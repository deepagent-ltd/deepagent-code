import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit } from "effect"
import { Git } from "@deepagent-code/core/git"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { branch, commit, gitRemote } from "./fixture/git"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Git.defaultLayer)

describe("Git", () => {
  it.live("reports an unborn repository without a HEAD", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => $`git init`.cwd(root.path).quiet())
      const git = yield* Git.Service
      expect(yield* git.head(root.path)).toBeUndefined()
      expect(Exit.isFailure(yield* git.patch(AbsolutePath.make(root.path)).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.live("captures successive workspace revisions even when the same file remains dirty", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const directory = AbsolutePath.make(fixture.source)
        const clean = yield* git.patch(directory)
        yield* Effect.promise(() => fs.writeFile(path.join(fixture.source, "README.md"), "first edit\n"))
        const first = yield* git.patch(directory)
        yield* Effect.promise(() => fs.writeFile(path.join(fixture.source, "README.md"), "second edit\n"))
        const second = yield* git.patch(directory)
        expect(new Set([clean, first, second]).size).toBe(3)
        yield* Effect.promise(() => fs.writeFile(path.join(fixture.source, "new.txt"), "new evidence\n"))
        expect(yield* git.patch(directory)).not.toBe(second)
      }),
    ),
  )

  it.live("clones a remote and reads checkout metadata", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = path.join(fixture.root, "checkout")
        const result = yield* git.clone({ remote: fixture.remote, target })

        expect(result.exitCode).toBe(0)
        expect(yield* git.origin(target)).toBe(fixture.remote)
        expect(yield* git.head(target)).toBeString()
        expect(yield* git.branch(target)).toBe("main")
        expect(yield* git.remoteHead(target)).toBe("origin/main")
        expect(yield* read(path.join(target, "README.md"))).toBe("one\n")
      }),
    ),
  )

  it.live("fetches, checks out, and resets remote changes", () =>
    withRemote((fixture) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const target = path.join(fixture.root, "checkout")
        yield* git.clone({ remote: fixture.remote, target })

        yield* Effect.promise(() => commit(fixture.source, "two\n", "second"))
        expect((yield* git.fetch(target)).exitCode).toBe(0)
        expect((yield* git.reset(target, "origin/main")).exitCode).toBe(0)
        expect(yield* read(path.join(target, "README.md"))).toBe("two\n")

        yield* Effect.promise(() => branch(fixture.source, "feature/docs", "feature\n"))
        expect((yield* git.fetchBranch(target, "feature/docs")).exitCode).toBe(0)
        expect((yield* git.checkout(target, "feature/docs")).exitCode).toBe(0)
        expect((yield* git.reset(target, "origin/feature/docs")).exitCode).toBe(0)
        expect(yield* git.branch(target)).toBe("feature/docs")
        expect(yield* read(path.join(target, "README.md"))).toBe("feature\n")
      }),
    ),
  )
})

function withRemote<A, E, R>(body: (fixture: Awaited<ReturnType<typeof gitRemote>>) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.promise(async () => {
      const root = await tmpdir()
      return { root, fixture: await gitRemote(root.path) }
    }),
    (input) => body(input.fixture),
    (input) => Effect.promise(() => input.root[Symbol.asyncDispose]()),
  )
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replace(/\r\n/g, "\n")))
}

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@deepagent-code.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

describe("Git worktrees", () => {
  it.live("creates, lists, and removes linked worktrees", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const worktree = AbsolutePath.make(`${root.path}-git-worktree`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(worktree, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const git = yield* Git.Service
      const repo = { directory, store: AbsolutePath.make(path.join(directory, ".git")) }

      yield* git.worktreeCreate({ repo, directory: worktree })

      expect((yield* git.worktreeList(repo)).some((entry) => entry.endsWith("-git-worktree"))).toBe(true)
      const linked = yield* git.find(worktree)
      expect(linked?.directory).toBe(AbsolutePath.make(yield* Effect.promise(() => fs.realpath(worktree))))
      expect(linked?.store).toBe(repo.store)
      if (!linked) throw new Error("Linked worktree not found")
      yield* git.worktreeRemove({ repo: linked, directory: worktree, force: false })
      expect((yield* git.worktreeList(repo)).some((entry) => entry.endsWith("-git-worktree"))).toBe(false)
    }),
  )
})
