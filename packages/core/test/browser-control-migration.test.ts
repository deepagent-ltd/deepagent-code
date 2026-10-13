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

const boundary = migrations.findIndex((item) => item.id === "20261007050245_managed_browser_control")
const browserMigrations = migrations.slice(0, boundary + 1)
const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof makeDb>
const hash = "a".repeat(64)
// Raw rows prove physical migration constraints, never canonical tool authority or a live host.
const control = {
  control_id: "migration-control", request_id: "migration-create", request_digest: hash,
  principal: "migration-operator", security_namespace_id: "migration-namespace",
  location_key: "migration-location", project_scope_key: "migration-scope",
  namespace_binding_hash: hash, session_id: "migration-session", project_id: "migration-project",
  directory: "/fixture", host_id: "migration-host", host_incarnation: "migration-incarnation",
  resource_id: "migration-resource", credential_binding: hash,
  profile: "managed-loopback-preview-v1", origin: "http://127.0.0.1:80", revision: 1,
  epoch: 1, policy_revision: 1, state: "active", expires_at: 100, record: "{}",
  record_hash: hash, created_at: 1, updated_at: 1,
}
const action = {
  action_id: "migration-action", control_id: control.control_id, request_id: "migration-action-request",
  command_digest: hash, admission_id: "migration-admission", provider_receipt_id: "migration-provider",
  provider_attempt_id: "migration-attempt", tool_call_id: "migration-call", session_id: control.session_id,
  host_incarnation: control.host_incarnation, resource_id: control.resource_id, control_epoch: 1,
  policy_revision: 1, revision: 1, deadline: 100, outcome: "pending", record: "{}",
  record_hash: hash, created_at: 1, updated_at: 1,
}

function insert(db: Db, table: "browser_control" | "browser_action", row: Record<string, string | number | null>) {
  return db.run(sql`INSERT INTO ${sql.identifier(table)}
    (${sql.join(Object.keys(row).map((key) => sql.identifier(key)), sql`,`)})
    VALUES (${sql.join(Object.values(row).map((value) => sql`${value}`), sql`,`)})`)
}

const snapshot = (db: Db) => Effect.all({
  schema: db.all(sql`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`),
  migrations: db.all(sql`SELECT * FROM migration ORDER BY id`),
  goals: db.all(sql`SELECT * FROM goal_control ORDER BY goal_id`),
  foreignKeys: db.all(sql`PRAGMA foreign_key_check`),
  integrity: db.all(sql`PRAGMA quick_check`),
})

const seed = (db: Db) => db.run(sql`INSERT INTO goal_control
  (goal_id,session_id,is_current,plan_doc_id,project_id,directory,driver_mode,initialization,initialization_hash,preparation,revision,requested_phase,next_seq,plan_version,created_at,updated_at)
  VALUES ('browser-migration-goal','browser-migration-session',1,'browser-migration-plan','browser-migration-project','/fixture','event','{"version":1,"original":"中文\\n"}',${hash},'ready',0,'paused',0,0,1,1)`)

test("same-file 218 to 219 preserves Goal bytes and browser business rows on reopen and reapply", async () => {
  expect(boundary).toBe(218)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-migration-"))
  const filename = path.join(directory, "database.sqlite")
  const before = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql`PRAGMA foreign_keys=ON`)
    yield* DatabaseMigration.applyOnly(db, browserMigrations.slice(0, -1))
    yield* seed(db)
    return yield* db.all(sql`SELECT * FROM goal_control`)
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  const identity = await fs.stat(filename)
  const first = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql`PRAGMA foreign_keys=ON`)
    yield* DatabaseMigration.applyOnly(db, browserMigrations)
    expect(yield* db.all(sql`SELECT * FROM goal_control`)).toEqual(before)
    yield* insert(db, "browser_control", control)
    yield* insert(db, "browser_action", action)
    return yield* Effect.all({ snapshot: snapshot(db), controls: db.all(sql`SELECT * FROM browser_control`), actions: db.all(sql`SELECT * FROM browser_action`) })
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  const reopened = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql`PRAGMA foreign_keys=ON`)
    yield* DatabaseMigration.applyOnly(db, browserMigrations)
    return yield* Effect.all({ snapshot: snapshot(db), controls: db.all(sql`SELECT * FROM browser_control`), actions: db.all(sql`SELECT * FROM browser_action`) })
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  expect(reopened).toEqual(first)
  expect(reopened.snapshot.foreignKeys).toEqual([])
  expect(reopened.snapshot.integrity).toEqual([{ quick_check: "ok" }])
  const after = await fs.stat(filename)
  expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: identity.dev, ino: identity.ino })
  await fs.rm(directory, { recursive: true })
})

test("browser physical CHECKs reject NULL PK, UTF8 overflow, unsafe integers and invalid records", () => Effect.runPromise(Effect.gen(function* () {
  const db = yield* makeDb
  yield* DatabaseMigration.applyOnly(db, browserMigrations)
  for (const changes of [
    { control_id: null }, { principal: "" }, { security_namespace_id: "中".repeat(171) },
    { directory: "中".repeat(683) }, { request_digest: "A".repeat(64) },
    { credential_binding: "0".repeat(63) }, { revision: 0 }, { revision: 1.5 },
    { revision: 9007199254740992 }, { updated_at: 0 }, { expires_at: 1 },
    { state: "invented" }, { profile: "arbitrary" }, { record: "{" },
    { record: JSON.stringify("中".repeat(5461)) },
  ]) {
    expect(Exit.isFailure(yield* insert(db, "browser_control", { ...control, ...changes }).pipe(Effect.exit))).toBe(true)
  }
  yield* insert(db, "browser_control", control)
  expect(Exit.isFailure(yield* insert(db, "browser_control", { ...control, control_id: "second" }).pipe(Effect.exit))).toBe(true)
  for (const changes of [
    { action_id: null }, { provider_receipt_id: "中".repeat(171) }, { revision: 0 },
    { control_epoch: -1 }, { policy_revision: 9007199254740992 }, { deadline: 1 },
    { outcome: "invented" }, { record_hash: "!".repeat(64) }, { record: "{" },
    { record: JSON.stringify("中".repeat(43691)) },
  ]) {
    expect(Exit.isFailure(yield* insert(db, "browser_action", { ...action, ...changes }).pipe(Effect.exit))).toBe(true)
  }
  yield* insert(db, "browser_action", action)
  expect(Exit.isFailure(yield* insert(db, "browser_action", { ...action, action_id: "second" }).pipe(Effect.exit))).toBe(true)
  expect(yield* db.get(sql`SELECT COUNT(*) AS count FROM browser_control`)).toEqual({ count: 1 })
  expect(yield* db.get(sql`SELECT COUNT(*) AS count FROM browser_action`)).toEqual({ count: 1 })
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped)))

test("late browser DDL failure rolls back both tables, indexes and migration journal", () => Effect.runPromise(Effect.gen(function* () {
  const db = yield* makeDb
  yield* db.run(sql`PRAGMA foreign_keys=ON`)
  yield* DatabaseMigration.applyOnly(db, browserMigrations.slice(0, -1))
  yield* seed(db)
  const before = yield* snapshot(db)
  const successor = browserMigrations[boundary]!
  const failing = { ...successor, up: (tx: Parameters<DatabaseMigration.Migration["up"]>[0]) => successor.up(tx).pipe(Effect.andThen(tx.run("CREATE INDEX browser_control_state_idx ON browser_control(state)"))) }
  expect(Exit.isFailure(yield* DatabaseMigration.applyOnly(db, [...browserMigrations.slice(0, -1), failing]).pipe(Effect.exit))).toBe(true)
  expect(yield* snapshot(db)).toEqual(before)
  expect(yield* db.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped)))

const interactionBoundary = migrations.findIndex((item) => item.id === "20261007192454_browser_interaction_profile")
const interactionMigrations = migrations.slice(0, interactionBoundary + 1)

test("230 to 231 preserves preview history and audit guards while admitting the distinct interaction profile", async () => {
  expect(interactionBoundary).toBe(230)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-browser-interaction-migration-"))
  const filename = path.join(directory, "database.sqlite")
  const first = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql`PRAGMA foreign_keys=ON`)
    yield* DatabaseMigration.applyOnly(db, interactionMigrations.slice(0, -1))
    yield* seed(db)
    yield* insert(db, "browser_control", { ...control, state: "unknown", record: '{"original":"中文\\n","outcome":"unknown"}' })
    yield* insert(db, "browser_action", { ...action, outcome: "unknown", record: '{"original":"中文\\n","outcome":"unknown"}' })
    yield* db.run(sql`CREATE INDEX browser_control_audit_idx ON browser_control(profile,state)`)
    yield* db.run(sql`CREATE TRIGGER browser_control_audit_guard BEFORE UPDATE OF request_digest ON browser_control
      WHEN NEW.request_digest != OLD.request_digest BEGIN SELECT RAISE(ABORT,'audit identity'); END`)
    const before = yield* Effect.all({
      controls: db.all(sql`SELECT * FROM browser_control`),
      actions: db.all(sql`SELECT * FROM browser_action`),
      goals: db.all(sql`SELECT * FROM goal_control`),
      guards: db.all(sql`SELECT type,name,sql FROM sqlite_master WHERE name IN ('browser_control_audit_idx','browser_control_audit_guard') ORDER BY name`),
    })
    yield* DatabaseMigration.applyOnly(db, interactionMigrations)
    expect(yield* db.all(sql`SELECT * FROM browser_control`)).toEqual(before.controls)
    expect(yield* db.all(sql`SELECT * FROM browser_action`)).toEqual(before.actions)
    expect(yield* db.all(sql`SELECT * FROM goal_control`)).toEqual(before.goals)
    expect(yield* db.all(sql`SELECT type,name,sql FROM sqlite_master WHERE name IN ('browser_control_audit_idx','browser_control_audit_guard') ORDER BY name`)).toEqual(before.guards)
    expect(Exit.isFailure(yield* db.run(sql`UPDATE browser_control SET request_digest=${"b".repeat(64)}`).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* insert(db, "browser_control", { ...control, control_id: "new-bad", request_id: "new-bad", resource_id: "new-bad", profile: "arbitrary" }).pipe(Effect.exit))).toBe(true)
    // This raw row verifies the physical profile CHECK only; it grants no live browser authority.
    yield* insert(db, "browser_control", { ...control, control_id: "interaction", request_id: "interaction", resource_id: "interaction", profile: "managed-loopback-interaction-v1" })
    expect(yield* db.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
    expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
    expect(yield* db.all(sql`PRAGMA quick_check`)).toEqual([{ quick_check: "ok" }])
    return yield* Effect.all({ snapshot: snapshot(db), controls: db.all(sql`SELECT * FROM browser_control ORDER BY control_id`), actions: db.all(sql`SELECT * FROM browser_action`) })
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  const reopened = await Effect.runPromise(Effect.gen(function* () {
    const db = yield* makeDb
    yield* db.run(sql`PRAGMA foreign_keys=ON`)
    yield* DatabaseMigration.applyOnly(db, interactionMigrations)
    return yield* Effect.all({ snapshot: snapshot(db), controls: db.all(sql`SELECT * FROM browser_control ORDER BY control_id`), actions: db.all(sql`SELECT * FROM browser_action`) })
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  expect(reopened).toEqual(first)
  await fs.rm(directory, { recursive: true })
})

test("late interaction CHECK rebuild failure rolls back preview rows, guards and journal with foreign keys enabled", () => Effect.runPromise(Effect.gen(function* () {
  const db = yield* makeDb
  yield* db.run(sql`PRAGMA foreign_keys=ON`)
  yield* DatabaseMigration.applyOnly(db, interactionMigrations.slice(0, -1))
  yield* seed(db)
  yield* insert(db, "browser_control", control)
  yield* insert(db, "browser_action", action)
  yield* db.run(sql`CREATE TRIGGER browser_control_audit_guard BEFORE UPDATE ON browser_control BEGIN SELECT RAISE(ABORT,'audit'); END`)
  const before = yield* Effect.all({ snapshot: snapshot(db), controls: db.all(sql`SELECT * FROM browser_control`), actions: db.all(sql`SELECT * FROM browser_action`) })
  const successor = interactionMigrations[interactionBoundary]!
  const failing = { ...successor, up: (tx: Parameters<DatabaseMigration.Migration["up"]>[0]) => successor.up(tx).pipe(Effect.andThen(tx.run("CREATE INDEX browser_control_state_idx ON browser_control(state)"))) }
  expect(Exit.isFailure(yield* DatabaseMigration.applyOnly(db, [...interactionMigrations.slice(0, -1), failing]).pipe(Effect.exit))).toBe(true)
  expect(yield* Effect.all({ snapshot: snapshot(db), controls: db.all(sql`SELECT * FROM browser_control`), actions: db.all(sql`SELECT * FROM browser_action`) })).toEqual(before)
  expect(yield* db.get(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })), Effect.scoped)))
