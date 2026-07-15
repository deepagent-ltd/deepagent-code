import { describe, expect, test, afterEach } from "bun:test"
import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { createAgentWorktree, cleanupAgentWorktree } from "../../src/session/agent-worktree"

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
    await cleanupAgentWorktree(wt)
    // working dir gone
    expect(await fs.exists(wt.directory)).toBe(false)
    // branch KEPT with the auto-preserved commit → the work is recoverable
    const branches = await git(["branch", "--list", wt.branch], repo)
    expect(branches.stdout.includes(wt.branch)).toBe(true)
    const show = await git(["show", `${wt.branch}:agent-output.txt`], repo)
    expect(show.code).toBe(0)
    expect(show.stdout.trim()).toBe("result")
    // cleanup the kept branch so the temp repo teardown is clean
    await git(["branch", "-D", wt.branch], repo)
  })

  test("cleanup reaps a genuinely-clean turn (worktree + throwaway branch both removed)", async () => {
    const repo = await makeRepo()
    const wt = await createAgentWorktree({ eventDirectory: repo, label: "noop" })
    expect(wt).not.toBeNull()
    if (!wt) return
    // no work produced → clean turn
    await cleanupAgentWorktree(wt)
    expect(await fs.exists(wt.directory)).toBe(false)
    const branches = await git(["branch", "--list", wt.branch], repo)
    expect(branches.stdout.trim()).toBe("") // throwaway branch reaped
  })

  test("non-git directory → null (the runner falls back to the event dir)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepagent-nongit-"))
    cleanupDirs.push(dir)
    const wt = await createAgentWorktree({ eventDirectory: dir, label: "x" })
    expect(wt).toBeNull()
  })
})
