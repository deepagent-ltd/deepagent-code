export * as WorkWriteStage from "./work-write-stage"

import { and, eq, isNull, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { SessionProviderAttemptTable, SessionProviderOwnerLeaseTable } from "../context-federation/session-sql"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SessionTable } from "./sql"
import { V2ProviderTurnReceiptTable } from "./runner/v2-provider-turn.sql"
import { V2ToolEffectAdmissionTable } from "./runner/v2-tool-effect.sql"
import { WorkWriteStageSchema } from "./work-write-stage.schema"
import { WorkWriteStageMeterTable, WorkWriteStageTable } from "./work-write-stage.sql"
import { WorkErrorDiagnostic } from "./work-error-diagnostic"
import type { WorkAuthority } from "./work-authority"

type Db = Database.Interface["db"]
type Reader = Pick<Db, "select">
type Record = WorkWriteStageSchema.Record
export type Reservation = Omit<Record, "version" | "parentIdentity" | "stageIdentity" | "state" | "revision" |
  "reservedBytes" | "observedRetainedBytes" | "createdAt" | "updatedAt" | "releasedAt">
const failure = (code: WorkWriteStageSchema.Error["code"] = "WRITE_STAGE_UNAVAILABLE") =>
  new WorkWriteStageSchema.Error({ code, message: "Native write custody is unavailable or requires reconciliation" })

/** SELECT only. A damaged large record is rejected before its text is materialized. */
export const get = Effect.fn("WorkWriteStage.get")(function* (db: Reader, admissionID: string) {
  const size = yield* db.select({ bytes: sql<number>`length(CAST(${WorkWriteStageTable.record} AS BLOB))` })
    .from(WorkWriteStageTable).where(eq(WorkWriteStageTable.admission_id, admissionID)).get()
  if (!size) return undefined
  if (!Number.isSafeInteger(size.bytes) || size.bytes < 1 || size.bytes > WorkWriteStageSchema.MAX_RECORD_BYTES)
    return yield* failure("WRITE_STAGE_INVALID_RECORD")
  const row = yield* db.select().from(WorkWriteStageTable).where(and(
    eq(WorkWriteStageTable.admission_id, admissionID),
    sql`length(CAST(${WorkWriteStageTable.record} AS BLOB)) BETWEEN 1 AND ${WorkWriteStageSchema.MAX_RECORD_BYTES}`,
  )).get()
  if (!row) return yield* failure("WRITE_STAGE_INVALID_RECORD")
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(WorkWriteStageSchema.Record),
    { onExcessProperty: "error" })(row.record)
  if (Option.isNone(decoded)) return yield* failure("WRITE_STAGE_INVALID_RECORD")
  const record = decoded.value
  if (!valid(record) || CanonicalJson.stringify(columns(record)) !== CanonicalJson.stringify(row))
    return yield* failure("WRITE_STAGE_INVALID_RECORD")
  return record
}, preserve)

/** Bounded custody observations for a new write admission, never a recovery permit. */
export const custody = Effect.fn("WorkWriteStage.custody")(function* (db: Reader, instanceID: string) {
  const rows = yield* db.select({ admissionID: WorkWriteStageTable.admission_id }).from(WorkWriteStageTable)
    .where(and(eq(WorkWriteStageTable.instance_id, instanceID), isNull(WorkWriteStageTable.released_at)))
    .limit(WorkWriteStageSchema.MAX_CUSTODY + 1)
  if (rows.length > WorkWriteStageSchema.MAX_CUSTODY) return yield* failure("WRITE_STAGE_CAPACITY")
  return yield* Effect.forEach(rows, (row) => get(db, row.admissionID).pipe(Effect.flatMap((record) => record
    ? Effect.succeed(record) : Effect.fail(failure("WRITE_STAGE_INVALID_RECORD")))))
}, preserve)

/** Commits capacity before mkdir/payload creation. An exact retry observes the original
 * stage; it is deliberately NOT a permit to re-run prepare or publication. */
export const reserve = Effect.fn("WorkWriteStage.reserve")(function* (db: Db, input: Reservation) {
  const now = Date.now()
  const record = yield* checked({ ...input, version: 1, parentIdentity: null, stageIdentity: null,
    state: "reserved", revision: 1, reservedBytes: input.nextBytes + WorkWriteStageSchema.METADATA_RESERVATION +
      (input.expected.kind === "observed" ? WorkWriteStageSchema.MAX_PREVIOUS_BYTES : 0),
    observedRetainedBytes: 0, createdAt: now, updatedAt: now, releasedAt: null })
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const previous = yield* get(tx, record.admissionID)
    if (previous) {
      if (previous.instanceID !== record.instanceID || previous.stageID !== record.stageID ||
        previous.workID !== record.workID || previous.bindingHash !== record.bindingHash ||
        previous.requestHash !== record.requestHash) return yield* failure("WRITE_STAGE_CONFLICT")
      return { record: previous, replayed: true }
    }
    yield* requireCurrent(tx, record)
    yield* tx.insert(WorkWriteStageMeterTable).values({ instance_id: record.instanceID,
      audit_count: 0, custody_count: 0, retained_bytes: 0, revision: 1, updated_at: now }).onConflictDoNothing()
    const meter = yield* tx.select().from(WorkWriteStageMeterTable)
      .where(eq(WorkWriteStageMeterTable.instance_id, record.instanceID)).get()
    if (!meter || ![meter.audit_count, meter.custody_count, meter.retained_bytes, meter.revision].every(Number.isSafeInteger) ||
      meter.audit_count >= WorkWriteStageSchema.MAX_RECORDS || meter.custody_count >= WorkWriteStageSchema.MAX_CUSTODY ||
      meter.retained_bytes + record.reservedBytes > WorkWriteStageSchema.MAX_RETAINED_BYTES)
      return yield* failure("WRITE_STAGE_CAPACITY")
    const changed = yield* tx.update(WorkWriteStageMeterTable).set({ audit_count: meter.audit_count + 1,
      custody_count: meter.custody_count + 1, retained_bytes: meter.retained_bytes + record.reservedBytes,
      revision: meter.revision + 1, updated_at: now }).where(and(eq(WorkWriteStageMeterTable.instance_id, record.instanceID),
        eq(WorkWriteStageMeterTable.revision, meter.revision))).returning({ id: WorkWriteStageMeterTable.instance_id })
    if (changed.length !== 1) return yield* failure("WRITE_STAGE_CONFLICT")
    yield* tx.insert(WorkWriteStageTable).values(columns(record))
    return { record, replayed: false }
  }), { behavior: "immediate" })
}, preserve)

/** These transitions preserve factual custody after revocation. Only the two boundaries
 * that can precede side effects recheck current Work/claim; SQL contains no native I/O. */
export const located = (db: Db, record: Record, stageIdentity: NonNullable<Record["stageIdentity"]>) =>
  transition(db, record, { ...record, stageIdentity }, "reserved", true)

export const prepared = (db: Db, record: Record, identities: {
  parentIdentity: NonNullable<Record["parentIdentity"]>; stageIdentity: NonNullable<Record["stageIdentity"]>
}) => transition(db, record, { ...record, ...identities, state: "prepared",
  observedRetainedBytes: record.nextBytes }, "reserved", true)

export const beginPublication = (db: Db, record: Record) => transition(db, record,
  { ...record, state: "publication_unknown" }, "prepared", true)

export const settled = (db: Db, record: Record, outcome: "published" | "refused", observedRetainedBytes: number) =>
  transition(db, record, { ...record, state: outcome, observedRetainedBytes }, record.state, false)

/** Records actual growth without dropping evidence when it exceeds the admission budget.
 * The meter then blocks new reservations. Unknown objects are never implicitly released. */
export const observed = (db: Db, record: Record, observedRetainedBytes: number) =>
  transition(db, record, { ...record, observedRetainedBytes }, record.state, false)

/** Only the installed native owner invokes this after exact-object cleanup confirmation.
 * Terminal SQL state by itself never proves that retained files have been removed. */
export const released = (db: Db, record: Record) => transition(db, record, {
  ...record, releasedAt: Date.now(), reservedBytes: 0, observedRetainedBytes: 0,
}, record.state, false)

/** Cleanup confirmation and the original quota CAS must commit in the same transaction. */
export const releasedInTransaction = (tx: WorkAuthority.Transaction, record: Record) => transitionInTransaction(tx, record,
  { ...record, releasedAt: Date.now(), reservedBytes: 0, observedRetainedBytes: 0 }, record.state, false)

function transition(db: Db, record: Record, requested: Record, state: Record["state"], current: boolean) {
  return db.transaction((tx) => transitionInTransaction(tx, record, requested, state, current), { behavior: "immediate" }).pipe(preserve)
}

function transitionInTransaction(tx: WorkAuthority.Transaction, record: Record, requested: Record, state: Record["state"], current: boolean) {
  return Effect.gen(function* () {
    const actual = yield* get(tx, record.admissionID)
    if (!actual || actual.state !== state || actual.releasedAt !== null ||
      CanonicalJson.stringify(actual) !== CanonicalJson.stringify(record)) return yield* failure("WRITE_STAGE_CONFLICT")
    if (requested.state !== state && requested.state === "published" && state !== "publication_unknown") return yield* failure("WRITE_STAGE_CONFLICT")
    if (requested.state !== state && requested.state === "refused" && !["reserved", "prepared", "publication_unknown"].includes(state))
      return yield* failure("WRITE_STAGE_CONFLICT")
    if (requested.releasedAt !== null && !["published", "refused"].includes(actual.state))
      return yield* failure("WRITE_STAGE_CONFLICT")
    if (current) yield* requireCurrent(tx, actual)
    const next = yield* checked({ ...requested, revision: actual.revision + 1, updatedAt: Date.now() })
    const meter = yield* tx.select().from(WorkWriteStageMeterTable)
      .where(eq(WorkWriteStageMeterTable.instance_id, record.instanceID)).get()
    if (!meter || meter.custody_count < 1) return yield* failure("WRITE_STAGE_INVALID_RECORD")
    const bytes = meter.retained_bytes - Math.max(record.reservedBytes, record.observedRetainedBytes) +
      Math.max(next.reservedBytes, next.observedRetainedBytes)
    if (!Number.isSafeInteger(bytes) || bytes < 0) return yield* failure("WRITE_STAGE_INVALID_RECORD")
    const changed = yield* tx.update(WorkWriteStageTable).set(columns(next)).where(and(
      eq(WorkWriteStageTable.stage_id, record.stageID), eq(WorkWriteStageTable.revision, record.revision),
    )).returning({ id: WorkWriteStageTable.stage_id })
    if (changed.length !== 1) return yield* failure("WRITE_STAGE_CONFLICT")
    const metered = yield* tx.update(WorkWriteStageMeterTable).set({ retained_bytes: bytes,
      custody_count: meter.custody_count - (next.releasedAt === null ? 0 : 1),
      revision: meter.revision + 1, updated_at: next.updatedAt }).where(and(
      eq(WorkWriteStageMeterTable.instance_id, record.instanceID), eq(WorkWriteStageMeterTable.revision, meter.revision),
    )).returning({ id: WorkWriteStageMeterTable.instance_id })
    if (metered.length !== 1) return yield* failure("WRITE_STAGE_CONFLICT")
    return next
  }).pipe(preserve)
}

function requireCurrent(tx: WorkAuthority.Transaction, record: Record) {
  return Effect.gen(function* () {
    // Keep Work and tool registration dependency cycles out of cold module evaluation.
    const { WorkAuthority } = yield* Effect.promise(() => import("./work-authority"))
    const work = yield* WorkAuthority.requireCurrentControlInTransaction(tx, {
      workID: record.workID, expectedRevision: record.controlRevision,
    })
    if (work.binding.schemaVersion !== "work-execution.v2" || work.binding_hash !== record.bindingHash ||
      work.root_work_id !== record.rootWorkID || work.session_id !== record.sessionID || work.input_id !== record.inputID ||
      work.binding.projectScope.helperHash !== record.helperHash ||
      CanonicalJson.stringify(work.binding.projectScope.rootIdentity) !== CanonicalJson.stringify(record.rootIdentity))
      return yield* failure("WRITE_STAGE_CONFLICT")
    const allowed = work.binding.toolPolicy.capabilities.find((item) => item.toolID === "write")
    const matches = (rule: { kind: "file" | "tree"; path: string }) => record.relative === rule.path ||
      (rule.kind === "tree" && record.relative.startsWith(`${rule.path}/`))
    if (!allowed || allowed.definitionHash !== record.definitionHash || !allowed.operations.includes("write") ||
      work.binding.toolPolicy.fileScope.deny.some(matches) || !work.binding.toolPolicy.fileScope.write.some(matches))
      return yield* failure("WRITE_STAGE_CONFLICT")
    const rows = yield* tx.select({ admission: V2ToolEffectAdmissionTable, receipt: V2ProviderTurnReceiptTable,
      attempt: SessionProviderAttemptTable, owner: SessionProviderOwnerLeaseTable, session: SessionTable,
    }).from(V2ToolEffectAdmissionTable)
      .innerJoin(V2ProviderTurnReceiptTable, eq(V2ProviderTurnReceiptTable.receipt_id, V2ToolEffectAdmissionTable.receipt_id))
      .innerJoin(SessionProviderAttemptTable, eq(SessionProviderAttemptTable.attempt_id, V2ToolEffectAdmissionTable.provider_attempt_id))
      .innerJoin(SessionProviderOwnerLeaseTable, eq(SessionProviderOwnerLeaseTable.owner_token, V2ToolEffectAdmissionTable.owner_token))
      .innerJoin(SessionTable, eq(SessionTable.id, V2ToolEffectAdmissionTable.session_id))
      .where(eq(V2ToolEffectAdmissionTable.admission_id, record.admissionID)).get()
    if (!rows || rows.admission.tool_name !== "write" || rows.admission.effect_kind !== "mutating" ||
      rows.admission.session_id !== record.sessionID || rows.admission.receipt_id !== record.providerReceiptID ||
      rows.admission.provider_attempt_id !== record.providerAttemptID || rows.admission.tool_call_id !== record.toolCallID ||
      rows.admission.owner_token !== record.ownerToken || rows.receipt.owner_token !== record.ownerToken ||
      rows.attempt.owner_token !== record.ownerToken || rows.attempt.session_id !== record.sessionID ||
      rows.attempt.activity_id !== record.activityID || rows.attempt.execution_claim_token !== record.sessionClaimToken ||
      rows.session.execution_claim_token !== record.sessionClaimToken || rows.owner.released_at !== null ||
      rows.owner.lease_expires_at <= Date.now() || rows.receipt.state !== "settled" || rows.attempt.state !== "settled")
      return yield* failure("WRITE_STAGE_CONFLICT")
  })
}

function checked(input: unknown) {
  const decoded = Schema.decodeUnknownOption(WorkWriteStageSchema.Record, { onExcessProperty: "error" })(input)
  if (Option.isNone(decoded) || !valid(decoded.value)) return Effect.fail(failure("WRITE_STAGE_INVALID_RECORD"))
  return Buffer.byteLength(CanonicalJson.stringify(decoded.value)) <= WorkWriteStageSchema.MAX_RECORD_BYTES
    ? Effect.succeed(decoded.value) : Effect.fail(failure("WRITE_STAGE_CAPACITY"))
}

function valid(record: Record) {
  return record.updatedAt >= record.createdAt &&
    (record.state === "reserved" || record.state === "refused" || (record.parentIdentity !== null && record.stageIdentity !== null)) &&
    (record.releasedAt === null || (["published", "refused"].includes(record.state) && record.releasedAt >= record.createdAt &&
      record.reservedBytes === 0 && record.observedRetainedBytes === 0))
}

function columns(record: Record) {
  const text = CanonicalJson.stringify(record)
  return { stage_id: record.stageID, instance_id: record.instanceID, work_id: record.workID, root_work_id: record.rootWorkID,
    session_id: record.sessionID, input_id: record.inputID, provider_receipt_id: record.providerReceiptID,
    provider_attempt_id: record.providerAttemptID, admission_id: record.admissionID, tool_call_id: record.toolCallID,
    binding_hash: record.bindingHash, control_revision: record.controlRevision, request_hash: record.requestHash,
    state: record.state, revision: record.revision, reserved_bytes: record.reservedBytes,
    observed_retained_bytes: record.observedRetainedBytes, record: text, record_hash: Hash.sha256(text),
    created_at: record.createdAt, updated_at: record.updatedAt, released_at: record.releasedAt }
}

function preserve<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.tapError((error) => error instanceof WorkWriteStageSchema.Error ? Effect.void : WorkErrorDiagnostic.report("write", error)),
    Effect.mapError((error) => error instanceof WorkWriteStageSchema.Error ? error : failure()),
  )
}
