export * as EventWorkDagSchema from "./event-work-dag.schema"

import { Schema } from "effect"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import { EventWorkPlacement } from "./event-work-placement"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Positive = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Instruction = Schema.String.check(Schema.isMinLength(1), Schema.makeFilter((value) => Buffer.byteLength(value, "utf8") <= 16_384))
export const Node = Schema.Struct({
  id: Text, agentID: Text, instruction: Instruction,
  dependencies: Schema.Array(Text).check(Schema.isMaxLength(32)),
  toolIDs: Schema.Array(Text).check(Schema.isMaxLength(128)),
  budget: WorkAuthoritySchema.Budget,
  requiresWriteIsolation: Schema.Boolean,
})
export type Node = typeof Node.Type
/** A reviewed immutable graph is an operator grant, never a model/router-produced plan. */
export const Plan = Schema.Struct({ version: Schema.Literal(1), id: Text,
  nodes: Schema.Array(Node).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  maxConcurrent: Positive.check(Schema.isLessThanOrEqualTo(2)),
}).check(Schema.makeFilter((plan) => {
  if (Buffer.byteLength(JSON.stringify(plan), "utf8") > 65_536 || new Set(plan.nodes.map((node) => node.id)).size !== plan.nodes.length ||
    plan.nodes.reduce((total, node) => total + node.dependencies.length, 0) > 128 ||
    plan.nodes.some((node) => new Set(node.dependencies).size !== node.dependencies.length || node.dependencies.includes(node.id) ||
      new Set(node.toolIDs).size !== node.toolIDs.length || node.toolIDs.includes("task") || node.budget.maxChildren !== 0 ||
      node.dependencies.some((id) => !plan.nodes.some((other) => other.id === id)))) return false
  const settled = new Set<string>()
  for (const node of plan.nodes) {
    if (!node.dependencies.every((id) => settled.has(id))) return false
    settled.add(node.id)
  }
  return true
}))
export type Plan = typeof Plan.Type
export const Terminal = Schema.Struct({ version: Schema.Literal(1), workID: Text, sessionID: Text, inputID: Text,
  nodeID: Text, controllerID: Text, bindingHash: WorkAuthoritySchema.Digest, sourceHash: WorkAuthoritySchema.Digest,
  controlRevision: Positive, outcome: Schema.Literals(["succeeded", "failed"]),
  activityID: Text, finalMessageID: Text, finalMessageHash: WorkAuthoritySchema.Digest,
  providerChainHash: WorkAuthoritySchema.Digest, effectChainHash: WorkAuthoritySchema.Digest,
  chargedTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  resultHash: WorkAuthoritySchema.Digest,
  settledAt: Positive,
  workspaceCommit: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/))),
  workspaceRef: Schema.optional(Text),
})
export type Terminal = typeof Terminal.Type
const BaselineFacts = {
  version: Schema.Literal(1), originalCommit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  scopeHash: WorkAuthoritySchema.Digest, sourceHash: WorkAuthoritySchema.Digest,
  rootIdentity: WorkAuthoritySchema.ProjectBinding.fields.projectScope.fields.rootIdentity,
  gitDirectory: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))),
  gitRootIdentity: Schema.optional(WorkAuthoritySchema.ProjectBinding.fields.projectScope.fields.rootIdentity),
  nodeID: Text, startedAt: Positive,
}
export const Baseline = Schema.Union([
  Schema.Struct({ ...BaselineFacts, state: Schema.Literal("preparing") }),
  Schema.Struct({ ...BaselineFacts, state: Schema.Literal("unknown") }),
  Schema.Struct({ ...BaselineFacts, state: Schema.Literal("sealed"),
    commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)), manifestSha256: WorkAuthoritySchema.Digest,
    files: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8192)),
    bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(67_108_864)),
    allocatedBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(EventWorkPlacement.BASELINE_CUSTODY_RESERVATION_BYTES))),
    settledRetentionAt: Schema.optional(Positive),
    sealedAt: Positive }),
])
export type Baseline = typeof Baseline.Type
export const Controller = Schema.Struct({ version: Schema.Literal(1), controllerID: Text, receiptID: Text,
  rootWorkID: Text, rootSessionID: Text, rootInputID: Text, rootBindingHash: WorkAuthoritySchema.Digest,
  plan: Plan, planHash: WorkAuthoritySchema.Digest, ruleHash: WorkAuthoritySchema.Digest, epoch: Positive,
  revision: Positive, state: Schema.Literals(["pending", "running", "succeeded", "failed", "unknown"]),
  activeNodeID: Schema.NullOr(Text),
  baseline: Schema.optional(Baseline),
  createdAt: Positive, expiresAt: Positive,
})
export type Controller = typeof Controller.Type
export const ArtifactCustody = Schema.Struct({ version: Schema.Literal(1),
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)), manifestSha256: WorkAuthoritySchema.Digest,
  files: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8192)),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(67_108_864)),
  worktreeAllocatedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  gitAllocatedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  indexAllocatedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sealedAt: Positive,
  cleanup: Schema.optional(Schema.Struct({ state: Schema.Literals(["preparing", "unknown", "collected"]), startedAt: Positive,
    completedAt: Schema.optional(Positive) })),
}).check(Schema.makeFilter((value) => Number.isSafeInteger(value.worktreeAllocatedBytes + value.gitAllocatedBytes + value.indexAllocatedBytes) &&
  value.worktreeAllocatedBytes + value.gitAllocatedBytes + value.indexAllocatedBytes <= EventWorkPlacement.WORKSPACE_CUSTODY_RESERVATION_BYTES))
export type ArtifactCustody = typeof ArtifactCustody.Type
export const Authority = Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("event_dag_node_v1"),
  authorityID: Text, controllerID: Text, receiptID: Text, nodeID: Text, planHash: WorkAuthoritySchema.Digest,
  rootWorkID: Text, parentWorkID: Text, rootSessionID: Text, parentSessionID: Text,
  childWorkID: Text, childSessionID: Text, childInputID: Text,
  rootBinding: WorkAuthoritySchema.ProjectBinding, rootBindingHash: WorkAuthoritySchema.Digest,
  rootRevision: Positive, childBinding: WorkAuthoritySchema.ProjectBinding, childBindingHash: WorkAuthoritySchema.Digest,
  inputText: Schema.String.check(Schema.makeFilter((value) => Buffer.byteLength(value, "utf8") <= 65_536)),
  predecessorRefs: Schema.Array(Terminal).check(Schema.isMaxLength(32)),
  placement: Schema.optional(EventWorkPlacement.Description),
  artifactCustody: Schema.optional(ArtifactCustody),
  terminal: Schema.optional(Terminal),
  createdAt: Positive, expiresAt: Positive,
})
export type Authority = typeof Authority.Type
export class Error extends Schema.TaggedErrorClass<Error>()("EventWorkDag.Error", {
  code: Schema.Literals(["EVENT_DAG_INVALID", "EVENT_DAG_CONFLICT", "EVENT_DAG_SOURCE_CHANGED", "EVENT_DAG_UNKNOWN",
    "EVENT_DAG_NOT_READY", "EVENT_DAG_CAPACITY", "EVENT_DAG_UNAVAILABLE"]), message: Schema.String,
}) {}
