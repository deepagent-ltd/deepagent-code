import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Layer, Schema, Stream } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventTable } from "@deepagent-code/core/event/sql"
import { tempRoot, summarizeGroups, timeEffect, Recorder, type ScenarioOutcome } from "../lib"

// Harness-side durable definitions exercising the production bus mechanics
// (sequence allocation, sync dedupe/projection, claim). These types exist only
// in this harness; the owning code is packages/core/src/event.ts.
const LocalProbe = EventV2.define({
  type: "perf.bus.local",
  schema: { key: Schema.String, text: Schema.String },
})

const SyncProbe = EventV2.define({
  type: "perf.bus.sync",
  sync: { version: 1, aggregate: "key" },
  schema: { key: Schema.String, text: Schema.String },
})

export interface EventBusOptions {
  readonly warmup: number
  readonly measured: number
  readonly claims: number
}

/**
 * publish groups measure a single durable append through the existing bus
 * implementation; local = process-local durability (no sync projection),
 * sync = synchronized path with aggregate sequencing + dedupe constraints.
 * claim sets the sequence owner (the durable read-owner transition).
 */
export const runEventBus = async (options: EventBusOptions): Promise<ScenarioOutcome> => {
  const startedAt = performance.now()
  const root = tempRoot("event-bus")
  const file = path.join(root, "event-bus.db")
  const databaseLayer = Database.layerFromPath(file)
  const layer = Layer.mergeAll(databaseLayer, EventV2.layer.pipe(Layer.provide(databaseLayer)))

  const program = Effect.gen(function* () {
    const events = yield* EventV2.Service
    const database = yield* Database.Service
    const recorder = new Recorder()
    const key = "ses_perf_bus_probe"
    let logicalBytes = 0

    for (let index = 0; index < options.warmup; index++) {
      const payload = { key, text: `warmup ${index}` }
      logicalBytes += JSON.stringify(payload).length
      const [, elapsed] = yield* timeEffect(events.publish(SyncProbe, payload))
      recorder.add("publish_sync_warmup", elapsed)
    }

    for (let index = 0; index < options.measured; index++) {
      const localPayload = { key, text: `local sample ${index}` }
      const [, elapsedLocal] = yield* timeEffect(events.publish(LocalProbe, localPayload))
      recorder.add("publish_local", elapsedLocal)

      const syncPayload = { key, text: `sync sample ${index} `.padEnd(160, "x") }
      logicalBytes += syncPayload.text.length
      const [, elapsedSync] = yield* timeEffect(events.publish(SyncProbe, syncPayload))
      recorder.add("publish_sync", elapsedSync)
    }

    for (let index = 0; index < options.claims; index++) {
      const [, elapsedClaim] = yield* timeEffect(events.claim(key, `probe-owner-${index}`))
      recorder.add("claim", elapsedClaim)
    }

    // Journal replay of the probe aggregate: the drain side of hydration.
    // aggregateEvents is a persistent stream (initial drain then an unterminated live tail —
    // see streamEvents in packages/core/src/event.ts), so every collect is bounded by
    // Stream.take on the exact number of durable rows written to THIS aggregate. Only the
    // SyncProbe events carry that aggregate (aggregate = "key"); LocalProbe events are not
    // part of it, so the bound is read from the DB rather than assumed from a publish-count
    // formula (bounding by a too-large count would spin forever on the unterminated live tail).
    const counted = yield* database.db
      .select({ n: sql<number>`count(*)` })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, key))
      .all()
      .pipe(Effect.orDie)
    const expectedEvents = Number(counted[0]!.n)
    const drainOnce = () =>
      Stream.runCollect(Stream.take(events.aggregateEvents({ aggregateID: key }), expectedEvents)).pipe(
        Effect.map((chunk) => Array.from(chunk).length),
      )
    const [, elapsedDrain] = yield* timeEffect(drainOnce())
    recorder.add("drain_probe_aggregate", elapsedDrain)
    const drainedCount = yield* drainOnce()
    return { groups: recorder.results(), drainedCount, expectedEvents, logicalBytes }
  }).pipe(Effect.provide(layer))

  try {
    const result = await Effect.runPromise(Effect.scoped(program))
    if (result.drainedCount !== result.expectedEvents) {
      throw new Error(`drain delivered ${result.drainedCount} of ${result.expectedEvents} written probe events`)
    }
    return summarizeGroups(
      {
        name: "event-publish-claim",
        owner_note:
          "durable bus V2 owner (packages/core/src/event.ts on sqlite); no legacy event bus or HTTP involved",
        status: "ok",
        evidence_refs: ["packages/core/src/event.ts", "packages/core/src/event/sql.ts"],
        groups: result.groups,
        extras: {
          unit: "ms",
          warmup_policy: "10 warmup sync publishes then 300 measured local+sync publish pairs + 60 claims + 1 aggregate drain (no samples dropped)",
          sample_basis:
            "300 local+sync publish pairs and 60 claims after 10 sync warmups; per-op cost is sub-ms so larger N keeps p95/p99 meaningful",
          probe_aggregate_events_after_drain: result.drainedCount,
          logical_payload_bytes_written_approx: result.logicalBytes,
        },
      },
      performance.now() - startedAt,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
