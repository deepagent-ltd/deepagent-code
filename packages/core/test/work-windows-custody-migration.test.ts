import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { sql } from "drizzle-orm"
import { Effect, Exit, Schema } from "effect"
import { DatabaseMigration } from "../src/database/migration"
import current from "../src/database/migration/20261009040718_windows_command_custody_v2"
import { WorkStorageCleanup } from "../src/session/work-storage-cleanup"
import { WorkStorageCleanupSchema } from "../src/session/work-storage-cleanup.schema"
import { WorkStorageCleanupWindowsSchema } from "../src/session/work-storage-cleanup-windows.schema"
import { WorkCommand } from "../src/session/work-command"
import { WorkCommandSchema } from "../src/session/work-command.schema"
import { WorkCommandWindowsSchema } from "../src/session/work-command-windows.schema"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"
import { WorkWindowsCustodyFixture } from "./fixture/work-windows-custody"

const make = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof make>
const digest = WorkWindowsCustodyFixture.digest
const posix = { kind: "posix", device: "1", inode: "2" }
const legacyCommand = Schema.decodeUnknownSync(WorkCommandSchema.Record)({
  version: 1, commandID: "command", admissionID: "admission", instanceID: "instance", workID: "work", rootWorkID: "work",
  sessionID: "session", inputID: "input", activityID: "activity", providerReceiptID: "receipt", providerAttemptID: "attempt",
  toolCallID: "call", ownerToken: "owner", sessionClaimToken: 1, bindingHash: digest, controlRevision: 1,
  recipeID: "recipe", recipeRevision: 1, recipeHash: digest, requestHash: digest, helperHash: digest, runtimeHash: digest,
  workspaceBasename: `cmd_${"b".repeat(32)}`, workspaceIdentity: null, snapshotHash: null, state: "settled",
  outcome: "refused_before_dispatch", processIncarnation: null, processID: null, exitCode: null, signal: null,
  stopConfirmed: true, stdout: null, stderr: null, outputs: [], createdAt: 1, preparedAt: null, dispatchedAt: null,
  terminalAt: 2, updatedAt: 2, releasedAt: null, deadline: 10, revision: 2,
  reservedBytes: WorkCommandSchema.RESERVATION_BYTES, observedRetainedBytes: 0,
})
const legacyManifest = Schema.decodeUnknownSync(WorkStorageCleanupSchema.Manifest, { onExcessProperty: "ignore" })({
  ...WorkWindowsCustodyFixture.manifest, version: 1, project: "/private/project", data: "/private/data",
  projectIdentity: posix, dataIdentity: posix, baseIdentity: posix, containerIdentity: posix,
  files: WorkWindowsCustodyFixture.manifest.files.map((item) => ({ ...item, identity: posix })),
  directories: WorkWindowsCustodyFixture.manifest.directories.map((item) => ({ ...item, identity: posix })),
})

test("Windows custody forward preserves v1 bytes, audit objects and restrictive references with atomic rollback", async () => {
  const directory = await fs.mkdtemp("/tmp/dac-windows-custody-forward-")
  const filename = `${directory}/database.sqlite`
  try {
    const saved = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* make
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* db.run("CREATE TABLE session_v2_tool_effect_admission(admission_id TEXT PRIMARY KEY)")
      yield* db.run("CREATE TABLE work_execution(work_id TEXT PRIMARY KEY)")
      for (const name of ["20261007201659_work_command_intent", "20261008210106_work_storage_cleanup"]) {
        const source = yield* Effect.promise(() => Bun.file(new URL(`../migration/${name}/migration.sql`, import.meta.url)).text())
        const statements = source.split("--> statement-breakpoint").map((statement) => statement.trim()).filter((statement) =>
          /^CREATE TABLE `work_(?:command_intent|command_meter|storage_cleanup)`/.test(statement) ||
          /^CREATE (?:UNIQUE )?INDEX .* ON `work_(?:command_intent|command_meter|storage_cleanup)`/.test(statement))
        yield* Effect.forEach(statements, (statement) => db.run(statement), { discard: true })
      }
      yield* db.run("INSERT INTO session_v2_tool_effect_admission VALUES ('admission'),('admission-win')")
      yield* db.run("INSERT INTO work_execution VALUES ('work')")
      yield* db.run(sql`INSERT INTO work_command_meter VALUES ('instance',1,${WorkCommandSchema.RESERVATION_BYTES},1,1,1)`)
      yield* command(db, legacyCommand)
      yield* manifest(db, legacyManifest)
      yield* db.run("CREATE TABLE command_audit_reference(id TEXT PRIMARY KEY, command_id TEXT REFERENCES work_command_intent(command_id) ON DELETE RESTRICT ON UPDATE RESTRICT)")
      yield* db.run("INSERT INTO command_audit_reference VALUES ('audit','command')")
      yield* db.run("CREATE TABLE cleanup_audit_reference(id TEXT PRIMARY KEY, admission_id TEXT REFERENCES work_storage_cleanup(admission_id))")
      yield* db.run("INSERT INTO cleanup_audit_reference VALUES ('audit','admission')")
      yield* db.run("CREATE INDEX command_private_audit_idx ON work_command_intent(record_hash)")
      yield* db.run("CREATE TRIGGER command_private_no_delete BEFORE DELETE ON work_command_intent BEGIN SELECT RAISE(ABORT,'audit retained'); END")
      yield* db.run("CREATE TRIGGER cleanup_private_no_delete BEFORE DELETE ON work_storage_cleanup BEGIN SELECT RAISE(ABORT,'audit retained'); END")
      const before = yield* snapshot(db)
      const oldHash = WorkCommand.resultHash(legacyCommand)
      expect(yield* WorkCommand.get(db, "admission")).toEqual(legacyCommand)
      expect((yield* WorkStorageCleanup.read(db, "admission"))?.manifest).toEqual(legacyManifest)
      const failed = yield* DatabaseMigration.applyOnly(db, [{ ...current,
        up: (tx) => current.up(tx).pipe(Effect.andThen(tx.run("SELECT * FROM nonexistent_late_windows_forward"))),
      }]).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBeTrue()
      expect(yield* snapshot(db)).toEqual(before)
      expect(yield* db.all("SELECT * FROM migration")).toEqual([])
      yield* DatabaseMigration.applyOnly(db, [current])
      expect(yield* snapshot(db)).toEqual(before)
      const old = yield* WorkCommand.get(db, "admission")
      if (!old) throw new Error("Legacy command disappeared")
      expect(WorkCommand.resultHash(old)).toBe(oldHash)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect(yield* db.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1 })
      expect(yield* db.get("PRAGMA defer_foreign_keys")).toEqual({ defer_foreign_keys: 0 })
      // SQL-only records test storage/version boundaries; they are not native
      // permits, execution outcomes, ACL leases or cleanup authentication.
      const windows = Schema.decodeUnknownSync(WorkCommandWindowsSchema.Record)({ ...legacyCommand,
        version: 2, target: "win32-x64", commandID: "command-win", admissionID: "admission-win" })
      yield* command(db, windows)
      yield* db.run(sql`UPDATE work_command_meter SET custody_count=2,audit_count=2,retained_bytes=${2 * WorkCommandSchema.RESERVATION_BYTES},revision=2,updated_at=2`)
      expect(yield* WorkCommand.get(db, "admission-win")).toEqual(windows)
      yield* manifest(db, { ...WorkWindowsCustodyFixture.manifest, admissionID: "admission-win", custodyID: "command-win" })
      const row = yield* WorkStorageCleanup.read(db, "admission-win")
      if (!row) throw new Error("Windows manifest disappeared")
      expect(row.manifest.version).toBe(2)
      for (const invalid of [
        { ...windows, target: "linux-x64" }, { ...windows, target: undefined },
        { ...windows, workspaceIdentity: posix }, { ...windows, workspaceIdentity: {} },
        { ...windows, outputs: [{ identity: posix }] }, { ...windows, outputs: [{ identity: {} }] },
      ]) expect(Exit.isFailure(yield* db.run(sql`UPDATE work_command_intent SET record=${CanonicalJson.stringify(invalid)} WHERE command_id='command-win'`).pipe(Effect.exit))).toBeTrue()
      const journal = Schema.decodeUnknownSync(WorkStorageCleanupWindowsSchema.Journal)({ ...WorkWindowsCustodyFixture.journal,
        request: { ...WorkWindowsCustodyFixture.journal.request, admissionID: "admission-win" }, manifestHash: row.manifest_hash })
      const update = (value: unknown) => db.run(sql`UPDATE work_storage_cleanup SET phase='cleanup_pending',journal=${CanonicalJson.stringify(value)},
        journal_hash=${WorkStorageCleanup.hash(value)},journal_mac=${digest},cleanup_id='cleanup',request_hash=${digest} WHERE admission_id='admission-win'`)
      for (const invalid of [{ ...journal, version: 1 }, { ...journal, target: "win32-arm64" },
        { ...journal, security: { ...journal.security, leaseSetHash: "b".repeat(64) } }, { ...journal, security: null }])
        expect(Exit.isFailure(yield* update(invalid).pipe(Effect.exit))).toBeTrue()
      yield* update(journal)
      expect((yield* WorkStorageCleanup.read(db, "admission-win"))?.journal).toEqual(journal)
      const proof = Schema.decodeUnknownSync(WorkStorageCleanupWindowsSchema.Proof)({ ...WorkWindowsCustodyFixture.proof,
        manifestHash: row.manifest_hash, planHash: WorkStorageCleanup.hash(journal) })
      const verifyShape = (value: unknown) => db.run(sql`UPDATE work_storage_cleanup SET phase='cleanup_verified',proof=${CanonicalJson.stringify(value)},
        proof_hash=${WorkStorageCleanup.hash(value)},proof_mac=${digest} WHERE admission_id='admission-win'`)
      for (const invalid of [{ ...proof, version: 1 }, { ...proof, target: "win32-arm64" }, { ...proof, jobRetired: false },
        { ...proof, appContainerRetired: false }, { ...proof, aclRestored: false }, { ...proof, aclRestoreHash: null },
        { ...proof, dataIdentity: posix }, { ...proof, security: { ...proof.security, leaseSetHash: "b".repeat(64) } }])
        expect(Exit.isFailure(yield* verifyShape(invalid).pipe(Effect.exit))).toBeTrue()
      yield* verifyShape(proof)
      expect((yield* WorkStorageCleanup.read(db, "admission-win"))?.proof).toEqual(proof)
      const beforeCleanup = yield* snapshot(db)
      expect(Exit.isFailure(yield* WorkStorageCleanup.cleanup(db, journal.request).pipe(Effect.exit))).toBeTrue()
      expect(yield* snapshot(db)).toEqual(beforeCleanup)
      expect(yield* db.get("SELECT custody_count,retained_bytes FROM work_command_meter")).toEqual({ custody_count: 2, retained_bytes: 2 * WorkCommandSchema.RESERVATION_BYTES })
      expect(Exit.isFailure(yield* db.run("DELETE FROM work_command_intent WHERE command_id='command'").pipe(Effect.exit))).toBeTrue()
      expect(Exit.isFailure(yield* db.run("DELETE FROM work_storage_cleanup WHERE admission_id='admission'").pipe(Effect.exit))).toBeTrue()
      return yield* snapshot(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    await Effect.runPromise(Effect.gen(function* () {
      const db = yield* make
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, [current])
      expect(yield* snapshot(db)).toEqual(saved)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect(yield* db.all("PRAGMA quick_check")).toEqual([{ quick_check: "ok" }])
      expect((yield* WorkCommand.get(db, "admission-win"))?.version).toBe(2)
      expect((yield* WorkStorageCleanup.read(db, "admission-win"))?.journal?.version).toBe(2)
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

function command(db: Db, record: unknown) {
  return Effect.gen(function* () {
    const columns = yield* db.all<{ name: string }>("PRAGMA table_info(work_command_intent)")
    const bytes = CanonicalJson.stringify(record)
    const values = columns.map((column) => column.name === "record" ? bytes : column.name === "record_hash" ? Hash.sha256(bytes)
      : Reflect.get(Object(record), column.name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()).replace(/Id$/, "ID")))
    yield* db.run(sql`INSERT INTO work_command_intent (${sql.join(columns.map((column) => sql.identifier(column.name)), sql`,`)}) VALUES (${sql.join(values.map((value: unknown) => sql`${value}`), sql`,`)})`)
  })
}
function manifest(db: Db, value: unknown) {
  const row = Schema.decodeUnknownSync(Schema.Struct({ admissionID: Schema.String, instanceID: Schema.String, workID: Schema.String,
    kind: Schema.String, custodyID: Schema.String, createdAt: Schema.Number }))(value)
  return db.run(sql`INSERT INTO work_storage_cleanup (admission_id,instance_id,work_id,kind,custody_id,manifest,manifest_hash,manifest_mac,phase,revision,released_bytes,created_at,updated_at)
    VALUES (${row.admissionID},${row.instanceID},${row.workID},${row.kind},${row.custodyID},${CanonicalJson.stringify(value)},${WorkStorageCleanup.hash(value)},${digest},'retained',1,0,${row.createdAt},${row.createdAt})`)
}
function snapshot(db: Db) {
  return Effect.gen(function* () {
    return { command: yield* db.all("SELECT * FROM work_command_intent ORDER BY command_id"), meter: yield* db.all("SELECT * FROM work_command_meter"),
      cleanup: yield* db.all("SELECT * FROM work_storage_cleanup ORDER BY admission_id"), reference: yield* db.all("SELECT * FROM command_audit_reference"),
      cleanupReference: yield* db.all("SELECT * FROM cleanup_audit_reference"),
      audit: yield* db.all("SELECT name,sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name IN ('work_command_intent','work_storage_cleanup') ORDER BY type,name") }
  })
}
