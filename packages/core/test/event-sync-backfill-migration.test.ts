import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import eventSnapshotAuthorityMigration from "@deepagent-code/core/database/migration/20260813100000_event_snapshot_authority"
import eventSyncBackfillAuthorityMigration from "@deepagent-code/core/database/migration/20260813125000_event_sync_backfill_authority"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

describe("Event sync backfill migration", () => {
  test("installs staged authority without rewriting legacy event rows", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT)`)
        yield* db.run(sql`CREATE TABLE event (
          id TEXT PRIMARY KEY,
          aggregate_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          data TEXT NOT NULL
        )`)
        yield* db.run(sql`INSERT INTO event_sequence VALUES ('session-a', 2, NULL)`)
        yield* db.run(sql`INSERT INTO event VALUES
          ('event-a', 'session-a', 0, 'test.1', '{"payload":"a"}'),
          ('event-b', 'session-a', 1, 'test.1', '{"payload":"b"}'),
          ('event-c', 'session-a', 2, 'test.1', '{"payload":"c"}')`)

        yield* DatabaseMigration.applyOnly(db, [eventSnapshotAuthorityMigration])

        expect(yield* db.all(sql`SELECT id, sync_seq FROM event ORDER BY rowid`)).toEqual([
          { id: "event-a", sync_seq: null },
          { id: "event-b", sync_seq: null },
          { id: "event-c", sync_seq: null },
        ])
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'event_sync_seq_idx'`),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT state, cursor_rowid, high_water_rowid, processed_count FROM event_sync_backfill`)).toEqual({
          state: "pending",
          cursor_rowid: 0,
          high_water_rowid: 3,
          processed_count: 0,
        })
        expect(yield* db.get(sql`SELECT seq, backfill_complete FROM event_sync_sequence`)).toEqual({
          seq: 3,
          backfill_complete: 0,
        })

        yield* db.run(sql`UPDATE event_sync_sequence SET seq = seq + 1 WHERE id = 1`)
        yield* db.run(sql`INSERT INTO event(id, aggregate_id, seq, type, data, sync_seq)
          VALUES ('event-new', 'session-a', 3, 'test.1', '{}', (SELECT seq FROM event_sync_sequence WHERE id = 1))`)
        const legacyWriter = yield* db.run(sql`INSERT INTO event(id, aggregate_id, seq, type, data)
          VALUES ('event-legacy-writer', 'session-a', 4, 'test.1', '{}')`).pipe(Effect.exit)

        expect(yield* db.all(sql`SELECT sync_seq, event_id FROM event_sync_index ORDER BY sync_seq`)).toEqual([
          { sync_seq: 4, event_id: "event-new" },
        ])
        expect(legacyWriter._tag).toBe("Failure")
        expect(yield* db.get(sql`SELECT id FROM event WHERE id = 'event-legacy-writer'`)).toBeUndefined()
      }),
    )
  })

  test("repairs an already migrated candidate database into pending staged authority", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE event_sequence (
          aggregate_id TEXT PRIMARY KEY,
          seq INTEGER NOT NULL,
          owner_id TEXT,
          retention_floor_seq INTEGER,
          snapshot_id TEXT
        )`)
        yield* db.run(sql`CREATE TABLE event (
          id TEXT PRIMARY KEY,
          aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          sync_seq INTEGER
        )`)
        yield* db.run(sql`CREATE TABLE event_sync_sequence (
          id INTEGER PRIMARY KEY,
          seq INTEGER NOT NULL,
          generation TEXT NOT NULL,
          cursor_secret TEXT NOT NULL
        )`)
        yield* db.run(sql`INSERT INTO event_sequence VALUES ('session-a', 0, NULL, NULL, NULL)`)
        yield* db.run(sql`INSERT INTO event VALUES ('event-a', 'session-a', 0, 'test.1', '{}', 1)`)
        yield* db.run(sql`INSERT INTO event_sync_sequence VALUES (1, 1, lower(hex(randomblob(16))), lower(hex(randomblob(32))))`)

        yield* DatabaseMigration.applyOnly(db, [eventSyncBackfillAuthorityMigration])

        expect(yield* db.get(sql`SELECT backfill_complete FROM event_sync_sequence`)).toEqual({
          backfill_complete: 0,
        })
        expect(yield* db.get(sql`SELECT state, high_water_rowid FROM event_sync_backfill`)).toEqual({
          state: "pending",
          high_water_rowid: 1,
        })
        expect(yield* db.all(sql`SELECT * FROM event_sync_index`)).toEqual([])
      }),
    )
  })
})
