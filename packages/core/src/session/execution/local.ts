export * as SessionExecutionLocal from "./local"

import { Cause, DateTime, Effect, Layer } from "effect"
import { EventV2 } from "../../event"
import { LocationServiceMap } from "../../location-layer"
import { SessionEvent } from "../event"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { logFailure } from "../logging"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap
    const events = yield* EventV2.Service
    const reportLifecycle = (sessionID: SessionSchema.ID, effect: Effect.Effect<void>) =>
      effect.pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to publish Session execution lifecycle", cause).pipe(
                Effect.annotateLogs("sessionID", sessionID),
              ),
        ),
        Effect.ignore,
      )
    const clearSuspensionOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () => store.consumeSuspended(sessionID).pipe(Effect.asVoid),
    })
    const coordinator = yield* SessionRunCoordinator.make<
      SessionSchema.ID,
      void,
      SessionRunner.RunError,
      SessionExecution.InterruptReason
    >({
      started: (sessionID) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            yield* events.publish(
              SessionEvent.Execution.Started,
              { sessionID, timestamp: yield* DateTime.now },
              clearSuspensionOnCommit(sessionID),
            )
          }),
        ),
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, mode) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force: mode === "run" })).pipe(
          Effect.provide(locations.get(session.location)),
        )
      }),
      onFailure: (sessionID, cause) => logFailure("Failed to drain Session", sessionID, cause),
      settled: (sessionID, exit, reason) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            const outcome = SessionExecution.terminal(exit, reason)
            const timestamp = yield* DateTime.now
            if (outcome.type === "succeeded") {
              yield* events.publish(
                SessionEvent.Execution.Succeeded,
                { sessionID, timestamp },
                clearSuspensionOnCommit(sessionID),
              )
              return
            }
            if (outcome.type === "interrupted") {
              yield* events.publish(SessionEvent.Execution.Interrupted, {
                sessionID,
                timestamp,
                reason: outcome.reason,
              })
              return
            }
            yield* events.publish(
              SessionEvent.Execution.Failed,
              { sessionID, timestamp, error: outcome.error },
              clearSuspensionOnCommit(sessionID),
            )
          }),
        ),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: (sessionID, seq) => coordinator.interrupt(sessionID, seq, "user"),
      resume: coordinator.run,
      wake: coordinator.wake,
      awaitIdle: coordinator.awaitIdle,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionStore.defaultLayer), Layer.provide(EventV2.defaultLayer))

export const liveLayer = Layer.suspend(() => defaultLayer.pipe(Layer.provide(LocationServiceMap.layer)))
