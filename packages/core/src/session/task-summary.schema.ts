export * as TaskSummarySchema from "./task-summary.schema"

import { Schema } from "effect"

export const State = Schema.Literals([
  "admitted",
  "provisioning",
  "researching",
  "finalizing",
  "completed",
  "error",
  "cancelled",
  "interrupted",
  "queued",
  "running",
  "failed",
  "closed",
  "recovery_required",
  "unknown",
])

export const Item = Schema.Struct({
  childSessionID: Schema.String,
  title: Schema.String,
  agent: Schema.NullOr(Schema.String),
  state: State,
  runID: Schema.NullOr(Schema.String),
  generation: Schema.NullOr(Schema.Int),
  controlState: Schema.NullOr(Schema.Literals(["open", "close_requested", "closed"])),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  settledAt: Schema.NullOr(Schema.Finite),
  progress: Schema.NullOr(
    Schema.Struct({
      messageID: Schema.String,
      text: Schema.String,
      tool: Schema.NullOr(
        Schema.Struct({
          name: Schema.String,
          status: Schema.Literals(["pending", "running", "completed", "error"]),
        }),
      ),
    }),
  ),
  result: Schema.Struct({
    state: Schema.Literals(["available", "not_available", "unknown"]),
    text: Schema.NullOr(Schema.String),
    messageID: Schema.NullOr(Schema.String),
    truncated: Schema.Boolean,
  }),
  notification: Schema.Struct({
    state: Schema.Literals([
      "not_established",
      "pending",
      "delivering",
      "delivered",
      "dead",
      "admitting",
      "admitted",
      "processing",
      "response_recovery_required",
      "unknown",
    ]),
    updatedAt: Schema.NullOr(Schema.Finite),
    deliveredAt: Schema.NullOr(Schema.Finite),
  }),
}).annotate({ identifier: "TaskSummaryItem" })
export type Item = typeof Item.Type

export const Summary = Schema.Struct({
  parentSessionID: Schema.String,
  observedAt: Schema.Finite,
  items: Schema.Array(Item),
  hasMore: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "TaskSummary" })
export type Summary = typeof Summary.Type

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("TaskSummary.Unavailable", {
  reason: Schema.Literals(["not_found", "scope_changed"]),
}) {}
