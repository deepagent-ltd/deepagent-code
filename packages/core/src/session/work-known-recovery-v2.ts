export * as WorkKnownRecoveryV2 from "./work-known-recovery-v2"

import { and, asc, eq, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema, Scope } from "effect"
import type { Database } from "../database/database"
import { Finish, ToolCall } from "@deepagent-code/llm"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import { SessionActivityTable, SessionProviderAttemptTable, SessionProviderOwnerLeaseTable } from "../context-federation/session-sql"
import { SessionInputTable, SessionTable } from "./sql"
import { SessionSchema } from "./schema"
import { SessionMessage } from "./message"
import { WorkAuthority } from "./work-authority"
import { WorkAuthorityPolicy } from "./work-authority-policy"
import { WorkCountAcquisition } from "./work-count-acquisition"
import { WorkCountAcquisitionTable } from "./work-count-acquisition.sql"
import { WorkDispatchReservationTable } from "./work-authority.sql"
import { V2ProviderTurnReceiptTable } from "./runner/v2-provider-turn.sql"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "./runner/v2-tool-effect.sql"
import { WorkKnownRecoverySchema } from "./work-known-recovery.schema"
import { WorkKnownRecoveryV2Schema } from "./work-known-recovery-v2.schema"
import { WorkKnownRecoveryV2Table } from "./work-known-recovery-v2.sql"
import { WorkKnownRecoveryResumeV2Table } from "./work-known-recovery-v2.sql"
import type { WorkToolPolicy } from "./work-tool-policy"
import { WorkChildAuthority } from "./work-child-authority"
import { WorkTaskKnownProof } from "./work-task-known-proof"
import { WorkTaskKnownProofSchema } from "./work-task-known-proof.schema"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
declare const prepared: unique symbol
export interface Prepared { readonly [prepared]: true }
export type Principal = Readonly<{ instanceID: string; operatorID: string }>
export type Observation = Readonly<{
  principal: Principal
  operatorRevision: number
  approvalRevision: number
  base: Omit<WorkKnownRecoveryV2Schema.Evidence, "activityID" | "providers" | "tools" | "tasks">
  proofs: readonly WorkToolPolicy.Known[]
  tasks: readonly WorkTaskKnownProofSchema.Record[]
}>
/** No default authority. A fixed host factory owns Prepared in a private WeakMap and only
 * seals a candidate whose exact command/current observations were independently checked. */
export class Authority extends Context.Service<Authority, {
  readonly principal: Effect.Effect<Principal, WorkKnownRecoverySchema.Error>
  readonly prepare: (request: WorkKnownRecoveryV2Schema.Request) => Effect.Effect<Prepared, WorkKnownRecoverySchema.Error, Scope.Scope>
  readonly prepareResume: (record: WorkKnownRecoveryV2Schema.Record, request: WorkKnownRecoveryV2Schema.ResumeRequest) => Effect.Effect<Prepared, WorkKnownRecoverySchema.Error, Scope.Scope>
  readonly authenticateResume: (tx: Tx, witness: Prepared, record: WorkKnownRecoveryV2Schema.ResumeRecord) => Effect.Effect<string, WorkKnownRecoverySchema.Error>
  readonly verifyResume: (record: WorkKnownRecoveryV2Schema.ResumeRecord, mac: string) => Effect.Effect<void, WorkKnownRecoverySchema.Error>
  readonly current: (tx: Tx, witness: Prepared) => Effect.Effect<Observation, WorkKnownRecoverySchema.Error>
  readonly authenticate: (tx: Tx, witness: Prepared, record: WorkKnownRecoveryV2Schema.Record) => Effect.Effect<string, WorkKnownRecoverySchema.Error>
  readonly verify: (record: WorkKnownRecoveryV2Schema.Record, mac: string) => Effect.Effect<void, WorkKnownRecoverySchema.Error>
}>()("@deepagent-code/WorkKnownRecoveryV2/Authority") {}
export const failure = (code: WorkKnownRecoverySchema.Error["code"]) => new WorkKnownRecoverySchema.Error({
  code, message: "Explicit known Work recovery is unavailable, changed, or requires attention",
})
type Continuation = {
  db: Db
  installed: import("./work-execution-profile").Installed
  record: WorkKnownRecoveryV2Schema.Record
  resume?: WorkKnownRecoveryV2Schema.ResumeRecord
  active: boolean
  entered: boolean
  verify: Context.Service.Shape<typeof Authority>["verify"]
}
const continuations = new WeakMap<object, Continuation>()
const CurrentContinuation = Context.Reference<Continuation | undefined>("@deepagent-code/WorkKnownRecoveryV2/Continuation", { defaultValue: () => undefined })
const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
const authority = Effect.gen(function* () {
  const value = yield* Effect.serviceOption(Authority)
  if (Option.isNone(value)) return yield* failure("RECOVERY_UNAVAILABLE")
  return value.value
})

/** Default operation is zero execution: exactly one receipt and one old-claim CAS. The
 * caller may explicitly request the existing runner only AFTER this transaction commits. */
export const recover = Effect.fn("WorkKnownRecoveryV2.recover")(function* (db: Db, input: WorkKnownRecoveryV2Schema.Request) {
  const request = yield* decode(WorkKnownRecoveryV2Schema.Request, input, "RECOVERY_INVALID_REQUEST")
  const host = yield* authority
  const principal = yield* host.principal
  const requestHash = commandHash(principal, request)
  const where = and(eq(WorkKnownRecoveryV2Table.instance_id, principal.instanceID),
    eq(WorkKnownRecoveryV2Table.operator_id, principal.operatorID), eq(WorkKnownRecoveryV2Table.work_id, request.workID),
    eq(WorkKnownRecoveryV2Table.request_id, request.requestID))
  const existing = yield* read(db, where)
  if (existing) return yield* retry(existing, requestHash)
  const claimReceipt = yield* db.select({ id: WorkKnownRecoveryV2Table.recovery_id }).from(WorkKnownRecoveryV2Table)
    .where(and(eq(WorkKnownRecoveryV2Table.work_id, request.workID), eq(WorkKnownRecoveryV2Table.old_claim_token, request.expectedClaimToken))).get()
  if (claimReceipt) return yield* failure("RECOVERY_CONFLICT")
  const witness = yield* host.prepare(request)
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const prior = yield* read(tx, where)
    if (prior) return yield* retry(prior, requestHash)
    const observation = yield* host.current(tx, witness)
    if (hash(observation.principal) !== hash(principal)) return yield* failure("RECOVERY_AUTH_REQUIRED")
    const current = yield* facts(tx, request, observation)
    const record: WorkKnownRecoveryV2Schema.Record = {
      version: 2, recoveryID: `wrecover2_${requestHash}`, ...principal,
      workID: current.work.work_id, rootWorkID: current.work.root_work_id,
      sessionID: current.work.session_id, inputID: current.work.input_id,
      requestID: request.requestID, action: request.action, oldClaimToken: request.expectedClaimToken,
      controlRevision: request.expectedControlRevision, operatorRevision: observation.operatorRevision,
      sourceRevision: current.work.source_revision, approvalRevision: observation.approvalRevision,
      bindingHash: current.work.binding_hash, requestHash, evidenceHash: hash(current.evidence),
      evidence: current.evidence, createdAt: Date.now(),
    }
    const text = CanonicalJson.stringify(yield* decode(WorkKnownRecoveryV2Schema.Record, record))
    if (Buffer.byteLength(text) > WorkKnownRecoveryV2Schema.MAX_RECORD_BYTES) return yield* failure("RECOVERY_CAPACITY")
    const [capacity] = yield* tx.all<{ instance: number; work: number; bytes: number }>(sql`SELECT
      count(*) instance, COALESCE(sum(work_id=${request.workID}),0) work,
      coalesce(sum(length(CAST(record AS BLOB))+8192),0) bytes FROM work_known_recovery_v2
      WHERE instance_id=${principal.instanceID}`)
    if (!capacity || capacity.instance >= WorkKnownRecoveryV2Schema.MAX_INSTANCE_RECEIPTS ||
      capacity.work >= WorkKnownRecoveryV2Schema.MAX_WORK_RECEIPTS || capacity.bytes+Buffer.byteLength(text)+8192>
        WorkKnownRecoveryV2Schema.MAX_INSTANCE_BYTES) return yield* failure("RECOVERY_CAPACITY")
    const mac = yield* host.authenticate(tx, witness, record)
    // The physical insert guard checks the still-owned old claim. Both writes share this
    // immediate transaction; a failed CAS rolls back the authenticated receipt too.
    yield* tx.insert(WorkKnownRecoveryV2Table).values(columns(record, mac))
    const changed = yield* tx.update(SessionTable).set({ execution_claim_token: null,
      time_updated: sql`${SessionTable.time_updated}` }).where(and(
        eq(SessionTable.id, SessionSchema.ID.make(request.sessionID)),
        eq(SessionTable.execution_claim_token, request.expectedClaimToken),
      )).returning({ id: SessionTable.id }).get()
    if (!changed) return yield* failure("RECOVERY_CONFLICT")
    const result = receipt(record, false)
    if (record.action === "recover_and_resume") yield* registerContinuation(db, result, record)
    return result
  }), { behavior: "immediate" })
}, preserve)

/** A SQL-only bounded read. No key creation, native capture, claim mutation or execution. */
export const read = Effect.fn("WorkKnownRecoveryV2.read")(function* (db: Pick<Db, "select">, where: ReturnType<typeof eq> | undefined,
  verify?: Context.Service.Shape<typeof Authority>["verify"]) {
  const size = yield* db.select({ size: sql<number>`length(CAST(${WorkKnownRecoveryV2Table.record} AS BLOB))` })
    .from(WorkKnownRecoveryV2Table).where(where).get()
  if (!size) return undefined
  if (!Number.isSafeInteger(size.size) || size.size < 1 || size.size > WorkKnownRecoveryV2Schema.MAX_RECORD_BYTES)
    return yield* failure("RECOVERY_INVALID_RECORD")
  const row = yield* db.select().from(WorkKnownRecoveryV2Table).where(and(where,
    sql`length(CAST(${WorkKnownRecoveryV2Table.record} AS BLOB)) BETWEEN 1 AND ${WorkKnownRecoveryV2Schema.MAX_RECORD_BYTES}`)).get()
  if (!row) return yield* failure("RECOVERY_INVALID_RECORD")
  const record = yield* decode(Schema.fromJsonString(WorkKnownRecoveryV2Schema.Record), row.record)
  if (hash(columns(record, row.mac)) !== hash(row) || record.evidenceHash !== hash(record.evidence) ||
    record.requestHash !== commandHash(record, { workID: record.workID, sessionID: record.sessionID,
      requestID: record.requestID, expectedClaimToken: record.oldClaimToken,
      expectedControlRevision: record.controlRevision, action: record.action })) return yield* failure("RECOVERY_INVALID_RECORD")
  yield* verify ? verify(record, row.mac) : (yield* authority).verify(record, row.mac)
  return record
}, preserve)

/** Re-read in the caller's SAME transaction. No network, installation I/O or lease renewal. */
export const facts = Effect.fn("WorkKnownRecoveryV2.facts")(function* (
  tx: Tx, request: WorkKnownRecoveryV2Schema.Request, observation: Observation, releasedClaim = false,
) {
  const work = yield* WorkAuthority.requireCurrentControlInTransaction(tx, {
    workID: request.workID, expectedRevision: request.expectedControlRevision,
  })
  if (work.binding.schemaVersion !== "work-execution.v2" || work.binding.profile.id !== WorkAuthorityPolicy.SHARED_ROOT_PROFILE.id ||
    work.parent_work_id !== null || work.work_id !== work.root_work_id || work.outcome !== "pending" ||
    work.session_id !== request.sessionID || work.binding.scope.actorID !== observation.principal.operatorID ||
    work.source_record_hash !== observation.base.sourceRecordHash || work.binding.source.sourceID !== observation.base.sourceID ||
    work.binding.projectScope.helperHash !== observation.base.helperHash ||
    hash(work.binding.projectScope.rootIdentity) !== hash(observation.base.rootIdentity)) return yield* failure("RECOVERY_CONFLICT")
  const session = yield* tx.select().from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make(work.session_id))).get()
  const input = yield* tx.select().from(SessionInputTable).where(eq(SessionInputTable.id, SessionMessage.ID.make(work.input_id))).get()
  if (!session || session.execution_claim_token !== (releasedClaim ? null : request.expectedClaimToken) || !input ||
    input.session_id !== work.session_id || input.promoted_seq === null) return yield* failure("RECOVERY_CONFLICT")
  const [additional] = yield* tx.all<{ children: number; runs: number; unsupported: number }>(sql`SELECT
    (SELECT count(*) FROM work_execution WHERE root_work_id=${work.root_work_id} AND work_id!=${work.work_id}) children,
    (SELECT count(*) FROM task_run WHERE parent_session_id=${work.session_id}) runs,
    (SELECT count(*) FROM goal_child_unit WHERE parent_session_id=${work.session_id} OR child_session_id=${work.session_id})
      +(SELECT count(*) FROM work_execution WHERE root_work_id=${work.root_work_id} AND work_id!=${work.work_id}
        AND (parent_work_id IS NOT ${work.work_id} OR outcome!='succeeded')) unsupported`)
  if (!additional || additional.unsupported!==0 || additional.children<1 || additional.children>128 ||
    additional.children!==additional.runs || additional.children!==observation.tasks.length) return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
  const turns = yield* tx.select().from(V2ProviderTurnReceiptTable)
    .where(eq(V2ProviderTurnReceiptTable.session_id, SessionSchema.ID.make(work.session_id)))
    .orderBy(asc(V2ProviderTurnReceiptTable.provider_turn_seq)).limit(33).all()
  const rootReservations = yield* tx.select().from(WorkDispatchReservationTable)
    .where(eq(WorkDispatchReservationTable.root_work_id, work.root_work_id)).limit(33).all()
  const reservations = rootReservations.filter((row) => row.work_id===work.work_id)
  const counts = yield* tx.select({ key: WorkCountAcquisitionTable.turn_key }).from(WorkCountAcquisitionTable)
    .where(eq(WorkCountAcquisitionTable.work_id, work.work_id)).limit(33).all()
  const admissions = yield* tx.select().from(V2ToolEffectAdmissionTable)
    .where(eq(V2ToolEffectAdmissionTable.session_id, work.session_id)).limit(129).all()
  if (!turns.length || turns.length > 32 || counts.length !== turns.length || reservations.length !== turns.length ||
    rootReservations.length>32 || rootReservations.some((row) => row.state!=="settled") || admissions.length > 128 ||
    observation.proofs.length+observation.tasks.length !== admissions.length) return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
  const activity = yield* tx.select().from(SessionActivityTable).where(eq(SessionActivityTable.activity_id, turns[0].activity_id)).get()
  if (!activity || activity.session_id !== work.session_id || activity.trigger_input_id !== work.input_id ||
    activity.state !== "active" || activity.settled_at !== null) return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
  const providers: Array<typeof WorkTaskKnownProofSchema.Provider.Type> = []
  const tools: Array<typeof WorkKnownRecoverySchema.Tool.Type> = []
  const tasks: Array<typeof WorkKnownRecoveryV2Schema.Task.Type> = []
  for (const turn of turns) {
    if (turn.state !== "settled" || turn.user_message_id !== work.input_id || turn.activity_id !== turns[0].activity_id ||
      !turn.provider_attempt_id || !turn.outcome_artifact || turn.error_code !== null ||
      turn.outcome_hash !== hash(turn.outcome_artifact)) return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
    const finish = turn.outcome_artifact.flatMap((event) => {
      const decoded = Schema.decodeUnknownOption(Finish)(event)
      return Option.isSome(decoded) ? [decoded.value] : []
    })
    const calls = turn.outcome_artifact.flatMap((event) => {
      const decoded = Schema.decodeUnknownOption(ToolCall)(event)
      return Option.isSome(decoded) ? [decoded.value] : []
    })
    if (finish.length !== 1 || finish[0].reason !== "tool-calls" || !calls.length ||
      hash(turn.outcome_artifact.at(-1)) !== hash(finish[0]) || new Set(calls.map((call) => call.id)).size !== calls.length)
      return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
    const attempt = yield* tx.select().from(SessionProviderAttemptTable).where(eq(SessionProviderAttemptTable.attempt_id, turn.provider_attempt_id)).get()
    const owner = yield* tx.select().from(SessionProviderOwnerLeaseTable).where(eq(SessionProviderOwnerLeaseTable.owner_token, turn.owner_token)).get()
    if (!owner || (owner.released_at === null && owner.lease_expires_at > Date.now())) return yield* failure("RECOVERY_OWNER_ACTIVE")
    const reservation = reservations.find((row) => row.receipt_id === turn.receipt_id)
    const slot = yield* tx.select({ key: WorkCountAcquisitionTable.turn_key }).from(WorkCountAcquisitionTable)
      .where(eq(WorkCountAcquisitionTable.provider_receipt_id, turn.receipt_id)).get()
    const count = slot?.key ? yield* WorkCountAcquisition.getTurn(tx, work.work_id, slot.key) : undefined
    if (!attempt || attempt.state !== "settled" || attempt.session_id !== work.session_id ||
      attempt.owner_token !== turn.owner_token || attempt.activity_id !== turn.activity_id ||
      (turn === turns.at(-1) && attempt.execution_claim_token !== request.expectedClaimToken) ||
      attempt.provider_turn_seq !== turn.provider_turn_seq || attempt.prepared_turn_hash !== turn.prepared_turn_hash ||
      attempt.wire_request_hash !== turn.wire_request_hash || !count || count.state !== "settled" || !count.result ||
      count.binding.providerAttemptID !== attempt.attempt_id || count.binding.providerReceiptID !== turn.receipt_id ||
      count.binding.bindingHash !== work.binding_hash || count.binding.sourceRecordHash !== work.source_record_hash ||
      count.binding.sessionClaimToken !== attempt.execution_claim_token || count.binding.providerOwnerToken !== turn.owner_token ||
      !reservation || reservation.state !== "settled" || !reservation.actual_usage || reservation.attempt_id !== attempt.attempt_id ||
      reservation.owner_token !== turn.owner_token || reservation.session_claim_token !== attempt.execution_claim_token ||
      reservation.work_id !== work.work_id || reservation.input_bound.tokens !== count.result.inputTokens)
      return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
    const usage = WorkAuthorityPolicy.usageTotal(reservation.actual_usage)
    if (!usage.ok || usage.value !== reservation.charged_tokens) return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
    const matched = admissions.filter((row) => row.receipt_id === turn.receipt_id)
    if (matched.length !== calls.length) return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
    for (const admission of matched) {
      const call = calls.find((item) => item.id===admission.tool_call_id)
      if (admission.tool_name === "task") {
        const observed = observation.tasks.find((item) => item.admissionID===admission.admission_id)
        if (!observed || !call || call.name!=="task" || admission.effect_kind!=="mutating" ||
          admission.provider_attempt_id!==attempt.attempt_id || admission.owner_token!==turn.owner_token ||
          observed.receiptID!==turn.receipt_id || observed.attemptID!==attempt.attempt_id ||
          observed.ownerToken!==turn.owner_token || observed.sessionClaimToken!==attempt.execution_claim_token)
          return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
        const proof = yield* WorkChildAuthority.requireHistoricalTerminal(tx, work, { admissionID: admission.admission_id,
          inputHash: hash(call.input), outcomeHash: observed.outcomeHash })
        if (hash(proof)!==hash(observed)) return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
        tasks.push({ proofID: proof.proofID, proofHash: hash(proof), admissionID: proof.admissionID,
          effectID: proof.effectID, outcomeHash: proof.outcomeHash, childWorkID: proof.childWorkID })
        continue
      }
      const proofColumn = admission.tool_name === "managed_command" && admission.effect_kind === "mutating"
        ? V2ToolEffectTable.known_command_proof : admission.effect_kind === "read_only"
          ? V2ToolEffectTable.known_read_proof : V2ToolEffectTable.known_write_proof
      const row = yield* tx.select({ effect: { effect_id: V2ToolEffectTable.effect_id, session_id: V2ToolEffectTable.session_id,
          provider_attempt_id: V2ToolEffectTable.provider_attempt_id, receipt_id: V2ToolEffectTable.receipt_id,
          tool_call_id: V2ToolEffectTable.tool_call_id, tool_name: V2ToolEffectTable.tool_name,
          effect_kind: V2ToolEffectTable.effect_kind, state: V2ToolEffectTable.state,
          outcome_hash: V2ToolEffectTable.outcome_hash, error_code: V2ToolEffectTable.error_code,
          grant_receipt_id: V2ToolEffectTable.grant_receipt_id, grant_owner_id: V2ToolEffectTable.grant_owner_id,
          grant_state: V2ToolEffectTable.grant_state, grant_version: V2ToolEffectTable.grant_version,
          owner_token: V2ToolEffectTable.owner_token, time_created: V2ToolEffectTable.time_created },
        sealedProof: proofColumn, proofBytes: sql<number>`length(CAST(${proofColumn} AS BLOB))` }).from(V2ToolEffectTable)
        .where(and(eq(V2ToolEffectTable.receipt_id, turn.receipt_id), eq(V2ToolEffectTable.tool_call_id, admission.tool_call_id),
          sql`length(CAST(${proofColumn} AS BLOB)) BETWEEN 1 AND 16384`)).get()
      const proof = observation.proofs.find((item) => item.admissionID === admission.admission_id)
      if (!row || !proof || !call || row.effect.state !== "settled" || row.effect.effect_kind !== (proof.toolID === "read" ? "read_only" : "mutating") ||
        row.effect.error_code !== null || !row.sealedProof || row.effect.outcome_hash !== proof.outcomeHash ||
        admission.provider_attempt_id !== attempt.attempt_id || admission.owner_token !== turn.owner_token ||
        row.effect.owner_token !== turn.owner_token || call.name !== proof.toolID || admission.tool_name !== proof.toolID ||
        proof.inputHash !== hash(call.input) || proof.workID !== work.work_id || proof.bindingHash !== work.binding_hash ||
        proof.receiptID !== turn.receipt_id || proof.attemptID !== attempt.attempt_id || proof.sessionClaimToken !== attempt.execution_claim_token)
        return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
      tools.push({ effectID: row.effect.effect_id, admissionID: admission.admission_id,
        receiptID: turn.receipt_id, attemptID: attempt.attempt_id, toolCallID: admission.tool_call_id,
        // This is the original public 16-column contract. Adding nullable private native
        // proof columns must not change already authenticated recovery evidence.
        effectHash: hash({ effect_id: row.effect.effect_id, session_id: row.effect.session_id,
          provider_attempt_id: row.effect.provider_attempt_id, receipt_id: row.effect.receipt_id,
          tool_call_id: row.effect.tool_call_id, tool_name: row.effect.tool_name,
          effect_kind: row.effect.effect_kind, state: row.effect.state, outcome_hash: row.effect.outcome_hash,
          error_code: row.effect.error_code, grant_receipt_id: row.effect.grant_receipt_id,
          grant_owner_id: row.effect.grant_owner_id, grant_state: row.effect.grant_state,
          grant_version: row.effect.grant_version, owner_token: row.effect.owner_token,
          time_created: row.effect.time_created }), outcomeHash: proof.outcomeHash,
        proofHash: Hash.sha256(row.sealedProof), controlRevision: proof.controlRevision })
    }
    providers.push({ workID: work.work_id, receiptID: turn.receipt_id, attemptID: attempt.attempt_id, providerTurnSeq: turn.provider_turn_seq,
      receiptHash: hash({ ...turn, prepared_turn: undefined, outcome_artifact: undefined }), attemptHash: hash(attempt), ownerToken: turn.owner_token,
      countID: count.acquisitionID, countRecordHash: hash(count), reservationID: reservation.reservation_id,
      reservationHash: hash(reservation), chargedTokens: reservation.charged_tokens })
  }
  const allProviders = [...providers,...observation.tasks.flatMap((task) => task.providers)]
  const [allCounts] = yield* tx.all<{ count: number }>(sql`SELECT count(*) count FROM work_count_acquisition c
    JOIN work_execution w ON w.work_id=c.work_id WHERE w.root_work_id=${work.root_work_id}`)
  if (tools.length+tasks.length !== admissions.length || new Set(tasks.map((task) => task.childWorkID)).size!==tasks.length ||
    new Set(allProviders.map((provider) => provider.receiptID)).size!==allProviders.length || allProviders.length!==rootReservations.length ||
    allCounts?.count!==allProviders.length || allProviders.some((provider) => !rootReservations.some((row) =>
      row.reservation_id===provider.reservationID && hash(row)===provider.reservationHash)) ||
    allProviders.reduce((sum, item) => sum + item.chargedTokens, 0) > work.binding.budget.maxTotalTokens)
    return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
  return { work, evidence: { ...observation.base, activityID: turns[0].activity_id, providers: allProviders, tools, tasks } }
}, preserve)

export function commandHash(principal: Principal, request: WorkKnownRecoveryV2Schema.Request) {
  return hash({ version: 2, instanceID: principal.instanceID, operatorID: principal.operatorID, ...request })
}
function receipt(record: WorkKnownRecoveryV2Schema.Record, replayed: boolean): WorkKnownRecoveryV2Schema.Receipt {
  return { recoveryID: record.recoveryID, workID: record.workID, sessionID: record.sessionID, requestID: record.requestID,
    action: record.action, oldClaimToken: record.oldClaimToken, controlRevision: record.controlRevision,
    createdAt: record.createdAt, replayed, continuation: "not_started" }
}
function retry(record: WorkKnownRecoveryV2Schema.Record, requestHash: string) {
  return record.requestHash === requestHash ? Effect.succeed(receipt(record, true)) : Effect.fail(failure("RECOVERY_CONFLICT"))
}
function decode<A>(schema: Schema.Decoder<A>, value: unknown, code: WorkKnownRecoverySchema.Error["code"] = "RECOVERY_INVALID_RECORD") {
  const decoded = Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(value)
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(failure(code))
}
function columns(record: WorkKnownRecoveryV2Schema.Record, mac: string) {
  return { recovery_id: record.recoveryID, version: record.version, instance_id: record.instanceID, operator_id: record.operatorID,
    work_id: record.workID, root_work_id: record.rootWorkID, session_id: record.sessionID, input_id: record.inputID,
    request_id: record.requestID, action: record.action, old_claim_token: record.oldClaimToken, control_revision: record.controlRevision,
    operator_revision: record.operatorRevision, source_revision: record.sourceRevision, approval_revision: record.approvalRevision,
    binding_hash: record.bindingHash, request_hash: record.requestHash, evidence_hash: record.evidenceHash,
    record_hash: hash(record), mac, created_at: record.createdAt, record: CanonicalJson.stringify(record) }
}
function preserve<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.mapError((error) => error instanceof WorkKnownRecoverySchema.Error ? error : failure("RECOVERY_UNAVAILABLE")))
}


/** A narrowly authenticated revision bridge. Historical proof/charge bytes remain unchanged;
 * the next turn still needs current source, route, count and owner authorization. */
export const requireBridge = Effect.fn("WorkKnownRecoveryV2.requireBridge")(function* (
  tx: Tx, work: WorkAuthority.Work,
  item: { readonly tool: { effectID: string; proofHash: string; outcomeHash: string; controlRevision: number } }
    | { readonly reservation: typeof WorkDispatchReservationTable.$inferSelect },
) {
  const entry = yield* CurrentContinuation
  if (!entry?.active || !entry.entered || entry.record.workID!==work.work_id) return yield* failure("RECOVERY_UNAVAILABLE")
  const rows = yield* tx.select({ id: WorkKnownRecoveryV2Table.recovery_id }).from(WorkKnownRecoveryV2Table)
    .where(and(eq(WorkKnownRecoveryV2Table.work_id, work.work_id),
      eq(WorkKnownRecoveryV2Table.control_revision, work.control_revision))).limit(33).all()
  if (rows.length > 32) return yield* failure("RECOVERY_INVALID_RECORD")
  for (const row of rows) {
    const record = yield* read(tx, eq(WorkKnownRecoveryV2Table.recovery_id, row.id), entry.verify)
    if (!record || record.bindingHash !== work.binding_hash || record.rootWorkID !== work.root_work_id ||
      record.sessionID !== work.session_id || record.inputID !== work.input_id || record.sourceRevision !== work.source_revision ||
      record.evidence.sourceRecordHash !== work.source_record_hash || record.evidence.sourceID !== work.binding.source.sourceID)
      continue
    if ("tool" in item && record.evidence.tools.some((tool) => tool.effectID === item.tool.effectID &&
      tool.proofHash === item.tool.proofHash && tool.outcomeHash === item.tool.outcomeHash && tool.controlRevision === item.tool.controlRevision)) return
    if ("reservation" in item && record.evidence.providers.some((provider) =>
      provider.reservationID === item.reservation.reservation_id && provider.reservationHash === hash(item.reservation))) return
  }
  return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
}, preserve)

/** A historical task is consumable only in the original first committed explicit parent
 * continuation. A serialized recovery receipt, GET, startup or advisory wake cannot enter. */
export const historicalTask = Effect.fn("WorkKnownRecoveryV2.historicalTask")(function* (
  tx: Tx, work: WorkAuthority.Work, input: { admissionID: string; inputHash: string; outcomeHash: string },
) {
  const entry = yield* CurrentContinuation
  if (!entry?.active || !entry.entered) return undefined
  yield* requireContinuation(tx, work)
  const proof = yield* WorkChildAuthority.requireHistoricalTerminal(tx, work, input)
  if (!entry.record.evidence.tasks.some((item) => item.proofID===proof.proofID && item.proofHash===hash(proof) &&
    item.admissionID===proof.admissionID && item.effectID===proof.effectID && item.outcomeHash===proof.outcomeHash &&
    item.childWorkID===proof.childWorkID)) return yield* failure("RECOVERY_EVIDENCE_UNKNOWN")
  return proof
}, preserve)

export const hasContinuation = Effect.gen(function* () {
  const entry = yield* CurrentContinuation
  return entry?.active===true && entry.entered
})


/** Commit once before the caller explicitly resumes the original Session. A lost post-commit
 * acknowledgement leaves a durable intent; exact retry never dispatches again. */
export const recordResume = Effect.fn("WorkKnownRecoveryV2.recordResume")(function* (db: Db, input: WorkKnownRecoveryV2Schema.ResumeRequest) {
  const request = yield* decode(WorkKnownRecoveryV2Schema.ResumeRequest, input, "RECOVERY_INVALID_REQUEST")
  const host = yield* authority
  const principal = yield* host.principal
  const original = yield* read(db, eq(WorkKnownRecoveryV2Table.recovery_id, request.recoveryID))
  if (!original || original.instanceID !== principal.instanceID || original.operatorID !== principal.operatorID)
    return yield* failure("RECOVERY_NOT_FOUND")
  const requestHash = hash({ version: 2, ...principal, ...request })
  const previous = yield* readResume(db, request.recoveryID)
  if (previous) return yield* resumeRetry(previous, requestHash)
  const command = yield* db.select({ id: WorkKnownRecoveryResumeV2Table.recovery_id }).from(WorkKnownRecoveryResumeV2Table)
    .where(and(eq(WorkKnownRecoveryResumeV2Table.instance_id, principal.instanceID),
      eq(WorkKnownRecoveryResumeV2Table.operator_id, principal.operatorID), eq(WorkKnownRecoveryResumeV2Table.work_id, original.workID),
      eq(WorkKnownRecoveryResumeV2Table.request_id, request.requestID))).get()
  if (command) return yield* failure("RECOVERY_CONFLICT")
  if (original.action !== "recover_only" || request.expectedControlRevision !== original.controlRevision) return yield* failure("RECOVERY_CONFLICT")
  const witness = yield* host.prepareResume(original, request)
  return yield* db.transaction((tx) => Effect.gen(function* () {
    const prior = yield* readResume(tx, request.recoveryID)
    if (prior) return yield* resumeRetry(prior, requestHash)
    const recovery = yield* read(tx, eq(WorkKnownRecoveryV2Table.recovery_id, request.recoveryID))
    if (!recovery || hash(recovery) !== hash(original)) return yield* failure("RECOVERY_CONFLICT")
    const observation = yield* host.current(tx, witness)
    if (hash(observation.principal) !== hash(principal)) return yield* failure("RECOVERY_AUTH_REQUIRED")
    const current = yield* facts(tx, requestOf(recovery), observation, true)
    if (hash(current.evidence) !== recovery.evidenceHash || current.work.binding_hash !== recovery.bindingHash)
      return yield* failure("RECOVERY_CONFLICT")
    const record: WorkKnownRecoveryV2Schema.ResumeRecord = {
      version: 2, recoveryID: recovery.recoveryID, ...principal,
      workID: recovery.workID, sessionID: recovery.sessionID, requestID: request.requestID,
      controlRevision: request.expectedControlRevision, operatorRevision: observation.operatorRevision,
      sourceRevision: current.work.source_revision, approvalRevision: observation.approvalRevision,
      bindingHash: current.work.binding_hash, recoveryRecordHash: hash(recovery), requestHash, createdAt: Date.now(),
    }
    if (Buffer.byteLength(CanonicalJson.stringify(yield* decode(WorkKnownRecoveryV2Schema.ResumeRecord, record))) > WorkKnownRecoveryV2Schema.MAX_RESUME_RECORD_BYTES)
      return yield* failure("RECOVERY_CAPACITY")
    const mac = yield* host.authenticateResume(tx, witness, record)
    yield* tx.insert(WorkKnownRecoveryResumeV2Table).values(resumeColumns(record, mac))
    const result = resumeReceipt(record, false)
    yield* registerContinuation(db, result, recovery, record)
    return result
  }), { behavior: "immediate" })
}, preserve)

export const readResume = Effect.fn("WorkKnownRecoveryV2.readResume")(function* (db: Pick<Db, "select">, recoveryID: string) {
  const where = eq(WorkKnownRecoveryResumeV2Table.recovery_id, recoveryID)
  const size = yield* db.select({ size: sql<number>`length(CAST(${WorkKnownRecoveryResumeV2Table.record} AS BLOB))` })
    .from(WorkKnownRecoveryResumeV2Table).where(where).get()
  if (!size) return undefined
  if (!Number.isSafeInteger(size.size) || size.size < 1 || size.size > WorkKnownRecoveryV2Schema.MAX_RESUME_RECORD_BYTES)
    return yield* failure("RECOVERY_INVALID_RECORD")
  const row = yield* db.select().from(WorkKnownRecoveryResumeV2Table).where(and(where,
    sql`length(CAST(${WorkKnownRecoveryResumeV2Table.record} AS BLOB)) BETWEEN 1 AND ${WorkKnownRecoveryV2Schema.MAX_RESUME_RECORD_BYTES}`)).get()
  if (!row) return yield* failure("RECOVERY_INVALID_RECORD")
  const record = yield* decode(Schema.fromJsonString(WorkKnownRecoveryV2Schema.ResumeRecord), row.record)
  if (hash(resumeColumns(record, row.mac)) !== hash(row) || record.requestHash !== hash({ version: 2,
    instanceID: record.instanceID, operatorID: record.operatorID, recoveryID: record.recoveryID,
    requestID: record.requestID, expectedControlRevision: record.controlRevision })) return yield* failure("RECOVERY_INVALID_RECORD")
  yield* (yield* authority).verifyResume(record, row.mac)
  return record
}, preserve)

export function requestOf(record: WorkKnownRecoveryV2Schema.Record): WorkKnownRecoveryV2Schema.Request {
  return { workID: record.workID, sessionID: record.sessionID, requestID: record.requestID,
    expectedClaimToken: record.oldClaimToken, expectedControlRevision: record.controlRevision, action: record.action }
}
function resumeColumns(record: WorkKnownRecoveryV2Schema.ResumeRecord, mac: string) {
  return { recovery_id: record.recoveryID, version: record.version, instance_id: record.instanceID,
    operator_id: record.operatorID, work_id: record.workID, session_id: record.sessionID, request_id: record.requestID,
    control_revision: record.controlRevision, operator_revision: record.operatorRevision, source_revision: record.sourceRevision,
    approval_revision: record.approvalRevision, binding_hash: record.bindingHash, recovery_record_hash: record.recoveryRecordHash,
    request_hash: record.requestHash, record_hash: hash(record), mac, created_at: record.createdAt, record: CanonicalJson.stringify(record) }
}
function resumeReceipt(record: WorkKnownRecoveryV2Schema.ResumeRecord, replayed: boolean): WorkKnownRecoveryV2Schema.ResumeReceipt {
  return { recoveryID: record.recoveryID, workID: record.workID, sessionID: record.sessionID, requestID: record.requestID,
    controlRevision: record.controlRevision, createdAt: record.createdAt, replayed, continuation: "recorded" }
}
function resumeRetry(record: WorkKnownRecoveryV2Schema.ResumeRecord, requestHash: string) {
  return record.requestHash === requestHash ? Effect.succeed(resumeReceipt(record, true)) : Effect.fail(failure("RECOVERY_CONFLICT"))
}


function registerContinuation(db: Db, receipt: object, record: WorkKnownRecoveryV2Schema.Record, resume?: WorkKnownRecoveryV2Schema.ResumeRecord) {
  return Effect.gen(function* () {
    const { WorkExecutionProfile } = yield* Effect.promise(() => import("./work-execution-profile"))
    const installed = yield* Effect.serviceOption(WorkExecutionProfile.Services)
    // Bare-core stores can record history, but cannot mint a runnable host continuation.
    if (Option.isNone(installed)) return
    const entry = { db, installed: installed.value, record, resume, active: true, entered: false, verify: (yield* authority).verify }
    continuations.set(receipt, entry)
    yield* Effect.addFinalizer(() => Effect.sync(() => { entry.active = false; continuations.delete(receipt) }))
  })
}

/** No factory/JSON mint: only the exact first committed receipt object in this live Scope can
 * enter once. The reference follows the existing global coordinator fiber and never an HTTP DTO. */
export function withContinuation<A, E, R>(receipt: WorkKnownRecoveryV2Schema.Receipt | WorkKnownRecoveryV2Schema.ResumeReceipt,
  effect: Effect.Effect<A, E, R>) {
  return Effect.suspend<A, E | WorkKnownRecoverySchema.Error, R>(() => {
    const entry = continuations.get(receipt)
    if (!entry?.active || entry.entered || receipt.replayed) return Effect.fail(failure("RECOVERY_UNAVAILABLE"))
    entry.entered = true
    return effect.pipe(Effect.provideService(CurrentContinuation, entry),
      Effect.ensuring(Effect.sync(() => { entry.active = false; continuations.delete(receipt) })))
  })
}

/** Only SessionExecutionLocal's trusted coordinator constructor consumes this capture. The
 * wrapper contains one private live witness, never the caller's general service environment. */
export const captureContinuation = (sessionID: string) => Effect.gen(function* () {
  const entry = yield* CurrentContinuation
  if (!entry?.active || !entry.entered || entry.record.sessionID !== sessionID) return undefined
  return (effect: Effect.Effect<void>) => effect.pipe(Effect.provideService(CurrentContinuation, entry))
})

/** Check before claim, Location loading, Context and every continuation. A durable receipt or
 * even an unused resume intent is not permission for startup/advisory/public replay. */
export const requireContinuation = Effect.fn("WorkKnownRecoveryV2.requireContinuation")(function* (
  db: Pick<Db, "select">, work: WorkAuthority.Work,
) {
  const entry = yield* CurrentContinuation
  // Claims are random identities, not an ordering. The private first-commit witness names its
  // exact immutable record; absent that witness, any recovery history fences ordinary replay.
  if (entry && entry.record.workID !== work.work_id) return yield* failure("RECOVERY_UNAVAILABLE")
  const row = yield* db.select({ id: WorkKnownRecoveryV2Table.recovery_id, hash: WorkKnownRecoveryV2Table.record_hash })
    .from(WorkKnownRecoveryV2Table).where(and(eq(WorkKnownRecoveryV2Table.work_id, work.work_id),
      entry ? eq(WorkKnownRecoveryV2Table.recovery_id, entry.record.recoveryID) : undefined)).get()
  if (!row) {
    if (entry) return yield* failure("RECOVERY_UNAVAILABLE")
    return
  }
  const { WorkExecutionProfile } = yield* Effect.promise(() => import("./work-execution-profile"))
  const { Database } = yield* Effect.promise(() => import("../database/database"))
  const installed = yield* Effect.serviceOption(WorkExecutionProfile.Services)
  const database = yield* Effect.serviceOption(Database.Service)
  if (!entry?.active || !entry.entered || Option.isNone(installed) || Option.isNone(database) ||
    entry.db !== database.value.db || entry.installed !== installed.value || entry.record.recoveryID !== row.id ||
    hash(entry.record) !== row.hash || entry.record.workID !== work.work_id || entry.record.sessionID !== work.session_id ||
    entry.record.bindingHash !== work.binding_hash || entry.record.sourceRevision !== work.source_revision ||
    entry.record.evidence.sourceRecordHash !== work.source_record_hash || entry.record.controlRevision !== work.control_revision)
    return yield* failure("RECOVERY_UNAVAILABLE")
  if (entry.record.action === "recover_only") {
    const intent = yield* db.select({ hash: WorkKnownRecoveryResumeV2Table.record_hash }).from(WorkKnownRecoveryResumeV2Table)
      .where(eq(WorkKnownRecoveryResumeV2Table.recovery_id, row.id)).get()
    if (!entry.resume || !intent || intent.hash !== hash(entry.resume)) return yield* failure("RECOVERY_UNAVAILABLE")
  }
}, preserve)
