import { Layer, type Context, ManagedRuntime, type Effect } from "effect"
import { makeMemoMap } from "./memo-map"
import { Observability } from "./observability"
import { ProcessLifecycle } from "./process-lifecycle"

export function makeRuntime<I, S, E>(service: Context.Service<I, S>, layer: Layer.Layer<I, E>, name?: string) {
  let rt: ManagedRuntime.ManagedRuntime<I, E> | undefined
  let unregister: (() => void) | undefined
  const dispose = async () => {
    const current = rt
    rt = undefined
    unregister?.()
    unregister = undefined
    await current?.dispose()
  }
  const getRuntime = () => {
    if (rt) return rt
    rt = ManagedRuntime.make(Layer.provideMerge(layer, Observability.layer) as Layer.Layer<I, E>, {
      memoMap: makeMemoMap(),
    })
    if (name) unregister = ProcessLifecycle.register(name, dispose)
    return rt
  }

  return {
    runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runSync(service.use(fn)),
    runPromiseExit: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromiseExit(service.use(fn), options),
    runPromise: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromise(service.use(fn), options),
    runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runFork(service.use(fn)),
    runCallback: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runCallback(service.use(fn)),
    dispose,
  }
}
