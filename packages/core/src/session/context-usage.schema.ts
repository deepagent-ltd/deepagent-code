export * as SessionContextUsageSchema from "./context-usage.schema"

import { Schema } from "effect"

export const Tokens = Schema.Struct({
  nonCachedInput: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
})
export type Tokens = typeof Tokens.Type

export const Query = Schema.Struct({
  providerID: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  modelID: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  variant: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  agent: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  draft: Schema.optional(Schema.String.check(Schema.isMaxLength(131072))),
  draftRevision: Schema.String.check(Schema.isMaxLength(128)),
  hasAttachments: Schema.optional(Schema.Boolean),
})

export const Summary = Schema.Struct({
  sessionID: Schema.String,
  observedAt: Schema.Number,
  revision: Schema.String,
  estimate: Schema.Struct({
    status: Schema.Literals(["complete", "partial", "unavailable", "stale"]),
    inputTokens: Schema.NullOr(Schema.Number),
    contextLimit: Schema.NullOr(Schema.Number),
    inputLimit: Schema.NullOr(Schema.Number),
    physicalInputBudget: Schema.NullOr(Schema.Number),
    reservedOutput: Schema.NullOr(Schema.Number),
    modelID: Schema.NullOr(Schema.String),
    providerID: Schema.NullOr(Schema.String),
    draftRevision: Schema.String,
    missing: Schema.Array(Schema.String),
  }),
  activity: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      state: Schema.String,
      current: Schema.Boolean,
      calls: Schema.Number,
      reportedCalls: Schema.Number,
      unknownCalls: Schema.Number,
      reasoningReported: Schema.Boolean,
      cacheReadReported: Schema.Boolean,
      cacheWriteReported: Schema.Boolean,
      tokens: Tokens,
    }),
  ),
  totals: Tokens,
  totalsReasoningReported: Schema.Boolean,
  totalsCacheReadReported: Schema.Boolean,
  totalsCacheWriteReported: Schema.Boolean,
  totalCalls: Schema.Number,
  unknownCalls: Schema.Number,
  coverage: Schema.Literals(["recorded", "partial"]),
})
export type Summary = typeof Summary.Type

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("SessionContextUsage.Unavailable", {
  reason: Schema.Literals(["not_found", "scope_changed"]),
}) {}
