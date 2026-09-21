export * as TaskWorkspace from "./task-workspace"

/**
 * Core-native TaskWorkspace: deterministic, run-owned git worktrees for write-isolated subagent
 * task runs (durable-only migration wave 3, worklist #29 part 1).
 *
 * Deterministic derivation (legacy `task-worktree.ts` convention, so UX/CLI expectations and
 * the existing on-disk layout survive; the receipt documents it via `derivation`):
 *   operationKey = task_run.workspace_operation_key (the deterministic child session id)
 *   name         = `task-<sha256(operationKey).slice(0, 24)>`
 *   branch       = `deepagent-code/<name>`
 *   directory    = `<Global.Path.data>/worktree/durable/<sha256(repositoryRoot).slice(0, 16)>/<name>`
 *
 * Receipt protocol (all state lives on the existing L1 `task_run` columns — no new tables):
 *   workspace_preflight_state: pending → ready | failed   (ready is the child-start fence)
 *   workspace_branch_state:    none → admitting → ready    (branch receipt; mirrors the worktree)
 *   worktree_state:            none → admitting → ready → removed
 *
 * The READY receipt settles strictly BEFORE child execution and is the fence: child session
 * creation and first-input admission refuse (typed) unless a write-isolated run is `ready`
 * (see {@link childLocation} / {@link requireAdmissible}). A crash between the receipt and the
 * child start adopts on retry — the same derivation converges on the same branch/directory and
 * the idempotent git ensure re-verifies instead of duplicating.
 *
 * The parent checkout is NEVER mutated: the branch and worktree live under the DeepAgent data
 * root, and every physical operation against the parent repository is read-only except for the
 * managed worktree/branch themselves.
 */

import fs from "fs/promises"
import path from "path"
import { spawnSync } from "node:child_process"
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { Data, Effect } from "effect"
import type { Database } from "../database/database"
import { Global } from "../global"
import { Identifier } from "../id/id"
import type { LocationRef } from "../location/ref"
import { AbsolutePath } from "../schema"
import { Hash } from "../util/hash"
import { TaskRunEventTable, TaskRunTable } from "./sql"

type DatabaseService = Database.Interface["db"]
type Writer = Pick<DatabaseService, "select" | "insert" | "update">
type RunRow = typeof TaskRunTable.$inferSelect

export class WorkspaceError extends Data.TaggedError("TaskWorkspace.Error")<{
  readonly runID: string
  readonly code:
    | "run_not_found"
    | "not_isolated"
    | "preflight_failed"
    | "preflight_conflict"
    | "git_failed"
    | "not_terminal"
  readonly message: string
}> {}

/** The child-start fence refusal: a write-isolated run without a durable ready receipt. */
export class PreflightNotReady extends Data.TaggedError("TaskWorkspace.PreflightNotReady")<{
  readonly runID: string
  readonly preflightState: string
}> {}

export type WorkspaceReceipt = {
  readonly runID: string
  readonly repositoryRoot: string
  readonly baseCommit: string
  readonly parentBranch?: string
  readonly operationKey: string
  readonly branch: string
  readonly directory: string
  /** Human-readable derivation record (branch/directory layout) for UX/CLI consumers. */
  readonly derivation: string
}

export type ReleaseOutcome = {
  readonly runID: string
  readonly released: boolean
  readonly state: string
}

export type RetainOutcome = {
  readonly runID: string
  readonly retained: boolean
  readonly state: string
}

/** Terminal run states after which the workspace may be released. */
const TERMINAL_STATES = new Set(["completed", "failed", "error", "cancelled", "interrupted", "closed"])

// ── Deterministic derivation ──────────────────────────────────────────────────────────────────

export function derive(input: { readonly repositoryRoot: string; readonly operationKey: string }) {
  const name = `task-${Hash.sha256(input.operationKey).slice(0, 24)}`
  return {
    name,
    branch: `deepagent-code/${name}`,
    directory: path.join(
      Global.Path.data,
      "worktree",
      "durable",
      Hash.sha256(input.repositoryRoot).slice(0, 16),
      name,
    ),
  }
}

// ── Receipt row helpers ───────────────────────────────────────────────────────────────────────

const loadRunRow = (db: Writer, runID: string) =>
  db
    .select()
    .from(TaskRunTable)
    .where(eq(TaskRunTable.run_id, runID))
    .get()
    .pipe(Effect.orDie)

const requireIsolatedRun = (row: RunRow | undefined, runID: string) =>
  Effect.gen(function* () {
    if (!row || row.execution_runtime !== "v2")
      return yield* new WorkspaceError({
        runID,
        code: "run_not_found",
        message: `task_run ${runID} is not a Core V2 run`,
      })
    if (row.workspace_mode !== "worktree")
      return yield* new WorkspaceError({
        runID,
        code: "not_isolated",
        message: "workspace operation requires a write-isolated (worktree) run",
      })
    return row
  })

const receiptOf = (row: RunRow): WorkspaceReceipt => {
  const operationKey = row.workspace_operation_key ?? row.child_session_id
  return {
    runID: row.run_id,
    repositoryRoot: row.workspace_repository_root!,
    baseCommit: row.workspace_base_commit!,
    ...(row.workspace_parent_branch === null ? {} : { parentBranch: row.workspace_parent_branch }),
    operationKey,
    branch: row.worktree_branch!,
    directory: row.worktree_directory!,
    derivation: `branch deepagent-code/task-<sha256(operationKey).slice(0,24)>; directory <data root>/worktree/durable/<sha256(repositoryRoot).slice(0,16)>/task-<sha256(operationKey).slice(0,24)>`,
  }
}

// ── prepare: pending → ready, receipt strictly before child execution ─────────────────────────

/**
 * Provision (or, after any crash, ADOPT) the run-owned worktree and settle the durable preflight
 * receipt pending→ready. Fresh provisioning records a started marker (branch/worktree
 * `admitting` plus the frozen base commit) before the physical git work, so a retry after a
 * crash reuses the RECORDED base commit and the idempotent git ensure instead of drifting.
 * Git failures mark the preflight `failed` with the error code and never create a child session.
 */
export const prepare = Effect.fn("TaskWorkspace.prepare")(function* (
  db: DatabaseService,
  input: {
    readonly runID: string
    /** Parent checkout directory; the repository root is resolved from here (read-only). */
    readonly parentDirectory: string
    readonly now?: number
  },
) {
  const now = input.now ?? Date.now()
  const loaded = yield* loadRunRow(db, input.runID)
  const row = yield* requireIsolatedRun(loaded, input.runID)
  if (row.workspace_preflight_state === "ready") return yield* adoptReady(row)
  if (row.workspace_preflight_state === "failed")
    return yield* new WorkspaceError({
      runID: input.runID,
      code: "preflight_failed",
      message: `workspace preflight already failed for this run (${row.workspace_preflight_error_code ?? "unknown"})`,
    })

  const repository = yield* git(input.parentDirectory, ["rev-parse", "--show-toplevel"])
  if (repository.exitCode !== 0)
    return yield* failPreflight(db, row, "git_failed", `git rev-parse failed in ${input.parentDirectory}: ${text(repository.stderr)}`, now)
  const repositoryRoot = text(repository.stdout)
  const derived = derive({ repositoryRoot, operationKey: row.workspace_operation_key ?? row.child_session_id })
  // Canonicalize before the started marker: git registers worktrees by their real path, so the
  // receipt must record exactly that path (macOS /var → /private/var symlink resolution) for
  // adoption verification to match `git worktree list` entries.
  yield* Effect.promise(() => fs.mkdir(path.dirname(derived.directory), { recursive: true }))
  const parent = yield* Effect.promise(() => fs.realpath(path.dirname(derived.directory)))
  const directory = path.join(parent, path.basename(derived.directory))

  // Deterministic crash retry: a started marker froze the base commit; only a first attempt
  // reads the parent's HEAD. The parent branch is advisory provenance for later PR flows.
  const head =
    row.workspace_base_commit !== null
      ? { exitCode: 0, stdout: row.workspace_base_commit, stderr: "" }
      : yield* git(repositoryRoot, ["rev-parse", "HEAD"])
  if (head.exitCode !== 0 || text(head.stdout) === "")
    return yield* failPreflight(db, row, "git_failed", `git rev-parse HEAD failed in ${repositoryRoot}: ${text(head.stderr)}`, now)
  const baseCommit = text(head.stdout)
  const symbolic =
    row.workspace_parent_branch !== null
      ? { exitCode: 0, stdout: row.workspace_parent_branch, stderr: "" }
      : yield* git(repositoryRoot, ["symbolic-ref", "--short", "HEAD"])
  const parentBranch = symbolic.exitCode === 0 && text(symbolic.stdout) !== "" ? text(symbolic.stdout) : undefined

  if (row.state !== "admitted")
    return yield* new WorkspaceError({
      runID: input.runID,
      code: "preflight_conflict",
      message: `workspace prepare requires an admitted run; run is '${row.state}'`,
    })

  const plan = { ...derived, directory, repositoryRoot, baseCommit, parentBranch, now }
  yield* markStarted(db, row, plan)

  const ensured = yield* ensureWorktree({ repositoryRoot, baseCommit, ...derived, directory })
  if (!ensured.ok) return yield* failPreflight(db, row, ensured.code, ensured.message, now)

  return yield* markReady(db, row.run_id, plan)
})

// A ready receipt is adopted by re-verifying the physical workspace against itself; the receipt
// is the fence, so adoption does not depend on the run's lifecycle state.
const adoptReady = (row: RunRow) =>
  Effect.gen(function* () {
    if (
      !row.workspace_repository_root ||
      !row.workspace_base_commit ||
      !row.worktree_directory ||
      !row.worktree_branch
    )
      return yield* new WorkspaceError({
        runID: row.run_id,
        code: "preflight_conflict",
        message: "ready workspace receipt is missing its derivation columns",
      })
    const verified = yield* verifyWorktree({
      repositoryRoot: row.workspace_repository_root,
      directory: row.worktree_directory,
      branch: row.worktree_branch,
      baseCommit: row.workspace_base_commit,
    })
    if (verified.status === "conflict")
      return yield* new WorkspaceError({ runID: row.run_id, code: "preflight_conflict", message: verified.message })
    if (verified.status === "missing")
      return yield* new WorkspaceError({
        runID: row.run_id,
        code: "preflight_conflict",
        message: `worktree at ${row.worktree_directory} is no longer registered for a ready receipt`,
      })
    return receiptOf(row)
  })

const markStarted = (
  db: DatabaseService,
  row: RunRow,
  planned: {
    readonly name: string
    readonly branch: string
    readonly directory: string
    readonly repositoryRoot: string
    readonly baseCommit: string
    readonly parentBranch?: string
    readonly now: number
  },
) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const updated = yield* tx
          .update(TaskRunTable)
          .set({
            workspace_preflight_state: "pending",
            workspace_preflight_at: planned.now,
            workspace_repository_root: planned.repositoryRoot,
            workspace_base_commit: planned.baseCommit,
            workspace_parent_branch: planned.parentBranch ?? null,
            workspace_branch_state: "admitting",
            workspace_branch_started_at: planned.now,
            worktree_state: "admitting",
            worktree_started_at: planned.now,
            worktree_directory: planned.directory,
            worktree_branch: planned.branch,
            version: row.version + 1,
            time_updated: planned.now,
          })
          .where(
            and(
              eq(TaskRunTable.run_id, row.run_id),
              eq(TaskRunTable.version, row.version),
              eq(TaskRunTable.execution_runtime, "v2"),
              eq(TaskRunTable.state, "admitted"),
              eq(TaskRunTable.workspace_mode, "worktree"),
              isNull(TaskRunTable.execution_owner),
            ),
          )
          .returning({ version: TaskRunTable.version })
          .get()
          .pipe(Effect.orDie)
        // A lost CAS means a concurrent starter recorded the SAME deterministic plan; the
        // physical ensure and the ready CAS below stay idempotent, so continue either way.
        if (!updated) return
        yield* appendEvent(tx, {
          runID: row.run_id,
          version: updated.version,
          type: "workspace_preflight_started",
          reason: `${planned.branch}:${planned.directory}`,
          now: planned.now,
        })
      }),
    { behavior: "immediate" },
  )

const markReady = (
  db: DatabaseService,
  runID: string,
  planned: {
    readonly name: string
    readonly branch: string
    readonly directory: string
    readonly repositoryRoot: string
    readonly baseCommit: string
    readonly parentBranch?: string
    readonly now: number
  },
) =>
  db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const updated = yield* tx
          .update(TaskRunTable)
          .set({
            workspace_preflight_state: "ready",
            workspace_preflight_at: planned.now,
            workspace_preflight_error_code: null,
            workspace_repository_root: planned.repositoryRoot,
            workspace_base_commit: planned.baseCommit,
            workspace_parent_branch: planned.parentBranch ?? null,
            // Isolated runs target their own worktree branch; the parent checkout never moves.
            workspace_target_branch: planned.branch,
            workspace_branch_state: "ready",
            worktree_directory: planned.directory,
            worktree_branch: planned.branch,
            worktree_state: "ready",
            version: sql`${TaskRunTable.version} + 1`,
            time_updated: planned.now,
          })
          .where(
            and(
              eq(TaskRunTable.run_id, runID),
              eq(TaskRunTable.execution_runtime, "v2"),
              eq(TaskRunTable.state, "admitted"),
              eq(TaskRunTable.workspace_mode, "worktree"),
              eq(TaskRunTable.workspace_preflight_state, "pending"),
              isNull(TaskRunTable.execution_owner),
            ),
          )
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (updated) {
          yield* appendEvent(tx, {
            runID,
            version: updated.version,
            type: "workspace_preflight_ready",
            reason: `base=${planned.baseCommit} ${planned.branch}:${planned.directory}`,
            now: planned.now,
          })
          return receiptOf(updated)
        }
        // Lost the ready CAS: converge only on the same deterministic identity.
        const current = yield* loadRunRow(tx, runID)
        if (
          current?.workspace_preflight_state === "ready" &&
          current.worktree_directory === planned.directory &&
          current.worktree_branch === planned.branch &&
          current.workspace_base_commit === planned.baseCommit &&
          current.workspace_repository_root === planned.repositoryRoot
        )
          return receiptOf(current)
        return yield* new WorkspaceError({
          runID,
          code: "preflight_conflict",
          message: `workspace ready receipt lost its fence and diverged (${current?.workspace_preflight_state ?? "missing"})`,
        })
      }),
    { behavior: "immediate" },
  )

const failPreflight = (
  db: DatabaseService,
  row: RunRow,
  code: "git_failed" | "preflight_conflict",
  message: string,
  now: number,
) =>
  Effect.gen(function* () {
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              workspace_preflight_state: "failed",
              workspace_preflight_at: now,
              workspace_preflight_error_code: code,
              version: sql`${TaskRunTable.version} + 1`,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, row.run_id),
                eq(TaskRunTable.execution_runtime, "v2"),
                eq(TaskRunTable.state, "admitted"),
                isNull(TaskRunTable.execution_owner),
                or(
                  eq(TaskRunTable.workspace_preflight_state, "pending"),
                  eq(TaskRunTable.workspace_preflight_state, "legacy"),
                )!,
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return
          yield* appendEvent(tx, {
            runID: row.run_id,
            version: updated.version,
            type: "workspace_preflight_failed",
            reason: `${code}:${message}`,
            now,
          })
        }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
    return yield* new WorkspaceError({ runID: row.run_id, code, message })
  })

// ── The child-start fence ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the child session's Location for an admitted run. Shared runs keep the caller's
 * fallback (the parent Location); write-isolated runs REFUSE unless the durable preflight
 * receipt is `ready`, in which case the child is rooted at the recorded worktree directory —
 * that Location scoping (every Location-keyed service follows the session's directory) is what
 * keeps the child's tools inside the worktree instead of the parent checkout.
 */
export const childLocation = (
  db: DatabaseService,
  input: { readonly runID: string; readonly fallback: LocationRef.Ref },
) =>
  Effect.gen(function* () {
    const row = yield* loadRunRow(db, input.runID)
    if (!row) return yield* Effect.die(`task_run missing: ${input.runID}`)
    if (row.workspace_mode !== "worktree") return input.fallback
    if (row.workspace_preflight_state === "ready" && row.worktree_directory)
      return { directory: AbsolutePath.make(row.worktree_directory) } satisfies LocationRef.Ref
    return yield* new PreflightNotReady({
      runID: input.runID,
      preflightState: row.workspace_preflight_state,
    })
  })

/** First-input admission fence: write-isolated runs admit ONLY against a ready receipt. */
export const requireAdmissible = (db: DatabaseService, runID: string) =>
  Effect.gen(function* () {
    const row = yield* loadRunRow(db, runID)
    if (!row) return yield* Effect.die(`task_run missing: ${runID}`)
    if (row.workspace_mode !== "worktree") return
    if (row.workspace_preflight_state === "ready" && row.worktree_directory) return
    return yield* new PreflightNotReady({
      runID,
      preflightState: row.workspace_preflight_state,
    })
  })

// ── release: terminal-fenced worktree prune ───────────────────────────────────────────────────

/**
 * Prune the run-owned worktree. Fenced by durable run state: an in-flight run refuses (typed)
 * and only terminal states may release. Idempotent and crash-safe — an unregistered directory
 * prunes stale registration metadata and removes the remains. The worktree BRANCH is retained:
 * the child's commits stay reachable for the later PR/merge flow. Best-effort by contract —
 * callers treat a release failure as cleanup debt, never as a run failure.
 */
export const release = Effect.fn("TaskWorkspace.release")(function* (
  db: DatabaseService,
  input: { readonly runID: string; readonly now?: number },
) {
  const now = input.now ?? Date.now()
  const loaded = yield* loadRunRow(db, input.runID)
  const row = yield* requireIsolatedRun(loaded, input.runID)
  if (!TERMINAL_STATES.has(row.state))
    return yield* new WorkspaceError({
      runID: input.runID,
      code: "not_terminal",
      message: `workspace release refused: run '${row.state}' is in flight`,
    })
  if (row.worktree_state === "removed" || !row.worktree_directory || !row.workspace_repository_root)
    return { runID: row.run_id, released: row.worktree_state === "removed", state: row.state }

  const pruned = yield* pruneWorktree(row.workspace_repository_root, row.worktree_directory)
  if (!pruned.ok)
    return yield* new WorkspaceError({ runID: row.run_id, code: "git_failed", message: pruned.message })

  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const updated = yield* tx
          .update(TaskRunTable)
          .set({
            worktree_state: "removed",
            version: sql`${TaskRunTable.version} + 1`,
            time_updated: now,
          })
          .where(
            and(
              eq(TaskRunTable.run_id, row.run_id),
              eq(TaskRunTable.execution_runtime, "v2"),
              sql`${TaskRunTable.worktree_state} IS NOT 'removed'`,
            ),
          )
          .returning({ version: TaskRunTable.version })
          .get()
          .pipe(Effect.orDie)
        if (!updated) return
        yield* appendEvent(tx, {
          runID: row.run_id,
          version: updated.version,
          type: "worktree_released",
          reason: `${row.worktree_branch ?? ""}:${row.worktree_directory}`,
          now,
        })
      }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
  return { runID: row.run_id, released: true, state: row.state } satisfies ReleaseOutcome
})

// ── retain: terminal-fenced worktree keep (timeout/interrupt survival) ────────────────────────

/**
 * Mark the run-owned worktree RETAINED instead of pruning it: the directory and branch stay on
 * disk so the child session (rooted at the worktree directory) remains resumable by task_id, and
 * a later task_close / pr_finalize / explicit release owns the cleanup. Fenced by durable run
 * state exactly like {@link release} — an in-flight run refuses (typed). Idempotent: an already
 * retained (or already released/submitted) row converges without a second event. Best-effort by
 * contract — callers treat a retain failure as cleanup debt, never as a run failure.
 */
export const retain = Effect.fn("TaskWorkspace.retain")(function* (
  db: DatabaseService,
  input: { readonly runID: string; readonly now?: number },
) {
  const now = input.now ?? Date.now()
  const loaded = yield* loadRunRow(db, input.runID)
  const row = yield* requireIsolatedRun(loaded, input.runID)
  if (!TERMINAL_STATES.has(row.state))
    return yield* new WorkspaceError({
      runID: input.runID,
      code: "not_terminal",
      message: `workspace retain refused: run '${row.state}' is in flight`,
    })
  if (row.worktree_state !== "ready" && row.worktree_state !== "admitting" && row.worktree_state !== "conflict")
    return { runID: row.run_id, retained: row.worktree_state === "retained", state: row.worktree_state } satisfies RetainOutcome

  const updated = yield* db
    .update(TaskRunTable)
    .set({
      worktree_state: "retained",
      version: sql`${TaskRunTable.version} + 1`,
      time_updated: now,
    })
    .where(
      and(
        eq(TaskRunTable.run_id, row.run_id),
        eq(TaskRunTable.execution_runtime, "v2"),
        inArray(TaskRunTable.worktree_state, ["ready", "admitting", "conflict"]),
      ),
    )
    .returning({ version: TaskRunTable.version })
    .get()
    .pipe(Effect.orDie)
  if (updated)
    yield* appendEvent(db, {
      runID: row.run_id,
      version: updated.version,
      type: "worktree_retained",
      reason: `${row.worktree_branch ?? ""}:${row.worktree_directory ?? ""}`,
      now,
    })
  return { runID: row.run_id, retained: true, state: "retained" } satisfies RetainOutcome
})

// ── Physical git (spawned git; the parent repository is read-only here) ────────────────────────

type GitResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string }

// node:child_process is used (not Bun.spawnSync) because the desktop main process bundles this
// server code for Node; an unusable cwd or missing git surfaces as status null, which the
// caller folds into the one typed failure path.
const spawnOrNull = (cwd: string, args: readonly string[]) => {
  try {
    return spawnSync("git", args, { cwd, encoding: "buffer" })
  } catch {
    return undefined
  }
}

const git = (cwd: string, args: readonly string[]): Effect.Effect<GitResult> =>
  Effect.sync(() => {
    const proc = spawnOrNull(cwd, args)
    if (proc === undefined || proc.status === null)
      return { exitCode: -1, stdout: "", stderr: `git ${args[0]} could not run in ${cwd}` }
    return {
      exitCode: proc.status,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    }
  })

const text = (value: string) => value.trim()

const registeredWorktree = (
  repositoryRoot: string,
  directory: string,
): Effect.Effect<{ readonly branch?: string; readonly head: string } | undefined> =>
  Effect.gen(function* () {
    const list = yield* git(repositoryRoot, ["worktree", "list", "--porcelain"])
    if (list.exitCode !== 0) return undefined
    const found = parseWorktreeList(list.stdout).find((entry) => entry.directory === directory)
    if (found?.head === undefined) return undefined
    return { ...(found.branch === undefined ? {} : { branch: found.branch }), head: found.head }
  })

const parseWorktreeList = (porcelain: string) =>
  porcelain
    .split("\n\n")
    .map((block) => {
      const entry: { directory?: string; head?: string; branch?: string } = {}
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) entry.directory = text(line.slice("worktree ".length))
        if (line.startsWith("HEAD ")) entry.head = text(line.slice("HEAD ".length))
        if (line.startsWith("branch "))
          entry.branch = text(line.slice("branch ".length)).replace(/^refs\/heads\//, "")
      }
      return entry
    })
    .filter((entry) => entry.directory !== undefined)

type VerifyOutcome =
  | { readonly status: "adopted" }
  | { readonly status: "missing" }
  | { readonly status: "conflict"; readonly message: string }

const verifyWorktree = (input: {
  readonly repositoryRoot: string
  readonly directory: string
  readonly branch: string
  readonly baseCommit: string
}): Effect.Effect<VerifyOutcome> =>
  Effect.gen(function* () {
    const existing = yield* registeredWorktree(input.repositoryRoot, input.directory)
    if (existing === undefined) return { status: "missing" }
    if (existing.branch !== input.branch)
      return {
        status: "conflict",
        message: `worktree at ${input.directory} is on branch '${existing.branch ?? "detached"}', expected '${input.branch}'`,
      }
    if (existing.head !== input.baseCommit)
      return {
        status: "conflict",
        message: `worktree HEAD ${existing.head} does not match the recorded base ${input.baseCommit}`,
      }
    return { status: "adopted" }
  })

type EnsureFailure = { readonly ok: false; readonly code: "git_failed" | "preflight_conflict"; readonly message: string }
type EnsureOutcome = { readonly ok: true } | EnsureFailure

/**
 * Idempotent physical ensure (legacy `Worktree.ensureExact` semantics): adopt a registered
 * worktree with the exact branch+base; attach a pre-existing branch at the right commit; else
 * create branch and worktree at the recorded base commit. A losing race with a concurrent
 * creator re-checks the registration once and adopts, so two prepares converge on one worktree.
 */
const ensureWorktree = (input: {
  readonly repositoryRoot: string
  readonly baseCommit: string
  readonly name: string
  readonly branch: string
  readonly directory: string
}): Effect.Effect<EnsureOutcome> =>
  Effect.gen(function* () {
    const verified = yield* verifyWorktree(input)
    if (verified.status === "adopted") return { ok: true }
    if (verified.status === "conflict") return { ok: false, code: "preflight_conflict", message: verified.message }

    const branchRef = yield* git(input.repositoryRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${input.branch}`,
    ])
    if (branchRef.exitCode === 0) {
      const tip = yield* git(input.repositoryRoot, ["rev-parse", `refs/heads/${input.branch}`])
      if (tip.exitCode !== 0 || text(tip.stdout) !== input.baseCommit)
        return {
          ok: false,
          code: "preflight_conflict",
          message: `branch '${input.branch}' exists at ${text(tip.stdout) || "unknown"}, expected base ${input.baseCommit}`,
        }
      const added = yield* git(input.repositoryRoot, ["worktree", "add", input.directory, input.branch])
      return added.exitCode === 0 ? { ok: true } : yield* adoptAfterRace(input, `${text(added.stderr)} ${text(added.stdout)}`.trim())
    }

    yield* Effect.promise(() => fs.mkdir(path.dirname(input.directory), { recursive: true }))
    const created = yield* git(input.repositoryRoot, [
      "worktree",
      "add",
      "-b",
      input.branch,
      input.directory,
      input.baseCommit,
    ])
    return created.exitCode === 0
      ? { ok: true }
      : yield* adoptAfterRace(input, `${text(created.stderr)} ${text(created.stdout)}`.trim())
  })

// A concurrent creator may have registered the worktree between our list check and add; adopt
// the exact registration instead of failing.
const adoptAfterRace = (
  input: { readonly repositoryRoot: string; readonly branch: string; readonly directory: string; readonly baseCommit: string },
  stderr: string,
): Effect.Effect<EnsureOutcome> =>
  Effect.gen(function* () {
    const verified = yield* verifyWorktree(input)
    if (verified.status === "adopted") return { ok: true }
    return {
      ok: false,
      code: "git_failed",
      message: `git worktree add ${input.directory} failed: ${stderr || "unknown git error"}`,
    }
  })

const pruneWorktree = (repositoryRoot: string, directory: string): Effect.Effect<{ readonly ok: true } | { readonly ok: false; readonly message: string }> =>
  Effect.gen(function* () {
    const plain = yield* git(repositoryRoot, ["worktree", "remove", directory])
    if (plain.exitCode === 0) return { ok: true }
    // Dirty worktrees refuse a plain remove; the run is terminal, so force-prune remains.
    const forced = yield* git(repositoryRoot, ["worktree", "remove", "--force", directory])
    if (forced.exitCode === 0) return { ok: true }
    const registered = yield* registeredWorktree(repositoryRoot, directory)
    if (registered !== undefined)
      return {
        ok: false,
        message: `git worktree remove ${directory} failed: ${text(forced.stderr) || text(plain.stderr)}`,
      }
    // Crash window between remove and the removed receipt (or manual cleanup): drop stale
    // registration metadata and whatever remains of the directory. Only ever touches paths
    // inside the managed durable-worktree layout under the DeepAgent data root.
    yield* git(repositoryRoot, ["worktree", "prune"])
    if (isInside(path.join(Global.Path.data, "worktree", "durable"), directory))
      yield* Effect.promise(() => fs.rm(directory, { recursive: true, force: true }))
    return { ok: true }
  })

const isInside = (root: string, candidate: string) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

// ── Shared helpers ────────────────────────────────────────────────────────────────────────────

const appendEvent = (
  db: Writer,
  input: {
    readonly runID: string
    readonly version: number
    readonly type: string
    readonly reason: string
    readonly now: number
  },
) =>
  db
    .insert(TaskRunEventTable)
    .values({
      event_id: Identifier.ascending("event"),
      run_id: input.runID,
      version: input.version,
      type: input.type,
      from_state: "admitted",
      to_state: "admitted",
      reason: input.reason,
      time_created: input.now,
    })
    .run()
    .pipe(Effect.orDie)
