import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import remoteCompactPersistence from "../src/database/migration/20260820000000_remote_compact_persistence"
import remoteCompactReplayBoundary from "../src/database/migration/20260820140000_remote_compact_replay_boundary"
import remoteCompactPointerIntegrity from "../src/database/migration/20260821120000_remote_compact_pointer_integrity"
import remoteCompactPerRunBlob from "../src/database/migration/20260821140000_remote_compact_per_run_blob"

// UPD-005 Gap 1 + Gap 2 schema migration and the replay-boundary extension.
const migrationID = "20260820000000_remote_compact_persistence"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

describe("remote compact persistence migration", () => {
  test("upgrades the retained remote blob without rejecting older committed history", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(`INSERT INTO session (id) VALUES ('session-upgrade')`)
        yield* db.run(`
          CREATE TABLE compaction_run (
            run_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            state TEXT NOT NULL,
            compaction_mode TEXT NOT NULL,
            encrypted_content_session TEXT
          )
        `)
        yield* db.run(`
          CREATE TABLE session_compaction_encrypted_content (
            session_id TEXT PRIMARY KEY,
            encrypted_content TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            model_id TEXT,
            source_run_id TEXT,
            source_end_message_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `)
        yield* db.run(`
          INSERT INTO compaction_run
            (run_id, session_id, state, compaction_mode, encrypted_content_session)
          VALUES
            ('run-old', 'session-upgrade', 'committed', 'remote_compact', 'session-upgrade'),
            ('run-newer', 'session-upgrade', 'committed', 'remote_compact', 'session-upgrade')
        `)
        yield* db.run(`
          INSERT INTO session_compaction_encrypted_content (
            session_id, encrypted_content, provider_id, model_id, source_run_id,
            source_end_message_id, created_at, updated_at
          ) VALUES (
            'session-upgrade', 'encrypted-newer', 'openai', 'gpt-x', 'run-newer',
            'message-newer', 2, 2
          )
        `)

        yield* DatabaseMigration.applyOnly(db, [remoteCompactPointerIntegrity, remoteCompactPerRunBlob])
        expect(
          yield* db.all(
            `SELECT run_id, remote_provider_id, encrypted_content_blob_id FROM compaction_run ORDER BY run_id`,
          ),
        ).toEqual([
          { run_id: "run-newer", remote_provider_id: "openai", encrypted_content_blob_id: "run-newer" },
          { run_id: "run-old", remote_provider_id: null, encrypted_content_blob_id: null },
        ])
        expect(yield* db.get(`SELECT session_id, blob_id FROM session_compaction_encrypted_head`)).toEqual({
          session_id: "session-upgrade",
          blob_id: "run-newer",
        })
        expect(yield* db.get(`SELECT source_run_id, encrypted_content FROM session_compaction_encrypted_blob`)).toEqual(
          {
            source_run_id: "run-newer",
            encrypted_content: "encrypted-newer",
          },
        )
        expect(yield* db.all(`PRAGMA foreign_key_check`)).toEqual([])
      }),
    )
  })

  test("creates the encrypted content table and the mode columns, and stays idempotent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        expect(remoteCompactPersistence.id).toBe(migrationID)
        expect(remoteCompactReplayBoundary.id).toBe("20260820140000_remote_compact_replay_boundary")
        expect(remoteCompactPointerIntegrity.id).toBe("20260821120000_remote_compact_pointer_integrity")

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
          [
            "created_at",
            "encrypted_content",
            "model_id",
            "provider_id",
            "session_id",
            "source_end_message_id",
            "source_run_id",
            "updated_at",
          ].sort(),
        )

        // Gap 2: the two mode columns land on compaction_run.
        const runColumns = yield* db.all<{ name: string; dflt_value: string | null }>(
          `PRAGMA table_info(compaction_run)`,
        )
        const modeColumn = runColumns.find((column) => column.name === "compaction_mode")
        expect(modeColumn).toBeDefined()
        expect(modeColumn!.dflt_value).toBe("'local_summary'")
        expect(runColumns.some((column) => column.name === "encrypted_content_session")).toBe(true)
        expect(runColumns.some((column) => column.name === "remote_provider_id")).toBe(true)

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
          .run(
            `
            INSERT INTO session_compaction_encrypted_content (
              session_id, encrypted_content, provider_id, model_id, source_run_id, created_at, updated_at
            ) VALUES ('session-remote-compact', 'blob-v2', 'openai', 'gpt-x', 'run-pre-remote-compact', 2, 2)
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(duplicate)).toBe(true)

        // Session deletion cascades the blob row.
        yield* db.run(`DELETE FROM session WHERE id = 'session-remote-compact'`)
        expect(yield* db.get(`SELECT count(*) AS count FROM session_compaction_encrypted_content`)).toEqual({
          count: 0,
        })
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
        // summary_text NULL, gated on an immutable per-run blob pointer.
        yield* seedRun("run-remote-ok")
        yield* db.run(`
          INSERT INTO session_compaction_encrypted_blob (
            blob_id, session_id, encrypted_content, provider_id, model_id, source_run_id, created_at
          ) VALUES ('run-remote-ok', 'session-trigger-check', 'blob-trigger', 'openai', 'gpt-x', 'run-remote-ok', 1)
        `)
        yield* db.run(`UPDATE compaction_run SET state = 'summarizing' WHERE run_id = 'run-remote-ok'`)
        yield* db.run(`
          UPDATE compaction_run
          SET state = 'committed', compaction_mode = 'remote_compact',
              encrypted_content_session = 'session-trigger-check',
              encrypted_content_blob_id = 'run-remote-ok',
              remote_provider_id = 'openai',
              completion_reason = 'manual', committed_at = 2
          WHERE run_id = 'run-remote-ok'
        `)
        expect(yield* db.get(`SELECT state, summary_text FROM compaction_run WHERE run_id = 'run-remote-ok'`)).toEqual({
          state: "committed",
          summary_text: null,
        })

        yield* seedRun("run-remote-provider-mismatch")
        yield* db.run(`
          INSERT INTO session_compaction_encrypted_blob (
            blob_id, session_id, encrypted_content, provider_id, model_id, source_run_id, created_at
          ) VALUES ('run-remote-provider-mismatch', 'session-trigger-check', 'blob-mismatch', 'deepseek', 'gpt-x', 'run-remote-provider-mismatch', 1)
        `)
        yield* db.run(`
          UPDATE compaction_run SET state = 'summarizing'
          WHERE run_id = 'run-remote-provider-mismatch'
        `)
        const providerMismatch = yield* db
          .run(
            `
            UPDATE compaction_run
            SET state = 'committed', compaction_mode = 'remote_compact',
                encrypted_content_session = 'session-trigger-check',
                encrypted_content_blob_id = 'run-remote-provider-mismatch',
                remote_provider_id = 'openai',
                completion_reason = 'manual', committed_at = 2
            WHERE run_id = 'run-remote-provider-mismatch'
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(providerMismatch)).toBe(true)
        yield* db.run(`
          UPDATE compaction_run SET state = 'failed', terminal_failure_kind = 'test'
          WHERE run_id = 'run-remote-provider-mismatch'
        `)

        // A non-empty pointer is not sufficient: the blob must exist, belong to
        // the same session, and carry the source run that is being committed.
        yield* seedRun("run-remote-missing-blob")
        yield* db.run(`UPDATE compaction_run SET state = 'summarizing' WHERE run_id = 'run-remote-missing-blob'`)
        const missingBlob = yield* db
          .run(
            `
            UPDATE compaction_run
            SET state = 'committed', compaction_mode = 'remote_compact',
                encrypted_content_session = 'session-trigger-check',
                remote_provider_id = 'openai',
                completion_reason = 'manual', committed_at = 2
            WHERE run_id = 'run-remote-missing-blob'
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(missingBlob)).toBe(true)
        yield* db.run(`
          UPDATE compaction_run SET state = 'failed', terminal_failure_kind = 'test'
          WHERE run_id = 'run-remote-missing-blob'
        `)

        // Remote mode without the blob pointer still fails the binding check.
        yield* seedRun("run-remote-no-pointer")
        yield* db.run(`UPDATE compaction_run SET state = 'summarizing' WHERE run_id = 'run-remote-no-pointer'`)
        const noPointer = yield* db
          .run(
            `
            UPDATE compaction_run
            SET state = 'committed', compaction_mode = 'remote_compact',
                completion_reason = 'manual', committed_at = 2
            WHERE run_id = 'run-remote-no-pointer'
          `,
          )
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
          .run(
            `
            UPDATE compaction_run
            SET state = 'committed', completion_reason = 'manual', committed_at = 2
            WHERE run_id = 'run-local-no-summary'
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(localNoSummary)).toBe(true)
        yield* db.run(`
          UPDATE compaction_run SET state = 'failed', terminal_failure_kind = 'test'
          WHERE run_id = 'run-local-no-summary'
        `)

        // The state machine itself is unchanged: skipping summarizing is rejected.
        yield* seedRun("run-skip-state")
        const skip = yield* db
          .run(
            `
            UPDATE compaction_run
            SET state = 'committed', compaction_mode = 'remote_compact',
                encrypted_content_session = 'session-trigger-check',
                remote_provider_id = 'openai',
                completion_reason = 'manual', committed_at = 2
            WHERE run_id = 'run-skip-state'
          `,
          )
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
          .run(
            `
            INSERT INTO session_compaction_encrypted_content (
              session_id, encrypted_content, provider_id, model_id, source_run_id, created_at, updated_at
            ) VALUES ('session-missing', 'blob', 'openai', NULL, NULL, 1, 1)
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(rejected)).toBe(true)
      }),
    )
  })

  test("keeps prior committed blobs immutable while advancing the session head", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        yield* db.run(`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-immutable', '/repo', '[]', 1, 1)
        `)
        yield* db.run(`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, mutation_epoch, time_created, time_updated
          ) VALUES
            ('session-immutable', 'project-immutable', 'immutable', '/repo', 'Immutable', '1', 0, 1, 1),
            ('session-other', 'project-immutable', 'other', '/repo', 'Other', '1', 0, 1, 1)
        `)
        yield* db.run(`
          INSERT INTO session_compaction_encrypted_blob (
            blob_id, session_id, encrypted_content, provider_id, source_run_id, created_at
          ) VALUES
            ('run-immutable-1', 'session-immutable', 'blob-1', 'openai', 'run-immutable-1', 1),
            ('run-immutable-2', 'session-immutable', 'blob-2', 'openai', 'run-immutable-2', 2),
            ('run-other', 'session-other', 'blob-other', 'openai', 'run-other', 2)
        `)
        const crossSessionInsert = yield* db
          .run(
            `
            INSERT INTO session_compaction_encrypted_head (session_id, blob_id, updated_at)
            VALUES ('session-immutable', 'run-other', 1)
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(crossSessionInsert)).toBe(true)
        yield* db.run(`
          INSERT INTO session_compaction_encrypted_head (session_id, blob_id, updated_at)
          VALUES ('session-immutable', 'run-immutable-1', 1)
        `)
        const crossSessionUpdate = yield* db
          .run(
            `
            UPDATE session_compaction_encrypted_head
            SET blob_id = 'run-other'
            WHERE session_id = 'session-immutable'
          `,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(crossSessionUpdate)).toBe(true)
        yield* db.run(`DELETE FROM session WHERE id = 'session-other'`)
        yield* db.run(`
          INSERT INTO compaction_run (
            run_id, session_id, from_prompt_epoch, "trigger", state, created_at,
            source_window_id, source_effective_history_hash, source_message_count, source_projection_version
          ) VALUES (
            'run-immutable-1', 'session-immutable', 0, 'manual', 'requested', 1,
            'window-1', 'hash-1', 1, 1
          )
        `)
        yield* db.run(`UPDATE compaction_run SET state = 'summarizing' WHERE run_id = 'run-immutable-1'`)
        yield* db.run(`
          UPDATE compaction_run
          SET state = 'committed', compaction_mode = 'remote_compact',
              encrypted_content_session = 'session-immutable', encrypted_content_blob_id = 'run-immutable-1',
              remote_provider_id = 'openai', completion_reason = 'manual', committed_at = 2
          WHERE run_id = 'run-immutable-1'
        `)
        yield* db.run(`
          UPDATE session_compaction_encrypted_head
          SET blob_id = 'run-immutable-2', updated_at = 2
          WHERE session_id = 'session-immutable'
        `)
        expect(yield* db.get(`SELECT blob_id FROM session_compaction_encrypted_head`)).toEqual({
          blob_id: "run-immutable-2",
        })
        expect(
          yield* db.all(`SELECT blob_id, encrypted_content FROM session_compaction_encrypted_blob ORDER BY blob_id`),
        ).toEqual([
          { blob_id: "run-immutable-1", encrypted_content: "blob-1" },
          { blob_id: "run-immutable-2", encrypted_content: "blob-2" },
        ])
        const mutation = yield* db
          .run(
            `UPDATE session_compaction_encrypted_blob SET encrypted_content = 'changed' WHERE blob_id = 'run-immutable-1'`,
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(mutation)).toBe(true)
        const deletion = yield* db
          .run(`DELETE FROM session_compaction_encrypted_blob WHERE blob_id = 'run-immutable-1'`)
          .pipe(Effect.exit)
        expect(Exit.isFailure(deletion)).toBe(true)

        yield* db.run(`DELETE FROM session WHERE id = 'session-immutable'`)
        expect(yield* db.get(`SELECT COUNT(*) AS count FROM session_compaction_encrypted_blob`)).toEqual({ count: 0 })
        expect(yield* db.all(`PRAGMA foreign_key_check`)).toEqual([])
      }),
    )
  })
})
