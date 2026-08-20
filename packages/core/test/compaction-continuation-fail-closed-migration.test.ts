import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const migrationID = "20260820130000_compaction_continuation_fail_closed"
const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))

// Seed a committed run whose continuation never reached admission (the BUG-407-009 incident
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
