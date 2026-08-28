import { describe, expect, test, afterEach } from "bun:test"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { createAgentWorktree, cleanupAgentWorktree } from "../../src/session/agent-worktree"
import { Global } from "@deepagent-code/core/global"
import { DEFAULT_WORKER_IDENTITY } from "../../src/agent/collaboration-identity"
import { Filesystem } from "../../src/util/filesystem"

// §C3.2 (P4.5a) — the git-CLI worktree helper against a REAL temp git repo. Proves: a git repo yields a
// distinct, isolated worktree dir on a dedicated branch; cleanup preserves committed work (branch KEPT)
// but reaps a clean throwaway; a non-git dir yields null (→ the runner falls back). Never throws.

const git = async (args: string[], cwd: string): Promise<{ code: number; stdout: string }> => {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, stdout }
}

const cleanupDirs: string[] = []
afterEach(async () => {
  for (const d of cleanupDirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {})
})

const makeRepo = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepagent-wt-test-"))
  cleanupDirs.push(dir)
  await git(["init", "-b", "main"], dir)
  await git(["config", "user.email", "test@test.dev"], dir)
  await git(["config", "user.name", "test"], dir)
  await fs.writeFile(path.join(dir, "seed.txt"), "seed\n")
  await git(["add", "-A"], dir)
  await git(["commit", "--no-verify", "-m", "seed"], dir)
  return dir
}

describe("agent-worktree (§C3.2 / P4.5a)", () => {
  test("creates an isolated worktree dir on a dedicated branch for a git repo", async () => {
    const repo = await makeRepo()
    const wt = await createAgentWorktree({ eventDirectory: repo, label: "corr-123" })
    expect(wt).not.toBeNull()
    if (!wt) return
    cleanupDirs.push(wt.directory)
    // physically distinct working directory
    expect(wt.directory).not.toBe(repo)
    expect(wt.directory.startsWith(Filesystem.resolve(Global.Path.agent.tmp) + path.sep)).toBe(true)
    expect(wt.directory).toBe(await fs.realpath(wt.directory))
    expect(await fs.exists(path.join(wt.directory, "seed.txt"))).toBe(true)
    // dedicated branch, listed as a git worktree of the repo
    expect(wt.branch.startsWith("agent/")).toBe(true)
    const list = await git(["worktree", "list", "--porcelain"], repo)
    expect(list.stdout.includes(wt.directory)).toBe(true)
    await cleanupAgentWorktree(wt)
  })

  test("cleanup preserves committed work on the branch but removes the working dir", async () => {
    const repo = await makeRepo()
    const wt = await createAgentWorktree({ eventDirectory: repo, label: "work" })
    expect(wt).not.toBeNull()
    if (!wt) return
    // the agent produced uncommitted work
    await fs.writeFile(path.join(wt.directory, "agent-output.txt"), "result\n")
    const cleaned = await cleanupAgentWorktree(wt)
    // working dir gone
    expect(await fs.exists(wt.directory)).toBe(false)
    // branch KEPT with the auto-preserved commit → the work is recoverable
    const branches = await git(["branch", "--list", wt.branch], repo)
    expect(branches.stdout.includes(wt.branch)).toBe(true)
    const show = await git(["show", `${wt.branch}:agent-output.txt`], repo)
    expect(show.code).toBe(0)
    expect(show.stdout.trim()).toBe("result")
    expect(cleaned?.continuationRef).toBe(wt.branch)
    expect(cleaned?.artifacts).toEqual([`git-ref:${wt.branch}`])
    const identity = await git(["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", wt.branch], repo)
    expect(identity.stdout.trim().split("\0")).toEqual([
      DEFAULT_WORKER_IDENTITY.name,
      DEFAULT_WORKER_IDENTITY.email,
      DEFAULT_WORKER_IDENTITY.name,
      DEFAULT_WORKER_IDENTITY.email,
    ])
    // cleanup the kept branch so the temp repo teardown is clean
    await git(["branch", "-D", wt.branch], repo)
  })

  test("cleanup reaps a genuinely-clean turn (worktree + throwaway branch both removed)", async () => {
    const repo = await makeRepo()
    const wt = await createAgentWorktree({ eventDirectory: repo, label: "noop" })
    expect(wt).not.toBeNull()
    if (!wt) return
    // no work produced → clean turn
    const cleaned = await cleanupAgentWorktree(wt)
    expect(await fs.exists(wt.directory)).toBe(false)
    const branches = await git(["branch", "--list", wt.branch], repo)
    expect(branches.stdout.trim()).toBe("") // throwaway branch reaped
    expect(cleaned?.continuationRef).toBe(wt.baseSha)
  })

  test("non-git directory → null (the caller chooses read-only fallback or write fail-closed)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepagent-nongit-"))
    cleanupDirs.push(dir)
    const wt = await createAgentWorktree({ eventDirectory: dir, label: "x" })
    expect(wt).toBeNull()
  })

  test("creates a dependent worktree from the upstream branch instead of repository HEAD", async () => {
    const repo = await makeRepo()
    const upstream = await createAgentWorktree({ eventDirectory: repo, label: "upstream" })
    expect(upstream).not.toBeNull()
    if (!upstream) return
    await fs.writeFile(path.join(upstream.directory, "upstream.txt"), "visible downstream\n")
    const preserved = await cleanupAgentWorktree(upstream)
    expect(preserved?.continuationRef).toBe(upstream.branch)

    const dependent = await createAgentWorktree({
      eventDirectory: repo,
      label: "dependent",
      baseRef: preserved?.continuationRef,
    })
    expect(dependent).not.toBeNull()
    if (!dependent) return
    expect(await fs.readFile(path.join(dependent.directory, "upstream.txt"), "utf8")).toBe("visible downstream\n")
    await cleanupAgentWorktree(dependent)
    await git(["branch", "-D", upstream.branch], repo)
  })

  test("an unreadable worktree is left recoverable instead of being force-removed", async () => {
    const repo = await makeRepo()
    const wt = await createAgentWorktree({ eventDirectory: repo, label: "uncertain" })
    expect(wt).not.toBeNull()
    if (!wt) return
    await fs.rename(wt.directory, `${wt.directory}-moved`)
    cleanupDirs.push(`${wt.directory}-moved`)

    expect(await cleanupAgentWorktree(wt)).toBeNull()
    expect((await git(["branch", "--list", wt.branch], repo)).stdout).toContain(wt.branch)
    expect((await git(["worktree", "list", "--porcelain"], repo)).stdout).toContain(wt.directory)
  })
})
