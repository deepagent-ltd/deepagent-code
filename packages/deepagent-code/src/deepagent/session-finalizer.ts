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
  | {
      readonly kind: "no_changes"
      readonly branch?: string | null
      readonly headBefore?: string | null
      readonly headAfter?: string | null
    }
  | {
      /** Attributable paths are clean AND the branch/HEAD moved: work exists off this surface. */
      readonly kind: "no_changes_on_this_branch"
      files: number
      branch?: string
      headBefore?: string
      headAfter?: string
      recoveryRef: string
    }
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

/** The git facts a delivery verdict must carry, so the outcome is auditable after the fact. */
export type FinalizerGitState = {
  readonly branch: string | null
  readonly head: string | null
  /**
   * Every local branch ref and its commit at observation time. A branch tip is the only durable
   * evidence that the activity's work landed somewhere: a model may commit to a side branch and
   * check the original one back out, leaving the delivery surface (HEAD + worktree) genuinely
   * clean while the work sits one ref away.
   */
  readonly refs: Readonly<Record<string, string>>
}

/**
 * Read the branch, HEAD and branch-tip map. `null` values mean "not a git repo / unreadable" — the
 * caller records that honestly rather than substituting a plausible default.
 */
export const finalizerGitState = async (directory: string): Promise<FinalizerGitState> => {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], directory)
  const head = await git(["rev-parse", "HEAD"], directory)
  const refs = await git(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], directory)
  return {
    branch: branch && branch.code === 0 ? branch.stdout.trim() : null,
    head: head && head.code === 0 ? head.stdout.trim() : null,
    refs:
      refs && refs.code === 0
        ? Object.fromEntries(
            refs.stdout
              .split("\n")
              .map((line) => line.trim().split(/\s+/))
              .filter((parts) => parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined)
              .map((parts) => [parts[0]!, parts[1]!]),
          )
        : {},
  }
}

/**
 * Branches that ADVANCED during the activity, newest-tip first. Comparing the tip map catches work
 * committed to a branch that is not checked out (including one the activity created), which
 * comparing HEAD against HEAD cannot see when the activity returns to its starting commit.
 */
const advancedBranches = async (
  beforeRefs: FinalizerGitState["refs"],
  after: FinalizerGitState,
  directory: string,
): Promise<ReadonlyArray<{ readonly branch: string; readonly tip: string }>> => {
  const moved = Object.entries(after.refs).filter(([name, tip]) => beforeRefs[name] !== tip)
  if (moved.length === 0) return []
  const ranked = await Promise.all(
    moved.map(async ([branch, tip]) => {
      const when = await git(["log", "-1", "--format=%ct", tip], directory)
      return { branch, tip, at: when && when.code === 0 ? Number(when.stdout.trim()) : 0 }
    }),
  )
  return ranked.sort((a, b) => b.at - a.at).map(({ branch, tip }) => ({ branch, tip }))
}

/** Does `tip` contain every touched path, relative to the delivery surface's HEAD? */
const tipCarriesPaths = async (
  branch: string,
  tip: string,
  head: string | null,
  touchedPaths: readonly string[],
  directory: string,
): Promise<boolean> => {
  if (head === null) return false
  const diff = await git(["diff", "--name-only", head, tip, "--", ...touchedPaths], directory)
  if (!diff || diff.code !== 0) return false
  const named = new Set(
    diff.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  )
  return touchedPaths.every((path_) => named.has(path_))
}

export const finalizeSessionWork = async (input: {
  readonly directory: string
  readonly validation: FinalizerValidation
  readonly touchedPaths: readonly string[]
  /** HEAD (and branch) observed when the activity STARTED, so a side-branch commit is detectable. */
  readonly headBefore?: string | null
  readonly branchBefore?: string | null
  /** Branch tips observed when the activity started (see FinalizerGitState.refs). */
  readonly refsBefore?: FinalizerGitState["refs"] | null
}): Promise<FinalizeOutcome> => {
  const current = await finalizerGitState(input.directory)
  const state = { branch: current.branch, headBefore: input.headBefore ?? null, headAfter: current.head }
  if (input.touchedPaths.length === 0) return { kind: "skipped", reason: "no_attributable_paths", ...state }
  const toplevel = await git(["rev-parse", "--show-toplevel"], input.directory)
  if (!toplevel || toplevel.code !== 0) return { kind: "skipped", reason: "not_a_git_repo", ...state }

  const status = await git(["status", "--porcelain", ...input.touchedPaths], input.directory)
  if (!status || status.code !== 0) return { kind: "skipped", reason: "git_status_unreadable", ...state }
  const changedFiles = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (changedFiles.length === 0) {
    // A clean attributable set is NOT proof there was nothing to deliver: the model may have
    // committed the work itself — possibly to a branch that is not checked out. Round-7 did exactly
    // that (task instruction: "work on this in a new branch from main and commit everything"),
    // leaving this surface clean while the work sat one ref away, and the runtime reported
    // "no changes to deliver". Any branch tip that advanced during the activity AND now carries the
    // attributable paths is a recovery reference, never a silent nothing.
    const advanced = await advancedBranches(input.refsBefore ?? current.refs, current, input.directory)
    for (const candidate of advanced)
      if (await tipCarriesPaths(candidate.branch, candidate.tip, current.head, input.touchedPaths, input.directory))
        return {
          kind: "no_changes_on_this_branch",
          files: 0,
          branch: current.branch ?? undefined,
          headBefore: input.headBefore ?? undefined,
          headAfter: current.head ?? undefined,
          recoveryRef: `${candidate.branch}@${candidate.tip}`,
        }
    return { kind: "no_changes", ...state }
  }

  if (input.validation !== "validated")
    return {
      kind: input.validation === "validation_failed" ? "validation_failed" : "unverified",
      files: changedFiles.length,
      ...state,
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
  if (!committed || committed.code !== 0) return { kind: "skipped", reason: "git_commit_failed", ...state }
  const head = await git(["rev-parse", "HEAD"], input.directory)
  if (!head || head.code !== 0) return { kind: "skipped", reason: "git_head_unreadable", ...state }
  return { kind: "committed", commit: head.stdout.trim(), files: changedFiles.length }
}
