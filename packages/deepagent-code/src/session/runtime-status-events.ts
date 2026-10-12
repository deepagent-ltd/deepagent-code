export * as SessionRuntimeStatusEvents from "./runtime-status-events"

import { EventV2 } from "@deepagent-code/core/event"
import { Execution } from "@deepagent-code/core/session/event"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { Cause, Deferred, Effect, Fiber, Queue, Schema, Stream } from "effect"
import { SessionStatus } from "./status"

export function sessionID(event: EventV2.Payload): SessionSchema.ID | undefined {
  if (Schema.is(Execution.Succeeded)(event)) return event.data.sessionID
  if (Schema.is(Execution.Failed)(event)) return event.data.sessionID
  if (Schema.is(Execution.Interrupted)(event)) return event.data.sessionID
  return undefined
}

/** Wait for the original owner cleanup, then read current authority without executing work. */
export const read = Effect.fn("SessionRuntimeStatusEvents.read")(function* (
  execution: SessionExecution.Interface,
  runtime: SessionRuntimeStatus.Interface,
  sessionID: SessionSchema.ID,
) {
  // The owner's failed/interrupted settlement is a value from our own waiter.
  // Canceling this observer cancels only its child wait, never the Session owner.
  const waiter = yield* execution.awaitIdle(sessionID).pipe(Effect.forkChild)
  yield* Fiber.await(waiter)
  const current = runtime.get ? yield* runtime.get(sessionID) : (yield* runtime.list).get(sessionID)
  const status: SessionStatus.Info = current?.status === "busy"
    ? { type: "busy" }
    : current?.status === "recovery_required"
      ? {
        type: "recovery_required",
        message: "Execution stopped with unresolved durable work; inspect recovery before resuming",
        ...(current.blockedReason ? { blockedReason: current.blockedReason } : {}),
      }
      : { type: "idle" }
  return { sessionID, status }
})

/** Advisory status projection; the original event stream remains the fact authority. */
export const stream = Effect.fn("SessionRuntimeStatusEvents.stream")(function* (
  events: EventV2.Interface,
  execution: SessionExecution.Interface,
  runtime: SessionRuntimeStatus.Interface,
) {
  const pending = new Map<SessionSchema.ID, {
    sessionID: SessionSchema.ID
    location: EventV2.Payload["location"]
    revision: number
  }>()
  const failure = yield* Deferred.make<never, Error>()
  const queue = yield* Queue.dropping<{
    sessionID: SessionSchema.ID
    location: EventV2.Payload["location"]
    revision: number
  }, Error | Cause.Done>(64)
  const unsubscribe = yield* events.listen((event) => Effect.sync(() => {
    const id = sessionID(event)
    if (id === undefined) return
    const current = pending.get(id)
    if (current) {
      current.revision += 1
      current.location = event.location
      return
    }
    // Include in-flight observers in the bound. Losing a terminal silently would leave
    // clients with a stale busy status; fail SSE so they obtain a new bootstrap snapshot.
    if (pending.size >= 64) {
      const error = new Error("Runtime status observer exceeded its 64-Session buffer")
      Deferred.doneUnsafe(failure, Effect.fail(error))
      Queue.failCauseUnsafe(queue, Cause.fail(error))
      return
    }
    const candidate = { sessionID: id, location: event.location, revision: 0 }
    pending.set(id, candidate)
    if (Queue.offerUnsafe(queue, candidate)) return
    pending.delete(id)
    const error = new Error("Runtime status observer queue is unavailable")
    Deferred.doneUnsafe(failure, Effect.fail(error))
    Queue.failCauseUnsafe(queue, Cause.fail(error))
  }))
  yield* Effect.addFinalizer(() => unsubscribe.pipe(
    Effect.andThen(Queue.shutdown(queue)), Effect.andThen(Effect.sync(() => pending.clear())),
  ))
  return Stream.fromQueue(queue).pipe(
    Stream.mapEffect((event) => Effect.gen(function* () {
      // A successor terminal may arrive while the database snapshot is being read.
      // Coalesce into this observer, but never publish its now-stale busy snapshot.
      while (true) {
        const revision = event.revision
        const properties = yield* read(execution, runtime, event.sessionID)
        if (event.revision === revision) return { location: event.location, properties }
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => pending.delete(event.sessionID))),
    ), { concurrency: 4, unordered: true }),
    // Queue failure alone is buffered behind waiting observers. This independent
    // failure channel ends SSE immediately, including when all four waits are held.
    Stream.merge(Stream.fromEffect(Deferred.await(failure)), { haltStrategy: "either" }),
  )
})
