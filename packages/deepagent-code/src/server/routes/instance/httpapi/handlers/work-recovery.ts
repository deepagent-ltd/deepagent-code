import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { WorkKnownRecoverySchema } from "@deepagent-code/core/session/work-known-recovery.schema"
import { WorkStorageCleanupSchema } from "@deepagent-code/core/session/work-storage-cleanup.schema"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { LocalTaskAuthority } from "@/im/local-task-authority"
import { NativeWorkKnownRecovery } from "@/installation/work-known-recovery"
import { NativeWorkStorageCleanup } from "@/installation/work-storage-cleanup"
import { ServerAuth } from "@/server/auth"
import { CorsConfig } from "@/server/cors"
import { RootHttpApi } from "../api"
import { WorkRecoveryInvalid, WorkRecoveryForbidden, WorkRecoveryNotFound,
  WorkRecoveryConflict, WorkRecoveryUnavailable } from "../groups/work-recovery"

// Root-only registration: no Instance/Workspace middleware that can initialize another project.
export const workRecoveryHandlers = () => HttpApiBuilder.group(RootHttpApi, "workRecovery", (handlers) => Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const config = yield* ServerAuth.Config
  const cors = yield* CorsConfig
  const context = yield* Effect.context()
  const authenticate = Effect.gen(function* () {
    return yield* LocalTaskAuthority.authenticate(db, config, yield* HttpServerRequest.HttpServerRequest, cors)
  })
  return handlers
    .handle("recoverKnown", ({ params, payload }) => map(Effect.gen(function* () {
      const identity = yield* authenticate
      return yield* LocalTaskAuthority.provide(identity, NativeWorkKnownRecovery.recover({
        ...payload, workID: params.workID, action: payload.action ?? "recover_only",
      }).pipe(Effect.provide(context)))
    })))
    .handle("resumeRecovered", ({ params, payload }) => map(Effect.gen(function* () {
      const identity = yield* authenticate
      return yield* LocalTaskAuthority.provide(identity,
        NativeWorkKnownRecovery.resume(payload, params.workID).pipe(Effect.provide(context)))
    })))
    .handle("cleanupKnown", ({ payload }) => mapCleanup(Effect.gen(function* () {
      const identity = yield* authenticate
      return yield* LocalTaskAuthority.provide(identity,
        NativeWorkStorageCleanup.cleanup(payload).pipe(Effect.provide(context)))
    })))
}))
function map<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.mapError((error) => {
    const code = error instanceof WorkKnownRecoverySchema.Error ? error.code : "RECOVERY_AUTH_REQUIRED"
    const message = "Known Work recovery is unavailable, changed, or needs attention"
    if (code === "RECOVERY_AUTH_REQUIRED") return new WorkRecoveryForbidden({ status: 403, code, message })
    if (code === "RECOVERY_NOT_FOUND") return new WorkRecoveryNotFound({ status: 404, code, message })
    if (code === "RECOVERY_INVALID_REQUEST") return new WorkRecoveryInvalid({ status: 400, code, message })
    if (code === "RECOVERY_CONFLICT" || code === "RECOVERY_OWNER_ACTIVE") return new WorkRecoveryConflict({ status: 409, code, message })
    return new WorkRecoveryUnavailable({ status: 503, code, message })
  }))
}

function mapCleanup<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.mapError((error) => {
    const code = error instanceof WorkStorageCleanupSchema.Error ? error.code
      : error instanceof LocalOperatorSchema.Error ? "STORAGE_AUTH_REQUIRED" : "STORAGE_UNAVAILABLE"
    const message = "Known Work storage cleanup is unavailable, changed, or needs attention"
    if (code === "STORAGE_AUTH_REQUIRED") return new WorkRecoveryForbidden({ status: 403, code, message })
    if (code === "STORAGE_INVALID") return new WorkRecoveryInvalid({ status: 400, code, message })
    if (code === "STORAGE_CONFLICT") return new WorkRecoveryConflict({ status: 409, code, message })
    return new WorkRecoveryUnavailable({ status: 503, code, message })
  }))
}
