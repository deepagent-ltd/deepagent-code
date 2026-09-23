import { Schema } from "effect"
import { EventV2 } from "../event/define"

const base = {
  requestID: Schema.String,
  tenantID: Schema.String,
  tier: Schema.Literals(["passthrough", "context", "full"]),
  providerID: Schema.String,
  modelID: Schema.String,
  laneSessionID: Schema.optional(Schema.String),
}

export const RequestAdmitted = EventV2.define({
  type: "proxy.request.admitted",
  sync: { aggregate: "requestID", version: 1 },
  schema: { ...base, admittedAt: Schema.Number, stream: Schema.Boolean },
})

export const ResponseCompleted = EventV2.define({
  type: "proxy.response.completed",
  sync: { aggregate: "requestID", version: 1 },
  schema: {
    ...base,
    completedAt: Schema.Number,
    finishReason: Schema.String,
    usageInput: Schema.optional(Schema.Number),
    usageOutput: Schema.optional(Schema.Number),
    usageReasoning: Schema.optional(Schema.Number),
    usageCacheRead: Schema.optional(Schema.Number),
    usageCacheWrite: Schema.optional(Schema.Number),
    usageSource: Schema.optional(Schema.Literals(["provider", "estimated"])),
  },
})
