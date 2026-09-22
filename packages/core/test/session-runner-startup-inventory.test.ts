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
    yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY, execution_claim_token INTEGER)`)
    yield* db.run(sql`INSERT INTO session VALUES ('fixture-session', 1), ('sess-1', 1), ('sess_inv', 1)`)
    yield* db.run(sql`
      CREATE TABLE session_provider_attempt (
        attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL, session_id TEXT DEFAULT 'fixture-session', activity_id TEXT,
        provider_turn_seq INTEGER, attempt_version INTEGER, execution_claim_token INTEGER NOT NULL DEFAULT 1,
        selection_id TEXT,
        projection_hash TEXT, request_hash TEXT, provider_id TEXT, owner_token TEXT
      )
    `)
    yield* db.run(sql`
      CREATE TABLE session_v2_tool_effect_admission
        (admission_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, tool_call_id TEXT NOT NULL)
    `)
    yield* db.run(sql`
      CREATE TABLE session_v2_tool_effect
        (effect_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
         state TEXT NOT NULL, grant_state TEXT)
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
      CREATE TABLE session_v2_compaction_request (request_id TEXT PRIMARY KEY, status TEXT NOT NULL)
    `)
    yield* db.run(sql`
      CREATE TABLE session_facade_activity (activity_id TEXT PRIMARY KEY, state TEXT NOT NULL)
    `)
    yield* db.run(sql`
      CREATE TABLE session_activity (activity_id TEXT PRIMARY KEY, state TEXT NOT NULL)
    `)
    yield* db.run(sql`
      CREATE TABLE session_provider_recovery_descriptor
        (descriptor_id TEXT PRIMARY KEY, session_id TEXT, activity_id TEXT, turn_id TEXT,
         kind TEXT NOT NULL, payload TEXT, content_hash TEXT, created_at INTEGER)
    `)
    yield* db.run(sql`
      CREATE TABLE recovery_command (
        command_id TEXT PRIMARY KEY, descriptor_id TEXT, attempt TEXT NOT NULL, state TEXT NOT NULL,
        expected_owner_token TEXT, result_hash TEXT, actor_type TEXT, actor_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )
    `)
    yield* db.run(sql`
      CREATE TABLE session_provider_attempt_resolution (
        resolution_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, decision TEXT NOT NULL
      )
    `)
    yield* db.run(sql`
      CREATE TABLE session_input
        (id TEXT PRIMARY KEY, delivery TEXT NOT NULL, promoted_seq INTEGER)
    `)
    yield* db.run(sql`
      CREATE TABLE session_v2_provider_turn_receipt (
        receipt_id TEXT PRIMARY KEY, state TEXT NOT NULL, provider_attempt_id TEXT,
        session_id TEXT NOT NULL, activity_id TEXT NOT NULL, provider_turn_seq INTEGER NOT NULL,
        request_input_hash TEXT NOT NULL, provider_id TEXT NOT NULL, owner_token TEXT NOT NULL
      )
    `)
    yield* db.run(sql`
      CREATE TABLE session_v2_provider_recovery_bridge
        (resolution_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, receipt_id TEXT NOT NULL,
         command_id TEXT NOT NULL)
    `)
    yield* db.run(sql`
      CREATE TABLE deepagent_event_outbox (
        outbox_id TEXT PRIMARY KEY, status TEXT NOT NULL, claim_token TEXT, claimant_id TEXT,
        lease_expires_at INTEGER, published_at INTEGER
      )
    `)
    yield* db.run(sql`CREATE TABLE deepagent_event_consumer (consumer_key TEXT PRIMARY KEY)`)
    yield* db.run(sql`
      CREATE TABLE deepagent_event_consumer_delivery (
        outbox_id TEXT NOT NULL, consumer_key TEXT NOT NULL, status TEXT NOT NULL,
        claim_token TEXT, claimant_id TEXT, lease_expires_at INTEGER, resolved_at INTEGER,
        PRIMARY KEY(outbox_id, consumer_key)
      )
    `)
    yield* db.run(sql`
      CREATE TABLE event_sync_backfill (
        id INTEGER PRIMARY KEY, state TEXT NOT NULL, cursor_rowid INTEGER NOT NULL,
        high_water_rowid INTEGER NOT NULL, completed_at INTEGER
      )
    `)
    yield* db.run(sql`
      CREATE TABLE event_sync_sequence
        (id INTEGER PRIMARY KEY, backfill_complete INTEGER NOT NULL)
    `)
    yield* db.run(sql`INSERT INTO event_sync_backfill VALUES (1, 'complete', 0, 0, 1)`)
    yield* db.run(sql`INSERT INTO event_sync_sequence VALUES (1, 1)`)
  })

describe("StartupInventory.classifyStartup (C1B-10)", () => {
  test("classifies all five categories deterministically", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_provider_attempt(attempt_id, state)
          VALUES ('att-prepared', 'prepared'), ('att-stream', 'streaming'), ('att-settled', 'settled')`)
        yield* db.run(sql`INSERT INTO session_v2_tool_effect_admission
          VALUES ('adm-a', 'receipt-a', 'call-a'), ('adm-b', 'receipt-b', 'call-b')`)
        yield* db.run(sql`INSERT INTO session_v2_tool_effect
          VALUES
            ('eff-a', 'receipt-a', 'call-a', 'settled', 'settled'),
            ('eff-b', 'receipt-b', 'call-b', 'failed', 'unknown')`)
        yield* db.run(sql`INSERT INTO task_run
          VALUES ('task-a', 'completed', NULL, NULL), ('task-b', 'running', NULL, NULL)`)
        yield* db.run(sql`INSERT INTO event_snapshot_attempt VALUES ('snap-a', 'complete'), ('snap-b', 'staged')`)
        yield* db.run(sql`INSERT INTO event_compaction_receipt VALUES ('agg-a', 'complete'), ('agg-b', 'running')`)
        yield* db.run(sql`INSERT INTO session_v2_compaction_request
          VALUES ('cr-pending', 'pending'), ('cr-dispatched', 'dispatched'), ('cr-settled', 'settled'),
                 ('cr-recovery', 'recovery_required'), ('cr-failed', 'failed')`)
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
        expect(inventory.byCategory.compaction.resolved).toBe(4)
        expect(inventory.byCategory.compaction.safe_before_dispatch).toBe(2)
        expect(inventory.byCategory.compaction.recovery).toBe(3)
        expect(inventory.byCategory.session_activity.resolved).toBe(1)
        expect(inventory.byCategory.session_activity.recovery).toBe(1)
        expect(inventory.byCategory.sync_projection.resolved).toBe(1)
        expect(inventory.total).toBe(19)
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
        yield* db.run(sql`INSERT INTO session_provider_attempt(attempt_id, state) VALUES ('att-dispatch', 'dispatching'), ('att-prep', 'prepared')`)
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
        yield* db.run(sql`INSERT INTO session_provider_attempt(attempt_id, state) VALUES ('att-indeterminate', 'indeterminate_after_crash')`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.provider_attempt.recovery).toBe(1)
        expect(inventory.byCategory.provider_attempt.safe_before_dispatch).toBe(0)
        expect(inventory.unclassifiedItems).toHaveLength(0)
      }),
    )
  })

  test("a live or indeterminate attempt without an exact Session claim blocks startup", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session VALUES ('sess-historical', 1)`)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt(attempt_id, state, execution_claim_token, session_id)
          VALUES ('att-historical', 'indeterminate_after_crash', 0, 'sess-historical')
        `)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.ready).toBe(false)
        expect(inventory.unclassifiedItems).toContainEqual({
          category: "provider_attempt",
          id: "att-historical",
          classification: "unclassified",
          state: "indeterminate_after_crash",
          reason: "provider attempt lacks its exact current Session execution claim",
        })
      }),
    )
  })

  test("an unknown compaction-request status is unclassified; known request states map to their buckets", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`
          INSERT INTO session_v2_compaction_request
          VALUES ('cr-pending', 'pending'), ('cr-orphaned', 'dispatched'), ('cr-weird', 'teleported')
        `)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.ready).toBe(false)
        expect(inventory.byCategory.compaction.safe_before_dispatch).toBe(1)
        expect(inventory.byCategory.compaction.recovery).toBe(1)
        expect(inventory.unclassifiedItems).toContainEqual({
          category: "compaction",
          id: "request:cr-weird",
          classification: "unclassified",
          state: "teleported",
          reason: "unknown request_compaction state 'teleported'",
        })
      }),
    )
  })

  test("an indeterminate attempt whose claim was released or superseded is recovery, never a boot blocker", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        // Live-owner interrupt quarantine (user abort mid-dispatch) settles the attempt as
        // indeterminate and releases the Session claim; a later drain may supersede it. Both
        // forms are terminal quarantine evidence: recovery, never unclassified.
        yield* db.run(sql`INSERT INTO session VALUES ('sess-released', NULL), ('sess-superseded', 99)`)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt(attempt_id, state, execution_claim_token, session_id)
          VALUES
            ('att-released', 'indeterminate_after_crash', 42, 'sess-released'),
            ('att-superseded', 'indeterminate_after_crash', 42, 'sess-superseded')
        `)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.provider_attempt.recovery).toBe(2)
        expect(inventory.unclassifiedItems).toHaveLength(0)
        expect(inventory.ready).toBe(true)
      }),
    )
  })

  test("a live attempt without the exact current Session claim still blocks startup", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session VALUES ('sess-live', NULL)`)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt(attempt_id, state, execution_claim_token, session_id)
          VALUES ('att-live', 'streaming', 42, 'sess-live')
        `)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.ready).toBe(false)
        expect(inventory.unclassifiedItems).toContainEqual({
          category: "provider_attempt",
          id: "att-live",
          classification: "unclassified",
          state: "streaming",
          reason: "provider attempt lacks its exact current Session execution claim",
        })
      }),
    )
  })

  test("Core session_activity rows are inventoried alongside facade activities", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_activity VALUES ('core-active', 'active')`)
        yield* db.run(sql`INSERT INTO session_facade_activity VALUES ('facade-settled', 'settled')`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.session_activity.recovery).toBe(1)
        expect(inventory.byCategory.session_activity.resolved).toBe(1)
        expect(inventory.total).toBe(3)
      }),
    )
  })

  test("recovery commands require an exact durable attempt and terminal bridge", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        const attempt = identity()
        const descriptor = SessionProviderRecovery.classify(baseClassify(attempt))
        const descriptorId = `descriptor_${RecoveryCommandContract.recoveryDescriptorDigest(descriptor)}`
        yield* db.run(sql`
          INSERT INTO session_provider_recovery_descriptor
            (descriptor_id, session_id, activity_id, turn_id, kind, payload, content_hash, created_at)
          VALUES (
            ${descriptorId}, ${attempt.sessionId}, ${attempt.activityId}, '1',
            ${descriptor.descriptorKind}, ${JSON.stringify(descriptor)},
            ${RecoveryCommandContract.recoveryDescriptorDigest(descriptor)}, 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt (
            attempt_id, state, session_id, activity_id, provider_turn_seq, attempt_version,
            selection_id, projection_hash, request_hash, provider_id, owner_token
          ) VALUES (
            ${attempt.attemptId}, 'indeterminate_after_crash', ${attempt.sessionId},
            ${attempt.activityId}, ${attempt.providerTurnSeq}, 2, ${attempt.selectionId},
            ${attempt.projectionHash}, ${attempt.requestHash}, ${attempt.providerId}, 'owner_inv'
          )
        `)
        yield* db.run(sql`
          INSERT INTO recovery_command VALUES (
            'command-exact', ${descriptorId}, ${JSON.stringify(attempt)}, 'pending',
            'owner_inv', NULL, 'user', 'operator', 1, 1
          )
        `)

        const pending = yield* StartupInventory.classifyStartup(db)
        expect(pending.byCategory.recovery_command.recovery).toBe(1)
        expect(pending.byCategory.recovery_command.unclassified).toBe(0)

        yield* db.run(sql`UPDATE session SET execution_claim_token = 2 WHERE id = ${attempt.sessionId}`)
        const successorClaim = yield* StartupInventory.classifyStartup(db)
        expect(successorClaim.byCategory.recovery_command.unclassified).toBe(1)
        expect(successorClaim.ready).toBe(false)
        yield* db.run(sql`UPDATE session SET execution_claim_token = 1 WHERE id = ${attempt.sessionId}`)

        yield* db.run(sql`
          UPDATE recovery_command SET state = 'abandoned', result_hash = ${"x".repeat(64)}
          WHERE command_id = 'command-exact'
        `)
        const shellTerminal = yield* StartupInventory.classifyStartup(db)
        expect(shellTerminal.byCategory.recovery_command.unclassified).toBe(1)
        expect(shellTerminal.ready).toBe(false)

        yield* db.run(sql`
          UPDATE session_provider_attempt
          SET state = 'resolved_abandoned', attempt_version = 3
          WHERE attempt_id = ${attempt.attemptId}
        `)
        yield* db.run(sql`
          INSERT INTO session_provider_attempt_resolution VALUES ('resolution-exact', ${attempt.attemptId}, 'abandoned')
        `)
        yield* db.run(sql`
          INSERT INTO session_v2_provider_turn_receipt VALUES (
            'receipt-exact', 'indeterminate_after_crash', ${attempt.attemptId},
            ${attempt.sessionId}, ${attempt.activityId}, ${attempt.providerTurnSeq},
            ${attempt.requestHash}, ${attempt.providerId}, 'owner_inv'
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_v2_provider_recovery_bridge
          VALUES ('resolution-exact', ${attempt.attemptId}, 'receipt-exact', 'command-exact')
        `)
        const staleTerminalClaim = yield* StartupInventory.classifyStartup(db)
        expect(staleTerminalClaim.byCategory.recovery_command.unclassified).toBe(1)
        expect(staleTerminalClaim.ready).toBe(false)
        yield* db.run(sql`UPDATE session SET execution_claim_token = NULL WHERE id = ${attempt.sessionId}`)
        const resolved = yield* StartupInventory.classifyStartup(db)
        expect(resolved.byCategory.recovery_command.resolved).toBe(1)
        expect(resolved.byCategory.recovery_command.unclassified).toBe(0)
        expect(resolved.ready).toBe(true)
      }),
    )
  })

  test("an orphan recovery command blocks ready instead of disappearing from startup", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`
          INSERT INTO recovery_command VALUES (
            'command-orphan', NULL, ${JSON.stringify(identity())}, 'pending',
            'owner_inv', NULL, 'user', 'operator', 1, 1
          )
        `)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.ready).toBe(false)
        expect(inventory.unclassifiedItems).toContainEqual({
          category: "recovery_command",
          id: "command-orphan",
          classification: "unclassified",
          state: "pending",
          reason: "recovery command has no verifiable bound descriptor",
        })
      }),
    )
  })

  test("native terminals resolve, but resolved_* state without resolution bridge fails closed", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_provider_attempt(attempt_id, state) VALUES
          ('att-settled', 'settled'),
          ('att-failed', 'failed'),
          ('att-abandoned', 'resolved_abandoned'),
          ('att-replayed', 'resolved_replayed')`)
        yield* db.run(sql`INSERT INTO task_run
          VALUES ('task-err', 'error', NULL, NULL), ('task-cancel', 'cancelled', NULL, NULL)`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.provider_attempt.resolved).toBe(2)
        expect(inventory.byCategory.provider_attempt.unclassified).toBe(2)
        expect(inventory.byCategory.task_run.resolved).toBe(2)
        expect(inventory.ready).toBe(false)
      }),
    )
  })

  test("an unclassified item (unknown state) makes the inventory not ready", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_provider_attempt(attempt_id, state) VALUES ('att-weird', 'teleported')`)

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

  test("a settled grant cannot hide a corrupt tool-effect state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_v2_tool_effect_admission VALUES ('adm-corrupt', 'receipt-corrupt', 'call-corrupt')`)
        yield* db.run(sql`INSERT INTO session_v2_tool_effect VALUES
          ('effect-corrupt', 'receipt-corrupt', 'call-corrupt', 'teleported', 'settled')`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.ready).toBe(false)
        expect(inventory.unclassifiedItems).toEqual([
          {
            category: "tool_effect",
            id: "adm-corrupt",
            classification: "unclassified",
            state: "teleported",
            reason: "unknown tool effect state 'teleported'",
          },
        ])
      }),
    )
  })

  test("missing receipt-attempt binding blocks ready", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_v2_provider_turn_receipt VALUES
          ('receipt-orphan', 'preparing', NULL, 'sess', 'activity', 1, 'request', 'provider', 'owner')`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.ready).toBe(false)
        expect(inventory.unclassifiedItems).toContainEqual({
          category: "provider_binding",
          id: "receipt-orphan",
          classification: "unclassified",
          state: "preparing",
          reason: "provider receipt/attempt exact binding missing or mismatched",
        })
      }),
    )
  })

  test("pending input and event ledgers are visible to startup recovery", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_input VALUES ('input-pending', 'steer', NULL)`)
        yield* db.run(sql`INSERT INTO deepagent_event_outbox VALUES
          ('outbox-pending', 'pending', NULL, NULL, NULL, NULL)`)
        yield* db.run(sql`INSERT INTO deepagent_event_consumer_delivery VALUES
          ('outbox-pending', 'consumer', 'pending', NULL, NULL, NULL, NULL)`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.session_input.safe_before_dispatch).toBe(1)
        expect(inventory.byCategory.event_outbox.safe_before_dispatch).toBe(1)
        expect(inventory.byCategory.event_delivery.safe_before_dispatch).toBe(1)
        expect(inventory.ready).toBe(true)
      }),
    )
  })

  test("corrupt cursor authority and unknown event states fail closed", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`UPDATE event_sync_backfill SET cursor_rowid = 2, high_water_rowid = 1`)
        yield* db.run(sql`INSERT INTO deepagent_event_outbox VALUES
          ('outbox-corrupt', 'teleported', NULL, NULL, NULL, NULL)`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.ready).toBe(false)
        expect(inventory.unclassifiedItems.map((item) => item.category).sort()).toEqual([
          "event_outbox",
          "sync_projection",
        ])
      }),
    )
  })

  test("unclassified=0 makes the inventory ready (total classification)", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* createTables(db)
        yield* db.run(sql`INSERT INTO session_provider_attempt(attempt_id, state) VALUES ('att-prep', 'prepared')`)
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
        yield* db.run(sql`INSERT INTO session_provider_attempt(attempt_id, state) VALUES ('att-a', 'streaming'), ('att-b', 'settled')`)
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
        yield* db.run(sql`INSERT INTO session_v2_tool_effect_admission VALUES
          ('adm-settled', 'receipt-settled', 'call-settled'),
          ('adm-started', 'receipt-started', 'call-started'),
          ('adm-unknown', 'receipt-unknown', 'call-unknown'),
          ('adm-nogrant', 'receipt-nogrant', 'call-nogrant'),
          ('adm-orphan', 'receipt-orphan', 'call-orphan')`)
        yield* db.run(sql`INSERT INTO session_v2_tool_effect VALUES
          ('eff-settled', 'receipt-settled', 'call-settled', 'settled', 'settled'),
          ('eff-started', 'receipt-started', 'call-started', 'failed', 'started'),
          ('eff-unknown', 'receipt-unknown', 'call-unknown', 'settled', 'unknown'),
          ('eff-nogrant', 'receipt-nogrant', 'call-nogrant', 'failed', NULL)`)

        const inventory = yield* StartupInventory.classifyStartup(db)
        expect(inventory.byCategory.tool_effect.resolved).toBe(1)
        expect(inventory.byCategory.tool_effect.recovery).toBe(4)
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
        yield* db.run(sql`INSERT INTO session_provider_attempt(attempt_id, state) VALUES ('att-a', 'indeterminate_after_crash')`)
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
