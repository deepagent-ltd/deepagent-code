import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { RecoveryBinding } from "@deepagent-code/core/database/recovery-binding"
import { migrations } from "../src/database/migration.gen"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

// §16.4 DATA-AND-RECOVERY D-5 — recovery binding audit over the real schema (all 166 migrations
// applied in-memory). Consistent rows pass; each identity break is reported per row.

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

// Binding/hash guards require 64-char lowercase hex digests.
const H64 = (c: string) => c.repeat(64)

const setup = Effect.gen(function* () {
  const db = yield* EffectDrizzleSqlite.makeWithDefaults()
  // The audit queries join only the binding columns; foreign keys stay OFF so the minimal rows
  // bypass the federation-knowledge insert guards on unrelated parent tables.
  yield* db.run(sql`PRAGMA foreign_keys = OFF`)
  yield* DatabaseMigration.applyOnly(db, migrations)
  const ph = H64("a")
  const rh = H64("b")
  const oh = H64("c")
  const now = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`
  yield* db.run(sql`INSERT INTO session_provider_owner_lease(owner_token, registered_at, heartbeat_at, lease_expires_at) VALUES
    ('lease-1', ${now}, ${now}, ${now} + 3600000)`)
  yield* db.run(sql`INSERT INTO session_provider_attempt(attempt_id, session_id, activity_id, provider_turn_seq, selection_id, projection_hash, request_hash, provider_id, owner_token, state, created_at) VALUES
    ('att-1', 'ses-1', 'act-1', 1, 'sel-1', ${ph}, ${H64("b")}, 'prov', 'lease-1', 'settled', 1)`)
  yield* db.run(sql`INSERT INTO session_v2_provider_turn_receipt(receipt_id, session_id, request_ordinal, activity_id, provider_turn_seq, provider_attempt_id, user_message_id, history_prompt_epoch, request_input_hash, provider_id, model_id, protocol, owner_mode, owner_token, state, created_at) VALUES
    ('rcp-1', 'ses-1', 0, 'act-1', 1, 'att-1', 'inp-1', 42, ${H64("b")}, 'prov', 'model', 'http', 'v2', 'lease-1', 'preparing', 1)`)
  yield* db.run(sql`INSERT INTO session_v2_tool_effect(effect_id, session_id, provider_attempt_id, receipt_id, tool_call_id, tool_name, effect_kind, state, outcome_hash, owner_token, time_created) VALUES
    ('eff-1', 'ses-1', 'att-1', 'rcp-1', 'call-1', 'tool', 'mutating', 'settled', ${H64("c")}, 'lease-1', 1)`)
  yield* db.run(sql`INSERT INTO task_run(run_id, root_run_id, request_hash, parent_session_id, parent_message_id, tool_call_id, child_session_id, generation, delivery_mode, phase, state, execution_owner, time_created, time_updated) VALUES
    ('run-1', 'run-1', ${H64("b")}, 'ses-1', 'pmsg', 'tcall', 'ses-child', 3, 'foreground', 'settled', 'completed', 'lease-1', 1, 1)`)
  yield* db.run(sql`INSERT INTO session_v2_task_run_receipt(receipt_id, session_id, run_id, child_session_id, generation, state, reason, outcome_hash, owner_token, time_created) VALUES
    ('trcp-1', 'ses-1', 'run-1', 'ses-child', 3, 'completed', 'ok', ${H64("c")}, 'lease-1', 1)`)
  return db
})

describe("recovery binding audit", () => {
  test("passes a consistent snapshot", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        const verdict = yield* RecoveryBinding.audit(db)
        expect(verdict).toEqual({ ok: true, problems: [] })
      }),
    )
  })

  test("reports a receipt bound to an attempt with a different owner", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        // The attempt owner column is immutable by trigger, so the violation is seeded as
        // pre-guard historical data: drop the immutability guard, diverge the owner, audit.
        yield* db.run(sql`DROP TRIGGER session_provider_attempt_owner_immutable`)
        yield* db.run(sql`DROP TRIGGER session_provider_attempt_legal_update`)
        yield* db.run(sql`UPDATE session_provider_attempt SET owner_token = 'lease-2' WHERE attempt_id = 'att-1'`)
        const verdict = yield* RecoveryBinding.audit(db)
        expect(verdict.ok).toBe(false)
        expect(verdict.problems.some((p) => p.chain === "provider_turn" && p.kind === "receipt_attempt_mismatch")).toBe(true)
      }),
    )
  })

  test("reports partial grant evidence on a tool effect", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        // The insert guard rejects partial grants going forward, so the violation is seeded as
        // pre-guard historical data: drop the guard, insert the partial row, then audit.
        yield* db.run(sql`DROP TRIGGER session_v2_tool_effect_insert_guard`)
        yield* db.run(sql`INSERT INTO session_v2_tool_effect(effect_id, session_id, provider_attempt_id, receipt_id, tool_call_id, tool_name, effect_kind, state, outcome_hash, owner_token, time_created, grant_owner_id) VALUES
          ('eff-2', 'ses-1', 'att-1', 'rcp-1', 'call-2', 'tool', 'mutating', 'settled', ${H64("c")}, 'lease-1', 1, 'owner-x')`)
        const verdict = yield* RecoveryBinding.audit(db)
        expect(verdict.ok).toBe(false)
        expect(verdict.problems.some((p) => p.chain === "tool_effect" && p.kind === "partial_grant_evidence")).toBe(true)
      }),
    )
  })

  test("reports a task run receipt whose generation disagrees with the task run row", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* setup
        // The receipt identity is immutable by trigger, so the violation is seeded as pre-guard
        // historical data: drop the guard, diverge the generation, audit.
        yield* db.run(sql`DROP TRIGGER session_v2_task_run_receipt_update_guard`)
        yield* db.run(sql`UPDATE session_v2_task_run_receipt SET generation = 4 WHERE receipt_id = 'trcp-1'`)
        const verdict = yield* RecoveryBinding.audit(db)
        expect(verdict.ok).toBe(false)
        expect(verdict.problems.some((p) => p.chain === "task_run" && p.kind === "owner_generation_mismatch")).toBe(true)
      }),
    )
  })
})
