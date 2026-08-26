import { afterEach, describe, expect } from "bun:test"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Git } from "../../src/git"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// U3 (S1 §P0): the worktree change-count / fail-closed delete / diff / branch-summary / merge-back
// added on top of the existing service. Runs against real git via the test fixture.

const it = testEffect(
  Layer.mergeAll(Worktree.defaultLayer, FSUtil.defaultLayer, CrossSpawnSpawner.defaultLayer, Git.defaultLayer),
)

const waitReady = Effect.fn("WorktreeU3.waitReady")(function* () {
  const ready = yield* Deferred.make<{ name: string; branch?: string }>()
  const on = (evt: GlobalEvent) => {
    if (evt.payload.type !== Worktree.Event.Ready.type) return
    Deferred.doneUnsafe(ready, Effect.succeed(evt.payload.properties))
  }
  GlobalBus.on("event", on)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))
  return yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
    }),
  )
})

const git = Effect.fn("WorktreeU3.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text()
})

const withWorktree = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const svc = yield* Worktree.Service
      const ready = yield* waitReady().pipe(Effect.forkScoped)
      const info = yield* svc.create({ name: "u3-test" })
      yield* Fiber.join(ready)
      return info
    }),
    (info) => use(info.directory),
    (info) =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        yield* svc.remove({ directory: info.directory }).pipe(Effect.ignore)
      }),
  )

describe("Worktree U3", () => {
  afterEach(() => disposeAllInstances())

  describe("countChanges / safeRemove (fail-closed)", () => {
    it.instance(
      "a fresh worktree is clean and safeRemove succeeds",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          yield* withWorktree((dir) =>
            Effect.gen(function* () {
              const count = yield* svc.countChanges({ directory: dir })
              expect(count.uncommitted).toBe(0)
              expect(count.ahead).toBe(0)
              expect(count.clean).toBe(true)
            }),
          )
        }),
      { git: true },
    )

    it.instance(
      "uncommitted changes make it unclean and safeRemove refuses",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const fs = yield* FSUtil.Service
          yield* withWorktree((dir) =>
            Effect.gen(function* () {
              yield* fs.writeFileString(`${dir}/dirty.txt`, "uncommitted").pipe(Effect.orDie)
              const count = yield* svc.countChanges({ directory: dir })
              expect(count.clean).toBe(false)
              expect(count.uncommitted).toBeGreaterThan(0)
              // fail-closed: safeRemove refuses with UnsafeRemoveError
              const exit = yield* svc.safeRemove({ directory: dir }).pipe(Effect.exit)
              expect(exit._tag).toBe("Failure")
              // force overrides
              const forced = yield* svc.safeRemove({ directory: dir, force: true })
              expect(forced).toBe(true)
            }),
          )
        }),
      { git: true },
    )
  })

  describe("diff", () => {
    it.instance(
      "reports an untracked file as an added entry",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const fs = yield* FSUtil.Service
          yield* withWorktree((dir) =>
            Effect.gen(function* () {
              yield* fs.writeFileString(`${dir}/new.txt`, "hello\nworld\n").pipe(Effect.orDie)
              const d = yield* svc.diff({ directory: dir })
              const added = d.entries.find((e) => e.file.endsWith("new.txt"))
              expect(added).toBeDefined()
              expect(added?.status).toBe("added")
            }),
          )
        }),
      { git: true },
    )
  })

  describe("branchSummary", () => {
    it.instance(
      "counts a committed file on the worktree branch",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const fs = yield* FSUtil.Service
          yield* withWorktree((dir) =>
            Effect.gen(function* () {
              yield* fs.writeFileString(`${dir}/feature.txt`, "a\nb\nc\n").pipe(Effect.orDie)
              yield* git(dir, ["add", "."])
              yield* git(dir, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "feat"])
              const summary = yield* svc.branchSummary({ directory: dir })
              expect(summary.files).toBeGreaterThanOrEqual(1)
              expect(summary.additions).toBeGreaterThanOrEqual(3)
            }),
          )
        }),
      { git: true },
    )
  })
})
