export * as WorkRouteApprovalSchema from "./work-route-approval.schema"

import { Schema } from "effect"
import { WorkAuthoritySchema } from "./work-authority.schema"

export const MAX_RECORD_BYTES = 262_144
export const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.makeFilter((value: string) => Buffer.byteLength(value, "utf8") <= 512),
)
export const Address = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2048),
  Schema.makeFilter((value: string) => Buffer.byteLength(value, "utf8") <= 2048),
)
export const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const Revision = Count.check(Schema.isGreaterThan(0))
export const Digest = WorkAuthoritySchema.Digest
export const Scope = Schema.Struct({
  instanceID: Text,
  operatorID: Text,
  targetID: Text,
  securityNamespaceID: Text,
  projectScopeKey: Text,
  locationKey: Text,
  canonicalRoot: Address,
  namespaceBindingHash: Digest,
})
export type Scope = typeof Scope.Type

/** All fields describe actual installed components and an explicit provider contract. They are
 * data until a trusted host capture and the record MAC have both been checked. */
export const ExactEvidence = Schema.Struct({
  ...Scope.fields,
  providerID: Text,
  routeID: Text,
  modelID: Text,
  modelRevision: Text,
  protocol: Schema.Literal("openai-responses"),
  endpoint: Address,
  counterEndpoint: Address,
  providerContractID: Text,
  providerContractHash: Digest,
  releaseID: Text,
  binaryHash: Digest,
  componentsHash: Digest,
  factoryHash: Digest,
  adapterHash: Digest,
  loweringHash: Digest,
  framingHash: Digest,
  tokenizerIdentity: Text,
  configuredTargetStamp: Digest,
  configurationStamp: Digest,
  credentialLocatorStamp: Digest,
  credentialFingerprint: Digest,
  nonsecretHeadersHash: Digest,
  completionLimit: Revision,
  expiresAt: Revision,
})
export const ContextBoundEvidence = Schema.Struct({
  ...ExactEvidence.fields,
  providerID: Schema.Literal("deepseek"),
  modelID: Schema.Literal("deepseek-flash"),
  endpoint: Schema.Literal("https://api.deepseek.com/responses"),
  counterEndpoint: Schema.Literal("dac-local://deepseek/flash/context-upper-bound-v1"),
  counterSemantics: Schema.Literal("vendor_context_input_upper_bound"),
  inputUpperBoundTokens: Schema.Literal(1_048_576),
})
export const Evidence = Schema.Union([ExactEvidence, ContextBoundEvidence])
export type Evidence = typeof Evidence.Type
export const Receipt = Schema.Struct({
  approvalID: Text,
  revision: Revision,
  state: Schema.Literals(["active", "revoked"]),
  evidenceHash: Digest,
  operatorRevision: Revision,
  policyRevision: Revision,
  credentialGeneration: Revision,
  invalidatedTargetIDs: Schema.Array(Text).check(Schema.isMaxLength(32)),
})
export type Receipt = typeof Receipt.Type
export const LegacyCommand = Schema.Struct({
  requestID: Text,
  requestHash: Digest,
  action: Schema.Literals(["approve", "revoke"]),
  expectedRevision: Count,
  receipt: Receipt,
})
/** Stable explicit command data, independent of live Config/Auth/installed artifact evidence. */
const CommandScope = {
  version: Schema.Literal(1),
  instanceID: Text,
  operatorID: Text,
  targetID: Text,
  expectedRevision: Count,
  expectedOperatorRevision: Revision,
}
export const CommandIdentity = Schema.Union([
  Schema.Struct({ ...CommandScope, action: Schema.Literal("approve"), snapshot: Text, expiresAt: Revision }),
  Schema.Struct({ ...CommandScope, action: Schema.Literal("revoke"), snapshot: Schema.Null, expiresAt: Schema.Null }),
])
export type CommandIdentity = typeof CommandIdentity.Type
export const IdentifiedCommand = Schema.Struct({
  ...LegacyCommand.fields,
  identity: CommandIdentity,
  identityHash: Digest,
})
export const Command = Schema.Union([LegacyCommand, IdentifiedCommand])
const RecordFields = {
  ...Receipt.fields,
  evidence: Evidence,
  policyHash: Digest,
  createdAt: Count,
  updatedAt: Count,
}
// v1 bytes/MAC remain valid. v2 may retain old opaque commands; they never gain inferred identity.
export const Record = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    ...RecordFields,
    commands: Schema.Array(LegacyCommand).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    ...RecordFields,
    commands: Schema.Array(Command).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
])
export type Record = typeof Record.Type

export class Error extends Schema.TaggedErrorClass<Error>()("WorkRouteApproval.Error", {
  code: Schema.Literals([
    "ROUTE_PROOF_UNAVAILABLE",
    "ROUTE_REVOKED",
    "ROUTE_REVISION_CONFLICT",
    "ROUTE_BINDING_CONFLICT",
    "ROUTE_INVALID_RECORD",
    "ROUTE_COMMAND_CAPACITY",
    "ROUTE_EXPIRED",
    "ROUTE_COMMAND_IDENTITY_UNAVAILABLE",
    "CREDENTIAL_DRIFT",
    "RUNTIME_MISMATCH",
    "NATIVE_OBSERVATION_REQUIRED",
  ]),
  message: Schema.String,
}) {}
