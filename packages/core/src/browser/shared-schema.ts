export * as SharedBrowserSchema from "./shared-schema"

import { Schema } from "effect"
import { BrowserSchema } from "./schema"
import { BrowserFileSchema } from "./file-exchange.schema"

export const PROFILE = "managed-shared-browser-v1"
export const INPUT_ASSURANCE = "shared-document-v1"
export const MAX_WITNESS_BYTES = 1_024
export const MAX_SNAPSHOT_TARGETS = BrowserSchema.MAX_SNAPSHOT_TARGETS
export const MAX_RESOURCE_WITNESS_BYTES = 512_000
export const Origin = Schema.Union([BrowserSchema.Origin, BrowserSchema.PublicOrigin])
export const Origins = Schema.Array(Origin).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8),
  Schema.makeFilter((values) => new Set(values).size === values.length),
)
export const PostGrant = Schema.Struct({
  method: Schema.Literal("POST"),
  url: BrowserSchema.Address,
  contentType: BrowserSchema.ApiPostContentType,
  bodySha256: BrowserSchema.Digest,
  bytes: BrowserSchema.Count.check(Schema.isLessThanOrEqualTo(BrowserSchema.MAX_POST_BYTES)),
}).check(
  Schema.makeFilter(
    (value) =>
      URL.canParse(value.url) &&
      !new URL(value.url).username &&
      !new URL(value.url).password &&
      !new URL(value.url).hash &&
      new URL(value.url).href === value.url,
  ),
)
export const Policy = Schema.Struct({
  origin: Origin,
  approvedOrigins: Origins,
  manualApprovedOrigins: Origins,
  resolverPolicy: BrowserSchema.ResolverPolicy,
  postGrants: Schema.Array(PostGrant).check(Schema.isMaxLength(8)),
  scriptContext: Schema.optional(Schema.Literal("snapshot-json-v1")),
  scriptGrants: Schema.optional(BrowserSchema.ScriptGrants),
  programGrants: Schema.optional(BrowserSchema.ProgramGrants),
  filePolicy: Schema.optional(BrowserFileSchema.Policy),
}).check(
  Schema.makeFilter(
    (value) =>
      value.approvedOrigins.includes(value.origin) &&
      value.manualApprovedOrigins.includes(value.origin) &&
      value.postGrants.every((grant) => value.approvedOrigins.includes(new URL(grant.url).origin)),
  ),
)
export type Policy = typeof Policy.Type

export const Create = Schema.Struct({
  version: Schema.Literal(2),
  profile: Schema.Literal(PROFILE),
  inputAssurance: Schema.Literal(INPUT_ASSURANCE),
  requestID: BrowserSchema.ID,
  sessionID: BrowserSchema.ID,
  policy: Policy,
  expiresAt: BrowserSchema.Revision,
})
export type Create = typeof Create.Type
export const ResourceState = Schema.Literals([
  "creating",
  "agent_owned",
  "takeover_pending",
  "human_owned",
  "acquire_pending",
  "fenced_blocked",
  "recovery_required",
  "resource_lost",
  "closing",
  "closed",
])
export const ApproveOrigin = Schema.Struct({
  resourceID: BrowserSchema.ID,
  requestID: BrowserSchema.ID,
  expectedRevision: BrowserSchema.Revision,
  expectedManualEpoch: BrowserSchema.Count,
  expectedPolicyHash: BrowserSchema.Digest,
  origin: Origin,
})
export type ApproveOrigin = typeof ApproveOrigin.Type
export const PolicyApproval = Schema.Struct({
  requestID: BrowserSchema.ID,
  requestHash: BrowserSchema.Digest,
  manualEpoch: BrowserSchema.Count,
  baseRevision: BrowserSchema.Revision,
  revision: BrowserSchema.Revision,
  policyRevision: BrowserSchema.Revision,
  policyHash: BrowserSchema.Digest,
})
export const Resource = Schema.Struct({
  version: Schema.Literal(2),
  profile: Schema.Literal(PROFILE),
  inputAssurance: Schema.Literal(INPUT_ASSURANCE),
  resourceID: BrowserSchema.ID,
  requestID: BrowserSchema.ID,
  requestDigest: BrowserSchema.Digest,
  rootSessionID: BrowserSchema.ID,
  scope: BrowserSchema.Scope,
  mainIncarnation: BrowserSchema.ID,
  policy: Policy,
  policyHash: BrowserSchema.Digest,
  policyRevision: Schema.optional(BrowserSchema.Revision),
  policyApprovals: Schema.optional(Schema.Array(PolicyApproval).check(Schema.isMaxLength(14))),
  state: ResourceState,
  revision: BrowserSchema.Revision,
  manualEpoch: BrowserSchema.Count,
  barrierOrder: BrowserSchema.Count,
  coreCutoff: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
  liveLeaseID: Schema.NullOr(BrowserSchema.ID),
  agentAccessFenced: Schema.Boolean,
  resourceAlive: Schema.Boolean,
  manualEnabled: Schema.Boolean,
  createdAt: BrowserSchema.Count,
  updatedAt: BrowserSchema.Count,
  expiresAt: BrowserSchema.Revision,
}).check(
  Schema.makeFilter(
    (value) =>
      value.rootSessionID === value.scope.sessionID &&
      value.updatedAt >= value.createdAt &&
      value.expiresAt > value.createdAt &&
      (!value.manualEnabled || value.agentAccessFenced),
  ),
)
export type Resource = typeof Resource.Type
export const Lease = Schema.Struct({
  version: Schema.Literal(2),
  leaseID: BrowserSchema.ID,
  controlID: BrowserSchema.ID,
  resourceID: BrowserSchema.ID,
  mainIncarnation: BrowserSchema.ID,
  sidecarIncarnation: BrowserSchema.ID,
  scope: BrowserSchema.Scope,
  policyHash: BrowserSchema.Digest,
  leaseEpoch: BrowserSchema.Revision,
  manualEpoch: BrowserSchema.Count,
  state: Schema.Literals(["pending", "active", "revoked", "unknown"]),
  originInputID: Schema.NullOr(BrowserSchema.ID),
  requestID: BrowserSchema.ID,
  createdAt: BrowserSchema.Count,
  updatedAt: BrowserSchema.Count,
  expiresAt: BrowserSchema.Revision,
}).check(
  Schema.makeFilter(
    (value) =>
      value.leaseID === value.controlID && value.updatedAt >= value.createdAt && value.expiresAt > value.createdAt,
  ),
)
export type Lease = typeof Lease.Type

export const Takeover = Schema.Struct({
  resourceID: BrowserSchema.ID,
  requestID: BrowserSchema.ID,
  expectedRevision: BrowserSchema.Revision,
})
export type Takeover = typeof Takeover.Type
export const BarrierTicket = Schema.Struct({
  resourceID: BrowserSchema.ID,
  rootSessionID: BrowserSchema.ID,
  mainIncarnation: BrowserSchema.ID,
  requestID: BrowserSchema.ID,
  expectedRevision: BrowserSchema.Revision,
  manualEpoch: BrowserSchema.Revision,
  barrierOrder: BrowserSchema.Revision,
  reason: Schema.Literals(["human_takeover", "sidecar_lost", "lease_expired", "action_timeout", "permission_lost"]),
})
export type BarrierTicket = typeof BarrierTicket.Type
export const Observation = Schema.Struct({
  resourceID: BrowserSchema.ID,
  mainIncarnation: BrowserSchema.ID,
  manualEpoch: BrowserSchema.Count,
  barrierOrder: BrowserSchema.Count,
  resourceAlive: Schema.Boolean,
  agentAccessFenced: Schema.Boolean,
  leaseRevoked: Schema.Boolean,
  inputIsolated: Schema.Boolean,
  heldReleased: Schema.Boolean,
  transportStopped: Schema.Boolean,
  manualEnabled: Schema.Boolean,
  unknownEffects: Schema.Boolean,
  leaseID: Schema.NullOr(BrowserSchema.ID),
  leaseEpoch: BrowserSchema.Count,
})
export type Observation = typeof Observation.Type
export const Status = Schema.Struct({
  resourceID: BrowserSchema.ID,
  state: ResourceState,
  revision: BrowserSchema.Revision,
  manualEpoch: BrowserSchema.Count,
  liveLeaseID: Schema.NullOr(BrowserSchema.ID),
  resourceAlive: Schema.Boolean,
  agentAccessFenced: Schema.Boolean,
  manualEnabled: Schema.Boolean,
})
export type Status = typeof Status.Type

// Only the original Main-registered owner input bridge may issue these fields. The public
// prompt body and an origin row do not constitute a live issuer capability.
export const InputStamp = Schema.Struct({
  originalSubmissionID: BrowserSchema.ID,
  inputID: BrowserSchema.ID,
  rootSessionID: BrowserSchema.ID,
  rawInputHash: BrowserSchema.Digest,
  promptHash: Schema.optional(BrowserSchema.Digest),
  sourceKind: Schema.Literals(["gui_composer", "tui_owner", "im_owner_dac"]),
  sourceBindingHash: BrowserSchema.Digest,
  mainIncarnation: BrowserSchema.ID,
  submissionOrder: BrowserSchema.Revision,
})
export type InputStamp = typeof InputStamp.Type
export const InputOrigin = Schema.Struct({
  ...InputStamp.fields,
  promptHash: BrowserSchema.Digest,
  delivery: Schema.Literals(["steer", "queue"]),
  admittedSeq: BrowserSchema.Count,
  promotedSeq: Schema.NullOr(BrowserSchema.Count),
  originHash: BrowserSchema.Digest,
})
export type InputOrigin = typeof InputOrigin.Type
export const UserWitness = Schema.Struct({
  inputID: BrowserSchema.ID,
  rootSessionID: BrowserSchema.ID,
  mainIncarnation: BrowserSchema.ID,
  submissionOrder: BrowserSchema.Revision,
  admittedSeq: BrowserSchema.Count,
  promotedSeq: BrowserSchema.Count,
  originHash: BrowserSchema.Digest,
  providerReceiptID: BrowserSchema.ID,
  selectionID: BrowserSchema.ID,
  projectionHash: BrowserSchema.Digest,
})
export type UserWitness = typeof UserWitness.Type
export const Acquire = Schema.Struct({
  resourceID: BrowserSchema.ID,
  requestID: BrowserSchema.ID,
  expectedManualEpoch: BrowserSchema.Revision,
  approvedOrigins: Schema.optional(Origins),
})
export type Acquire = typeof Acquire.Type
export const Close = Schema.Struct({
  resourceID: BrowserSchema.ID,
  requestID: BrowserSchema.ID,
  expectedRevision: BrowserSchema.Revision,
})
export type Close = typeof Close.Type
export const Action = Schema.Struct({
  actionID: BrowserSchema.ID,
  resourceID: BrowserSchema.ID,
  leaseID: BrowserSchema.ID,
  leaseEpoch: BrowserSchema.Revision,
  manualEpoch: BrowserSchema.Count,
  admissionID: BrowserSchema.ID,
  providerReceiptID: BrowserSchema.ID,
  providerAttemptID: BrowserSchema.ID,
  toolCallID: BrowserSchema.ID,
  rootSessionID: BrowserSchema.ID,
  command: BrowserSchema.Command,
  commandHash: BrowserSchema.Digest,
  deadline: BrowserSchema.Revision,
})
export type Action = typeof Action.Type
export const ActionRecord = Schema.Struct({
  ...Action.fields,
  outcome: Schema.Literals(["pending", "completed", "cancelled", "unknown"]),
  result: Schema.NullOr(BrowserSchema.Result),
  errorCode: Schema.NullOr(BrowserSchema.ErrorCode),
  createdAt: BrowserSchema.Count,
  updatedAt: BrowserSchema.Count,
})
export type ActionRecord = typeof ActionRecord.Type
export const Receipt = Schema.Struct({
  resourceID: BrowserSchema.ID,
  requestID: BrowserSchema.ID,
  kind: Schema.Literals(["takeover", "acquire", "close"]),
  requestDigest: BrowserSchema.Digest,
  manualEpoch: BrowserSchema.Count,
  state: Schema.Literals(["pending", "completed", "unknown"]),
  leaseID: Schema.NullOr(BrowserSchema.ID),
  ticket: Schema.NullOr(BarrierTicket),
  observation: Schema.NullOr(Observation),
  createdAt: BrowserSchema.Count,
  updatedAt: BrowserSchema.Count,
})
export type Receipt = typeof Receipt.Type
export const Invoke = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("status"), resourceID: BrowserSchema.ID }),
  Schema.Struct({ operation: Schema.Literal("acquire"), ...Acquire.fields }),
  Schema.Struct({
    operation: Schema.Literal("execute"),
    resourceID: BrowserSchema.ID,
    command: BrowserSchema.Command,
    timeoutMs: Schema.optional(BrowserSchema.Revision.check(Schema.isLessThanOrEqualTo(BrowserSchema.MAX_TIMEOUT_MS))),
  }),
])
export type Invoke = typeof Invoke.Type
