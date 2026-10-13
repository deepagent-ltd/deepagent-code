export * as WorkCountAcquisitionSchema from "./work-count-acquisition.schema"

import { Schema } from "effect"
import { WorkRouteApprovalSchema } from "./work-route-approval.schema"

export const MAX_RECORD_BYTES = 32_768

const Text = WorkRouteApprovalSchema.Text
const Count = WorkRouteApprovalSchema.Count
const Revision = WorkRouteApprovalSchema.Revision
const Digest = WorkRouteApprovalSchema.Digest
export const Binding = Schema.Struct({
  workID: Text,
  inputID: Text,
  sessionID: Text,
  bindingHash: Digest,
  controlRevision: Revision,
  sourceAuthorityID: Text,
  sourceRevision: Revision,
  sourceRecordHash: Digest,
  providerReceiptID: Text,
  providerAttemptID: Text,
  sessionClaimToken: Revision,
  providerOwnerToken: Text,
  approvalID: Text,
  approvalRevision: Revision,
  approvalEvidenceHash: Digest,
  configurationStamp: Digest,
  credentialFingerprint: Digest,
  credentialGeneration: Revision,
  inputTupleHash: Digest,
  countBodyHash: Digest,
  generationBodyHash: Digest,
  wireHash: Digest,
  nonsecretHeadersHash: Digest,
  sealedRequestHash: Digest,
})
export type Binding = typeof Binding.Type
export const State = Schema.Literals(["prepared", "sending", "settled", "failed", "unknown"])
export type State = typeof State.Type
export const Result = Schema.Struct({
  responseHash: Digest,
  inputTokens: Count,
  countedAt: Count,
  expiresAt: Revision,
})
export type Result = typeof Result.Type
export const Record = Schema.Struct({
  version: Schema.Literal(1),
  acquisitionID: Text,
  binding: Binding,
  state: State,
  revision: Revision,
  ownerToken: Text,
  bootID: Text,
  deadline: Revision,
  result: Schema.NullOr(Result),
  errorCode: Schema.NullOr(
    Schema.Literals(["COUNT_CANCELLED", "COUNT_OWNER_LOST", "COUNT_INVALID_RESPONSE", "COUNT_REJECTED"]),
  ),
  createdAt: Count,
  updatedAt: Count,
  sendingAt: Schema.NullOr(Count),
  terminalAt: Schema.NullOr(Count),
})
export type Record = typeof Record.Type

/** A project slot names an actual canonical turn. These codecs describe persisted data;
 * only the transactional store may prove the referenced selection, claim and predecessor.
 * The v1 store intentionally keeps using Binding/Record until the forward migration and
 * current-row checks are installed together. Decoding a v2 value never enables a successor. */
export const ProjectTurn = Schema.Struct({
  key: Digest,
  activityID: Text,
  providerTurnSeq: Revision,
  contextSelectionID: Text,
  contextProjectionHash: Digest,
  historyPromptEpoch: Count,
  historySourceEndMessageID: Schema.NullOr(Text),
})
export type ProjectTurn = typeof ProjectTurn.Type
export const ExactProjectBinding = Schema.Struct({
  ...Binding.fields,
  rootWorkID: Text,
  turn: ProjectTurn,
  predecessor: Schema.NullOr(Schema.Struct({
    acquisitionID: Text,
    receiptID: Text,
    outcomeHash: Digest,
    toolTerminalHash: Digest,
  })),
  toolAdvertisementHash: Digest,
  inputProjectionVersion: Schema.Literal("openai-responses-project-input.v1"),
  inputProjectionHash: Digest,
})
/** The physical slot still denotes one canonical project turn. This strict, independent
 * discriminator never interprets an old exact-count receipt as a local upper-bound proof. */
export const ContextBoundProjectBinding = Schema.Struct({
  ...ExactProjectBinding.fields,
  inputProjectionVersion: Schema.Literal("deepseek-responses-project-context-bound.v1"),
  counterSemantics: Schema.Literal("vendor_context_input_upper_bound"),
  inputUpperBoundTokens: Schema.Literal(1_048_576),
})
export const ProjectBinding = Schema.Union([ExactProjectBinding, ContextBoundProjectBinding])
export type ProjectBinding = typeof ProjectBinding.Type
export const ProjectRecord = Schema.Struct({
  ...Record.fields,
  version: Schema.Literal(2),
  binding: ProjectBinding,
})
export type ProjectRecord = typeof ProjectRecord.Type

export class Error extends Schema.TaggedErrorClass<Error>()("WorkCountAcquisition.Error", {
  code: Schema.Literals([
    "COUNT_UNAVAILABLE",
    "COUNT_BINDING_CONFLICT",
    "COUNT_BUSY",
    "COUNT_OWNER_CONFLICT",
    "COUNT_UNKNOWN",
    "COUNT_EXPIRED",
    "COUNT_INVALID_RECORD",
    "COUNT_INVALID_RESPONSE",
    "COUNT_REJECTED",
  ]),
  message: Schema.String,
}) {}
