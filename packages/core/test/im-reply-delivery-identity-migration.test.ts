import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { DatabaseMigration } from "../src/database/migration"
import original from "../src/database/migration/20260918120000_im_reply_outbox"
import current from "../src/database/migration/20261008213323_im_reply_delivery_identity"
import { ReplyDeliveryID } from "../src/im/reply-delivery-id"

const database = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof database>
const seed = (db: Db, id: string) => db.run(sql`INSERT INTO im_reply_outbox
  (id,session_id,group_id,agent_id,reply_message_id,reply_text,time_created,time_updated)
  VALUES (${id},${`session-${id}`},'group','agent',${`reply-${id}`},'相同的失败回复',1,1)`)

test("forward indexes all original reply identities across pages and preserves exact bytes after file reopen", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-reply-identity-"))
  const filename = path.join(root, "database.sqlite")
  const ids = [...Array.from({ length: 265 }, (_, i) => `imo_${String(i).padStart(4, "0")}`), "imresult_中文\"\\末尾"]
  const originalRows = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* database
    yield* DatabaseMigration.applyOnly(db, [original])
    yield* Effect.forEach(ids, (id) => seed(db, id), { discard: true })
    return yield* db.all<{ id: string }>("SELECT * FROM im_reply_outbox ORDER BY id COLLATE BINARY")
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  const inode = await fs.stat(filename)
  const rows = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* database
    yield* DatabaseMigration.applyOnly(db, [original, current])
    const rows = yield* db.all<{ id: string; delivery_message_id: string }>("SELECT * FROM im_reply_outbox ORDER BY id COLLATE BINARY")
    expect(rows.map(({ delivery_message_id, ...row }) => row)).toEqual(originalRows)
    expect(rows.map((row) => row.delivery_message_id)).toEqual(rows.map((row) => ReplyDeliveryID.fromOutbox(row.id)))
    expect((yield* db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN SELECT id FROM im_reply_outbox
      WHERE delivery_message_id=${ReplyDeliveryID.fromOutbox(ids[264])}`))
      .some((row) => row.detail.includes("im_reply_outbox_delivery_message_idx"))).toBeTrue()
    expect(Exit.isFailure(yield* db.run(sql`UPDATE im_reply_outbox SET delivery_message_id='imsg_reply_invalid' WHERE id=${ids[0]}`).pipe(Effect.exit))).toBeTrue()
    expect(Exit.isFailure(yield* db.run(sql`UPDATE im_reply_outbox SET delivery_message_id=${ReplyDeliveryID.fromOutbox(ids[0])}
      WHERE id=${ids[1]}`).pipe(Effect.exit))).toBeTrue()
    return rows
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* database
    yield* DatabaseMigration.applyOnly(db, [original, current])
    expect(yield* db.all("SELECT * FROM im_reply_outbox ORDER BY id COLLATE BINARY")).toEqual(rows)
    expect(yield* db.all("PRAGMA quick_check")).toEqual([{ quick_check: "ok" }])
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  expect((await fs.stat(filename)).ino).toBe(inode.ino)
  await fs.rm(root, { recursive: true })
})

test("late SQL failure rolls back the derived column and keeps every original outbox byte", () => Effect.runPromise(Effect.gen(function* () {
  const db = yield* database
  yield* DatabaseMigration.applyOnly(db, [original])
  yield* seed(db, "imo_rollback")
  const before = yield* db.all("SELECT * FROM im_reply_outbox")
  const failed = yield* DatabaseMigration.applyOnly(db, [{ ...current,
    up: (tx) => current.up(tx).pipe(Effect.andThen(tx.run("SELECT * FROM missing_late_identity_table"))),
  }]).pipe(Effect.exit)
  expect(Exit.isFailure(failed)).toBeTrue()
  expect(yield* db.all("SELECT * FROM im_reply_outbox")).toEqual(before)
  expect((yield* db.all<{ name: string }>("PRAGMA table_info(im_reply_outbox)"))
    .some((column) => column.name === "delivery_message_id")).toBeFalse()
  expect(yield* db.all("SELECT * FROM migration WHERE id='20261008213323_im_reply_delivery_identity'")).toEqual([])
} ).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped)))
