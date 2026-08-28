import { Effect, Fiber, Layer, ManagedRuntime } from "effect"
import * as Context from "effect/Context"
import { EventRouteRef, InstanceRef, WorkspaceRef, type EventRoute } from "./instance-ref"
import * as Observability from "@deepagent-code/core/effect/observability"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import type { InstanceContext } from "@/project/instance-context"
import { memoMap } from "@deepagent-code/core/effect/memo-map"

type Refs = {
  instance?: InstanceContext
  eventRoute?: EventRoute
  workspace?: string
}

export function attachWith<A, E, R>(effect: Effect.Effect<A, E, R>, refs: Refs): Effect.Effect<A, E, R> {
  const routed = refs.eventRoute ? effect.pipe(Effect.provideService(EventRouteRef, refs.eventRoute)) : effect
  if (!refs.instance && !refs.workspace) return routed
  if (!refs.instance) return routed.pipe(Effect.provideService(WorkspaceRef, refs.workspace))
  if (!refs.workspace) return routed.pipe(Effect.provideService(InstanceRef, refs.instance))
  return routed.pipe(
    Effect.provideService(InstanceRef, refs.instance),
    Effect.provideService(WorkspaceRef, refs.workspace),
  )
}

export function attach<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const workspace = WorkspaceContext.workspaceID
  const fiber = Fiber.getCurrent()
  return attachWith(effect, {
    instance: fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined,
    eventRoute: fiber ? Context.getReferenceUnsafe(fiber.context, EventRouteRef) : undefined,
    workspace: workspace ?? (fiber ? Context.getReferenceUnsafe(fiber.context, WorkspaceRef) : undefined),
  })
}

export function makeRuntime<I, S, E>(service: Context.Service<I, S>, layer: Layer.Layer<I, E>) {
  let rt: ManagedRuntime.ManagedRuntime<I, E> | undefined
  const getRuntime = () => (rt ??= ManagedRuntime.make(Layer.provideMerge(layer, Observability.layer), { memoMap }))

  return {
    runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runSync(attach(service.use(fn))),
    runPromiseExit: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromiseExit(attach(service.use(fn)), options),
    runPromise: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromise(attach(service.use(fn)), options),
    runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runFork(attach(service.use(fn))),
    runCallback: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) =>
      getRuntime().runCallback(attach(service.use(fn))),
  }
}
