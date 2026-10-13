export * as WorkTaskKnownProofSchema from "./work-task-known-proof.schema"

import { Schema } from "effect"
import { WorkAuthoritySchema } from "./work-authority.schema"

export const MAX_RECORD_BYTES = 65_536
export const MAX_ROOT_PROOFS = 128
export const MAX_INSTANCE_PROOFS = 10_000
export const MAX_INSTANCE_BYTES = 33_554_432
export const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (value: string) => value.isWellFormed() && Buffer.byteLength(value) <= 512 && !value.includes("\0"),
  ),
)
export const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const Revision = Count.check(Schema.isGreaterThanOrEqualTo(1))
export const Digest = WorkAuthoritySchema.Digest

/** Hashes name original durable evidence, including private native leaf envelopes. They do
 * not turn a historical child into an executable Session or refresh any source deadline. */
export const Provider = Schema.Struct({
  workID: Text,
  receiptID: Text,
  attemptID: Text,
  providerTurnSeq: Revision,
  receiptHash: Digest,
  attemptHash: Digest,
  ownerToken: Text,
  countID: Text,
  countRecordHash: Digest,
  reservationID: Text,
  reservationHash: Digest,
  chargedTokens: Count,
})
export const Tool = Schema.Struct({
  effectID: Text,
  admissionID: Text,
  receiptID: Text,
  attemptID: Text,
  toolCallID: Text,
  admissionHash: Digest,
  effectHash: Digest,
  outcomeHash: Digest,
  proofHash: Digest,
  controlRevision: Revision,
})
export const Record = Schema.Struct({
  version: Schema.Literal(2),
  proofID: Text,
  instanceID: Text,
  rootWorkID: Text,
  parentWorkID: Text,
  childWorkID: Text,
  rootBindingHash: Digest,
  parentBindingHash: Digest,
  childBindingHash: Digest,
  grantHash: Digest,
  rootRevision: Revision,
  parentRevision: Revision,
  childRevision: Revision,
  parentSessionID: Text,
  parentInputID: Text,
  childSessionID: Text,
  childInputID: Text,
  admissionID: Text,
  effectID: Text,
  receiptID: Text,
  attemptID: Text,
  toolCallID: Text,
  ownerToken: Text,
  sessionClaimToken: Revision,
  activityID: Text,
  activityOrdinal: Count,
  triggerInputID: Text,
  expectedInputSeq: Revision,
  inputHash: Digest,
  outcomeHash: Digest,
  definitionHash: Digest,
  registrationGeneration: Text,
  taskRunID: Text,
  taskGeneration: Revision,
  taskRequestHash: Digest,
  terminalReceiptID: Text,
  terminalReceiptHash: Digest,
  rawResultMessageID: Text,
  rawResultMessageHash: Digest,
  childResultHash: Digest,
  childExpiresAt: Revision,
  sourceRecordHash: Digest,
  routeEvidenceHash: Digest,
  providers: Schema.Array(Provider).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  tools: Schema.Array(Tool).check(Schema.isMaxLength(128)),
  createdAt: Revision,
})
export type Record = typeof Record.Type
export const State = Schema.Literals(["reserved", "sealed"])
export const ErrorCode = Schema.Literals([
  "TASK_PROOF_UNAVAILABLE",
  "TASK_PROOF_CONFLICT",
  "TASK_PROOF_CAPACITY",
  "TASK_PROOF_UNKNOWN",
  "TASK_PROOF_INVALID",
])
export class Error extends Schema.TaggedErrorClass<Error>()("WorkTaskKnownProof.Error", {
  code: ErrorCode,
  message: Schema.String,
}) {}
