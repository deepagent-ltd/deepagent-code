import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/database/migration"
import migration from "../src/database/migration/20261011234500_windows_write_custody_v2"
import { WorkStorageCleanupWindowsWriteSchema } from "../src/session/work-storage-cleanup-windows-write.schema"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
type Store = EffectDrizzleSqlite.EffectSQLiteDatabase
const digest = "a".repeat(64)
const identity = { kind: "windows" as const, volumeSerial: "0".repeat(16), fileID: "1".repeat(32) }
const base = { admissionID: "admission", instanceID: "instance", workID: "work", rootWorkID: "work", sessionID: "session",
  inputID: "input", activityID: "activity", providerReceiptID: "receipt", providerAttemptID: "attempt", toolCallID: "call",
  ownerToken: "owner", sessionClaimToken: 1, bindingHash: digest, controlRevision: 1, custodyID: "stage", sourceRequestHash: digest,
  helperHash: digest, snapshotHash: null, basename: "1".repeat(32), createdAt: 1 }
const manifest = { ...base, version: 2, target: "win32-x64", purpose: "work_write", kind: "write", captureKind: "native_live",
  stagePhase: "prepared_payload",
  project: "C:\\project", projectIdentity: identity, data: "C:\\data", dataIdentity: identity, baseIdentity: identity,
  containerIdentity: identity, files: [{ relative: "payload", identity: { ...identity, fileID: "2".repeat(32) }, sha256: digest,
    bytes: 4, retainedUnlinked: false }], directories: [{ relative: "", identity }] }

function row(value: unknown, admissionID: string) {
  return { admission_id: admissionID, instance_id: "instance", work_id: "work", kind: "write", custody_id: "stage",
    manifest: JSON.stringify(value), manifest_hash: digest, manifest_mac: digest, phase: "retained", revision: 1,
    journal: null, journal_hash: null, journal_mac: null, cleanup_id: null, request_hash: null, proof: null, proof_hash: null,
    proof_mac: null, released_bytes: 0, created_at: 1, updated_at: 1 }
}
function insert(db: Store, input: ReturnType<typeof row>) {
  return db.run(sql`INSERT INTO work_storage_cleanup (${sql.join(Object.keys(input).map(sql.identifier), sql`, `)})
    VALUES (${sql.join(Object.values(input).map((value) => sql`${value}`), sql`, `)})`)
}
async function fileStore(body: (db: Store, ddl: string) => Effect.Effect<void, unknown>) {
  const source = await Bun.file(new URL("../src/database/migration/20261009040718_windows_command_custody_v2.ts", import.meta.url)).text()
  const ddl = source.match(/CREATE TABLE \\\`__new_work_storage_cleanup\\\` \([\s\S]*?\n        \);/)?.[0]?.replaceAll("\\`", "`")
  if (!ddl) throw new Error("Original Windows command custody table is unavailable")
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-windows-write-forward-"))
  try {
    await Effect.runPromise(Effect.gen(function* () { yield* body(yield* makeDb, ddl) })
      .pipe(Effect.provide(SqliteClient.layer({ filename: path.join(directory, "actual.sqlite") })), Effect.scoped))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}
function initialize(db: Store, ddl: string) {
  return Effect.gen(function* () {
    yield* db.run("PRAGMA foreign_keys=ON")
    yield* db.run("CREATE TABLE work_execution(work_id text PRIMARY KEY)")
    yield* db.run("INSERT INTO work_execution VALUES ('work')")
    yield* db.run("CREATE TABLE session_v2_tool_effect_admission(admission_id text PRIMARY KEY)")
    for (const admissionID of ["history", "admission", "empty", ...Array.from({ length: 12 }, (_value, index) => `bad${index}`)])
      yield* db.run(sql`INSERT INTO session_v2_tool_effect_admission VALUES (${admissionID})`)
    yield* db.run(sql.raw(ddl))
    yield* db.run("ALTER TABLE __new_work_storage_cleanup RENAME TO work_storage_cleanup")
    const posix = { kind: "posix", device: "1", inode: "2" }
    yield* insert(db, row({ ...base, admissionID: "history", version: 1, kind: "write", captureKind: "native_live",
      project: "/project", projectIdentity: posix, data: "/data", dataIdentity: posix, baseIdentity: posix,
      containerIdentity: posix, files: [], directories: [{ relative: "", identity: posix }] }, "history"))
    yield* db.run("CREATE INDEX original_storage_audit_idx ON work_storage_cleanup(custody_id)")
    yield* db.run("CREATE TABLE audit(value text)")
    yield* db.run("CREATE TRIGGER original_storage_audit AFTER INSERT ON work_storage_cleanup BEGIN INSERT INTO audit VALUES (NEW.admission_id); END")
    yield* db.run("CREATE TABLE kept_reference(admission_id text REFERENCES work_storage_cleanup(admission_id) ON DELETE RESTRICT ON UPDATE RESTRICT)")
    yield* db.run("INSERT INTO kept_reference VALUES ('history')")
  })
}
const snapshot = (db: Store) => Effect.gen(function* () {
  return { rows: yield* db.all("SELECT * FROM work_storage_cleanup ORDER BY admission_id"),
    objects: yield* db.all("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='work_storage_cleanup' AND type IN ('index','trigger') ORDER BY name"),
    references: yield* db.all("SELECT * FROM kept_reference"), foreignKeys: yield* db.all("PRAGMA foreign_key_list(work_storage_cleanup)") }
})

test("Windows write forward preserves actual history/audit/FKs and admits only its distinct stage purpose", async () => {
  await fileStore((db, ddl) => Effect.gen(function* () {
    yield* initialize(db, ddl)
    const before = yield* snapshot(db)
    expect(Exit.isFailure(yield* Effect.exit(insert(db, row(manifest, "admission"))))).toBe(true)
    yield* DatabaseMigration.applyOnly(db, [migration])
    expect(yield* snapshot(db)).toEqual(before)
    expect(yield* db.all("SELECT * FROM audit")).toEqual([])
    expect(Schema.is(WorkStorageCleanupWindowsWriteSchema.Manifest)(manifest)).toBe(true)
    yield* insert(db, row(manifest, "admission"))
    expect(yield* db.all("SELECT * FROM audit")).toEqual([{ value: "admission" }])
    const empty = { ...manifest, admissionID: "empty", stagePhase: "refused_empty", files: [] }
    expect(Schema.is(WorkStorageCleanupWindowsWriteSchema.Manifest)(empty)).toBe(true)
    yield* insert(db, row(empty, "empty"))
    const bad = [
      { ...manifest, purpose: "settings" }, { ...manifest, security: {} }, { ...manifest, snapshotHash: digest },
      { ...manifest, basename: "cmd_" + "1".repeat(32) }, { ...manifest, files: [] },
      { ...manifest, files: [{ ...manifest.files[0], retainedUnlinked: true }] },
      { ...manifest, files: [{ ...manifest.files[0], bytes: 51_201 }] },
      { ...manifest, files: [{ ...manifest.files[0], identity: { ...identity, volumeSerial: "f".repeat(16) } }] },
      { ...manifest, directories: [{ relative: "", identity: { ...identity, fileID: "f".repeat(32) } }] },
      { ...manifest, stagePhase: "refused_empty" }, { ...manifest, stagePhase: "unknown", files: [] },
    ]
    for (const [index, input] of bad.entries()) {
      expect(Option.isNone(Schema.decodeUnknownOption(WorkStorageCleanupWindowsWriteSchema.Manifest,
        { onExcessProperty: "error" })(input))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(insert(db, row({ ...input, admissionID: `bad${index}` }, `bad${index}`))))).toBe(true)
    }
    expect(Exit.isFailure(yield* Effect.exit(db.run("DELETE FROM work_storage_cleanup WHERE admission_id='history'")))).toBe(true)
    expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
    const after = yield* snapshot(db)
    yield* DatabaseMigration.applyOnly(db, [migration])
    expect(yield* snapshot(db)).toEqual(after)
    expect(yield* db.all("SELECT * FROM migration")).toHaveLength(1)
  }))
})

test("Windows write forward late failure rolls the real table/data/audit objects back atomically", async () => {
  await fileStore((db, ddl) => Effect.gen(function* () {
    yield* initialize(db, ddl)
    const before = yield* snapshot(db)
    const failed: DatabaseMigration.Migration = { ...migration, up: (tx) => Effect.gen(function* () {
      yield* migration.up(tx)
      return yield* tx.run("SELECT * FROM deliberate_windows_write_forward_failure")
    }) }
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, [failed])))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
    expect(yield* db.all("SELECT * FROM migration")).toEqual([])
    yield* db.run("PRAGMA foreign_keys=OFF")
    expect(Exit.isFailure(yield* Effect.exit(DatabaseMigration.applyOnly(db, [migration])))).toBe(true)
    expect(yield* snapshot(db)).toEqual(before)
  }))
})
