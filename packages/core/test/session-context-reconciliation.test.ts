import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import receiptActivePackSetMigration from "../src/database/migration/20260816080000_receipt_active_pack_set_attribution"
import reconciliationMigration from "../src/database/migration/20260816081000_session_context_reconciliation"
import { ContextReconciliation } from "../src/context-federation/reconciliation"

const sessionId = "reconciliation-session"
const activityId = "reconciliation-activity"
const projectionRefs = [
  { graph: "knowledge" as const, entityId: "doc-a", revision: "rev-1" },
  { graph: "memory" as const, entityId: "mem-b", revision: "rev-2" },
  { graph: "code" as const, entityId: "file-c", revision: "rev-3" },
]

describe("context reconciliation pure functions", () => {
  test("refKeys sorts and de-duplicates; fingerprint is order and duplicate insensitive", () => {
    const reversed = [...projectionRefs].reverse()
    expect(ContextReconciliation.refKeys(projectionRefs)).toEqual(ContextReconciliation.refKeys(reversed))
    expect(ContextReconciliation.refsFingerprint(projectionRefs)).toEqual(
      ContextReconciliation.refsFingerprint([...projectionRefs, projectionRefs[0]!]),
    )
    expect(ContextReconciliation.duplicateCount(projectionRefs)).toBe(0)
    expect(ContextReconciliation.duplicateCount([...projectionRefs, projectionRefs[0]!])).toBe(1)
  })

  test("diffRefKeys partitions two ref key sets", () => {
    const diff = ContextReconciliation.diffRefKeys(["a", "b"], ["b", "c"])
    expect(diff).toEqual({ onlyInA: ["a"], onlyInB: ["c"], sharedCount: 1 })
  })

  test("evaluate without legacy refs records projection-internal consistency", () => {
    const evaluated = ContextReconciliation.evaluate({ projectionRefs })
    expect(evaluated.outcome).toBe("legacy_unavailable_projection_consistent")
    expect(evaluated.legacyFingerprint).toBeUndefined()
    expect(evaluated.diffSummary.mode).toBe("projection_internal")
    expect(evaluated.diffSummary.refCount).toBe(3)
    expect(evaluated.diffSummary.duplicateCount).toBe(0)
    expect(evaluated.diffSummary.perGraph).toEqual({ knowledge: 1, memory: 1, code: 1 })

    const duplicated = ContextReconciliation.evaluate({ projectionRefs: [...projectionRefs, projectionRefs[0]!] })
    expect(duplicated.outcome).toBe("legacy_unavailable_projection_duplicate_refs")
    expect(duplicated.diffSummary.duplicateCount).toBe(1)
  })

  test("evaluate with legacy refs reports match and mismatch with the diff partition", () => {
    const match = ContextReconciliation.evaluate({ projectionRefs, legacyRefs: [...projectionRefs].reverse() })
    expect(match.outcome).toBe("legacy_match")
    expect(match.legacyFingerprint).toBe(ContextReconciliation.refsFingerprint(projectionRefs))
    expect(match.diffSummary.mode).toBe("legacy_vs_projection")

    const mismatch = ContextReconciliation.evaluate({
      projectionRefs,
      legacyRefs: [
        projectionRefs[0]!,
        { graph: "knowledge" as const, entityId: "doc-legacy-only", revision: "rev-9" },
      ],
    })
    expect(mismatch.outcome).toBe("legacy_mismatch")
    expect(mismatch.diffSummary.legacy).toEqual({
      refCount: 2,
      onlyInLegacy: ["knowledge:doc-legacy-only:rev-9"],
      onlyInProjection: ["code:file-c:rev-3", "memory:mem-b:rev-2"],
      sharedCount: 1,
    })
  })
})

describe("context reconciliation durable record", () => {
  test("writes one idempotent row per federated turn receipt", async () => {
    await runCurrent(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seedSession(db)
        const input = {
          sessionId,
          activityId,
          turnReceiptId: "receipt-turn-1",
          selectionId: "selection-1",
          projectionRefs,
          now: 42,
        }
        yield* ContextReconciliation.record(db, input)
        yield* ContextReconciliation.record(db, input)

        const rows = yield* db.all<{
          reconciliation_id: string
          session_id: string
          activity_id: string
          turn_receipt_id: string
          selection_id: string
          legacy_refs_fingerprint: string | null
          projection_refs_fingerprint: string
          outcome: string
          diff_summary: string
          created_at: number
        }>(sql`SELECT * FROM session_context_reconciliation`)
        expect(rows.length).toBe(1)
        const row = rows[0]!
        expect(row.reconciliation_id).toBe(ContextReconciliation.reconciliationId("receipt-turn-1"))
        expect(row.session_id).toBe(sessionId)
        expect(row.activity_id).toBe(activityId)
        expect(row.turn_receipt_id).toBe("receipt-turn-1")
        expect(row.selection_id).toBe("selection-1")
        expect(row.legacy_refs_fingerprint).toBeNull()
        expect(row.projection_refs_fingerprint).toBe(ContextReconciliation.refsFingerprint(projectionRefs))
        expect(row.outcome).toBe("legacy_unavailable_projection_consistent")
        expect(JSON.parse(row.diff_summary).mode).toBe("projection_internal")
        expect(row.created_at).toBe(42)

        const secondTurn = yield* ContextReconciliation.record(db, {
          ...input,
          turnReceiptId: "receipt-turn-2",
          projectionRefs: [projectionRefs[0]!],
          now: 43,
        })
        expect(secondTurn.outcome).toBe("legacy_unavailable_projection_consistent")
        expect((yield* db.all(sql`SELECT reconciliation_id FROM session_context_reconciliation`)).length).toBe(2)
      }),
    )
  })

  test("records the legacy fingerprint when legacy refs are provided", async () => {
    await runCurrent(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seedSession(db)
        yield* ContextReconciliation.record(db, {
          sessionId,
          activityId,
          turnReceiptId: "receipt-turn-legacy",
          projectionRefs,
          legacyRefs: projectionRefs,
        })
        expect(yield* db.get(sql`
          SELECT legacy_refs_fingerprint, projection_refs_fingerprint, outcome
          FROM session_context_reconciliation
          WHERE turn_receipt_id = 'receipt-turn-legacy'
        `)).toEqual({
          legacy_refs_fingerprint: ContextReconciliation.refsFingerprint(projectionRefs),
          projection_refs_fingerprint: ContextReconciliation.refsFingerprint(projectionRefs),
          outcome: "legacy_match",
        })
      }),
    )
  })

  test("fresh schema exposes the reconciliation table, indexes, and the receipt attribution column", async () => {
    await runCurrent(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(
          (yield* db.all<{ name: string }>(sql`
            SELECT name FROM pragma_table_info('session_context_reconciliation')
          `)).map((column) => column.name),
        ).toEqual([
          "reconciliation_id",
          "session_id",
          "activity_id",
          "turn_receipt_id",
          "selection_id",
          "legacy_refs_fingerprint",
          "projection_refs_fingerprint",
          "outcome",
          "diff_summary",
          "created_at",
        ])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`
            SELECT name, "unique"
            FROM pragma_index_list('session_context_reconciliation')
            WHERE name NOT LIKE 'sqlite_%'
            ORDER BY name
          `)).map((index) => index),
        ).toEqual([
          { name: "session_context_reconciliation_receipt_idx", unique: 1 },
          { name: "session_context_reconciliation_session_idx", unique: 0 },
        ])
        expect(
          (yield* db.all<{ name: string }>(sql`
            SELECT name FROM pragma_table_info('session_tool_request_receipt')
          `)).map((column) => column.name),
        ).toEqual(expect.arrayContaining(["context_active_pack_set_snapshot_id"]))
        expect(
          yield* db.all<{ name: string; partial: number }>(sql`
            SELECT name, partial
            FROM pragma_index_list('session_tool_request_receipt')
            WHERE name = 'session_tool_request_receipt_active_pack_set_idx'
          `),
        ).toEqual([{ name: "session_tool_request_receipt_active_pack_set_idx", partial: 1 }])
      }),
    )
  })
})

describe("FEAT-007 migrations upgrade a historical schema", () => {
  test("adds the attribution column and reconciliation table without touching existing rows", async () => {
    await runRaw(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`
          CREATE TABLE session (id TEXT PRIMARY KEY)
        `)
        yield* db.run(sql`
          CREATE TABLE session_activity (activity_id TEXT PRIMARY KEY, session_id TEXT)
        `)
        yield* db.run(sql`
          CREATE TABLE session_tool_request_receipt (
            receipt_id TEXT PRIMARY KEY,
            session_id TEXT,
            provider_state TEXT
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (receipt_id, session_id, provider_state)
          VALUES ('historical-receipt', 'historical-session', 'prepared')
        `)

        yield* DatabaseMigration.applyOnly(db, [receiptActivePackSetMigration, reconciliationMigration])

        expect(
          (yield* db.all<{ name: string }>(sql`
            SELECT name FROM pragma_table_info('session_tool_request_receipt')
          `)).map((column) => column.name),
        ).toEqual(expect.arrayContaining(["context_active_pack_set_snapshot_id"]))
        expect(
          yield* db.get(sql`
            SELECT context_active_pack_set_snapshot_id FROM session_tool_request_receipt
            WHERE receipt_id = 'historical-receipt'
          `),
        ).toEqual({ context_active_pack_set_snapshot_id: null })

        const invalid = yield* db
          .run(sql`
            UPDATE session_tool_request_receipt
            SET context_active_pack_set_snapshot_id = 'not-a-pack-snapshot'
            WHERE receipt_id = 'historical-receipt'
          `)
          .pipe(Effect.exit)
        expect(Exit.isFailure(invalid)).toBe(true)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET context_active_pack_set_snapshot_id = 'pack_snapshot:abcdef0123456789'
          WHERE receipt_id = 'historical-receipt'
        `)
        expect(
          yield* db.get(sql`
            SELECT context_active_pack_set_snapshot_id FROM session_tool_request_receipt
            WHERE receipt_id = 'historical-receipt'
          `),
        ).toEqual({ context_active_pack_set_snapshot_id: "pack_snapshot:abcdef0123456789" })

        expect(
          yield* db.get(sql`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'session_context_reconciliation'
          `),
        ).toEqual({ name: "session_context_reconciliation" })

        const malformedFingerprint = yield* db
          .run(sql`
            INSERT INTO session_context_reconciliation (
              reconciliation_id, session_id, activity_id, turn_receipt_id,
              projection_refs_fingerprint, outcome, diff_summary, created_at
            ) VALUES ('malformed', 'historical-session', 'historical-activity', 'receipt-x',
              'short', 'legacy_match', '{}', 1)
          `)
          .pipe(Effect.exit)
        expect(Exit.isFailure(malformedFingerprint)).toBe(true)
        const malformedSummary = yield* db
          .run(sql`
            INSERT INTO session_context_reconciliation (
              reconciliation_id, session_id, activity_id, turn_receipt_id,
              projection_refs_fingerprint, outcome, diff_summary, created_at
            ) VALUES ('malformed-summary', 'historical-session', 'historical-activity', 'receipt-x',
              ${"a".repeat(64)}, 'legacy_match', '[]', 1)
          `)
          .pipe(Effect.exit)
        expect(Exit.isFailure(malformedSummary)).toBe(true)
      }),
    )
  })
})

function runCurrent<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped))
}

function runRaw<A, E>(effect: Effect.Effect<A, E, SqlClientService>) {
  return Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
}

type DatabaseClient = Database.Interface["db"]

function seedSession(db: DatabaseClient) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
      VALUES ('reconciliation-project', '/tmp/reconciliation', '[]', 1, 1)
    `)
    yield* db.run(sql`
      INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES (${sessionId}, 'reconciliation-project', 'reconciliation-session', '/tmp/reconciliation', 'Reconciliation session', 'test', 1, 1)
    `)
    yield* db.run(sql`
      INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, promoted_seq, time_created)
      VALUES ('reconciliation-input', ${sessionId}, '{"text":"reconciliation"}', 'steer', 0, 0, 1)
    `)
    yield* db.run(sql`
      INSERT INTO session_activity (
        activity_id, session_id, ordinal, trigger_input_id, delivery, state, created_at
      ) VALUES (${activityId}, ${sessionId}, 0, 'reconciliation-input', 'steer', 'active', 1)
    `)
  })
}
