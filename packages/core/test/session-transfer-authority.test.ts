import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import sessionTransferAuthorityMigration from "@deepagent-code/core/database/migration/20260813133000_session_transfer_authority"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

describe("Session transfer authority", () => {
  test("fences source input and enforces monotonic cross-database phases", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE event_sequence (
          aggregate_id TEXT PRIMARY KEY,
          seq INTEGER NOT NULL,
          owner_id TEXT
        )`)
        yield* db.run(sql`CREATE TABLE session_input (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL
        )`)
        yield* db.run(sql`INSERT INTO session VALUES ('session-a')`)
        yield* db.run(sql`INSERT INTO event_sequence VALUES ('session-a', 7, 'source-owner')`)
        yield* DatabaseMigration.applyOnly(db, [sessionTransferAuthorityMigration])

        yield* db.run(sql`INSERT INTO session_transfer_operation(
          transfer_id, session_id, source_owner_id, target_owner_id,
          source_event_seq, source_mutation_epoch, state, request_hash, created_at, updated_at
        ) VALUES (
          'transfer-a', 'session-a', 'source-owner', 'target-owner',
          7, 3, 'admitted', ${"a".repeat(64)}, 1, 1
        )`)
        yield* db.run(sql`UPDATE event_sequence SET write_fence_transfer_id = 'transfer-a'
          WHERE aggregate_id = 'session-a'`)
        const input = yield* db
          .run(sql`INSERT INTO session_input VALUES ('input-a', 'session-a')`)
          .pipe(Effect.exit)
        expect(Exit.isFailure(input)).toBe(true)

        yield* db.run(sql`UPDATE session_transfer_operation
          SET state = 'source_frozen', snapshot_id = 'snapshot-a', snapshot_hash = ${"b".repeat(64)}
          WHERE transfer_id = 'transfer-a'`)
        yield* db.run(sql`UPDATE session_transfer_operation SET state = 'target_staged'
          WHERE transfer_id = 'transfer-a'`)
        const skipped = yield* db
          .run(sql`UPDATE session_transfer_operation SET state = 'target_activated'
            WHERE transfer_id = 'transfer-a'`)
          .pipe(Effect.exit)
        expect(Exit.isFailure(skipped)).toBe(true)
        yield* db.run(sql`UPDATE session_transfer_operation SET state = 'owner_committed'
          WHERE transfer_id = 'transfer-a'`)
        yield* db.run(sql`UPDATE session_transfer_operation SET state = 'target_activated', completed_at = 5
          WHERE transfer_id = 'transfer-a'`)
        expect(yield* db.get(sql`SELECT state, snapshot_id FROM session_transfer_operation`)).toEqual({
          state: "target_activated",
          snapshot_id: "snapshot-a",
        })
      }),
    )
  })
})
