import { buffer } from "node:stream/consumers"
import { Process } from "@/util/process"
import { DEFAULT_WORKER_IDENTITY } from "@/agent/collaboration-identity"

/**
 * G2 unified finalizer — the runtime-owned delivery step the Gamma plan (§5 阶段三) requires.
 *
 * The abs evidence: the model finished the implementation but never committed; the verifier grades
 * `git diff <base> HEAD`, so an uncommitted tree graded as an EMPTY patch and the run scored 0/6
 * despite complete work. Delivery (save/commit) is a runtime responsibility, not model discipline.
 *
 * Contract (mirrors agent-worktree's fail-safe posture — never lose work, never fake success):
 *   - ONLY the paths this session's own tool calls touched are committed (review finding: the
 *     first version ran `git add -A` on the PROJECT ROOT, silently absorbing the user's unrelated
 *     uncommitted work and other tasks' files into a runtime commit). The caller passes the
 *     write/edit targets extracted from the session's durable history; bash side effects are NOT
 *     attributable and are deliberately left uncommitted.
 *   - A recovery commit is made ONLY on the EXPLICIT "validated" verdict — all-pass evidence
 *     attributed to THIS activity (review round 5: three-state input; "validation_failed" and
 *     "unverified" both withhold, the tree keeps the work as diagnostic evidence / for the next
 *     round).
 *   - The commit identity is the runtime worker (never the model's or the user's), --no-verify so
 *     a repo hook cannot lose the work, --no-gpg-sign.
 *   - Any failure (no repo, git error, timeout) leaves the tree EXACTLY as it was and reports the
 *     reason; the finalizer never deletes, resets, or force-anything.
 *   - An empty diff is NOT a success: it reports `no_changes` so callers can distinguish
 *     "delivered" from "nothing to deliver".
 */

export type FinalizeOutcome =
  | { readonly kind: "committed"; readonly commit: string; files: number }
  | { readonly kind: "no_changes" }
  | { readonly kind: "validation_failed"; readonly files: number }
  | { readonly kind: "unverified"; readonly files: number }
  | { readonly kind: "skipped"; readonly reason: string }

const GIT_TIMEOUT_MS = 60_000

const git = async (args: readonly string[], cwd: string): Promise<{ code: number; stdout: string } | null> => {
  try {
    const proc = Process.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } })
    const stdout = proc.stdout
    if (!stdout) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {}
        resolve("timeout")
      }, GIT_TIMEOUT_MS)
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

/**
 * Commit a session's uncompleted work when the runtime can prove it is safe to deliver.
 * `validation` is an EXPLICIT three-state verdict (review round 5 — the boolean|null contract
 * made `null` mean both "no validation but allowed" and "evidence not trustworthy" at once, so
 * the fail-closed intent never actually held):
 *   - "validated"          → all-pass evidence attributed to THIS activity: commit.
 *   - "validation_failed"  → this activity's validation failed: withhold (diagnostic evidence).
 *   - "unverified"         → no evidence, or evidence not attributable to this activity:
 *                            withhold. The tree keeps the work — delivery defers, never loses.
 * `touchedPaths`: the session's own write/edit targets. Only these paths are ever staged; an
 * empty list skips delivery rather than committing nothing.
 */
export type FinalizerValidation = "validated" | "validation_failed" | "unverified"

export const finalizeSessionWork = async (input: {
  readonly directory: string
  readonly validation: FinalizerValidation
  readonly touchedPaths: readonly string[]
}): Promise<FinalizeOutcome> => {
  if (input.touchedPaths.length === 0) return { kind: "skipped", reason: "no_attributable_paths" }
  const toplevel = await git(["rev-parse", "--show-toplevel"], input.directory)
  if (!toplevel || toplevel.code !== 0) return { kind: "skipped", reason: "not_a_git_repo" }

  const status = await git(["status", "--porcelain", ...input.touchedPaths], input.directory)
  if (!status || status.code !== 0) return { kind: "skipped", reason: "git_status_unreadable" }
  const changedFiles = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (changedFiles.length === 0) return { kind: "no_changes" }

  if (input.validation !== "validated")
    return {
      kind: input.validation === "validation_failed" ? "validation_failed" : "unverified",
      files: changedFiles.length,
    }

  // Stage EXACTLY the attributable paths — never the whole tree.
  const staged = await git(["add", "--", ...input.touchedPaths], input.directory)
  if (!staged || staged.code !== 0) return { kind: "skipped", reason: "git_add_failed" }
  const committed = await git(
    [
      "-c",
      `user.name=${DEFAULT_WORKER_IDENTITY.name}`,
      "-c",
      `user.email=${DEFAULT_WORKER_IDENTITY.email}`,
      "commit",
      // Keep any index entries that predated this activity out of the runtime commit. `git add`
      // only adds the attributable paths, but a plain commit would still consume unrelated
      // entries already staged by the user or another process.
      "--only",
      "--no-gpg-sign",
      "--no-verify",
      "-m",
      "runtime finalizer: deliver session work (auto-preserved)",
      "--",
      ...input.touchedPaths,
    ],
    input.directory,
  )
  if (!committed || committed.code !== 0) return { kind: "skipped", reason: "git_commit_failed" }
  const head = await git(["rev-parse", "HEAD"], input.directory)
  if (!head || head.code !== 0) return { kind: "skipped", reason: "git_head_unreadable" }
  return { kind: "committed", commit: head.stdout.trim(), files: changedFiles.length }
}
