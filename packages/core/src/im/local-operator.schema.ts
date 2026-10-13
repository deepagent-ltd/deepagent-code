export * as LocalOperatorSchema from "./local-operator.schema"

import { Schema } from "effect"
import { IMTaskAuthoritySchema } from "./task-authority.schema"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import { EventWorkRuleSchema } from "../deepagent/event-work-rule.schema"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Revision = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const RegisteredTarget = Schema.Struct({
  id: Text,
  locationKey: Text,
  namespaceBindingHash: WorkAuthoritySchema.Digest,
  target: IMTaskAuthoritySchema.Target,
})
export type RegisteredTarget = typeof RegisteredTarget.Type
export const KERNEL_RECEIVER_LIFETIME_MS = 7 * 86_400_000
const MappingTime = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
/** Explicit operator policy, independent of any message body or live transport observation. */
export const KernelReceiver = Schema.Struct({
  id: Text,
  targetID: Text,
  realmID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096), Schema.makeFilter((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.href === value
  })),
  appkeyID: Text,
  orgID: MappingTime,
  receiverID: Text,
  localUserID: Schema.Literal("server"),
  issuedAt: MappingTime,
  expiresAt: MappingTime,
}).check(Schema.makeFilter((value) => value.expiresAt === value.issuedAt + KERNEL_RECEIVER_LIFETIME_MS))
export type KernelReceiver = typeof KernelReceiver.Type
const KernelReceivers = Schema.optional(Schema.Array(KernelReceiver).check(Schema.isMinLength(1), Schema.isMaxLength(32)))

export const LegacyPolicy = Schema.Struct({
  version: Schema.Literal(1),
  kernelReceivers: KernelReceivers,
  targets: Schema.Array(RegisteredTarget).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
})
export const ProjectPolicy = Schema.Struct({ version: Schema.Literal(2),
  kernelReceivers: KernelReceivers,
  targets: Schema.Array(RegisteredTarget).check(Schema.isMinLength(1), Schema.isMaxLength(32)) })
export const EventPolicy = Schema.Struct({ version: Schema.Literal(3),
  kernelReceivers: KernelReceivers,
  targets: ProjectPolicy.fields.targets,
  eventOrigins: Schema.Array(EventWorkRuleSchema.Origin).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
})
export const EventDagPolicy = Schema.Struct({ version: Schema.Literal(4),
  kernelReceivers: KernelReceivers, targets: ProjectPolicy.fields.targets,
  eventOrigins: Schema.Array(EventWorkRuleSchema.AnyOrigin).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
})
export const Policy = Schema.Union([LegacyPolicy, ProjectPolicy, EventPolicy, EventDagPolicy])
export type Policy = typeof Policy.Type
export const RuntimeBinding = Schema.Struct({
  instanceID: Text,
  installationKeyHash: WorkAuthoritySchema.Digest,
  credentialBinding: WorkAuthoritySchema.Digest,
})
export type RuntimeBinding = typeof RuntimeBinding.Type
export const MutationWitness = Schema.Struct({
  ...IMTaskAuthoritySchema.Principal.fields,
  credentialGeneration: Revision,
  credentialBinding: WorkAuthoritySchema.Digest,
  installationKeyHash: WorkAuthoritySchema.Digest,
})
export type MutationWitness = typeof MutationWitness.Type
export const CommandReceipt = Schema.Struct({
  instanceID: Text,
  operatorID: Text,
  revision: Revision,
  credentialGeneration: Revision,
  policyRevision: Revision,
  state: Schema.Literals(["active", "revoked"]),
})
export type CommandReceipt = typeof CommandReceipt.Type
export class Error extends Schema.TaggedErrorClass<Error>()("LocalOperator.Error", {
  code: Schema.Literals([
    "LOCAL_OPERATOR_UNAVAILABLE",
    "LOCAL_OPERATOR_AUTH_REQUIRED",
    "LOCAL_OPERATOR_CONFIG_MISMATCH",
    "LOCAL_OPERATOR_INSTALLATION_MISMATCH",
    "LOCAL_OPERATOR_REVOKED",
    "LOCAL_OPERATOR_INVALID",
    "LOCAL_OPERATOR_CONFLICT",
    "LOCAL_OPERATOR_REVISION_CONFLICT",
    "LOCAL_TASK_SCOPE_DENIED",
    "LOCAL_TASK_SOURCE_UNAVAILABLE",
    "LOCAL_TASK_LEGACY_UNSETTLED",
    "LOCAL_TASK_EXECUTION_UNAVAILABLE",
  ]),
  message: Schema.String,
}) {}
