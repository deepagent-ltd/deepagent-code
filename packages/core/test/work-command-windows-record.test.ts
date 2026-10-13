import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Exit, Option, Schema } from "effect"
import { WorkCommand } from "../src/session/work-command"
import { WorkCommandSchema } from "../src/session/work-command.schema"
import { WorkCommandWindowsSchema } from "../src/session/work-command-windows.schema"
import { WorkCommandIntentTable, WorkCommandMeterTable } from "../src/session/work-command.sql"
import { V2ToolEffectAdmissionTable } from "../src/session/runner/v2-tool-effect.sql"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"
import { CanonicalJson } from "../src/util/canonical-json"
import { Hash } from "../src/util/hash"
import { eq } from "drizzle-orm"

const identity = Schema.decodeUnknownSync(WorkCommandWindowsSchema.Identity)({ kind: "windows", volumeSerial: "a".repeat(16), fileID: "b".repeat(32) })
const reserved = { version: 2, target: "win32-x64", commandID: "command", admissionID: "admission",
  instanceID: "instance", workID: "work", rootWorkID: "work", sessionID: "session", inputID: "input", activityID: "activity",
  providerReceiptID: "receipt", providerAttemptID: "attempt", toolCallID: "call", ownerToken: "owner",
  sessionClaimToken: 1, bindingHash: "1".repeat(64), controlRevision: 1,
  recipeID: "recipe", recipeRevision: 1, recipeHash: "2".repeat(64), requestHash: "3".repeat(64),
  helperHash: "4".repeat(64), runtimeHash: "5".repeat(64), workspaceBasename: `cmd_${"6".repeat(32)}`,
  workspaceIdentity: null, snapshotHash: null, state: "reserved", outcome: null,
  processIncarnation: null, processID: null, exitCode: null, signal: null, stopConfirmed: false,
  stdout: null, stderr: null, outputs: [], createdAt: 10, preparedAt: null, dispatchedAt: null,
  terminalAt: null, updatedAt: 10, releasedAt: null, deadline: 1000, revision: 1,
  reservedBytes: WorkCommandSchema.RESERVATION_BYTES, observedRetainedBytes: 0 }
const output = { relative: "out/result.txt", identity, sha256: "7".repeat(64), bytes: 8 }

test("independent Windows codec preserves its target and rejects POSIX/caller fields and Windows path aliases", () => {
  for (const target of ["win32-x64", "win32-arm64"]) {
    const value = { ...reserved, target, workspaceIdentity: identity, outputs: [output] }
    const decoded = WorkCommandWindowsSchema.decodeRecord(value)
    expect(Option.isSome(decoded)).toBeTrue()
    if (Option.isNone(decoded)) throw new Error("Windows factual codec missing")
    expect(CanonicalJson.stringify(decoded.value)).toBe(CanonicalJson.stringify(value))
    expect(Schema.is(WorkCommandSchema.Record)(decoded.value)).toBeFalse()
  }
  for (const value of [
    { ...reserved, target: "linux-x64" }, { ...reserved, version: 1 }, { ...reserved, target: undefined },
    { ...reserved, workspaceIdentity: { kind: "posix", device: "1", inode: "2" } },
    { ...reserved, workspaceIdentity: { ...identity, volumeSerial: "A".repeat(16) } },
    { ...reserved, outputs: [{ ...output, identity: { ...identity, fileID: "b".repeat(31) } }] },
    { ...reserved, outputs: [{ ...output, identity: { kind: "posix", device: "1", inode: "2" } }] },
    { ...reserved, outputs: [output, { ...output, relative: "OUT/RESULT.TXT" }] },
    { ...reserved, outputs: [output, { ...output, relative: "out" }] },
    ...["CON.txt", "LPT¹", "name.", "name ", "x:stream", "C:/abs", "..", "foo\\bar", "\ud800"].map((relative) =>
      ({ ...reserved, outputs: [{ ...output, relative }] })),
    { ...reserved, outputs: Array.from({ length: 33 }, (_, index) => ({ ...output, relative: `${index}.txt` })) },
    { ...reserved, processHandle: "copied" },
  ]) expect(Option.isNone(WorkCommandWindowsSchema.decodeRecord(value))).toBeTrue()
})

test("Windows result hash binds target/identity and is stable across custody retirement", () => {
  const record = Schema.decodeUnknownSync(WorkCommandWindowsSchema.Record, { onExcessProperty: "error" })({
    ...reserved, workspaceIdentity: identity, outputs: [output] })
  const hash = WorkCommand.resultHash(record)
  expect(WorkCommand.resultHash({ ...record, target: "win32-arm64" })).not.toBe(hash)
  expect(WorkCommand.resultHash({ ...record, rootWorkID: "other-root" })).not.toBe(hash)
  expect(WorkCommand.resultHash({ ...record, controlRevision: 2 })).not.toBe(hash)
  expect(WorkCommand.resultHash({ ...record, workspaceIdentity: { ...record.workspaceIdentity!, fileID: "c".repeat(32) } })).not.toBe(hash)
  expect(WorkCommand.resultHash({ ...record, outputs: [{ ...record.outputs[0]!, identity: { ...identity, fileID: "d".repeat(32) } }] })).not.toBe(hash)
  expect(WorkCommand.resultHash({ ...record, releasedAt: 80, updatedAt: 80, revision: 4,
    reservedBytes: 0, observedRetainedBytes: 0 })).toBe(hash)
})

const source = process.env.DAC_WORK_COMMAND_DB
const golden = process.env.DAC_WORK_COMMAND_RESULT_HASH
test.skipIf(!source || !golden)("actual v1 fileDB cold observation preserves bytes/hash/custody and missing Windows factory reserves nothing", async () => {
  if (!source || !golden) throw new Error("Actual private Native source and predecessor result hash required")
  const root = process.env.DAC_WORK_WINDOWS_RECORD_CASE ?? await fs.mkdtemp(path.join(os.tmpdir(), "dac-windows-record-v1-"))
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("dac-windows-record-v1-"))
    throw new Error("Only this module's private temp case may be reused")
  const filename = path.join(root, "database.sqlite")
  if (!process.env.DAC_WORK_WINDOWS_RECORD_CASE) {
    const original = new Database(source, { readonly: true })
    await fs.writeFile(filename, original.serialize())
    original.close()
  }
  const observe = () => Effect.runPromise(Effect.gen(function* () {
    const db = yield* EffectDrizzleSqlite.makeWithDefaults()
    yield* db.run("PRAGMA foreign_keys=ON")
    const rows = yield* db.all<{ admission_id: string; record: string; record_hash: string }>("SELECT admission_id,record,record_hash FROM work_command_intent")
    expect(rows).toHaveLength(1)
    const meter = yield* db.all("SELECT * FROM work_command_meter")
    const inputs = yield* db.get("SELECT count(*) n FROM session_input")
    const providers = yield* db.get("SELECT count(*) n FROM session_v2_provider_turn_receipt")
    const record = yield* WorkCommand.get(db, rows[0]!.admission_id)
    if (!record || record.version !== 1) throw new Error("Original POSIX factual record missing")
    expect(CanonicalJson.stringify(record)).toBe(rows[0]!.record)
    expect(WorkCommand.resultHash(record)).toBe(golden)
    expect((yield* WorkCommand.custody(db, record.instanceID)).map((item) => item.version)).toEqual([1])
    for (const operation of [WorkCommand.beginDispatch(db, record, "replacement"), WorkCommand.started(db, record, 2),
      WorkCommand.unknown(db, record)])
      expect(Exit.isFailure(yield* operation.pipe(Effect.exit))).toBeTrue()
    expect(Exit.isFailure(yield* WorkCommand.reserveWindows(db, record).pipe(Effect.exit))).toBeTrue()
    expect(yield* db.all("SELECT admission_id,record,record_hash FROM work_command_intent")).toEqual(rows)
    expect(yield* db.all("SELECT * FROM work_command_meter")).toEqual(meter)
    expect(yield* db.get("SELECT count(*) n FROM session_input")).toEqual(inputs)
    expect(yield* db.get("SELECT count(*) n FROM session_v2_provider_turn_receipt")).toEqual(providers)
    expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
    return { rows, meter }
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
  const first = await observe()
  expect(await observe()).toEqual(first)
  if (process.env.DAC_WORK_WINDOWS_RECORD_STORE === "1") {
    // The full production trigger rejects copied settled Work. These are
    // untrusted SQL facts, never native execution/Source/Approval evidence.
    const saved = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys=ON")
      yield* DatabaseMigration.applyOnly(db, migrations)
      const row = yield* db.select().from(WorkCommandIntentTable).get()
      if (!row) throw new Error("Actual v1 predecessor missing")
      expect(row.record).toBe(first.rows[0]!.record)
      expect(row.record_hash).toBe(first.rows[0]!.record_hash)
      const old = yield* WorkCommand.get(db, row.admission_id)
      if (!old || old.version !== 1) throw new Error("Original v1 record changed")
      const now = Date.now()
      const record = Schema.decodeUnknownSync(WorkCommandWindowsSchema.Record, { onExcessProperty: "error" })({
        ...old, version: 2, target: "win32-x64", commandID: "windows-record-command", admissionID: "windows-record-admission",
        toolCallID: "windows-record-call", workspaceBasename: `cmd_${"f".repeat(32)}`,
        workspaceIdentity: null, snapshotHash: null, state: "reserved", outcome: null, processIncarnation: null,
        processID: null, exitCode: null, signal: null, stopConfirmed: false, stdout: null, stderr: null, outputs: [],
        createdAt: now, updatedAt: now, preparedAt: null, dispatchedAt: null, terminalAt: null, releasedAt: null,
        deadline: now + 60_000, revision: 1, reservedBytes: WorkCommandSchema.RESERVATION_BYTES, observedRetainedBytes: 0,
      })
      const meter = yield* db.select().from(WorkCommandMeterTable)
      const admissions = yield* db.get("SELECT count(*) n FROM session_v2_tool_effect_admission")
      const providers = yield* db.get("SELECT count(*) n FROM session_v2_provider_turn_receipt")
      const inputs = yield* db.get("SELECT count(*) n FROM session_input")
      const rejected = yield* db.transaction((tx) => Effect.gen(function* () {
        yield* tx.insert(V2ToolEffectAdmissionTable).values({ admission_id: record.admissionID, session_id: record.sessionID,
          provider_attempt_id: record.providerAttemptID, receipt_id: record.providerReceiptID, tool_call_id: record.toolCallID,
          tool_name: "managed_command", effect_kind: "mutating", owner_token: record.ownerToken, time_created: now })
        const original = yield* tx.select().from(WorkCommandMeterTable).where(eq(WorkCommandMeterTable.instance_id, record.instanceID)).get()
        if (!original) throw new Error("Original command meter missing")
        yield* tx.update(WorkCommandMeterTable).set({ custody_count: original.custody_count + 1,
          audit_count: original.audit_count + 1, retained_bytes: original.retained_bytes + record.reservedBytes,
          revision: original.revision + 1, updated_at: now }).where(eq(WorkCommandMeterTable.instance_id, record.instanceID))
        const text = CanonicalJson.stringify(record)
        yield* tx.insert(WorkCommandIntentTable).values({ ...row, command_id: record.commandID, admission_id: record.admissionID,
          tool_call_id: record.toolCallID, workspace_basename: record.workspaceBasename, state: "reserved", outcome: null,
          revision: 1, reserved_bytes: record.reservedBytes, observed_retained_bytes: 0, record: text, record_hash: Hash.sha256(text),
          created_at: now, updated_at: now, prepared_at: null, dispatched_at: null, terminal_at: null, released_at: null, deadline: record.deadline })
      }), { behavior: "immediate" }).pipe(Effect.exit)
      expect(Exit.isFailure(rejected)).toBeTrue()
      expect(yield* db.select().from(WorkCommandMeterTable)).toEqual(meter)
      expect(yield* db.select().from(WorkCommandIntentTable)).toEqual([row])
      expect(yield* db.get("SELECT count(*) n FROM session_v2_tool_effect_admission")).toEqual(admissions)
      expect(yield* db.get("SELECT count(*) n FROM session_v2_provider_turn_receipt")).toEqual(providers)
      expect(yield* db.get("SELECT count(*) n FROM session_input")).toEqual(inputs)
      expect(Exit.isFailure(yield* WorkCommand.reserveWindows(db, record).pipe(Effect.exit))).toBeTrue()
      expect(Exit.isFailure(yield* WorkCommand.prepared(db, record, { workspaceIdentity: identity, snapshotHash: "9".repeat(64),
        observedRetainedBytes: 0 }).pipe(Effect.exit))).toBeTrue()
      expect(Exit.isFailure(yield* WorkCommand.beginDispatch(db, record, "replacement").pipe(Effect.exit))).toBeTrue()
      expect(yield* db.all("PRAGMA foreign_key_check")).toEqual([])
      return { rows: yield* db.select().from(WorkCommandIntentTable), meter: yield* db.select().from(WorkCommandMeterTable) }
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    const cold = await Effect.runPromise(Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      expect(yield* WorkCommand.get(db, "windows-record-admission")).toBeUndefined()
      return { rows: yield* db.select().from(WorkCommandIntentTable), meter: yield* db.select().from(WorkCommandMeterTable) }
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped))
    expect(cold).toEqual(saved)
  }
  await fs.rm(root, { recursive: true })
})
