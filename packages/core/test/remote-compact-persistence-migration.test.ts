import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import remoteCompactPersistence from "../src/database/migration/20260820000000_remote_compact_persistence"

// UPD-005 Gap 1 + Gap 2 schema migration. The migration is not registered in
// migration.gen.ts yet (mainline registers it), so this test applies the tracked
// history first and then the single migration via applyOnly.
const migrationID = "20260820000000_remote_compact_persistence"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

describe("remote compact persistence migration", () => {
  test("creates the encrypted content table and the mode columns, and stays idempotent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        expect(remoteCompactPersistence.id).toBe(migrationID)

        // Seed a historical compaction_run BEFORE the migration: it must read back
        // as the 'local_summary' default afterwards.
        yield* db.run(`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-remote-compact', '/repo', '[]', 1, 1)
        `)
        yield* db.run(`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, mutation_epoch, time_created, time_updated
          ) VALUES (
            'session-remote-compact', 'project-remote-compact', 'remote-compact', '/repo',
            'Remote compact', '1', 0, 1, 1
          )
        `)
        yield* db.run(`
          INSERT INTO compaction_run (
            run_id, session_id, from_prompt_epoch, "trigger", state, created_at,
            source_window_id, source_effective_history_hash, source_message_count, source_projection_version
          ) VALUES (
            'run-pre-remote-compact', 'session-remote-compact', 1, 'manual', 'committed', 1,
            'window-1', 'hash-1', 3, 0
          )
        `)

        yield* DatabaseMigration.applyOnly(db, [remoteCompactPersistence])

        // Gap 1: the blob table exists with the documented shape.
        const tableCheck = yield* db.get<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_compaction_encrypted_content'`,
        )
        expect(tableCheck).toBeDefined()
        const tableSql = tableCheck!.sql.replace(/\s+/g, " ")
        expect(tableSql).toContain("session_id TEXT NOT NULL PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE")
        expect(tableSql).toContain("encrypted_content TEXT NOT NULL")
        expect(tableSql).toContain("provider_id TEXT NOT NULL")

        const columns = yield* db.all<{ name: string }>(`PRAGMA table_info(session_compaction_encrypted_content)`)
        expect(columns.map((column) => column.name).sort()).toEqual(
          ["created_at", "encrypted_content", "model_id", "provider_id", "session_id", "source_run_id", "updated_at"].sort(),
        )

        // Gap 2: the two mode columns land on compaction_run.
        const runColumns = yield* db.all<{ name: string; dflt_value: string | null }>(
          `PRAGMA table_info(compaction_run)`,
        )
        const modeColumn = runColumns.find((column) => column.name === "compaction_mode")
        expect(modeColumn).toBeDefined()
        expect(modeColumn!.dflt_value).toBe("'local_summary'")
        expect(runColumns.some((column) => column.name === "encrypted_content_session")).toBe(true)

        // Historical rows read back as local_summary with no blob pointer.
        expect(
          yield* db.get(`
            SELECT compaction_mode, encrypted_content_session
            FROM compaction_run WHERE run_id = 'run-pre-remote-compact'
          `),
        ).toEqual({ compaction_mode: "local_summary", encrypted_content_session: null })

        // The CHECK constraint rejects unknown modes.
        const rejectedMode = yield* db
          .run(`UPDATE compaction_run SET compaction_mode = 'hybrid' WHERE run_id = 'run-pre-remote-compact'`)
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejectedMode)).toBe(true)

        // Blob rows are keyed by session and enforce uniqueness (latest-wins is an
        // upsert at the write site, not duplicate rows).
        yield* db.run(`
          INSERT INTO session_compaction_encrypted_content (
            session_id, encrypted_content, provider_id, model_id, source_run_id, created_at, updated_at
          ) VALUES ('session-remote-compact', 'blob-v1', 'openai', 'gpt-x', 'run-pre-remote-compact', 1, 1)
        `)
        const duplicate = yield* db
          .run(`
            INSERT INTO session_compaction_encrypted_content (
              session_id, encrypted_content, provider_id, model_id, source_run_id, created_at, updated_at
            ) VALUES ('session-remote-compact', 'blob-v2', 'openai', 'gpt-x', 'run-pre-remote-compact', 2, 2)
          `)
          .pipe(Effect.exit)
        expect(Exit.isFailure(duplicate)).toBe(true)

        // Session deletion cascades the blob row.
        yield* db.run(`DELETE FROM session WHERE id = 'session-remote-compact'`)
        expect(
          yield* db.get(`SELECT count(*) AS count FROM session_compaction_encrypted_content`),
        ).toEqual({ count: 0 })
        expect(yield* db.all(`PRAGMA foreign_key_check`)).toEqual([])

        // Forward-only idempotence: reapplying is a tracked no-op.
        const before = yield* db.get<{ count: number }>(`SELECT count(*) AS count FROM migration`)
        yield* DatabaseMigration.applyOnly(db, [remoteCompactPersistence])
        expect(yield* db.get(`SELECT count(*) AS count FROM migration`)).toEqual(before)
      }),
    )
  })

  test("rebuilt authority trigger admits remote commits without a TEXT summary and keeps local binding strict", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        yield* DatabaseMigration.applyOnly(db, [remoteCompactPersistence])

        yield* db.run(`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-trigger-check', '/repo', '[]', 1, 1)
        `)
        yield* db.run(`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, mutation_epoch, time_created, time_updated
          ) VALUES (
            'session-trigger-check', 'project-trigger-check', 'trigger-check', '/repo',
            'Trigger check', '1', 0, 1, 1
          )
        `)
        const seedRun = (runID: string) =>
          db.run(`
            INSERT INTO compaction_run (
              run_id, session_id, from_prompt_epoch, "trigger", state, created_at,
              source_window_id, source_effective_history_hash, source_message_count, source_projection_version
            ) VALUES (
              '${runID}', 'session-trigger-check', 1, 'manual', 'requested', 1,
              'window-1', 'hash-1', 3, 0
            )
          `)

        // Remote mode: requested → summarizing → committed succeeds with
        // summary_text NULL, gated only on the encrypted_content pointer.
        yield* seedRun("run-remote-ok")
        yield* db.run(`UPDATE compaction_run SET state = 'summarizing' WHERE run_id = 'run-remote-ok'`)
        yield* db.run(`
          UPDATE compaction_run
          SET state = 'committed', compaction_mode = 'remote_compact',
              encrypted_content_session = 'session-trigger-check',
              completion_reason = 'manual', committed_at = 2
          WHERE run_id = 'run-remote-ok'
        `)
        expect(
          yield* db.get(`SELECT state, summary_text FROM compaction_run WHERE run_id = 'run-remote-ok'`),
        ).toEqual({ state: "committed", summary_text: null })

        // Remote mode without the blob pointer still fails the binding check.
        yield* seedRun("run-remote-no-pointer")
        yield* db.run(`UPDATE compaction_run SET state = 'summarizing' WHERE run_id = 'run-remote-no-pointer'`)
        const noPointer = yield* db
          .run(`
            UPDATE compaction_run
            SET state = 'committed', compaction_mode = 'remote_compact',
                completion_reason = 'manual', committed_at = 2
            WHERE run_id = 'run-remote-no-pointer'
          `)
          .pipe(Effect.exit)
        expect(Exit.isFailure(noPointer)).toBe(true)
        // Terminate the stuck run so the next seed passes the single-active-run check.
        yield* db.run(`
          UPDATE compaction_run SET state = 'failed', terminal_failure_kind = 'test'
          WHERE run_id = 'run-remote-no-pointer'
        `)

        // Local mode keeps the strict TEXT-summary binding (zero regression).
        yield* seedRun("run-local-no-summary")
        yield* db.run(`UPDATE compaction_run SET state = 'summarizing' WHERE run_id = 'run-local-no-summary'`)
        const localNoSummary = yield* db
          .run(`
            UPDATE compaction_run
            SET state = 'committed', completion_reason = 'manual', committed_at = 2
            WHERE run_id = 'run-local-no-summary'
          `)
          .pipe(Effect.exit)
        expect(Exit.isFailure(localNoSummary)).toBe(true)
        yield* db.run(`
          UPDATE compaction_run SET state = 'failed', terminal_failure_kind = 'test'
          WHERE run_id = 'run-local-no-summary'
        `)

        // The state machine itself is unchanged: skipping summarizing is rejected.
        yield* seedRun("run-skip-state")
        const skip = yield* db
          .run(`
            UPDATE compaction_run
            SET state = 'committed', compaction_mode = 'remote_compact',
                encrypted_content_session = 'session-trigger-check',
                completion_reason = 'manual', committed_at = 2
            WHERE run_id = 'run-skip-state'
          `)
          .pipe(Effect.exit)
        expect(Exit.isFailure(skip)).toBe(true)
      }),
    )
  })

  test("blob row FK rejects unknown sessions", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        yield* DatabaseMigration.applyOnly(db, [remoteCompactPersistence])

        const rejected = yield* db
          .run(`
            INSERT INTO session_compaction_encrypted_content (
              session_id, encrypted_content, provider_id, model_id, source_run_id, created_at, updated_at
            ) VALUES ('session-missing', 'blob', 'openai', NULL, NULL, 1, 1)
          `)
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
      }),
    )
  })
})
