import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { EventInvestigationSchema } from "@deepagent-code/core/deepagent/event-investigation.schema"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { Authorization } from "../middleware/authorization"
import { ValidationInvalid, ValidationForbidden, ValidationConflict, ValidationUnavailable } from "./event-validation"

const errors = [ValidationInvalid, ValidationForbidden, ValidationConflict, ValidationUnavailable] as const
export const InvestigationCapture = Schema.Struct({
  ruleID: EventValidationSchema.ID, targetID: EventValidationSchema.ID, expiresAt: EventValidationSchema.Positive,
})
export const InvestigationCaptured = Schema.Struct({
  captureID: EventValidationSchema.ID, expiresAt: EventValidationSchema.Positive,
  preview: Schema.Struct({ ruleID: EventValidationSchema.ID, ruleRevision: EventValidationSchema.Positive,
    operatorRevision: EventValidationSchema.Positive, epoch: EventValidationSchema.Count,
    grantExpiresAt: EventValidationSchema.Positive, target: EventInvestigationSchema.Candidates.fields.targets.value }),
})
export const InvestigationControl = Schema.Struct({
  ...EventInvestigationSchema.GrantCommand.fields, captureID: Schema.NullOr(EventValidationSchema.ID),
}).check(Schema.makeFilter((value) => value.operation === "enable"
  ? value.targetID !== null && value.expiresAt !== null
  : value.targetID === null && value.expiresAt === null && value.captureID === null))
export const EventInvestigationApi = HttpApi.make("event-investigation").add(HttpApiGroup.make("eventInvestigation")
  .add(HttpApiEndpoint.get("candidates", "/api/v1/event-investigation/rules/:ruleID/candidates", {
    params: { ruleID: EventValidationSchema.ID }, success: EventInvestigationSchema.Candidates, error: errors,
  }))
  .add(HttpApiEndpoint.get("reports", "/api/v1/event-investigation/rules/:ruleID/reports", {
    params: { ruleID: EventValidationSchema.ID }, success: EventInvestigationSchema.Reports, error: errors,
  }))
  .add(HttpApiEndpoint.post("capture", "/api/v1/event-investigation/capture", {
    payload: InvestigationCapture, success: InvestigationCaptured, error: errors,
  }))
  .add(HttpApiEndpoint.post("control", "/api/v1/event-investigation/control", {
    payload: InvestigationControl,
    success: Schema.Struct({ receipt: EventValidationSchema.CommandReceipt, replayed: Schema.Boolean }), error: errors,
  }))
  .middleware(Authorization))
