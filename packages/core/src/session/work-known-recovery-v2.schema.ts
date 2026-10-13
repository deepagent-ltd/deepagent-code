export * as WorkKnownRecoveryV2Schema from "./work-known-recovery-v2.schema"

import { Schema } from "effect"
import { WorkKnownRecoverySchema } from "./work-known-recovery.schema"
import { WorkTaskKnownProofSchema } from "./work-task-known-proof.schema"

export const MAX_RECORD_BYTES = 131_072
export const MAX_RESUME_RECORD_BYTES = 8_192
export const MAX_WORK_RECEIPTS = 32
export const MAX_INSTANCE_RECEIPTS = 10_000
export const MAX_INSTANCE_BYTES = 33_554_432
export const Request = Schema.Struct({
  ...WorkKnownRecoverySchema.Request.fields,
  workID: WorkTaskKnownProofSchema.Text,
  sessionID: WorkTaskKnownProofSchema.Text,
  requestID: WorkTaskKnownProofSchema.Text,
})
export type Request = typeof Request.Type
export const ResumeRequest = Schema.Struct({
  ...WorkKnownRecoverySchema.ResumeRequest.fields,
  recoveryID: WorkTaskKnownProofSchema.Text,
  requestID: WorkTaskKnownProofSchema.Text,
})
export type ResumeRequest = typeof ResumeRequest.Type
export const Task = Schema.Struct({
  proofID: WorkTaskKnownProofSchema.Text,
  proofHash: WorkTaskKnownProofSchema.Digest,
  admissionID: WorkTaskKnownProofSchema.Text,
  effectID: WorkTaskKnownProofSchema.Text,
  outcomeHash: WorkTaskKnownProofSchema.Digest,
  childWorkID: WorkTaskKnownProofSchema.Text,
})
export const Evidence = Schema.Struct({
  ...WorkKnownRecoverySchema.Evidence.fields,
  providers: Schema.Array(WorkTaskKnownProofSchema.Provider).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  tasks: Schema.Array(Task).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
})
export type Evidence = typeof Evidence.Type
export const Record = Schema.Struct({
  ...WorkKnownRecoverySchema.Record.fields,
  version: Schema.Literal(2),
  evidence: Evidence,
  recoveryID: WorkTaskKnownProofSchema.Text,
  instanceID: WorkTaskKnownProofSchema.Text,
  operatorID: WorkTaskKnownProofSchema.Text,
  workID: WorkTaskKnownProofSchema.Text,
  rootWorkID: WorkTaskKnownProofSchema.Text,
  sessionID: WorkTaskKnownProofSchema.Text,
  inputID: WorkTaskKnownProofSchema.Text,
  requestID: WorkTaskKnownProofSchema.Text,
})
export type Record = typeof Record.Type
export const ResumeRecord = Schema.Struct({
  ...WorkKnownRecoverySchema.ResumeRecord.fields,
  version: Schema.Literal(2),
  recoveryID: WorkTaskKnownProofSchema.Text,
  instanceID: WorkTaskKnownProofSchema.Text,
  operatorID: WorkTaskKnownProofSchema.Text,
  workID: WorkTaskKnownProofSchema.Text,
  sessionID: WorkTaskKnownProofSchema.Text,
  requestID: WorkTaskKnownProofSchema.Text,
})
export type ResumeRecord = typeof ResumeRecord.Type
export const Receipt = WorkKnownRecoverySchema.Receipt
export type Receipt = typeof Receipt.Type
export const ResumeReceipt = WorkKnownRecoverySchema.ResumeReceipt
export type ResumeReceipt = typeof ResumeReceipt.Type
