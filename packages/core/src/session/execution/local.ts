import { GoalChildSchema } from "../../deepagent/goal-child.schema"
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
import { WorkAuthoritySchema } from "../work-authority.schema"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const owned = store.goalOwned?.()
    const withReceipt = <A, E, R>(
      receipt: SessionRunCoordinator.OwnedReceipt<SessionSchema.ID> | undefined,
      effect: Effect.Effect<A, E, R>,
    ) => (owned ? owned.withReceipt(receipt, effect) : effect)
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
    const releaseOnCommit = (
      sessionID: SessionSchema.ID,
      receipt?: SessionRunCoordinator.OwnedReceipt<SessionSchema.ID>,
      state: GoalChildSchema.Execution["state"] = "recovery_required",
    ) => ({
      commit: () => {
        const token = ownedClaims.get(sessionID)
        if (token === undefined) return Effect.die(`Session execution claim token missing: ${sessionID}`)
        return (owned?.finish(receipt, state) ?? Effect.void).pipe(
          Effect.orDie,
          Effect.andThen(store.release(sessionID, token)),
          Effect.flatMap((released) =>
            released ? Effect.void : Effect.die(`Session execution claim token changed: ${sessionID}`),
          ),
        )
      },
    })
    const coordinator: SessionRunCoordinator.Coordinator<SessionSchema.ID, void, SessionRunner.RunError, SessionExecution.InterruptReason> = yield* SessionRunCoordinator.make<
      SessionSchema.ID,
      void,
      SessionRunner.RunError,
      SessionExecution.InterruptReason
    >({
      captureRunScope: (sessionID) => Effect.gen(function* () {
        const { WorkKnownRecovery } = yield* Effect.promise(() => import("../work-known-recovery"))
        return yield* WorkKnownRecovery.captureContinuation(sessionID)
      }),
      started: (sessionID, receipt) =>
        withReceipt(
          receipt,
          Effect.gen(function* () {
            yield* store.requireExecution(sessionID)
            const session = yield* store.get(sessionID)
            if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
            let claimedToken: number | undefined
            let link: GoalChildSchema.Execution | undefined
            yield* events.publishChecked(
              SessionEvent.Execution.Started,
              { sessionID, timestamp: yield* DateTime.now },
              {
                commit: (seq) =>
                  store.requireExecution(sessionID, { prepareSource: false }).pipe(
                    Effect.andThen(store.claim(sessionID)),
                    Effect.flatMap((token) =>
                      Effect.gen(function* () {
                        if (token === undefined)
                          return yield* new SessionRunner.ExecutionRecoveryRequiredError({ sessionID })
                        if (receipt) link = yield* owned!.bind(receipt, token, seq)
                        claimedToken = token
                      }),
                    ),
                  ),
                location: session.location,
              },
            )
            if (claimedToken === undefined)
              return yield* Effect.die(`Session execution claim token missing after Started: ${sessionID}`)
            if (receipt && link) owned!.committed(receipt, link)
            ownedClaims.set(sessionID, claimedToken)
          }).pipe(
            // Control can refuse before publishChecked or inside its transactional hook. Preserve
            // either typed refusal; unexpected hook failures remain defects and keep claims fenced.
            Effect.catch((error) =>
              error instanceof WorkAuthoritySchema.Error || error instanceof GoalChildSchema.Error
                ? Effect.fail(error)
                : error.cause instanceof SessionRunner.ExecutionRecoveryRequiredError ||
                    error.cause instanceof WorkAuthoritySchema.Error ||
                    error.cause instanceof GoalChildSchema.Error
                  ? Effect.fail(error.cause)
                  : Effect.die(error),
            ),
            Effect.asVoid,
          ),
        ),
      drain: (sessionID, mode, receipt, activityID) =>
        withReceipt(
          receipt,
          Effect.gen(function* () {
            yield* store.requireExecution(sessionID)
            const session = yield* store.get(sessionID)
            if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
            return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force: mode === "run", activityID })).pipe(
              Effect.provide(locations.get(session.location)),
              Effect.provideService(Delegation.DelegationSlot, delegation),
              // A bounded continuation owns only its activity. Independently admitted future
              // inputs retain their normal wake path after that activity settles or pauses.
              Effect.tap(() => activityID === undefined ? Effect.void : coordinator.wake(sessionID)),
            )
          }),
        ),
      onFailure: (sessionID, cause) => logFailure("Failed to drain Session", sessionID, cause),
      settled: (sessionID, exit, reason, receipt) =>
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
                yield* (
                  owned
                    ? owned.transaction(
                        owned
                          .finish(receipt, "recovery_required")
                          .pipe(Effect.andThen(store.release(sessionID, token))),
                      )
                    : store.release(sessionID, token)
                ).pipe(
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
                { ...releaseOnCommit(sessionID, receipt, "settled"), location: session.location },
              )
              ownedClaims.delete(sessionID)
              return
            }
            if (outcome.type === "interrupted") {
              yield* events.publish(
                SessionEvent.Execution.Interrupted,
                { sessionID, timestamp, reason: outcome.reason },
                {
                  ...(outcome.reason === "shutdown"
                    ? { commit: () => (owned?.finish(receipt, "recovery_required") ?? Effect.void).pipe(Effect.orDie) }
                    : releaseOnCommit(sessionID, receipt, "interrupted")),
                  location: session.location,
                },
              )
              if (outcome.reason !== "shutdown") ownedClaims.delete(sessionID)
              return
            }
            yield* events.publish(
              SessionEvent.Execution.Failed,
              { sessionID, timestamp, error: outcome.error },
              { ...releaseOnCommit(sessionID, receipt), location: session.location },
            )
            ownedClaims.delete(sessionID)
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => owned?.revoke(receipt)))),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      owned: owned
        ? {
            run: (target, options) =>
              Effect.gen(function* () {
                if (options?.receipt) {
                  if (!owned.matches(options.receipt, target)) return { status: "not-local" } as const
                  return yield* coordinator.runOwned(
                    SessionSchema.ID.make((yield* owned.prepareForJoin(target)).sessionID),
                    options.receipt,
                  )
                }
                const prepared = yield* owned.prepare(target)
                return yield* coordinator.runOwned(prepared.sessionID, undefined, (receipt) => {
                  owned.register(receipt, prepared)
                  options?.registered?.(receipt)
                })
              }),
            interrupt: (receipt, predicate, seq, reason) =>
              coordinator.interruptIf(receipt, predicate, seq, reason ?? "user"),
            await: coordinator.awaitOwned,
          }
        : undefined,
      interrupt: (sessionID, seq) => coordinator.interrupt(sessionID, seq, "user"),
      resume: (sessionID, options) =>
        (owned?.ordinary(sessionID) ?? Effect.void).pipe(
          Effect.andThen(store.requireExecution(sessionID)),
          Effect.andThen(coordinator.run(sessionID, options)),
        ),
      wake: (sessionID, seq) =>
        (owned?.ordinary(sessionID) ?? Effect.void).pipe(
          Effect.andThen(
            store
              .interruptSeq(sessionID)
              .pipe(
                Effect.flatMap((interruptSeq) =>
                  interruptSeq !== undefined && (seq === undefined || seq <= interruptSeq)
                    ? Effect.void
                    : coordinator.wake(sessionID, seq),
                ),
              ),
          ),
          // Advisory delivery is not execution acceptance. A managed wake must never join an
          // owned Entry, while its historical fire-and-forget return remains compatible.
          Effect.catchTag("GoalChild.Error", () => Effect.void),
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
