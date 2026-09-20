import type { InstanceContext } from "@/project/instance-context"
import { Context, Effect, Layer } from "effect"

type Initializer = (context: InstanceContext) => Promise<void>
type Disposer = (directory: string) => Promise<void>
const stateDisposers = new WeakMap<InstanceContext, Set<() => Promise<void>>>()

export interface Interface {
  readonly registerInitializer: (initializer: Initializer) => () => void
  readonly initialize: (context: InstanceContext) => Effect.Effect<void>
  readonly registerDisposer: (disposer: Disposer) => () => void
  readonly dispose: (directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/InstanceRegistry") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const disposers = new Set<Disposer>()
    const initializers = new Set<Initializer>()

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        disposers.clear()
        initializers.clear()
      }),
    )

    return Service.of({
      registerInitializer(initializer) {
        initializers.add(initializer)
        return () => initializers.delete(initializer)
      },
      initialize: (context) =>
        settle(
          [...initializers].map((initializer) => Promise.resolve().then(() => initializer(context))),
          "initialization",
        ),
      registerDisposer(disposer) {
        disposers.add(disposer)
        return () => disposers.delete(disposer)
      },
      dispose: (directory) =>
        settle(
          [...disposers].map((disposer) => Promise.resolve().then(() => disposer(directory))),
          "disposal",
        ),
    })
  }),
)

function settle(tasks: Promise<void>[], operation: string) {
  return Effect.promise(() => Promise.allSettled(tasks)).pipe(
    Effect.flatMap((results) => {
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failed.length === 0) return Effect.void
      return Effect.die(
        new AggregateError(
          failed.map((result) => result.reason),
          `Instance ${operation} failed`,
        ),
      )
    }),
  )
}

export const registerInitializer = (initializer: Initializer) =>
  Service.use((registry) => Effect.sync(() => registry.registerInitializer(initializer)))

export const initializeInstance = (context: InstanceContext) => Service.use((registry) => registry.initialize(context))

export const registerDisposer = (disposer: Disposer) =>
  Service.use((registry) => Effect.sync(() => registry.registerDisposer(disposer)))

export const disposeInstance = (directory: string) => Service.use((registry) => registry.dispose(directory))

export function registerInstanceStateDisposer(context: InstanceContext, disposer: () => Promise<void>) {
  const current = stateDisposers.get(context) ?? new Set<() => Promise<void>>()
  current.add(disposer)
  stateDisposers.set(context, current)
  return () => {
    current.delete(disposer)
    if (current.size === 0 && stateDisposers.get(context) === current) stateDisposers.delete(context)
  }
}

export function disposeInstanceState(context: InstanceContext) {
  const current = stateDisposers.get(context)
  stateDisposers.delete(context)
  return settle(
    [...(current ?? [])].map((disposer) => Promise.resolve().then(disposer)),
    "state disposal",
  )
}

export * as InstanceRegistry from "./instance-registry"
