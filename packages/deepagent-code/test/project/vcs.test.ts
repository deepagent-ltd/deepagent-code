import { afterEach, describe, expect } from "bun:test"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { parsePatch } from "diff"
import { Cause, Deferred, Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import fs from "fs/promises"
import path from "path"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Watcher } from "@deepagent-code/core/filesystem/watcher"
import { Git } from "../../src/git"
import { Vcs } from "@/project/vcs"
import { testEffect } from "../lib/effect"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"

const layer = Layer.mergeAll(
  Vcs.layer.pipe(Layer.provideMerge(Git.defaultLayer), Layer.provideMerge(EventV2Bridge.defaultLayer)),
  CrossSpawnSpawner.defaultLayer,
  FSUtil.defaultLayer,
)
const it = testEffect(layer)
const worktreeIt = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

const git = Effect.fn("VcsTest.git")(function* (cwd: string, args: string[]) {
  const result = yield* Git.Service.use((git) => git.run(args, { cwd }))
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
})

const write = Effect.fn("VcsTest.write")(function* (file: string, content: string) {
  yield* FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
})

const remove = Effect.fn("VcsTest.remove")(function* (file: string) {
  yield* FSUtil.Service.use((fs) => fs.remove(file))
})

const symlink = (target: string, file: string) => Effect.promise(() => fs.symlink(target, file))

const init = Effect.fn("VcsTest.init")(function* () {
  const vcs = yield* Vcs.Service
  yield* vcs.init()
  return vcs
})

const nextBranchUpdate = Effect.fn("VcsTest.nextBranchUpdate")(function* () {
  const events = yield* EventV2Bridge.Service
  const updated = yield* Deferred.make<string | undefined>()

  const off = yield* events.listen((event) => {
    if (event.type === Vcs.Event.BranchUpdated.type)
      Deferred.doneUnsafe(updated, Effect.succeed((event.data as typeof Vcs.Event.BranchUpdated.data.Type).branch))
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  return updated
})

const publishHeadChangeUntil = Effect.fn("VcsTest.publishHeadChangeUntil")(function* (
  pending: Deferred.Deferred<string | undefined>,
  head: string,
) {
  const events = yield* EventV2Bridge.Service
  for (let i = 0; i < 50; i++) {
    yield* events.publish(Watcher.Event.Updated, { file: head, event: "change" })
    if (yield* Deferred.isDone(pending)) return
    yield* Effect.sleep("10 millis")
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Vcs", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "branch() returns current branch name",
    () =>
      Effect.gen(function* () {
        const vcs = yield* init()
        const branch = yield* vcs.branch()

        expect(branch).toBeDefined()
        expect(typeof branch).toBe("string")
      }),
    { git: true },
  )

  it.instance("branch() returns undefined for non-git directories", () =>
    Effect.gen(function* () {
      const vcs = yield* init()
      const branch = yield* vcs.branch()

      expect(branch).toBeUndefined()
    }),
  )

  it.instance(
    "publishes BranchUpdated when .git/HEAD changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)

        const updated = yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))
        expect(updated).toBe(branch)
      }),
    { git: true },
  )

  it.instance(
    "branch() reflects the new branch after HEAD change",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const branch = `test-${Math.random().toString(36).slice(2)}`
        yield* git(test.directory, ["branch", branch])

        const vcs = yield* init()
        yield* vcs.branch()
        const pending = yield* nextBranchUpdate()

        const head = path.join(test.directory, ".git", "HEAD")
        yield* write(head, `ref: refs/heads/${branch}\n`)
        yield* publishHeadChangeUntil(pending, head)
        yield* Deferred.await(pending).pipe(Effect.timeout("2 seconds"))

        const current = yield* vcs.branch()
        expect(current).toBe(branch)
      }),
    { git: true },
  )
})

describe("Vcs diff", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "defaultBranch() falls back to main",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("main")
      }),
    { git: true },
  )

  it.instance(
    "defaultBranch() uses init.defaultBranch when available",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "trunk"])
        yield* git(test.directory, ["config", "init.defaultBranch", "trunk"])

        const vcs = yield* init()
        const branch = yield* vcs.defaultBranch()

        expect(branch).toBe("trunk")
      }),
    { git: true },
  )

  worktreeIt.live("detects current branch from the active worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const wt = yield* tmpdirScoped()
      yield* git(tmp, ["branch", "-M", "main"])
      const dir = path.join(wt, "feature")
      yield* git(tmp, ["worktree", "add", "-b", "feature/test", dir, "HEAD"])

      const [branch, base] = yield* Effect.gen(function* () {
        const vcs = yield* init()
        return yield* Effect.all([vcs.branch(), vcs.defaultBranch()], { concurrency: 2 })
      }).pipe(provideInstance(dir))

      expect(branch).toBeDefined()
      expect(branch).toBe("feature/test")
      expect(base).toBe("main")
    }),
  )

  it.instance(
    "diff('git') returns uncommitted changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "original\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "changed\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "file.txt",
              status: "modified",
            }),
          ]),
        )
        expect(diff.find((item) => item.file === "file.txt")?.patch).toContain("diff --git")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') handles special filenames",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, weird), "hello\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: weird,
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps batched patches aligned for type changes",
    () =>
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const test = yield* TestInstance
        yield* write(path.join(test.directory, "a.txt"), "old\n")
        yield* write(path.join(test.directory, "b.txt"), "old\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add files"])
        yield* remove(path.join(test.directory, "a.txt"))
        yield* symlink("target", path.join(test.directory, "a.txt"))
        yield* write(path.join(test.directory, "b.txt"), "new\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const a = diff.find((item) => item.file === "a.txt")
        const b = diff.find((item) => item.file === "b.txt")

        expect(a?.patch).toContain("deleted file mode")
        expect(a?.patch).toContain("new file mode")
        expect(b?.patch).toContain("+new")
      }),
    { git: true },
  )

  it.instance(
    "diff('git') keeps carriage returns inside patch hunks",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "file.txt"), "keep\nsame\rdiff --git inside\ndelete\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add file"])
        yield* write(path.join(test.directory, "file.txt"), "keep\nadd\nsame\rdiff --git inside\n")

        const vcs = yield* init()
        const diff = yield* vcs.diff("git")
        const file = diff.find((item) => item.file === "file.txt")

        expect(file?.patch).toContain(" same\rdiff --git inside")
        expect(file?.patch).toContain("-delete")
        expect(() => parsePatch(file?.patch ?? "")).not.toThrow()
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "diff('branch') returns changes against default branch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* git(test.directory, ["checkout", "-b", "feature/test"])
        yield* write(path.join(test.directory, "branch.txt"), "hello\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "branch file"])

        const vcs = yield* init()
        const diff = yield* vcs.diff("branch")

        expect(diff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              file: "branch.txt",
              status: "added",
            }),
          ]),
        )
      }),
    { git: true },
  )

  it.instance(
    "diffRaw returns a complete patch for tracked and untracked files",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "tracked.txt"), "before\n")
        yield* git(test.directory, ["add", "tracked.txt"])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add tracked"])
        yield* write(path.join(test.directory, "tracked.txt"), "after\n")
        yield* write(path.join(test.directory, "untracked.txt"), "new\n")

        const patch = yield* (yield* init()).diffRaw()

        expect(patch).toContain("diff --git a/tracked.txt b/tracked.txt")
        expect(patch).toContain("diff --git a/untracked.txt b/untracked.txt")
        expect(Buffer.byteLength(patch)).toBeLessThanOrEqual(Vcs.RawDiffLimits.patchBytes)
      }),
    { git: true },
  )

  it.instance(
    "diffRaw includes staged files before the repository has its first commit",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "staged.txt"), "staged\n")
        yield* git(test.directory, ["add", "staged.txt"])

        const patch = yield* (yield* init()).diffRaw()

        expect(patch).toContain("diff --git a/staged.txt b/staged.txt")
        expect(patch).toContain("+staged")
      }),
    { git: true },
  )

  it.instance(
    "diffRaw fails closed when a tracked patch exceeds the UTF-8 budget",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "tracked.txt"), "before\n")
        yield* git(test.directory, ["add", "tracked.txt"])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "add tracked"])
        yield* write(path.join(test.directory, "tracked.txt"), "x".repeat(Vcs.RawDiffLimits.patchBytes + 1))

        const exit = yield* (yield* init()).diffRaw().pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure")
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "VcsRawDiffError",
            reason: "tracked-output",
            limit: Vcs.RawDiffLimits.patchBytes,
          })
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "diffRaw fails closed when an untracked patch exceeds the UTF-8 budget",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "untracked.txt"), "x".repeat(Vcs.RawDiffLimits.patchBytes + 1))

        const exit = yield* (yield* init()).diffRaw().pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure")
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "VcsRawDiffError",
            reason: "untracked-output",
          })
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "diffRaw fails closed before patch generation when candidate files exceed the limit",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.forEach(
          Array.from({ length: Vcs.RawDiffLimits.candidateFiles + 1 }, (_, index) => index),
          (index) => write(path.join(test.directory, `candidate-${index}.txt`), "x\n"),
          { concurrency: 32, discard: true },
        )

        const exit = yield* (yield* init()).diffRaw().pipe(Effect.exit)

        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure")
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "VcsRawDiffError",
            reason: "candidate-files",
            limit: Vcs.RawDiffLimits.candidateFiles,
            actual: Vcs.RawDiffLimits.candidateFiles + 1,
          })
      }),
    { git: true },
    20_000,
  )
})

describe("Vcs work overview", () => {
  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "work overview counts committed, staged, unstaged and untracked changes once without mutating Git",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "same.txt"), "one\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "overview base"])
        yield* git(test.directory, ["branch", "overview-base"])
        yield* git(test.directory, ["update-ref", "refs/remotes/origin/overview-base", "HEAD"])
        yield* write(path.join(test.directory, "same.txt"), "one\ntwo\n")
        yield* git(test.directory, ["add", "."])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "-m", "overview commit"])
        yield* write(path.join(test.directory, "same.txt"), "one\nstaged\n")
        yield* git(test.directory, ["add", "."])
        yield* write(path.join(test.directory, "same.txt"), "one\nworking\nthree\n")
        yield* write(path.join(test.directory, "new.txt"), "new\n")
        yield* write(path.join(test.directory, "empty.txt"), "")
        yield* Effect.promise(() => Bun.write(path.join(test.directory, "image.bin"), new Uint8Array([0, 1, 0, 2])))
        const service = yield* Git.Service
        const before = yield* service.run(["status", "--porcelain=v1", "-z"], { cwd: test.directory })
        const index = yield* service.run(["write-tree"], { cwd: test.directory })
        const head = yield* service.resolveRef(test.directory)
        const vcs = yield* init()
        const refs = yield* vcs.refs()
        expect(refs.items).toContainEqual(
          expect.objectContaining({ name: "overview-base", ref: "refs/heads/overview-base", kind: "local" }),
        )
        expect(refs.items).toContainEqual(
          expect.objectContaining({
            name: "origin/overview-base",
            ref: "refs/remotes/origin/overview-base",
            kind: "remote",
          }),
        )
        const summary = yield* vcs.summary("refs/heads/overview-base")
        expect(summary).toMatchObject({
          state: "ready",
          coverage: "complete",
          stale: false,
          files: 4,
          additions: 3,
          deletions: 0,
          uncommitted: 4,
          binary: 1,
          lineStatsComplete: false,
          conflicts: 0,
          headOID: head,
        })
        expect(
          (yield* Effect.flip(vcs.diff("branch", { baseRef: "refs/heads/overview-base", baseOID: "0".repeat(40) })))
            .reason,
        ).toBe("scope_changed")
        const diff = yield* vcs.diff("branch", {
          baseRef: "refs/heads/overview-base",
          baseOID: summary.baseOID ?? undefined,
          headOID: summary.headOID ?? undefined,
          context: 3,
        })
        expect(diff.map((item) => item.file).sort()).toEqual(["empty.txt", "image.bin", "new.txt", "same.txt"])
        expect((yield* service.run(["status", "--porcelain=v1", "-z"], { cwd: test.directory })).text()).toBe(
          before.text(),
        )
        expect((yield* service.run(["write-tree"], { cwd: test.directory })).text()).toBe(index.text())
        expect(yield* service.resolveRef(test.directory)).toBe(head)
      }),
    { git: true },
  )

  it.instance(
    "work overview explicitly compares the current branch instead of the old default-branch empty shortcut",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "-M", "main"])
        yield* write(path.join(test.directory, "local.txt"), "local\n")
        const vcs = yield* init()
        expect(yield* vcs.diff("branch")).toEqual([])
        expect(yield* vcs.summary("main")).toMatchObject({ state: "ready", files: 1, additions: 1, deletions: 0 })
        expect(yield* vcs.diff("branch", { baseRef: "main" })).toContainEqual(
          expect.objectContaining({ file: "local.txt" }),
        )
        for (const name of ["missing-ref", "HEAD~1", "--output=/tmp/invalid", "main; echo invalid"]) {
          expect(yield* vcs.summary(name)).toMatchObject({ state: "base_unavailable", files: null, additions: null })
          expect((yield* Effect.flip(vcs.diff("branch", { baseRef: name }))).reason).toBe("ref_invalid")
        }
      }),
    { git: true },
  )

  it.instance(
    "work overview reports detached identity and no-common-ancestor without claiming zero changes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* git(test.directory, ["branch", "overview-base"])
        yield* git(test.directory, ["checkout", "--detach", "HEAD"])
        const vcs = yield* init()
        expect(yield* vcs.summary("overview-base")).toMatchObject({ state: "ready", branch: null, files: 0 })
        yield* git(test.directory, ["checkout", "--orphan", "unrelated"])
        yield* git(test.directory, ["read-tree", "--empty"])
        yield* git(test.directory, ["commit", "--no-gpg-sign", "--allow-empty", "-m", "unrelated root"])
        expect(yield* vcs.summary("overview-base")).toMatchObject({
          state: "no_common_ancestor",
          files: null,
          additions: null,
        })
        expect((yield* Effect.flip(vcs.diff("branch", { baseRef: "overview-base" }))).reason).toBe("no_common_ancestor")
      }),
    { git: true },
  )

  it.instance("work overview distinguishes a non-Git directory from a clean repository", () =>
    Effect.gen(function* () {
      expect(yield* (yield* init()).summary()).toMatchObject({
        state: "non_git",
        files: null,
        additions: null,
        lineStatsComplete: false,
      })
    }),
  )
})

worktreeIt.live("work overview keeps a nested directory's status, numstat and review paths in the same scope", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped({ git: true })
    const dir = path.join(root, " nested ")
    yield* write(path.join(dir, "same.txt"), "before\n")
    yield* write(path.join(root, "outside.txt"), "outside\n")
    yield* git(root, ["add", "."])
    yield* git(root, ["commit", "--no-gpg-sign", "-m", "nested base"])
    yield* git(root, ["branch", "overview-base"])
    yield* git(root, ["config", "status.relativePaths", "false"])
    yield* write(path.join(dir, "same.txt"), "after\n")
    yield* write(path.join(dir, "new.txt"), "new\n")
    yield* write(path.join(root, "outside.txt"), "outside changed\n")
    const result = yield* Effect.gen(function* () {
      const vcs = yield* init()
      return {
        summary: yield* vcs.summary("overview-base"),
        diff: yield* vcs.diff("branch", { baseRef: "overview-base" }),
      }
    }).pipe(provideInstance(dir))
    expect(result.summary).toMatchObject({
      state: "ready",
      directory: dir,
      repositoryRoot: root,
      files: 2,
      additions: 2,
      deletions: 1,
      uncommitted: 2,
    })
    expect(result.diff.map((item) => item.file).sort()).toEqual(["new.txt", "same.txt"])
    expect(result.diff.find((item) => item.file === "same.txt")?.patch).toContain("--- a/same.txt")
    expect(result.diff.some((item) => item.patch?.includes("outside changed"))).toBe(false)
  }),
)
