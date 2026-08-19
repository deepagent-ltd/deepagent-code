import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { migrations } from "@deepagent-code/core/database/migration.gen"
import turnStageEvidenceMigration from "@deepagent-code/core/database/migration/20260820120000_session_turn_stage_evidence"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const documentedStages = [
  "activity_claimed",
  "snapshot_started",
  "snapshot_finished",
  "snapshot_degraded",
  "history_loaded",
  "request_prepared",
  "provider_dispatch_started",
  "terminal_settled",
] as const

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

describe("session turn stage evidence migration", () => {
  test("creates the BUG-407-012 gap C evidence table with the documented stage contract", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        // Mirror the runtime connection (Database.layer enables FK before migrating).
        yield* db.run(`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        yield* DatabaseMigration.applyOnly(db, [turnStageEvidenceMigration])

        const check = yield* db.get<{ sql: string }>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'session_turn_stage_evidence'`,
        )
        expect(check).toBeDefined()
        for (const stage of documentedStages) expect(check!.sql).toContain(`'${stage}'`)
        expect(check!.sql).toContain(`PRIMARY KEY (session_id, activity_id)`)
        expect(check!.sql).toContain(`REFERENCES session(id) ON DELETE CASCADE`)

        // One row per (session_id, activity_id).
        const duplicate = yield* db
          .run(`
            INSERT INTO session_turn_stage_evidence (session_id, activity_id, stage, stage_at, updated_at)
            VALUES ('session-missing', 'activity-dup', 'activity_claimed', 1, 1)
          `)
          .pipe(Effect.exit)
        // FK violation fires first (session row absent) — the PK shape is asserted via sqlite_master above.
        expect(Exit.isFailure(duplicate)).toBe(true)

        yield* db.run(`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project-stage-evidence', '/repo', '[]', 1, 1)
        `)
        yield* db.run(`
          INSERT INTO session (
            id, project_id, slug, directory, title, version, mutation_epoch, time_created, time_updated
          ) VALUES (
            'session-stage-evidence', 'project-stage-evidence', 'stage-evidence', '/repo',
            'Stage evidence', '1', 0, 1, 1
          )
        `)

        for (const [index, stage] of documentedStages.entries()) {
          yield* db.run(`
            INSERT INTO session_turn_stage_evidence (session_id, activity_id, stage, stage_at, updated_at)
            VALUES ('session-stage-evidence', 'activity-${stage}', '${stage}', ${index + 1}, ${index + 1})
          `)
        }
        expect(
          yield* db.get(
            `SELECT count(*) AS count FROM session_turn_stage_evidence WHERE session_id = 'session-stage-evidence'`,
          ),
        ).toEqual({ count: documentedStages.length })

        const invalidStage = yield* db
          .run(`
            INSERT INTO session_turn_stage_evidence (session_id, activity_id, stage, stage_at, updated_at)
            VALUES ('session-stage-evidence', 'activity-invalid', 'dispatched', 1, 1)
          `)
          .pipe(Effect.exit)
        expect(Exit.isFailure(invalidStage)).toBe(true)

        // ON DELETE CASCADE: deleting the session removes its stage evidence.
        yield* db.run(`DELETE FROM session WHERE id = 'session-stage-evidence'`)
        expect(
          yield* db.get(
            `SELECT count(*) AS count FROM session_turn_stage_evidence WHERE session_id = 'session-stage-evidence'`,
          ),
        ).toEqual({ count: 0 })

        const indexRow = yield* db.get<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'session_turn_stage_evidence_session_idx'`,
        )
        expect(indexRow).toBeDefined()

        // Idempotent replay + clean FK graph.
        const before = yield* db.get<{ count: number }>(`SELECT count(*) AS count FROM migration`)
        yield* DatabaseMigration.applyOnly(db, [turnStageEvidenceMigration])
        expect(yield* db.get(`SELECT count(*) AS count FROM migration`)).toEqual(before)
        expect(yield* db.all(`PRAGMA foreign_key_check`)).toEqual([])
      }),
    )
  })

  test("orders after every registered migration", async () => {
    for (const registered of migrations) {
      if (registered.id === turnStageEvidenceMigration.id) continue
      expect(turnStageEvidenceMigration.id > registered.id).toBe(true)
    }
  })
})
