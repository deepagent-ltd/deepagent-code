import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import { PostVerify, PostVerifyError } from "@deepagent-code/core/database/post-verify"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

// C1A-11 POST-MIGRATION GATE. After apply() reaches 'verifying' and BEFORE the run may advance to
// 'ready' (business admission), the gate runs DataIntegrity (quick_check + foreign_key_check +
// registry-set equality) and RecoveryBinding.audit. A failing verdict routes the run to
// recovery_required under a stable code and is NEVER advanced to ready. The gate is idempotent:
// re-running apply() on an already-recovery_required run does not double-fail.

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

/** Minimal copies of the recovery tables RecoveryBinding.audit reads (empty => the audit passes). */
const createRecoveryTables = (db: EffectDrizzleSqlite.EffectSQLiteDatabase) =>
  Effect.gen(function* () {
    yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY, execution_claim_token INTEGER)`)
    yield* db.run(sql`CREATE TABLE session_provider_attempt (attempt_id TEXT PRIMARY KEY, session_id TEXT, activity_id TEXT, provider_turn_seq INTEGER, attempt_version INTEGER, execution_claim_token INTEGER NOT NULL DEFAULT 1, selection_id TEXT, projection_hash TEXT, request_hash TEXT, provider_id TEXT, owner_token TEXT, state TEXT)`)
    yield* db.run(sql`CREATE TABLE session_v2_provider_turn_receipt (receipt_id TEXT PRIMARY KEY, session_id TEXT, activity_id TEXT, provider_turn_seq INTEGER, provider_attempt_id TEXT, request_input_hash TEXT, provider_id TEXT, owner_token TEXT, state TEXT)`)
    yield* db.run(sql`CREATE TABLE session_v2_tool_effect_admission (admission_id TEXT PRIMARY KEY, session_id TEXT, receipt_id TEXT, provider_attempt_id TEXT, tool_call_id TEXT, tool_name TEXT, effect_kind TEXT, owner_token TEXT)`)
    yield* db.run(sql`CREATE TABLE session_v2_tool_effect (effect_id TEXT PRIMARY KEY, session_id TEXT, receipt_id TEXT, provider_attempt_id TEXT, tool_call_id TEXT, tool_name TEXT, effect_kind TEXT, owner_token TEXT, grant_receipt_id TEXT, grant_owner_id TEXT, grant_state TEXT, grant_version TEXT, state TEXT)`)
    yield* db.run(sql`CREATE TABLE session_v2_task_run_receipt (receipt_id TEXT PRIMARY KEY, run_id TEXT, generation INTEGER, owner_token TEXT, state TEXT)`)
    yield* db.run(sql`CREATE TABLE task_run (run_id TEXT PRIMARY KEY, generation INTEGER, execution_owner TEXT, state TEXT, lease_expires_at INTEGER)`)
    // C1B-10 startup inventory surfaces (real implementation wired into post-verify): every table
    // classifyStartup reads, so the clean fixture keeps the inventory total (unclassified = 0).
    yield* db.run(sql`CREATE TABLE event_snapshot_attempt (snapshot_id TEXT PRIMARY KEY, state TEXT)`)
    yield* db.run(sql`CREATE TABLE event_compaction_receipt (aggregate_id TEXT PRIMARY KEY, state TEXT)`)
    yield* db.run(sql`CREATE TABLE session_v2_compaction_request (request_id TEXT PRIMARY KEY, status TEXT)`)
    yield* db.run(sql`CREATE TABLE session_facade_activity (activity_id TEXT PRIMARY KEY, state TEXT)`)
    yield* db.run(sql`CREATE TABLE session_activity (activity_id TEXT PRIMARY KEY, state TEXT)`)
    // W2 C1B recovery descriptor + command surface — created so classifyStartup is total.
    yield* db.run(sql`CREATE TABLE session_provider_recovery_descriptor
      (descriptor_id TEXT PRIMARY KEY, session_id TEXT, activity_id TEXT, turn_id TEXT,
       kind TEXT NOT NULL, payload TEXT, content_hash TEXT, created_at INTEGER)`)
    yield* db.run(sql`CREATE TABLE recovery_command
      (command_id TEXT PRIMARY KEY, descriptor_id TEXT, attempt TEXT, state TEXT,
       expected_owner_token TEXT, result_hash TEXT, actor_type TEXT, actor_id TEXT, command_kind TEXT, evidence TEXT,
       created_at INTEGER, updated_at INTEGER)`)
    yield* db.run(sql`CREATE TABLE session_provider_attempt_resolution (resolution_id TEXT PRIMARY KEY, attempt_id TEXT, decision TEXT)`)
    yield* db.run(sql`CREATE TABLE session_v2_provider_recovery_bridge (resolution_id TEXT PRIMARY KEY, attempt_id TEXT, receipt_id TEXT, command_id TEXT)`)
    yield* db.run(sql`CREATE TABLE session_input (id TEXT PRIMARY KEY, delivery TEXT, promoted_seq INTEGER)`)
    yield* db.run(sql`CREATE TABLE deepagent_event_outbox (outbox_id TEXT PRIMARY KEY, status TEXT, claim_token TEXT, claimant_id TEXT, lease_expires_at INTEGER, published_at INTEGER)`)
    yield* db.run(sql`CREATE TABLE deepagent_event_consumer (consumer_key TEXT PRIMARY KEY)`)
    yield* db.run(sql`CREATE TABLE deepagent_event_consumer_delivery (outbox_id TEXT, consumer_key TEXT, status TEXT, claim_token TEXT, claimant_id TEXT, lease_expires_at INTEGER, resolved_at INTEGER, PRIMARY KEY (outbox_id, consumer_key))`)
    yield* db.run(sql`CREATE TABLE event_sync_backfill (id INTEGER PRIMARY KEY, state TEXT, cursor_rowid INTEGER, high_water_rowid INTEGER, completed_at INTEGER)`)
    yield* db.run(sql`CREATE TABLE event_sync_sequence (id INTEGER PRIMARY KEY, backfill_complete INTEGER)`)
    // The sync-projection authority row always classifies: seed the complete state so a clean
    // fixture is resolved (an absent/corrupt authority is unclassified and blocks ready).
    yield* db.run(sql`INSERT INTO event_sync_backfill VALUES (1, 'complete', 0, 0, 1)`)
    yield* db.run(sql`INSERT INTO event_sync_sequence VALUES (1, 1)`)
  })

const setup = Effect.gen(function* () {
  const db = yield* makeDb
  yield* db.run("PRAGMA foreign_keys = ON")
  yield* DatabaseUpgradeRun.ensureTables(db)
  yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
  yield* createRecoveryTables(db)
  return db
})

const entry = (db: EffectDrizzleSqlite.EffectSQLiteDatabase) =>
  db.get<{ run_id: string; state: string; failure_code: string | null }>(
    sql`SELECT run_id, state, failure_code FROM database_upgrade_run LIMIT 1`,
  )

/** Run a PostVerify.run and return the failing stable code, asserting the run was set to recovery_required. */
const gateFails = (
  db: EffectDrizzleSqlite.EffectSQLiteDatabase,
  options: { runId: string; registryIds: readonly string[] },
): Effect.Effect<PostVerifyError["code"], never> =>
  Effect.gen(function* () {
    const verdict = yield* PostVerify.run(db, options).pipe(
      Effect.match({
        onFailure: (err: unknown) => ({
          ok: false as const,
          code: (err as PostVerifyError).code as PostVerifyError["code"],
        }),
        onSuccess: () => ({ ok: true as const }),
      }),
    )
    if (verdict.ok) return yield* Effect.die(new Error("expected a gate failure"))
    return verdict.code
  })

describe("PostVerify post-migration gate (C1A-11)", () => {
  test("a clean fixture passes the gate (no throw)", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        yield* db.run(sql`INSERT INTO migration VALUES ('m-1', 1), ('m-2', 1)`)
        yield* PostVerify.run(db, { runId: "run-1", registryIds: ["m-1", "m-2"] })
        // No throw == the gate passed; a caller may now advance verifying -> ready.
      }),
    )
  })

  test("orphaned foreign-key reference -> post_verify_foreign_keys", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        yield* db.run(sql`INSERT INTO migration VALUES ('m-1', 1)`)
        yield* db.run(sql`CREATE TABLE parent (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id))`)
        yield* db.run(sql`INSERT INTO parent VALUES ('p-1')`)
        yield* db.run(sql`PRAGMA foreign_keys = OFF`)
        yield* db.run(sql`INSERT INTO child VALUES ('c-orphan', 'missing-parent')`)
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        const code = yield* gateFails(db, { runId: "run-1", registryIds: ["m-1"] })
        expect(code).toBe("post_verify_foreign_keys")
      }),
    )
  })

  test("registry-set mismatch -> post_verify_registry_mismatch", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        yield* db.run(sql`INSERT INTO migration VALUES ('m-1', 1)`)
        const code = yield* gateFails(db, { runId: "run-1", registryIds: ["m-1", "m-2"] })
        expect(code).toBe("post_verify_registry_mismatch")
      }),
    )
  })

  test("recovery binding problem -> post_verify_recovery_binding", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        yield* db.run(sql`INSERT INTO migration VALUES ('m-1', 1)`)
        // A provider-turn receipt bound to an attempt id that doesn't exist breaks the binding.
        yield* db.run(sql`
          INSERT INTO session_v2_provider_turn_receipt
            (receipt_id, session_id, activity_id, provider_turn_seq, provider_attempt_id, owner_token)
          VALUES ('r-1', 's-1', 'a-1', 1, 'missing-attempt', 'owner-1')
        `)
        const code = yield* gateFails(db, { runId: "run-1", registryIds: ["m-1"] })
        expect(code).toBe("post_verify_recovery_binding")
      }),
    )
  })

  test("clean fixture through apply() advances to ready", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run("PRAGMA foreign_keys = ON")
        const resumed = yield* DatabaseMigration.apply(db)
        expect(resumed).not.toBeUndefined()
        expect(resumed!.state).toBe("ready")
      }),
    )
  }, 60_000)

  test("an injected failing gate makes apply() return recovery_required, never ready", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run("PRAGMA foreign_keys = ON")
        const outcome = yield* DatabaseMigration.apply(db, {
          postVerify: () =>
            Effect.fail(new PostVerifyError({ code: "post_verify_quick_check_failed", detail: "injected" })),
        }).pipe(Effect.exit)
        expect(outcome._tag).toBe("Failure")
        const row = yield* entry(db)
        expect(row!.state).toBe("recovery_required")
        expect(row!.failure_code).toBe("post_verify_quick_check_failed")
      }),
    )
  }, 60_000)

  test("gate is idempotent: re-running apply() on a recovery_required run does not double-fail", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run("PRAGMA foreign_keys = ON")
        const first = yield* DatabaseMigration.apply(db, {
          postVerify: () =>
            Effect.fail(new PostVerifyError({ code: "post_verify_quick_check_failed", detail: "injected" })),
        }).pipe(Effect.exit)
        expect(first._tag).toBe("Failure")
        const afterFirst = yield* entry(db)
        expect(afterFirst!.state).toBe("recovery_required")

        // Re-run with the REAL gate. All migrations are already applied (the injected gate runs AFTER
        // applyMigrations), so readCompletedSet finds no pending IDs and apply() returns early without
        // re-failing or rewriting the run's recovery code.
        const second = yield* DatabaseMigration.apply(db).pipe(Effect.exit)
        expect(second._tag).toBe("Success")
        const afterSecond = yield* entry(db)
        expect(afterSecond!.state).toBe("recovery_required")
        expect(afterSecond!.failure_code).toBe("post_verify_quick_check_failed")
      }),
    )
  }, 60_000)
})
