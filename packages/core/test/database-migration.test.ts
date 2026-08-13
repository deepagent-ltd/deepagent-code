import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit, Layer } from "effect"
import { eq, inArray, sql } from "drizzle-orm"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import sessionUsageMigration from "@deepagent-code/core/database/migration/20260510033149_session_usage"
import normalizeStoragePathsMigration from "@deepagent-code/core/database/migration/20260601010001_normalize_storage_paths"
import sessionMessageProjectionOrderMigration from "@deepagent-code/core/database/migration/20260603040000_session_message_projection_order"
import eventSourcedSessionInputMigration from "@deepagent-code/core/database/migration/20260604172448_event_sourced_session_input"
import contextEpochAgentMigration from "@deepagent-code/core/database/migration/20260605042240_add_context_epoch_agent"
import eventDropDistinctMigration from "@deepagent-code/core/database/migration/20260712040000_deepagent_event_drop_distinct"
import timeSuspendedMigration from "@deepagent-code/core/database/migration/20260803000000_time_suspended"
import taskRunDeliveryMigration from "@deepagent-code/core/database/migration/20260724134000_task_run_delivery"
import subagentControlPlaneMigration from "@deepagent-code/core/database/migration/20260803000001_subagent_control_plane_l1"
import taskAdmissionRepairMigration from "@deepagent-code/core/database/migration/20260805000000_repair_task_admission"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import sessionMetadataMigration from "@deepagent-code/core/database/migration/20260511173437_session-metadata"
import compactionContinuationAdmissionMigration from "@deepagent-code/core/database/migration/20260810160000_compaction_continuation_admission"
import partIntegrityBackfillMigration from "@deepagent-code/core/database/migration/20260810170000_part_integrity_backfill"
import legacyActivityProgressMigration from "@deepagent-code/core/database/migration/20260811090000_legacy_activity_progress"
import legacyActivityOwnerMigration from "@deepagent-code/core/database/migration/20260811100000_legacy_activity_owner"
import eventSnapshotAuthorityMigration from "@deepagent-code/core/database/migration/20260813100000_event_snapshot_authority"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { Database } from "@deepagent-code/core/database/database"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("DatabaseMigration", () => {
  test("rejects duplicate migration IDs before changing the database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        const duplicate = {
          id: "duplicate-migration-id",
          up: () => Effect.die("duplicate migration must not run"),
        }
        const result = yield* DatabaseMigration.applyOnly(db, [duplicate, duplicate]).pipe(Effect.exit)

        expect(result).toMatchObject({ _tag: "Failure" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'`),
        ).toBeUndefined()
      }),
    )
  })

  test("stages EventV2 history without rewriting legacy rows and fences old writers", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT)`)
        yield* db.run(sql`CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL)`)
        yield* db.run(sql`INSERT INTO event_sequence VALUES ('session-a', 1, NULL)`)
        yield* db.run(sql`INSERT INTO event VALUES ('event-a', 'session-a', 0, 'test.1', '{}')`)
        yield* db.run(sql`INSERT INTO event VALUES ('event-b', 'session-a', 1, 'test.1', '{}')`)

        yield* DatabaseMigration.applyOnly(db, [eventSnapshotAuthorityMigration])
        const oldWriter = yield* db
          .run(sql`INSERT INTO event(id, aggregate_id, seq, type, data) VALUES ('event-old-writer', 'session-a', 2, 'test.1', '{}')`)
          .pipe(Effect.exit)
        yield* db.run(sql`UPDATE event_sync_sequence SET seq = seq + 1 WHERE id = 1`)
        yield* db.run(sql`INSERT INTO event(id, aggregate_id, seq, type, data, sync_seq) VALUES ('event-new-writer', 'session-a', 2, 'test.1', '{}', (SELECT seq FROM event_sync_sequence WHERE id = 1))`)

        expect(oldWriter._tag).toBe("Failure")
        expect(yield* db.all(sql`SELECT id, sync_seq FROM event ORDER BY rowid`)).toEqual([
          { id: "event-a", sync_seq: null },
          { id: "event-b", sync_seq: null },
          { id: "event-new-writer", sync_seq: 3 },
        ])
        expect(yield* db.all(sql`SELECT sync_seq, event_id FROM event_sync_index`)).toEqual([
          { sync_seq: 3, event_id: "event-new-writer" },
        ])
        expect(yield* db.get(sql`SELECT seq, backfill_complete, length(generation) AS generation_length, length(cursor_secret) AS secret_length FROM event_sync_sequence WHERE id = 1`)).toEqual({ seq: 3, backfill_complete: 0, generation_length: 32, secret_length: 64 })
      }),
    )
  })
  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")
    const layers = [Database.layerFromPath(filename), Database.layerFromPath(filename)]

    await Effect.runPromise(
      Effect.all(
        layers.map((layer) => Effect.scoped(Layer.build(layer))),
        { concurrency: "unbounded" },
      ),
    )
  })
  if (process.platform === "linux") {
    test("declared schema has no ungenerated migrations", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
        .quiet()
        .nothrow()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
    }, 30_000)
  }

  test("applies tracked migrations to an empty database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`)).toEqual({
          name: "session",
        })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_input'`),
        ).toEqual({ name: "session_input" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_context_epoch'`),
        ).toEqual({ name: "session_context_epoch" })
        expect(
          yield* db.get(
            sql`SELECT name, dflt_value FROM pragma_table_info('session_context_epoch') WHERE name = 'agent'`,
          ),
        ).toEqual({ name: "agent", dflt_value: "'build'" })
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('task_run', 'task_admission', 'task_notification_outbox') ORDER BY name`,
          ),
        ).toEqual([{ name: "task_admission" }, { name: "task_notification_outbox" }, { name: "task_run" }])
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('task_run_child_generation_idx', 'task_run_child_active_idx', 'task_notification_outbox_due_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "task_notification_outbox_due_idx" },
          { name: "task_run_child_active_idx" },
          { name: "task_run_child_generation_idx" },
        ])
        expect(yield* db.get(sql`SELECT count(*) as count FROM migration`)).toEqual({ count: migrations.length })
        expect(yield* db.get(sql`SELECT name FROM pragma_table_info('session') WHERE name = 'time_suspended'`)).toEqual(
          { name: "time_suspended" },
        )
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_time_suspended_idx'`,
          ),
        ).toEqual({ name: "session_time_suspended_idx" })
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_tool_argument_receipt'`,
          ),
        ).toEqual({ name: "session_tool_argument_receipt" })
        expect(
          yield* db.get(
            sql`SELECT name FROM pragma_table_info('session_fork_intent') WHERE name = 'side_effects_completed_at'`,
          ),
        ).toEqual({ name: "side_effects_completed_at" })
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_fork_intent_side_effects_idx'`,
          ),
        ).toEqual({ name: "session_fork_intent_side_effects_idx" })
        expect(
          yield* db.all(
            sql`SELECT name FROM pragma_table_info('session_tool_request_receipt') WHERE name IN ('provider_request_hash', 'response_chain_reuse_decision', 'response_chain_refusal_reason') ORDER BY name`,
          ),
        ).toEqual([
          { name: "provider_request_hash" },
          { name: "response_chain_refusal_reason" },
          { name: "response_chain_reuse_decision" },
        ])
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('session_tool_argument_receipt_call_idx', 'session_tool_argument_receipt_created_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "session_tool_argument_receipt_call_idx" },
          { name: "session_tool_argument_receipt_created_idx" },
        ])
        expect(
          yield* db.get(
            sql`SELECT name, dflt_value FROM pragma_table_info('session_tool_argument_receipt') WHERE name = 'validation_outcome'`,
          ),
        ).toEqual({ name: "validation_outcome", dflt_value: "'not_evaluated'" })
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id,
            registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
            request_state, created_at
          ) VALUES (
            'receipt-constraint-test', 1, 'session-constraint-test', 'message-constraint-test',
            'provider-test', 'model-test', '[]', '[]', '[]', '[]', 'dispatched', 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_argument_receipt (
            receipt_id, layer, ordinal, event_type, payload_keys, unavailable_reason, created_at
          ) VALUES (
            'receipt-constraint-test', 'raw_frame', 0, 'raw', '[]', 'raw_receipt_gate_disabled', 1
          )
        `)
        const emptyEvidence = yield* db
          .run(
            sql`
            INSERT INTO session_tool_argument_receipt (
              receipt_id, layer, ordinal, event_type, payload_keys, created_at
            ) VALUES (
              'receipt-constraint-test', 'ai_sdk_input', 0, 'tool-call', '[]', 1
            )
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(emptyEvidence)).toBe(true)
        const invalidOutcome = yield* db
          .run(
            sql`
            UPDATE session_tool_argument_receipt
            SET validation_outcome = 'untrusted'
            WHERE receipt_id = 'receipt-constraint-test'
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(invalidOutcome)).toBe(true)
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('event_aggregate_seq_idx', 'event_aggregate_type_seq_idx', 'session_input_session_pending_seq_idx', 'session_input_session_pending_delivery_seq_idx', 'session_input_session_admitted_seq_idx', 'session_input_session_promoted_seq_idx', 'session_message_session_idx', 'session_message_session_type_idx', 'session_message_session_seq_idx', 'session_message_session_type_seq_idx', 'session_message_session_time_created_id_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "event_aggregate_seq_idx" },
          { name: "event_aggregate_type_seq_idx" },
          { name: "session_input_session_admitted_seq_idx" },
          { name: "session_input_session_pending_delivery_seq_idx" },
          { name: "session_input_session_promoted_seq_idx" },
          { name: "session_message_session_seq_idx" },
          { name: "session_message_session_time_created_id_idx" },
          { name: "session_message_session_type_seq_idx" },
        ])
      }),
    )
  })

  test("reapplying tracked migrations is a no-op", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const before = yield* db.get(sql`SELECT count(*) as count FROM migration`)
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get(sql`SELECT count(*) as count FROM migration`)).toEqual(before)
      }),
    )
  })

  test("legacy activity migration backfills V2 source identity and rejects mismatched legacy admissions", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session_intent (
          intent_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, admitted_message_id TEXT,
          delivery TEXT, selected_payload_hash TEXT, state TEXT NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE session_input (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL,
          delivery TEXT NOT NULL, admitted_seq INTEGER NOT NULL, promoted_seq INTEGER,
          time_created INTEGER NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE session_activity (
          activity_id TEXT PRIMARY KEY, trigger_input_id TEXT NOT NULL
        )`)
        yield* db.run(sql`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL)`)
        yield* db.run(sql`CREATE TABLE part (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session_tool_request_receipt (receipt_id TEXT PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO session VALUES ('ses_migration')`)
        yield* db.run(sql`INSERT INTO session_input VALUES
          ('input-v2', 'ses_migration', '{"text":"v2"}', 'turn', 1, 7, 11)`)
        yield* db.run(sql`INSERT INTO session_activity VALUES ('activity-v2', 'input-v2')`)

        yield* DatabaseMigration.applyOnly(db, [legacyActivityProgressMigration])
        expect(
          yield* db.get(sql`
            SELECT source_kind, payload_fingerprint_kind, payload_fingerprint
            FROM session_activity_admission WHERE admission_id = 'v2:input-v2'
          `),
        ).toEqual({
          source_kind: "session_input",
          payload_fingerprint_kind: "source_identity",
          payload_fingerprint: "session-input:input-v2",
        })

        yield* db.run(sql`INSERT INTO session_intent VALUES
          ('legacy-intent', 'ses_migration', 'legacy-message', 'turn', 'payload-hash', 'admitted')`)
        yield* db.run(sql`
          INSERT INTO session_activity_admission (
            admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id,
            delivery, payload_fingerprint_kind, payload_fingerprint, created_at
          ) VALUES ('legacy-admission', 'ses_migration', 'legacy_intent', 'legacy-intent',
            'legacy-message', 'turn', 'payload_hash', 'payload-hash', 12)
        `)
        yield* db.run(sql`INSERT INTO session_legacy_activity VALUES
          ('legacy-activity', 'ses_migration', 0, 'legacy-admission', 'active', NULL, 12, NULL)`)
        yield* db.run(sql`INSERT INTO session_legacy_activity_admission
          (activity_id, admission_id, ordinal, role, attached_at)
          VALUES ('legacy-activity', 'legacy-admission', 0, 'trigger', 12)`)
        yield* DatabaseMigration.applyOnly(db, [legacyActivityOwnerMigration])
        expect(
          yield* db.get(sql`SELECT owner_token FROM session_legacy_activity WHERE activity_id = 'legacy-activity'`),
        ).toEqual({ owner_token: "pre-owner-migration" })
        expect(
          Exit.isFailure(
            yield* db
              .run(sql`UPDATE session_legacy_activity SET owner_token = 'other' WHERE activity_id = 'legacy-activity'`)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO session_activity_admission (
                  admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id,
                  delivery, payload_fingerprint_kind, payload_fingerprint, created_at
                ) VALUES ('invalid-admission', 'ses_migration', 'legacy_intent', 'legacy-intent',
                  'legacy-message', 'turn', 'source_identity', 'session-input:legacy-message', 12)
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("enforces provider receipt lifecycle and compaction part provenance", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt (
            receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id,
            registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
            request_state, provider_state, prompt_epoch, prompt_window_id, effective_history_hash,
            request_input_hash, owner_token, created_at
          ) VALUES (
            'receipt-provider-lifecycle', 1, 'session-provider-lifecycle', 'message-provider-lifecycle',
            'provider-test', 'model-test', '[]', '[]', '[]', '[]', 'prepared', 'preparing',
            0, 'window-0', 'history-0', 'input-hash', 'owner-1', 1
          )
        `)

        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_tool_request_receipt
                SET provider_state = 'dispatching'
                WHERE receipt_id = 'receipt-provider-lifecycle'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'prepared', final_request_hash = 'final-hash',
              adapter_prepared_at = 2, provider_request_hash = 'final-hash'
          WHERE receipt_id = 'receipt-provider-lifecycle'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'dispatching', dispatching_at = 3, request_state = 'dispatched'
          WHERE receipt_id = 'receipt-provider-lifecycle'
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_tool_request_receipt
                SET provider_state = 'prepared'
                WHERE receipt_id = 'receipt-provider-lifecycle'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'streaming', streaming_at = 4
          WHERE receipt_id = 'receipt-provider-lifecycle'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'settled', terminal_at = 5
          WHERE receipt_id = 'receipt-provider-lifecycle'
        `)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET response_fingerprint = 'response-hash'
          WHERE receipt_id = 'receipt-provider-lifecycle'
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_tool_request_receipt
                SET final_request_hash = 'different-final-hash'
                WHERE receipt_id = 'receipt-provider-lifecycle'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)

        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-provenance', '/repo', '[]', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, time_created, time_updated
          ) VALUES (
            'session-provenance', 'project-provenance', 'provenance', '/repo', 'Provenance', '1', 1, 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('message-provenance', 'session-provenance', 1, 1, '{}')
        `)
        yield* db.run(sql`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, time_created, time_updated
          ) VALUES (
            'session-provenance-other', 'project-provenance', 'provenance-other', '/repo',
            'Provenance other', '1', 1, 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('message-provenance-other', 'session-provenance-other', 1, 1, '{}')
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                VALUES (
                  'part-cross-session', 'message-provenance', 'session-provenance-other',
                  1, 1, '{"type":"text","text":"x"}'
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO part (id, message_id, session_id, provenance, time_created, time_updated, data)
                VALUES (
                  'part-invalid-provenance', 'message-provenance', 'session-provenance',
                  '{"source":"unknown","durable":true}', 1, 1, '{"type":"text","text":"x"}'
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          INSERT INTO part (id, message_id, session_id, provenance, time_created, time_updated, data)
          VALUES (
            'part-valid-provenance', 'message-provenance', 'session-provenance',
            '{"source":"compaction_continue","owner_session_id":"session-provenance","owner_prompt_epoch":1,"owner_run_id":"run-1","durable":true}',
            1, 1, '{"type":"text","text":"x"}'
          )
        `)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE part
                SET message_id = 'message-provenance-other', session_id = 'session-provenance-other'
                WHERE id = 'part-valid-provenance'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE part
                SET provenance = '{"source":"compaction_continue","owner_session_id":"session-provenance","owner_prompt_epoch":2,"owner_run_id":"run-1","durable":true}'
                WHERE id = 'part-valid-provenance'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
      }),
    )
  })

  test("enforces durable prompt history recovery state invariants", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-history-authority', '/repo', '[]', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, time_created, time_updated
          ) VALUES (
            'session-history-authority', 'project-history-authority', 'history-authority', '/repo',
            'History authority', '1', 1, 1
          )
        `)
        yield* db.run(sql`
          INSERT INTO session_prompt_epoch (
            session_id, epoch, state, reason, created_at, authority_state,
            projection_version, canonicalization_version, base_message_count,
            effective_history_hash, first_window_id, window_id
          ) VALUES (
            'session-history-authority', 0, 'active', 'bootstrap', 1, 'ready',
            1, 1, 0, 'history-hash', 'window-0', 'window-0'
          )
        `)

        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_prompt_epoch
                SET authority_state = 'recovery_required'
                WHERE session_id = 'session-history-authority' AND epoch = 0
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                INSERT INTO session_history_state (
                  session_id, state, reason, time_created, time_updated
                ) VALUES (
                  'session-history-authority', 'recovery_required', 'corrupt history', 1, 1
                )
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)

        yield* db.run(sql`
          UPDATE session_prompt_epoch
          SET authority_state = 'recovery_required', recovery_reason = 'corrupt history'
          WHERE session_id = 'session-history-authority' AND epoch = 0
        `)
        yield* db.run(sql`
          INSERT INTO session_history_state (
            session_id, state, reason, time_created, time_updated
          ) VALUES (
            'session-history-authority', 'recovery_required', 'corrupt history', 1, 1
          )
        `)

        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_prompt_epoch
                SET authority_state = 'ready', recovery_reason = NULL
                WHERE session_id = 'session-history-authority' AND epoch = 0
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_history_state
                SET reason = NULL
                WHERE session_id = 'session-history-authority'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db.get(
            sql`
              SELECT authority_state, recovery_reason
              FROM session_prompt_epoch
              WHERE session_id = 'session-history-authority' AND epoch = 0
            `,
          ),
        ).toEqual({ authority_state: "recovery_required", recovery_reason: "corrupt history" })
        expect(
          yield* db.get(
            sql`
              SELECT state, reason
              FROM session_history_state
              WHERE session_id = 'session-history-authority'
            `,
          ),
        ).toEqual({ state: "recovery_required", reason: "corrupt history" })

        yield* db.run(sql`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, time_created, time_updated
          ) VALUES (
            'session-missing-authority', 'project-history-authority', 'missing-authority', '/repo',
            'Missing authority', '1', 2, 2
          )
        `)
        yield* db.run(sql`
          INSERT INTO message (id, session_id, time_created, time_updated, data)
          VALUES ('message-missing-authority', 'session-missing-authority', 2, 2, '{"role":"user"}')
        `)
        yield* db.run(sql`
          INSERT INTO session_prompt_epoch (
            session_id, epoch, state, reason, created_at, authority_state,
            projection_version, canonicalization_version, base_message_count,
            effective_history_hash, first_window_id, window_id, source_end_message_id
          ) VALUES (
            'session-missing-authority', 0, 'active', 'bootstrap', 2, 'ready',
            1, 1, 0, 'missing-history-hash', 'missing-window-0', 'missing-window-0',
            'message-missing-authority'
          )
        `)
        yield* db.run(sql`DELETE FROM message WHERE id = 'message-missing-authority'`)

        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE session_prompt_epoch
                SET recovery_reason = NULL
                WHERE session_id = 'session-missing-authority' AND epoch = 0
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_prompt_epoch
          SET authority_state = 'recovery_required', recovery_reason = 'referenced message missing'
          WHERE session_id = 'session-missing-authority' AND epoch = 0
        `)
        expect(
          yield* db.get(sql`
            SELECT authority_state, recovery_reason
            FROM session_prompt_epoch
            WHERE session_id = 'session-missing-authority' AND epoch = 0
          `),
        ).toEqual({
          authority_state: "recovery_required",
          recovery_reason: "referenced message missing",
        })
      }),
    )
  })

  test("adds nullable Session suspension without inferring historical recovery", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('historical')`)

        yield* DatabaseMigration.applyOnly(db, [timeSuspendedMigration])

        expect(yield* db.get(sql`SELECT time_suspended FROM session WHERE id = 'historical'`)).toEqual({
          time_suspended: null,
        })
        expect(
          yield* db.get(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_time_suspended_idx'`,
          ),
        ).toEqual({ name: "session_time_suspended_idx" })
      }),
    )
  })

  test("preserves historical task admission and outbox rows across the L1 rebuild", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_parent')`)
        yield* DatabaseMigration.applyOnly(db, [taskRunDeliveryMigration])
        yield* db.run(sql`
          INSERT INTO task_run (
            run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
            tool_call_id, child_session_id, generation, delivery_mode, phase, state,
            attempts, time_created, time_updated
          ) VALUES (
            'run_historical', 'run_historical', 'request', 'ses_parent', 'msg_parent',
            'call_historical', 'ses_child', 1, 'background', 'research', 'researching',
            2, 100, 200
          )
        `)
        yield* db.run(sql`
          INSERT INTO task_admission (
            admission_key, request_hash, run_id, parent_session_id, parent_message_id,
            tool_call_id, delivery_mode, time_created
          ) VALUES (
            'admission_historical', 'request', 'run_historical', 'ses_parent', 'msg_parent',
            'call_historical', 'background', 100
          )
        `)
        yield* db.run(sql`
          INSERT INTO task_notification_outbox (
            id, run_id, message_id, parent_session_id, directory, payload, status,
            attempts, available_at, time_created, time_updated
          ) VALUES (
            'outbox_historical', 'run_historical', 'msg_outbox', 'ses_parent', '/repo', '{}',
            'delivering', 1, 150, 100, 200
          )
        `)

        yield* DatabaseMigration.applyOnly(db, [subagentControlPlaneMigration])

        expect(
          yield* db.get(
            sql`SELECT state, phase, control_state, input_state, workspace_preflight_state, start_attempts FROM task_run WHERE run_id = 'run_historical'`,
          ),
        ).toEqual({
          state: "running",
          phase: "research",
          control_state: "open",
          input_state: "legacy",
          workspace_preflight_state: "legacy",
          start_attempts: 2,
        })
        expect(
          yield* db.get(
            sql`SELECT admission_key, origin_kind, origin_key FROM task_admission WHERE run_id = 'run_historical'`,
          ),
        ).toEqual({
          admission_key: "admission_historical",
          origin_kind: "task_tool",
          origin_key: "admission_historical",
        })
        expect(
          yield* db.get(
            sql`SELECT status, event_kind, time_admitted FROM task_notification_outbox WHERE run_id = 'run_historical'`,
          ),
        ).toEqual({ status: "processing", event_kind: "terminal", time_admitted: null })
        const activeIndex = yield* db.get<{ sql: string }>(
          sql`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'task_run_child_active_idx'`,
        )
        expect(activeIndex?.sql).toContain(
          "WHERE state IN ('admitted', 'provisioning', 'running', 'researching', 'finalizing')",
        )
        expect(activeIndex?.sql).not.toContain("'queued'")
      }),
    )
  })

  test("repairs the canonical admission on databases already affected by the L1 cascade", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_parent')`)
        yield* DatabaseMigration.applyOnly(db, [taskRunDeliveryMigration])
        yield* db.run(sql`
          INSERT INTO task_run (
            run_id, root_run_id, request_hash, parent_session_id, parent_message_id,
            tool_call_id, child_session_id, generation, delivery_mode, phase, state,
            attempts, time_created, time_updated
          ) VALUES (
            'run_repair', 'run_repair', 'request_repair', 'ses_parent', 'msg_repair',
            'call_repair', 'ses_child_repair', 1, 'foreground', 'research', 'completed',
            1, 100, 200
          )
        `)
        yield* db.run(sql`
          INSERT INTO task_admission (
            admission_key, request_hash, run_id, parent_session_id, parent_message_id,
            tool_call_id, delivery_mode, time_created
          ) VALUES (
            'admission_repair', 'request_repair', 'run_repair', 'ses_parent', 'msg_repair',
            'call_repair', 'foreground', 100
          )
        `)
        yield* DatabaseMigration.applyOnly(db, [subagentControlPlaneMigration])
        yield* db.run(sql`DELETE FROM task_admission WHERE run_id = 'run_repair'`)

        yield* DatabaseMigration.applyOnly(db, [taskAdmissionRepairMigration])

        expect(
          yield* db.get(
            sql`SELECT admission_key, request_hash, tool_call_id, origin_key FROM task_admission WHERE run_id = 'run_repair'`,
          ),
        ).toEqual({
          admission_key: "admission_repair",
          request_hash: "request_repair",
          tool_call_id: "call_repair",
          origin_key: "admission_repair",
        })
      }),
    )
  })

  test("backfills existing Context Epoch rows to the build agent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE session_context_epoch (session_id text PRIMARY KEY, baseline text NOT NULL, snapshot text NOT NULL, baseline_seq integer NOT NULL, replacement_seq integer, revision integer DEFAULT 0 NOT NULL)`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('ses_existing', 'baseline', '{}', 0)`,
        )

        yield* DatabaseMigration.applyOnly(db, [contextEpochAgentMigration])

        expect(yield* db.get(sql`SELECT agent FROM session_context_epoch WHERE session_id = 'ses_existing'`)).toEqual({
          agent: "build",
        })
      }),
    )
  })

  test("resets beta history and rebuilds event-sourced Session input storage", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, workspace_id text)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE part (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq)`)
        yield* db.run(sql`CREATE INDEX event_aggregate_type_seq_idx ON event (aggregate_id, type, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_input (seq integer PRIMARY KEY AUTOINCREMENT, id text NOT NULL UNIQUE, session_id text NOT NULL, prompt text NOT NULL, delivery text NOT NULL, promoted_seq integer, time_created integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_input_session_pending_delivery_seq_idx ON session_input (session_id, promoted_seq, delivery, seq)`,
        )
        yield* db.run(sql`INSERT INTO session (id, workspace_id) VALUES ('session', 'wrk_old')`)
        yield* db.run(sql`INSERT INTO workspace (id) VALUES ('wrk_old')`)
        yield* db.run(sql`INSERT INTO message (id) VALUES ('message')`)
        yield* db.run(sql`INSERT INTO part (id) VALUES ('part')`)
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 0)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_old', 'session', 0, 'old.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_old', 'session', 'user', 0, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, time_created) VALUES ('msg_pending', 'session', '{}', 'steer', 1)`,
        )

        yield* DatabaseMigration.applyOnly(db, [eventSourcedSessionInputMigration])

        expect(yield* db.all(sql`SELECT id, workspace_id FROM session`)).toEqual([
          { id: "session", workspace_id: null },
        ])
        expect(yield* db.all(sql`SELECT id FROM workspace`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM message`)).toEqual([{ id: "message" }])
        expect(yield* db.all(sql`SELECT id FROM part`)).toEqual([{ id: "part" }])
        expect(yield* db.all(sql`SELECT id FROM event`)).toEqual([])
        expect(yield* db.all(sql`SELECT aggregate_id FROM event_sequence`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_input`)).toEqual([])
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session_input)`)).map((column) => column.name),
        ).toEqual(["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq", "time_created"])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_message)`)).find(
            (index) => index.name === "session_message_session_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(event)`)).find(
            (index) => index.name === "event_aggregate_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_input)`)).filter((index) =>
            ["session_input_session_admitted_seq_idx", "session_input_session_promoted_seq_idx"].includes(index.name),
          ),
        ).toEqual([
          expect.objectContaining({ name: "session_input_session_promoted_seq_idx", unique: 1 }),
          expect.objectContaining({ name: "session_input_session_admitted_seq_idx", unique: 1 }),
        ])
      }),
    )
  })

  test("resets incompatible projected Session messages before adding sequence order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE TABLE event (id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_type_time_created_id_idx ON session_message (session_id, type, time_created, id)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('legacy_message', 'session', 1, 1, '{"role":"user"}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('legacy_part', 'legacy_message', 'session', 1, 1, '{"type":"text","text":"hello"}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES ('stale_projection', 'session', 'user', 1, 1, '{}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionMessageProjectionOrderMigration])

        expect(yield* db.all(sql`SELECT id, session_id, data FROM message`)).toEqual([
          { id: "legacy_message", session_id: "session", data: '{"role":"user"}' },
        ])
        expect(yield* db.all(sql`SELECT id, message_id, session_id, data FROM part`)).toEqual([
          {
            id: "legacy_part",
            message_id: "legacy_message",
            session_id: "session",
            data: '{"type":"text","text":"hello"}',
          },
        ])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])

        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('fresh_projection', 'session', 'user', 7, 2, 2, '{}')`,
        )
        expect(yield* db.get(sql`SELECT id, seq FROM session_message`)).toEqual({ id: "fresh_projection", seq: 7 })
      }),
    )
  })

  test("runs session usage backfill in order with schema changes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, data text NOT NULL)`)
        yield* db.run(sql`INSERT INTO session (id, time_updated) VALUES ('session_1', 1)`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES ('message_1', 'session_1', '{"role":"assistant","cost":1.25,"tokens":{"input":2,"output":3,"reasoning":4,"cache":{"read":5,"write":6}}}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionUsageMigration])

        expect(
          yield* db.get(
            sql`SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = 'session_1'`,
          ),
        ).toEqual({
          cost: 1.25,
          tokens_input: 2,
          tokens_output: 3,
          tokens_reasoning: 4,
          tokens_cache_read: 5,
          tokens_cache_write: 6,
        })
      }),
    )
  })

  test("normalizes Windows storage paths and leaves POSIX paths untouched", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, sandboxes text NOT NULL)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, path text)`)
        // Windows-shaped rows (drive + backslash) must be normalized.
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"win"}, ${"C:\\Repo\\Thing"}, ${JSON.stringify([
            "C:\\Repo\\Thing\\sandbox",
          ])})`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"win"}, ${"C:\\Repo\\Thing\\packages\\api"}, ${"packages\\api"})`,
        )
        // UNC worktrees and their sandboxes must normalize too (not just drive paths).
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"unc"}, ${"\\\\server\\share"}, ${JSON.stringify([
            "\\\\server\\share\\sandbox",
          ])})`,
        )
        // The "/" worktree sentinel and POSIX paths (including a pathological
        // backslash in a POSIX filename) must survive byte-for-byte.
        yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"global"}, ${"/"}, ${"[]"})`)
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"posix"}, ${"/home/me/we\\ird"}, ${"src\\weird"})`,
        )

        yield* DatabaseMigration.applyOnly(db, [normalizeStoragePathsMigration])

        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'win'`)).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'win'`)).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })
        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'unc'`)).toEqual({
          worktree: "//server/share",
          sandboxes: JSON.stringify(["//server/share/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT worktree FROM project WHERE id = 'global'`)).toEqual({ worktree: "/" })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'posix'`)).toEqual({
          directory: "/home/me/we\\ird",
          path: "src\\weird",
        })
      }),
    )
  })

  test("maps native Windows paths through database columns", async () => {
    if (process.platform !== "win32") return
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const projectID = ProjectV2.ID.make("codec_project")
        const worktree = AbsolutePath.make("C:\\Repo\\Thing")
        const sandbox = AbsolutePath.make("C:\\Repo\\Thing\\sandbox")
        const directory = "C:\\Repo\\Thing\\packages\\api"
        const sessionID = SessionSchema.ID.make("ses_codec")

        expect(() =>
          Effect.runSync(
            db
              .insert(ProjectTable)
              .values({
                id: ProjectV2.ID.make("invalid_path"),
                worktree: AbsolutePath.make("not-absolute"),
                sandboxes: [],
                time_created: 1,
                time_updated: 1,
              })
              .run(),
          ),
        ).toThrow()

        yield* db
          .insert(ProjectTable)
          .values({
            id: projectID,
            worktree,
            sandboxes: [sandbox],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "codec",
            directory,
            path: "packages\\api",
            title: "Codec",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })
          .run()

        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(
          yield* db.get<{ directory: string; path: string }>(
            sql`SELECT directory, path FROM session WHERE id = ${sessionID}`,
          ),
        ).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })

        const project = yield* db.select().from(ProjectTable).where(eq(ProjectTable.worktree, worktree)).get()
        const session = yield* db.select().from(SessionTable).where(eq(SessionTable.directory, directory)).get()
        expect(project?.worktree).toBe(worktree)
        expect(project?.sandboxes).toEqual([sandbox])
        expect(session?.directory).toBe(directory)
        expect(session?.path).toBe("packages/api")

        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.path, "packages\\api")).get())?.id).toBe(
          sessionID,
        )

        const moved = AbsolutePath.make("D:\\Moved\\Thing")
        const updated = yield* db
          .update(ProjectTable)
          .set({ worktree: moved, sandboxes: [moved] })
          .where(eq(ProjectTable.id, projectID))
          .returning()
          .get()
        expect(updated?.worktree).toBe(moved)
        expect(updated?.sandboxes).toEqual([moved])
        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({ worktree: "D:/Moved/Thing", sandboxes: JSON.stringify(["D:/Moved/Thing"]) })
        expect(
          (yield* db
            .select()
            .from(ProjectTable)
            .where(inArray(ProjectTable.worktree, [moved]))
            .get())?.id,
        ).toBe(projectID)

        yield* db.run(sql`UPDATE project SET worktree = ${"not-absolute"} WHERE id = ${projectID}`)
        expect(() =>
          Effect.runSync(db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()),
        ).toThrow()
      }),
    )
  })

  test("imports existing drizzle migration state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.get(sql`SELECT id FROM migration`)).toEqual({ id: "20260127222353_familiar_lady_ursula" })
      }),
    )
  })

  test("does not replay a migrated session metadata column", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260511173437_session-metadata', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "20260511173437_session-metadata" }])
      }),
    )
  })

  test("accepts the temporary replacement session metadata migration id", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('20260530232709_lovely_romulus', 1)`)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([
          { id: "20260511173437_session-metadata" },
          { id: "20260530232709_lovely_romulus" },
        ])
      }),
    )
  })

  test("skips drizzle import when migration table already has state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('existing', 1)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([{ id: "existing" }])
      }),
    )
  })

  // §A4 event_dropped DISTINCT (P4.6) — the unique-index migration must be robust on a dev/beta DB that
  // already accumulated DUPLICATE event_id drop rows (flags-ON + same event shed multiple times under
  // backpressure BEFORE the onConflictDoNothing fix). A naive CREATE UNIQUE INDEX would throw `UNIQUE
  // constraint failed`, aborting the migration txn and wedging startup. The dedupe-before-index step must
  // collapse the duplicates first so the index builds cleanly.
  test("event_dropped distinct: dedupes historical duplicate event_id rows BEFORE the unique index (no throw)", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        // recreate the P3.13 (20260712010000) table shape WITHOUT the unique index, as a pre-fix DB has it.
        yield* db.run(sql`
          CREATE TABLE deepagent_event_drop (
            id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
            event_id text NOT NULL,
            workspace_id text NOT NULL,
            reason text NOT NULL,
            priority text NOT NULL,
            created_at integer NOT NULL
          )
        `)
        // the same event shed 3× under backpressure (3 rows, same event_id) + a distinct event (1 row).
        yield* db.run(
          sql`INSERT INTO deepagent_event_drop (event_id, workspace_id, reason, priority, created_at) VALUES ('dae_dup', 'wrk_1', 'backpressure', 'normal', 100)`,
        )
        yield* db.run(
          sql`INSERT INTO deepagent_event_drop (event_id, workspace_id, reason, priority, created_at) VALUES ('dae_dup', 'wrk_1', 'backpressure', 'normal', 200)`,
        )
        yield* db.run(
          sql`INSERT INTO deepagent_event_drop (event_id, workspace_id, reason, priority, created_at) VALUES ('dae_dup', 'wrk_1', 'backpressure', 'normal', 300)`,
        )
        yield* db.run(
          sql`INSERT INTO deepagent_event_drop (event_id, workspace_id, reason, priority, created_at) VALUES ('dae_other', 'wrk_1', 'backpressure', 'normal', 400)`,
        )

        // the migration must NOT throw despite the duplicate event_id rows.
        yield* DatabaseMigration.applyOnly(db, [eventDropDistinctMigration])

        // one row per event_id survived; the duplicate collapsed to its EARLIEST (MIN(rowid) → created_at 100).
        expect(yield* db.all(sql`SELECT event_id, created_at FROM deepagent_event_drop ORDER BY event_id`)).toEqual([
          { event_id: "dae_dup", created_at: 100 },
          { event_id: "dae_other", created_at: 400 },
        ])
        // event_dropped_total (COUNT(*)) now == 2 DISTINCT events, not 4 shed-attempts.
        expect(yield* db.get(sql`SELECT count(*) as n FROM deepagent_event_drop`)).toEqual({ n: 2 })

        // the UNIQUE index is in place, so a re-shed of an existing event is a no-op (onConflictDoNothing works).
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(deepagent_event_drop)`)).find(
            (index) => index.name === "deepagent_event_drop_event_id_idx",
          ),
        ).toMatchObject({ unique: 1 })
        // prove the constraint is live: an ON CONFLICT DO NOTHING insert of an existing id changes nothing.
        yield* db.run(
          sql`INSERT INTO deepagent_event_drop (event_id, workspace_id, reason, priority, created_at) VALUES ('dae_dup', 'wrk_1', 'backpressure', 'normal', 999) ON CONFLICT DO NOTHING`,
        )
        expect(yield* db.get(sql`SELECT count(*) as n FROM deepagent_event_drop`)).toEqual({ n: 2 })
      }),
    )
  })

  // fresh/duplicate-free table: the DELETE is a harmless no-op and the index still builds.
  test("event_dropped distinct: DELETE is a no-op on a duplicate-free table, index still applies", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE deepagent_event_drop (
            id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
            event_id text NOT NULL,
            workspace_id text NOT NULL,
            reason text NOT NULL,
            priority text NOT NULL,
            created_at integer NOT NULL
          )
        `)
        yield* db.run(
          sql`INSERT INTO deepagent_event_drop (event_id, workspace_id, reason, priority, created_at) VALUES ('dae_a', 'wrk_1', 'backpressure', 'normal', 100)`,
        )
        yield* DatabaseMigration.applyOnly(db, [eventDropDistinctMigration])
        expect(yield* db.get(sql`SELECT count(*) as n FROM deepagent_event_drop`)).toEqual({ n: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(deepagent_event_drop)`)).find(
            (index) => index.name === "deepagent_event_drop_event_id_idx",
          ),
        ).toMatchObject({ unique: 1 })
      }),
    )
  })

  test("compaction continuation admission migrates legacy wakeups from durable provider evidence", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE compaction_run (
            run_id text PRIMARY KEY NOT NULL,
            session_id text NOT NULL,
            state text NOT NULL,
            continuation_wakeup_at integer
          )
        `)
        yield* db.run(sql`
          CREATE TABLE compaction_artifact (
            run_id text NOT NULL,
            session_id text NOT NULL,
            message_id text NOT NULL,
            state text NOT NULL,
            kind text NOT NULL
          )
        `)
        yield* db.run(sql`
          CREATE TABLE session_tool_request_receipt (
            receipt_id text PRIMARY KEY NOT NULL,
            request_ordinal integer NOT NULL,
            session_id text NOT NULL,
            user_message_id text NOT NULL,
            provider_state text NOT NULL,
            dispatching_at integer,
            terminal_at integer,
            request_error_code text,
            response_fingerprint text,
            created_at integer NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO compaction_run (run_id, session_id, state, continuation_wakeup_at) VALUES
            ('orphan-wakeup', 'ses_orphan', 'committed', 10),
            ('prepared-wakeup', 'ses_prepared', 'committed', 20),
            ('dispatching-wakeup', 'ses_dispatching', 'committed', 30),
            ('settled-without-response', 'ses_incomplete', 'committed', 40)
        `)
        yield* db.run(sql`
          INSERT INTO compaction_artifact (run_id, session_id, message_id, state, kind) VALUES
            ('orphan-wakeup', 'ses_orphan', 'msg_orphan', 'committed', 'continue'),
            ('prepared-wakeup', 'ses_prepared', 'msg_prepared', 'committed', 'continue'),
            ('dispatching-wakeup', 'ses_dispatching', 'msg_dispatching', 'committed', 'continue'),
            ('settled-without-response', 'ses_incomplete', 'msg_incomplete', 'committed', 'continue')
        `)
        yield* db.run(sql`
          INSERT INTO session_tool_request_receipt
            (receipt_id, request_ordinal, session_id, user_message_id, provider_state,
             dispatching_at, terminal_at, request_error_code, created_at)
          VALUES
            ('receipt-prepared', 1, 'ses_prepared', 'msg_prepared', 'prepared', NULL, NULL, NULL, 21),
            ('receipt-dispatching', 1, 'ses_dispatching', 'msg_dispatching', 'dispatching', 31, NULL, NULL, 31),
            ('receipt-incomplete', 1, 'ses_incomplete', 'msg_incomplete', 'settled', 41, 42, NULL, 41)
        `)

        yield* DatabaseMigration.applyOnly(db, [compactionContinuationAdmissionMigration])

        expect(
          yield* db.all(sql`
            SELECT run_id, continuation_state, continuation_receipt_id,
                   continuation_admitted_at, continuation_dispatching_at, continuation_error_code
            FROM compaction_run
            ORDER BY run_id
          `),
        ).toEqual([
          {
            run_id: "dispatching-wakeup",
            continuation_state: "dispatching",
            continuation_receipt_id: "receipt-dispatching",
            continuation_admitted_at: 30,
            continuation_dispatching_at: 31,
            continuation_error_code: null,
          },
          {
            run_id: "orphan-wakeup",
            continuation_state: "pending",
            continuation_receipt_id: null,
            continuation_admitted_at: null,
            continuation_dispatching_at: null,
            continuation_error_code: "legacy_wakeup_without_provider_admission",
          },
          {
            run_id: "prepared-wakeup",
            continuation_state: "admitted",
            continuation_receipt_id: "receipt-prepared",
            continuation_admitted_at: 20,
            continuation_dispatching_at: null,
            continuation_error_code: null,
          },
          {
            run_id: "settled-without-response",
            continuation_state: "indeterminate",
            continuation_receipt_id: "receipt-incomplete",
            continuation_admitted_at: 40,
            continuation_dispatching_at: 41,
            continuation_error_code: null,
          },
        ])
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE compaction_run
                SET continuation_state = 'settled', continuation_terminal_at = 40
                WHERE run_id = 'orphan-wakeup'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(
                sql`
                UPDATE compaction_run
                SET continuation_state = 'settled', continuation_terminal_at = 40
                WHERE run_id = 'dispatching-wakeup'
              `,
              )
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        yield* db.run(sql`
          UPDATE session_tool_request_receipt
          SET provider_state = 'settled', response_fingerprint = 'response-hash', terminal_at = 40
          WHERE receipt_id = 'receipt-dispatching'
        `)
        yield* db.run(sql`
          UPDATE compaction_run
          SET continuation_state = 'settled', continuation_terminal_at = 40
          WHERE run_id = 'dispatching-wakeup'
        `)
        expect(
          yield* db.get(sql`
            SELECT continuation_state, continuation_terminal_at
            FROM compaction_run
            WHERE run_id = 'dispatching-wakeup'
          `),
        ).toEqual({ continuation_state: "settled", continuation_terminal_at: 40 })
      }),
    )
  })

  test("part integrity backfill quarantines pre-existing cross-session rows and blocks history", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE project (id text PRIMARY KEY NOT NULL, worktree text, sandboxes text,
            time_created integer NOT NULL, time_updated integer NOT NULL)
        `)
        yield* db.run(sql`
          CREATE TABLE session (id text PRIMARY KEY NOT NULL, project_id text NOT NULL,
            slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL,
            time_created integer NOT NULL, time_updated integer NOT NULL)
        `)
        yield* db.run(sql`
          CREATE TABLE message (id text PRIMARY KEY NOT NULL, session_id text NOT NULL,
            time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)
        `)
        yield* db.run(sql`
          CREATE TABLE part (id text PRIMARY KEY NOT NULL, message_id text NOT NULL,
            session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
            data text NOT NULL)
        `)
        yield* db.run(sql`
          CREATE TABLE session_prompt_epoch (session_id text NOT NULL, epoch integer NOT NULL,
            state text NOT NULL, authority_state text, recovery_reason text,
            PRIMARY KEY (session_id, epoch))
        `)
        yield* db.run(sql`
          CREATE TABLE session_history_state (session_id text PRIMARY KEY NOT NULL,
            state text NOT NULL, reason text, time_created integer NOT NULL, time_updated integer NOT NULL,
            FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE)
        `)
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`INSERT INTO project VALUES ('p', '/repo', '[]', 1, 1)`)
        yield* db.run(sql`INSERT INTO session VALUES
          ('session-a', 'p', 'a', '/repo', 'A', '1', 1, 1),
          ('session-b', 'p', 'b', '/repo', 'B', '1', 1, 1)`)
        yield* db.run(sql`INSERT INTO message VALUES ('message-a', 'session-a', 1, 1, '{}')`)
        yield* db.run(sql`INSERT INTO part VALUES
          ('part-bad', 'message-a', 'session-b', 1, 1, '{"type":"text","text":"secret"}'),
          ('part-missing-session', 'message-a', 'session-missing', 1, 1, '{"type":"text","text":"orphan"}')`)
        yield* db.run(sql`INSERT INTO session_prompt_epoch VALUES ('session-a', 0, 'active', 'legacy_pending', NULL)`)
        yield* db.run(sql`INSERT INTO session_prompt_epoch VALUES ('session-b', 0, 'active', 'legacy_pending', NULL)`)

        yield* DatabaseMigration.applyOnly(db, [partIntegrityBackfillMigration])

        expect(
          yield* db.all(
            sql`SELECT part_id, message_id, part_session_id, message_session_id, reason FROM session_part_integrity_quarantine ORDER BY part_id`,
          ),
        ).toEqual([
          {
            part_id: "part-bad",
            message_id: "message-a",
            part_session_id: "session-b",
            message_session_id: "session-a",
            reason: "part_parent_cross_session",
          },
          {
            part_id: "part-missing-session",
            message_id: "message-a",
            part_session_id: "session-missing",
            message_session_id: "session-a",
            reason: "part_parent_cross_session",
          },
        ])
        expect(yield* db.all(sql`SELECT session_id, state FROM session_history_state ORDER BY session_id`)).toEqual([
          { session_id: "session-a", state: "recovery_required" },
          { session_id: "session-b", state: "recovery_required" },
        ])
        expect(
          yield* db.all(sql`SELECT session_id, authority_state FROM session_prompt_epoch ORDER BY session_id`),
        ).toEqual([
          { session_id: "session-a", authority_state: "recovery_required" },
          { session_id: "session-b", authority_state: "recovery_required" },
        ])
      }),
    )
  })
})
