import { Context, Deferred, Effect, Layer, Option, Scope } from "effect"
import * as Socket from "effect/unstable/socket/Socket"

export const SERVER_CLOSING_EVENT = () => new Socket.CloseEvent(1001, "server closing")

type Close = Effect.Effect<void, unknown>

export interface Registration {
  readonly accepted: boolean
  readonly shutdown: Effect.Effect<void>
}

export interface Interface {
  readonly register: (close: Close) => Effect.Effect<Registration, never, Scope.Scope>
  readonly closeAll: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/HttpApiWebSocketTracker") {}

export const layer = Layer.sync(Service)(() => {
  const sockets = new Set<{ close: Close; shutdown: Deferred.Deferred<void> }>()
  const closed = Deferred.makeUnsafe<void>()
  let closing = false
  return Service.of({
    register: (close) =>
      Effect.gen(function* () {
        if (closing) return { accepted: false, shutdown: Effect.void }
        const entry = { close, shutdown: yield* Deferred.make<void>() }
        sockets.add(entry)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sockets.delete(entry)
          }),
        )
        return { accepted: true, shutdown: Deferred.await(entry.shutdown) }
      }),
    closeAll: Effect.gen(function* () {
      if (closing) return yield* Deferred.await(closed)
      closing = true
      const active = Array.from(sockets)
      sockets.clear()
      yield* Effect.all(
        active.map((entry) =>
          Effect.gen(function* () {
            const done = Deferred.makeUnsafe<void>()
            const closeFiber = yield* Effect.forkDetach(
              entry.close.pipe(
                Effect.catchCause(() => Effect.void),
                Effect.ensuring(Deferred.succeed(done, undefined).pipe(Effect.ignore)),
              ),
            )
            yield* Deferred.await(done).pipe(Effect.timeout("1 second"), Effect.ignore)
            yield* Effect.sync(() => closeFiber.interruptUnsafe())
            yield* Deferred.succeed(entry.shutdown, undefined)
          }),
        ),
        { concurrency: "unbounded", discard: true },
      )
      yield* Deferred.succeed(closed, undefined)
    }),
  })
})

export const register = (close: Close) =>
  Effect.gen(function* () {
    const tracker = yield* Effect.serviceOption(Service)
    if (Option.isNone(tracker)) return { accepted: true, shutdown: Effect.never }
    return yield* tracker.value.register(close)
  })

export * as WebSocketTracker from "./websocket-tracker"
