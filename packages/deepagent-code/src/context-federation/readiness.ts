export * as ContextFederationReadiness from "./readiness"

import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { Database } from "@deepagent-code/core/database/database"
import { Context, Effect, Exit, Layer } from "effect"
import { LocationIndexRuntime } from "../location-index/runtime"

const SnapshotLifetimeMs = 15_000

export function unavailableSnapshot(observedAt = Date.now()): ContextFederationRollout.DerivedContextDataReadiness {
  return {
    state: "blocked",
    identityBound: false,
    indexAvailable: false,
    storageHealthy: false,
    observedAt,
    expiresAt: observedAt,
  }
}

export interface Interface {
  readonly snapshot: () => Effect.Effect<ContextFederationRollout.DerivedContextDataReadiness>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ContextFederationReadiness") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const runtime = yield* LocationIndexRuntime.Service

    const snapshot: Interface["snapshot"] = Effect.fn("ContextFederationReadiness.snapshot")(function* () {
      const observedAt = Date.now()
      const current = yield* runtime.current()
      if (!current) {
        return {
          state: "uninitialized",
          identityBound: false,
          indexAvailable: false,
          storageHealthy: false,
          observedAt,
          expiresAt: observedAt + SnapshotLifetimeMs,
        }
      }

      const [index, storage] = yield* Effect.all([
        current.coordinator.codeStatus().pipe(Effect.exit),
        database.db.run("SELECT 1").pipe(Effect.exit),
      ])
      const indexAvailable = Exit.isSuccess(index) && ["ready", "degraded"].includes(index.value.state)
      const storageHealthy = Exit.isSuccess(storage)
      const state = !storageHealthy
        ? ("blocked" as const)
        : Exit.isFailure(index) || index.value.state === "unavailable"
          ? ("degraded" as const)
          : index.value.state === "cold" || index.value.state === "indexing"
            ? ("building" as const)
            : index.value.state

      return {
        state,
        identityBound: true,
        indexAvailable,
        storageHealthy,
        observedAt,
        expiresAt: observedAt + SnapshotLifetimeMs,
      }
    })

    return Service.of({ snapshot })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(LocationIndexRuntime.defaultLayer),
  Layer.provide(Database.defaultLayer),
)
