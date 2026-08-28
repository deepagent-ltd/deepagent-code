import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { WebSocketTracker } from "../../src/server/routes/instance/httpapi/websocket-tracker"

describe("HttpApi WebSocketTracker", () => {
  test("closeAll closes active registrations and releases their handlers", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* WebSocketTracker.Service
          const closed: string[] = []
          const first = yield* WebSocketTracker.register(Effect.sync(() => closed.push("first")))
          const second = yield* WebSocketTracker.register(Effect.sync(() => closed.push("second")))

          yield* tracker.closeAll
          yield* Effect.all([first.shutdown, second.shutdown], { discard: true })

          return { accepted: [first.accepted, second.accepted], closed }
        }).pipe(Effect.provide(WebSocketTracker.layer)),
      ),
    )

    expect(result.accepted).toEqual([true, true])
    expect(result.closed.sort()).toEqual(["first", "second"])
  })

  test("rejects registrations after shutdown begins", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* WebSocketTracker.Service
          yield* tracker.closeAll
          return yield* WebSocketTracker.register(Effect.void)
        }).pipe(Effect.provide(WebSocketTracker.layer)),
      ),
    )

    expect(result.accepted).toBe(false)
    await expect(Effect.runPromise(result.shutdown)).resolves.toBeUndefined()
  })

  test("concurrent closeAll callers join the active shutdown", async () => {
    const joinedBeforeRelease = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* WebSocketTracker.Service
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const secondDone = yield* Deferred.make<void>()
          yield* WebSocketTracker.register(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )

          const first = yield* tracker.closeAll.pipe(Effect.forkChild)
          yield* Deferred.await(started)
          const second = yield* tracker.closeAll.pipe(
            Effect.ensuring(Deferred.succeed(secondDone, undefined)),
            Effect.forkChild,
          )
          yield* Effect.yieldNow
          const result = yield* Deferred.isDone(secondDone)
          yield* Deferred.succeed(release, undefined)
          yield* Effect.all([Fiber.join(first), Fiber.join(second)], { discard: true })
          return result
        }).pipe(Effect.provide(WebSocketTracker.layer)),
      ),
    )

    expect(joinedBeforeRelease).toBe(false)
  })

  test("signals handlers when a close action never completes", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tracker = yield* WebSocketTracker.Service
          const registration = yield* WebSocketTracker.register(Effect.never)
          yield* tracker.closeAll
          yield* registration.shutdown.pipe(Effect.timeout("2 seconds"))
        }).pipe(Effect.provide(WebSocketTracker.layer)),
      ),
    )
  })

  test("scope finalization removes registrations before closeAll", async () => {
    const closed: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const tracker = yield* WebSocketTracker.Service
        yield* Effect.scoped(WebSocketTracker.register(Effect.sync(() => closed.push("closed"))))
        yield* tracker.closeAll
      }).pipe(Effect.provide(WebSocketTracker.layer)),
    )

    expect(closed).toEqual([])
  })
})
