import path from "node:path"

// V3.1 A4 (P0 fix): real runner ground truth for the round report's change-surface dimension.
// The round report reconciles MODEL CLAIMS against RUNNER GROUND TRUTH; the changed-file list and
// diff stat must come from git, never from the model. This replaces the earlier stub
// (changed_files: [], diff_stat: null) that made change-surface reconciliation a no-op.

export type GitGroundTruth = {
  readonly changed_files: readonly string[]
  readonly diff_stat: string | null
  // P1-B: the repository root (absolute) `git diff` paths are relative to. The claimed change
  // surface MUST be relativized against this SAME base, not the session cwd — git always emits
  // repo-root-relative paths, so when cwd is a subdirectory of the repo, relativizing claims to cwd
  // made every claimed file look "phantom" and falsely forced needs_human. null outside a git repo.
  readonly repo_root: string | null
}

const EMPTY: GitGroundTruth = { changed_files: [], diff_stat: null, repo_root: null }

const run = async (args: readonly string[], cwd: string, timeoutMs: number): Promise<string | null> => {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } })
    // P2-5: race read+exit against a timeout sentinel; on timeout kill and resolve null instead of
    // awaiting stdout that may never close after kill.
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
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return { stdout, exitCode } as const
    })()
    const outcome = await Promise.race([completed, timeout])
    if (timer) clearTimeout(timer)
    if (outcome === "timeout") return null
    return outcome.exitCode === 0 ? outcome.stdout : null
  } catch {
    return null
  }
}

// Collect the real working-tree change surface (tracked modifications + untracked files) and a
// human-readable diff stat. Best-effort: outside a git repo or on any git failure it returns the
// empty truth, which simply means "no change-surface evidence" (reconciliation stays sound).
export const gitGroundTruth = async (cwd: string, timeoutMs = 15_000): Promise<GitGroundTruth> => {
  const tracked = await run(["diff", "--name-only", "HEAD"], cwd, timeoutMs)
  if (tracked === null) return EMPTY
  // P1-B: resolve the repo root so callers can relativize the model's claimed change surface against
  // the SAME base git uses. Best-effort: if rev-parse fails the report still carries the file list.
  const repoRootRaw = await run(["rev-parse", "--show-toplevel"], cwd, timeoutMs)
  const repo_root = repoRootRaw && repoRootRaw.trim().length > 0 ? repoRootRaw.trim() : null
  const untracked = (await run(["ls-files", "--others", "--exclude-standard"], cwd, timeoutMs)) ?? ""
  const files = [...tracked.split("\n"), ...untracked.split("\n")]
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  // Normalize to repo-relative POSIX paths and de-duplicate.
  const changed_files = [...new Set(files.map((f) => f.split(path.sep).join("/")))].sort()
  const stat = (await run(["diff", "--stat", "HEAD"], cwd, timeoutMs))?.trim()
  return { changed_files, diff_stat: stat && stat.length > 0 ? stat : null, repo_root }
}
