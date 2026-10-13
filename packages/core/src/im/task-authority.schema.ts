export * as IMTaskAuthoritySchema from "./task-authority.schema"

import { Schema } from "effect"
import { WorkAuthoritySchema } from "../session/work-authority.schema"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Revision = Count.check(Schema.isGreaterThan(0))
export const Principal = Schema.Struct({
  instanceID: Text,
  actorID: Text,
  revision: Revision,
  identityHash: WorkAuthoritySchema.Digest,
})
export type Principal = typeof Principal.Type

/** Fixed reader and enrollment identity. Current native observations remain outside this hash. */
export const ReaderSource = Schema.Struct({
  readerKey: WorkAuthoritySchema.Digest,
  effectKey: WorkAuthoritySchema.Digest,
  bindingKey: WorkAuthoritySchema.Digest,
  projectionKey: WorkAuthoritySchema.Digest,
  scopeKey: WorkAuthoritySchema.Digest,
  immutableHash: WorkAuthoritySchema.Digest,
  sourceHash: WorkAuthoritySchema.Digest,
  mappingID: Text,
  mappingHash: WorkAuthoritySchema.Digest,
  targetID: Text,
  workspaceID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  localUserID: Schema.Literal("server"),
  observationHash: WorkAuthoritySchema.Digest,
})

/** Only the internal source resolver may produce this proof. It is never an HTTP DTO. */
export const SourceProof = Schema.Struct({
  instanceID: Text,
  securityNamespaceID: Text,
  namespaceBindingHash: WorkAuthoritySchema.Digest,
  realmID: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  appkeyID: Schema.NullOr(Text),
  orgID: Schema.NullOr(Text),
  senderID: Text,
  receiverID: Text,
  conversationType: Schema.Literals(["local", "1", "2"]),
  conversationID: Text,
  kernelMessageID: Schema.NullOr(Text),
  intentID: Schema.NullOr(Text),
  origin: Schema.Literals(["local", "kernel_live", "history", "unverified"]),
  revision: Revision,
  generation: Revision,
  expiresAt: Count,
  proofHash: WorkAuthoritySchema.Digest,
  reader: Schema.optional(ReaderSource),
})
export type SourceProof = typeof SourceProof.Type

export const LegacyTarget = Schema.Struct({
  scope: WorkAuthoritySchema.LegacyBinding.fields.scope,
  location: WorkAuthoritySchema.Location,
  agentID: Text,
  profile: WorkAuthoritySchema.LegacyBinding.fields.profile,
  provider: WorkAuthoritySchema.ProviderRoute,
  budget: WorkAuthoritySchema.Budget,
  durationMs: Revision,
})
export const ProjectTarget = Schema.Struct({
  ...LegacyTarget.fields,
  version: Schema.Literal(2),
  profile: WorkAuthoritySchema.ProjectBinding.fields.profile,
  projectScope: WorkAuthoritySchema.ProjectBinding.fields.projectScope,
  contextPolicy: WorkAuthoritySchema.ProjectBinding.fields.contextPolicy,
  toolPolicy: WorkAuthoritySchema.ProjectBinding.fields.toolPolicy,
  childPolicy: WorkAuthoritySchema.ProjectBinding.fields.childPolicy,
})
export const Target = Schema.Union([LegacyTarget, ProjectTarget])
export type Target = typeof Target.Type

export const TargetProof = Schema.Struct({
  revision: Revision,
  recordHash: WorkAuthoritySchema.Digest,
  targetHash: WorkAuthoritySchema.Digest,
})
export type TargetProof = typeof TargetProof.Type

export const RequestState = Schema.Literals(["proposed", "accepted"])
export const GrantState = Schema.Literals(["active", "revoked"])
export const ErrorCode = Schema.Literals([
  "IM_TASK_AUTHORITY_UNAVAILABLE",
  "IM_TASK_INVALID_REQUEST",
  "IM_TASK_SOURCE_UNAVAILABLE",
  "IM_TASK_SOURCE_CHANGED",
  "IM_TASK_NOT_VISIBLE",
  "IM_TASK_FORBIDDEN",
  "IM_TASK_IDENTITY_CONFLICT",
  "IM_TASK_REVISION_CONFLICT",
  "IM_TASK_EXPIRED",
  "IM_TASK_REVOKED",
  "IM_TASK_UNSUPPORTED_ATTEMPT",
  "IM_TASK_RESULT_UNKNOWN",
])
export type ErrorCode = typeof ErrorCode.Type
export class Error extends Schema.TaggedErrorClass<Error>()("IMTaskAuthority.Error", {
  code: ErrorCode,
  message: Schema.String,
}) {}
