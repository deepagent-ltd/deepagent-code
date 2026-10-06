export * as AttentionSchema from "./schema"

import { Schema } from "effect"

export const Kind = Schema.Literals(["activity_failed", "execution_recovery"])
export const State = Schema.Literals([
  "failed",
  "recovery_required",
  "authority_conflict",
  "owned_elsewhere",
  "execution_claim_pending",
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
  source: Schema.Struct({ activityID: Schema.optional(Schema.String) }),
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
