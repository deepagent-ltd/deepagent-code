import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { EventValidationSchema } from "@deepagent-code/core/deepagent/event-validation.schema"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { EventValidationHost } from "@/deepagent/event-validation"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { ServerAuth } from "@/server/auth"
import { CorsConfig } from "@/server/cors"
import { EventValidationHttpApi } from "../api"
import { ValidationInvalid, ValidationForbidden, ValidationNotFound,
  ValidationConflict, ValidationCapacity, ValidationUnavailable } from "../groups/event-validation"

// Register beside the root API: GET never initializes an Instance/Location or starts a
// watcher. The same host service owns native handles and is captured once here.
export const eventValidationHandlers = () => HttpApiBuilder.group(EventValidationHttpApi, "eventValidation", (handlers) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const config = yield* ServerAuth.Config
  const cors = yield* CorsConfig
  const service = yield* EventValidationHost.Service
  const authenticate = Effect.gen(function* () {
    return yield* LocalTaskAuthority.authenticate(db, config, yield* HttpServerRequest.HttpServerRequest, cors)
  })
  return handlers
    .handle("candidates", ({ payload }) => map(Effect.gen(function* () {
      const identity = yield* authenticate
      return yield* LocalTaskAuthority.provide(identity, service.candidates(payload))
    })))
    .handle("capture", ({ payload }) => map(Effect.gen(function* () {
      const identity = yield* authenticate
      return yield* LocalTaskAuthority.provide(identity, service.capture(payload))
    })))
    .handle("configureCaptured", ({ payload }) => map(Effect.gen(function* () {
      const identity = yield* authenticate
      return yield* LocalTaskAuthority.provide(identity, service.configureCaptured(payload))
    })))
    .handle("rules", () => map(Effect.gen(function* () { yield* authenticate; return yield* service.list })))
    .handle("runs", ({ params }) => map(Effect.gen(function* () {
      yield* authenticate
      const rules = yield* service.list
      const rule = rules.find((item) => item.ruleID === params.ruleID)
      if (!rule) return yield* new EventValidationSchema.Error({ code: "VALIDATION_NOT_FOUND", message: "Validation rule not found" })
      const history = yield* service.history(params.ruleID)
      return history.map((record) => ({ record, observation: service.observation(record), current: rule.state === "enabled" && rule.currentRunID === record.runID &&
        rule.contentRevision === record.contentRevision && rule.contentHash === record.contentHash && rule.revision === record.ruleRevision }))
    })))
    .handle("configure", ({ payload }) => map(Effect.gen(function* () {
      const identity = yield* authenticate
      return yield* LocalTaskAuthority.provide(identity, service.configure(payload))
    })))
    .handle("control", ({ params, payload }) => map(Effect.gen(function* () {
      const identity = yield* authenticate
      return yield* LocalTaskAuthority.provide(identity, service.control({ ...payload, ruleID: params.ruleID }))
    })))
}))
function map<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.mapError((error) => {
    const code = error instanceof EventValidationSchema.Error ? error.code
      : error instanceof LocalOperatorSchema.Error && error.code !== "LOCAL_OPERATOR_UNAVAILABLE" ? "VALIDATION_AUTH_REQUIRED"
      : "VALIDATION_UNAVAILABLE"
    const message = "Project validation is unavailable, changed, or needs reconciliation"
    if (code === "VALIDATION_AUTH_REQUIRED" || code === "VALIDATION_SCOPE_CHANGED") return new ValidationForbidden({ status: 403, code, message })
    if (code === "VALIDATION_NOT_FOUND") return new ValidationNotFound({ status: 404, code, message })
    if (code === "VALIDATION_INVALID") return new ValidationInvalid({ status: 400, code, message })
    if (code === "VALIDATION_CAPACITY") return new ValidationCapacity({ status: 429, code, message })
    if (code === "VALIDATION_CONFLICT" || code === "VALIDATION_RECOVERY_REQUIRED" || code === "VALIDATION_CAPTURE_EXPIRED") return new ValidationConflict({ status: 409, code, message })
    return new ValidationUnavailable({ status: 503, code, message })
  }))
}
