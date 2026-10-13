import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { Authorization } from "../middleware/authorization"

const fields = { code: Schema.String, message: Schema.String }
export class ValidationInvalid extends Schema.ErrorClass<ValidationInvalid>("ValidationInvalid")(
  { ...fields, status: Schema.Literal(400) }, { httpApiStatus: 400 }) {}
export class ValidationForbidden extends Schema.ErrorClass<ValidationForbidden>("ValidationForbidden")(
  { ...fields, status: Schema.Literal(403) }, { httpApiStatus: 403 }) {}
export class ValidationNotFound extends Schema.ErrorClass<ValidationNotFound>("ValidationNotFound")(
  { ...fields, status: Schema.Literal(404) }, { httpApiStatus: 404 }) {}
export class ValidationConflict extends Schema.ErrorClass<ValidationConflict>("ValidationConflict")(
  { ...fields, status: Schema.Literal(409) }, { httpApiStatus: 409 }) {}
export class ValidationCapacity extends Schema.ErrorClass<ValidationCapacity>("ValidationCapacity")(
  { ...fields, status: Schema.Literal(429) }, { httpApiStatus: 429 }) {}
export class ValidationUnavailable extends Schema.ErrorClass<ValidationUnavailable>("ValidationUnavailable")(
  { ...fields, status: Schema.Literal(503) }, { httpApiStatus: 503 }) {}
const errors = [ValidationInvalid, ValidationForbidden, ValidationNotFound, ValidationConflict, ValidationCapacity, ValidationUnavailable] as const
const result = Schema.Struct({ receipt: EventValidationSchema.CommandReceipt, replayed: Schema.Boolean })
export const EventValidationApi = HttpApi.make("event-validation").add(HttpApiGroup.make("eventValidation")
  .add(HttpApiEndpoint.post("candidates", "/api/v1/event-validation/candidates", {
    payload: EventValidationSchema.CandidatesRequest, success: EventValidationSchema.Candidates, error: errors,
  }))
  .add(HttpApiEndpoint.post("capture", "/api/v1/event-validation/capture", {
    payload: EventValidationSchema.Capture, success: EventValidationSchema.Captured, error: errors,
  }))
  .add(HttpApiEndpoint.post("configureCaptured", "/api/v1/event-validation/rules/configure-captured", {
    payload: EventValidationSchema.ConfigureCaptured, success: result, error: errors,
  }))
  .add(HttpApiEndpoint.get("rules", "/api/v1/event-validation/rules", {
    success: Schema.Array(EventValidationSchema.RuleRecord), error: errors,
  }))
  .add(HttpApiEndpoint.get("runs", "/api/v1/event-validation/rules/:ruleID/runs", {
    params: { ruleID: EventValidationSchema.ID },
    success: Schema.Array(EventValidationSchema.RunView), error: errors,
  }))
  .add(HttpApiEndpoint.post("configure", "/api/v1/event-validation/rules/configure", {
    payload: EventValidationSchema.Configure, success: result, error: errors,
  }))
  .add(HttpApiEndpoint.post("control", "/api/v1/event-validation/rules/:ruleID/control", {
    params: { ruleID: EventValidationSchema.ID },
    payload: Schema.Struct({ requestID: EventValidationSchema.ID, expectedRevision: EventValidationSchema.Positive,
      action: EventValidationSchema.Control.fields.action }), success: result, error: errors,
  }))
  .middleware(Authorization))
