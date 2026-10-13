export * as GoalTickExecution from "./goal-tick-execution"

import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalChildPolicy } from "@deepagent-code/core/deepagent/goal-child-policy"
import { GoalChildSchema } from "@deepagent-code/core/deepagent/goal-child.schema"
import { GoalTickCheckpointV2 } from "@deepagent-code/core/deepagent/goal-tick-checkpoint-v2"
import { GoalTickCheckpoint } from "@deepagent-code/core/deepagent/goal-tick-checkpoint"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import type { SessionRunCoordinator } from "@deepagent-code/core/session/run-coordinator"
import type { SessionSchema } from "@deepagent-code/core/session/schema"

const identity: unique symbol = Symbol("GoalTickExecution.Frame")
export type Frame = { readonly [identity]: true }
type Receipt = SessionRunCoordinator.OwnedReceipt<SessionSchema.ID>
type Entry = {
  permit: GoalControl.Permit
  policy: GoalChildPolicy.Frame
  receipts: Set<Receipt>
  revoked: boolean
  signal?: () => void
  completed: Deferred.Deferred<void>
}
export interface Interface {
  readonly withFrame: <A, E, R>(
    permit: GoalControl.Permit,
    body: (frame: Frame) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | GoalChildSchema.Error, R>
  readonly policy: (frame: Frame) => GoalChildPolicy.Frame | undefined
  readonly current: (frame: Frame) => Effect.Effect<void, GoalChildSchema.Error>
  readonly registered: (frame: Frame, receipt: Receipt) => void
  /** Call only after the control transaction committed. This never looks up a fiber by Session ID. */
  readonly control: (goalID: string, committedRevision: number) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("deepagent-code/GoalTickExecution") {}
const failure = () =>
  new GoalChildSchema.Error({ code: "GOAL_CHILD_RECOVERY_REQUIRED", message: "Goal tick frame is no longer current" })

/** One root-scoped bounded frame registry; SessionExecution still owns every process-local drain. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const execution = yield* SessionExecution.Service
    const entries = new Map<Frame, Entry>()
    const stop = (frame: Frame, entry: Entry, awaitBody = true) =>
      Effect.gen(function* () {
        entry.revoked = true
        GoalChildPolicy.revokeFrame(entry.policy)
        // Send first. Await the single join owner's finalization receipt, not a second observer
        // on the interrupted fiber (whose synchronous completion can re-enter its join owner).
        entry.signal?.()
        const owned = execution.owned
        // Start every exact interrupt before waiting: the tick finalizer may itself await a drain.
        const joins = [
          ...(awaitBody ? [Deferred.await(entry.completed)] : []),
          ...(owned
            ? [...entry.receipts].map((receipt) =>
                owned
                  .interrupt(receipt, () => entries.get(frame) === entry && entry.revoked, undefined, "user")
                  .pipe(Effect.andThen(owned.await(receipt)), Effect.asVoid),
              )
            : []),
        ]
        yield* Effect.all(joins, { concurrency: Math.max(1, joins.length), discard: true })
      })
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...entries],
        ([frame, entry]) =>
          stop(frame, entry).pipe(
            Effect.andThen(GoalChildPolicy.releaseFrame(db, entry.policy)),
            Effect.orDie,
            Effect.ensuring(Effect.sync(() => entries.delete(frame))),
          ),
        { discard: true },
      ),
    )
    const current = (frame: Frame) =>
      Effect.gen(function* () {
        const entry = entries.get(frame)
        if (!entry || entry.revoked || !GoalChildPolicy.frameCurrent(entry.policy, entry.permit.permit_id))
          return yield* failure()
        const goal = yield* GoalControl.get(db, entry.permit.goal_id).pipe(Effect.mapError(() => failure()))
        if (
          !goal ||
          !goal.is_current ||
          goal.revision !== entry.permit.control_revision ||
          goal.requested_phase !== "running" ||
          goal.next_seq !== entry.permit.tick_seq
        )
          return yield* failure()
      })
    return Service.of({
      policy: (frame) => {
        const entry = entries.get(frame)
        return entry && !entry.revoked ? entry.policy : undefined
      },
      current,
      registered: (frame, receipt) => {
        const entry = entries.get(frame)
        if (!entry) throw failure()
        entry.receipts.add(receipt)
        // Coordinator registration defects settle this same Entry before Started; they cannot leak an owner.
        if (entry.revoked) throw failure()
      },
      control: (goalID, committedRevision) =>
        Effect.forEach(
          [...entries].filter(
            ([, entry]) => entry.permit.goal_id === goalID && entry.permit.control_revision < committedRevision,
          ),
          ([frame, entry]) => stop(frame, entry),
          { discard: true },
        ),
      withFrame: (permit, body) =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            if (
              !execution.owned ||
              entries.size >= 32 ||
              [...entries.values()].some((entry) => entry.permit.permit_id === permit.permit_id)
            )
              return yield* new GoalChildSchema.Error({
                code: "GOAL_CHILD_UNAVAILABLE",
                message: "Owned Goal tick frames are busy or unavailable",
              })
            const current = yield* GoalTickCheckpoint.currentPermit(db, permit.permit_id, permit.token).pipe(
              Effect.mapError(() => failure()),
            )
            if (GoalControl.fingerprint(current.permit) !== GoalControl.fingerprint(permit)) return yield* failure()
            const policy = yield* GoalChildPolicy.openFrame(db, permit.permit_id).pipe(Effect.mapError(() => failure()))
            const frame: Frame = Object.freeze({ [identity]: true as const })
            entries.set(frame, {
              permit: current.permit,
              policy,
              receipts: new Set(),
              revoked: false,
              completed: yield* Deferred.make<void>(),
            })
            return frame
          }),
          (frame) =>
            Effect.gen(function* () {
              const fiber = yield* body(frame).pipe(Effect.forkChild)
              entries.get(frame)!.signal = () => fiber.interruptUnsafe()
              return yield* Fiber.join(fiber)
            }),
          (frame, exit) => {
            const entry = entries.get(frame)!
            return Effect.gen(function* () {
              yield* stop(frame, entry, false)
              if (Exit.isFailure(exit)) yield* GoalTickCheckpointV2.markUnknown(db, permit.permit_id).pipe(Effect.orDie)
              yield* GoalChildPolicy.releaseFrame(db, entry.policy).pipe(Effect.orDie)
              entries.delete(frame)
            }).pipe(Effect.ensuring(Deferred.succeed(entry.completed, undefined)))
          },
        ),
    })
  }),
)

// Both host roots use this same layer identity; SessionExecution remains an outer shared authority.
export const runtimeLayer = layer.pipe(Layer.provide(Database.defaultLayer))
