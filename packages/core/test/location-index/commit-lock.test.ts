import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { LocationCommitLock } from "../../src/location-index/commit-lock"
import { tmpdir } from "../fixture/tmpdir"

describe("LocationCommitLock", () => {
  test("allows concurrent readers and excludes writers plus late readers", async () => {
    await using tmp = await tmpdir()
    const layer = LocationCommitLock.layer({ directory: tmp.path, timeoutMs: 1_000, staleMs: 2_000, pollMs: 2 })
    const events: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const lock = yield* LocationCommitLock.Service
        const reader = (name: string, hold: number) =>
          Effect.gen(function* () {
            events.push(`${name}:start`)
            yield* Effect.sleep(hold)
            events.push(`${name}:end`)
          }).pipe(lock.withShared("code"))
        const first = yield* reader("r1", 40).pipe(Effect.forkChild)
        const second = yield* reader("r2", 40).pipe(Effect.forkChild)
        yield* Effect.sleep(5)
        const writer = yield* Effect.gen(function* () {
          events.push("w:start")
          yield* Effect.sleep(20)
          events.push("w:end")
        }).pipe(lock.withExclusive("code"), Effect.forkChild)
        yield* Effect.sleep(5)
        const late = yield* reader("r3", 1).pipe(Effect.forkChild)
        yield* Effect.all([Fiber.join(first), Fiber.join(second), Fiber.join(writer), Fiber.join(late)])
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    expect(events.slice(0, 2).toSorted()).toEqual(["r1:start", "r2:start"])
    expect(events.indexOf("w:start")).toBeGreaterThan(events.indexOf("r1:end"))
    expect(events.indexOf("w:start")).toBeGreaterThan(events.indexOf("r2:end"))
    expect(events.indexOf("r3:start")).toBeGreaterThan(events.indexOf("w:end"))
  })

  test("times out under contention and does not couple different projection keys", async () => {
    await using tmp = await tmpdir()
    const layer = LocationCommitLock.layer({ directory: tmp.path, timeoutMs: 20, staleMs: 1_000, pollMs: 2 })
    await Effect.runPromise(
      Effect.gen(function* () {
        const lock = yield* LocationCommitLock.Service
        yield* lock.acquireExclusive("code")
        const timeout = yield* lock.acquireShared("code").pipe(Effect.scoped, Effect.flip)
        expect(timeout).toMatchObject({ _tag: "LocationCommitLock.TimeoutError", mode: "shared" })
        expect(yield* Effect.succeed("documents").pipe(lock.withExclusive("repo_documents"))).toBe("documents")
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
  })
})
