export * as EventWorkManagementSchema from "./event-work-management.schema"

import { Schema } from "effect"
import { WorkAuthoritySchema } from "../session/work-authority.schema"
import { EventWorkDagSchema } from "./event-work-dag.schema"
import { EventWorkRuleSchema } from "./event-work-rule.schema"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Positive = Count.check(Schema.isGreaterThan(0))
export const Candidate = Schema.Struct({
  originID: Text, targetID: Text, sourceSessionID: Text, mode: Schema.Literals(["single", "dag"]),
  profile: Schema.Struct({ id: Text, version: Positive, hash: WorkAuthoritySchema.Digest }),
  providerID: Text, modelID: Text, budget: WorkAuthoritySchema.Budget, serverNow: Positive, maxExpiresAt: Positive,
  plan: Schema.optional(EventWorkDagSchema.Plan), planHash: Schema.optional(WorkAuthoritySchema.Digest),
  available: Schema.Boolean, reason: Schema.optional(Text),
}).annotate({ identifier: "EventWorkCandidate" })
export const Rule = Schema.Struct({
  ruleID: Text, revision: Positive, epoch: Positive, originID: Text, targetID: Text,
  mode: Schema.Literals(["single", "dag"]), state: Schema.Literals(["disabled", "enabled", "paused", "revoked"]),
  instruction: Schema.String, expiresAt: Positive, enabledAfterOrdinal: EventWorkRuleSchema.ActivityCutoff,
  planID: Schema.optional(Text), planHash: Schema.optional(WorkAuthoritySchema.Digest),
  allowedActions: Schema.Array(Schema.Literals(["enable", "pause", "revoke"])).check(Schema.isMaxLength(3)),
}).annotate({ identifier: "EventWorkRule" })
export const Node = Schema.Struct({
  nodeID: Text, agentID: Text, dependencies: Schema.Array(Text).check(Schema.isMaxLength(32)),
  state: Schema.Literals(["awaiting_dependencies", "reserved", "ready", "running", "succeeded", "failed", "unknown", "cancelled"]),
  workID: Schema.optional(Text), sessionID: Schema.optional(Text), inputID: Schema.optional(Text),
  controlRevision: Schema.optional(Positive), reservedTokens: Count, actualUsage: Schema.optional(WorkAuthoritySchema.Usage),
  resultHash: Schema.optional(WorkAuthoritySchema.Digest), terminalHash: Schema.optional(WorkAuthoritySchema.Digest),
  reason: Schema.optional(Text), sessionAvailable: Schema.Boolean,
}).annotate({ identifier: "EventWorkNode" })
export const Root = Schema.Struct({
  rootID: Text, receiptID: Text, ruleID: Text, revision: Positive, mode: Schema.Literals(["single", "dag"]),
  state: Schema.Literals(["pending", "running", "succeeded", "failed", "unknown"]),
  controlState: WorkAuthoritySchema.ControlState, expiresAt: Positive,
  planID: Schema.optional(Text), planHash: Schema.optional(WorkAuthoritySchema.Digest),
  budget: WorkAuthoritySchema.Budget, reservedTokens: Count, actualUsage: Schema.optional(WorkAuthoritySchema.Usage),
  providerConcurrency: Schema.Literal(1), schedulingConcurrency: Positive.check(Schema.isLessThanOrEqualTo(2)),
  nodes: Schema.Array(Node).check(Schema.isMaxLength(32)),
  allowedActions: Schema.Array(Schema.Literal("cancel")).check(Schema.isMaxLength(1)), reason: Schema.optional(Text),
}).annotate({ identifier: "EventWorkRoot" })
export const RuleCommand = Schema.Struct({ ruleID: Text, requestID: Text, expectedRevision: Count,
  action: Schema.Literals(["create", "enable", "pause", "revoke"]), originID: Schema.optional(Text),
  instruction: Schema.optional(Schema.String.check(Schema.isMinLength(1),
    Schema.makeFilter((value) => Buffer.byteLength(value, "utf8") <= 60_000))), expiresAt: Schema.optional(Positive) }).annotate({ identifier: "EventWorkRuleCommand" })
export const RootCommand = Schema.Struct({ rootID: Text, requestID: Text, expectedRevision: Positive, action: Schema.Literal("cancel") }).annotate({ identifier: "EventWorkRootCommand" })
export const RuleCommandResult = Schema.Struct({ requestID: Text, expectedRevision: Count,
  action: RuleCommand.fields.action, replayed: Schema.Boolean, rule: Rule }).annotate({ identifier: "EventWorkRuleCommandResult" })
export const RootCommandResult = Schema.Struct({ requestID: Text, expectedRevision: Positive,
  action: Schema.Literal("cancel"), replayed: Schema.Boolean, root: Root }).annotate({ identifier: "EventWorkRootCommandResult" })
export const Page = Schema.Struct({ limit: Schema.optional(Positive.check(Schema.isLessThanOrEqualTo(32))), after: Schema.optional(Text) })
/** A management Session ID is only a lookup hint. This separate current port authorizes opening. */
export const SessionPointer = Schema.Struct({ version: Schema.Literal(1), rootID: Text, nodeID: Text, workID: Text,
  sessionID: Text, inputID: Text, rootRevision: Positive, controlRevision: Positive, bindingHash: WorkAuthoritySchema.Digest,
  placement: Schema.Struct({ directory: Schema.String, workspaceID: Schema.NullOr(Schema.String), projectID: Text,
    securityNamespaceID: Text, namespaceBindingHash: WorkAuthoritySchema.Digest }), expiresAt: Positive }).annotate({ identifier: "EventWorkSessionPointer" })
export type Candidate = typeof Candidate.Type
export type Rule = typeof Rule.Type
export type Root = typeof Root.Type
export type Node = typeof Node.Type
export type SessionPointer = typeof SessionPointer.Type
