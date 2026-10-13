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

const boundary = migrations.findIndex((item) => item.id === "20261006235109_goal_tick_checkpoint")
const checkpointMigrations = migrations.slice(0, boundary + 1)
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof makeDb>
const hash = "a".repeat(64)

// Raw SQL fixtures check migration preservation and constraints, not Goal execution eligibility.
const seed = (db: Db) =>
  Effect.gen(function* () {
    // The raw SqliteClient seam does not enable the production Database layer's FK policy.
    yield* db.run(sql`PRAGMA foreign_keys = ON`)
    yield* db.run(sql`INSERT INTO goal_control
      (goal_id,session_id,is_current,plan_doc_id,project_id,directory,driver_mode,initialization,
        initialization_hash,preparation,revision,requested_phase,next_seq,plan_version,created_at,updated_at)
      VALUES('migration-goal','migration-parent',1,'migration-plan','migration-project','/fixture',
        'event','{"version":1}',${hash},'ready',0,'running',0,0,1,1)`)
    yield* db.run(sql`INSERT INTO goal_tick_permit
      (permit_id,goal_id,tick_seq,control_revision,plan_version,owner_id,token,state,child_sessions,interrupt_state,created_at)
      VALUES('migration-permit','migration-goal',0,0,0,'migration-owner','migration-token','issued','[]','none',1)`)
    yield* db.run(sql`INSERT INTO goal_child_unit
      (unit_id,goal_id,permit_id,role_key,parent_session_id,child_session_id,binding,binding_hash,state,inputs,created_at,updated_at)
      VALUES('migration-unit','migration-goal','migration-permit','worker/0','migration-parent','migration-child',
        '{"version":1,"permissionPolicy":"parent-exact-v1"}',${hash},'reserved','[]',1,1)`)
    yield* db.run(sql`INSERT INTO im_kernel_delivery
      (message_id,binding,binding_hash,wire_id,state,created_at,updated_at)
      VALUES('migration-message','{"version":1}',${hash},'migration-wire','prepared',1,1)`)
  })

const original = (db: Db) =>
  Effect.all({
    goal: db.all(sql`SELECT * FROM goal_control`),
    permit: db.all(sql`SELECT * FROM goal_tick_permit`),
    child: db.all(sql`SELECT * FROM goal_child_unit`),
    delivery: db.all(sql`SELECT * FROM im_kernel_delivery`),
  })

const snapshot = (db: Db) =>
  Effect.all({
    schema: db.all(
      sql`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
    ),
    journal: db.all(sql`SELECT * FROM migration ORDER BY id`),
    rows: original(db),
    checkpoint: db.all(sql`SELECT * FROM goal_tick_checkpoint`),
    integrity: db.all(sql`PRAGMA quick_check`),
  })

const insert = (
  db: Db,
  input: Partial<{
    permitID: string | null
    tickSeq: number
    version: number
    revision: number
    checkedSeq: number
    journal: string
    logicalBytes: number
    reservedBytes: number
    createdAt: number
    updatedAt: number
  }> = {},
) => {
  const row = {
    permitID: "migration-permit",
    tickSeq: 0,
    version: 1,
    revision: 0,
    checkedSeq: 0,
    journal: "{}",
    logicalBytes: 2,
    reservedBytes: 1_048_576,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  }
  return db.run(sql`INSERT INTO goal_tick_checkpoint
    (permit_id,goal_id,tick_seq,version,revision,binding_hash,role_manifest_hash,parent_checked_through_seq,
      state,journal,journal_hash,logical_bytes,reserved_bytes,created_at,updated_at)
    VALUES(${row.permitID},'migration-goal',${row.tickSeq},${row.version},${row.revision},${hash},${hash},
      ${row.checkedSeq},'prepared',${row.journal},${hash},${row.logicalBytes},${row.reservedBytes},${row.createdAt},${row.updatedAt})`)
}

test("checkpoint forward migration preserves prior Goal/IM SQL rows and file identity on reopen", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dac-checkpoint-migration-"))
  const filename = path.join(root, "authority.sqlite")
  const run = (first: boolean) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* makeDb
        if (first) {
          expect(boundary).toBe(215)
          yield* DatabaseMigration.applyOnly(db, migrations.slice(0, boundary))
          yield* seed(db)
          const before = yield* original(db)
          yield* DatabaseMigration.applyOnly(db, checkpointMigrations)
          expect(yield* original(db)).toEqual(before)
          yield* insert(db)
        }
        yield* DatabaseMigration.applyOnly(db, checkpointMigrations)
        return yield* snapshot(db)
      }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped),
    )
  try {
    const first = await run(true)
    const before = await fs.stat(filename)
    const second = await run(false)
    const after = await fs.stat(filename)
    expect(second).toEqual(first)
    expect(second.journal).toHaveLength(216)
    expect(second.checkpoint).toHaveLength(1)
    expect(second.integrity).toEqual([{ quick_check: "ok" }])
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
    if (process.env.DAC_CHECKPOINT_MIGRATION_EVIDENCE)
      await Bun.write(
        path.join(process.env.DAC_CHECKPOINT_MIGRATION_EVIDENCE, "file-reopen.json"),
        JSON.stringify({ filename, dev: after.dev, inode: after.ino, first, second }, null, 2),
      )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("actual checkpoint SQL rejects NULL, unsafe counts, false byte reservations and invalid time", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* DatabaseMigration.applyOnly(db, checkpointMigrations)
      yield* seed(db)
      const invalid = [
        { permitID: null },
        { permitID: "" },
        { permitID: "missing-permit" },
        { version: 2 },
        { revision: -1 },
        { revision: 0.5 },
        { revision: Number.MAX_SAFE_INTEGER + 1 },
        { tickSeq: -1 },
        { checkedSeq: 0.5 },
        { journal: "[]" },
        { journal: "invalid" },
        { logicalBytes: 1 },
        { logicalBytes: 3 },
        { reservedBytes: 1 },
        { reservedBytes: 1_048_577 },
        { reservedBytes: 2.5 },
        { createdAt: -1 },
        { updatedAt: 0 },
        { updatedAt: 1.5 },
        { journal: '{"text":"中文"}', logicalBytes: 13 },
      ]
      yield* Effect.forEach(invalid, (input) =>
        insert(db, input).pipe(
          Effect.exit,
          Effect.tap((exit) =>
            Effect.sync(() => expect({ input, rejected: Exit.isFailure(exit) }).toEqual({ input, rejected: true })),
          ),
        ),
      )
      expect(yield* db.all(sql`SELECT * FROM goal_tick_checkpoint`)).toHaveLength(0)
      yield* insert(db, { journal: '{"text":"中文"}', logicalBytes: Buffer.byteLength('{"text":"中文"}') })
      expect(yield* db.get(sql`SELECT logical_bytes FROM goal_tick_checkpoint`)).toEqual({ logical_bytes: 17 })
      expect(Exit.isFailure(yield* insert(db).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
  ))

test("late migration DDL failure rolls back table, new index and registry row", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, boundary))
      yield* seed(db)
      yield* db.run(sql`CREATE INDEX goal_tick_checkpoint_state_idx ON goal_control(updated_at)`)
      const before = yield* Effect.all({
        schema: db.all(sql`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`),
        journal: db.all(sql`SELECT * FROM migration ORDER BY id`),
        rows: original(db),
      })
      expect(Exit.isFailure(yield* DatabaseMigration.applyOnly(db, checkpointMigrations).pipe(Effect.exit))).toBe(true)
      expect(
        yield* Effect.all({
          schema: db.all(sql`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`),
          journal: db.all(sql`SELECT * FROM migration ORDER BY id`),
          rows: original(db),
        }),
      ).toEqual(before)
      expect(yield* db.all(sql`PRAGMA quick_check`)).toEqual([{ quick_check: "ok" }])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
  ))
