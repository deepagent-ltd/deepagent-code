export * as GoalChildSchema from "./goal-child.schema"

import { Schema } from "effect"
import { PermissionSchema } from "../permission/schema"

export const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
export const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const Stage = Schema.Literals(["plain", "research", "finalizer.1", "finalizer.2"])
export type Stage = typeof Stage.Type
export const State = Schema.Literals([
  "reserved",
  "admitted",
  "result_recorded",
  "cancelled_before_dispatch",
  "recovery_required",
])
export type State = typeof State.Type

export const BindingV1 = Schema.Struct({
  version: Schema.Literal(1),
  unitID: Text,
  goalID: Text,
  permitID: Text,
  permitToken: Text,
  roleKey: Text,
  parentSessionID: Text,
  childSessionID: Text,
  projectID: Text,
  directory: Text,
  workspaceID: Schema.optional(Text),
  agent: Text,
  model: Schema.Struct({ providerID: Text, id: Text, variant: Schema.Literal("default") }),
  permissions: PermissionSchema.Ruleset,
  permissionPolicy: Schema.Literal("parent-exact-v1"),
  mode: Schema.Literals(["plain", "structured"]),
  initializationHash: Hash,
  planHash: Hash,
  steeringHash: Hash,
  promptPolicyHash: Hash,
  parentHash: Hash,
})
export const Policy = Schema.Struct({
  version: Schema.Literal("derived-subagent-v2"),
  parentSelector: Schema.NullOr(Text),
  parentResolvedAgentID: Text,
  parentAgentHash: Hash,
  childAgentHash: Hash,
  rosterInstanceID: Text,
  rosterGeneration: Count,
  role: Schema.Struct({
    version: Schema.Literal("owned-goal-v2"),
    kind: Schema.Literals(["worker", "reviewer", "panel"]),
    planWriteOwnGoal: Schema.Boolean,
  }),
  roleHash: Hash,
  parentAgentPermissions: PermissionSchema.Ruleset,
  parentSessionPermissions: PermissionSchema.Ruleset,
  childAgentPermissions: PermissionSchema.Ruleset,
  childSessionPermissions: PermissionSchema.Ruleset,
  planResource: Text,
  checkpointHash: Hash,
  resultSchemaHash: Hash,
})
export type Policy = typeof Policy.Type
export const BindingV2 = Schema.Struct({
  ...BindingV1.fields,
  version: Schema.Literal(2),
  permissionPolicy: Schema.Literal("derived-subagent-v2"),
  policy: Policy,
})
export const PolicyV3 = Schema.Struct({
  ...Policy.fields,
  version: Schema.Literal("derived-subagent-v3"),
  parentPlanResource: Text,
  programHash: Hash,
  activationHash: Hash,
})
export type PolicyV3 = typeof PolicyV3.Type
export const BindingV3 = Schema.Struct({
  ...BindingV1.fields,
  version: Schema.Literal(3),
  permissionPolicy: Schema.Literal("derived-subagent-v3"),
  policy: PolicyV3,
})
export const Binding = Schema.Union([BindingV1, BindingV2, BindingV3])
export type Binding = typeof Binding.Type

export const Execution = Schema.Struct({
  version: Schema.Literal(1),
  executionID: Text,
  executionInstanceID: Text,
  goalOwnerID: Text,
  claimToken: Count,
  startedSeq: Count,
  controlRevision: Count,
  state: Schema.Literals(["bound", "settled", "interrupted", "recovery_required"]),
})
export type Execution = typeof Execution.Type

// Recorded only by the native Plan leaf after its exact scratch file CAS. It is still
// a proposal: result inspection requires the matching settled owned tool effect.
export const PlanProposal = Schema.Struct({
  version: Schema.Literal(1),
  documentID: Text,
  documentVersion: Count,
  documentHash: Hash,
  toolCallID: Text,
  messageID: Text,
})
export type PlanProposal = typeof PlanProposal.Type

export const InputReceipt = Schema.Struct({
  stage: Stage,
  inputID: Text,
  promptHash: Hash,
  text: Schema.String.check(Schema.isMaxLength(262144)),
  delivery: Schema.Literal("queue"),
  admittedSeq: Schema.NullOr(Count),
  activityID: Schema.NullOr(Text),
  resultRef: Schema.NullOr(Text),
  resultHash: Schema.NullOr(Hash),
  execution: Schema.optional(Execution),
  scratch: Schema.optional(Schema.Struct({ payloadHash: Hash, version: Count, hash: Hash })),
  proposal: Schema.optional(PlanProposal),
})
export type InputReceipt = typeof InputReceipt.Type
export const Inputs = Schema.Array(InputReceipt).check(Schema.isMaxLength(3))
export const CreationReceipt = Schema.Struct({ seq: Count, sessionHash: Hash })
export type CreationReceipt = typeof CreationReceipt.Type

export class Error extends Schema.TaggedErrorClass<Error>()("GoalChild.Error", {
  code: Schema.Literals([
    "GOAL_CHILD_MANAGED",
    "GOAL_CHILD_CONFLICT",
    "GOAL_CHILD_RECOVERY_REQUIRED",
    "GOAL_CHILD_UNAVAILABLE",
    "GOAL_CHILD_INVALID_REQUEST",
  ]),
  message: Schema.String,
}) {}
