import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const migrationID = "20260820130000_compaction_continuation_fail_closed"
const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

// Seed a committed run whose continuation never reached admission (the provider recovery incident
// shape): continuation_state pending with no receipt binding.
const seedPendingContinuation = (runID: string, sessionID: string) => `
  INSERT INTO compaction_run (
    run_id, session_id, from_prompt_epoch, target_prompt_epoch, trigger, state,
    completion_reason, summary_text, recent_context, committed_at, committed_summary_message_id,
    checkpoint_ref, checkpoint_hash, continuation_state, created_at,
    source_window_id, source_effective_history_hash, source_message_count, source_projection_version
  ) VALUES (
    '${runID}', '${sessionID}', 0, 0, 'manual', 'committed',
    'manual', 'summary', 'context', 1, 'msg-seed', 'checkpoint', 'hash', 'pending', 1,
    'window', 'history-hash', 1, 1
  )
`

describe("compaction continuation fail-closed migration", () => {
  test("allows pending → failed without admission bindings and keeps the rest of the machine intact", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)

        yield* db.run(`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-fc', '/repo', '[]', 1, 1)
        `)
        yield* db.run(`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, mutation_epoch, time_created, time_updated
          ) VALUES ('session-fc', 'project-fc', 'fc', '/repo', 'Fail closed', '1', 0, 1, 1)
        `)
        yield* db.run(seedPendingContinuation("run-fc", "session-fc"))

        // The fail-closed transition: pending → failed, no receipt id / admitted_at / terminal_at.
        yield* db.run(`UPDATE compaction_run SET continuation_state = 'failed' WHERE run_id = 'run-fc'`)
        const row = yield* db.get<{ continuation_state: string }>(
          `SELECT continuation_state FROM compaction_run WHERE run_id = 'run-fc'`,
        )
        expect(row?.continuation_state).toBe("failed")

        // The rest of the machine is unchanged: pending → settled stays illegal (skip admission).
        yield* db.run(seedPendingContinuation("run-fc2", "session-fc"))
        const illegal = yield* db
          .run(`UPDATE compaction_run SET continuation_state = 'settled' WHERE run_id = 'run-fc2'`)
          .pipe(Effect.exit)
        expect(illegal._tag).toBe("Failure")

        // failed → pending stays illegal (no resurrection).
        const resurrect = yield* db
          .run(`UPDATE compaction_run SET continuation_state = 'pending' WHERE run_id = 'run-fc'`)
          .pipe(Effect.exit)
        expect(resurrect._tag).toBe("Failure")

        // A fail-closed decision carries a stable reason and terminal timestamp,
        // then gets one immutable failure episode bound to that exact run.
        yield* db.run(seedPendingContinuation("run-fc-resolution", "session-fc"))
        yield* db.run(`
          UPDATE compaction_run
          SET continuation_state = 'failed',
              continuation_error_code = 'test_recovery_gap',
              continuation_terminal_at = 2
          WHERE run_id = 'run-fc-resolution'
        `)
        yield* db.run(`
          INSERT INTO compaction_continuation_failure (
            failure_id, run_id, session_id, ordinal, source_state, reason, created_at
          ) VALUES (
            'failure-fc', 'run-fc-resolution', 'session-fc', 1, 'pending', 'test_recovery_gap', 2
          )
        `)
        const failure = yield* db.get<{
          source_state: string
          reason: string
        }>(`SELECT source_state, reason FROM compaction_continuation_failure WHERE run_id = 'run-fc-resolution'`)
        expect(failure).toEqual({ source_state: "pending", reason: "test_recovery_gap" })

        const mutate = yield* db
          .run(`UPDATE compaction_continuation_failure SET reason = 'mutated' WHERE failure_id = 'failure-fc'`)
          .pipe(Effect.exit)
        expect(mutate._tag).toBe("Failure")

        yield* db.run(seedPendingContinuation("run-fc-wrong-reason", "session-fc"))
        yield* db.run(`
          UPDATE compaction_run
          SET continuation_state = 'failed',
              continuation_error_code = 'test_recovery_gap',
              continuation_terminal_at = 3
          WHERE run_id = 'run-fc-wrong-reason'
        `)
        const wrongReason = yield* db
          .run(
            `
            INSERT INTO compaction_continuation_failure (
              failure_id, run_id, session_id, ordinal, source_state, reason, created_at
            ) VALUES (
              'failure-fc-wrong', 'run-fc-wrong-reason', 'session-fc', 1, 'pending', 'wrong_reason', 3
            )
          `,
          )
          .pipe(Effect.exit)
        expect(wrongReason._tag).toBe("Failure")

        yield* db.run(`
          INSERT INTO session_prompt_epoch (
            session_id, epoch, state, projection_version, canonicalization_version,
            base_message_count, effective_history_hash, first_window_id, window_id,
            authority_state, recovery_reason, reason, created_at
          ) VALUES (
            'session-fc', 0, 'active', 1, 1,
            0, 'history-source', 'first', 'window-source',
            'recovery_required', 'test_recovery_gap', 'bootstrap', 1
          )
        `)

        const abandonWithoutRisk = yield* db
          .run(
            `
            INSERT INTO compaction_continuation_resolution (
              resolution_id, failure_id, run_id, session_id, decision, actor_id, reason, risk_acknowledged,
              source_prompt_epoch, source_window_id, source_history_hash, source_mutation_epoch,
              successor_prompt_epoch, successor_window_id, successor_history_hash, successor_mutation_epoch, created_at
            ) VALUES (
              'resolution-no-risk', 'failure-fc', 'run-fc-resolution', 'session-fc', 'abandoned',
              'operator', 'unsafe abandon', 0, 0, 'window-source', 'history-source', 0,
              1, 'window-1', 'history', 1, 4
            )
          `,
          )
          .pipe(Effect.exit)
        expect(abandonWithoutRisk._tag).toBe("Failure")

        const unsafeReplay = yield* db
          .run(
            `
            INSERT INTO compaction_continuation_resolution (
              resolution_id, failure_id, run_id, session_id, decision, actor_id, reason, risk_acknowledged,
              source_prompt_epoch, source_window_id, source_history_hash, source_mutation_epoch,
              successor_prompt_epoch, successor_window_id, successor_history_hash, successor_mutation_epoch, created_at
            ) VALUES (
              'resolution-unsafe', 'failure-fc', 'run-fc-resolution', 'session-fc', 'replay',
              'operator', 'safe replay', 0, 0, 'window-source', 'history-source', 0,
              1, 'window-1', 'history', 1, 4
            )
          `,
          )
          .pipe(Effect.exit)
        expect(unsafeReplay._tag).toBe("Success")
        yield* db.run(`
          UPDATE compaction_run
          SET continuation_state = 'pending'
          WHERE run_id = 'run-fc-resolution'
        `)
        yield* db.run(`
          UPDATE compaction_run
          SET continuation_state = 'failed', continuation_terminal_at = 5
          WHERE run_id = 'run-fc-resolution'
        `)
        yield* db.run(`
          INSERT INTO compaction_continuation_failure (
            failure_id, run_id, session_id, ordinal, source_state, reason, created_at
          ) VALUES (
            'failure-fc-second', 'run-fc-resolution', 'session-fc', 2, 'pending', 'test_recovery_gap', 5
          )
        `)
        const staleReplay = yield* db
          .run(`
            UPDATE compaction_run
            SET continuation_state = 'pending'
            WHERE run_id = 'run-fc-resolution'
          `)
          .pipe(Effect.exit)
        expect(staleReplay._tag).toBe("Failure")
        yield* db.run(`
          UPDATE session_prompt_epoch SET state = 'retired', retired_at = 4
          WHERE session_id = 'session-fc' AND epoch = 0
        `)
        const wrongSuccessor = yield* db
          .run(
            `
            INSERT INTO session_prompt_epoch (
              session_id, epoch, state, checkpoint_hash, projection_version, canonicalization_version,
              base_message_count, effective_history_hash, first_window_id, window_id,
              world_state_baseline_hash, authority_state, recovery_resolution_id, reason, created_at
            ) VALUES (
              'session-fc', 2, 'active', 'history', 1, 1,
              0, 'history', 'first', 'window-2',
              'baseline', 'ready', 'resolution-unsafe', 'recovery', 4
            )
          `,
          )
          .pipe(Effect.exit)
        expect(wrongSuccessor._tag).toBe("Failure")
        yield* db.run(`
          INSERT INTO session_prompt_epoch (
            session_id, epoch, state, checkpoint_hash, projection_version, canonicalization_version,
            base_message_count, effective_history_hash, first_window_id, window_id,
            world_state_baseline_hash, authority_state, recovery_resolution_id, reason, created_at
          ) VALUES (
            'session-fc', 1, 'active', 'history', 1, 1,
            0, 'history', 'first', 'window-1',
            'baseline', 'ready', 'resolution-unsafe', 'recovery', 4
          )
        `)

        const resolutionMutation = yield* db
          .run(`UPDATE compaction_continuation_resolution SET reason = 'changed' WHERE resolution_id = 'resolution-unsafe'`)
          .pipe(Effect.exit)
        expect(resolutionMutation._tag).toBe("Failure")
        const resolutionDeletion = yield* db
          .run(`DELETE FROM compaction_continuation_resolution WHERE resolution_id = 'resolution-unsafe'`)
          .pipe(Effect.exit)
        expect(resolutionDeletion._tag).toBe("Failure")
        const failureDeletion = yield* db
          .run(`DELETE FROM compaction_continuation_failure WHERE failure_id = 'failure-fc'`)
          .pipe(Effect.exit)
        expect(failureDeletion._tag).toBe("Failure")
        yield* db.run(`
          INSERT INTO compaction_continuation_resolution_command (
            command_id, request_hash, run_id, result_resolution_id, created_at
          ) VALUES ('command-fc', 'request-hash', 'run-fc-resolution', NULL, 4)
        `)
        yield* db.run(`
          UPDATE compaction_continuation_resolution_command
          SET result_resolution_id = 'resolution-unsafe'
          WHERE command_id = 'command-fc'
        `)
        const commandMutation = yield* db
          .run(`UPDATE compaction_continuation_resolution_command SET request_hash = 'changed' WHERE command_id = 'command-fc'`)
          .pipe(Effect.exit)
        expect(commandMutation._tag).toBe("Failure")
        const commandDeletion = yield* db
          .run(`DELETE FROM compaction_continuation_resolution_command WHERE command_id = 'command-fc'`)
          .pipe(Effect.exit)
        expect(commandDeletion._tag).toBe("Failure")

        const recoveryUpdate = yield* db
          .run(`
            UPDATE session_prompt_epoch
            SET authority_state = 'recovery_required', recovery_reason = 'unsafe_source'
            WHERE session_id = 'session-fc' AND epoch = 1
          `)
          .pipe(Effect.exit)
        expect(recoveryUpdate._tag).toBe("Success")
        yield* db.run(`UPDATE session SET mutation_epoch = 1 WHERE id = 'session-fc'`)

        yield* db.run(seedPendingContinuation("run-fc-unsafe-source", "session-fc"))
        yield* db.run(`
          UPDATE compaction_run
          SET continuation_state = 'failed', continuation_error_code = 'unsafe_source', continuation_terminal_at = 5
          WHERE run_id = 'run-fc-unsafe-source'
        `)
        yield* db.run(`
          INSERT INTO compaction_continuation_failure (
            failure_id, run_id, session_id, ordinal, source_state, reason, created_at
          ) VALUES (
            'failure-fc-unsafe-source', 'run-fc-unsafe-source', 'session-fc', 1, 'admitted', 'unsafe_source', 5
          )
        `)
        const admittedReplay = yield* db
          .run(
            `
            INSERT INTO compaction_continuation_resolution (
              resolution_id, failure_id, run_id, session_id, decision, actor_id, reason, risk_acknowledged,
              source_prompt_epoch, source_window_id, source_history_hash, source_mutation_epoch,
              successor_prompt_epoch, successor_window_id, successor_history_hash, successor_mutation_epoch, created_at
            ) VALUES (
              'resolution-admitted-replay', 'failure-fc-unsafe-source', 'run-fc-unsafe-source',
              'session-fc', 'replay', 'operator', 'unsafe replay', 0,
              1, 'window-1', 'history', 1, 2, 'window-2', 'history-2', 2, 5
            )
          `,
          )
          .pipe(Effect.exit)
        expect(admittedReplay._tag).toBe("Failure")
        yield* db.run(`
          INSERT INTO compaction_continuation_resolution (
            resolution_id, failure_id, run_id, session_id, decision, actor_id, reason, risk_acknowledged,
            source_prompt_epoch, source_window_id, source_history_hash, source_mutation_epoch,
            successor_prompt_epoch, successor_window_id, successor_history_hash, successor_mutation_epoch, created_at
          ) VALUES (
            'resolution-admitted-abandon', 'failure-fc-unsafe-source', 'run-fc-unsafe-source',
            'session-fc', 'abandoned', 'operator', 'acknowledged abandon', 1,
            1, 'window-1', 'history', 1, 2, 'window-2', 'history-2', 2, 5
          )
        `)

        // Append-only while the authority exists, but ordinary session deletion
        // must still cascade through run and resolution rows.
        yield* db.run(`DELETE FROM session WHERE id = 'session-fc'`)
        expect(
          yield* db.get<{ count: number }>(
            `SELECT COUNT(*) AS count FROM compaction_continuation_failure WHERE failure_id = 'failure-fc'`,
          ),
        ).toEqual({ count: 0 })
      }),
    )
  })

  test("migration registers after the stage-evidence batch and applies idempotently", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        const tracked = yield* db.get<{ id: string }>(`SELECT id FROM migration WHERE id = '${migrationID}'`)
        expect(tracked?.id).toBe(migrationID)
        yield* DatabaseMigration.apply(db)
        expect(
          yield* db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM migration WHERE id = '${migrationID}'`),
        ).toEqual({ count: 1 })
      }),
    )
  })
})
