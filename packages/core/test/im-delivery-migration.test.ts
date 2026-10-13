import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"

test("authority migrations preserve old messages, never synthesize intents, and are repeatable", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys = ON")
      const boundary = migrations.findIndex((migration) => migration.id === "20261005162725_im_delivery_authority")
      expect(boundary).toBeGreaterThan(0)
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, boundary))
      yield* db.run(
        "INSERT INTO im_groups (id, workspace_id, type, name, created_by, created_at, updated_at) VALUES ('img_old', 'ws', 'project', 'Old', 'alice', 1, 1)",
      )
      yield* db.run(
        "INSERT INTO im_messages (id, group_id, sender_id, sender_type, type, content, created_at, updated_at) VALUES ('imsg_old', 'img_old', 'alice', 'user', 'text', '@auto old history', 1, 1)",
      )
      yield* DatabaseMigration.applyOnly(db, migrations.slice(boundary))
      yield* DatabaseMigration.applyOnly(db, migrations.slice(boundary))
      yield* db.run("INSERT INTO im_media_cleanup_cursor (workspace_id, revision, updated_at) VALUES ('ws', 0, 1)")
      yield* db.run("UPDATE im_media_cleanup_cursor SET after_created_at = 1, after_id = 'ima_scanned', revision = 1 WHERE workspace_id = 'ws'")
      yield* DatabaseMigration.applyOnly(db, migrations.slice(boundary))
      expect(yield* db.get("SELECT after_created_at, after_id, revision FROM im_media_cleanup_cursor WHERE workspace_id = 'ws'"))
        .toEqual({ after_created_at: 1, after_id: "ima_scanned", revision: 1 })
      for (const values of [
        "NULL, NULL, NULL, 0, 1",
        "'', NULL, NULL, 0, 1",
        "'bad', 1, NULL, 0, 1",
        "'bad', NULL, 'ima_bad', 0, 1",
        "'bad', 1, '', 0, 1",
        "'bad', 1, 'ima_bad', -1, 1",
        "'bad', 1, 'ima_bad', 0, 9007199254740992",
      ]) {
        expect((yield* db.run(`INSERT INTO im_media_cleanup_cursor (workspace_id, after_created_at, after_id, revision, updated_at) VALUES (${values})`).pipe(Effect.exit))._tag)
          .toBe("Failure")
      }
      expect(yield* db.get("SELECT count(*) AS n FROM im_media_cleanup_cursor")).toEqual({ n: 1 })
      yield* db.run(`INSERT INTO im_media_cleanup_cursor (workspace_id, revision, updated_at) VALUES ('/${"a".repeat(1024)}', 0, 1)`)
      expect(yield* db.get("SELECT count(*) AS n FROM im_media_cleanup_cursor")).toEqual({ n: 2 })
      expect((yield* db.all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT message_id FROM im_kernel_delivery WHERE kernel_message_id = 'ack' AND state = 'acknowledged' LIMIT 2",
      )).some((row) => row.detail.includes("im_kernel_delivery_result_lookup_idx"))).toBe(true)
      expect(yield* db.get("SELECT content, client_request_id FROM im_messages WHERE id = 'imsg_old'")).toEqual({
        content: "@auto old history",
        client_request_id: null,
      })
      expect(yield* db.get("SELECT count(*) AS n FROM im_mention_intent")).toEqual({ n: 0 })
      expect(
        (yield* db.all<{ name: string; notnull: number }>("PRAGMA table_info(session_activity)")).find(
          (column) => column.name === "final_message_id",
        ),
      ).toMatchObject({ notnull: 0 })
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})
