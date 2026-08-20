import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const migrationID = "20260819120000_session_intent_confirmation_state"
const documentedStates = [
  "preparing",
  "awaiting_confirmation",
  "selected",
  "admitting",
  "admitted",
  "canceled",
  "superseded",
  "failed",
] as const

// sha256("[]") — the released-refs fingerprint used by unrelated receipt seeds.
const emptyReleasedRefsFingerprint = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

describe("session intent confirmation state migration", () => {
  test("enforces the BUG-405-003 state contract on a fresh database and stays idempotent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        // Mirror the runtime connection (Database.layer enables FK before migrating).
        yield* db.run(`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)

        const check = yield* db.get<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_intent'`,
        )
        expect(check).toBeDefined()
        for (const state of documentedStates) expect(check!.sql).toContain(`'${state}'`)

        yield* db.run(`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-intent-check', '/repo', '[]', 1, 1)
        `)
        yield* db.run(`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, mutation_epoch, time_created, time_updated
          ) VALUES (
            'session-intent-check', 'project-intent-check', 'intent-check', '/repo',
            'Intent check', '1', 0, 1, 1
          )
        `)

        for (const [index, state] of documentedStates.entries()) {
          yield* db.run(`
            INSERT INTO session_intent (
              intent_id, session_id, source, state, time_created, time_updated
            ) VALUES (
              'intent-check-${state}', 'session-intent-check', 'composer', '${state}', ${index + 1}, ${index + 1}
            )
          `)
        }
        expect(
          yield* db.get(`SELECT count(*) AS count FROM session_intent WHERE session_id = 'session-intent-check'`),
        ).toEqual({ count: documentedStates.length })

        for (const invalidState of ["awaiting_review", "confirmed", "drafted"]) {
          const rejected = yield* db
            .run(`
              INSERT INTO session_intent (
                intent_id, session_id, source, state, time_created, time_updated
              ) VALUES (
                'intent-check-invalid-${invalidState}', 'session-intent-check', 'composer',
                '${invalidState}', 1, 1
              )
            `)
            .pipe(Effect.exit)
          expect(Exit.isFailure(rejected)).toBe(true)
        }
        expect(
          yield* db.get(`SELECT count(*) AS count FROM session_intent WHERE session_id = 'session-intent-check'`),
        ).toEqual({ count: documentedStates.length })

        const before = yield* db.get<{ count: number }>(`SELECT count(*) AS count FROM migration`)
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get(`SELECT count(*) AS count FROM migration`)).toEqual(before)
        expect(yield* db.all(`PRAGMA foreign_key_check`)).toEqual([])
      }),
    )
  })

  test("preserves durable intent receipts and the legacy activity chain while widening the state CHECK", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const migrationIndex = migrations.findIndex((migration) => migration.id === migrationID)
        expect(migrationIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, migrationIndex))
        yield* db.run(`PRAGMA foreign_keys = ON`)

        // Historical databases predate the widened contract: only the legacy six states exist.
        const rejectedBefore = yield* db
          .run(`
            INSERT INTO session_intent (
              intent_id, session_id, source, state, time_created, time_updated
            ) VALUES ('intent-pre-check', 'session-missing', 'composer', 'awaiting_confirmation', 1, 1)
          `)
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejectedBefore)).toBe(true)

        yield* db.run(`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-intent-state', '/repo', '[]', 1, 1)
        `)
        yield* db.run(`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, mutation_epoch, time_created, time_updated
          ) VALUES (
            'session-intent-state', 'project-intent-state', 'intent-state', '/repo',
            'Intent state', '1', 2, 1, 1
          )
        `)
        yield* db.run(`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('message-intent-state', 'session-intent-state', 1, 1, '{}')
        `)
        yield* db.run(`
          INSERT INTO session_provider_owner_lease (owner_token, registered_at, heartbeat_at, lease_expires_at)
          VALUES (
            'owner-intent-state',
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 10000
          )
        `)
        yield* db.run(`
          INSERT INTO context_security_namespace (id, kind, binding_hash, created_at)
          VALUES ('sec_intent_state', 'implicit_local', 'receipt-namespace-binding', 1)
        `)
        yield* db.run(`
          INSERT INTO context_project_scope_identity (
            security_namespace_id, project_scope_key, project_kind, project_identity_hash, created_at
          ) VALUES (
            'sec_intent_state', 'prjctx_intent_state', 'registered_root', 'receipt-project-identity', 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id, assistant_message_id,
            provider_id, model_id, registry_tool_ids, permission_filtered_tool_ids,
            final_offered_tool_ids, call_ids, released_knowledge_security_namespace_id,
            released_knowledge_project_scope_key, released_knowledge_binding_state,
            released_knowledge_exact_refs, released_knowledge_exact_refs_fingerprint,
            owner_token, request_state, created_at
          ) VALUES (
            'receipt-intent-state', 1, 'session-intent-state', 'message-intent-state',
            'message-intent-state', 'provider-test', 'model-test', '[]', '[]', '[]', '[]',
            'sec_intent_state', 'prjctx_intent_state', 'unavailable', '[]',
            '${emptyReleasedRefsFingerprint}', 'owner-intent-state', 'dispatched', 1
          )
        `)

        for (const [index, state] of ["preparing", "admitting", "canceled", "superseded", "failed"].entries()) {
          yield* db.run(`
            INSERT INTO session_intent (
              intent_id, session_id, source, state, time_created, time_updated
            ) VALUES (
              'intent-state-${state}', 'session-intent-state', 'composer', '${state}', ${index + 1}, ${index + 1}
            )
          `)
        }
        // Admitted intent A backs an active activity with a claimed run.
        yield* db.run(`
          INSERT INTO session_intent (
            intent_id, session_id, source, state, selected_variant, selected_payload_hash,
            delivery, admitted_message_id, mutation_epoch, execution_mode, execution_state,
            execution_claim_id, execution_claimed_at, version, time_created, time_selected,
            time_admitted, time_updated
          ) VALUES (
            'intent-state-a', 'session-intent-state', 'composer', 'admitted', 'original',
            'payload-intent-state-a', 'turn', 'message-intent-state', 3, 'run_now', 'claimed',
            'run-intent-state-a', 2, 1, 1, 1, 1, 2
          )
        `)
        // Admitted intent B backs an activity settled outside a run (recovery terminal path).
        yield* db.run(`
          INSERT INTO session_intent (
            intent_id, session_id, source, state, selected_variant, selected_payload_hash,
            delivery, admitted_message_id, mutation_epoch, execution_mode, execution_state,
            version, time_created, time_selected, time_admitted, time_updated
          ) VALUES (
            'intent-state-b', 'session-intent-state', 'intelligence', 'admitted', 'rewritten',
            'payload-intent-state-b', 'turn', 'message-intent-state', 4, 'run_now', 'pending',
            1, 1, 1, 1, 2
          )
        `)
        yield* db.run(`
          INSERT INTO session_activity_admission (
            admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id,
            delivery, payload_fingerprint_kind, payload_fingerprint, created_at, execution_mode
          ) VALUES (
            'admission-intent-state-a', 'session-intent-state', 'legacy_intent', 'intent-state-a',
            'message-intent-state', 'turn', 'payload_hash', 'payload-intent-state-a', 1, 'run_now'
          )
        `)
        yield* db.run(`
          INSERT INTO session_activity_admission (
            admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id,
            delivery, payload_fingerprint_kind, payload_fingerprint, created_at, execution_mode
          ) VALUES (
            'admission-intent-state-b', 'session-intent-state', 'legacy_intent', 'intent-state-b',
            'message-intent-state', 'turn', 'payload_hash', 'payload-intent-state-b', 1, 'run_now'
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity (
            activity_id, session_id, ordinal, trigger_admission_id, owner_token,
            state, terminal_reason, created_at, settled_at
          ) VALUES (
            'activity-intent-state-a', 'session-intent-state', 0, 'admission-intent-state-a',
            'owner-intent-state', 'active', NULL, 1, NULL
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity (
            activity_id, session_id, ordinal, trigger_admission_id, owner_token,
            state, terminal_reason, created_at, settled_at
          ) VALUES (
            'activity-intent-state-b', 'session-intent-state', 1, 'admission-intent-state-b',
            'owner-intent-state', 'settled', 'user completed', 1, 3
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity_admission (
            activity_id, admission_id, ordinal, role, attached_at
          ) VALUES ('activity-intent-state-a', 'admission-intent-state-a', 0, 'trigger', 1)
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity_admission (
            activity_id, admission_id, ordinal, role, attached_at
          ) VALUES ('activity-intent-state-b', 'admission-intent-state-b', 0, 'trigger', 1)
        `)
        yield* db.run(`
          INSERT INTO session_activity_progress (
            activity_id, revision, assistant_message_id, provider_receipt_id, state,
            created_at, settled_at, input_membership_ordinal
          ) VALUES (
            'activity-intent-state-a', 0, 'message-intent-state', 'receipt-intent-state',
            'progress', 1, 2, 0
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity_run (
            run_id, activity_id, session_id, mutation_epoch, generation, owner_token,
            state, started_at
          ) VALUES (
            'run-intent-state-a', 'activity-intent-state-a', 'session-intent-state', 3, 0,
            'owner-intent-state', 'running', 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity_terminal (
            activity_id, session_id, mutation_epoch, state, reason_code, source,
            operation_id, membership_ordinal, owner_token, created_at
          ) VALUES (
            'activity-intent-state-b', 'session-intent-state', 4, 'settled', 'user completed',
            'restart_recovery', 'operation-intent-state-b', 0, 'owner-intent-state', 3
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity_migration_receipt (
            receipt_id, batch_id, activity_id, classifier_version, before_state, after_state,
            evidence_hash, terminal_operation_id, created_at
          ) VALUES (
            'receipt-migration-intent-state', 'batch-intent-state', 'activity-intent-state-b',
            'legacy-terminal-state-v1', 'settled', 'settled', 'evidence-intent-state',
            'operation-intent-state-b', 3
          )
        `)

        const snapshot = {
          intents: yield* db.all(`SELECT intent_id, state FROM session_intent ORDER BY intent_id`),
          admissions: yield* db.all(`SELECT admission_id, execution_mode FROM session_activity_admission ORDER BY admission_id`),
          activities: yield* db.all(`SELECT activity_id, state FROM session_legacy_activity ORDER BY activity_id`),
          joins: yield* db.all(`SELECT activity_id, role FROM session_legacy_activity_admission ORDER BY activity_id`),
          progress: yield* db.all(`SELECT activity_id, state FROM session_activity_progress ORDER BY activity_id, revision`),
          runs: yield* db.all(`SELECT run_id, state FROM session_legacy_activity_run ORDER BY run_id`),
          terminals: yield* db.all(`SELECT activity_id, state, source FROM session_legacy_activity_terminal ORDER BY activity_id`),
          receipts: yield* db.all(`SELECT receipt_id, after_state FROM session_legacy_activity_migration_receipt ORDER BY receipt_id`),
        }

        yield* DatabaseMigration.applyOnly(db, migrations.slice(migrationIndex, migrationIndex + 1))
        // Apply the migrations registered after the intent rebuild too, so the full-history
        // re-apply below asserts a true no-op against the current registry.
        yield* DatabaseMigration.applyOnly(db, migrations.slice(migrationIndex + 1))

        const widenedCheck = yield* db.get<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_intent'`,
        )
        expect(widenedCheck).toBeDefined()
        expect(widenedCheck!.sql).toContain("'awaiting_confirmation'")
        expect(widenedCheck!.sql).toContain("'selected'")

        expect(yield* db.all(`SELECT intent_id, state FROM session_intent ORDER BY intent_id`)).toEqual(
          snapshot.intents,
        )
        expect(
          yield* db.all(`SELECT admission_id, execution_mode FROM session_activity_admission ORDER BY admission_id`),
        ).toEqual(snapshot.admissions)
        expect(yield* db.all(`SELECT activity_id, state FROM session_legacy_activity ORDER BY activity_id`)).toEqual(
          snapshot.activities,
        )
        expect(
          yield* db.all(`SELECT activity_id, role FROM session_legacy_activity_admission ORDER BY activity_id`),
        ).toEqual(snapshot.joins)
        expect(
          yield* db.all(`SELECT activity_id, state FROM session_activity_progress ORDER BY activity_id, revision`),
        ).toEqual(snapshot.progress)
        expect(yield* db.all(`SELECT run_id, state FROM session_legacy_activity_run ORDER BY run_id`)).toEqual(
          snapshot.runs,
        )
        expect(
          yield* db.all(`SELECT activity_id, state, source FROM session_legacy_activity_terminal ORDER BY activity_id`),
        ).toEqual(snapshot.terminals)
        expect(
          yield* db.all(
            `SELECT receipt_id, after_state FROM session_legacy_activity_migration_receipt ORDER BY receipt_id`,
          ),
        ).toEqual(snapshot.receipts)
        expect(
          yield* db.get(`
            SELECT execution_claim_id, selected_payload_hash, mutation_epoch
            FROM session_intent WHERE intent_id = 'intent-state-a'
          `),
        ).toEqual({
          execution_claim_id: "run-intent-state-a",
          selected_payload_hash: "payload-intent-state-a",
          mutation_epoch: 3,
        })

        expect(
          yield* db.all(`
            SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND name IN (
              'session_intent_execution_validate_insert',
              'session_intent_execution_validate_update',
              'session_activity_admission_validate_insert',
              'session_activity_admission_immutable',
              'session_activity_admission_execution_mode_validate_insert',
              'session_legacy_activity_legal_update',
              'session_legacy_activity_objective_insert',
              'session_legacy_activity_objective_terminal_projection',
              'session_legacy_activity_permission_effect_terminal_guard',
              'session_legacy_activity_admission_validate_insert',
              'session_legacy_activity_admission_immutable',
              'session_activity_progress_validate_insert',
              'session_activity_progress_legal_update',
              'session_legacy_activity_run_validate_insert',
              'session_legacy_activity_run_legal_update',
              'session_legacy_activity_terminal_validate_insert',
              'session_legacy_activity_terminal_immutable_update',
              'session_legacy_activity_terminal_immutable_delete',
              'session_legacy_activity_migration_receipt_immutable_update',
              'session_legacy_activity_migration_receipt_immutable_delete'
            )
            ORDER BY name
          `),
        ).toHaveLength(20)
        expect(
          yield* db.all(`
            SELECT name FROM sqlite_master
            WHERE type = 'index' AND name IN (
              'session_intent_session_state_idx',
              'session_legacy_activity_active_idx',
              'session_legacy_activity_run_generation_idx',
              'session_legacy_activity_live_run_idx',
              'session_legacy_activity_terminal_operation_idx',
              'session_legacy_activity_migration_batch_idx',
              'session_legacy_activity_migration_terminal_idx'
            )
            ORDER BY name
          `),
        ).toHaveLength(7)
        expect(yield* db.all(`PRAGMA foreign_key_check`)).toEqual([])

        // The widened contract now accepts the confirmation window and the CAS selection.
        yield* db.run(`
          INSERT INTO session_intent (
            intent_id, session_id, source, state, time_created, time_updated
          ) VALUES ('intent-state-confirm', 'session-intent-state', 'intelligence', 'awaiting_confirmation', 9, 9)
        `)
        yield* db.run(`
          INSERT INTO session_intent (
            intent_id, session_id, source, state, selected_variant, selected_payload_hash,
            time_created, time_selected, time_updated
          ) VALUES (
            'intent-state-selected', 'session-intent-state', 'intelligence', 'selected', 'rewritten',
            'payload-intent-state-selected', 9, 9, 9
          )
        `)
        const rejectedAfter = yield* db
          .run(`
            INSERT INTO session_intent (
              intent_id, session_id, source, state, time_created, time_updated
            ) VALUES ('intent-state-invalid', 'session-intent-state', 'composer', 'awaiting_review', 1, 1)
          `)
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejectedAfter)).toBe(true)

        // Reapplying the tracked history must remain a no-op (forward-only, idempotent).
        const before = yield* db.get<{ count: number }>(`SELECT count(*) AS count FROM migration`)
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get(`SELECT count(*) AS count FROM migration`)).toEqual(before)
        expect(yield* db.all(`SELECT intent_id, state FROM session_intent ORDER BY intent_id`)).not.toEqual(
          snapshot.intents,
        )
      }),
    )
  })
})
