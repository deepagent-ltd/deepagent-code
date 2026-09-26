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
import { Delegation } from "../../tool/delegation"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap
    const events = yield* EventV2.Service
    // Drain fibers are forked from this layer's captured context and structurally cannot see the
    // process root; carrying the per-root delegation holder lets the Core `task` tool reach the
    // root SessionV2 service from inside a Location-scoped settle (see tool/delegation.ts).
    const delegation = yield* Delegation.DelegationSlot
    const ownedClaims = new Map<SessionSchema.ID, number>()
    const reportLifecycle = (sessionID: SessionSchema.ID, effect: Effect.Effect<void>) =>
      effect.pipe(
        Effect.tapCause((cause) =>
          Effect.gen(function* () {
            // A terminal event may fail after the release hook ran but before its transaction
            // committed. Leave the durable claim fenced for explicit recovery, and discard the
            // process-local token so a later START refusal cannot release it implicitly.
            ownedClaims.delete(sessionID)
            if (!Cause.hasInterruptsOnly(cause))
              yield* Effect.logError("Failed to publish Session execution lifecycle", cause).pipe(
                Effect.annotateLogs("sessionID", sessionID),
              )
          }),
        ),
        Effect.ignore,
      )
    const releaseOnCommit = (sessionID: SessionSchema.ID) => ({
      commit: () => {
        const token = ownedClaims.get(sessionID)
        if (token === undefined) return Effect.die(`Session execution claim token missing: ${sessionID}`)
        return store.release(sessionID, token).pipe(
          Effect.flatMap((released) =>
            released
              ? Effect.void
              : Effect.die(`Session execution claim token changed: ${sessionID}`),
          ),
        )
      },
    })
    const coordinator = yield* SessionRunCoordinator.make<
      SessionSchema.ID,
      void,
      SessionRunner.RunError,
      SessionExecution.InterruptReason
    >({
      started: (sessionID) =>
        Effect.gen(function* () {
          const session = yield* store.get(sessionID)
          if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
          let claimedToken: number | undefined
          yield* events.publishChecked(
            SessionEvent.Execution.Started,
            { sessionID, timestamp: yield* DateTime.now },
            {
              commit: () => store.claim(sessionID).pipe(Effect.flatMap((token) =>
                token === undefined
                  ? Effect.fail(new SessionRunner.ExecutionRecoveryRequiredError({ sessionID }))
                  : Effect.sync(() => { claimedToken = token }),
              )),
              location: session.location,
            },
          )
          if (claimedToken === undefined) return yield* Effect.die(`Session execution claim token missing after Started: ${sessionID}`)
          ownedClaims.set(sessionID, claimedToken)
        }).pipe(
          // A refused claim aborts the event transaction. Recover only this expected CAS result
          // from the checked hook channel; all other hook failures remain defects.
          Effect.catch((error) =>
            error.cause instanceof SessionRunner.ExecutionRecoveryRequiredError
              ? Effect.fail(error.cause)
              : Effect.die(error),
          ),
          Effect.asVoid,
        ),
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, mode) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force: mode === "run" })).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.provideService(Delegation.DelegationSlot, delegation),
        )
      }),
      onFailure: (sessionID, cause) => logFailure("Failed to drain Session", sessionID, cause),
      settled: (sessionID, exit, reason) =>
        reportLifecycle(
          sessionID,
          Effect.gen(function* () {
            if (
              exit._tag === "Failure" &&
              exit.cause.reasons.some(
                (item) =>
                  Cause.isFailReason(item) && item.error instanceof SessionRunner.ExecutionRecoveryRequiredError,
              )
            ) {
              // The no-event early return serves the START-time CAS refusal (no claim was ever
              // acquired). A MID-DRAIN recovery escalation owns its execution claim: the drain is
              // over, so releasing here is required — the recovery fence for the underlying
              // evidence lives in the receipt state machine, not in this execution claim.
              const token = ownedClaims.get(sessionID)
              if (token !== undefined)
                yield* store
                  .release(sessionID, token)
                  .pipe(
                    Effect.flatMap((released) =>
                      released ? Effect.sync(() => ownedClaims.delete(sessionID)) : Effect.void,
                    ),
                    Effect.ignore,
                  )
              return
            }
            // The Started event may have failed after its in-transaction claim hook; neither
            // the DB claim nor the process-local token exists after that rollback.
            if (!ownedClaims.has(sessionID)) return
            const session = yield* store.get(sessionID)
            if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
            const outcome = SessionExecution.terminal(exit, reason)
            const timestamp = yield* DateTime.now
            if (outcome.type === "succeeded") {
              yield* events.publish(
                SessionEvent.Execution.Succeeded,
                { sessionID, timestamp },
                { ...releaseOnCommit(sessionID), location: session.location },
              )
              ownedClaims.delete(sessionID)
              return
            }
            if (outcome.type === "interrupted") {
              yield* events.publish(
                SessionEvent.Execution.Interrupted,
                { sessionID, timestamp, reason: outcome.reason },
                {
                  ...(outcome.reason === "shutdown" ? {} : releaseOnCommit(sessionID)),
                  location: session.location,
                },
              )
              if (outcome.reason !== "shutdown") ownedClaims.delete(sessionID)
              return
            }
            yield* events.publish(
              SessionEvent.Execution.Failed,
              { sessionID, timestamp, error: outcome.error },
              { ...releaseOnCommit(sessionID), location: session.location },
            )
            ownedClaims.delete(sessionID)
          }),
        ),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: (sessionID, seq) => coordinator.interrupt(sessionID, seq, "user"),
      resume: coordinator.run,
      wake: (sessionID, seq) =>
        store.interruptSeq(sessionID).pipe(
          Effect.flatMap((interruptSeq) =>
            interruptSeq !== undefined && (seq === undefined || seq <= interruptSeq)
              ? Effect.void
              : coordinator.wake(sessionID, seq),
          ),
        ),
      awaitIdle: coordinator.awaitIdle,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Delegation.delegationSlotLayer),
)

export const liveLayer = Layer.suspend(() => defaultLayer.pipe(Layer.provide(LocationServiceMap.layer)))
