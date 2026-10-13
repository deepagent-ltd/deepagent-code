export * as WorkKnownRecoverySchema from "./work-known-recovery.schema"

import { Schema } from "effect"
import { WorkAuthoritySchema } from "./work-authority.schema"

export const MAX_RECORD_BYTES = 65_536
export const MAX_WORK_RECEIPTS = 32
export const MAX_INSTANCE_RECEIPTS = 10_000
export const Text = Schema.String.check(Schema.isMinLength(1),
  Schema.makeFilter((value: string) => Buffer.byteLength(value) <= 512 && !value.includes("\0")))
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const Revision = Count.check(Schema.isGreaterThanOrEqualTo(1))
export const Digest = WorkAuthoritySchema.Digest
export const Action = Schema.Literals(["recover_only", "recover_and_resume"])
export const Request = Schema.Struct({
  workID: Text,
  sessionID: Text,
  requestID: Text,
  expectedClaimToken: Revision,
  expectedControlRevision: Revision,
  action: Action,
})
export type Request = typeof Request.Type

export const Provider = Schema.Struct({
  receiptID: Text, attemptID: Text, providerTurnSeq: Revision,
  receiptHash: Digest, attemptHash: Digest, ownerToken: Text,
  countID: Text, countRecordHash: Digest, reservationID: Text, reservationHash: Digest,
  chargedTokens: Count,
})
export const Tool = Schema.Struct({
  effectID: Text, admissionID: Text, receiptID: Text, attemptID: Text, toolCallID: Text,
  effectHash: Digest, outcomeHash: Digest, proofHash: Digest, controlRevision: Revision,
})

/** An immutable recovery observation. These hashes authenticate historical facts only;
 * they do not replace the next turn's current source, route, count or budget checks. */
export const Evidence = Schema.Struct({
  activityID: Text,
  sourceID: Text,
  sourceRecordHash: Digest,
  approvalID: Text,
  approvalEvidenceHash: Digest,
  operatorGeneration: Revision,
  providerGeneration: Revision,
  installationKeyHash: Digest,
  executableHash: Digest,
  componentsHash: Digest,
  releaseID: Text,
  canonicalRoot: Schema.String.check(Schema.isMinLength(1),
    Schema.makeFilter((value: string) => Buffer.byteLength(value) <= 2048 && !value.includes("\0"))),
  rootIdentity: WorkAuthoritySchema.ProjectBinding.fields.projectScope.fields.rootIdentity,
  helperHash: Digest,
  providers: Schema.Array(Provider).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  tools: Schema.Array(Tool).check(Schema.isMaxLength(128)),
})
export type Evidence = typeof Evidence.Type

// The SQL mirror paths are deliberately top-level and stable. recordHash and MAC are
// outside this canonical record, avoiding self-referential hashing and schema guessing.
export const Record = Schema.Struct({
  version: Schema.Literal(1),
  recoveryID: Text,
  instanceID: Text,
  operatorID: Text,
  workID: Text,
  rootWorkID: Text,
  sessionID: Text,
  inputID: Text,
  requestID: Text,
  action: Action,
  oldClaimToken: Revision,
  controlRevision: Revision,
  operatorRevision: Revision,
  sourceRevision: Revision,
  approvalRevision: Revision,
  bindingHash: Digest,
  requestHash: Digest,
  evidenceHash: Digest,
  evidence: Evidence,
  createdAt: Revision,
})
export type Record = typeof Record.Type

export const Receipt = Schema.Struct({
  recoveryID: Text,
  workID: Text,
  sessionID: Text,
  requestID: Text,
  action: Action,
  oldClaimToken: Revision,
  controlRevision: Revision,
  createdAt: Revision,
  replayed: Schema.Boolean,
  // A receipt is not a claim that an optional subsequent drain ran or completed.
  continuation: Schema.Literal("not_started"),
})
export type Receipt = typeof Receipt.Type
export const ErrorCode = Schema.Literals([
  "RECOVERY_INVALID_REQUEST", "RECOVERY_AUTH_REQUIRED", "RECOVERY_UNAVAILABLE",
  "RECOVERY_NOT_FOUND", "RECOVERY_CONFLICT", "RECOVERY_OWNER_ACTIVE",
  "RECOVERY_EVIDENCE_UNKNOWN", "RECOVERY_CAPACITY", "RECOVERY_INVALID_RECORD",
])
export class Error extends Schema.TaggedErrorClass<Error>()("WorkKnownRecovery.Error", {
  code: ErrorCode,
  message: Schema.String,
}) {}


export const MAX_RESUME_RECORD_BYTES = 8_192
export const ResumeRequest = Schema.Struct({
  recoveryID: Text,
  requestID: Text,
  expectedControlRevision: Revision,
})
export type ResumeRequest = typeof ResumeRequest.Type

/** A one-shot durable continuation intent. Its presence is not an execution or completion
 * receipt; duplicate requests observe it and never wake the runner again. */
export const ResumeRecord = Schema.Struct({
  version: Schema.Literal(1),
  recoveryID: Text,
  instanceID: Text,
  operatorID: Text,
  workID: Text,
  sessionID: Text,
  requestID: Text,
  controlRevision: Revision,
  operatorRevision: Revision,
  sourceRevision: Revision,
  approvalRevision: Revision,
  bindingHash: Digest,
  recoveryRecordHash: Digest,
  requestHash: Digest,
  createdAt: Revision,
})
export type ResumeRecord = typeof ResumeRecord.Type
export const ResumeReceipt = Schema.Struct({
  recoveryID: Text,
  workID: Text,
  sessionID: Text,
  requestID: Text,
  controlRevision: Revision,
  createdAt: Revision,
  replayed: Schema.Boolean,
  continuation: Schema.Literal("recorded"),
})
export type ResumeReceipt = typeof ResumeReceipt.Type
