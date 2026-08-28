import path from "node:path"
import { mkdir } from "node:fs/promises"
import { buffer } from "node:stream/consumers"
import { Global } from "@deepagent-code/core/global"
import { DEFAULT_WORKER_IDENTITY } from "@/agent/collaboration-identity"
import { Process } from "@/util/process"
import { Filesystem } from "@/util/filesystem"

// V4.0 §C3.2 (P4.5a) — PHYSICAL per-agent worktree isolation for the event-driven turn runner.
//
// P2.9 shipped file-locks + code-graph symbol arbitration but DEFERRED physical branch/worktree
// isolation ("locks+arbiter give the safety without separate worktrees"). This module is that deferred
// half: it gives each concurrent event-driven agent subtask its OWN git worktree on its OWN branch, so
// two agents editing the same repo genuinely operate on separate working trees (complementing — not
// replacing — the P2.9 locks + P2.9 conflict arbiter).
//
// It is a self-contained git-CLI helper rather than the
// Worktree.Service: that service is InstanceState-bound + project-sandbox-registered + persisted under
// Global.Path.data (built for long-lived, user-visible worktrees), whereas these are EPHEMERAL, per-turn,
// temp-dir worktrees created + torn down inside one dispatch turn — and the SubagentTurnRunner effect has
// no service (R) channel to require a service through.
//
// FAIL-SAFE CONTRACT: createAgentWorktree returns null on ANY failure. The caller decides whether a
// read-only turn may degrade to the event directory or a write turn must fail closed. Cleanup returns a
// durable continuation ref only after it has proved the branch state recoverable. Uncertain git state is
// never force-removed.

export type AgentWorktree = {
  /** The isolated working directory the agent turn should run in. */
  readonly directory: string
  /** The dedicated branch the worktree is checked out on (agent/<label>-<rand>). */
  readonly branch: string
  /** The repository root the worktree belongs to (git ops target this). */
  readonly repoRoot: string
  /** The commit HEAD pointed at when the worktree was created (the recoverability baseline). */
  readonly baseSha: string
}

export type AgentWorktreeCleanup = {
  /** Ref dependent agent turns must use as their base. A clean turn continues from baseSha. */
  readonly continuationRef: string
  /** Source-control artifacts suitable for AgentCoordinationEvent persistence. */
  readonly artifacts: ReadonlyArray<string>
}

const GIT_TIMEOUT_MS = 30_000

// Run a git command; resolve { code, stdout } or null on spawn failure/timeout. Mirrors git-groundtruth.
const git = async (
  args: readonly string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<{ code: number; stdout: string } | null> => {
  try {
    const proc = Process.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })
    const stdout = proc.stdout
    if (!stdout) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {}
        resolve("timeout")
      }, timeoutMs)
    })
    const completed = (async () => {
      const [output, exitCode] = await Promise.all([buffer(stdout), proc.exited])
      return { stdout: output.toString(), exitCode } as const
    })()
    const outcome = await Promise.race([completed, timeout])
    if (timer) clearTimeout(timer)
    if (outcome === "timeout") return null
    return { code: outcome.exitCode, stdout: outcome.stdout }
  } catch {
    return null
  }
}

// Slugify a free-text label into a branch-name-safe segment. git ref rules forbid many chars; we keep
// [a-z0-9-] and cap the length so a long correlationID can't blow up the ref name.
const slugifyLabel = (label: string): string =>
  label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 48) || "turn"

const randomSuffix = (): string => Math.random().toString(36).slice(2, 10)

/**
 * Create a dedicated, ephemeral git worktree + branch for one agent turn, rooted in the triggering
 * event's directory. Returns the isolated handle, or NULL when isolation is not possible/failed (not a
 * git repo, git unavailable, worktree add failed) — the caller falls back to the event directory. Never
 * throws.
 */
export const createAgentWorktree = async (input: {
  readonly eventDirectory: string
  readonly label: string
  /** Optional upstream dependency ref. Omitted means the repository's current HEAD. */
  readonly baseRef?: string
}): Promise<AgentWorktree | null> => {
  // 1) Only a real git repo can host a worktree. rev-parse --show-toplevel resolves the repo root and
  //    simultaneously proves the directory is inside a work tree. Any failure ⇒ fall back.
  const toplevel = await git(["rev-parse", "--show-toplevel"], input.eventDirectory)
  if (!toplevel || toplevel.code !== 0) return null
  const repoRoot = toplevel.stdout.trim()
  if (!repoRoot) return null

  // 2) Capture the baseline commit so cleanup can tell "the agent produced recoverable work" (branch
  //    advanced past base) from "nothing happened" (delete the throwaway branch).
  const head = await git(["rev-parse", input.baseRef ?? "HEAD"], repoRoot)
  if (!head || head.code !== 0) return null
  const baseSha = head.stdout.trim()
  if (!baseSha) return null

  const rand = randomSuffix()
  const branch = `agent/${slugifyLabel(input.label)}-${rand}`
  const directory = path.join(Global.Path.agent.tmp, `worktree-${rand}`)
  await mkdir(Global.Path.agent.tmp, { recursive: true })

  // 3) Create the worktree on a NEW branch checked out from the current HEAD. This physically clones the
  //    working tree into an isolated directory — the whole point of §C3.2.
  const added = await git(["worktree", "add", "-b", branch, directory, baseSha], repoRoot)
  if (!added || added.code !== 0) {
    // Best-effort cleanup of any partial state, then fall back.
    await git(["worktree", "remove", "--force", directory], repoRoot)
    await git(["branch", "-D", branch], repoRoot)
    return null
  }

  return { directory: Filesystem.resolve(directory), branch, repoRoot: Filesystem.resolve(repoRoot), baseSha }
}

/**
 * Tear down a per-agent worktree, preserving any work the agent produced. Never throws.
 *   - Uncommitted changes are committed to the branch (--no-verify so a repo hook can't lose the work),
 *     making the result recoverable via the branch.
 *   - A branch that advanced past its baseline is KEPT (recoverable); the working dir is removed.
 *   - A genuinely-clean turn removes BOTH the worktree and its throwaway branch (no litter).
 *   - If work exists but could NOT be committed, the worktree dir is LEFT ON DISK (recoverable) rather
 *     than force-removed — losing work is worse than leaking a temp dir.
 */
export const cleanupAgentWorktree = async (wt: AgentWorktree): Promise<AgentWorktreeCleanup | null> => {
  // Detect uncommitted work. An unreadable status is uncertain state: leave everything recoverable.
  const status = await git(["status", "--porcelain"], wt.directory)
  if (!status || status.code !== 0) return null
  const hasUncommitted = status.stdout.trim().length > 0

  if (hasUncommitted) {
    const add = await git(["add", "-A"], wt.directory)
    const commit =
      add && add.code === 0
        ? await git(
            [
              "-c",
              `user.name=${DEFAULT_WORKER_IDENTITY.name}`,
              "-c",
              `user.email=${DEFAULT_WORKER_IDENTITY.email}`,
              "commit",
              "--no-gpg-sign",
              "--no-verify",
              "-m",
              "agent turn work (auto-preserved)",
            ],
            wt.directory,
          )
        : null
    if (!commit || commit.code !== 0) return null
  }

  // Does the branch hold recoverable commits (advanced past baseline)?
  const ahead = await git(["rev-list", "--count", `${wt.baseSha}..${wt.branch}`], wt.repoRoot)
  if (!ahead || ahead.code !== 0) return null
  const hasWork = ahead != null && ahead.code === 0 && Number(ahead.stdout.trim()) > 0

  // Remove the working directory (its work, if any, is now committed on the branch).
  const removed = await git(["worktree", "remove", "--force", wt.directory], wt.repoRoot)

  // Delete the throwaway branch ONLY when it carries no recoverable work and the worktree was removed.
  if (!hasWork && removed?.code === 0) {
    await git(["branch", "-D", wt.branch], wt.repoRoot)
  }

  return {
    continuationRef: hasWork ? wt.branch : wt.baseSha,
    artifacts: hasWork ? [`git-ref:${wt.branch}`] : [`git-ref:${wt.baseSha}`],
  }
}

export * as AgentWorktree from "./agent-worktree"
