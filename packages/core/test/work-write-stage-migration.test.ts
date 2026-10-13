import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const boundary = migrations.findIndex((item) => item.id === "20261007180603_work_write_stage")
const selected = migrations.slice(0, boundary + 1)

test("write-stage upgrade only adds the private column, preserves old terminal rows and guards, and cold reapply is exact", async () => {
  expect(boundary).toBe(229)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-write-stage-migration-"))
  const filename = path.join(directory, "database.sqlite")
  try {
    const upgraded = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, selected.slice(0, -1))
      yield* db.run("INSERT INTO session_v2_tool_effect_admission VALUES ('old-admission','session-fixture','attempt-fixture','receipt-fixture','call-fixture','read','read_only','owner-fixture',1)")
      yield* db.run(sql`INSERT INTO session_v2_tool_effect (effect_id,session_id,provider_attempt_id,receipt_id,tool_call_id,tool_name,effect_kind,state,outcome_hash,known_read_proof,owner_token,time_created) VALUES ('old-effect','session-fixture','attempt-fixture','receipt-fixture','call-fixture','read','read_only','settled',${"a".repeat(64)},'{"version":1}', 'owner-fixture',2)`)
      const columns = (yield* db.all<{ name: string }>("PRAGMA table_info(session_v2_tool_effect)")).map((row) => row.name)
      const projection = sql`SELECT ${sql.join(columns.map(sql.identifier), sql`, `)} FROM session_v2_tool_effect ORDER BY effect_id`
      const before = yield* db.all(projection)
      const guards = yield* db.all("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='session_v2_tool_effect' ORDER BY name")
      const schema = yield* db.all("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
      const journal = yield* db.all("SELECT * FROM migration ORDER BY id")
      const failed: DatabaseMigration.Migration[] = [...selected.slice(0, -1), {
        ...selected[boundary], up: (tx) => Effect.gen(function* () {
          yield* selected[boundary].up(tx)
          return yield* tx.run("SELECT * FROM write_stage_late_failure")
        }),
      }]
      expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, failed)))).toBe(true)
      expect(yield* db.all("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")).toEqual(schema)
      expect(yield* db.all("SELECT * FROM migration ORDER BY id")).toEqual(journal)
      expect(yield* db.all(projection)).toEqual(before)
      yield* DatabaseMigration.applyOnly(db, selected)
      expect(yield* db.all(projection)).toEqual(before)
      expect(yield* db.get("SELECT known_write_proof FROM session_v2_tool_effect")).toEqual({ known_write_proof: null })
      expect(yield* db.all("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='session_v2_tool_effect' ORDER BY name")).toEqual(guards)
      expect(yield* db.all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }])
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect(yield* db.get("SELECT COUNT(*) AS count FROM work_write_stage")).toEqual({ count: 0 })
      expect(yield* db.get("SELECT COUNT(*) AS count FROM work_write_stage_meter")).toEqual({ count: 0 })
      return {
        rows: yield* db.all("SELECT * FROM session_v2_tool_effect ORDER BY effect_id"),
        schema: yield* db.all("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"),
        journal: yield* db.all("SELECT * FROM migration ORDER BY id"),
      }
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    const reopened = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, selected)
      return {
        rows: yield* db.all("SELECT * FROM session_v2_tool_effect ORDER BY effect_id"),
        schema: yield* db.all("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"),
        journal: yield* db.all("SELECT * FROM migration ORDER BY id"),
      }
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    expect(reopened).toEqual(upgraded)
  } finally {
    await fs.rm(directory, { recursive: true })
  }
})

test("write-stage meter records real growth beyond the admission cap, and proof SQL shape stays separate from read", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run("PRAGMA foreign_keys=ON")
    yield* DatabaseMigration.applyOnly(db, selected)
    yield* db.run("INSERT INTO work_write_stage_meter VALUES ('instance-fixture',1,268435457,1,1,1)")
    expect(yield* db.get("SELECT retained_bytes FROM work_write_stage_meter")).toEqual({ retained_bytes: 268435457 })
    expect(Exit.isFailure(yield* Effect.exit(db.run("UPDATE work_write_stage_meter SET custody_count=33,revision=2")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run("UPDATE work_write_stage_meter SET audit_count=10001,revision=2")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run("UPDATE work_write_stage_meter SET retained_bytes=9007199254740992,revision=2")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run("DELETE FROM work_write_stage_meter")))).toBe(true)
    for (const kind of ["read_only", "mutating"]) {
      yield* db.run(sql`INSERT INTO session_v2_tool_effect_admission VALUES (${`admission-${kind}`},'session-fixture','attempt-fixture','receipt-fixture',${kind},${kind === "read_only" ? "read" : "write"},${kind},'owner-fixture',1)`)
    }
    const insert = (id: string, kind: "read_only" | "mutating", proof: string) => db.run(sql`INSERT INTO session_v2_tool_effect
      (effect_id,session_id,provider_attempt_id,receipt_id,tool_call_id,tool_name,effect_kind,state,outcome_hash,known_write_proof,owner_token,time_created)
      VALUES (${id},'session-fixture','attempt-fixture','receipt-fixture',${kind},${kind === "read_only" ? "read" : "write"},${kind},'settled',${"a".repeat(64)},${proof},'owner-fixture',2)`)
    for (const proof of ["", "{}", '{"version":2}', "[]", "x".repeat(16385)])
      expect(Exit.isFailure(yield* Effect.exit(insert("bad-shape", "mutating", proof)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(insert("bad-kind", "read_only", '{"version":1}')))).toBe(true)
    // This is only a storage-shape oracle; the native HMAC/witness verifier
    // must reject this unsigned object before a production terminal is admitted.
    yield* insert("shape-only", "mutating", '{"version":1}')
    expect(yield* db.get("SELECT known_read_proof,known_write_proof FROM session_v2_tool_effect"))
      .toEqual({ known_read_proof: null, known_write_proof: '{"version":1}' })
    expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped))
})
