import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { SessionRunCoordinator } from "@deepagent-code/core/session/run-coordinator"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("SessionRunCoordinator owned execution", () => {
  it.effect("registers the exact owned receipt synchronously before Started and drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = new WeakSet<object>()
        const seen: string[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
          started: (_key, receipt) =>
            Effect.sync(() => {
              expect(registry.has(receipt!)).toBeTrue()
              seen.push("started")
            }),
          drain: (_key, _mode, receipt) =>
            Effect.sync(() => {
              expect(registry.has(receipt!)).toBeTrue()
              seen.push("drain")
            }),
        })
        const run = yield* coordinator.runOwned("child", undefined, (receipt) => {
          registry.add(receipt)
          seen.push("registered")
        })
        if (run.status !== "started") throw new Error(run.status)
        const done = yield* coordinator.awaitOwned(run.receipt)
        expect(done.status === "settled" && Exit.isSuccess(done.exit)).toBeTrue()
        expect(seen).toEqual(["registered", "started", "drain"])
      }),
    ),
  )

  it.effect("settles a registration throw without entering Started, draining, or leaving the child busy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: string[] = []
        const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
          started: () =>
            Effect.sync(() => {
              seen.push("started")
            }),
          drain: () =>
            Effect.sync(() => {
              seen.push("drain")
            }),
          settled: (_key, _exit, _reason, receipt) =>
            Effect.sync(() => {
              expect(receipt).toBeDefined()
              seen.push("settled")
            }),
        })
        const run = yield* coordinator.runOwned("child", undefined, () => {
          throw new Error("registration failed")
        })
        if (run.status !== "started") throw new Error(run.status)
        const done = yield* coordinator.awaitOwned(run.receipt)
        expect(done.status === "settled" && Exit.isFailure(done.exit)).toBeTrue()
        expect(seen).toEqual(["settled"])
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("publishes the owner before a separate fiber interrupts during started", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stops: Array<Fiber.Fiber<void, never>> = []
        let drains = 0
        const coordinator: SessionRunCoordinator.Coordinator<string, void, never> = yield* SessionRunCoordinator.make<
          string,
          void,
          never
        >({
          // runFork executes this independent cancellation fiber immediately. It may await the
          // owner, but the owner's started hook never joins it (which would self-deadlock).
          started: () =>
            Effect.sync(() => {
              stops.push(Effect.runFork(coordinator.interrupt("session")))
            }),
          drain: () =>
            Effect.sync(() => {
              drains++
            }),
        })

        const exit = yield* coordinator.run("session").pipe(Effect.exit)
        yield* Fiber.join(stops[0]!)
        expect(drains).toBe(0)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("registers the receipt and publishes its Entry before started and keeps same-receipt joins read-only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const hooks: Array<SessionRunCoordinator.OwnedReceipt<string> | undefined> = []
        let drains = 0
        const coordinator: SessionRunCoordinator.Coordinator<string, void, never> = yield* SessionRunCoordinator.make<
          string,
          void,
          never
        >({
          started: (key, receipt) =>
            Effect.gen(function* () {
              hooks.push(receipt)
              expect(receipt).toBeDefined()
              if (receipt === undefined) return yield* Effect.die("Owned Started receipt missing")
              expect(Array.from(yield* coordinator.active)).toEqual([key])
              expect(yield* coordinator.runOwned(key, receipt)).toEqual({ status: "joined", receipt })
              yield* Deferred.succeed(started, undefined)
            }),
          drain: () =>
            Effect.sync(() => {
              drains++
            }).pipe(Effect.andThen(Deferred.await(gate))),
        })

        const result = yield* coordinator.runOwned("session")
        const receipt = requireReceipt(result)
        yield* Deferred.await(started)
        expect(result.status).toBe("started")
        expect(hooks).toEqual([receipt])
        expect(Object.isFrozen(receipt)).toBeTrue()
        expect(yield* coordinator.runOwned("session")).toEqual({ status: "busy" })
        expect(yield* coordinator.runOwned("other", receipt)).toEqual({ status: "obsolete" })
        expect(yield* coordinator.runOwned("session", receipt)).toEqual({ status: "joined", receipt })
        yield* Deferred.succeed(gate, undefined)
        const settled = yield* coordinator.awaitOwned(receipt)
        expect(settled.status === "settled" && Exit.isSuccess(settled.exit)).toBeTrue()
        expect(yield* coordinator.runOwned("session", receipt)).toEqual({ status: "obsolete" })
        expect(yield* coordinator.awaitOwned(receipt)).toEqual(settled)
        expect(drains).toBe(1)
      }),
    ),
  )

  it.effect("rejects foreign, copied, inherited and deserialized receipts without invoking their predicate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
          drain: () => Deferred.await(gate),
        })
        const foreign = yield* SessionRunCoordinator.make<string, void, never>({ drain: () => Deferred.await(gate) })
        const receipt = requireReceipt(yield* coordinator.runOwned("session"))
        const other = requireReceipt(yield* foreign.runOwned("session"))
        const copied = [other, { ...receipt }, Object.create(receipt), JSON.parse(JSON.stringify(receipt))] as Array<
          SessionRunCoordinator.OwnedReceipt<string>
        >
        let predicates = 0
        for (const candidate of copied) {
          expect(yield* coordinator.runOwned("session", candidate)).toEqual({ status: "not-local" })
          expect(yield* coordinator.awaitOwned(candidate)).toEqual({ status: "not-local" })
          expect(
            yield* coordinator.interruptIf(candidate, () => {
              predicates++
              return true
            }),
          ).toEqual({ status: "not-local" })
        }
        expect(predicates).toBe(0)
        expect(yield* coordinator.interruptIf(receipt, () => false)).toEqual({
          status: "obsolete",
          reason: "predicate",
        })
        expect(
          yield* coordinator.interruptIf(receipt, (() => Promise.resolve(true)) as unknown as () => boolean),
        ).toEqual({ status: "obsolete", reason: "predicate" })
        expect(Array.from(yield* coordinator.active)).toEqual(["session"])
        yield* Deferred.succeed(gate, undefined)
        yield* coordinator.awaitOwned(receipt)
        yield* foreign.awaitOwned(other)
      }),
    ),
  )

  it.effect("does not join an ordinary run or wake and does not queue work behind a stopping Entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const cleanup = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let drains = 0
        const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
          drain: () =>
            Effect.sync(() => {
              drains++
            }).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
            ),
        })
        const ordinary = yield* coordinator.run("session").pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(entered)
        expect(yield* coordinator.runOwned("session")).toEqual({ status: "busy" })
        const stopping = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
        yield* Deferred.await(cleanup)
        expect(yield* coordinator.runOwned("session")).toEqual({ status: "busy" })
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(stopping)
        yield* Fiber.join(ordinary)
        expect(drains).toBe(1)
        yield* coordinator.wake("session", 2)
        expect(yield* coordinator.runOwned("session")).toEqual({ status: "busy" })
        yield* coordinator.interrupt("session")
        expect(drains).toBe(2)
      }),
    ),
  )

  it.effect("joins a starting or stopping owned Entry without treating either as a completed drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starting = yield* Deferred.make<void>()
        const cleanup = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let drains = 0
        const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
          started: () =>
            Deferred.succeed(starting, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
            ),
          drain: () =>
            Effect.sync(() => {
              drains++
            }),
        })
        const receipt = requireReceipt(yield* coordinator.runOwned("session"))
        yield* Deferred.await(starting)
        expect(yield* coordinator.runOwned("session", receipt)).toEqual({ status: "joined", receipt })
        const first = yield* coordinator.awaitOwned(receipt).pipe(Effect.forkChild)
        const second = yield* coordinator.awaitOwned(receipt).pipe(Effect.forkChild)
        const stopped = yield* Deferred.make<void>()
        const stop = yield* coordinator
          .interruptIf(receipt, () => true)
          .pipe(
            Effect.tap(() => Deferred.succeed(stopped, undefined)),
            Effect.forkChild,
          )
        yield* Deferred.await(cleanup)
        let repeatedChecks = 0
        const repeated = yield* coordinator
          .interruptIf(receipt, () => {
            repeatedChecks++
            return true
          })
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(repeatedChecks).toBe(1)
        expect(yield* coordinator.runOwned("session")).toEqual({ status: "busy" })
        expect(yield* coordinator.runOwned("session", receipt)).toEqual({ status: "joined", receipt })
        expect(first.pollUnsafe()).toBeUndefined()
        expect(second.pollUnsafe()).toBeUndefined()
        expect(yield* Deferred.isDone(stopped)).toBeFalse()
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(stop)).toEqual({ status: "matched" })
        expect(yield* Fiber.join(repeated)).toEqual({ status: "matched" })
        const one = yield* Fiber.join(first)
        expect(yield* Fiber.join(second)).toEqual(one)
        expect(
          one.status === "settled" && Exit.isFailure(one.exit) && Cause.hasInterruptsOnly(one.exit.cause),
        ).toBeTrue()
        expect(drains).toBe(0)
      }),
    ),
  )

  it.effect("returns the starting failure and never drains or recreates its receipt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = new Error("claim/link refused")
        let drains = 0
        const coordinator = yield* SessionRunCoordinator.make<string, void, Error>({
          started: () => Effect.fail(failure),
          drain: () =>
            Effect.sync(() => {
              drains++
            }),
        })
        const receipt = requireReceipt(yield* coordinator.runOwned("session"))
        const result = yield* coordinator.awaitOwned(receipt)
        expect(result.status === "settled" && Exit.isFailure(result.exit) && Cause.squash(result.exit.cause)).toBe(
          failure,
        )
        expect(yield* coordinator.interruptIf(receipt, () => true)).toEqual({ status: "obsolete", reason: "entry" })
        expect(yield* coordinator.runOwned("session", receipt)).toEqual({ status: "obsolete" })
        expect(drains).toBe(0)
      }),
    ),
  )

  it.effect("does not report settlement before the lifecycle hook finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const terminalizing = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
          drain: () => Effect.void,
          settled: () => Deferred.succeed(terminalizing, undefined).pipe(Effect.andThen(Deferred.await(release))),
        })
        const receipt = requireReceipt(yield* coordinator.runOwned("session"))
        yield* Deferred.await(terminalizing)
        const wait = yield* coordinator.awaitOwned(receipt).pipe(Effect.forkChild)
        expect(wait.pollUnsafe()).toBeUndefined()
        expect(yield* coordinator.runOwned("session")).toEqual({ status: "busy" })
        yield* Deferred.succeed(release, undefined)
        const result = yield* Fiber.join(wait)
        expect(result.status === "settled" && Exit.isSuccess(result.exit)).toBeTrue()
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }),
    ),
  )

  it.effect("keeps one receipt across coalesced followups and captures the replacement fiber within that Entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstGate = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const hooks: Array<SessionRunCoordinator.OwnedReceipt<string> | undefined> = []
        let drains = 0
        const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
          started: (_key, receipt) =>
            Effect.sync(() => {
              hooks.push(receipt)
            }),
          drain: () =>
            Effect.sync(() => ++drains).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Deferred.await(firstGate)
                  : Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Effect.never)),
              ),
            ),
        })
        const receipt = requireReceipt(yield* coordinator.runOwned("session"))
        const ordinary = yield* coordinator.run("session").pipe(Effect.exit, Effect.forkChild)
        yield* coordinator.wake("session", 2)
        yield* coordinator.wake("session", 3)
        yield* Deferred.succeed(firstGate, undefined)
        yield* Deferred.await(secondStarted)
        expect(yield* coordinator.runOwned("session", receipt)).toEqual({ status: "joined", receipt })
        expect(yield* coordinator.interruptIf(receipt, () => true, 2)).toEqual({
          status: "obsolete",
          reason: "boundary",
        })
        expect(yield* coordinator.interruptIf(receipt, () => true, 3)).toEqual({ status: "matched" })
        const result = yield* coordinator.awaitOwned(receipt)
        expect(result.status === "settled" && Exit.isFailure(result.exit)).toBeTrue()
        const ordinaryExit = yield* Fiber.join(ordinary)
        expect(Exit.isFailure(ordinaryExit) && Cause.hasInterruptsOnly(ordinaryExit.cause)).toBeTrue()
        expect(hooks).toEqual([receipt])
        expect(drains).toBe(2)
      }),
    ),
  )

  it.effect("late A interruption and awaiting A never control or wait for the new B Entry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gateA = yield* Deferred.make<void>()
        const gateB = yield* Deferred.make<void>()
        let drains = 0
        const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
          drain: () =>
            Effect.sync(() => ++drains).pipe(Effect.flatMap((count) => Deferred.await(count === 1 ? gateA : gateB))),
        })
        const a = requireReceipt(yield* coordinator.runOwned("session"))
        const lateStop = coordinator.interruptIf(a, () => true)
        const waitA = coordinator.awaitOwned(a)
        yield* Deferred.succeed(gateA, undefined)
        yield* waitA
        const b = requireReceipt(yield* coordinator.runOwned("session"))
        expect(b).not.toBe(a)
        expect(yield* lateStop).toEqual({ status: "obsolete", reason: "entry" })
        const aResult = yield* waitA
        expect(aResult.status === "settled" && Exit.isSuccess(aResult.exit)).toBeTrue()
        expect(yield* coordinator.runOwned("session", b)).toEqual({ status: "joined", receipt: b })
        expect(Array.from(yield* coordinator.active)).toEqual(["session"])
        yield* Deferred.succeed(gateB, undefined)
        const bResult = yield* coordinator.awaitOwned(b)
        expect(bResult.status === "settled" && Exit.isSuccess(bResult.exit)).toBeTrue()
      }),
    ),
  )

  it.effect("retains only post-stop wakes as a new unowned Entry without extending the old wait", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cleanup = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const successor = yield* Deferred.make<void>()
        const successorGate = yield* Deferred.make<void>()
        const hooks: Array<SessionRunCoordinator.OwnedReceipt<string> | undefined> = []
        let drains = 0
        const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
          started: (_key, receipt) =>
            Effect.sync(() => {
              hooks.push(receipt)
            }),
          drain: () =>
            Effect.sync(() => ++drains).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.never.pipe(
                      Effect.onInterrupt(() =>
                        Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(release))),
                      ),
                    )
                  : Deferred.succeed(successor, undefined).pipe(Effect.andThen(Deferred.await(successorGate))),
              ),
            ),
        })
        const receipt = requireReceipt(yield* coordinator.runOwned("session"))
        yield* coordinator.wake("session", 2)
        const stop = yield* coordinator.interruptIf(receipt, () => true, 2).pipe(Effect.forkChild)
        yield* Deferred.await(cleanup)
        yield* coordinator.wake("session", 1)
        yield* coordinator.wake("session", 3)
        expect(yield* coordinator.interruptIf(receipt, () => true, 1)).toEqual({
          status: "obsolete",
          reason: "boundary",
        })
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(stop)).toEqual({ status: "matched" })
        yield* Deferred.await(successor)
        const result = yield* coordinator.awaitOwned(receipt)
        expect(result.status === "settled" && Exit.isFailure(result.exit)).toBeTrue()
        expect(yield* coordinator.interruptIf(receipt, () => true, 3)).toEqual({ status: "obsolete", reason: "entry" })
        expect(hooks).toEqual([receipt, undefined])
        expect(yield* coordinator.runOwned("session")).toEqual({ status: "busy" })
        yield* Deferred.succeed(successorGate, undefined)
        yield* coordinator.awaitIdle("session")
        expect(drains).toBe(2)
      }),
    ),
  )

  it.effect("ordinary failure followups get a new Entry without inheriting an owned receipt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fail = yield* Deferred.make<void>()
        const successor = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const hooks: Array<SessionRunCoordinator.OwnedReceipt<string> | undefined> = []
        let drains = 0
        const coordinator = yield* SessionRunCoordinator.make<string, void, string>({
          started: (_key, receipt) =>
            Effect.sync(() => {
              hooks.push(receipt)
            }),
          drain: () =>
            Effect.sync(() => ++drains).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Deferred.await(fail).pipe(Effect.andThen(Effect.fail("failed A")))
                  : Deferred.succeed(successor, undefined).pipe(Effect.andThen(Deferred.await(gate))),
              ),
            ),
        })
        const receipt = requireReceipt(yield* coordinator.runOwned("session"))
        yield* coordinator.wake("session", 1)
        yield* Deferred.succeed(fail, undefined)
        yield* Deferred.await(successor)
        const result = yield* coordinator.awaitOwned(receipt)
        expect(result.status === "settled" && Exit.isFailure(result.exit) && Cause.squash(result.exit.cause)).toBe(
          "failed A",
        )
        expect(hooks).toEqual([receipt, undefined])
        expect(yield* coordinator.interruptIf(receipt, () => true)).toEqual({ status: "obsolete", reason: "entry" })
        yield* Deferred.succeed(gate, undefined)
        yield* coordinator.awaitIdle("session")
      }),
    ),
  )

  it.effect("waits for actual closed-scope cleanup for every owned waiter and refuses new work", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const cleanup = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const closed = yield* Deferred.make<void>()
      const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
        drain: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ),
          ),
      }).pipe(Scope.provide(scope))
      const receipt = requireReceipt(yield* coordinator.runOwned("session"))
      const first = yield* coordinator.awaitOwned(receipt).pipe(Effect.forkChild)
      const second = yield* coordinator.awaitOwned(receipt).pipe(Effect.forkChild)
      const close = yield* Scope.close(scope, Exit.void).pipe(
        Effect.tap(() => Deferred.succeed(closed, undefined)),
        Effect.forkChild,
      )
      yield* Deferred.await(cleanup)
      const afterClose = yield* coordinator.awaitOwned(receipt).pipe(Effect.forkChild)
      expect(yield* coordinator.runOwned("session")).toEqual({ status: "closed" })
      expect(yield* coordinator.runOwned("session", receipt)).toEqual({ status: "closed" })
      expect(yield* coordinator.interruptIf(receipt, () => true)).toEqual({ status: "obsolete", reason: "closed" })
      expect(first.pollUnsafe()).toBeUndefined()
      expect(second.pollUnsafe()).toBeUndefined()
      expect(afterClose.pollUnsafe()).toBeUndefined()
      expect(yield* Deferred.isDone(closed)).toBeFalse()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(close)
      const result = yield* Fiber.join(first)
      expect(yield* Fiber.join(second)).toEqual(result)
      expect(yield* Fiber.join(afterClose)).toEqual(result)
      expect(
        result.status === "settled" && Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause),
      ).toBeTrue()
    }),
  )

  it.effect("interrupting one owned waiter does not stop the owner or other waiters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        const coordinator = yield* SessionRunCoordinator.make<string, void, never>({
          drain: () => Deferred.await(gate),
        })
        const receipt = requireReceipt(yield* coordinator.runOwned("session"))
        const first = yield* coordinator.awaitOwned(receipt).pipe(Effect.forkChild)
        const second = yield* coordinator.awaitOwned(receipt).pipe(Effect.forkChild)
        yield* Fiber.interrupt(first)
        expect(Array.from(yield* coordinator.active)).toEqual(["session"])
        expect(second.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(gate, undefined)
        const result = yield* Fiber.join(second)
        expect(result.status === "settled" && Exit.isSuccess(result.exit)).toBeTrue()
      }),
    ),
  )
})

function requireReceipt<Key>(result: SessionRunCoordinator.OwnedStart<Key>) {
  if (result.status === "started" || result.status === "joined") return result.receipt
  throw new Error(`Expected an owned receipt, received ${result.status}`)
}
