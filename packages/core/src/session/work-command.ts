export * as WorkCommand from "./work-command"

import { and, eq, isNull, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionProviderAttemptTable, SessionProviderOwnerLeaseTable } from "../context-federation/session-sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SessionTable } from "./sql"
import { V2ProviderTurnReceiptTable } from "./runner/v2-provider-turn.sql"
import { V2ToolEffectAdmissionTable } from "./runner/v2-tool-effect.sql"
import { WorkCommandSchema } from "./work-command.schema"
import { WorkCommandWindowsSchema } from "./work-command-windows.schema"
import { WorkWindowsPathSchema } from "./work-windows-path.schema"
import { WorkCommandIntentTable, WorkCommandMeterTable } from "./work-command.sql"
import { WorkErrorDiagnostic } from "./work-error-diagnostic"
import type { WorkAuthority } from "./work-authority"

type Db = Database.Interface["db"]
type Reader = Pick<Db, "select">
export type Record = WorkCommandWindowsSchema.StoredRecord
type Result<R extends Record> = Effect.Effect<R, WorkCommandSchema.Error>
type Preparation<R extends Record> = { workspaceIdentity: NonNullable<R["workspaceIdentity"]>; snapshotHash: string; observedRetainedBytes: number }
type Settlement<R extends Record> = Pick<R, "outcome" | "exitCode" | "signal" | "stopConfirmed" | "stdout" | "stderr" | "outputs" | "observedRetainedBytes">
/** The installed native factory supplies this captured, live getter. It must
 * only inspect its own opaque lease inside a transaction, never perform IO or
 * obtain a target from request/recipe JSON. Bare/source hosts have no factory. */
export const NativeWindows = Context.Reference<{
  readonly current: Effect.Effect<WorkCommandWindowsSchema.Target, WorkCommandSchema.Error>
} | undefined>("@deepagent-code/WorkCommand/NativeWindows", { defaultValue: () => undefined })
export type Reservation = Pick<Record, "commandID" | "admissionID" | "instanceID" | "workID" | "rootWorkID" |
  "sessionID" | "inputID" | "activityID" | "providerReceiptID" | "providerAttemptID" | "toolCallID" |
  "ownerToken" | "sessionClaimToken" | "bindingHash" | "controlRevision" | "recipeID" | "recipeRevision" |
  "recipeHash" | "requestHash" | "helperHash" | "runtimeHash" | "workspaceBasename" | "deadline">
const failure = (code: WorkCommandSchema.Error["code"] = "WORK_COMMAND_UNAVAILABLE") =>
  new WorkCommandSchema.Error({ code, message: "Managed command authority or custody is unavailable" })

/** Read only, including cold dispatching/unknown records. Reading a PID never creates
 * an OS handle, launch permit or permission to kill a potentially recycled process. */
export const get = Effect.fn("WorkCommand.get")(function* (db: Reader, admissionID: string) {
  const size = yield* db.select({ bytes: sql<number>`length(CAST(${WorkCommandIntentTable.record} AS BLOB))` })
    .from(WorkCommandIntentTable).where(eq(WorkCommandIntentTable.admission_id, admissionID)).get()
  if (!size) return undefined
  if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || size.bytes > WorkCommandSchema.MAX_RECORD_BYTES)
    return yield* failure("WORK_COMMAND_INVALID_RECORD")
  const row = yield* db.select().from(WorkCommandIntentTable).where(and(
    eq(WorkCommandIntentTable.admission_id, admissionID),
    sql`length(CAST(${WorkCommandIntentTable.record} AS BLOB)) BETWEEN 1 AND ${WorkCommandSchema.MAX_RECORD_BYTES}`,
  )).get()
  if (!row) return yield* failure("WORK_COMMAND_INVALID_RECORD")
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(WorkCommandWindowsSchema.StoredRecord),
    { onExcessProperty: "error" })(row.record)
  if (Option.isNone(decoded) || !valid(decoded.value) ||
    CanonicalJson.stringify(columns(decoded.value)) !== CanonicalJson.stringify(row))
    return yield* failure("WORK_COMMAND_INVALID_RECORD")
  return decoded.value
}, preserve)

export const custody = Effect.fn("WorkCommand.custody")(function* (db: Reader, instanceID: string) {
  const rows = yield* db.select({ admissionID: WorkCommandIntentTable.admission_id }).from(WorkCommandIntentTable)
    .where(and(eq(WorkCommandIntentTable.instance_id, instanceID), isNull(WorkCommandIntentTable.released_at)))
    .limit(WorkCommandSchema.MAX_CUSTODY + 1)
  if (rows.length > WorkCommandSchema.MAX_CUSTODY) return yield* failure("WORK_COMMAND_CAPACITY")
  return yield* Effect.forEach(rows, (row) => get(db, row.admissionID).pipe(Effect.flatMap((record) => record
    ? Effect.succeed(record) : Effect.fail(failure("WORK_COMMAND_INVALID_RECORD")))))
}, preserve)

/** Capacity is committed before any workspace creation. replayed is observational;
 * a caller must never spawn or reconstruct a native capability from that branch. */
export const reserve = Effect.fn("WorkCommand.reserve")(function* (db: Db, input: Reservation) {
  const result = yield* reserveRecord(db, input, { version: 1 })
  if (result.record.version !== 1) return yield* failure("WORK_COMMAND_CONFLICT")
  return { record: result.record, replayed: result.replayed }
}, preserve)

/** No version/target argument exists. The original installed native factory
 * must be live before any reservation, including an observational exact retry. */
export const reserveWindows = Effect.fn("WorkCommand.reserveWindows")(function* (db: Db, input: Reservation) {
  const factory = yield* NativeWindows
  if (!factory) return yield* failure()
  const target = yield* factory.current
  if (!Schema.is(WorkCommandWindowsSchema.Target)(target)) return yield* failure()
  const result = yield* reserveRecord(db, input, { version: 2, target })
  if (result.record.version !== 2 || result.record.target !== target) return yield* failure("WORK_COMMAND_CONFLICT")
  return { record: result.record, replayed: result.replayed }
}, preserve)

function reserveRecord(db: Db, input: Reservation, domain: { version: 1 } | {
  version: 2; target: WorkCommandWindowsSchema.Target
}) {
  return Effect.gen(function* () {
    const now = Date.now()
    const record = yield* checked({ ...input, ...domain, state: "reserved", outcome: null, revision: 1,
      workspaceIdentity: null, snapshotHash: null, processIncarnation: null, processID: null,
      exitCode: null, signal: null, stopConfirmed: false, stdout: null, stderr: null, outputs: [],
      createdAt: now, updatedAt: now, preparedAt: null, dispatchedAt: null, terminalAt: null, releasedAt: null,
      reservedBytes: WorkCommandSchema.RESERVATION_BYTES, observedRetainedBytes: 0 })
    return yield* db.transaction((tx) => Effect.gen(function* () {
      const previous = yield* get(tx, record.admissionID)
      if (previous) {
        if (previous.version !== record.version || (previous.version === 2 &&
          (record.version !== 2 || previous.target !== record.target)) ||
          Object.keys(input).some((key) => Reflect.get(previous, key) !== Reflect.get(input, key)))
          return yield* failure("WORK_COMMAND_CONFLICT")
        return { record: previous, replayed: true }
      }
      yield* requireCurrent(tx, record)
      yield* tx.insert(WorkCommandMeterTable).values({ instance_id: record.instanceID, audit_count: 0,
        custody_count: 0, retained_bytes: 0, revision: 1, updated_at: now }).onConflictDoNothing()
      const meter = yield* tx.select().from(WorkCommandMeterTable)
        .where(eq(WorkCommandMeterTable.instance_id, record.instanceID)).get()
      const validation = yield* tx.get<{ count: number; bytes: number }>(sql`SELECT count(*) count,coalesce(sum(retained_bytes),0) bytes
        FROM event_validation_run WHERE instance_id=${record.instanceID} AND released_at IS NULL`)
      if (!meter || ![meter.audit_count, meter.custody_count, meter.retained_bytes, meter.revision].every(Number.isSafeInteger) ||
        !validation || !Number.isSafeInteger(validation.count) || !Number.isSafeInteger(validation.bytes) ||
        meter.audit_count >= WorkCommandSchema.MAX_AUDIT_RECORDS || meter.custody_count + validation.count >= WorkCommandSchema.MAX_CUSTODY ||
        meter.retained_bytes + validation.bytes + record.reservedBytes > WorkCommandSchema.MAX_CUSTODY_BYTES)
        return yield* failure("WORK_COMMAND_CAPACITY")
      const changed = yield* tx.update(WorkCommandMeterTable).set({ audit_count: meter.audit_count + 1,
        custody_count: meter.custody_count + 1, retained_bytes: meter.retained_bytes + record.reservedBytes,
        revision: meter.revision + 1, updated_at: now }).where(and(eq(WorkCommandMeterTable.instance_id, record.instanceID),
          eq(WorkCommandMeterTable.revision, meter.revision))).returning({ id: WorkCommandMeterTable.instance_id })
      if (changed.length !== 1) return yield* failure("WORK_COMMAND_CONFLICT")
      yield* tx.insert(WorkCommandIntentTable).values(columns(record))
      return { record, replayed: false }
    }), { behavior: "immediate" })
  })
}

export function prepared(db: Db, record: WorkCommandSchema.Record, input: Preparation<WorkCommandSchema.Record>): Result<WorkCommandSchema.Record>
export function prepared(db: Db, record: WorkCommandWindowsSchema.Record, input: Preparation<WorkCommandWindowsSchema.Record>): Result<WorkCommandWindowsSchema.Record>
export function prepared(db: Db, record: Record, input: Preparation<Record>): Result<Record>
export function prepared(db: Db, record: Record, input: Preparation<Record>) {
  return transition(db, record, { ...record, ...input, state: "prepared", preparedAt: Date.now() }, true)
}

/** The durable uncertainty boundary precedes spawn. The actual native owner then
 * records its handle's PID; a failed/ambiguous spawn does not reopen this intent. */
export function beginDispatch(db: Db, record: WorkCommandSchema.Record, processIncarnation: string): Result<WorkCommandSchema.Record>
export function beginDispatch(db: Db, record: WorkCommandWindowsSchema.Record, processIncarnation: string): Result<WorkCommandWindowsSchema.Record>
export function beginDispatch(db: Db, record: Record, processIncarnation: string): Result<Record>
export function beginDispatch(db: Db, record: Record, processIncarnation: string) {
  return transition(db, record, { ...record, state: "dispatching", processIncarnation, dispatchedAt: Date.now() }, true)
}

export function started(db: Db, record: WorkCommandSchema.Record, processID: number): Result<WorkCommandSchema.Record>
export function started(db: Db, record: WorkCommandWindowsSchema.Record, processID: number): Result<WorkCommandWindowsSchema.Record>
export function started(db: Db, record: Record, processID: number): Result<Record>
export function started(db: Db, record: Record, processID: number) {
  return record.state !== "dispatching" || record.processID !== null ? Effect.fail(failure("WORK_COMMAND_CONFLICT"))
    : transition(db, record, { ...record, processID }, false)
}

/** A contained, suspended original native owner is not payload dispatch. The
 * same transaction rechecks current authority and records uncertainty/PID
 * before the Host releases that owner to execute the approved image. */
export function dispatchReadyInTransaction(tx: WorkAuthority.Transaction, record: WorkCommandSchema.Record, processIncarnation: string, processID: number): Result<WorkCommandSchema.Record>
export function dispatchReadyInTransaction(tx: WorkAuthority.Transaction, record: WorkCommandWindowsSchema.Record, processIncarnation: string, processID: number): Result<WorkCommandWindowsSchema.Record>
export function dispatchReadyInTransaction(tx: WorkAuthority.Transaction, record: Record, processIncarnation: string, processID: number): Result<Record>
export function dispatchReadyInTransaction(tx: WorkAuthority.Transaction, record: Record, processIncarnation: string, processID: number) {
  return Effect.gen(function* () {
    if (record.state !== "prepared" || record.processID !== null) return yield* failure("WORK_COMMAND_CONFLICT")
    const dispatched = yield* transitionInTransaction(tx, record,
      { ...record, state: "dispatching", processIncarnation, dispatchedAt: Date.now() }, true)
    return yield* transitionInTransaction(tx, dispatched, { ...dispatched, processID }, false)
  })
}

export function settled(db: Db, record: WorkCommandSchema.Record, result: Settlement<WorkCommandSchema.Record>): Result<WorkCommandSchema.Record>
export function settled(db: Db, record: WorkCommandWindowsSchema.Record, result: Settlement<WorkCommandWindowsSchema.Record>): Result<WorkCommandWindowsSchema.Record>
export function settled(db: Db, record: Record, result: Settlement<Record>): Result<Record>
export function settled(db: Db, record: Record, result: Settlement<Record>) {
  return transition(db, record, { ...record, ...result, state: "settled", terminalAt: Date.now() }, false)
}

export function unknown(db: Db, record: WorkCommandSchema.Record): Result<WorkCommandSchema.Record>
export function unknown(db: Db, record: WorkCommandWindowsSchema.Record): Result<WorkCommandWindowsSchema.Record>
export function unknown(db: Db, record: Record): Result<Record>
export function unknown(db: Db, record: Record) {
  return transition(db, record, { ...record, state: "unknown" }, false)
}

export function observed(db: Db, record: WorkCommandSchema.Record, observedRetainedBytes: number): Result<WorkCommandSchema.Record>
export function observed(db: Db, record: WorkCommandWindowsSchema.Record, observedRetainedBytes: number): Result<WorkCommandWindowsSchema.Record>
export function observed(db: Db, record: Record, observedRetainedBytes: number): Result<Record>
export function observed(db: Db, record: Record, observedRetainedBytes: number) {
  return transition(db, record, { ...record, observedRetainedBytes }, false)
}

/** Installed owner only, after exact private-object cleanup. A terminal command keeps
 * custody while a subsequent tool may still publish an authenticated output. */
export function released(db: Db, record: WorkCommandSchema.Record): Result<WorkCommandSchema.Record>
export function released(db: Db, record: WorkCommandWindowsSchema.Record): Result<WorkCommandWindowsSchema.Record>
export function released(db: Db, record: Record): Result<Record>
export function released(db: Db, record: Record) {
  return transition(db, record, { ...record, releasedAt: Date.now(), reservedBytes: 0, observedRetainedBytes: 0 }, false)
}

/** Custody cleanup can change revision/bytes without rewriting the historical result. */
export function resultHash(record: Record) {
  const result = { commandID: record.commandID, admissionID: record.admissionID,
    requestHash: record.requestHash, recipeHash: record.recipeHash, runtimeHash: record.runtimeHash,
    workspaceIdentity: record.workspaceIdentity, snapshotHash: record.snapshotHash,
    processIncarnation: record.processIncarnation, processID: record.processID,
    state: record.state, outcome: record.outcome, exitCode: record.exitCode, signal: record.signal,
    stopConfirmed: record.stopConfirmed, stdout: record.stdout, stderr: record.stderr, outputs: record.outputs,
    preparedAt: record.preparedAt, dispatchedAt: record.dispatchedAt, terminalAt: record.terminalAt }
  return Hash.sha256(CanonicalJson.stringify(record.version === 1 ? result : {
    version: 2, target: record.target, instanceID: record.instanceID,
    workID: record.workID, rootWorkID: record.rootWorkID, sessionID: record.sessionID,
    inputID: record.inputID, activityID: record.activityID, providerReceiptID: record.providerReceiptID,
    providerAttemptID: record.providerAttemptID, toolCallID: record.toolCallID, ownerToken: record.ownerToken,
    sessionClaimToken: record.sessionClaimToken, bindingHash: record.bindingHash, controlRevision: record.controlRevision,
    recipeID: record.recipeID, recipeRevision: record.recipeRevision, helperHash: record.helperHash,
    workspaceBasename: record.workspaceBasename, deadline: record.deadline, ...result,
  }))
}

/** Cleanup confirmation and the original quota CAS must commit in the same transaction. */
export function releasedInTransaction(tx: WorkAuthority.Transaction, record: WorkCommandSchema.Record): Result<WorkCommandSchema.Record>
export function releasedInTransaction(tx: WorkAuthority.Transaction, record: WorkCommandWindowsSchema.Record): Result<WorkCommandWindowsSchema.Record>
export function releasedInTransaction(tx: WorkAuthority.Transaction, record: Record): Result<Record>
export function releasedInTransaction(tx: WorkAuthority.Transaction, record: Record) {
  return transitionInTransaction(tx, record, { ...record, releasedAt: Date.now(), reservedBytes: 0, observedRetainedBytes: 0 }, false)
}

function transition(db: Db, record: Record, requested: unknown, current: boolean) {
  return db.transaction((tx) => transitionInTransaction(tx, record, requested, current), { behavior: "immediate" }).pipe(preserve)
}

function transitionInTransaction(tx: WorkAuthority.Transaction, record: Record, input: unknown, current: boolean) {
  return Effect.gen(function* () {
    const decoded = WorkCommandWindowsSchema.decodeRecord(input)
    if (Option.isNone(decoded)) return yield* failure("WORK_COMMAND_INVALID_RECORD")
    // Phase timestamps are newer than the inherited record after real Native I/O.
    // The transition clock is server-owned; caller updatedAt cannot extend it.
    const requested = yield* checked({ ...decoded.value, updatedAt: Date.now() })
    const actual = yield* get(tx, record.admissionID)
    if (!actual || actual.releasedAt !== null || CanonicalJson.stringify(actual) !== CanonicalJson.stringify(record))
      return yield* failure("WORK_COMMAND_CONFLICT")
    if (requested.version !== actual.version || (actual.version === 2 &&
      (requested.version !== 2 || requested.target !== actual.target))) return yield* failure("WORK_COMMAND_CONFLICT")
    if (actual.version === 2 && (["commandID", "admissionID", "instanceID", "workID", "rootWorkID", "sessionID",
      "inputID", "activityID", "providerReceiptID", "providerAttemptID", "toolCallID", "ownerToken", "sessionClaimToken",
      "bindingHash", "controlRevision", "recipeID", "recipeRevision", "recipeHash", "requestHash", "helperHash", "runtimeHash",
      "workspaceBasename", "createdAt", "deadline"] as const).some((key) => actual[key] !== requested[key]))
      return yield* failure("WORK_COMMAND_CONFLICT")
    const allowed = requested.state === actual.state ||
      (actual.state === "reserved" && requested.state === "prepared") ||
      (actual.state === "prepared" && requested.state === "dispatching") ||
      (["reserved", "prepared"].includes(actual.state) && requested.state === "settled" && requested.outcome === "refused_before_dispatch") ||
      (actual.state === "dispatching" && ["settled", "unknown"].includes(requested.state))
    if (!allowed || (requested.releasedAt !== null && actual.state !== "settled") ||
      (requested.processID !== actual.processID && (actual.state !== "dispatching" || actual.processID !== null || requested.processID === null)))
      return yield* failure("WORK_COMMAND_CONFLICT")
    if (current) yield* requireCurrent(tx, actual)
    const next = yield* checked({ ...requested, revision: actual.revision + 1, updatedAt: Date.now() })
    const meter = yield* tx.select().from(WorkCommandMeterTable)
      .where(eq(WorkCommandMeterTable.instance_id, record.instanceID)).get()
    if (!meter || meter.custody_count < 1) return yield* failure("WORK_COMMAND_INVALID_RECORD")
    const bytes = meter.retained_bytes - Math.max(record.reservedBytes, record.observedRetainedBytes) +
      Math.max(next.reservedBytes, next.observedRetainedBytes)
    if (!Number.isSafeInteger(bytes) || bytes < 0) return yield* failure("WORK_COMMAND_INVALID_RECORD")
    const changed = yield* tx.update(WorkCommandIntentTable).set(columns(next)).where(and(
      eq(WorkCommandIntentTable.command_id, record.commandID), eq(WorkCommandIntentTable.revision, record.revision),
    )).returning({ id: WorkCommandIntentTable.command_id })
    if (changed.length !== 1) return yield* failure("WORK_COMMAND_CONFLICT")
    const metered = yield* tx.update(WorkCommandMeterTable).set({ retained_bytes: bytes,
      custody_count: meter.custody_count - (next.releasedAt === null ? 0 : 1), revision: meter.revision + 1,
      updated_at: next.updatedAt }).where(and(eq(WorkCommandMeterTable.instance_id, record.instanceID),
      eq(WorkCommandMeterTable.revision, meter.revision))).returning({ id: WorkCommandMeterTable.instance_id })
    if (metered.length !== 1) return yield* failure("WORK_COMMAND_CONFLICT")
    return next
  }).pipe(preserve)
}

function requireCurrent(tx: WorkAuthority.Transaction, record: Record) {
  return Effect.gen(function* () {
    const { WorkAuthority } = yield* Effect.promise(() => import("./work-authority"))
    const work = yield* WorkAuthority.requireCurrentControlInTransaction(tx, {
      workID: record.workID, expectedRevision: record.controlRevision,
    })
    if (work.binding.schemaVersion !== "work-execution.v2" || work.binding_hash !== record.bindingHash ||
      work.root_work_id !== record.rootWorkID || work.session_id !== record.sessionID || work.input_id !== record.inputID ||
      work.binding.projectScope.helperHash !== record.helperHash || record.deadline <= Date.now() ||
      record.deadline > work.binding.deadline)
      return yield* failure("WORK_COMMAND_CONFLICT")
    const recipe = work.binding.toolPolicy.commandRecipes?.find((item) => item.logicalID === record.recipeID)
    const capability = work.binding.toolPolicy.capabilities.find((item) => item.toolID === "managed_command")
    if (!recipe || recipe.revision !== record.recipeRevision || Hash.sha256(CanonicalJson.stringify(recipe)) !== record.recipeHash ||
      recipe.executable.sha256 !== record.runtimeHash || !capability?.operations.includes("run"))
      return yield* failure("WORK_COMMAND_CONFLICT")
    if (record.version === 2) {
      const factory = yield* NativeWindows
      if (!factory || (yield* factory.current) !== record.target || recipe.schemaVersion !== "work-command-recipe.v2" ||
        recipe.executable.platform !== record.target || recipe.executable.identity.kind !== "windows" ||
        work.binding.projectScope.rootIdentity.kind !== "windows" ||
        ![...recipe.inputs, ...recipe.outputs, ...(recipe.cwd === null ? [] : [recipe.cwd])].every(Schema.is(WorkWindowsPathSchema.Relative)) ||
        !WorkWindowsPathSchema.nonOverlapping([...recipe.inputs, ...recipe.outputs])) return yield* failure()
    }
    if (record.version === 1 && recipe.executable.identity.kind !== "posix") return yield* failure("WORK_COMMAND_CONFLICT")
    const rows = yield* tx.select({ admission: V2ToolEffectAdmissionTable, receipt: V2ProviderTurnReceiptTable,
      attempt: SessionProviderAttemptTable, owner: SessionProviderOwnerLeaseTable, session: SessionTable,
    }).from(V2ToolEffectAdmissionTable)
      .innerJoin(V2ProviderTurnReceiptTable, eq(V2ProviderTurnReceiptTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id))
      .innerJoin(SessionProviderAttemptTable, eq(SessionProviderAttemptTable.attempt_id, V2ToolEffectAdmissionTable.provider_attempt_id))
      .innerJoin(SessionProviderOwnerLeaseTable, eq(SessionProviderOwnerLeaseTable.owner_token, V2ToolEffectAdmissionTable.owner_token))
      .innerJoin(SessionTable, eq(SessionTable.id, V2ToolEffectAdmissionTable.session_id))
      .where(eq(V2ToolEffectAdmissionTable.admission_id, record.admissionID)).get()
    if (!rows || rows.admission.tool_name !== "managed_command" || rows.admission.effect_kind !== "mutating" ||
      rows.admission.session_id !== record.sessionID || rows.admission.receipt_id !== record.providerReceiptID ||
      rows.admission.provider_attempt_id !== record.providerAttemptID || rows.admission.tool_call_id !== record.toolCallID ||
      rows.admission.owner_token !== record.ownerToken || rows.receipt.owner_token !== record.ownerToken ||
      rows.attempt.owner_token !== record.ownerToken || rows.attempt.session_id !== record.sessionID ||
      rows.attempt.activity_id !== record.activityID || rows.attempt.execution_claim_token !== record.sessionClaimToken ||
      rows.session.execution_claim_token !== record.sessionClaimToken || rows.owner.released_at !== null ||
      rows.owner.lease_expires_at <= Date.now() || rows.receipt.state !== "settled" || rows.attempt.state !== "settled")
      return yield* failure("WORK_COMMAND_CONFLICT")
  })
}

function checked(input: unknown) {
  const decoded = WorkCommandWindowsSchema.decodeRecord(input)
  if (Option.isNone(decoded) || !valid(decoded.value)) return Effect.fail(failure("WORK_COMMAND_INVALID_RECORD"))
  return Buffer.byteLength(CanonicalJson.stringify(decoded.value)) <= WorkCommandSchema.MAX_RECORD_BYTES
    ? Effect.succeed(decoded.value) : Effect.fail(failure("WORK_COMMAND_CAPACITY"))
}

function valid(record: Record) {
  if (record.deadline <= record.createdAt || record.updatedAt < record.createdAt ||
    [record.preparedAt, record.dispatchedAt, record.terminalAt, record.releasedAt].some((time) =>
      time !== null && (time < record.createdAt || time > record.updatedAt)) ||
    (record.releasedAt !== null && (record.state !== "settled" || record.reservedBytes !== 0 || record.observedRetainedBytes !== 0)) ||
    (record.releasedAt === null && record.reservedBytes === 0)) return false
  if (record.state === "reserved") return record.preparedAt === null && record.dispatchedAt === null &&
    record.workspaceIdentity === null && record.snapshotHash === null && record.processID === null &&
    record.processIncarnation === null && record.outcome === null && record.terminalAt === null &&
    record.stdout === null && record.stderr === null && record.outputs.length === 0 && !record.stopConfirmed
  if (record.state === "settled" && record.outcome === "refused_before_dispatch") return record.dispatchedAt === null &&
    record.processID === null && record.processIncarnation === null && record.terminalAt !== null &&
    record.stdout === null && record.stderr === null && record.outputs.length === 0 && record.stopConfirmed
  if (!record.workspaceIdentity || !record.snapshotHash || !record.preparedAt) return false
  if (record.state === "prepared") return record.dispatchedAt === null && record.processIncarnation === null &&
    record.processID === null && record.outcome === null && record.terminalAt === null && !record.stopConfirmed &&
    record.stdout === null && record.stderr === null && record.outputs.length === 0
  if (!record.dispatchedAt || record.dispatchedAt < record.preparedAt || !record.processIncarnation) return false
  if (record.state !== "settled") return record.outcome === null && record.terminalAt === null &&
    record.stdout === null && record.stderr === null && record.outputs.length === 0 && !record.stopConfirmed
  return ["exited", "cancelled"].includes(record.outcome ?? "") && record.processID !== null && record.stopConfirmed &&
    record.terminalAt !== null && record.terminalAt >= record.dispatchedAt &&
    record.stdout?.complete === true && record.stderr?.complete === true &&
    (record.exitCode !== null || record.signal !== null) &&
    [record.stdout, record.stderr].every((stream) => stream.capturedBytes <= stream.bytes &&
      stream.truncated === (stream.capturedBytes < stream.bytes)) &&
    new Set(record.outputs.map((output) => output.relative)).size === record.outputs.length
}

function columns(record: Record) {
  const text = CanonicalJson.stringify(record)
  return { command_id: record.commandID, admission_id: record.admissionID, instance_id: record.instanceID,
    work_id: record.workID, root_work_id: record.rootWorkID, session_id: record.sessionID, input_id: record.inputID,
    activity_id: record.activityID, provider_receipt_id: record.providerReceiptID, provider_attempt_id: record.providerAttemptID,
    tool_call_id: record.toolCallID, owner_token: record.ownerToken, session_claim_token: record.sessionClaimToken,
    binding_hash: record.bindingHash, control_revision: record.controlRevision, recipe_id: record.recipeID,
    recipe_revision: record.recipeRevision, recipe_hash: record.recipeHash, request_hash: record.requestHash,
    helper_hash: record.helperHash, runtime_hash: record.runtimeHash, workspace_basename: record.workspaceBasename,
    state: record.state, outcome: record.outcome, revision: record.revision, reserved_bytes: record.reservedBytes,
    observed_retained_bytes: record.observedRetainedBytes, record: text, record_hash: Hash.sha256(text),
    created_at: record.createdAt, updated_at: record.updatedAt, prepared_at: record.preparedAt,
    dispatched_at: record.dispatchedAt, terminal_at: record.terminalAt, released_at: record.releasedAt, deadline: record.deadline }
}

function preserve<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.tapError((error) => error instanceof WorkCommandSchema.Error ? Effect.void : WorkErrorDiagnostic.report("command", error)),
    Effect.mapError((error) => error instanceof WorkCommandSchema.Error ? error : failure()),
  )
}
