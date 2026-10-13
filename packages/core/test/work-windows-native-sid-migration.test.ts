import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { Effect, Exit, Schema } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "../src/database/migration"
import migration from "../src/database/migration/20261011235900_windows_native_restriction_sid"
import { CanonicalJson } from "../src/util/canonical-json"
import { WorkStorageCleanup } from "../src/session/work-storage-cleanup"
import { WorkStorageCleanupWindowsSchema } from "../src/session/work-storage-cleanup-windows.schema"
import { WorkWindowsCustodyFixture } from "./fixture/work-windows-custody"

const make = EffectDrizzleSqlite.makeWithDefaults()
const digest = WorkWindowsCustodyFixture.digest
const security = { ...WorkWindowsCustodyFixture.security, restrictionSID: "S-1-5-21-0-1-4294967295-23" }
const nativeManifest = { ...WorkWindowsCustodyFixture.manifest, security }

test("Native NT restriction SID forward preserves legacy bytes, references and audit and rejects invalid numeric families", async () => {
  const source = await Bun.file(new URL("../src/database/migration/20261011234500_windows_write_custody_v2.ts", import.meta.url)).text()
  const ddl = source.match(/CREATE TABLE \\\`__new_work_storage_cleanup\\\` \([\s\S]*?\n        \);/)?.[0]?.replaceAll("\\`", "`")
  if (!ddl) throw new Error("Original Windows write custody table is unavailable")
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-windows-native-sid-forward-"))
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const db = yield* make
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* db.run("CREATE TABLE work_execution(work_id text PRIMARY KEY)")
      yield* db.run("INSERT INTO work_execution VALUES ('work')")
      yield* db.run("CREATE TABLE session_v2_tool_effect_admission(admission_id text PRIMARY KEY)")
      yield* db.run("INSERT INTO session_v2_tool_effect_admission VALUES ('history'),('admission')")
      yield* db.run(sql.raw(ddl))
      yield* db.run("ALTER TABLE __new_work_storage_cleanup RENAME TO work_storage_cleanup")
      const insert = (value: typeof nativeManifest, admissionID: string) => db.run(sql`
        INSERT INTO work_storage_cleanup(admission_id,instance_id,work_id,kind,custody_id,manifest,manifest_hash,manifest_mac,
          phase,revision,released_bytes,created_at,updated_at)
        VALUES (${admissionID},'instance','work','command','command',${CanonicalJson.stringify({ ...value, admissionID })},
          ${WorkStorageCleanup.hash({ ...value, admissionID })},${digest},'retained',1,0,1,1)`)
      yield* insert(WorkWindowsCustodyFixture.manifest, "history")
      yield* db.run("CREATE INDEX original_sid_audit_index ON work_storage_cleanup(custody_id)")
      yield* db.run("CREATE TABLE original_sid_audit(value text)")
      yield* db.run("CREATE TRIGGER original_sid_audit AFTER INSERT ON work_storage_cleanup BEGIN INSERT INTO original_sid_audit VALUES (NEW.admission_id); END")
      yield* db.run("CREATE TABLE original_sid_reference(admission_id text REFERENCES work_storage_cleanup(admission_id) ON DELETE RESTRICT ON UPDATE RESTRICT)")
      yield* db.run("INSERT INTO original_sid_reference VALUES ('history')")
      const snapshot = Effect.gen(function* () { return { rows: yield* db.all("SELECT * FROM work_storage_cleanup"),
        objects: yield* db.all("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='work_storage_cleanup' AND type IN ('index','trigger') ORDER BY name"),
        references: yield* db.all("SELECT * FROM original_sid_reference"), keys: yield* db.all("PRAGMA foreign_key_list(work_storage_cleanup)") } })
      const before = yield* snapshot
      expect(Exit.isFailure(yield* Effect.exit(insert(nativeManifest, "admission")))).toBe(true)
      yield* DatabaseMigration.applyOnly(db, [migration])
      expect(yield* snapshot).toEqual(before)
      expect(Schema.is(WorkStorageCleanupWindowsSchema.NativeSecurity)(security)).toBe(true)
      expect(Schema.is(WorkStorageCleanupWindowsSchema.NativeSecurity)(WorkWindowsCustodyFixture.security)).toBe(false)
      expect(Schema.is(WorkStorageCleanupWindowsSchema.Security)(WorkWindowsCustodyFixture.security)).toBe(true)
      for (const restrictionSID of ["S-1-5-21-1-2-3", "S-1-5-21-1-2-3-4-5", "S-1-5-21-4294967296-1-2-3",
        "S-1-5-21-01-2-3-4", "S-1-5-21--1-2-3-4", "S-1-5-21-1e0-2-3-4", "S-1-5-21- 1-2-3-4",
        "S-1-5-22-1-2-3-4", "S-1-5-21-1.0-2-3-4", "S-1-5-21-1-2-3-4 "]) {
        const invalid = { ...nativeManifest, security: { ...security, restrictionSID } }
        expect(Schema.is(WorkStorageCleanupWindowsSchema.Security)(invalid.security)).toBe(false)
        expect(Exit.isFailure(yield* Effect.exit(insert(invalid, "admission")))).toBe(true)
      }
      yield* insert(nativeManifest, "admission")
      expect(yield* db.all("SELECT * FROM original_sid_audit")).toEqual([{ value: "admission" }])
      const manifestHash = WorkStorageCleanup.hash(nativeManifest)
      const journal = { ...WorkWindowsCustodyFixture.journal, security, manifestHash }
      yield* db.run(sql`UPDATE work_storage_cleanup SET phase='cleanup_pending',journal=${CanonicalJson.stringify(journal)},
        journal_hash=${WorkStorageCleanup.hash(journal)},journal_mac=${digest},cleanup_id='cleanup',request_hash=${digest} WHERE admission_id='admission'`)
      const proof = Schema.decodeUnknownSync(WorkStorageCleanupWindowsSchema.Proof)({
        ...WorkWindowsCustodyFixture.proof, security, manifestHash, planHash: WorkStorageCleanup.hash(journal),
      })
      const updateProof = (value: unknown) => db.run(sql`UPDATE work_storage_cleanup SET phase='cleanup_verified',
        proof=${CanonicalJson.stringify(value)},proof_hash=${WorkStorageCleanup.hash(value)},proof_mac=${digest} WHERE admission_id='admission'`)
      expect(Exit.isFailure(yield* Effect.exit(updateProof({ ...proof, security: WorkWindowsCustodyFixture.security })))).toBe(true)
      yield* updateProof(proof)
      expect((yield* WorkStorageCleanup.read(db, "admission"))?.proof).toEqual(proof)
      expect(Exit.isFailure(yield* Effect.exit(db.run("DELETE FROM work_storage_cleanup WHERE admission_id='history'")))).toBe(true)
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      expect(yield* db.all("PRAGMA quick_check")).toEqual([{ quick_check: "ok" }])
      expect(yield* db.get("PRAGMA defer_foreign_keys")).toEqual({ defer_foreign_keys: 0 })
    }).pipe(Effect.provide(SqliteClient.layer({ filename: path.join(directory, "actual.sqlite") })), Effect.scoped))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
