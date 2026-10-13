export * as AttentionSchema from "./schema"

import { Schema } from "effect"

export const Kind = Schema.Literals(["activity_failed", "execution_recovery", "no_progress", "task", "goal"])
export const State = Schema.Literals([
  "failed",
  "recovery_required",
  "authority_conflict",
  "owned_elsewhere",
  "execution_claim_pending",
  "needs_human",
  "completed",
  "closed",
  "interrupted",
  "cancelled",
  "paused",
  "stopped",
  "rolled_back",
  "close_requested",
])
export const Item = Schema.Struct({
  id: Schema.String,
  revision: Schema.String,
  kind: Kind,
  state: State,
  reasonCode: Schema.Literals([
    "activity_failed",
    "claim_only",
    "safe_before_dispatch",
    "terminal_consistent",
    "recovery_required",
    "authority_conflict",
    "owned_elsewhere",
    "no_progress",
    "task_result",
    "task_recovery",
    "task_close_requested",
    "goal_result",
    "goal_recovery",
    "goal_paused",
    "goal_stopped",
  ]),
  occurredAt: Schema.NullOr(Schema.Finite),
  observedAt: Schema.Finite,
  session: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    projectID: Schema.String,
    directory: Schema.String,
    workspaceID: Schema.Null,
    parentID: Schema.optional(Schema.String),
  }),
  source: Schema.Struct({
    activityID: Schema.optional(Schema.String),
    permissionRequestID: Schema.optional(Schema.String),
    expiresAt: Schema.optional(Schema.Finite),
    task: Schema.optional(
      Schema.Struct({
        runID: Schema.String,
        parentSessionID: Schema.String,
        childSessionID: Schema.NullOr(Schema.String),
        recordedChildSessionID: Schema.String,
        generation: Schema.Int,
        version: Schema.Int,
        state: Schema.String,
        controlState: Schema.Literals(["open", "close_requested", "closed"]),
        terminalReceiptID: Schema.NullOr(Schema.String),
        pendingProviders: Schema.Int,
        pendingProviderAttempts: Schema.Int,
        pendingToolEffects: Schema.Int,
        hasExecutionClaim: Schema.Boolean,
      }),
    ),
    goal: Schema.optional(
      Schema.Struct({
        goalID: Schema.String,
        controlRevision: Schema.Int,
        planRevision: Schema.Int,
        nextSeq: Schema.Int,
        planDocID: Schema.String,
        phase: Schema.String,
        preparation: Schema.String,
        pendingRebase: Schema.Boolean,
        pendingPermits: Schema.Int,
        unknownPermits: Schema.Int,
        checkpointState: Schema.NullOr(Schema.String),
        checkpointHash: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  allowedActions: Schema.optional(
    Schema.Array(
      Schema.Literals([
        "continue_once",
        "terminate",
        "task_request_close",
        "task_resolve_failed",
        "task_resolve_closed",
        "goal_pause",
        "goal_resume",
        "goal_stop",
        "goal_edit",
      ]),
    ),
  ),
  seen: Schema.Boolean,
  seenAt: Schema.NullOr(Schema.Finite),
}).annotate({ identifier: "AttentionItem" })
export type Item = typeof Item.Type

export const List = Schema.Struct({
  data: Schema.Array(Item),
  nextCursor: Schema.optional(Schema.String),
  asOf: Schema.Finite,
  scope: Schema.Literal("implicit-local"),
  unseenCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "AttentionList" })
export type List = typeof List.Type

export const Capability = Schema.Struct({
  enabled: Schema.Boolean,
  scope: Schema.Literal("implicit-local"),
  actor: Schema.Literal("server"),
  reason: Schema.Literals(["enabled", "profile_disabled", "unsupported_host"]),
}).annotate({ identifier: "AttentionCapability" })
export type Capability = typeof Capability.Type
