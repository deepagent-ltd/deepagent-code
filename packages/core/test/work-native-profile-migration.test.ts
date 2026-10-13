import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/database/migration"
import migration from "../src/database/migration/20261011013000_work_native_profile_admission"
import { WorkAuthorityPolicy } from "../src/session/work-authority-policy"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Store = EffectDrizzleSqlite.EffectSQLiteDatabase
const targets = [
  { table: "work_command_intent", meter: "work_command_meter", name: "work_command_intent_binding_insert", source: "20261007201659_work_command_intent", tool: "managed_command" },
  { table: "work_write_stage", meter: "work_write_stage_meter", name: "work_write_stage_binding_insert", source: "20261007180603_work_write_stage", tool: "write" },
] as const
const profiles = [
  { id: WorkAuthorityPolicy.PROJECT_PROFILE.id, version: 1, hash: WorkAuthorityPolicy.PROJECT_PROFILE_HASH },
  { id: WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE.id, version: 1, hash: WorkAuthorityPolicy.DEEPSEEK_PROJECT_PROFILE_HASH },
  { id: WorkAuthorityPolicy.SHARED_ROOT_PROFILE.id, version: 1, hash: WorkAuthorityPolicy.SHARED_ROOT_PROFILE_HASH },
  { id: WorkAuthorityPolicy.EVENT_DAG_PROFILE.id, version: 1, hash: WorkAuthorityPolicy.EVENT_DAG_PROFILE_HASH },
]

// Storage-only oracle: execute the exact historical production trigger SQL and
// the actual forward migration on a fresh file-backed micro-schema. Supporting
// rows represent the trigger inputs, never a Native capability or runner permit.
async function historical() {
  return Promise.all(targets.map(async (target) => {
    const source = await Bun.file(new URL(`../src/database/migration/${target.source}.ts`, import.meta.url)).text()
    const ddl = source.match(new RegExp(`CREATE TRIGGER ${target.name} BEFORE INSERT[\\s\\S]*?\\nEND;`))?.[0]
    if (!ddl) throw new Error("Missing exact historical production trigger")
    return { ...target, ddl }
  }))
}

function initialize(db: Store, originals: Awaited<ReturnType<typeof historical>>) {
  return Effect.gen(function* () {
    yield* db.run("PRAGMA foreign_keys=ON")
    const tables = new Map<string, Set<string>>()
    for (const target of originals) {
      const aliases: Record<string, string> = { NEW: target.table, w: "work_execution", s: "session", a: "session_v2_tool_effect_admission", r: "session_v2_provider_turn_receipt", m: target.meter }
      for (const match of target.ddl.matchAll(/\b(NEW|w|s|a|r|m)\.([a-z_]+)/g)) {
        const table = aliases[match[1]]!
        const fields = tables.get(table) ?? new Set<string>()
        fields.add(match[2]!)
        tables.set(table, fields)
      }
    }
    tables.get("work_execution")!.add("execution_role")
    for (const [table, fields] of tables) yield* db.run(sql`CREATE TABLE ${sql.identifier(table)} (${sql.join([...fields].map(sql.identifier), sql`, `)})`)
    yield* insert(db, "work_execution", { work_id: "history", binding: "historical-unknown", execution_role: "agent" })
    for (const target of originals) {
      yield* insert(db, target.table, { work_id: "history", state: "unknown", record: "historical-opaque" })
      yield* db.run(sql.raw(target.ddl))
    }
    yield* db.run("CREATE TABLE independent_audit (id text PRIMARY KEY, value text)")
    yield* db.run("INSERT INTO independent_audit VALUES ('history','keep')")
    yield* db.run("CREATE TRIGGER independent_audit_no_delete BEFORE DELETE ON independent_audit BEGIN SELECT RAISE(ABORT,'audit retained'); END")
  })
}

function insert(db: Store, table: string, value: Record<string, string | number | null>) {
  return db.run(sql`INSERT INTO ${sql.identifier(table)} (${sql.join(Object.keys(value).map(sql.identifier), sql`, `)}) VALUES (${sql.join(Object.values(value).map((item) => sql`${item}`), sql`, `)})`)
}

function setup(db: Store, target: typeof targets[number], profile: { id: string; version: number | string; hash: string } = profiles[0]!, role = "agent") {
  return Effect.gen(function* () {
    for (const table of ["session", "session_v2_tool_effect_admission", "session_v2_provider_turn_receipt", "work_command_meter", "work_write_stage_meter"]) yield* db.run(sql`DELETE FROM ${sql.identifier(table)}`)
    yield* db.run("DELETE FROM work_execution WHERE work_id='active'")
    yield* insert(db, "work_execution", { work_id: "active", root_work_id: "active", session_id: "session", input_id: "input", binding_hash: "binding", control_revision: 1, binding_version: 2, admission_state: "ready", control_state: "active", outcome: "pending", execution_role: role,
      binding: JSON.stringify({ profile, projectScope: { helperHash: "helper" }, toolPolicy: { commandRecipes: [{ logicalID: "recipe", revision: 1, executable: { sha256: "runtime" } }], capabilities: [{ toolID: "managed_command", operations: ["run"] }] } }) })
    yield* insert(db, "session", { id: "session", execution_claim_token: "claim" })
    yield* insert(db, "session_v2_tool_effect_admission", { admission_id: "admission", session_id: "session", receipt_id: "receipt", provider_attempt_id: "attempt", tool_call_id: "call", tool_name: target.tool, effect_kind: "mutating", owner_token: "owner" })
    yield* insert(db, "session_v2_provider_turn_receipt", { receipt_id: "receipt", session_id: "session", provider_attempt_id: "attempt", activity_id: "activity", owner_token: "owner" })
    for (const item of targets) yield* insert(db, item.meter, { instance_id: "instance", custody_count: 1, audit_count: 1, retained_bytes: 1 })
  })
}

function reserve(db: Store, target: typeof targets[number]) {
  return insert(db, target.table, { work_id: "active", root_work_id: "active", session_id: "session", input_id: "input", binding_hash: "binding", control_revision: 1, admission_id: "admission", provider_receipt_id: "receipt", provider_attempt_id: "attempt", tool_call_id: "call", instance_id: "instance", state: "reserved", revision: 1, released_at: null, observed_retained_bytes: 0, reserved_bytes: 1,
    ...(target.tool === "managed_command" ? { prepared_at: null, dispatched_at: null, terminal_at: null, activity_id: "activity", owner_token: "owner", session_claim_token: "claim", helper_hash: "helper", recipe_id: "recipe", recipe_revision: 1, runtime_hash: "runtime" } : {}),
    record: JSON.stringify({ parentIdentity: null, stageIdentity: null, helperHash: "helper", sessionClaimToken: "claim", ownerToken: "owner", activityID: "activity", workspaceIdentity: null, snapshotHash: null, processIncarnation: null, processID: null, stdout: null, stderr: null, outputs: [], stopConfirmed: false }) })
}

async function fileStore(body: (db: Store) => Effect.Effect<void, unknown>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-native-profile-forward-"))
  try {
    await Effect.runPromise(Effect.gen(function* () { yield* body(yield* makeDb) }).pipe(Effect.provide(SqliteClient.layer({ filename: path.join(directory, "file.sqlite") })), Effect.scoped))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}

const snapshot = (db: Store) => Effect.gen(function* () {
  return { schema: yield* db.all<{ type: string; name: string; sql: string | null }>("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"), work: yield* db.all("SELECT * FROM work_execution"), command: yield* db.all("SELECT * FROM work_command_intent"), write: yield* db.all("SELECT * FROM work_write_stage"), audit: yield* db.all("SELECT * FROM independent_audit") }
})

test("native profile forward preserves history and admits exactly approved agents while retaining original binding/capacity guards", async () => {
  const originals = await historical()
  await fileStore((db) => Effect.gen(function* () {
    yield* initialize(db, originals)
    const before = yield* snapshot(db)
    for (const target of targets) {
      yield* setup(db, target, profiles[1])
      expect(Exit.isFailure(yield* Effect.exit(reserve(db, target)))).toBe(true)
    }
    yield* db.run("DELETE FROM work_execution WHERE work_id='active'")
    yield* DatabaseMigration.applyOnly(db, [migration])
    expect((yield* snapshot(db)).work).toEqual(before.work)
    expect((yield* snapshot(db)).command).toEqual(before.command)
    expect((yield* snapshot(db)).write).toEqual(before.write)
    expect((yield* snapshot(db)).audit).toEqual(before.audit)
    expect(yield* db.get("SELECT sql FROM sqlite_master WHERE name='independent_audit_no_delete'")).toEqual({ sql: before.schema.find((item) => item.name === "independent_audit_no_delete")!.sql })
    for (const target of targets) {
      for (const profile of profiles) {
        yield* setup(db, target, profile)
        yield* reserve(db, target)
      }
      for (const profile of [
        { id: WorkAuthorityPolicy.TEXT_ONLY_PROFILE.id, version: 1, hash: WorkAuthorityPolicy.TEXT_ONLY_PROFILE_HASH },
        { ...profiles[1]!, id: "unknown" }, { ...profiles[1]!, hash: "0".repeat(64) },
        { ...profiles[1]!, version: 2 }, { ...profiles[1]!, version: "1" },
      ]) {
        yield* setup(db, target, profile)
        expect(Exit.isFailure(yield* Effect.exit(reserve(db, target)))).toBe(true)
      }
      yield* setup(db, target, profiles[3], "controller")
      expect(Exit.isFailure(yield* Effect.exit(reserve(db, target)))).toBe(true)
      for (const guard of ["UPDATE session SET execution_claim_token='foreign'", "UPDATE session_v2_provider_turn_receipt SET owner_token='foreign'", "UPDATE session_v2_tool_effect_admission SET receipt_id='foreign'", `UPDATE ${target.meter} SET custody_count=0`, `UPDATE ${target.meter} SET retained_bytes=0`]) {
        yield* setup(db, target, profiles[1])
        yield* db.run(sql.raw(guard))
        expect(Exit.isFailure(yield* Effect.exit(reserve(db, target)))).toBe(true)
      }
    }
    const after = yield* snapshot(db)
    const journal = yield* db.all("SELECT * FROM migration ORDER BY id")
    yield* DatabaseMigration.applyOnly(db, [migration])
    expect(yield* snapshot(db)).toEqual(after)
    expect(yield* db.all("SELECT * FROM migration ORDER BY id")).toEqual(journal)
    expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
  }))
})

test("foreign original trigger and late migration failure leave all original schema and historical rows atomic", async () => {
  const originals = await historical()
  await fileStore((db) => Effect.gen(function* () {
    yield* initialize(db, originals)
    const before = yield* snapshot(db)
    const fail: DatabaseMigration.Migration = { ...migration, up: (tx) => Effect.gen(function* () { yield* migration.up(tx); return yield* tx.run("SELECT * FROM deliberate_late_forward_failure") }) }
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, [fail])))).toBe(true)
    const rolledBack = yield* snapshot(db)
    expect({ ...rolledBack, schema: rolledBack.schema.filter((item) => item.name !== "migration") }).toEqual(before)
    expect(yield* db.all("SELECT * FROM migration")).toEqual([])
    yield* db.run("DROP TRIGGER work_write_stage_binding_insert")
    yield* db.run(sql.raw(originals[1]!.ddl.replace("work_write_stage_binding_conflict", "foreign_binding_conflict")))
    const foreign = yield* snapshot(db)
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, [migration])))).toBe(true)
    expect(yield* snapshot(db)).toEqual(foreign)
    expect(yield* db.all("SELECT * FROM migration")).toEqual([])
    yield* db.run("PRAGMA foreign_keys=OFF")
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, [migration])))).toBe(true)
    expect(yield* snapshot(db)).toEqual(foreign)
  }))
})
