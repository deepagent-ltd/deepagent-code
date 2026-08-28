import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Git } from "../../src/git"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const weird = process.platform === "win32" ? "space file.txt" : "tab\tfile.txt"
const it = testEffect(Git.defaultLayer)

const scopedTmpdir = (options?: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("Git", () => {
  it.live("branch() returns current branch name", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      const branch = yield* git.branch(tmp.path)
      expect(branch).toBeDefined()
      expect(typeof branch).toBe("string")
    }),
  )

  it.live("branch() returns undefined for non-git directories", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const git = yield* Git.Service
      const branch = yield* git.branch(tmp.path)
      expect(branch).toBeUndefined()
    }),
  )

  it.live("branch() returns undefined for detached HEAD", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const hash = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(tmp.path).quiet().text())).trim()
      yield* Effect.promise(() => $`git checkout --detach ${hash}`.cwd(tmp.path).quiet())
      const git = yield* Git.Service
      const branch = yield* git.branch(tmp.path)
      expect(branch).toBeUndefined()
    }),
  )

  it.live("defaultBranch() uses init.defaultBranch when available", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => $`git branch -M trunk`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git config init.defaultBranch trunk`.cwd(tmp.path).quiet())
      const git = yield* Git.Service
      const branch = yield* git.defaultBranch(tmp.path)
      expect(branch?.name).toBe("trunk")
      expect(branch?.ref).toBe("trunk")
    }),
  )

  it.live("status() handles special filenames", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "hello\n", "utf-8"))
      const git = yield* Git.Service
      const status = yield* git.status(tmp.path)
      expect(status).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            status: "added",
          }),
        ]),
      )
    }),
  )

  it.live("diff(), stats(), and mergeBase() parse tracked changes", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => $`git branch -M main`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "before\n", "utf-8"))
      yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git checkout -b feature/test`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "after\n", "utf-8"))

      const git = yield* Git.Service
      const [base, diff, stats] = yield* Effect.all([
        git.mergeBase(tmp.path, "main"),
        git.diff(tmp.path, "HEAD"),
        git.stats(tmp.path, "HEAD"),
      ])

      expect(base).toBeTruthy()
      expect(diff).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            status: "modified",
          }),
        ]),
      )
      expect(stats).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: weird,
            additions: 1,
            deletions: 1,
          }),
        ]),
      )
    }),
  )

  it.live("patch() returns capped native patch output", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "before\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "other.txt"), "old\n", "utf-8"))
      yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "after\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "other.txt"), "new\n", "utf-8"))

      const git = yield* Git.Service
      const [patch, all, capped] = yield* Effect.all([
        git.patch(tmp.path, "HEAD", weird, { context: 2_147_483_647 }),
        git.patchAll(tmp.path, "HEAD", { context: 2_147_483_647 }),
        git.patch(tmp.path, "HEAD", weird, { maxOutputBytes: 1 }),
      ])

      expect(patch.truncated).toBe(false)
      expect(patch.text).toContain("diff --git")
      expect(patch.text).toContain("-before")
      expect(patch.text).toContain("+after")
      expect(all.truncated).toBe(false)
      expect(all.text).toContain("diff --git")
      expect(all.text).toContain("other.txt")
      expect(all.text).toContain("+new")
      expect(capped.truncated).toBe(true)
      expect(capped.text).toBe("")
    }),
  )

  it.live("patchUntracked() and statUntracked() handle added files", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, weird), "one\ntwo\n", "utf-8"))

      const git = yield* Git.Service
      const [patch, stat] = yield* Effect.all([
        git.patchUntracked(tmp.path, weird, { context: 2_147_483_647 }),
        git.statUntracked(tmp.path, weird),
      ])

      expect(patch.truncated).toBe(false)
      expect(patch.text).toContain("diff --git")
      expect(patch.text).toContain("+one")
      expect(patch.text).toContain("+two")
      expect(stat).toEqual(expect.objectContaining({ file: weird, additions: 2, deletions: 0 }))
    }),
  )

  it.live("collaboration primitives initialize repositories and report porcelain paths", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const git = yield* Git.Service

      expect(yield* git.repository(tmp.path)).toBeUndefined()
      expect((yield* git.initialize(tmp.path)).exitCode).toBe(0)
      expect(yield* git.repository(tmp.path)).toEqual(expect.objectContaining({ root: tmp.path, prefix: "" }))

      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "new.txt"), "new\n", "utf-8"))
      expect(yield* git.porcelainStatus(tmp.path)).toEqual(
        expect.objectContaining({ clean: false, paths: ["new.txt"] }),
      )
    }),
  )

  it.live("commitScoped() uses scoped identity and stages only declared paths", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "owned.txt"), "owned\n", "utf-8"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "user.txt"), "user\n", "utf-8"))

      const commit = yield* git.commitScoped(tmp.path, {
        paths: ["owned.txt"],
        message: "commit owned path",
        author: { name: "Scoped Author", email: "author@example.test" },
      })
      expect(commit.exitCode).toBe(0)
      expect((yield* git.status(tmp.path)).map((item) => item.file)).toEqual(["user.txt"])

      const metadata = yield* git.commitMetadata(tmp.path, "HEAD")
      expect(metadata).toEqual(
        expect.objectContaining({
          author: { name: "Scoped Author", email: "author@example.test" },
          committer: { name: "Scoped Author", email: "author@example.test" },
          subject: "commit owned path",
        }),
      )
      expect((yield* git.commitScoped(tmp.path, {
        paths: ["../outside.txt"],
        message: "unsafe",
        author: { name: "Scoped Author", email: "author@example.test" },
      })).exitCode).not.toBe(0)
    }),
  )

  it.live("commitRange() verifies exact commits and changed paths", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      const base = yield* git.resolveRef(tmp.path)
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "range.txt"), "range\n", "utf-8"))
      expect((yield* git.commitScoped(tmp.path, {
        paths: ["range.txt"],
        message: "range commit",
        author: { name: "Range Author", email: "range@example.test" },
      })).exitCode).toBe(0)

      const range = yield* git.commitRange(tmp.path, base!)
      expect(range?.commits).toHaveLength(1)
      expect(range?.paths).toEqual(["range.txt"])
      expect(yield* git.changedPaths(tmp.path, base!)).toEqual(["range.txt"])
    }),
  )

  it.live("mergeInto() merges cleanly and reports abortable conflicts", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      const git = yield* Git.Service
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "shared.txt"), "base\n", "utf-8"))
      expect((yield* git.commitScoped(tmp.path, {
        paths: ["shared.txt"],
        message: "base shared",
        author: { name: "Merge Author", email: "merge@example.test" },
      })).exitCode).toBe(0)
      yield* Effect.promise(() => $`git branch -M main`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git checkout -b feature/clean`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "clean.txt"), "clean\n", "utf-8"))
      expect((yield* git.commitScoped(tmp.path, {
        paths: ["clean.txt"],
        message: "clean feature",
        author: { name: "Merge Author", email: "merge@example.test" },
      })).exitCode).toBe(0)
      yield* Effect.promise(() => $`git checkout main`.cwd(tmp.path).quiet())

      const clean = yield* git.mergeInto(tmp.path, "feature/clean")
      expect(clean.type).toBe("merged")
      expect(yield* git.changedPaths(tmp.path, "HEAD~1", "HEAD")).toEqual(["clean.txt"])

      yield* Effect.promise(() => $`git checkout -b feature/conflict HEAD~1`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "shared.txt"), "feature\n", "utf-8"))
      expect((yield* git.commitScoped(tmp.path, {
        paths: ["shared.txt"],
        message: "conflicting feature",
        author: { name: "Merge Author", email: "merge@example.test" },
      })).exitCode).toBe(0)
      yield* Effect.promise(() => $`git checkout main`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "shared.txt"), "main\n", "utf-8"))
      expect((yield* git.commitScoped(tmp.path, {
        paths: ["shared.txt"],
        message: "conflicting main",
        author: { name: "Merge Author", email: "merge@example.test" },
      })).exitCode).toBe(0)

      const conflict = yield* git.mergeInto(tmp.path, "feature/conflict")
      expect(conflict).toEqual(expect.objectContaining({ type: "conflict", paths: ["shared.txt"] }))
      expect((yield* git.abortMerge(tmp.path)).exitCode).toBe(0)
      expect((yield* git.status(tmp.path)).map((item) => item.file)).toEqual([])
    }),
  )

  it.live("show() returns empty text for binary blobs", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir({ git: true })
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "bin.dat"), new Uint8Array([0, 1, 2, 3])))
      yield* Effect.promise(() => $`git add .`.cwd(tmp.path).quiet())
      yield* Effect.promise(() => $`git commit --no-gpg-sign -m "add binary"`.cwd(tmp.path).quiet())

      const git = yield* Git.Service
      const text = yield* git.show(tmp.path, "HEAD", "bin.dat")
      expect(text).toBe("")
    }),
  )
})
