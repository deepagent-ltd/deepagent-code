import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { testEffect } from "./lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))
const runMigration = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const authorityRows = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return yield* db.all<{ table_name: string; row_count: number }>(`
    SELECT 'session' AS table_name, count(*) AS row_count
      FROM session WHERE id = 'ses_recovery_delete'
    UNION ALL SELECT 'session_intent', count(*)
      FROM session_intent WHERE session_id = 'ses_recovery_delete'
    UNION ALL SELECT 'session_activity_admission', count(*)
      FROM session_activity_admission WHERE session_id = 'ses_recovery_delete'
    UNION ALL SELECT 'session_legacy_activity', count(*)
      FROM session_legacy_activity WHERE session_id = 'ses_recovery_delete'
    UNION ALL SELECT 'session_legacy_activity_admission', count(*)
      FROM session_legacy_activity_admission WHERE activity_id = 'activity-recovery-delete'
    UNION ALL SELECT 'session_activity_progress', count(*)
      FROM session_activity_progress WHERE activity_id = 'activity-recovery-delete'
    UNION ALL SELECT 'session_tool_request_receipt', count(*)
      FROM session_tool_request_receipt WHERE session_id = 'ses_recovery_delete'
    UNION ALL SELECT 'session_legacy_activity_terminal', count(*)
      FROM session_legacy_activity_terminal WHERE session_id = 'ses_recovery_delete'
    UNION ALL SELECT 'session_legacy_activity_migration_receipt', count(*)
      FROM session_legacy_activity_migration_receipt WHERE activity_id = 'activity-recovery-delete'
    UNION ALL SELECT 'session_prompt_epoch', count(*)
      FROM session_prompt_epoch WHERE session_id = 'ses_recovery_delete'
    UNION ALL SELECT 'session_prompt_epoch_message', count(*)
      FROM session_prompt_epoch_message WHERE session_id = 'ses_recovery_delete'
    UNION ALL SELECT 'session_world_state_baseline', count(*)
      FROM session_world_state_baseline WHERE session_id = 'ses_recovery_delete'
    UNION ALL SELECT 'session_tool_request_resolution_command', count(*)
      FROM session_tool_request_resolution_command WHERE session_id = 'ses_recovery_delete'
    UNION ALL SELECT 'session_tool_request_resolution', count(*)
      FROM session_tool_request_resolution WHERE session_id = 'ses_recovery_delete'
    UNION ALL SELECT 'session_prompt_epoch_recovery', count(*)
      FROM session_prompt_epoch_recovery WHERE session_id = 'ses_recovery_delete'
    UNION ALL SELECT 'session_history_state', count(*)
      FROM session_history_state WHERE session_id = 'ses_recovery_delete'
  `)
})

describe("legacy provider recovery delete cascade", () => {
  test("rebuilds receipt ownership without losing valid argument or activity evidence", async () => {
    await runMigration(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        const recoveryIndex = migrations.findIndex((migration) => migration.id === "20260812120000_legacy_provider_recovery")
        expect(recoveryIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, recoveryIndex))

        yield* db.run(`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-receipt-upgrade', '/repo', '[]', 1, 1)
        `)
        yield* db.run(`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, time_created, time_updated
          ) VALUES (
            'ses_receipt_upgrade', 'project-receipt-upgrade', 'receipt-upgrade', '/repo',
            'Receipt upgrade', '1', 1, 1
          )
        `)
        yield* db.run(`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('msg_receipt_upgrade', 'ses_receipt_upgrade', 1, 1, '{"role":"assistant"}')
        `)
        yield* db.run(`
          INSERT INTO session_intent (
            intent_id, session_id, source, state, selected_variant, selected_payload_hash,
            delivery, admitted_message_id, mutation_epoch,
            time_created, time_selected, time_admitted, time_updated
          ) VALUES (
            'intent-receipt-upgrade', 'ses_receipt_upgrade', 'composer', 'admitted', 'original',
            'payload-receipt-upgrade', 'turn', 'msg_receipt_upgrade', 0,
            1, 1, 1, 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_activity_admission (
            admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id,
            delivery, payload_fingerprint_kind, payload_fingerprint, created_at
          ) VALUES (
            'admission-receipt-upgrade', 'ses_receipt_upgrade', 'legacy_intent',
            'intent-receipt-upgrade', 'msg_receipt_upgrade', 'turn', 'payload_hash',
            'payload-receipt-upgrade', 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity (
            activity_id, session_id, ordinal, trigger_admission_id, owner_token,
            state, terminal_reason, created_at, settled_at
          ) VALUES (
            'activity-receipt-upgrade', 'ses_receipt_upgrade', 0, 'admission-receipt-upgrade',
            'owner-receipt-upgrade', 'active', NULL, 1, NULL
          )
        `)
        yield* db.run(`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id, assistant_message_id,
            provider_id, model_id, registry_tool_ids, permission_filtered_tool_ids,
            final_offered_tool_ids, call_ids, request_state, request_error_code, created_at,
            prompt_epoch, prompt_window_id, effective_history_hash, request_input_hash,
            final_request_hash, provider_state, adapter_prepared_at, dispatching_at,
            terminal_at, owner_token
          ) VALUES (
            'receipt-upgrade-valid', 1, 'ses_receipt_upgrade', 'msg_receipt_upgrade',
            'msg_receipt_upgrade', 'provider', 'model', '[]', '[]', '[]', '[]',
            'dispatched', 'provider outcome unknown', 1, 0, 'window-upgrade',
            'history-upgrade', 'input-upgrade', 'final-upgrade', 'indeterminate_after_crash',
            1, 1, 2, 'owner-receipt-upgrade'
          )
        `)
        yield* db.run(`
          INSERT INTO session_tool_argument_receipt (
            receipt_id, layer, ordinal, event_type, payload_keys, unavailable_reason,
            created_at, validation_outcome
          ) VALUES (
            'receipt-upgrade-valid', 'raw_frame', 0, 'raw', '[]',
            'raw_receipt_gate_disabled', 1, 'schema_invalid'
          )
        `)
        yield* db.run(`
          INSERT INTO session_activity_progress (
            activity_id, revision, assistant_message_id, provider_receipt_id,
            state, created_at, settled_at
          ) VALUES (
            'activity-receipt-upgrade', 0, 'msg_receipt_upgrade',
            'receipt-upgrade-valid', 'progress', 1, 2
          )
        `)
        yield* db.run(`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id,
            registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
            request_state, request_error_code, created_at, provider_state, terminal_at
          ) VALUES (
            'receipt-upgrade-orphan', 1, 'ses_missing', 'msg_missing', 'provider', 'model',
            '[]', '[]', '[]', '[]', 'dispatched', 'historical orphan', 1,
            'indeterminate_after_crash', 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_tool_argument_receipt (
            receipt_id, layer, ordinal, event_type, payload_keys, unavailable_reason,
            created_at, validation_outcome
          ) VALUES (
            'receipt-upgrade-orphan', 'raw_frame', 0, 'raw', '[]',
            'raw_receipt_gate_disabled', 1, 'not_evaluated'
          )
        `)

        const receiptColumns = yield* db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(`
          SELECT name, type, "notnull", dflt_value
          FROM pragma_table_info('session_tool_request_receipt') ORDER BY cid
        `)
        yield* DatabaseMigration.applyOnly(db, [migrations[recoveryIndex]!])

        expect(
          yield* db.all(`
            SELECT name, type, "notnull", dflt_value
            FROM pragma_table_info('session_tool_request_receipt') ORDER BY cid
          `),
        ).toEqual(receiptColumns)
        expect(
          yield* db.get(`
            SELECT receipt_id, session_id, provider_state, final_request_hash, owner_token
            FROM session_tool_request_receipt WHERE receipt_id = 'receipt-upgrade-valid'
          `),
        ).toEqual({
          receipt_id: "receipt-upgrade-valid",
          session_id: "ses_receipt_upgrade",
          provider_state: "indeterminate_after_crash",
          final_request_hash: "final-upgrade",
          owner_token: "owner-receipt-upgrade",
        })
        expect(
          yield* db.get(`
            SELECT receipt_id, validation_outcome
            FROM session_tool_argument_receipt WHERE receipt_id = 'receipt-upgrade-valid'
          `),
        ).toEqual({ receipt_id: "receipt-upgrade-valid", validation_outcome: "schema_invalid" })
        expect(
          yield* db.get(`
            SELECT activity_id, provider_receipt_id, state
            FROM session_activity_progress WHERE activity_id = 'activity-receipt-upgrade'
          `),
        ).toEqual({
          activity_id: "activity-receipt-upgrade",
          provider_receipt_id: "receipt-upgrade-valid",
          state: "progress",
        })
        expect(
          yield* db.get(`SELECT receipt_id FROM session_tool_request_receipt WHERE receipt_id = 'receipt-upgrade-orphan'`),
        ).toBeUndefined()
        expect(
          yield* db.get(`SELECT receipt_id FROM session_tool_argument_receipt WHERE receipt_id = 'receipt-upgrade-orphan'`),
        ).toBeUndefined()
        expect(
          yield* db.all(`
            SELECT name FROM sqlite_master
            WHERE type = 'index' AND name IN (
              'session_tool_request_receipt_session_ordinal_idx',
              'session_tool_request_receipt_session_idx',
              'session_tool_request_receipt_msg_idx',
              'session_tool_request_receipt_prompt_window_idx',
              'session_tool_request_receipt_provider_state_idx'
            ) ORDER BY name
          `),
        ).toEqual([
          { name: "session_tool_request_receipt_msg_idx" },
          { name: "session_tool_request_receipt_prompt_window_idx" },
          { name: "session_tool_request_receipt_provider_state_idx" },
          { name: "session_tool_request_receipt_session_idx" },
          { name: "session_tool_request_receipt_session_ordinal_idx" },
        ])
        expect(
          yield* db.all(`
            SELECT name FROM sqlite_master
            WHERE type = 'trigger' AND name LIKE 'session_tool_request_receipt_%'
            ORDER BY name
          `),
        ).toEqual([
          { name: "session_tool_request_receipt_binding_immutable" },
          { name: "session_tool_request_receipt_dispatch_guard" },
          { name: "session_tool_request_receipt_parent_cleanup" },
          { name: "session_tool_request_receipt_provider_transition" },
          { name: "session_tool_request_receipt_response_guard" },
        ])
        expect(
          yield* db.all(`
            SELECT "table", "from", "to", on_delete
            FROM pragma_foreign_key_list('session_tool_request_receipt')
          `),
        ).toEqual([{ table: "session", from: "session_id", to: "id", on_delete: "CASCADE" }])
        expect(
          Exit.isFailure(
            yield* db
              .run(`
                UPDATE session_tool_request_receipt
                SET provider_state = 'streaming'
                WHERE receipt_id = 'receipt-upgrade-valid'
              `)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      }),
    )
  })

  it.live("deletes recovery and terminal activity authority with its parent Session", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service

      yield* db.run(`
        INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
        VALUES ('project-recovery-delete', '/repo', '[]', 1, 1)
      `)
      yield* db.run(`
        INSERT INTO session (
          id, project_id, slug, directory, title, version, mutation_epoch, time_created, time_updated
        ) VALUES (
          'ses_recovery_delete', 'project-recovery-delete', 'recovery-delete', '/repo',
          'Recovery delete', '1', 1, 1, 1
        )
      `)
      yield* db.run(`
        INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
          ('msg_recovery_delete_user', 'ses_recovery_delete', 1, 1, '{"role":"user"}'),
          ('msg_recovery_delete_assistant', 'ses_recovery_delete', 2, 2, '{"role":"assistant"}'),
          ('msg_recovery_delete_high_water', 'ses_recovery_delete', 3, 3, '{"role":"user"}')
      `)
      yield* db.run(`
        INSERT INTO session_intent (
          intent_id, session_id, source, state, selected_variant, selected_payload_hash,
          delivery, admitted_message_id, execution_mode, execution_state, mutation_epoch,
          time_created, time_selected, time_admitted, time_updated
        ) VALUES (
          'intent-recovery-delete', 'ses_recovery_delete', 'composer', 'admitted', 'original',
          'payload-recovery-delete', 'turn', 'msg_recovery_delete_user', 'legacy', 'legacy', 0,
          1, 1, 1, 1
        )
      `)
      yield* db.run(`
        INSERT INTO session_activity_admission (
          admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id,
          delivery, payload_fingerprint_kind, payload_fingerprint, execution_mode, created_at
        ) VALUES (
          'admission-recovery-delete', 'ses_recovery_delete', 'legacy_intent',
          'intent-recovery-delete', 'msg_recovery_delete_user', 'turn', 'payload_hash',
          'payload-recovery-delete', 'legacy', 1
        )
      `)
      yield* db.run(`
        INSERT INTO session_legacy_activity (
          activity_id, session_id, ordinal, trigger_admission_id, owner_token,
          state, terminal_reason, created_at, settled_at
        ) VALUES (
          'activity-recovery-delete', 'ses_recovery_delete', 0, 'admission-recovery-delete',
          'owner-recovery-delete', 'active', NULL, 1, NULL
        )
      `)
      yield* db.run(`
        INSERT INTO session_legacy_activity_admission (
          activity_id, admission_id, ordinal, role, attached_at
        ) VALUES (
          'activity-recovery-delete', 'admission-recovery-delete', 0, 'trigger', 1
        )
      `)
      yield* db.run(`
        INSERT INTO session_tool_request_receipt (
          receipt_id, request_ordinal, session_id, user_message_id, assistant_message_id,
          provider_attempt_id, provider_id, model_id, protocol, registry_tool_ids,
          permission_filtered_tool_ids, final_offered_tool_ids, call_ids, prompt_epoch,
          prompt_window_id, effective_history_hash, request_input_hash, final_request_hash,
          provider_state, adapter_prepared_at, dispatching_at, terminal_at, owner_token,
          request_state, request_error_code, created_at
        ) VALUES (
          'receipt-recovery-delete', 1, 'ses_recovery_delete', 'msg_recovery_delete_user',
          'msg_recovery_delete_assistant', NULL, 'provider', 'model', 'chat', '[]', '[]',
          '[]', '[]', 0, 'window-recovery-source', 'history-recovery-source',
          'request-input-recovery-delete', 'request-final-recovery-delete',
          'indeterminate_after_crash', 1, 1, 2, 'owner-recovery-delete', 'dispatched',
          'provider_started_outcome_unknown_after_process_restart', 1
        )
      `)
      yield* db.run(`
        INSERT INTO session_activity_progress (
          activity_id, revision, assistant_message_id, provider_receipt_id,
          input_membership_ordinal, state, created_at, settled_at
        ) VALUES (
          'activity-recovery-delete', 0, 'msg_recovery_delete_assistant',
          'receipt-recovery-delete', 0, 'recovery_required', 1, 2
        )
      `)
      yield* db.run(`
        UPDATE session_legacy_activity
        SET state = 'recovery_required', terminal_reason = 'provider outcome unknown', settled_at = 2
        WHERE activity_id = 'activity-recovery-delete'
      `)
      yield* db.run(`
        INSERT INTO session_legacy_activity_terminal (
          activity_id, session_id, mutation_epoch, state, reason_code, source,
          operation_id, run_id, assistant_message_id, progress_revision,
          membership_ordinal, owner_token, created_at
        ) VALUES (
          'activity-recovery-delete', 'ses_recovery_delete', 0, 'recovery_required',
          'provider outcome unknown', 'migration_backfill', 'terminal-recovery-delete', NULL,
          'msg_recovery_delete_assistant', 0, 0, 'owner-recovery-delete', 2
        )
      `)
      yield* db.run(`
        INSERT INTO session_legacy_activity_migration_receipt (
          receipt_id, batch_id, activity_id, classifier_version, before_state, after_state,
          evidence_hash, terminal_operation_id, error_code, created_at
        ) VALUES (
          'migration-receipt-recovery-delete', 'migration-batch-recovery-delete',
          'activity-recovery-delete', 'legacy-terminal-state-v1', 'recovery_required',
          'recovery_required', 'evidence-recovery-delete', 'terminal-recovery-delete', NULL, 2
        )
      `)
      yield* db.run(`
        INSERT INTO session_prompt_epoch (
          session_id, epoch, state, source_end_message_id, reason, created_at, retired_at,
          projection_version, canonicalization_version, base_message_count,
          effective_history_hash, first_window_id, window_id, world_state_baseline_hash,
          authority_state, recovery_reason
        ) VALUES (
          'ses_recovery_delete', 0, 'retired', 'msg_recovery_delete_assistant', 'bootstrap',
          1, 2, 1, 1, 2, 'history-recovery-source', 'window-recovery-source',
          'window-recovery-source', 'baseline-recovery-delete', 'recovery_required',
          'provider outcome unknown'
        )
      `)
      yield* db.run(`
        INSERT INTO session_world_state_baseline (
          session_id, prompt_epoch, section_id, snapshot, fragment, fragment_hash,
          provenance, created_at
        ) VALUES (
          'ses_recovery_delete', 0, 'world_state:env',
          '{"kind":"env","version":1,"updatedAt":1,"value":"source"}',
          '## Environment\nsource', 'fragment-recovery-source', 'legacy_migration', 1
        )
      `)
      yield* db.run(`
        INSERT INTO session_tool_request_resolution (
          resolution_id, receipt_id, session_id, legacy_activity_id, assistant_message_id,
          source_prompt_epoch, source_window_id, source_effective_history_hash,
          source_request_hash, source_mutation_epoch, expected_provider_state, decision,
          actor_type, actor_id, reason, risk_acknowledged, safe_end_message_id,
          safe_history_hash, safe_message_ids, ambiguity_message_id, physical_message_high_water,
          successor_prompt_epoch, successor_window_id, successor_history_hash,
          successor_mutation_epoch, created_at
        ) VALUES (
          'resolution-recovery-delete', 'receipt-recovery-delete', 'ses_recovery_delete',
          'activity-recovery-delete', 'msg_recovery_delete_assistant', 0,
          'window-recovery-source', 'history-recovery-source', 'request-final-recovery-delete',
          0, 'indeterminate_after_crash', 'abandoned', 'user', 'test-user',
          'abandon unknown provider result', 0, 'msg_recovery_delete_user',
          'history-recovery-successor', '["msg_recovery_delete_user"]',
          'msg_recovery_delete_assistant', 'msg_recovery_delete_high_water', 1,
          'window-recovery-successor', 'history-recovery-successor', 1, 3
        )
      `)
      yield* db.run(`
        INSERT INTO session_prompt_epoch (
          session_id, epoch, state, source_end_message_id, checkpoint_hash, reason, created_at,
          projection_version, canonicalization_version, base_message_count,
          effective_history_hash, first_window_id, previous_window_id, window_id,
          world_state_baseline_hash, authority_state, recovery_resolution_id
        ) VALUES (
          'ses_recovery_delete', 1, 'active', 'msg_recovery_delete_high_water',
          'history-recovery-successor', 'recovery', 3, 1, 1, 1,
          'history-recovery-successor', 'window-recovery-source', 'window-recovery-source',
          'window-recovery-successor', 'baseline-recovery-delete', 'ready',
          'resolution-recovery-delete'
        )
      `)
      yield* db.run(`
        INSERT INTO session_prompt_epoch_message (
          session_id, prompt_epoch, ordinal, message_id
        ) VALUES ('ses_recovery_delete', 1, 0, 'msg_recovery_delete_user')
      `)
      yield* db.run(`
        INSERT INTO session_world_state_baseline (
          session_id, prompt_epoch, section_id, snapshot, fragment, fragment_hash,
          provenance, created_at
        ) VALUES (
          'ses_recovery_delete', 1, 'world_state:env',
          '{"kind":"env","version":1,"updatedAt":1,"value":"source"}',
          '## Environment\nsource', 'fragment-recovery-source', 'recovery_copied', 3
        )
      `)
      yield* db.run(`
        INSERT INTO session_prompt_epoch_recovery (
          session_id, prompt_epoch, resolution_id, source_prompt_epoch,
          source_mutation_epoch, successor_mutation_epoch, ambiguity_message_id,
          physical_message_high_water, created_at
        ) VALUES (
          'ses_recovery_delete', 1, 'resolution-recovery-delete', 0, 0, 1,
          'msg_recovery_delete_assistant', 'msg_recovery_delete_high_water', 3
        )
      `)
      yield* db.run(`
        INSERT INTO session_tool_request_resolution_command (
          command_id, request_hash, session_id, receipt_id, result_resolution_id, created_at
        ) VALUES (
          'command-recovery-delete', 'command-hash-recovery-delete', 'ses_recovery_delete',
          'receipt-recovery-delete', 'resolution-recovery-delete', 3
        )
      `)
      yield* db.run(`
        INSERT INTO session_history_state (session_id, state, reason, time_created, time_updated)
        VALUES ('ses_recovery_delete', 'ready', NULL, 1, 3)
      `)

      expect(yield* authorityRows).toEqual([
        { table_name: "session", row_count: 1 },
        { table_name: "session_intent", row_count: 1 },
        { table_name: "session_activity_admission", row_count: 1 },
        { table_name: "session_legacy_activity", row_count: 1 },
        { table_name: "session_legacy_activity_admission", row_count: 1 },
        { table_name: "session_activity_progress", row_count: 1 },
        { table_name: "session_tool_request_receipt", row_count: 1 },
        { table_name: "session_legacy_activity_terminal", row_count: 1 },
        { table_name: "session_legacy_activity_migration_receipt", row_count: 1 },
        { table_name: "session_prompt_epoch", row_count: 2 },
        { table_name: "session_prompt_epoch_message", row_count: 1 },
        { table_name: "session_world_state_baseline", row_count: 2 },
        { table_name: "session_tool_request_resolution_command", row_count: 1 },
        { table_name: "session_tool_request_resolution", row_count: 1 },
        { table_name: "session_prompt_epoch_recovery", row_count: 1 },
        { table_name: "session_history_state", row_count: 1 },
      ])

      yield* db.run("DELETE FROM session WHERE id = 'ses_recovery_delete'")

      expect((yield* authorityRows).every((row) => row.row_count === 0)).toBe(true)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
    }),
  )
})
