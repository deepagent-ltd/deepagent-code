import { expect, test } from "bun:test"
import { Effect, Scope } from "effect"
import { ListenerStop } from "../../src/server/listener-stop"

function fixture(finalizer: Effect.Effect<void>, onTimeout?: () => void) {
  const scope = Scope.makeUnsafe()
  const stages: string[] = []
  const close = Scope.addFinalizer(scope, finalizer)
  const stop = ListenerStop.make({
    scope,
    unpublish: Effect.sync(() => {
      stages.push("mdns")
    }),
    onTimeout,
    websockets: {
      closeAll: Effect.sync(() => {
        stages.push("websockets")
      }),
    },
    http: {
      closeAll: Effect.sync(() => {
        stages.push("force")
      }),
      close: Effect.sync(() => {
        stages.push("http")
      }),
    },
  })
  return { close, stages, stop }
}

test("real Scope finalization is joined once and graceful retries share completion", async () => {
  const release = Promise.withResolvers<void>()
  const facts = { entered: 0, settled: 0 }
  const entry = fixture(
    Effect.gen(function* () {
      facts.entered++
      yield* Effect.promise(() => release.promise)
      facts.settled++
    }),
  )
  await Effect.runPromise(entry.close)
  const original = entry.stop()
  expect(entry.stop()).toBe(original)
  await Bun.sleep(10)
  expect(facts).toEqual({ entered: 1, settled: 0 })
  release.resolve()
  await original
  await entry.stop()
  expect(facts).toEqual({ entered: 1, settled: 1 })
  expect(entry.stages).toEqual(["mdns", "websockets", "http"])
})

for (const reason of ["failed", "interrupted"] as const) {
  test(`real Scope ${reason} finalizer never becomes successful shutdown`, async () => {
    const facts = { entered: 0 }
    const entry = fixture(
      Effect.sync(() => {
        facts.entered++
      }).pipe(
        Effect.andThen(
          reason === "failed" ? Effect.die(new Error("private-secret /private/user/path")) : Effect.interrupt,
        ),
      ),
    )
    await Effect.runPromise(entry.close)
    const original = entry.stop()
    const failure = await original.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ListenerStop.Error)
    expect(failure).toMatchObject({ code: "LISTENER_STOP_FAILED", stage: "scope", reason })
    expect(String(failure)).not.toContain("private-secret")
    expect(String(failure)).not.toContain("/private/user/path")
    expect(await entry.stop().catch((error: unknown) => error)).toBe(failure)
    expect(facts.entered).toBe(1)
    expect(entry.stages).toEqual(["mdns", "websockets", "http"])
  })
}

test("the production two-second budget caches failure while the original Scope can settle late", async () => {
  const release = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  const facts = { entered: 0, diagnostics: 0 }
  const entry = fixture(
    Effect.gen(function* () {
      facts.entered++
      yield* Effect.promise(() => release.promise)
      settled.resolve()
    }),
    () => {
      facts.diagnostics++
      throw new Error("Diagnostic must not affect shutdown")
    },
  )
  await Effect.runPromise(entry.close)
  const started = performance.now()
  const original = entry.stop()
  const failure = await original.catch((error: unknown) => error)
  expect(performance.now() - started).toBeGreaterThanOrEqual(1_950)
  expect(performance.now() - started).toBeLessThan(3_000)
  expect(failure).toMatchObject({ code: "LISTENER_STOP_FAILED", stage: "scope", reason: "timeout" })
  expect(entry.stop()).toBe(original)
  release.resolve()
  await settled.promise
  expect(await entry.stop().catch((error: unknown) => error)).toBe(failure)
  expect(facts.entered).toBe(1)
  expect(facts.diagnostics).toBe(1)
  expect(entry.stages).toEqual(["mdns", "websockets", "http"])
}, 5_000)

test("force escalation closes transports once while sharing the same Scope settlement", async () => {
  const release = Promise.withResolvers<void>()
  const facts = { finalized: 0 }
  const entry = fixture(
    Effect.promise(() => release.promise).pipe(
      Effect.andThen(
        Effect.sync(() => {
          facts.finalized++
        }),
      ),
    ),
  )
  await Effect.runPromise(entry.close)
  const graceful = entry.stop()
  const forced = entry.stop(true)
  const repeated = entry.stop(true)
  release.resolve()
  await Promise.all([graceful, forced, repeated])
  expect(facts.finalized).toBe(1)
  expect(entry.stages).toEqual(["mdns", "websockets", "force", "http"])
})
