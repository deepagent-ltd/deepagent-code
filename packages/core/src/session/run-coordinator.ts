export * as SessionRunCoordinator from "./run-coordinator"

import { Cause, Context, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Scope } from "effect"
import { SessionRunner } from "./runner"
import { logFailure } from "./logging"
import { SessionSchema } from "./schema"

export type Mode = "run" | "wake"

const ownedReceiptTypeId = Symbol("SessionRunCoordinator.OwnedReceipt")

/** Process-local evidence of one Entry, never a serializable execution authorization. */
export interface OwnedReceipt<Key> {
  readonly [ownedReceiptTypeId]: Key
}

export type OwnedStart<Key> =
  | { readonly status: "started" | "joined"; readonly receipt: OwnedReceipt<Key> }
  | { readonly status: "busy" | "not-local" | "obsolete" | "closed" }

export type OwnedInterruption =
  | { readonly status: "matched" | "not-local" }
  | { readonly status: "obsolete"; readonly reason: "closed" | "entry" | "predicate" | "boundary" }

export type OwnedSettlement<A, E> =
  | { readonly status: "not-local" }
  | { readonly status: "settled"; readonly exit: Exit.Exit<A, E> }

/** Why one drain generation should run. Explicit runs dominate advisory wakes when demands coalesce. */
type Demand = { readonly _tag: "run"; readonly activityID?: string } | { readonly _tag: "wake"; readonly seq?: number }

/**
 * Runs at most one drain chain per key while allowing different keys to drain concurrently.
 *
 * For each key:
 *
 *   idle --run/wake--> draining --run/wake--> draining + one coalesced rerun --> idle
 *
 * `run` is an explicit drain request. It starts a chain or joins the current chain and
 * upgrades a pending follow-up so the caller receives explicit-run semantics.
 *
 * `wake` reports that durable work may now be available. It starts a chain while idle or
 * requests one coalesced follow-up while draining. Repeated wakes collapse together.
 *
 * `interrupt` stops the current ownership chain. Advisory wakes received by that chain from before
 * the interrupt boundary are suppressed; durable admission owns idle/restart boundary filtering.
 */
export interface Coordinator<Key, A, E, Reason = never> {
  /** Snapshots keys with an ownership chain active in this process. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts or joins one explicit drain generation. */
  readonly run: (key: Key, options?: { readonly activityID?: string }) => Effect.Effect<A, E>
  /** Starts a new owned chain or joins only the exact receipt; never waits for another owner. */
  readonly runOwned: (
    key: Key,
    receipt?: OwnedReceipt<Key>,
    registered?: (receipt: OwnedReceipt<Key>) => void,
  ) => Effect.Effect<OwnedStart<Key>>
  /** Stops only the captured Entry after a pure synchronous current-control check. */
  readonly interruptIf: (
    receipt: OwnedReceipt<Key>,
    predicate: () => boolean,
    seq?: number,
    reason?: Reason,
  ) => Effect.Effect<OwnedInterruption>
  /** Waits for this receipt's Entry, including cleanup, without following successor Entries. */
  readonly awaitOwned: (receipt: OwnedReceipt<Key>) => Effect.Effect<OwnedSettlement<A, E>>
  /** Coalesces one wake-up after durable work is recorded. */
  readonly wake: (key: Key, seq?: number) => Effect.Effect<void>
  /** Waits until the current ownership chain settles. */
  readonly awaitIdle: (key: Key) => Effect.Effect<void, E>
  /** Interrupts the active ownership chain without automatically draining pending wakes. */
  readonly interrupt: (key: Key, seq?: number, reason?: Reason) => Effect.Effect<void>
}

/** One Session's process-local execution lane: one active demand and at most one coalesced follow-up. */
type RunScope = (effect: Effect.Effect<void>) => Effect.Effect<void>

type Entry<Key, A, E, Reason> = {
  readonly runScope?: RunScope
  // `done`/`explicitWaiter` carry their Exit on the SUCCESS channel (same as `settled`): a Deferred
  // completed with an interrupt-only cause wakes only ONE awaiter under the v4 runtime, so a second
  // joined caller would strand here on interrupt. Each awaiter re-raises the Exit in its own fiber.
  readonly done: Deferred.Deferred<Exit.Exit<A, E>>
  readonly settled: Deferred.Deferred<Exit.Exit<A, E>>
  readonly receipt?: OwnedReceipt<Key>
  current: Demand
  pending?: Demand
  explicitWaiter?: Deferred.Deferred<Exit.Exit<A, E>>
  interruptSeq?: number
  owner?: Fiber.Fiber<void, never>
  stopping: boolean
  started: boolean
  terminalizing: boolean
  interruptionReason?: Reason
}

/** Combines follow-up demand: runs dominate, while wakes retain the newest durable admission sequence. */
const coalesce = (left: Demand | undefined, right: Demand): Demand => {
  if (left?._tag === "run" && left.activityID === undefined) return left
  if (right._tag === "run") return right
  if (left?._tag === "run") return left
  return { _tag: "wake", seq: maxSeq(left?.seq, right.seq) }
}

const maxSeq = (left: number | undefined, right: number | undefined) => {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.max(left, right)
}

/** Constructs a scoped coordinator. Every in-memory transition is synchronous. */
export const make = <Key, A, E, Reason = never>(options: {
  readonly drain: (key: Key, mode: Mode, receipt?: OwnedReceipt<Key>, activityID?: string) => Effect.Effect<A, E>
  readonly onFailure?: (key: Key, cause: Cause.Cause<E>) => Effect.Effect<void>
  /** Trusted construction hook, never caller-supplied Context. Advisory wakes cannot capture it. */
  readonly captureRunScope?: (key: Key) => Effect.Effect<RunScope | undefined>
  /** Runs once before the first drain in one process-local ownership chain. */
  readonly started?: (key: Key, receipt?: OwnedReceipt<Key>) => Effect.Effect<void, E>
  /** Runs once after the final drain in one process-local ownership chain. */
  readonly settled?: (
    key: Key,
    exit: Exit.Exit<A, E>,
    reason?: Reason,
    receipt?: OwnedReceipt<Key>,
  ) => Effect.Effect<void>
}): Effect.Effect<Coordinator<Key, A, E, Reason>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<Key, A, E, Reason>>()
    // Exact object membership, not the brand/key or a persisted digest, grants local control.
    const receipts = new WeakMap<OwnedReceipt<Key>, { readonly key: Key; readonly entry: Entry<Key, A, E, Reason> }>()
    const report = yield* FiberSet.makeRuntime<never, void, never>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    const shutdown = Deferred.makeUnsafe<void>()
    let closed = false
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true
        Deferred.doneUnsafe(shutdown, Effect.void)
        active.clear()
      }),
    )

    const makeEntry = (
      current: Demand,
      explicitWaiter?: Deferred.Deferred<Exit.Exit<A, E>>,
      receipt?: OwnedReceipt<Key>,
      runScope?: RunScope,
    ): Entry<Key, A, E, Reason> => ({
      runScope,
      done: Deferred.makeUnsafe<Exit.Exit<A, E>>(),
      settled: Deferred.makeUnsafe<Exit.Exit<A, E>>(),
      receipt,
      current,
      explicitWaiter,
      stopping: false,
      started: false,
      terminalizing: false,
    })

    const start = (
      key: Key,
      entry: Entry<Key, A, E, Reason>,
      demand: Demand,
      successor = false,
      registered?: (receipt: OwnedReceipt<Key>) => void,
    ) => {
      const ready = Deferred.makeUnsafe<void>()
      const drain = Effect.suspend(() => options.drain(key, demand._tag, entry.receipt, demand._tag === "run" ? demand.activityID : undefined))
      const started = Effect.suspend(() => {
        if (entry.started) return Effect.void
        entry.started = true
        return options.started?.(key, entry.receipt) ?? Effect.void
      })
      // Receipt registration, active publication and owner assignment must precede even Started:
      // its transactional hook can race with a synchronous cancellation from another fiber.
      // Observer-started successors yield once so synchronous drains cannot recurse on the JS stack.
      const lifecycle = Deferred.await(ready).pipe(
        Effect.andThen(started),
        Effect.andThen(successor ? Effect.yieldNow.pipe(Effect.andThen(drain)) : drain),
        Effect.onExit((exit) => {
          if (exit._tag === "Success" && !entry.stopping && entry.pending !== undefined)
            return Effect.sync(() => settle(key, entry, demand, exit))
          entry.terminalizing = true
          return (options.settled?.(key, exit, entry.interruptionReason, entry.receipt) ?? Effect.void).pipe(
            Effect.ensuring(Effect.sync(() => settle(key, entry, demand, exit))),
          )
        }),
        Effect.exit,
        Effect.asVoid,
      )
      const owner = fork(entry.runScope ? entry.runScope(lifecycle) : lifecycle)
      entry.owner = owner
      // A registration defect belongs to this Entry and must use its normal cleanup path.
      // It cannot escape after publication and leave an owner waiting forever on ready.
      Deferred.doneUnsafe(
        ready,
        Effect.runSyncExit(
          Effect.sync(() => {
            if (entry.receipt) registered?.(entry.receipt)
          }),
        ),
      )
    }

    const settle = (key: Key, entry: Entry<Key, A, E, Reason>, demand: Demand, exit: Exit.Exit<A, E>) => {
      if (closed) {
        Deferred.doneUnsafe(entry.done, Effect.succeed(exit))
        Deferred.doneUnsafe(entry.settled, Effect.succeed(exit))
        return
      }
      if (demand._tag === "run" && entry.explicitWaiter !== undefined) {
        Deferred.doneUnsafe(entry.explicitWaiter, Effect.succeed(exit))
        entry.explicitWaiter = undefined
      }
      if (entry.stopping && demand._tag === "wake" && entry.explicitWaiter !== undefined) {
        Deferred.doneUnsafe(entry.explicitWaiter, Effect.succeed(exit))
        entry.explicitWaiter = undefined
      }
      if (active.get(key) !== entry) {
        Deferred.doneUnsafe(entry.done, Effect.succeed(exit))
        Deferred.doneUnsafe(entry.settled, Effect.succeed(exit))
        return
      }
      if (exit._tag === "Success" && !entry.stopping && !entry.terminalizing) {
        if (entry.pending !== undefined) {
          const pending = entry.pending
          entry.pending = undefined
          entry.current = pending
          start(key, entry, pending, true)
          return
        }
        active.delete(key)
        Deferred.doneUnsafe(entry.done, Effect.succeed(exit))
        Deferred.doneUnsafe(entry.settled, Effect.succeed(exit))
        return
      }

      const successor = entry.pending !== undefined ? makeEntry(entry.pending, entry.explicitWaiter) : undefined
      if (successor === undefined) active.delete(key)
      else active.set(key, successor)
      if (successor !== undefined) start(key, successor, successor.current, true)
      Deferred.doneUnsafe(entry.done, Effect.succeed(exit))
      Deferred.doneUnsafe(entry.settled, Effect.succeed(exit))
      if (
        exit._tag === "Failure" &&
        !(entry.stopping && Cause.hasInterruptsOnly(exit.cause)) &&
        demand._tag === "wake" &&
        options.onFailure !== undefined
      ) {
        report(Effect.suspend(() => options.onFailure!(key, exit.cause)))
      }
    }

    const wake = (key: Key, seq?: number) =>
      Effect.sync(() => {
        if (closed) return
        const entry = active.get(key)
        if (entry !== undefined) {
          if (!acceptsWake(entry, seq)) return
          entry.pending = coalesce(entry.pending, { _tag: "wake", seq })
          return
        }

        const next = makeEntry({ _tag: "wake", seq })
        active.set(key, next)
        start(key, next, next.current)
      })

    const awaitIdle = (key: Key): Effect.Effect<void, E> =>
      Effect.gen(function* () {
        let firstFailure: Cause.Cause<E> | undefined
        while (!closed) {
          const entry = active.get(key)
          if (entry === undefined) break
          const exit = yield* Effect.raceFirst(
            Deferred.await(entry.settled),
            Deferred.await(shutdown).pipe(Effect.as(Exit.void)),
          )
          if (closed) break
          if (exit._tag === "Failure" && firstFailure === undefined) firstFailure = exit.cause
        }
        if (firstFailure !== undefined) return yield* Effect.failCause(firstFailure)
      })

    const interrupt = (key: Key, seq?: number, reason?: Reason): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        const latest = entry?.interruptSeq
        if (seq !== undefined && latest !== undefined && seq <= latest)
          return entry?.stopping && entry.owner !== undefined ? Fiber.interrupt(entry.owner) : Effect.void
        if (entry?.owner === undefined) return Effect.void
        if (
          seq !== undefined &&
          entry.current._tag === "wake" &&
          entry.current.seq !== undefined &&
          entry.current.seq > seq
        )
          return Effect.void
        if (entry.stopping) {
          if (reason !== undefined) entry.interruptionReason = reason
          entry.interruptSeq = maxSeq(entry.interruptSeq, seq)
          suppressPendingAtOrBefore(entry, seq)
          return Fiber.interrupt(entry.owner)
        }
        entry.stopping = true
        entry.interruptionReason = reason
        entry.interruptSeq = seq
        suppressPendingAtOrBefore(entry, seq)
        return Fiber.interrupt(entry.owner)
      })

    const runOwned = (
      key: Key,
      receipt?: OwnedReceipt<Key>,
      registered?: (receipt: OwnedReceipt<Key>) => void,
    ): Effect.Effect<OwnedStart<Key>> =>
      Effect.sync(() => {
        if (closed) return { status: "closed" }
        if (receipt !== undefined) {
          const owned = receipts.get(receipt)
          if (owned === undefined) return { status: "not-local" }
          if (active.get(key) !== owned.entry) return { status: "obsolete" }
          return { status: "joined", receipt }
        }
        if (active.has(key)) return { status: "busy" }
        const nextReceipt = Object.freeze({ [ownedReceiptTypeId]: key })
        const entry = makeEntry({ _tag: "run" }, undefined, nextReceipt)
        receipts.set(nextReceipt, { key, entry })
        active.set(key, entry)
        start(key, entry, entry.current, false, registered)
        return { status: "started", receipt: nextReceipt }
      })

    const interruptIf = (
      receipt: OwnedReceipt<Key>,
      predicate: () => boolean,
      seq?: number,
      reason?: Reason,
    ): Effect.Effect<OwnedInterruption> =>
      Effect.suspend((): Effect.Effect<OwnedInterruption> => {
        const owned = receipts.get(receipt)
        if (owned === undefined) return Effect.succeed({ status: "not-local" } as const)
        if (closed) return Effect.succeed({ status: "obsolete", reason: "closed" } as const)
        const entry = owned.entry
        if (active.get(owned.key) !== entry || entry.owner === undefined)
          return Effect.succeed({ status: "obsolete", reason: "entry" } as const)
        // No Promise, SQL or other Effect is allowed in this predicate. Strict true also rejects
        // accidental async callbacks at runtime; there is no yield before capturing the owner.
        if (predicate() !== true) return Effect.succeed({ status: "obsolete", reason: "predicate" } as const)
        if (closed || active.get(owned.key) !== entry)
          return Effect.succeed({ status: "obsolete", reason: "entry" } as const)
        if (
          seq !== undefined &&
          ((entry.interruptSeq !== undefined && seq < entry.interruptSeq) ||
            (entry.current._tag === "wake" && entry.current.seq !== undefined && entry.current.seq > seq))
        )
          return Effect.succeed({ status: "obsolete", reason: "boundary" } as const)
        const owner = entry.owner
        entry.stopping = true
        if (reason !== undefined) entry.interruptionReason = reason
        entry.interruptSeq = maxSeq(entry.interruptSeq, seq)
        suppressPendingAtOrBefore(entry, seq)
        // Never reread by key after yielding: a later Entry may already own that Session.
        return Fiber.interrupt(owner).pipe(Effect.as({ status: "matched" } as const))
      })

    const awaitOwned = (receipt: OwnedReceipt<Key>): Effect.Effect<OwnedSettlement<A, E>> =>
      Effect.suspend((): Effect.Effect<OwnedSettlement<A, E>> => {
        const owned = receipts.get(receipt)
        if (owned === undefined) return Effect.succeed({ status: "not-local" } as const)
        // Shutdown is not evidence of cleanup. The captured Entry settles only after its owner
        // and lifecycle hook finish, even when this coordinator is closed or a successor runs.
        return Deferred.await(owned.entry.settled).pipe(Effect.map((exit) => ({ status: "settled", exit }) as const))
      })

    return {
      active: Effect.sync(() => new Set(active.keys())),
      run,
      runOwned,
      interruptIf,
      awaitOwned,
      wake,
      awaitIdle,
      interrupt,
    }

    function run(key: Key, request?: { readonly activityID?: string }): Effect.Effect<A, E> {
      return Effect.uninterruptibleMask((restore) => {
        if (closed) return Effect.interrupt
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) {
            return restore(Deferred.await(entry.settled).pipe(Effect.andThen(run(key, request))))
          }
          if (entry.current._tag === "wake") {
            entry.pending = coalesce(entry.pending, { _tag: "run", activityID: request?.activityID })
            entry.explicitWaiter ??= Deferred.makeUnsafe<Exit.Exit<A, E>>()
            return restore(awaitRun(entry.explicitWaiter))
          }
          return restore(awaitRun(entry.done))
        }

        return (options.captureRunScope?.(key) ?? Effect.succeed(undefined)).pipe(Effect.flatMap((runScope) => {
          // The trusted capture may yield; publication still checks the actual Entry atomically.
          // A concurrent owner gets no scope from this caller, and an unused capture is inert.
          if (closed) return Effect.interrupt
          if (active.has(key)) return restore(run(key, request))
          const next = makeEntry({ _tag: "run", activityID: request?.activityID }, undefined, undefined, runScope)
          active.set(key, next)
          start(key, next, next.current)
          return restore(awaitRun(next.done))
        }))
      })
    }

    function awaitRun(done: Deferred.Deferred<Exit.Exit<A, E>>): Effect.Effect<A, E> {
      return Effect.raceFirst(
        Deferred.await(done).pipe(Effect.flatMap((exit) => exit)),
        Deferred.await(shutdown).pipe(Effect.andThen(Effect.interrupt)),
      )
    }

    function acceptsWake(entry: Entry<Key, A, E, Reason>, seq: number | undefined) {
      return !entry.stopping || (entry.interruptSeq !== undefined && seq !== undefined && seq > entry.interruptSeq)
    }

    function suppressPendingAtOrBefore(entry: Entry<Key, A, E, Reason>, seq: number | undefined) {
      if (
        entry.pending?._tag === "wake" &&
        seq !== undefined &&
        entry.pending.seq !== undefined &&
        entry.pending.seq > seq
      )
        return
      entry.pending = undefined
    }
  })

export interface Interface extends Coordinator<SessionSchema.ID, void, SessionRunner.RunError> {}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/v2/SessionRunCoordinator") {}

export const layer = Layer.effect(
  Service,
  SessionRunner.Service.pipe(
    Effect.flatMap((runner) =>
      make<SessionSchema.ID, void, SessionRunner.RunError>({
        drain: (sessionID, mode, _receipt, activityID) => runner.run({ sessionID, force: mode === "run", activityID }),
        onFailure: (sessionID, cause) => logFailure("Failed to drain Session", sessionID, cause),
      }),
    ),
    Effect.map(Service.of),
  ),
)
