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

const boundary = migrations.findIndex((migration) => migration.id === "20261007231920_event_validation")
const selected = migrations.slice(0, boundary + 1)
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof makeDb>

const snapshot = (db: Db) => Effect.gen(function* () {
  const tables = yield* db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  return {
    schema: yield* db.all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"),
    rows: yield* Effect.forEach(tables, (table) => Effect.gen(function* () {
      if (!/^[a-zA-Z0-9_]+$/.test(table.name)) return yield* Effect.die("Unexpected table identifier")
      return [table.name, (yield* db.all(`SELECT * FROM "${table.name}"`)).map((row) => JSON.stringify(row)).sort()] as const
    })),
  }
})

test("event validation additive upgrade preserves old data, rolls back late DDL, and cold reapply is unchanged", async () => {
  expect(boundary).toBe(233)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-event-validation-migration-"))
  const filename = path.join(directory, "database.sqlite")
  try {
    const after = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, selected.slice(0, -1))
      yield* db.run("INSERT INTO im_groups (id,workspace_id,type,name,created_by,created_at,updated_at) VALUES ('img_before_ev','workspace','project','Original','alice',1,1)")
      yield* db.run("INSERT INTO im_members (group_id,member_id,member_type,role,joined_at) VALUES ('img_before_ev','alice','user','owner',1)")
      yield* db.run("INSERT INTO im_messages (id,group_id,sender_id,sender_type,type,content,created_at,updated_at) VALUES ('imsg_before_ev','img_before_ev','alice','user','text','原聊天保持原字节',1,1)")
      const before = yield* snapshot(db)
      const failed: DatabaseMigration.Migration[] = [...selected.slice(0, -1), { ...selected[boundary]!, up: (tx) => Effect.gen(function* () {
        yield* selected[boundary]!.up(tx)
        return yield* tx.run("SELECT * FROM event_validation_late_failure")
      }) }]
      expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, failed)))).toBe(true)
      expect(yield* snapshot(db)).toEqual(before)
      yield* DatabaseMigration.applyOnly(db, selected)
      const upgraded = yield* snapshot(db)
      expect(upgraded.rows.filter(([name]) => !name.startsWith("event_validation_") && name !== "migration" && !name.startsWith("database_upgrade_")))
        .toEqual(before.rows.filter(([name]) => name !== "migration" && !name.startsWith("database_upgrade_")))
      expect(yield* db.get("SELECT content FROM im_messages WHERE id='imsg_before_ev'"))
        .toEqual({ content: "原聊天保持原字节" })
      expect(yield* db.all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }])
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect(yield* db.get("PRAGMA quick_check")).toEqual({ quick_check: "ok" })
      for (const table of ["event_validation_rule", "event_validation_project", "event_validation_run", "event_validation_command"])
        expect(yield* db.get(`SELECT count(*) count FROM ${table}`)).toEqual({ count: 0 })
      const columns = yield* db.all<{ name: string; notnull: number }>("PRAGMA table_info(event_validation_run)")
      expect(columns.find((column) => column.name === "run_id")?.notnull).toBe(1)
      return upgraded
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    const reopened = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* makeDb
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, selected)
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    expect(reopened).toEqual(after)
  } finally {
    await fs.rm(directory, { recursive: true })
  }
}, 60000)

test("event validation physical guards retain command identity and forbid unknown replay or capacity release", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run("PRAGMA foreign_keys=ON")
    yield* DatabaseMigration.applyOnly(db, selected)
    const receipt = { version: 1, instanceID: "instance", requestID: "request", ruleID: "rule", action: "create", ruleRevision: 1, runID: null, createdAt: 1 }
    yield* db.run(sql`INSERT INTO event_validation_command VALUES ('instance','request','rule','create',${"a".repeat(64)},${JSON.stringify(receipt)},1)`)
    for (const change of ["UPDATE event_validation_command SET request_hash='" + "b".repeat(64) + "'", "DELETE FROM event_validation_command"])
      expect(Exit.isFailure(yield* Effect.exit(db.run(change)))).toBe(true)
    const missing = { ...receipt, requestID: undefined }
    expect(Exit.isFailure(yield* Effect.exit(db.run(sql`INSERT INTO event_validation_command VALUES ('instance','invalid','rule','create',${"a".repeat(64)},${JSON.stringify(missing)},1)`)))).toBe(true)
    const rule = { version: 1, ruleID: "rule", instanceID: "instance", projectKey: "b".repeat(64), revision: 1, state: "disabled",
      operatorID: "operator", operatorRevision: 1, configHash: "c".repeat(64), contentRevision: 0, contentHash: null, runCount: 0,
      pendingFirstAt: null, pendingLastAt: null, dueAt: null, currentRunID: null, lastReason: "disabled", approval: null,
      configuration: { scope: { instanceID: "instance" } }, createdAt: 1, updatedAt: 1 }
    yield* db.run(sql`INSERT INTO event_validation_rule VALUES ('rule','instance',${rule.projectKey},1,'disabled','operator',1,${rule.configHash},0,NULL,0,NULL,NULL,NULL,NULL,'disabled',${JSON.stringify(rule)},${"d".repeat(64)},1,1)`)
    const record = { version: 1, runID: "run", ruleID: "rule", instanceID: "instance", projectKey: rule.projectKey,
      ruleRevision: 1, contentRevision: 1, contentHash: "e".repeat(64), recipeHash: "f".repeat(64), configHash: rule.configHash,
      state: "queued", outcome: null, ownerToken: "owner", revision: 1, cancelRequested: false,
      content: {}, testRunID: "run", previewBuildID: null, workspaceBasename: "cmd_" + "a".repeat(32), workspaceIdentity: null,
      snapshotHash: null, processIncarnation: null, processID: null, result: null, resultCurrent: false,
      retainedBytes: 102825984, releasedAt: null, createdAt: 1, startedAt: null, terminalAt: null, deadline: 100 }
    const insert = (value: typeof record) => db.run(sql`INSERT INTO event_validation_run VALUES (${value.runID},'rule','instance',${value.projectKey},1,${value.contentRevision},${value.contentHash},${value.recipeHash},${value.state},NULL,'owner',${value.revision},0,${JSON.stringify(value)},${"a".repeat(64)},${value.retainedBytes},NULL,1,NULL,NULL,100)`)
    expect(Exit.isFailure(yield* Effect.exit(insert({ ...record, configHash: undefined } as unknown as typeof record)))).toBe(true)
    yield* insert(record)
    yield* db.run(sql`INSERT INTO event_validation_project VALUES (${rule.projectKey},'instance',NULL,NULL,1,1)`)
    yield* db.run(sql`UPDATE event_validation_project SET active_run_id='run',owner_token='owner',revision=2 WHERE project_key=${rule.projectKey}`)
    const preparing = { ...record, state: "preparing", revision: 2 }
    yield* db.run(sql`UPDATE event_validation_run SET state='preparing',revision=2,record=${JSON.stringify(preparing)} WHERE run_id='run'`)
    const prepared = { ...preparing, revision: 3, snapshotHash: "b".repeat(64), processIncarnation: "incarnation", workspaceIdentity: { kind: "posix", device: "1", inode: "2" } }
    yield* db.run(sql`UPDATE event_validation_run SET revision=3,record=${JSON.stringify(prepared)} WHERE run_id='run'`)
    const dispatching = { ...prepared, state: "dispatching", revision: 4, startedAt: 2 }
    yield* db.run(sql`UPDATE event_validation_run SET state='dispatching',revision=4,started_at=2,record=${JSON.stringify(dispatching)} WHERE run_id='run'`)
    const unknown = { ...dispatching, state: "unknown", revision: 5, terminalAt: 3 }
    yield* db.run(sql`UPDATE event_validation_run SET state='unknown',revision=5,terminal_at=3,record=${JSON.stringify(unknown)} WHERE run_id='run'`)
    const before = yield* db.all("SELECT * FROM event_validation_run")
    expect(Exit.isFailure(yield* Effect.exit(db.run(sql`UPDATE event_validation_run SET state='queued',revision=6,record=${JSON.stringify({ ...unknown, state: "queued", revision: 6 })}`)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run(sql`UPDATE event_validation_run SET retained_bytes=0,released_at=4,revision=6,record=${JSON.stringify({ ...unknown, retainedBytes: 0, releasedAt: 4, revision: 6 })}`)))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run("UPDATE event_validation_project SET active_run_id=NULL,owner_token=NULL,revision=3")))).toBe(true)
    expect(Exit.isFailure(yield* Effect.exit(db.run("DELETE FROM event_validation_run")))).toBe(true)
    expect(yield* db.all("SELECT * FROM event_validation_run")).toEqual(before)
    expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
    const refused = { ...record, runID: "no-workspace", contentRevision: 2 }
    yield* insert(refused)
    const terminal = { ...refused, state: "superseded", outcome: "refused", revision: 2, terminalAt: 2 }
    yield* db.run(sql`UPDATE event_validation_run SET state='superseded',outcome='refused',revision=2,terminal_at=2,
      record=${JSON.stringify(terminal)} WHERE run_id='no-workspace'`)
    const cleanup = { ...terminal, retainedBytes: 0, releasedAt: 4, revision: 3,
      preparationRelease: { version: 1, preparationID: "private-preparation", kind: "no_workspace_created", workspaceIdentity: null, observedAt: 3 } }
    const release = (value: typeof cleanup) => db.run(sql`UPDATE event_validation_run SET retained_bytes=0,released_at=4,revision=3,
      record=${JSON.stringify(value)} WHERE run_id='no-workspace'`)
    expect(Exit.isFailure(yield* Effect.exit(release(cleanup)))).toBe(true)
    const previous = yield* snapshot(db)
    const nextBoundary = migrations.findIndex((migration) => migration.id === "20261008000100_event_validation_preparation_release")
    expect(nextBoundary).toBe(234)
    const forward = migrations.slice(0, nextBoundary + 1)
    const failed: DatabaseMigration.Migration[] = [...forward.slice(0, -1), { ...forward[nextBoundary]!, up: (tx) => Effect.gen(function* () {
      yield* forward[nextBoundary]!.up(tx)
      return yield* tx.run("SELECT * FROM preparation_release_late_failure")
    }) }]
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, failed)))).toBe(true)
    expect(yield* snapshot(db)).toEqual(previous)
    yield* DatabaseMigration.applyOnly(db, forward)
    expect(yield* db.all("SELECT * FROM event_validation_run WHERE run_id='run'")).toEqual(before)
    expect(Exit.isFailure(yield* Effect.exit(release({ ...cleanup, preparationRelease: { ...cleanup.preparationRelease, workspaceIdentity: { kind: "posix", device: "1", inode: "2" } } } as unknown as typeof cleanup)))).toBe(true)
    yield* release(cleanup)
    expect(yield* db.get("SELECT retained_bytes,released_at FROM event_validation_run WHERE run_id='no-workspace'"))
      .toEqual({ retained_bytes: 0, released_at: 4 })
    expect(Exit.isFailure(yield* Effect.exit(db.run("UPDATE event_validation_run SET retained_bytes=0,released_at=4,revision=6 WHERE run_id='run'")))).toBe(true)
    const frozen = yield* snapshot(db)
    yield* DatabaseMigration.applyOnly(db, forward)
    expect(yield* snapshot(db)).toEqual(frozen)
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped))
}, 60000)
