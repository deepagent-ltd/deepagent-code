export * as MediaUploadCheckpointMigrationFixture from "./im-media-upload-checkpoint-migration"

import { expect } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { DatabaseMigration } from "../../src/database/migration"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
export type Db = Effect.Success<typeof makeDb>
export type RawRow = Record<string, string | number | null>
export const workspaceID = "checkpoint-original-workspace-中文🙂"
export const groupID = "img_checkpoint_legacy_protected"
export const userID = "checkpoint-local-owner"
export const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

/** File-backed original SQLite with FK enforcement throughout. A caller that
 * deliberately tests a pre-existing deferred/FK failure must restore its own
 * setting before this boundary verifies the final state. */
export const open = <A, E>(filename: string, body: (db: Db) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run("PRAGMA foreign_keys=ON")
    expect(yield* db.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 })
    const result = yield* body(db)
    expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
    expect(yield* db.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 })
    expect(yield* db.get("PRAGMA defer_foreign_keys")).toEqual({ defer_foreign_keys: 0 })
    expect(yield* db.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" })
    return result
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))

export const isolated = async (body: (filename: string) => Promise<void>) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-media-upload-checkpoint-migration-"))
  await fs.chmod(directory, 0o700)
  const filename = path.join(directory, "database.sqlite")
  try { await body(filename) }
  finally {
    await fs.rm(directory, { recursive: true })
    expect(await Bun.file(filename).exists()).toBe(false)
  }
}

// Snapshots expose only schema/data hashes and counts. Unicode names, private
// paths and original body specimens do not appear in failing assertions.
export const snapshot = (db: Db, omitted: readonly string[] = []) => Effect.gen(function* () {
  const schema = yield* db.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
  return {
    schema: schema.filter((row) => !omitted.includes(row.tbl_name)).map((row) =>
      ({ type: row.type, name: row.name, table: row.tbl_name, hash: digest(row.sql ?? "") })),
    data: yield* Effect.forEach(schema.filter((row) => row.type === "table" && !omitted.includes(row.name)),
      (table) => Effect.gen(function* () {
        if (!/^[a-zA-Z0-9_]+$/.test(table.name)) return yield* Effect.die("Unexpected private fixture identifier")
        const rows = yield* db.all<RawRow>(`SELECT * FROM "${table.name}"`)
        return { table: table.name, count: rows.length,
          hash: digest(JSON.stringify(rows.map((row) => digest(JSON.stringify(row))).sort())) }
      })),
  }
})

/** An independent accounting oracle derives actual physical columns. It does
 * not call the production codec or copy its field lists. */
export const rowBytes = (db: Db, table: string, key: string, value: string | number) => Effect.gen(function* () {
  if (![table, key].every((name) => /^[a-zA-Z0-9_]+$/.test(name))) return yield* Effect.die("Unexpected private fixture identifier")
  const columns = yield* db.all<{ name: string; type: string }>(`PRAGMA table_info("${table}")`)
  const expression = columns.map((column) => /INT/i.test(column.type)
    ? `CASE WHEN "${column.name}" IS NULL THEN 0 ELSE 8 END`
    : `coalesce(length(CAST("${column.name}" AS BLOB)),0)`).join("+")
  return (yield* db.get<{ bytes: number }>(sql`SELECT ${sql.raw(expression)} bytes FROM ${sql.raw(`"${table}"`)} WHERE ${sql.raw(`"${key}"`)}=${value}`))?.bytes ?? 0
})

/** Seed only legal historical storage in the previous official schema. No
 * current reader, origin, FD, remote object or execution permission is minted. */
export const seedLegacy = (db: Db, previous: readonly DatabaseMigration.Migration[]) => Effect.gen(function* () {
  yield* DatabaseMigration.applyOnly(db, [...previous])
  yield* db.run("INSERT INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES('checkpoint-original-project','/private/checkpoint-history','[]',10,11)")
  yield* db.run(sql`INSERT INTO im_groups(id,workspace_id,project_id,type,name,created_by,kernel_conv_id,created_at,updated_at)
    VALUES (${groupID},${workspaceID},'checkpoint-original-project','project',${"原群🙂 é <>&"},${userID},'k:2:checkpoint-native-group',10,11)`)
  yield* db.run(sql`INSERT INTO im_groups(id,workspace_id,type,name,created_by,created_at,updated_at)
    VALUES ('img_checkpoint_legacy_local',${workspaceID},'direct',${"原本地会话🙂"},${userID},10,11)`)
  yield* db.run(sql`INSERT INTO im_members(group_id,member_id,member_type,role,joined_at)
    VALUES (${groupID},${userID},'user','owner',10)`)
  yield* db.run(sql`INSERT INTO im_messages(id,group_id,sender_id,sender_type,type,content,metadata,client_request_id,created_at,updated_at)
    VALUES ('imsg_checkpoint_legacy_local','img_checkpoint_legacy_local',${userID},'user','file',${"原本地正文🙂 é"},
    ${JSON.stringify({ type: "attachment_ref", attachmentID: "ima_checkpoint_legacy_2" }, null, 2)},${"原请求🙂"},10,11)`)
  const ids = ["ima_checkpoint_legacy_0", "ima_checkpoint_legacy_1", "ima_checkpoint_legacy_2", "ima_checkpoint_legacy_3"]
  yield* Effect.forEach(ids, (id, index) => db.run(sql`INSERT INTO im_attachments(id,workspace_id,project_id,group_id,message_id,uploaded_by,storage_path,filename,mime,size_bytes,checksum,created_at,deleted_at)
    VALUES (${id},${workspaceID},${index % 2 ? null : "checkpoint-original-project"},${index === 2 ? "img_checkpoint_legacy_local" : groupID},
      ${index === 2 ? "imsg_checkpoint_legacy_local" : null},${userID},${`/private/never-opened/checkpoint/${index}`},
      ${`原文件🙂 é ${index}.txt`},'text/plain; charset=utf-8',${index},${digest("x".repeat(index))},10,${index === 3 ? 11 : null})`))
  return ids
})
