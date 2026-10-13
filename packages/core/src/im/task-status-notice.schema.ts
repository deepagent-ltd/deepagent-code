export * as IMTaskStatusNoticeSchema from "./task-status-notice.schema"

import { Schema } from "effect"
import { CanonicalJson } from "../util/canonical-json"
import { WorkAuthoritySchema } from "../session/work-authority.schema"

export const MAX_RECORD_BYTES = 32768
export const RESERVED_DELIVERY_BYTES = 32768
export const MAX_INSTANCE_BYTES = 33554432
export const MAX_INSTANCE_NOTICES = 10000
export const MAX_REQUEST_NOTICES = 32
const ID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Revision = Time.check(Schema.isGreaterThan(0))
export const Kind = Schema.Literals(["cancel_requested", "recovery_required", "refused"])
export type Kind = typeof Kind.Type
export const templates = {
  cancel_requested: "取消请求已接受；这不证明已停止，已发生的工作及未知效果仍按原状态保留。",
  recovery_required: "任务需要恢复处理；未自动重试，未知效果与已用额度仍保留。",
  refused: "此任务提议已被明确拒绝；未为该提议接受新的执行。",
} as const

export const RecoveryEvidence = Schema.Struct({
  type: Schema.Literals(["tool_admission", "count_unknown", "count_sending_expired", "dispatch_unknown", "work_unknown"]),
  occurrenceID: ID,
  evidenceHash: WorkAuthoritySchema.Digest,
})
export type RecoveryEvidence = typeof RecoveryEvidence.Type
export const Basis = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("refused"), operationID: ID, expectedRevision: Revision }),
  Schema.Struct({ kind: Schema.Literal("cancel_requested"), operationID: ID, expectedGrantRevision: Revision,
    grantRevision: Revision, expectedControlRevision: Schema.NullOr(Revision), controlRevision: Schema.NullOr(Revision),
    controlReceiptHash: Schema.NullOr(WorkAuthoritySchema.Digest) }),
  Schema.Struct({ kind: Schema.Literal("recovery_required"), evidence: RecoveryEvidence }),
])
export type Basis = typeof Basis.Type
export const Notice = Schema.Struct({
  version: Schema.Literal(1), noticeID: ID, instanceID: ID, actorID: ID, requestID: ID,
  requestRevision: Revision, requestHash: WorkAuthoritySchema.Digest,
  sourceID: ID, sourceMessageID: ID, sourceProofHash: WorkAuthoritySchema.Digest, sourceSnapshotHash: WorkAuthoritySchema.Digest,
  kind: Kind, occurrenceKey: WorkAuthoritySchema.Digest, basisHash: WorkAuthoritySchema.Digest, basis: Basis,
  grantID: Schema.NullOr(ID), grantRevision: Schema.NullOr(Revision), workID: Schema.NullOr(ID), sessionID: Schema.NullOr(ID),
  controlRevision: Schema.NullOr(Revision), groupID: ID, agentID: ID,
  directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)), workspaceID: Schema.NullOr(ID),
  securityNamespaceID: ID, outboxID: ID, deliveryMessageID: ID,
  templateVersion: Schema.Literal(1), text: Schema.String.check(Schema.makeFilter((text) => Buffer.byteLength(text) <= 1024)),
  createdAt: Time,
}).check(Schema.makeFilter((notice) => notice.kind === notice.basis.kind && notice.text === templates[notice.kind] &&
  (notice.kind !== "refused" || notice.grantID === null && notice.workID === null && notice.sessionID === null && notice.controlRevision === null) &&
  Buffer.byteLength(CanonicalJson.stringify(notice)) <= MAX_RECORD_BYTES))
export type Notice = typeof Notice.Type
export const RefuseInput = Schema.Struct({ requestID: ID, operationID: ID, expectedRevision: Revision,
  directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)) })
export type RefuseInput = typeof RefuseInput.Type
export const RefuseReceipt = Schema.Struct({ version: Schema.Literal(1), operationID: ID, requestID: ID,
  expectedRevision: Revision, requestRevision: Revision, noticeID: ID, state: Schema.Literal("refused") })
export type RefuseReceipt = typeof RefuseReceipt.Type
export const ErrorCode = Schema.Literals(["TASK_NOTICE_UNAVAILABLE", "TASK_NOTICE_CHANGED", "TASK_NOTICE_CAPACITY", "TASK_NOTICE_INVALID"])
export class Error extends Schema.TaggedErrorClass<Error>()("IMTaskStatusNotice.Error", {
  code: ErrorCode, message: Schema.String,
}) {}
