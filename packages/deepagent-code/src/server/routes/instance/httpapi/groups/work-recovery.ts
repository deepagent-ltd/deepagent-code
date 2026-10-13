import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { WorkKnownRecoverySchema } from "@deepagent-code/core/session/work-known-recovery.schema"
import { WorkStorageCleanupSchema } from "@deepagent-code/core/session/work-storage-cleanup.schema"
import { Authorization } from "../middleware/authorization"

const fields = { code: Schema.String, message: Schema.String }
export class WorkRecoveryInvalid extends Schema.ErrorClass<WorkRecoveryInvalid>("WorkRecoveryInvalid")(
  { ...fields, status: Schema.Literal(400) }, { httpApiStatus: 400 }) {}
export class WorkRecoveryForbidden extends Schema.ErrorClass<WorkRecoveryForbidden>("WorkRecoveryForbidden")(
  { ...fields, status: Schema.Literal(403) }, { httpApiStatus: 403 }) {}
export class WorkRecoveryNotFound extends Schema.ErrorClass<WorkRecoveryNotFound>("WorkRecoveryNotFound")(
  { ...fields, status: Schema.Literal(404) }, { httpApiStatus: 404 }) {}
export class WorkRecoveryConflict extends Schema.ErrorClass<WorkRecoveryConflict>("WorkRecoveryConflict")(
  { ...fields, status: Schema.Literal(409) }, { httpApiStatus: 409 }) {}
export class WorkRecoveryUnavailable extends Schema.ErrorClass<WorkRecoveryUnavailable>("WorkRecoveryUnavailable")(
  { ...fields, status: Schema.Literal(503) }, { httpApiStatus: 503 }) {}
const errors = [WorkRecoveryInvalid, WorkRecoveryForbidden, WorkRecoveryNotFound, WorkRecoveryConflict, WorkRecoveryUnavailable] as const
const execution = Schema.Literals(["not_started", "drained", "attention_required"])
export const WorkRecoveryApi = HttpApi.make("work-recovery").add(HttpApiGroup.make("workRecovery")
  .add(HttpApiEndpoint.post("recoverKnown", "/api/v1/im/work/:workID/recover-known", {
    params: { workID: WorkKnownRecoverySchema.Text },
    payload: Schema.Struct({ sessionID: WorkKnownRecoverySchema.Text, requestID: WorkKnownRecoverySchema.Text,
      expectedClaimToken: WorkKnownRecoverySchema.Revision, expectedControlRevision: WorkKnownRecoverySchema.Revision,
      action: Schema.optional(WorkKnownRecoverySchema.Action) }),
    success: Schema.Struct({ receipt: WorkKnownRecoverySchema.Receipt, execution }), error: errors,
  }))
  .add(HttpApiEndpoint.post("resumeRecovered", "/api/v1/im/work/:workID/resume-recovered", {
    params: { workID: WorkKnownRecoverySchema.Text }, payload: WorkKnownRecoverySchema.ResumeRequest,
    success: Schema.Struct({ receipt: WorkKnownRecoverySchema.ResumeReceipt, execution }), error: errors,
  }))
  .add(HttpApiEndpoint.post("cleanupKnown", "/api/v1/im/work/cleanup-known", {
    payload: WorkStorageCleanupSchema.Request, success: WorkStorageCleanupSchema.Receipt, error: errors,
  }))
  .middleware(Authorization))
