import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { EffectDrizzleSqlite as EffectDrizzleSqliteValue } from "@deepagent-code/effect-drizzle-sqlite"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { RecoveryCommandContract } from "../src/contract/recovery-command"
import { SessionProviderRecovery } from "../src/session/runner/recovery"
import { StartupInventory } from "../src/session/runner/startup-inventory"

const makeDb = EffectDrizzleSqliteValue.makeWithDefaults()

type Db = EffectDrizzleSqlite.EffectSQLiteDatabase

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const H64 = (c: string) => c.repeat(64)

const identity = () => ({
  sessionId: "sess_inv",
  attemptId: "att_inv",
  activityId: "act_inv",
  providerTurnSeq: 1,
  selectionId: "sel_1",
  projectionHash: H64("p"),
  requestHash: H64("r"),
  providerId: "provider-test",
})

const baseClassify = (attempt: ReturnType<typeof identity>) => ({
  attempt,
  attemptState: "indeterminate_after_crash",
  expectedAttemptState: "indeterminate_after_crash",
  ownerToken: "owner_inv",
  expectedVersion: 2,
  baseline: { baselineHash: H64("b"), verified: true, state: "present" as const },
  historyVerified: true,
  providerLookupComplete: true,
  placementUnresolved: false,
  permissionIncomplete: false,
  workspaceConflict: false,
})

/** The five descriptor classes, classified through the real classifier (valid payload + hash). */
const fiveDescriptorRows = (): readonly {
  readonly descriptor_id: string
  readonly session_id: string
  readonly kind: string
  readonly payload: string
  readonly content_hash: string
}[] => {
  const attempt = identity()
  const descriptors = [
    SessionProviderRecovery.classify(baseClassify(attempt)),
    SessionProviderRecovery.classify({
      ...baseClassify(attempt),
      baseline: { verified: false, state: "missing", sourceSnapshotRef: "snap:1" },
    }),
    SessionProviderRecovery.classify({
      ...baseClassify(attempt),
      baseline: { verified: false, state: "present" },
      safeBoundary: { safeBoundaryRef: "boundary:1", safeBoundaryHash: H64("sb") },
    }),
    SessionProviderRecovery.classify({
      ...baseClassify(attempt),
      baseline: { verified: false, state: "present" },
    }),
    SessionProviderRecovery.classify({
      ...baseClassify(attempt),
      resolution: { resolutionRef: "resolution:1", bridgeRef: "bridge:1", terminal: "settled" },
    }),
  ]
  return descriptors.map((descriptor) => ({
    descriptor_id: `descriptor_${RecoveryCommandContract.recoveryDescriptorDigest(descriptor)}`,
    session_id: "sess-1",
    kind: descriptor.descriptorKind,
    payload: JSON.stringify(descriptor),
    content_hash: RecoveryCommandContract.recoveryDescriptorDigest(descriptor),
  }))
}

// Minimal, deterministic schema mirroring the columns classifyStartup reads. The real DB is built
// by the tracked migrations; these fixtures create exactly the read surface so the test is focused
// on the classification logic.
const createTables = (db: Db) =>
  Effect.gen(function* () {
    yield* db.run(sql`
      CREATE TABLE session_provider_attempt (attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL)
    `)
    yield* db.run(sql`
      CREATE TABLE session_v2_tool_effect (effect_id TEXT PRIMARY KEY, state TEXT NOT NULL, grant_state TEXT)
    `)
    yield* db.run(sql`
      CREATE TABLE task_run (run_id TEXT PRIMARY KEY, state TEXT NOT NULL, execution_owner TEXT, lease_expires_at INTEGER)
    `)
    yield* db.run(sql`
      CREATE TABLE event_snapshot_attempt (snapshot_id TEXT PRIMARY KEY, state TEXT NOT NULL)
    `)
    yield* db.run(sql`
      CREATE TABLE event_compaction_receipt (aggregate_id TEXT PRIMARY KEY, state TEXT NOT NULL)
    `)
    yield* db.run(sql`
      CREATE TABLE session_facade_activity (activity_id TEXT PRIMARY KEY, state TEXT NOT NULL)
    `)
    yield* db.run(sql`
      CREATE TABLE session_provider_recovery_descriptor
        (descriptor_id TEXT PRIMARY KEY, session_id TEXT, activity_id TEXT, turn_id TEXT,
         kind TEXT NOT NULL, payload TEXT, content_hash TEXT, created_at INTEGER)
    `)
  })

describe("StartupInventory.classifyStartup (C1B-10)", () => {
  test("classifies all five categories deterministically", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_provider_attempt
          VALUES ('att-prepared', 'prepared'), ('att-stream', 'streaming'), ('att-settled', 'settled')`)
        yield* db.run(sql`INSERT INTO session_v2_tool_effect
          VALUES ('eff-a', 'settled', 'settled'), ('eff-b', 'failed', 'unknown')`)
        yield* db.run(sql`INSERT INTO task_run
          VALUES ('task-a', 'completed', NULL, NULL), ('task-b', 'running', NULL, NULL)`)
        yield* db.run(sql`INSERT INTO event_snapshot_attempt VALUES ('snap-a', 'complete'), ('snap-b', 'staged')`)
        yield* db.run(sql`INSERT INTO event_compaction_receipt VALUES ('agg-a', 'complete'), ('agg-b', 'running')`)
        yield* db.run(sql`INSERT INTO session_facade_activity VALUES ('act-a', 'settled'), ('act-b', 'active')`)

        const inventory = yield* StartupInventory.classifyStartup(db)

        // All five categories present in the byCategory map.
        for (const category of StartupInventory.StartupCategories) {
          expect(inventory.byCategory[category]).toBeDefined()
        }
        // Each category routed a row to a known bucket.
        expect(inventory.byCategory.provider_attempt.safe_before_dispatch).toBe(1)
        expect(inventory.byCategory.provider_attempt.recovery).toBe(1)
        expect(inventory.byCategory.provider_attempt.resolved).toBe(1)
        expect(inventory.byCategory.tool_effect.resolved).toBe(1)
        expect(inventory.byCategory.tool_effect.recovery).toBe(1)
        expect(inventory.byCategory.task_run.resolved).toBe(1)
        expect(inventory.byCategory.task_run.recovery).toBe(1)
        expect(inventory.byCategory.compaction.resolved).toBe(2)
        expect(inventory.byCategory.compaction.safe_before_dispatch).toBe(1)
        expect(inventory.byCategory.compaction.recovery).toBe(1)
        expect(inventory.byCategory.session_activity.resolved).toBe(1)
        expect(inventory.byCategory.session_activity.recovery).toBe(1)
        expect(inventory.total).toBe(13)
        expect(inventory.ready).toBe(true)
        expect(inventory.unclassifiedItems).toHaveLength(0)
      }),
    )
  })

  test("only safe_before_dispatch items are requeue-eligible; the rest are never auto-requeued", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_provider_attempt VALUES ('att-dispatch', 'dispatching'), ('att-prep', 'prepared')`)
        yield* db.run(sql`INSERT INTO task_run VALUES ('task-pre', 'provisioning', NULL, NULL), ('task-run', 'running', NULL, NULL)`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        const requeueable = inventory.byCategory.provider_attempt.safe_before_dispatch + inventory.byCategory.task_run.safe_before_dispatch
        const recovery = inventory.byCategory.provider_attempt.recovery + inventory.byCategory.task_run.recovery
        // Only 'prepared' + 'provisioning' are provably pre-dispatch.
        expect(requeueable).toBe(2)
        // 'dispatching' + 'running' are past dispatch: recovery, NOT requeue.
        expect(recovery).toBe(2)
      }),
    )
  })

  test("an indeterminate-after-dispatch attempt is recovery, never requeue", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_provider_attempt VALUES ('att-indeterminate', 'indeterminate_after_crash')`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.provider_attempt.recovery).toBe(1)
        expect(inventory.byCategory.provider_attempt.safe_before_dispatch).toBe(0)
        expect(inventory.unclassifiedItems).toHaveLength(0)
      }),
    )
  })

  test("terminal evidence resolves an item (settled/failed/resolved_* and task terminal states)", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_provider_attempt VALUES
          ('att-settled', 'settled'),
          ('att-failed', 'failed'),
          ('att-abandoned', 'resolved_abandoned'),
          ('att-replayed', 'resolved_replayed')`)
        yield* db.run(sql`INSERT INTO task_run
          VALUES ('task-err', 'error', NULL, NULL), ('task-cancel', 'cancelled', NULL, NULL)`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.provider_attempt.resolved).toBe(4)
        expect(inventory.byCategory.task_run.resolved).toBe(2)
        expect(inventory.ready).toBe(true)
      }),
    )
  })

  test("an unclassified item (unknown state) makes the inventory not ready", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_provider_attempt VALUES ('att-weird', 'teleported')`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.ready).toBe(false)
        expect(inventory.unclassifiedItems).toHaveLength(1)
        expect(inventory.unclassifiedItems[0]).toMatchObject({
          category: "provider_attempt",
          classification: "unclassified",
          state: "teleported",
        })
        expect(StartupInventory.readOnlyRecoveryRequired(inventory)).toBe(true)
      }),
    )
  })

  test("unclassified=0 makes the inventory ready (total classification)", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_provider_attempt VALUES ('att-prep', 'prepared')`)
        yield* db.run(sql`INSERT INTO session_facade_activity VALUES ('act-settled', 'settled')`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.ready).toBe(true)
        expect(StartupInventory.gateReady(inventory)).toBe(true)
      }),
    )
  })

  test("restart determinism: the same rows re-classify to an identical inventory", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_provider_attempt VALUES ('att-a', 'streaming'), ('att-b', 'settled')`)
        yield* db.run(sql`INSERT INTO task_run VALUES ('task-a', 'running', NULL, NULL)`)

        const first = yield* StartupInventory.classifyStartup(db)
        const second = yield* StartupInventory.classifyStartup(db)
        expect(second).toEqual(first)
        expect(first.ready).toBe(true)
      }),
    )
  })

  test("tool effect permission grant gates quarantine: started/unknown/no-grant → recovery, settled → resolved", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_v2_tool_effect VALUES
          ('eff-settled', 'settled', 'settled'),
          ('eff-started', 'failed', 'started'),
          ('eff-unknown', 'settled', 'unknown'),
          ('eff-nogrant', 'failed', NULL)`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.tool_effect.resolved).toBe(1)
        expect(inventory.byCategory.tool_effect.recovery).toBe(3)
        expect(inventory.ready).toBe(true)
      }),
    )
  })

  test("a task run with a live execution lease is never requeued (owned elsewhere)", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        // provisioning + live lease → owned_elsewhere → recovery (NOT safe_before_dispatch).
        yield* db.run(sql`INSERT INTO task_run
          VALUES ('task-leased', 'provisioning', 'owner-x', ${Date.now() + 60_000})`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.task_run.safe_before_dispatch).toBe(0)
        expect(inventory.byCategory.task_run.recovery).toBe(1)
        expect(inventory.ready).toBe(true)
      }),
    )
  })

  test("compaction: committed snapshot/receipt → resolved; staged snapshot → requeue; running receipt → recovery", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO event_snapshot_attempt VALUES ('snap-complete', 'complete'), ('snap-staged', 'staged')`)
        yield* db.run(sql`INSERT INTO event_compaction_receipt VALUES ('agg-complete', 'complete'), ('agg-running', 'running')`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.compaction.resolved).toBe(2)
        expect(inventory.byCategory.compaction.safe_before_dispatch).toBe(1)
        expect(inventory.byCategory.compaction.recovery).toBe(1)
        expect(inventory.ready).toBe(true)
      }),
    )
  })

  test("W2 descriptor rows classify by kind: resolved → resolved, the four C1B classes → recovery", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`
          INSERT INTO session_provider_recovery_descriptor
            (descriptor_id, session_id, activity_id, turn_id, kind, payload, content_hash, created_at)
          VALUES ${sql.join(
            fiveDescriptorRows().map(
              (row) =>
                sql`(${row.descriptor_id}, ${row.session_id}, 'act', '1', ${row.kind}, ${row.payload}, ${row.content_hash}, 1)`,
            ),
            sql`, `,
          )}
        `)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.recovery_descriptor.resolved).toBe(1)
        expect(inventory.byCategory.recovery_descriptor.recovery).toBe(4)
        expect(inventory.byCategory.recovery_descriptor.safe_before_dispatch).toBe(0)
        expect(inventory.byCategory.recovery_descriptor.unclassified).toBe(0)
        expect(inventory.ready).toBe(true)
      }),
    )
  })

  test("an unknown descriptor kind makes the inventory not ready (never silently skipped)", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        // A valid payload whose kind column does NOT match it → decode refusal.
        const valid = fiveDescriptorRows()[0]!
        yield* db.run(sql`INSERT INTO session_provider_recovery_descriptor
          (descriptor_id, session_id, activity_id, turn_id, kind, payload, content_hash, created_at)
          VALUES ('desc-weird', 'sess-1', 'act', '1', 'teleported', ${valid.payload}, ${valid.content_hash}, 1)`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.ready).toBe(false)
        expect(inventory.unclassifiedItems).toHaveLength(1)
        expect(inventory.unclassifiedItems[0]).toMatchObject({
          category: "recovery_descriptor",
          classification: "unclassified",
          state: "teleported",
        })
      }),
    )
  })

  test("W2-1 content-hash validation: a tampered descriptor payload is unclassified (blocks ready)", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        const valid = fiveDescriptorRows()[0]!
        yield* db.run(sql`INSERT INTO session_provider_recovery_descriptor
          (descriptor_id, session_id, activity_id, turn_id, kind, payload, content_hash, created_at)
          VALUES (${valid.descriptor_id}, 'sess-1', 'act', '1', ${valid.kind}, '{"tampered":true}', ${valid.content_hash}, 1)`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.ready).toBe(false)
        expect(inventory.unclassifiedItems).toHaveLength(1)
        expect(inventory.unclassifiedItems[0]).toMatchObject({
          category: "recovery_descriptor",
          classification: "unclassified",
          reason: "recovery descriptor payload unverifiable (decode failure or content_hash mismatch)",
        })
      }),
    )
  })

  test("restart determinism includes descriptor rows (kill-9 re-derives the same inventory from the same rows)", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_provider_attempt VALUES ('att-a', 'indeterminate_after_crash')`)
        const coordination = SessionProviderRecovery.classify({
          ...baseClassify(identity()),
          baseline: { verified: false, state: "present" },
        })
        yield* db.run(sql`INSERT INTO session_provider_recovery_descriptor
          (descriptor_id, session_id, activity_id, turn_id, kind, payload, content_hash, created_at)
          VALUES ('desc-a', 'sess-1', 'act', '1',
                  ${coordination.descriptorKind}, ${JSON.stringify(coordination)},
                  ${RecoveryCommandContract.recoveryDescriptorDigest(coordination)}, 1)`)

        const first = yield* StartupInventory.classifyStartup(db)
        const second = yield* StartupInventory.classifyStartup(db)
        expect(second).toEqual(first)
        expect(first.byCategory.provider_attempt.recovery).toBe(1)
        expect(first.byCategory.recovery_descriptor.recovery).toBe(1)
        expect(first.ready).toBe(true)
      }),
    )
  })
})
