export * as LocationIndexWatcher from "./watcher-consumer"

import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { EventV2 } from "@deepagent-code/core/event"
import { Watcher } from "@deepagent-code/core/filesystem/watcher"
import { Context, Effect, Layer, Scope } from "effect"
import { LocationIndexCoordinator } from "./coordinator"

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/LocationIndexWatcher") {}

export function start(input: {
  readonly coordinator: LocationIndexCoordinator.Interface
  readonly events: EventV2.Interface
  readonly instance: { readonly directory: string }
}): Effect.Effect<void, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const scheduled = new Set<"code" | "repo_documents">()
    const schedule = (projectionKind: "code" | "repo_documents") => {
      if (scheduled.has(projectionKind)) return Effect.void
      scheduled.add(projectionKind)
      return Effect.sleep(50).pipe(
        Effect.andThen(input.coordinator.drain(projectionKind)),
        Effect.ensuring(Effect.sync(() => scheduled.delete(projectionKind))),
        Effect.catch(() => Effect.void),
        Effect.forkIn(scope),
        Effect.asVoid,
      )
    }
    const unsubscribe = yield* input.events.listen((event) => {
      if (event.location?.directory !== input.instance.directory) return Effect.void
      if (event.type === Watcher.Event.Overflow.type) {
        return input.coordinator
          .requestReconciliation({ reason: "overflow", source: "watcher" })
          .pipe(
            Effect.andThen(Effect.all([schedule("code"), schedule("repo_documents")], { discard: true })),
            Effect.catch(() => Effect.void),
          )
      }
      if (event.type !== Watcher.Event.Updated.type) return Effect.void
      const data = event.data as EventV2.Data<typeof Watcher.Event.Updated>
      return input.coordinator.observe(data).pipe(
        Effect.andThen(Effect.all([schedule("code"), schedule("repo_documents")], { discard: true })),
        Effect.catch(() => Effect.void),
      )
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    yield* input.coordinator.initialize()
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const coordinator = yield* LocationIndexCoordinator.Service
    const events = yield* EventV2Bridge.Service
    const instance = yield* InstanceRef
    if (!instance) return Service.of({})
    yield* start({ coordinator, events, instance })
    return Service.of({})
  }),
)
