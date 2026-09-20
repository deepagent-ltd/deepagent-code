import { Cause, Effect, ScopedCache, Scope } from "effect"
import * as EffectLogger from "@deepagent-code/core/effect/logger"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerInstanceStateDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~deepagent-code/InstanceState"

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<InstanceContext, A, E, R>
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const cache = yield* ScopedCache.make<InstanceContext, A, E, R>({
      capacity: 64,
      lookup: (instance) =>
        Effect.gen(function* () {
          const value = yield* init(instance)
          const unregister = registerInstanceStateDisposer(instance, () =>
            Effect.runPromise(
              ScopedCache.invalidate(cache, instance).pipe(
                // Disposal order is not guaranteed: when the cache's owning scope closed first, its
                // finalizer already released every entry — and invalidate on a Closed cache ends
                // interrupt-only (ScopedCache source: Closed → Effect.interrupt). That is the
                // satisfied postcondition, not a failure; any OTHER cause (e.g. a finalizer defect
                // inside Scope.close) still rejects disposal.
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.failCause(cause),
                ),
                Effect.provide(EffectLogger.layer),
              ),
            ),
          )
          yield* Effect.addFinalizer(() => Effect.sync(unregister))
          return value
        }),
    })

    return {
      [TypeId]: TypeId,
      cache,
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.get(self.cache, yield* context)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, yield* context)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, yield* context)
  })

export * as InstanceState from "./instance-state"
