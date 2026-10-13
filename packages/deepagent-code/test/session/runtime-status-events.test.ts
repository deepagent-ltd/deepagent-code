import { expect, test } from "bun:test"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { EventV2 } from "@deepagent-code/core/event"
import { Database } from "@deepagent-code/core/database/database"
import { Execution } from "@deepagent-code/core/session/event"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { SessionRunCoordinator } from "@deepagent-code/core/session/run-coordinator"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionRuntimeStatusEvents } from "../../src/session/runtime-status-events"

const id = SessionSchema.ID.make("ses_status_event")
const data = { sessionID: id, timestamp: DateTime.makeUnsafe(1000) }
const runtime = (list: SessionRuntimeStatus.Interface["list"]) => SessionRuntimeStatus.Service.of({
  list, blockedRedrives: Effect.succeed([]),
})
const execution = (coordinator: SessionRunCoordinator.Coordinator<SessionSchema.ID, void, SessionRunner.RunError>) =>
  SessionExecution.Service.of({
    active: coordinator.active, resume: coordinator.run, wake: coordinator.wake,
    interrupt: coordinator.interrupt, awaitIdle: coordinator.awaitIdle,
  })

test("recognizes only valid Core execution terminals", () => {
  expect(SessionRuntimeStatusEvents.sessionID({ id: EventV2.ID.create(), type: Execution.Succeeded.type, data })).toBe(id)
  expect(SessionRuntimeStatusEvents.sessionID({ id: EventV2.ID.create(), type: Execution.Failed.type,
    data: { ...data, error: { type: "unknown", message: "stopped" } } })).toBe(id)
  expect(SessionRuntimeStatusEvents.sessionID({ id: EventV2.ID.create(), type: Execution.Interrupted.type,
    data: { ...data, reason: "user" } })).toBe(id)
  expect(SessionRuntimeStatusEvents.sessionID({ id: EventV2.ID.create(), type: Execution.Started.type, data })).toBeUndefined()
  expect(SessionRuntimeStatusEvents.sessionID({ id: EventV2.ID.create(), type: Execution.Interrupted.type,
    data: { ...data, reason: "made_up" } })).toBeUndefined()
  expect(SessionRuntimeStatusEvents.sessionID({ id: EventV2.ID.create(), type: Execution.Succeeded.type,
    data: { sessionID: id } })).toBeUndefined()
})

test.each([false, true])("waits for actual owner cleanup before reading status (runner failed: %s)", (failed) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const terminal = yield* Deferred.make<void>()
    const cleanup = yield* Deferred.make<void>()
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, void, SessionRunner.RunError>({
      drain: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish)),
        Effect.andThen(failed ? Effect.fail(new SessionRunner.ExecutionRecoveryRequiredError({ sessionID: id })) : Effect.void)),
      settled: () => Deferred.succeed(terminal, undefined).pipe(Effect.andThen(Deferred.await(cleanup))),
    })
    const snapshots: string[] = []
    const current = runtime(Effect.sync(() => {
      snapshots.push("read")
      return new Map<SessionSchema.ID, SessionRuntimeStatus.State>(failed
        ? [[id, { status: "recovery_required", blockedReason: "recovery_required" }]] : [])
    }))
    yield* coordinator.wake(id)
    yield* Deferred.await(entered)
    const observer = yield* SessionRuntimeStatusEvents.read(execution(coordinator), current, id).pipe(Effect.forkChild)
    yield* Deferred.succeed(finish, undefined)
    yield* Deferred.await(terminal)
    yield* Effect.yieldNow
    expect(snapshots).toEqual([])
    expect((yield* coordinator.active).has(id)).toBe(true)
    yield* Deferred.succeed(cleanup, undefined)
    expect(yield* Fiber.join(observer)).toEqual({ sessionID: id, status: failed
      ? { type: "recovery_required", blockedReason: "recovery_required",
        message: "Execution stopped with unresolved durable work; inspect recovery before resuming" }
      : { type: "idle" } })
    expect(snapshots).toEqual(["read"])
  }).pipe(Effect.scoped, Effect.runPromise),
)

test("observer cancellation preserves the real active owner and a current busy snapshot", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const bodies: string[] = []
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, void, SessionRunner.RunError>({
      drain: () => Effect.sync(() => bodies.push("drain")).pipe(Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(finish))),
    })
    const current = runtime(Effect.succeed(new Map([[id, { status: "busy" as const }]])))
    yield* coordinator.wake(id)
    yield* Deferred.await(entered)
    const observer = yield* SessionRuntimeStatusEvents.read(execution(coordinator), current, id).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(observer)
    expect((yield* coordinator.active).has(id)).toBe(true)
    expect(bodies).toEqual(["drain"])
    yield* Deferred.succeed(finish, undefined)
    yield* coordinator.awaitIdle(id)
    // The snapshot may already reflect a newer owner than the terminal being observed.
    expect(yield* SessionRuntimeStatusEvents.read(execution(coordinator), current, id)).toEqual({
      sessionID: id, status: { type: "busy" },
    })
    expect(bodies).toEqual(["drain"])
  }).pipe(Effect.scoped, Effect.runPromise),
)

test("an interrupted owner still projects recovery after cleanup", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, void, SessionRunner.RunError>({
      drain: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    })
    const reads: string[] = []
    const current = runtime(Effect.sync(() => {
      reads.push("read")
      return new Map<SessionSchema.ID, SessionRuntimeStatus.State>([[id,
        { status: "recovery_required", blockedReason: "recovery_required" }]])
    }))
    yield* coordinator.wake(id)
    yield* Deferred.await(entered)
    const observer = yield* SessionRuntimeStatusEvents.read(execution(coordinator), current, id).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    yield* coordinator.interrupt(id)
    expect((yield* Fiber.join(observer)).status.type).toBe("recovery_required")
    expect(reads).toEqual(["read"])
  }).pipe(Effect.scoped, Effect.runPromise),
)

test("uses the production single-Session projection without falling back to global inventory", () =>
  Effect.gen(function* () {
    const requested: SessionSchema.ID[] = []
    const current = SessionRuntimeStatus.Service.of({
      list: Effect.die("Production get must not scan the global inventory"),
      blockedRedrives: Effect.die("Status read must not redrive recovery"),
      get: (sessionID) => Effect.sync(() => {
        requested.push(sessionID)
        return { status: "recovery_required" as const, blockedReason: "recovery_required" as const }
      }),
    })
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, void, SessionRunner.RunError>({
      drain: () => Effect.die("Status observation must not execute a drain"),
    })
    expect((yield* SessionRuntimeStatusEvents.read(execution(coordinator), current, id)).status.type).toBe("recovery_required")
    expect(requested).toEqual([id])
    expect((yield* coordinator.active).size).toBe(0)
  }).pipe(Effect.scoped, Effect.runPromise),
)

const database = Database.layerFromPath(":memory:")
const eventsLayer = EventV2.layer.pipe(Layer.provideMerge(database))

test("real event listener coalesces terminals, preserves location, and cancels waiting observers on disposal", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const scope = yield* Scope.make()
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, void, SessionRunner.RunError>({
      drain: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    })
    const reads: string[] = []
    const current = runtime(Effect.sync(() => { reads.push("read"); return new Map() }))
    const output = yield* SessionRuntimeStatusEvents.stream(events, execution(coordinator), current).pipe(Effect.provideService(Scope.Scope, scope))
    const collected = yield* output.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
    yield* coordinator.wake(id)
    yield* Deferred.await(entered)
    const location = { directory: AbsolutePath.make("/tmp/status-fixture") }
    yield* events.publish(Execution.Succeeded, data, { location })
    yield* events.publish(Execution.Interrupted, { ...data, reason: "user" }, { location })
    yield* Effect.yieldNow
    expect(reads).toEqual([])
    yield* Deferred.succeed(finish, undefined)
    expect(yield* Fiber.join(collected)).toEqual([{ location, properties: { sessionID: id, status: { type: "idle" } } }])
    expect(reads).toEqual(["read"])
    yield* Scope.close(scope, Exit.void)
    yield* events.publish(Execution.Succeeded, data, { location })
    expect(reads).toEqual(["read"])
  }).pipe(Effect.provide(eventsLayer), Effect.scoped, Effect.runPromise),
)

test("a successor terminal during snapshot read is coalesced into a fresh status", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const reads: string[] = []
    const current = runtime(Effect.suspend(() => {
      reads.push("read")
      if (reads.length > 1) return Effect.succeed(new Map<SessionSchema.ID, SessionRuntimeStatus.State>())
      return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish)),
        Effect.as(new Map<SessionSchema.ID, SessionRuntimeStatus.State>([[id, { status: "busy" }]])))
    }))
    const output = yield* SessionRuntimeStatusEvents.stream(events, SessionExecution.Service.of({
      active: Effect.succeed(new Set()), resume: () => Effect.void, wake: () => Effect.void,
      interrupt: () => Effect.void, awaitIdle: () => Effect.void,
    }), current)
    const collected = yield* output.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
    yield* events.publish(Execution.Succeeded, data)
    yield* Deferred.await(entered)
    yield* events.publish(Execution.Interrupted, { ...data, reason: "superseded" })
    yield* Deferred.succeed(finish, undefined)
    expect(yield* Fiber.join(collected)).toEqual([{ location: undefined,
      properties: { sessionID: id, status: { type: "idle" } } }])
    expect(reads).toEqual(["read", "read"])
  }).pipe(Effect.provide(eventsLayer), Effect.scoped, Effect.runPromise),
)

test("disconnect cancels a live coordinator observer and unsubscribes without interrupting its owner", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const scope = yield* Scope.make()
    const entered = yield* Deferred.make<void>()
    const observing = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, void, SessionRunner.RunError>({
      drain: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    })
    const stopped: string[] = []
    const original = execution(coordinator)
    const observed = SessionExecution.Service.of({ ...original, awaitIdle: (sessionID) =>
      Deferred.succeed(observing, undefined).pipe(Effect.andThen(original.awaitIdle(sessionID)),
        Effect.ensuring(Effect.sync(() => stopped.push("observer")).pipe(Effect.andThen(Deferred.succeed(cancelled, undefined))))) })
    const output = yield* SessionRuntimeStatusEvents.stream(events, observed,
      runtime(Effect.die("Disposed observer must not read status"))).pipe(Effect.provideService(Scope.Scope, scope))
    yield* output.pipe(Stream.runDrain, Effect.forkIn(scope))
    yield* coordinator.wake(id)
    yield* Deferred.await(entered)
    yield* events.publish(Execution.Succeeded, data)
    yield* Deferred.await(observing)
    yield* Scope.close(scope, Exit.void)
    yield* Deferred.await(cancelled).pipe(Effect.timeout("1 second"))
    expect(stopped).toEqual(["observer"])
    expect((yield* coordinator.active).has(id)).toBe(true)
    yield* events.publish(Execution.Succeeded, data)
    expect(stopped).toEqual(["observer"])
    yield* Deferred.succeed(finish, undefined)
    yield* coordinator.awaitIdle(id)
  }).pipe(Effect.provide(eventsLayer), Effect.scoped, Effect.runPromise),
)

test("a 65th distinct terminal fails the bounded observer stream instead of dropping recovery", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const output = yield* SessionRuntimeStatusEvents.stream(events, SessionExecution.Service.of({
      active: Effect.succeed(new Set()), resume: () => Effect.void, wake: () => Effect.void,
      interrupt: () => Effect.void, awaitIdle: () => Effect.never,
    }), runtime(Effect.succeed(new Map())))
    // Listener registration is eager, even before the stream consumer starts.
    yield* Effect.forEach(Array.from({ length: 65 }, (_, index) => SessionSchema.ID.make(`ses_status_overflow_${index}`)),
      (sessionID) => events.publish(Execution.Succeeded, { ...data, sessionID }), { concurrency: 1, discard: true })
    const exit = yield* output.pipe(Stream.runDrain, Effect.exit)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("64-Session buffer")
  }).pipe(Effect.provide(eventsLayer), Effect.scoped, Effect.runPromise),
)

test("limits simultaneous observers to four and overflow cancels all held waits", () =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const four = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    const active = new Set<SessionSchema.ID>()
    const counts: number[] = []
    const output = yield* SessionRuntimeStatusEvents.stream(events, SessionExecution.Service.of({
      active: Effect.succeed(new Set()), resume: () => Effect.void, wake: () => Effect.void,
      interrupt: () => Effect.void,
      awaitIdle: (sessionID) => Effect.sync(() => {
        active.add(sessionID)
        counts.push(active.size)
        if (active.size === 4) Deferred.doneUnsafe(four, Effect.void)
      }).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => {
        active.delete(sessionID)
        if (active.size === 0) Deferred.doneUnsafe(cancelled, Effect.void)
      }))),
    }), runtime(Effect.die("Held observers must not read status")))
    const consuming = yield* output.pipe(Stream.runDrain, Effect.exit, Effect.forkChild)
    yield* Effect.forEach(Array.from({ length: 64 }, (_, index) => SessionSchema.ID.make(`ses_status_held_${index}`)),
      (sessionID) => events.publish(Execution.Succeeded, { ...data, sessionID }), { concurrency: 1, discard: true })
    yield* Deferred.await(four)
    expect(active.size).toBe(4)
    expect(Math.max(...counts)).toBe(4)
    yield* events.publish(Execution.Succeeded, { ...data, sessionID: SessionSchema.ID.make("ses_status_held_overflow") })
    const exit = yield* Fiber.join(consuming)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("64-Session buffer")
    yield* Deferred.await(cancelled).pipe(Effect.timeout("1 second"))
    expect(active.size).toBe(0)
  }).pipe(Effect.provide(eventsLayer), Effect.scoped, Effect.runPromise),
)
