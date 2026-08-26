import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"

describe("legacy activity lifecycle migration", () => {
  test("backfills terminal authority and enforces atomic run and terminal transitions", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        const lifecycleIndex = migrations.findIndex(
          (migration) => migration.id === "20260812130000_legacy_activity_lifecycle_expand",
        )
        expect(lifecycleIndex).toBeGreaterThan(0)
        yield* DatabaseMigration.applyOnly(db, migrations.slice(0, lifecycleIndex))

        yield* db.run(`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-lifecycle', '/repo', '[]', 1, 1)
        `)
        yield* db.run(`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, mutation_epoch, time_created, time_updated
          ) VALUES (
            'session-lifecycle-backfill', 'project-lifecycle', 'lifecycle-backfill', '/repo',
            'Lifecycle backfill', '1', 2, 1, 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_intent (
            intent_id, session_id, source, state, selected_variant, selected_payload_hash,
            delivery, admitted_message_id, mutation_epoch,
            time_created, time_selected, time_admitted, time_updated
          ) VALUES (
            'intent-lifecycle-backfill', 'session-lifecycle-backfill', 'composer', 'admitted',
            'original', 'payload-lifecycle-backfill', 'turn', 'message-lifecycle-backfill', 2,
            1, 1, 1, 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_activity_admission (
            admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id,
            delivery, payload_fingerprint_kind, payload_fingerprint, created_at
          ) VALUES (
            'admission-lifecycle-backfill', 'session-lifecycle-backfill', 'legacy_intent',
            'intent-lifecycle-backfill', 'message-lifecycle-backfill', 'turn', 'payload_hash',
            'payload-lifecycle-backfill', 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity (
            activity_id, session_id, ordinal, trigger_admission_id, owner_token,
            state, terminal_reason, created_at, settled_at
          ) VALUES (
            'activity-lifecycle-backfill', 'session-lifecycle-backfill', 0,
            'admission-lifecycle-backfill', 'owner-lifecycle-backfill',
            'recovery_required', 'legacy outcome unknown', 1, 2
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity_admission (
            activity_id, admission_id, ordinal, role, attached_at
          ) VALUES (
            'activity-lifecycle-backfill', 'admission-lifecycle-backfill', 0, 'trigger', 1
          )
        `)

        yield* DatabaseMigration.applyOnly(db, migrations.slice(lifecycleIndex, lifecycleIndex + 1))

        expect(
          yield* db.all(`
            SELECT name FROM pragma_table_info('session_intent')
            WHERE name IN ('execution_mode', 'execution_state', 'execution_claim_id', 'execution_claimed_at')
            ORDER BY name
          `),
        ).toEqual([
          { name: "execution_claim_id" },
          { name: "execution_claimed_at" },
          { name: "execution_mode" },
          { name: "execution_state" },
        ])
        expect(
          yield* db.all(`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN (
              'session_legacy_activity_run',
              'session_legacy_activity_terminal',
              'session_legacy_activity_migration_receipt'
            )
            ORDER BY name
          `),
        ).toEqual([
          { name: "session_legacy_activity_migration_receipt" },
          { name: "session_legacy_activity_run" },
          { name: "session_legacy_activity_terminal" },
        ])
        expect(
          yield* db.get(`
            SELECT state, reason_code, source, run_id, membership_ordinal
            FROM session_legacy_activity_terminal
            WHERE activity_id = 'activity-lifecycle-backfill'
          `),
        ).toEqual({
          state: "recovery_required",
          reason_code: "legacy outcome unknown",
          source: "migration_backfill",
          run_id: null,
          membership_ordinal: 0,
        })
        expect(
          yield* db.get(`
            SELECT before_state, after_state, classifier_version
            FROM session_legacy_activity_migration_receipt
            WHERE activity_id = 'activity-lifecycle-backfill'
          `),
        ).toEqual({
          before_state: "recovery_required",
          after_state: "recovery_required",
          classifier_version: "legacy-terminal-state-v1",
        })

        yield* db.run(`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, mutation_epoch, time_created, time_updated
          ) VALUES (
            'session-lifecycle-runtime', 'project-lifecycle', 'lifecycle-runtime', '/repo',
            'Lifecycle runtime', '1', 3, 1, 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_intent (
            intent_id, session_id, source, state, selected_variant, selected_payload_hash,
            delivery, admitted_message_id, execution_mode, execution_state, mutation_epoch,
            time_created, time_selected, time_admitted, time_updated
          ) VALUES (
            'intent-lifecycle-runtime', 'session-lifecycle-runtime', 'composer', 'admitted',
            'original', 'payload-lifecycle-runtime', 'turn', 'message-lifecycle-runtime',
            'run_now', 'pending', 3, 1, 1, 1, 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_activity_admission (
            admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id,
            delivery, payload_fingerprint_kind, payload_fingerprint, execution_mode, created_at
          ) VALUES (
            'admission-lifecycle-runtime', 'session-lifecycle-runtime', 'legacy_intent',
            'intent-lifecycle-runtime', 'message-lifecycle-runtime', 'turn', 'payload_hash',
            'payload-lifecycle-runtime', 'run_now', 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity (
            activity_id, session_id, ordinal, trigger_admission_id, owner_token,
            state, terminal_reason, created_at, settled_at
          ) VALUES (
            'activity-lifecycle-runtime', 'session-lifecycle-runtime', 0,
            'admission-lifecycle-runtime', 'owner-lifecycle-runtime', 'active', NULL, 1, NULL
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity_admission (
            activity_id, admission_id, ordinal, role, attached_at
          ) VALUES (
            'activity-lifecycle-runtime', 'admission-lifecycle-runtime', 0, 'trigger', 1
          )
        `)

        const failedClaim = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.run(`
                UPDATE session_intent
                SET execution_state = 'claimed', execution_claim_id = 'run-lifecycle-bad',
                    execution_claimed_at = 2
                WHERE intent_id = 'intent-lifecycle-runtime'
              `)
              yield* tx.run(`
                INSERT INTO session_legacy_activity_run (
                  run_id, activity_id, session_id, mutation_epoch, generation,
                  owner_token, state, started_at
                ) VALUES (
                  'run-lifecycle-bad', 'activity-lifecycle-runtime', 'session-lifecycle-runtime',
                  3, 0, 'wrong-owner', 'running', 2
                )
              `)
            }),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(failedClaim)).toBe(true)
        expect(
          yield* db.get(`
            SELECT execution_state, execution_claim_id, execution_claimed_at
            FROM session_intent WHERE intent_id = 'intent-lifecycle-runtime'
          `),
        ).toEqual({ execution_state: "pending", execution_claim_id: null, execution_claimed_at: null })
        expect(yield* db.get(`SELECT count(*) AS count FROM session_legacy_activity_run`)).toEqual({ count: 0 })

        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(`
              UPDATE session_intent
              SET execution_state = 'claimed', execution_claim_id = 'run-lifecycle-runtime',
                  execution_claimed_at = 3
              WHERE intent_id = 'intent-lifecycle-runtime'
            `)
            yield* tx.run(`
              INSERT INTO session_legacy_activity_run (
                run_id, activity_id, session_id, mutation_epoch, generation,
                owner_token, state, started_at
              ) VALUES (
                'run-lifecycle-runtime', 'activity-lifecycle-runtime', 'session-lifecycle-runtime',
                3, 0, 'owner-lifecycle-runtime', 'running', 3
              )
            `)
          }),
        )

        const failedTerminal = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.run(`
                UPDATE session_legacy_activity_run
                SET state = 'completed', terminal_at = 4, terminal_reason = 'assistant_completed'
                WHERE run_id = 'run-lifecycle-runtime'
              `)
              yield* tx.run(`
                UPDATE session_legacy_activity
                SET state = 'settled', terminal_reason = 'assistant_completed', settled_at = 4
                WHERE activity_id = 'activity-lifecycle-runtime'
              `)
              yield* tx.run(`
                INSERT INTO session_legacy_activity_terminal (
                  activity_id, session_id, mutation_epoch, state, reason_code, source,
                  operation_id, run_id, assistant_message_id, progress_revision,
                  membership_ordinal, owner_token, created_at
                ) VALUES (
                  'activity-lifecycle-runtime', 'session-lifecycle-runtime', 3, 'settled',
                  'assistant_completed', 'provider_final', 'terminal-lifecycle-bad',
                  'run-lifecycle-runtime', NULL, NULL, 0, 'wrong-owner', 4
                )
              `)
            }),
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(failedTerminal)).toBe(true)
        expect(
          yield* db.get(`
            SELECT state, terminal_reason, settled_at
            FROM session_legacy_activity WHERE activity_id = 'activity-lifecycle-runtime'
          `),
        ).toEqual({ state: "active", terminal_reason: null, settled_at: null })
        expect(
          yield* db.get(`
            SELECT state, terminal_reason, terminal_at
            FROM session_legacy_activity_run WHERE run_id = 'run-lifecycle-runtime'
          `),
        ).toEqual({ state: "running", terminal_reason: null, terminal_at: null })

        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(`
              UPDATE session_legacy_activity_run
              SET state = 'completed', terminal_at = 5, terminal_reason = 'assistant_completed'
              WHERE run_id = 'run-lifecycle-runtime'
            `)
            yield* tx.run(`
              UPDATE session_legacy_activity
              SET state = 'settled', terminal_reason = 'assistant_completed', settled_at = 5
              WHERE activity_id = 'activity-lifecycle-runtime'
            `)
            yield* tx.run(`
              INSERT INTO session_legacy_activity_terminal (
                activity_id, session_id, mutation_epoch, state, reason_code, source,
                operation_id, run_id, assistant_message_id, progress_revision,
                membership_ordinal, owner_token, created_at
              ) VALUES (
                'activity-lifecycle-runtime', 'session-lifecycle-runtime', 3, 'settled',
                'assistant_completed', 'provider_final', 'terminal-lifecycle-runtime',
                'run-lifecycle-runtime', NULL, NULL, 0, 'owner-lifecycle-runtime', 5
              )
            `)
          }),
        )
        expect(
          yield* db.get(`
            SELECT state, reason_code, source, run_id, membership_ordinal
            FROM session_legacy_activity_terminal
            WHERE activity_id = 'activity-lifecycle-runtime'
          `),
        ).toEqual({
          state: "settled",
          reason_code: "assistant_completed",
          source: "provider_final",
          run_id: "run-lifecycle-runtime",
          membership_ordinal: 0,
        })
        expect(
          Exit.isFailure(
            yield* db
              .run(`
                UPDATE session_legacy_activity_terminal SET reason_code = 'changed'
                WHERE activity_id = 'activity-lifecycle-runtime'
              `)
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          Exit.isFailure(
            yield* db
              .run(`
                DELETE FROM session_legacy_activity_terminal
                WHERE activity_id = 'activity-lifecycle-runtime'
              `)
              .pipe(Effect.exit),
          ),
        ).toBe(true)

        yield* db.run(`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, mutation_epoch, time_created, time_updated
          ) VALUES (
            'session-lifecycle-old-writer', 'project-lifecycle', 'lifecycle-old-writer', '/repo',
            'Lifecycle old writer', '1', 0, 1, 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_intent (
            intent_id, session_id, source, state, selected_variant, selected_payload_hash,
            delivery, admitted_message_id, mutation_epoch,
            time_created, time_selected, time_admitted, time_updated
          ) VALUES (
            'intent-lifecycle-old-writer', 'session-lifecycle-old-writer', 'composer', 'admitted',
            'original', 'payload-lifecycle-old-writer', 'turn', 'message-lifecycle-old-writer', 0,
            1, 1, 1, 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_activity_admission (
            admission_id, session_id, source_kind, legacy_intent_id, admitted_message_id,
            delivery, payload_fingerprint_kind, payload_fingerprint, created_at
          ) VALUES (
            'admission-lifecycle-old-writer', 'session-lifecycle-old-writer', 'legacy_intent',
            'intent-lifecycle-old-writer', 'message-lifecycle-old-writer', 'turn', 'payload_hash',
            'payload-lifecycle-old-writer', 1
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity (
            activity_id, session_id, ordinal, trigger_admission_id, owner_token,
            state, terminal_reason, created_at, settled_at
          ) VALUES (
            'activity-lifecycle-old-writer', 'session-lifecycle-old-writer', 0,
            'admission-lifecycle-old-writer', 'owner-lifecycle-old-writer',
            'active', NULL, 1, NULL
          )
        `)
        yield* db.run(`
          INSERT INTO session_legacy_activity_admission (
            activity_id, admission_id, ordinal, role, attached_at
          ) VALUES (
            'activity-lifecycle-old-writer', 'admission-lifecycle-old-writer', 0, 'trigger', 1
          )
        `)
        yield* db.run(`
          UPDATE session_legacy_activity
          SET state = 'interrupted', terminal_reason = 'old writer stop', settled_at = 2
          WHERE activity_id = 'activity-lifecycle-old-writer'
        `)
        expect(
          yield* db.get(`
            SELECT state, terminal_reason
            FROM session_legacy_activity WHERE activity_id = 'activity-lifecycle-old-writer'
          `),
        ).toEqual({ state: "interrupted", terminal_reason: "old writer stop" })
        expect(
          yield* db.get(`
            SELECT count(*) AS count FROM session_legacy_activity_terminal
            WHERE activity_id = 'activity-lifecycle-old-writer'
          `),
        ).toEqual({ count: 0 })
        expect(yield* db.get(`PRAGMA integrity_check`)).toEqual({ integrity_check: "ok" })
        expect(yield* db.all(`PRAGMA foreign_key_check`)).toEqual([])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  })
})
