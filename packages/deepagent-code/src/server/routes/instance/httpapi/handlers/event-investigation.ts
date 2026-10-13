import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { EventInvestigation } from "@deepagent-code/core/deepagent/event-investigation"
import { EventInvestigationSchema } from "@deepagent-code/core/deepagent/event-investigation.schema"
import { EventValidation } from "@deepagent-code/core/deepagent/event-validation"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { EventInvestigationHost } from "@/deepagent/event-investigation"
import { LocalAuthority } from "@/installation/local-authority"
import { ServerAuth } from "@/server/auth"
import { CorsConfig } from "@/server/cors"
import { EventValidationHttpApi } from "../api"
import { ValidationInvalid, ValidationForbidden, ValidationConflict, ValidationUnavailable } from "../groups/event-validation"

const failure = (code: EventInvestigationSchema.Error["code"] = "INVESTIGATION_UNAVAILABLE") =>
  new EventInvestigationSchema.Error({ code, message: "Investigation authority is unavailable or changed" })

/** Authenticated Root reads have no Instance/Location initialization. Captures are
 * private to this scoped handler and retain actual Native provenance, never JSON proof. */
export const eventInvestigationHandlers = () => HttpApiBuilder.group(EventValidationHttpApi, "eventInvestigation", (handlers) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const config = yield* ServerAuth.Config
  const cors = yield* CorsConfig
  const service = yield* EventInvestigationHost.Service
  const captures = new Map<string, { capture: EventInvestigation.GrantCapture; inputHash: string; expiresAt: number;
    epoch: number; operatorRevision: number }>()
  const state = { active: true, inFlight: 0 }
  yield* Effect.addFinalizer(() => Effect.sync(() => { state.active = false; captures.clear() }))
  const authenticate = Effect.gen(function* () {
    return yield* LocalAuthority.authenticate(db, config, yield* HttpServerRequest.HttpServerRequest, cors)
  })
  return handlers
    .handle("candidates", ({ params }) => map(Effect.gen(function* () {
      const identity = yield* authenticate
      return yield* LocalAuthority.provide(identity, EventInvestigation.candidates(db, params.ruleID))
    })))
    .handle("reports", ({ params }) => map(Effect.gen(function* () {
      const identity = yield* authenticate
      return yield* LocalAuthority.provide(identity, EventInvestigation.reports(db, params.ruleID))
    })))
    .handle("capture", ({ payload }) => map(Effect.gen(function* () {
      const identity = yield* authenticate
      for (const [id, capture] of captures) if (capture.expiresAt <= Date.now()) captures.delete(id)
      if (!state.active) return yield* failure()
      if (captures.size + state.inFlight >= 32) return yield* failure("INVESTIGATION_CAPACITY")
      state.inFlight++
      return yield* LocalAuthority.provide(identity, Effect.gen(function* () {
        const before = yield* EventInvestigation.candidates(db, payload.ruleID)
        const target = before.targets.find((item) => item.targetID === payload.targetID)
        if (!target) return yield* failure("INVESTIGATION_SOURCE_CHANGED")
        const capture = yield* service.capture(payload)
        const after = yield* EventInvestigation.candidates(db, payload.ruleID)
        if (!state.active || EventValidation.hash(before) !== EventValidation.hash(after))
          return yield* failure("INVESTIGATION_SOURCE_CHANGED")
        const captureID = randomUUID()
        const expiresAt = Math.min(Date.now() + 60_000, payload.expiresAt)
        captures.set(captureID, { capture, inputHash: EventValidation.hash(payload), expiresAt,
          epoch: before.epoch, operatorRevision: before.operatorRevision })
        return { captureID, expiresAt, preview: { ruleID: before.ruleID, ruleRevision: before.ruleRevision,
          operatorRevision: before.operatorRevision, epoch: before.epoch, grantExpiresAt: payload.expiresAt, target } }
      })).pipe(Effect.ensuring(Effect.sync(() => { state.inFlight-- })))
    })))
    .handle("control", ({ payload }) => map(Effect.gen(function* () {
      const identity = yield* authenticate
      const input = { ruleID: payload.ruleID, requestID: payload.requestID, operation: payload.operation,
        expectedEpoch: payload.expectedEpoch, expectedOperatorRevision: payload.expectedOperatorRevision,
        targetID: payload.targetID, expiresAt: payload.expiresAt }
      const entry = payload.captureID ? captures.get(payload.captureID) : undefined
      const capture = state.active && entry && entry.expiresAt > Date.now() &&
        entry.epoch === payload.expectedEpoch && entry.operatorRevision === payload.expectedOperatorRevision &&
        entry.inputHash === EventValidation.hash({ ruleID: payload.ruleID, targetID: payload.targetID, expiresAt: payload.expiresAt })
        ? entry.capture : undefined
      // Missing/cold/consumed capture still reaches the original command ledger first.
      // Only a new enable can require a fresh opaque capability.
      const result = yield* LocalAuthority.provide(identity, service.control(input, capture))
      if (!result.replayed && payload.captureID && capture) captures.delete(payload.captureID)
      return { receipt: result.receipt, replayed: result.replayed }
    })))
}))

function map<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.mapError((error) => {
    const code = error instanceof EventInvestigationSchema.Error ? error.code
      : error instanceof LocalOperatorSchema.Error && error.code !== "LOCAL_OPERATOR_UNAVAILABLE" ? "INVESTIGATION_AUTH_REQUIRED"
      : "INVESTIGATION_UNAVAILABLE"
    const message = "Investigation is unavailable, changed, or needs reconciliation"
    if (code === "INVESTIGATION_AUTH_REQUIRED") return new ValidationForbidden({ status: 403, code, message })
    if (code === "INVESTIGATION_INVALID") return new ValidationInvalid({ status: 400, code, message })
    if (code === "INVESTIGATION_CONFLICT" || code === "INVESTIGATION_SOURCE_CHANGED" || code === "INVESTIGATION_EXPIRED" || code === "INVESTIGATION_RECOVERY_REQUIRED")
      return new ValidationConflict({ status: 409, code, message })
    return new ValidationUnavailable({ status: 503, code, message })
  }))
}
