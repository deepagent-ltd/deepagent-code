import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileLog, isTracked } from "./git"

const exec = promisify(execFile)

// Drives a real `git` binary against a throwaway repo so the test covers the actual git invocation
// path (argument formatting, record separator parsing, error classification) rather than a stub.

async function withRepo(fn: (repo: string) => Promise<void>) {
  const repo = await mkdtemp(join(tmpdir(), "deepagent-code-git-"))
  // Isolate git from any host identity/config so commits succeed without user setup.
  await exec("git", ["-C", repo, "init", "-q"])
  await exec("git", ["-C", repo, "config", "user.email", "test@example.com"])
  await exec("git", ["-C", repo, "config", "user.name", "Test User"])
  try {
    await fn(repo)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

async function commit(repo: string, message: string) {
  await exec("git", ["-C", repo, "add", "-A"])
  await exec("git", ["-C", repo, "commit", "-q", "-m", message])
}

describe("isTracked", () => {
  test("reports true for a committed file", async () => {
    await withRepo(async (repo) => {
      await writeFile(join(repo, "tracked.txt"), "v1")
      await commit(repo, "add file")
      const res = await isTracked(repo, "tracked.txt")
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.tracked).toBe(true)
    })
  })

  test("reports false for an untracked file", async () => {
    await withRepo(async (repo) => {
      // commit a seed file first, then create the untracked one WITHOUT staging it
      await writeFile(join(repo, "other.txt"), "x")
      await exec("git", ["-C", repo, "add", "other.txt"])
      await exec("git", ["-C", repo, "commit", "-q", "-m", "seed"])
      await writeFile(join(repo, "untracked.txt"), "nope")
      const res = await isTracked(repo, "untracked.txt")
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.tracked).toBe(false)
    })
  })

  test("reports false (not an error) outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepagent-code-git-"))
    try {
      await writeFile(join(dir, "lonely.txt"), "x")
      const res = await isTracked(dir, "lonely.txt")
      expect(res.ok).toBe(true)
      if (res.ok) expect(res.tracked).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("fileLog", () => {
  test("returns commits touching the file in reverse-chronological order", async () => {
    await withRepo(async (repo) => {
      await writeFile(join(repo, "doc.md"), "first")
      await commit(repo, "create doc")
      await writeFile(join(repo, "doc.md"), "second")
      await commit(repo, "update doc")

      const res = await fileLog(repo, "doc.md")
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.entries.length).toBe(2)
      // most recent first
      expect(res.entries[0].subject).toBe("update doc")
      expect(res.entries[1].subject).toBe("create doc")
      // each entry has hash/author/date populated
      expect(res.entries[0].hash).toMatch(/^[0-9a-f]{7,}$/)
      expect(res.entries[0].author).toBe("Test User")
      expect(res.entries[0].date).toBeTruthy()
    })
  })

  test("returns an empty list for a file with no history", async () => {
    await withRepo(async (repo) => {
      await writeFile(join(repo, "seed.txt"), "x")
      await commit(repo, "seed")
      await writeFile(join(repo, "fresh.txt"), "never committed")

      const res = await fileLog(repo, "fresh.txt")
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.entries).toEqual([])
    })
  })

  test("follows renames across commits", async () => {
    await withRepo(async (repo) => {
      await writeFile(join(repo, "old.md"), "content")
      await commit(repo, "add old")
      // rename via git mv so --follow can trace it
      await exec("git", ["-C", repo, "mv", "old.md", "new.md"])
      await commit(repo, "rename to new")

      const res = await fileLog(repo, "new.md")
      expect(res.ok).toBe(true)
      if (!res.ok) return
      // --follow surfaces history from before the rename
      expect(res.entries.length).toBeGreaterThanOrEqual(2)
      expect(res.entries.some((e) => e.subject === "add old")).toBe(true)
      expect(res.entries.some((e) => e.subject === "rename to new")).toBe(true)
    })
  })
})
