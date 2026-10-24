import { afterEach, describe, expect } from "bun:test"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Git } from "../../src/git"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { InstanceState } from "../../src/effect/instance-state"

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
      "safely removes the opened linked instance and its merged branch from a stable repository directory",
      () =>
        Effect.gen(function* () {
          const parent = yield* TestInstance
          const svc = yield* Worktree.Service
          const fs = yield* FSUtil.Service
          const origin = yield* tmpdirScoped()
          yield* git(parent.directory, ["branch", "-M", "main"])
          yield* git(parent.directory, ["clone", "--bare", parent.directory, origin])
          yield* git(parent.directory, ["remote", "add", "origin", origin])
          yield* git(parent.directory, ["fetch", "origin"])
          yield* git(parent.directory, ["remote", "set-head", "origin", "main"])
          yield* withWorktree((dir) =>
            Effect.gen(function* () {
              const branch = (yield* git(dir, ["branch", "--show-current"])).trim()
              yield* fs.writeFileString(`${dir}/removed-result.txt`, "accepted result\n").pipe(Effect.orDie)
              yield* git(dir, ["add", "removed-result.txt"])
              yield* git(dir, ["commit", "-m", "test: prepare linked removal result"])
              yield* git(parent.directory, ["merge", "--no-ff", branch, "-m", "test: accept linked result"])
              yield* git(origin, ["fetch", parent.directory, "main:refs/heads/main"])
              yield* git(parent.directory, ["fetch", "origin"])
              const head = yield* git(parent.directory, ["rev-parse", "HEAD"])
              const removed = yield* Effect.gen(function* () {
                expect((yield* InstanceState.context).worktree).toBe(dir)
                const count = yield* svc.countChanges({ directory: dir })
                expect(count.uncommitted).toBe(0)
                expect(count.ahead).toBe(0)
                expect(count.clean).toBe(true)
                return yield* svc.safeRemove({ directory: dir })
              }).pipe(provideInstanceEffect(dir), Effect.exit)
              expect(yield* fs.exists(dir)).toBe(false)
              expect(yield* git(parent.directory, ["worktree", "list", "--porcelain"])).not.toContain(dir)
              expect((yield* git(parent.directory, ["branch", "--list", branch])).trim()).toBe("")
              expect(removed._tag).toBe("Success")
              expect(yield* git(parent.directory, ["rev-parse", "HEAD"])).toBe(head)
              expect((yield* git(parent.directory, ["status", "--porcelain"])).trim()).toBe("")
              expect(yield* fs.readFileString(`${parent.directory}/removed-result.txt`)).toBe("accepted result\n")
            }),
          )
        }),
      { git: true },
    )

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
    it.instance("reports only a unique real default checkout for a linked-first project", () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const main = yield* tmpdirScoped({ git: true })
        const origin = yield* tmpdirScoped()
        const linked = yield* tmpdirScoped()
        const duplicate = yield* tmpdirScoped()
        yield* git(main, ["branch", "-M", "main"])
        yield* git(main, ["clone", "--bare", main, origin])
        yield* git(main, ["remote", "add", "origin", origin])
        yield* git(main, ["fetch", "origin"])
        yield* git(main, ["remote", "set-head", "origin", "main"])
        yield* git(main, ["worktree", "add", "-b", "summary-linked", linked, "main"])
        const head = yield* git(main, ["rev-parse", "HEAD"])
        const summary = yield* Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          expect(ctx.worktree).toBe(linked)
          expect(ctx.project.worktree).toBe(linked)
          return yield* svc.branchSummary({ directory: linked })
        }).pipe(provideInstanceEffect(linked))
        expect(summary.base).toBe("main")
        expect(summary.defaultCheckout).toBe(main)
        yield* git(main, ["checkout", "-b", "other-default"])
        const missing = yield* svc.branchSummary({ directory: linked }).pipe(provideInstanceEffect(linked))
        expect(missing.defaultCheckout).toBeUndefined()
        yield* git(main, ["checkout", "main"])
        yield* git(main, ["worktree", "add", "--force", duplicate, "main"])
        const ambiguous = yield* svc.branchSummary({ directory: linked }).pipe(provideInstanceEffect(linked))
        expect(ambiguous.defaultCheckout).toBeUndefined()
        expect(yield* git(main, ["rev-parse", "HEAD"])).toBe(head)
        expect(yield* git(linked, ["rev-parse", "HEAD"])).toBe(head)
        expect((yield* git(main, ["status", "--porcelain"])).trim()).toBe("")
        expect((yield* git(linked, ["status", "--porcelain"])).trim()).toBe("")
      }),
    )

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

  it.instance(
    "merges back from a linked instance into the clean default checkout",
    () =>
      Effect.gen(function* () {
        const parent = yield* TestInstance
        const svc = yield* Worktree.Service
        const fs = yield* FSUtil.Service
        const origin = yield* tmpdirScoped()
        yield* git(parent.directory, ["branch", "-M", "main"])
        yield* fs.writeFileString(`${parent.directory}/merge-target.txt`, "before\n").pipe(Effect.orDie)
        yield* git(parent.directory, ["add", "merge-target.txt"])
        yield* git(parent.directory, ["commit", "-m", "test: seed default checkout"])
        yield* git(parent.directory, ["clone", "--bare", parent.directory, origin])
        yield* git(parent.directory, ["remote", "add", "origin", origin])
        yield* git(parent.directory, ["fetch", "origin"])
        yield* git(parent.directory, ["remote", "set-head", "origin", "main"])
        const before = yield* git(parent.directory, ["rev-parse", "HEAD"])
        yield* withWorktree((dir) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(`${dir}/merge-target.txt`, "after\n").pipe(Effect.orDie)
            yield* git(dir, ["add", "merge-target.txt"])
            yield* git(dir, ["commit", "-m", "test: commit linked result"])
            const source = yield* git(dir, ["rev-parse", "HEAD"])
            const merged = yield* Effect.gen(function* () {
              expect((yield* InstanceState.context).worktree).toBe(dir)
              return yield* svc.mergeBack({ directory: dir })
            }).pipe(provideInstanceEffect(dir))
            expect(merged.merged).toBe(true)
            expect(merged.conflicted).toEqual([])
            expect(yield* fs.readFileString(`${parent.directory}/merge-target.txt`)).toBe("after\n")
            expect((yield* git(parent.directory, ["diff", "--cached", "--name-only"])).trim()).toBe("merge-target.txt")
            expect(yield* git(parent.directory, ["rev-parse", "HEAD"])).toBe(before)
            expect(yield* git(parent.directory, ["rev-parse", "MERGE_HEAD"])).toBe(source)
            expect((yield* git(dir, ["status", "--porcelain"])).trim()).toBe("")
            expect(yield* git(dir, ["rev-parse", "HEAD"])).toBe(source)
          }),
        )
      }),
    { git: true },
  )

  it.instance(
    "refuses interactive merge into a dirty or unavailable default checkout from a linked instance",
    () =>
      Effect.gen(function* () {
        const parent = yield* TestInstance
        const svc = yield* Worktree.Service
        const fs = yield* FSUtil.Service
        yield* git(parent.directory, ["branch", "-M", "main"])
        const before = yield* git(parent.directory, ["rev-parse", "HEAD"])
        yield* withWorktree((dir) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(`${dir}/feature.txt`, "linked result\n").pipe(Effect.orDie)
            yield* git(dir, ["add", "feature.txt"])
            yield* git(dir, ["commit", "-m", "test: commit linked result"])
            const source = yield* git(dir, ["rev-parse", "HEAD"])
            yield* fs.writeFileString(`${parent.directory}/unrelated.txt`, "preserve user change\n").pipe(Effect.orDie)
            const dirty = yield* svc.mergeBack({ directory: dir }).pipe(provideInstanceEffect(dir), Effect.exit)
            expect(dirty._tag).toBe("Failure")
            expect(yield* fs.readFileString(`${parent.directory}/unrelated.txt`)).toBe("preserve user change\n")
            expect(yield* fs.exists(`${parent.directory}/feature.txt`)).toBe(false)
            expect((yield* git(parent.directory, ["diff", "--cached", "--name-only"])).trim()).toBe("")
            yield* fs.remove(`${parent.directory}/unrelated.txt`).pipe(Effect.orDie)
            yield* git(parent.directory, ["checkout", "-b", "other-branch"])
            const missing = yield* svc.mergeBack({ directory: dir }).pipe(provideInstanceEffect(dir), Effect.exit)
            expect(missing._tag).toBe("Failure")
            expect((yield* git(parent.directory, ["branch", "--show-current"])).trim()).toBe("other-branch")
            expect(yield* fs.exists(`${parent.directory}/feature.txt`)).toBe(false)
            expect((yield* git(parent.directory, ["status", "--porcelain"])).trim()).toBe("")
            expect(yield* git(parent.directory, ["rev-parse", "HEAD"])).toBe(before)
            expect((yield* git(dir, ["status", "--porcelain"])).trim()).toBe("")
            expect(yield* git(dir, ["rev-parse", "HEAD"])).toBe(source)
          }),
        )
      }),
    { git: true },
  )

  it.instance(
    "merges an owned committed worktree as staged changes and safely removes it after the parent commit",
    () =>
      Effect.gen(function* () {
        const parent = yield* TestInstance
        const svc = yield* Worktree.Service
        const fs = yield* FSUtil.Service
        yield* withWorktree((dir) =>
          Effect.gen(function* () {
            yield* fs.writeFileString(`${dir}/merge-result.txt`, "owned worktree result\n").pipe(Effect.orDie)
            yield* git(dir, ["add", "merge-result.txt"])
            yield* git(dir, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "feat: owned result"])
            const before = yield* git(parent.directory, ["rev-parse", "HEAD"])
            const merged = yield* svc.mergeBack({ directory: dir })
            expect(merged.merged).toBe(true)
            expect(merged.conflicted).toEqual([])
            expect(yield* fs.readFileString(`${parent.directory}/merge-result.txt`)).toBe("owned worktree result\n")
            expect((yield* git(parent.directory, ["diff", "--cached", "--name-only"])).trim()).toBe("merge-result.txt")
            expect(yield* git(parent.directory, ["rev-parse", "HEAD"])).toBe(before)
            yield* git(parent.directory, [
              "-c",
              "user.email=t@t.t",
              "-c",
              "user.name=t",
              "commit",
              "-m",
              "test: accept merge",
            ])
            expect((yield* svc.countChanges({ directory: dir })).clean).toBe(true)
            expect(yield* svc.safeRemove({ directory: dir })).toBe(true)
            expect(yield* fs.exists(dir)).toBe(false)
            expect(yield* fs.readFileString(`${parent.directory}/merge-result.txt`)).toBe("owned worktree result\n")
          }),
        )
      }),
    { git: true },
  )
})
