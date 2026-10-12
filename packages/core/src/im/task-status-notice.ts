export * as IMTaskStatusNotice from "./task-status-notice"

import { and, asc, eq, sql } from "drizzle-orm"
import { Context, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"
import type { WorkAuthority } from "../session/work-authority"
import { IMTaskAuthority } from "./task-authority"
import { IMTaskAuthoritySchema } from "./task-authority.schema"
import { IMTaskRequestTable, IMTaskSourceTable } from "./task-authority.sql"
import { LocalOperator } from "./local-operator"
import { ReplyDeliveryID } from "./reply-delivery-id"
import { IMTaskStatusNoticeSchema } from "./task-status-notice.schema"
import { IMTaskStatusNoticeTable } from "./task-status-notice.sql"
import { MessageTable } from "./sql"

type Db = Database.Interface["db"]
type Tx = WorkAuthority.Transaction
type Reader = Pick<Db, "select">
type Managed = Effect.Success<ReturnType<typeof IMTaskAuthority.readOwnedManagementInTransaction>>
const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))
const failure = (code: IMTaskStatusNoticeSchema.Error["code"], message: string) =>
  new IMTaskStatusNoticeSchema.Error({ code, message })

export const CreationAuthority = Context.Reference<{
  readonly verify: (tx: Tx, input: { noticeID: string; original: object }) => Effect.Effect<IMTaskStatusNoticeSchema.Notice, IMTaskStatusNoticeSchema.Error>
} | undefined>("IMTaskStatusNotice.creation-authority", { defaultValue: () => undefined })
const CreationFrame = Context.Reference<object | undefined>("IMTaskStatusNotice.private-creation", { defaultValue: () => undefined })
const creations = new WeakMap<object, { db: Db; noticeID: string; original: object; authority: NonNullable<Context.Service.Shape<typeof CreationAuthority>> }>()

export const withCreation = <A, E, R>(db: Db, noticeID: string, original: object, effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const authority = yield* CreationAuthority
  if (!authority) return yield* failure("TASK_NOTICE_UNAVAILABLE", "Status notice creation authority is unavailable")
  const frame = {}
  creations.set(frame, { db, noticeID, original, authority })
  return yield* effect.pipe(Effect.provideService(CreationFrame, frame), Effect.ensuring(Effect.sync(() => creations.delete(frame))))
})

/** Same message INSERT transaction. Ordinary/results remain separate; a retry of a committed
 * message reconciles bytes only and cannot create a new disclosure or transport dispatch. */
export const requireCreationInTransaction = (tx: Tx, db: Db, message: {
  id: string; groupID: string; senderID: string; senderType: string; type: string; content: string; metadata?: unknown;
}) => Effect.gen(function* () {
  if (!message.id.startsWith("imsg_reply_")) return
  const owner = yield* tx.get<{ id: string; session_id: string; group_id: string; agent_id: string;
    trigger_message_id: string | null; reply_message_id: string; reply_text: string }>(sql`
    SELECT id,session_id,group_id,agent_id,trigger_message_id,reply_message_id,reply_text FROM im_reply_outbox WHERE delivery_message_id=${message.id}`)
  if (!owner) return yield* failure("TASK_NOTICE_UNAVAILABLE", "Reserved reply identity has no owned outbox")
  const notice = yield* readByDelivery(tx, message.id)
  if (!notice && !owner.id.startsWith("imnotice_")) return
  if (!notice || notice.outboxID !== owner.id || (notice.sessionID ?? notice.requestID) !== owner.session_id ||
    notice.groupID !== owner.group_id || notice.agentID !== owner.agent_id || notice.sourceMessageID !== owner.trigger_message_id ||
    notice.noticeID !== owner.reply_message_id || notice.text !== owner.reply_text ||
    notice.groupID !== message.groupID || notice.agentID !== message.senderID ||
    message.senderType !== "agent" || message.type !== "text" || notice.text !== message.content || message.metadata === undefined ||
    hash(message.metadata) !== hash({ type: "task_status_notice", noticeID: notice.noticeID, requestID: notice.requestID, kind: notice.kind }))
    return yield* failure("TASK_NOTICE_CHANGED", "Notice message differs from its owned fixed template")
  if (yield* tx.select({ id: MessageTable.id }).from(MessageTable).where(sql`${MessageTable.id}=${message.id}`).get()) return
  const frame = yield* CreationFrame
  const original = frame ? creations.get(frame) : undefined
  if (!original || original.db !== db || original.noticeID !== notice.noticeID)
    return yield* failure("TASK_NOTICE_UNAVAILABLE", "Original notice creation preparation is unavailable")
  if (hash(yield* original.authority.verify(tx, { noticeID: notice.noticeID, original: original.original })) !== hash(notice))
    return yield* failure("TASK_NOTICE_CHANGED", "Original notice authority changed before message creation")
})

/** A reduction receipt is durable even while its source is offline. It never accepts Work. */
export const refuse = (db: Db, input: IMTaskStatusNoticeSchema.RefuseInput) => db.transaction((tx) => Effect.gen(function* () {
  const decoded = Schema.decodeUnknownOption(IMTaskStatusNoticeSchema.RefuseInput, { onExcessProperty: "error" })(input)
  if (Option.isNone(decoded)) return yield* failure("TASK_NOTICE_INVALID", "Refusal requires the original request and revision")
  const authority = yield* IMTaskAuthority.Authority
  const principal = yield* authority.authenticateMutation(tx, "revoke")
  if (hash(yield* authority.verifyOperator(tx, principal)) !== hash(principal))
    return yield* failure("TASK_NOTICE_UNAVAILABLE", "Current reduction authority changed")
  const request = yield* tx.select().from(IMTaskRequestTable).where(eq(IMTaskRequestTable.request_id, input.requestID)).get()
  if (!request || request.instance_id !== principal.instanceID || request.actor_id !== principal.actorID)
    return yield* new IMTaskAuthoritySchema.Error({ code: "IM_TASK_NOT_VISIBLE", message: "Request is outside current operator scope" })
  if (request.target.location.directory !== input.directory)
    return yield* new IMTaskAuthoritySchema.Error({ code: "IM_TASK_FORBIDDEN", message: "Task reduction is outside this project" })
  const prior = yield* tx.select().from(IMTaskStatusNoticeTable).where(and(eq(IMTaskStatusNoticeTable.request_id, input.requestID),
    eq(IMTaskStatusNoticeTable.kind, "refused"))).get()
  if (prior) {
    const notice = yield* decodeRow(prior)
    if (notice.basis.kind !== "refused" || notice.basis.operationID !== input.operationID ||
      notice.basis.expectedRevision !== input.expectedRevision || notice.requestHash !== request.request_hash ||
      notice.requestRevision !== request.revision || request.state !== "proposed")
      return yield* failure("TASK_NOTICE_CHANGED", "Refusal identity conflicts with its original receipt")
    return { notice, receipt: refusalReceipt(notice) }
  }
  const managed = yield* IMTaskAuthority.readReductionInTransaction(tx, input)
  if (managed.grant || managed.request.state !== "proposed" || managed.request.revision !== input.expectedRevision)
    return yield* failure("TASK_NOTICE_CHANGED", "Only the unchanged unaccepted proposal can be refused")
  const notice = yield* append(tx, managed, { kind: "refused", operationID: input.operationID, expectedRevision: input.expectedRevision })
  return { notice, receipt: refusalReceipt(notice) }
}), { behavior: "immediate" })

/** Background collection reads current durable operator identity, never an interactive DTO. */
export const collect = (db: Db, requestID: string, kind?: "cancel_requested" | "recovery_required") => db.transaction((tx) => Effect.gen(function* () {
  const current = yield* LocalOperator.requireCurrent(tx)
  const request = yield* tx.select().from(IMTaskRequestTable).where(eq(IMTaskRequestTable.request_id, requestID)).get()
  if (!request) return yield* failure("TASK_NOTICE_UNAVAILABLE", "Original task request is unavailable")
  const managed = yield* IMTaskAuthority.readOwnedManagementInTransaction(tx, LocalOperator.principal(current), {
    requestID, directory: request.target.location.directory,
  })
  const basis = yield* currentBasis(tx, managed, kind)
  return basis ? yield* append(tx, managed, basis) : undefined
}), { behavior: "immediate" })

export const read = (db: Reader, noticeID: string) => Effect.gen(function* () {
  const row = yield* db.select().from(IMTaskStatusNoticeTable).where(eq(IMTaskStatusNoticeTable.notice_id, noticeID)).get()
  return row ? yield* decodeRow(row) : undefined
})

export const readByDelivery = (db: Reader, messageID: string) => Effect.gen(function* () {
  const row = yield* db.select().from(IMTaskStatusNoticeTable).where(eq(IMTaskStatusNoticeTable.delivery_message_id, messageID)).get()
  return row ? yield* decodeRow(row) : undefined
})

/** Current source verification must consume the host's original, short-lived native capture.
 * The execution grant may be revoked; this purpose discloses only the fixed status template. */
export const requireCurrentInTransaction = (tx: Tx, noticeID: string) => Effect.gen(function* () {
  const notice = yield* read(tx, noticeID)
  if (!notice) return yield* failure("TASK_NOTICE_UNAVAILABLE", "Original notice is unavailable")
  const current = yield* IMTaskAuthority.authorizeStatusSourceInTransaction(tx, { requestID: notice.requestID, directory: notice.directory })
  if (current.request.request_hash !== notice.requestHash || current.request.revision !== notice.requestRevision ||
    current.source.source_id !== notice.sourceID || current.source.message_id !== notice.sourceMessageID ||
    current.source.proof_hash !== notice.sourceProofHash || current.source.snapshot_hash !== notice.sourceSnapshotHash ||
    current.principal.instanceID !== notice.instanceID || current.principal.actorID !== notice.actorID ||
    current.request.target.agentID !== notice.agentID || current.request.target.scope.securityNamespaceID !== notice.securityNamespaceID ||
    (current.request.target.location.workspaceID ?? null) !== notice.workspaceID ||
    (current.grant?.grant_id ?? null) !== notice.grantID || (current.grant?.revision ?? null) !== notice.grantRevision ||
    (current.work?.work_id ?? null) !== notice.workID || (current.work?.session_id ?? null) !== notice.sessionID ||
    (current.work?.control_revision ?? null) !== notice.controlRevision)
    return yield* failure("TASK_NOTICE_CHANGED", "Current notice source or task status changed")
  if (notice.kind === "refused") {
    if (current.grant || current.request.state !== "proposed") return yield* failure("TASK_NOTICE_CHANGED", "Refused proposal gained an attempt")
    return notice
  }
  const basis = yield* currentBasis(tx, current, notice.kind)
  if (!basis || hash(basis) !== notice.basisHash) return yield* failure("TASK_NOTICE_CHANGED", "Original unresolved status occurrence changed")
  return notice
})

export const candidates = (db: Db, instanceID: string) => db.select().from(IMTaskStatusNoticeTable)
  .where(eq(IMTaskStatusNoticeTable.instance_id, instanceID)).orderBy(asc(IMTaskStatusNoticeTable.created_at), asc(IMTaskStatusNoticeTable.notice_id)).limit(32)

function refusalReceipt(notice: IMTaskStatusNoticeSchema.Notice): IMTaskStatusNoticeSchema.RefuseReceipt {
  if (notice.basis.kind !== "refused") throw failure("TASK_NOTICE_INVALID", "Notice is not a refusal receipt")
  return { version: 1, operationID: notice.basis.operationID, requestID: notice.requestID,
    expectedRevision: notice.basis.expectedRevision, requestRevision: notice.requestRevision, noticeID: notice.noticeID, state: "refused" }
}

function append(tx: Tx, managed: Managed, basis: IMTaskStatusNoticeSchema.Basis) {
  return Effect.gen(function* () {
    const source = yield* tx.select().from(IMTaskSourceTable).where(eq(IMTaskSourceTable.source_id, managed.request.source_id)).get()
    const group = source ? Schema.decodeUnknownOption(Schema.Struct({ group: Schema.Struct({ id: Schema.String }) }))(source.snapshot) : Option.none()
    if (!source || Option.isNone(group) || source.instance_id !== managed.request.instance_id ||
      source.proof_hash !== hash(source.proof) || source.snapshot_hash !== hash(source.snapshot))
      return yield* failure("TASK_NOTICE_UNAVAILABLE", "Original source identity is unavailable")
    const occurrenceKey = hash(["im-task-status-occurrence.v1", managed.request.request_id, basis])
    const noticeID = `imnotice_${hash([managed.request.instance_id, managed.request.request_id, occurrenceKey])}`
    const prior = yield* read(tx, noticeID)
    const value = { version: 1 as const, noticeID, instanceID: managed.request.instance_id, actorID: managed.request.actor_id,
      requestID: managed.request.request_id, requestRevision: managed.request.revision, requestHash: managed.request.request_hash,
      sourceID: source.source_id, sourceMessageID: source.message_id, sourceProofHash: source.proof_hash, sourceSnapshotHash: source.snapshot_hash,
      kind: basis.kind, occurrenceKey, basisHash: hash(basis), basis, grantID: managed.grant?.grant_id ?? null,
      grantRevision: managed.grant?.revision ?? null, workID: managed.work?.work_id ?? null, sessionID: managed.work?.session_id ?? null,
      controlRevision: managed.work?.control_revision ?? null, groupID: group.value.group.id, agentID: managed.request.target.agentID,
      directory: managed.request.target.location.directory, workspaceID: managed.request.target.location.workspaceID ?? null,
      securityNamespaceID: managed.request.target.scope.securityNamespaceID, outboxID: noticeID,
      deliveryMessageID: ReplyDeliveryID.fromOutbox(noticeID), templateVersion: 1 as const,
      text: IMTaskStatusNoticeSchema.templates[basis.kind], createdAt: prior?.createdAt ?? Date.now() }
    const decoded = Schema.decodeUnknownOption(IMTaskStatusNoticeSchema.Notice, { onExcessProperty: "error" })(value)
    if (Option.isNone(decoded)) return yield* failure("TASK_NOTICE_INVALID", "Notice exceeds the fixed template or record contract")
    if (prior) {
      if (hash(prior) !== hash(decoded.value)) return yield* failure("TASK_NOTICE_CHANGED", "Original notice identity was reused")
      return prior
    }
    const record = CanonicalJson.stringify(decoded.value)
    const budget = yield* tx.get<{ count: number; bytes: number; taskCount: number }>(sql`SELECT count(*) count,
      coalesce(sum(record_bytes+32768),0) bytes,
      coalesce(sum(CASE WHEN request_id=${managed.request.request_id} THEN 1 ELSE 0 END),0) taskCount
      FROM im_task_status_notice WHERE instance_id=${managed.request.instance_id}`)
    if (!budget || budget.count >= IMTaskStatusNoticeSchema.MAX_INSTANCE_NOTICES || budget.taskCount >= IMTaskStatusNoticeSchema.MAX_REQUEST_NOTICES ||
      budget.bytes + Buffer.byteLength(record) + IMTaskStatusNoticeSchema.RESERVED_DELIVERY_BYTES > IMTaskStatusNoticeSchema.MAX_INSTANCE_BYTES)
      return yield* failure("TASK_NOTICE_CAPACITY", "Status notice capacity is exhausted; existing receipts remain retained")
    yield* tx.insert(IMTaskStatusNoticeTable).values({ notice_id: noticeID, instance_id: value.instanceID, actor_id: value.actorID,
      request_id: value.requestID, request_revision: value.requestRevision, request_hash: value.requestHash,
      source_id: value.sourceID, source_message_id: value.sourceMessageID, source_proof_hash: value.sourceProofHash, source_snapshot_hash: value.sourceSnapshotHash,
      kind: value.kind, occurrence_key: value.occurrenceKey, basis_hash: value.basisHash, grant_id: value.grantID, grant_revision: value.grantRevision,
      work_id: value.workID, session_id: value.sessionID, control_revision: value.controlRevision, group_id: value.groupID, agent_id: value.agentID,
      outbox_id: noticeID, delivery_message_id: value.deliveryMessageID, record, record_hash: hash(decoded.value),
      record_bytes: Buffer.byteLength(record), created_at: value.createdAt }).run()
    return decoded.value
  })
}

function decodeRow(row: typeof IMTaskStatusNoticeTable.$inferSelect) {
  return Effect.gen(function* () {
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(IMTaskStatusNoticeSchema.Notice), { onExcessProperty: "error" })(row.record)
    if (Option.isNone(parsed) || Buffer.byteLength(row.record) !== row.record_bytes || hash(parsed.value) !== row.record_hash)
      return yield* failure("TASK_NOTICE_CHANGED", "Immutable notice record is invalid")
    const value = parsed.value
    if (row.notice_id !== value.noticeID || row.instance_id !== value.instanceID || row.actor_id !== value.actorID || row.request_id !== value.requestID ||
      row.request_revision !== value.requestRevision || row.request_hash !== value.requestHash || row.source_id !== value.sourceID ||
      row.source_message_id !== value.sourceMessageID || row.source_proof_hash !== value.sourceProofHash || row.source_snapshot_hash !== value.sourceSnapshotHash ||
      row.kind !== value.kind || row.occurrence_key !== value.occurrenceKey || row.basis_hash !== hash(value.basis) || value.basisHash !== row.basis_hash ||
      row.grant_id !== value.grantID || row.grant_revision !== value.grantRevision || row.work_id !== value.workID || row.session_id !== value.sessionID ||
      row.control_revision !== value.controlRevision || row.group_id !== value.groupID || row.agent_id !== value.agentID ||
      row.outbox_id !== value.outboxID || row.delivery_message_id !== value.deliveryMessageID || row.created_at !== value.createdAt ||
      value.outboxID !== value.noticeID || value.deliveryMessageID !== ReplyDeliveryID.fromOutbox(value.noticeID))
      return yield* failure("TASK_NOTICE_CHANGED", "Immutable notice mirrors changed")
    return value
  })
}

function currentBasis(tx: Tx, managed: Managed, kind?: "cancel_requested" | "recovery_required"): Effect.Effect<IMTaskStatusNoticeSchema.Basis | undefined, unknown> {
  return Effect.gen(function* () {
    if (kind !== "recovery_required" && managed.grant?.state === "revoked" && managed.grant.revoke_request_id && managed.grant.revoke_expected_revision &&
      (!managed.work || managed.work.control_state === "cancelled")) {
      const receipt = managed.work?.control_receipts.find((receipt) => receipt.requestID === `im-task-cancel:${managed.grant!.revoke_request_id}`)
      if (managed.work && (!receipt || receipt.action !== "cancel" || receipt.revision !== managed.work.control_revision || receipt.state !== "cancelled")) return undefined
      return { kind: "cancel_requested", operationID: managed.grant.revoke_request_id,
        expectedGrantRevision: managed.grant.revoke_expected_revision, grantRevision: managed.grant.revision,
        expectedControlRevision: receipt?.expectedRevision ?? null, controlRevision: receipt?.revision ?? null,
        controlReceiptHash: receipt ? hash(receipt) : null }
    }
    if (!managed.work || kind === "cancel_requested") return undefined
    const evidence = yield* recoveryEvidence(tx, managed.work)
    return evidence ? { kind: "recovery_required", evidence } : undefined
  })
}

function recoveryEvidence(tx: Tx, work: WorkAuthority.Work) {
  return Effect.gen(function* () {
    const session = yield* tx.get<{ claim: number | null }>(sql`SELECT execution_claim_token claim FROM session WHERE id=${work.session_id}`)
    if (!session || session.claim !== null) return undefined
    if (work.outcome === "unknown") return { type: "work_unknown" as const, occurrenceID: work.work_id,
      evidenceHash: hash([work.work_id, work.binding_hash, "unknown"]) }
    const count = yield* tx.get<{ acquisition_id: string; state: string; record_hash: string; record: string; binding_hash: string }>(sql`
      SELECT acquisition_id,state,record_hash,record,binding_hash FROM work_count_acquisition WHERE work_id=${work.work_id}
      AND session_id=${work.session_id} AND input_id=${work.input_id} AND binding_hash=${work.binding_hash}
      AND (state='unknown' OR (state='sending' AND deadline<=${Date.now()})) ORDER BY created_at,acquisition_id LIMIT 1`)
    if (count && count.record_hash === Hash.sha256(count.record)) return {
      type: count.state === "unknown" ? "count_unknown" as const : "count_sending_expired" as const,
      occurrenceID: count.acquisition_id, evidenceHash: hash([count.acquisition_id, count.state, count.record_hash, count.binding_hash]) }
    const admission = yield* tx.get<{ admissionID: string; receiptID: string; attemptID: string; toolCallID: string; owner: string;
      requestHash: string; preparedHash: string | null; wireHash: string | null }>(sql`
      SELECT a.admission_id admissionID,a.receipt_id receiptID,a.provider_attempt_id attemptID,a.tool_call_id toolCallID,
        a.owner_token owner,r.request_input_hash requestHash,r.prepared_turn_hash preparedHash,r.wire_request_hash wireHash
      FROM session_v2_tool_effect_admission a INNER JOIN session s ON s.id=a.session_id
      INNER JOIN session_v2_provider_turn_receipt r ON r.receipt_id=a.receipt_id AND r.session_id=a.session_id
        AND r.provider_attempt_id=a.provider_attempt_id AND r.owner_token=a.owner_token
      INNER JOIN session_provider_attempt p ON p.attempt_id=a.provider_attempt_id AND p.session_id=a.session_id AND p.owner_token=a.owner_token
        AND p.activity_id=r.activity_id AND p.provider_turn_seq=r.provider_turn_seq AND p.request_hash=r.request_input_hash
        AND p.provider_id=r.provider_id AND p.prepared_turn_hash IS r.prepared_turn_hash AND p.wire_request_hash IS r.wire_request_hash
      INNER JOIN session_provider_owner_lease l ON l.owner_token=a.owner_token
      LEFT JOIN session_v2_tool_effect e ON e.receipt_id=a.receipt_id AND e.tool_call_id=a.tool_call_id
      WHERE a.session_id=${work.session_id} AND s.execution_claim_token IS NULL AND s.workspace_id IS NULL
        AND s.v2_authority=1 AND r.owner_mode='v2' AND p.execution_claim_token>0 AND e.effect_id IS NULL
        AND (r.state IN ('settled','failed','indeterminate_after_crash') OR l.released_at IS NOT NULL OR l.lease_expires_at<=${Date.now()})
      ORDER BY a.time_created,a.admission_id LIMIT 1`)
    return admission ? { type: "tool_admission" as const, occurrenceID: admission.admissionID,
      evidenceHash: hash([admission.admissionID, admission.receiptID, admission.attemptID, admission.toolCallID,
        hash(admission.owner), admission.requestHash, admission.preparedHash, admission.wireHash]) } : undefined
  })
}
