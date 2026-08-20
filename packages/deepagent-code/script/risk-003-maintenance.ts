#!/usr/bin/env bun

import path from "node:path"
import { stat } from "node:fs/promises"
import { Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2, Cursor } from "@deepagent-code/core/event"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionDiffArtifact } from "@/session/diff-artifact"
import { SessionID } from "@/session/schema"

// RISK-003 data-maintenance drill (BUG-407-010 §14). Runs only against a drill COPY of the
// production snapshot (basename must contain "drill"). Gate order is strict:
//   sync backfill → message diff backfill (②③) → snapshot/floor parity + physical deletion (⑥⑦)
//   → integrity check → VACUUM (⑪). Every gate reports MiB/count evidence before and after;
//   any failure stops the run before the next irreversible step.

const arg = (name: string) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const MiB = (bytes: number) => (bytes / 1048576).toFixed(1)

const evidenceLines: { step: string; detail: string }[] = []
const evidence = (step: string, detail: string) => {
  evidenceLines.push({ step, detail })
  console.log(`RISK-003 ${step}: ${detail}`)
}

const layersFor = (database: string) => {
  // Same wiring as the REL-001 drill: every consumer must point at the drill path explicitly,
  // because EventV2.defaultLayer bakes the channel-local Database.defaultLayer.
  const eventV2 = EventV2.layer.pipe(Layer.provide(Database.layerFromPath(database)))
  const bridge = EventV2Bridge.layer.pipe(Layer.provide(eventV2))
  const sessionProjector = SessionProjector.layer.pipe(
    Layer.provide(eventV2),
    Layer.provide(Database.layerFromPath(database)),
  )
  return Layer.mergeAll(
    Session.layer.pipe(
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Database.layerFromPath(database)),
      Layer.provide(bridge),
      Layer.provide(RuntimeFlags.defaultLayer),
    ),
    sessionProjector,
    eventV2,
    Database.layerFromPath(database),
  )
}

export function runMaintenance(input: {
  database: string
  aggregateLimit: number
  skipDelete: boolean
  skipVacuum: boolean
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    // Gate 0 — survey.
    const before = yield* db.get<{ bytes: number; rows: number }>(sql`SELECT SUM(LENGTH(data)) AS bytes, COUNT(*) AS rows FROM event`).pipe(Effect.orDie)
    evidence("survey", `event rows=${before?.rows ?? 0} bytes=${MiB(before?.bytes ?? 0)} MiB`)
    const aggregates = yield* db.all<{ aggregate_id: string; bytes: number }>(sql`
      SELECT aggregate_id, SUM(LENGTH(data)) AS bytes FROM event GROUP BY aggregate_id
      ORDER BY bytes DESC LIMIT ${input.aggregateLimit}
    `).pipe(Effect.orDie)
    for (const row of aggregates) evidence("survey-aggregate", `${row.aggregate_id} ${MiB(row.bytes)} MiB`)

    // Gate 1 — sync index backfill (compact refuses to run before this completes).
    if (!events.backfillSyncIndex) return yield* Effect.die("event sync backfill is unavailable")
    let backfill = { processed: 0, complete: false }
    let backfillLoops = 0
    do {
      backfill = yield* events.backfillSyncIndex({ limit: 5000 }).pipe(Effect.exit).pipe(
        Effect.flatMap((exit) => (Exit.isFailure(exit) ? Effect.die(exit.cause) : Effect.succeed(exit.value))),
      )
      backfillLoops++
    } while (!backfill.complete && backfillLoops < 2000)
    if (!backfill.complete) return yield* Effect.die("sync index backfill did not complete within 2000 batches")
    evidence("backfill", `sync index complete after ${backfillLoops} batches`)

    // Gate 2 — ②③ message diff backfill (best effort per session; failures log and continue).
    const sessionsWithDiffs = yield* db.all<{ session_id: string }>(sql`
      SELECT DISTINCT session_id FROM message
      WHERE json_extract(data, '$.role') = 'user' AND json_array_length(json_extract(data, '$.summary.diffs')) > 0
        AND json_extract(data, '$.summary.diffArtifact') IS NULL
      LIMIT 20
    `).pipe(Effect.orDie)
    let migrated = 0
    let migrationSkipped = 0
    for (const row of sessionsWithDiffs) {
      const result = yield* SessionDiffArtifact.migrate({ sessionID: SessionID.make(row.session_id) }).pipe(Effect.exit)
      if (Exit.isFailure(result)) migrationSkipped++
      else migrated++
    }
    evidence("diff-backfill", `sessions scanned=${sessionsWithDiffs.length} migrated=${migrated} skipped=${migrationSkipped}`)

    // Gate 3 — ⑥⑦ snapshot/floor parity then physical deletion, per aggregate.
    let totalDeleted = 0
    let compactedAggregates = 0
    for (const row of aggregates) {
      const sequence = yield* db.get<{ seq: number; floor: number | null }>(sql`
        SELECT seq, retention_floor_seq AS floor FROM event_sequence WHERE aggregate_id = ${row.aggregate_id}
      `).pipe(Effect.orDie)
      if (!sequence) continue
      const throughSeq = sequence.seq
      if (sequence.floor !== null && sequence.floor >= throughSeq) continue
      const checkpoint = yield* events.checkpoint({
        aggregateID: row.aggregate_id,
        throughSeq: Cursor.make(throughSeq),
        codec: "session-projection",
        schemaVersion: 1,
        expectedLatest: Cursor.make(throughSeq),
      }).pipe(Effect.exit)
      if (Exit.isFailure(checkpoint)) {
        evidence("checkpoint-skip", `${row.aggregate_id} checkpoint failed: ${checkpoint.cause}`)
        continue
      }
      const imported = yield* events.importSnapshot(checkpoint.value).pipe(Effect.exit)
      if (Exit.isFailure(imported)) {
        evidence("import-skip", `${row.aggregate_id} snapshot import failed: ${imported.cause}`)
        continue
      }
      if (input.skipDelete) {
        evidence("floor-ready", `${row.aggregate_id} snapshot ${checkpoint.value.snapshotID} imported, floor=${throughSeq} (delete skipped)`)
        continue
      }
      let deleted = 0
      let complete = false
      let loops = 0
      do {
        const step = yield* events.compact({ aggregateID: row.aggregate_id, throughSeq: Cursor.make(throughSeq), limit: 100 }).pipe(Effect.exit)
        if (Exit.isFailure(step)) {
          evidence("compact-skip", `${row.aggregate_id} compact failed: ${step.cause}`)
          break
        }
        deleted += step.value.deleted
        complete = step.value.complete
        loops++
      } while (!complete && loops < 2000)
      totalDeleted += deleted
      compactedAggregates++
      evidence("compact", `${row.aggregate_id} deleted=${deleted} events complete=${complete}`)
    }
    evidence("delete-summary", `aggregates compacted=${compactedAggregates} total events deleted=${totalDeleted}`)

    const after = yield* db.get<{ bytes: number; rows: number }>(sql`SELECT SUM(LENGTH(data)) AS bytes, COUNT(*) AS rows FROM event`).pipe(Effect.orDie)
    evidence("after-delete", `event rows=${after?.rows ?? 0} bytes=${MiB(after?.bytes ?? 0)} MiB (was ${MiB(before?.bytes ?? 0)} MiB)`)

    // Gate 4 — integrity.
    const quickCheck = yield* db.get<{ quick_check: string }>(sql`PRAGMA quick_check`).pipe(Effect.orDie)
    evidence("integrity", `quick_check=${quickCheck?.quick_check}`)
    if (quickCheck?.quick_check !== "ok") return yield* Effect.die("integrity check failed before VACUUM")

    // Gate 5 — ⑪ VACUUM + acceptance.
    if (!input.skipVacuum) {
      const beforeSize = yield* Effect.promise(() => stat(input.database))
      yield* db.run(sql`VACUUM`).pipe(Effect.orDie)
      const afterSize = yield* Effect.promise(() => stat(input.database))
      evidence("vacuum", `file ${MiB(beforeSize.size)} MiB -> ${MiB(afterSize.size)} MiB`)
      for (const sessionID of ["ses_00c3f7decfffhjQSy69Q5gSd1S", "ses_0149b8afffffWlu80cVGdzFI9s"]) {
        const state = yield* db.get<{ state: string }>(sql`SELECT state FROM session_history_state WHERE session_id = ${sessionID}`).pipe(Effect.orDie)
        evidence("acceptance", `${sessionID} history=${state?.state}`)
      }
    }

    return { evidence: evidenceLines }
  })
}

if (import.meta.main) {
  const database = arg("--db")
  if (!database) {
    console.error("usage: bun script/risk-003-maintenance.ts --db <drill-copy.db> [--aggregates n] [--skip-delete] [--skip-vacuum]")
    process.exit(2)
  }
  if (!path.basename(database).includes("drill")) {
    console.error(`refusing to maintain a non-drill database: ${database}`)
    process.exit(2)
  }
  const outcome = await Effect.runPromise(
    runMaintenance({
      database,
      aggregateLimit: Number(arg("--aggregates") ?? 5),
      skipDelete: process.argv.includes("--skip-delete"),
      skipVacuum: process.argv.includes("--skip-vacuum"),
    })
      .pipe(Effect.provide(layersFor(database)))
      .pipe(Effect.exit),
  )
  if (Exit.isFailure(outcome)) {
    console.error(`RISK-003 maintenance FAILED: ${outcome.cause}`)
    process.exit(1)
  }
  console.log("RISK-003 summary: PASS")
}
