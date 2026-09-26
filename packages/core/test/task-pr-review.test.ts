import { projectLayer } from "./fixture/project-layer"
import { afterAll, describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { Location } from "@deepagent-code/core/location"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { TaskRunEventTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { TaskWorkspace } from "@deepagent-code/core/session/task-workspace"
import { TaskPRReview } from "@deepagent-code/core/session/task-pr-review"
import { SessionV2 } from "@deepagent-code/core/session"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { testEffect } from "./lib/effect"
import { tmpRoot, tmpRootShared } from "./fixture/tmpdir"

// Worklist #29 part 3 — the durable PR review state machine: terminal isolated runs with
// retained branches flow submit(review) → verdict → merge → cleanup as CAS transitions on the
// existing task_run PR columns (pr_operation_key / pr_started_at / pr_id + worktree_state),
// with plumbing-only git that never touches any working tree and fail-closed unknown outcomes.

const dataRoot = tmpRootShared()
const priorTestHome = process.env.DEEPAGENT_CODE_TEST_HOME
const priorDataHome = process.env.DEEPAGENT_CODE_HOME
process.env.DEEPAGENT_CODE_TEST_HOME = dataRoot
process.env.DEEPAGENT_CODE_HOME = dataRoot
afterAll(() => {
  if (priorTestHome === undefined) delete process.env.DEEPAGENT_CODE_TEST_HOME
  else process.env.DEEPAGENT_CODE_TEST_HOME = priorTestHome
  if (priorDataHome === undefined) delete process.env.DEEPAGENT_CODE_HOME
  else process.env.DEEPAGENT_CODE_HOME = priorDataHome
})

const stackOver = (database: Layer.Layer<Database.Service, unknown>) => {
  const events = EventV2.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const sessions = SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
    Layer.provide(projectLayer(database)),
    Layer.provide(SessionExecution.noopLayer),
  )
  return Layer.mergeAll(database, events, projector, sessions)
}

const it = testEffect(stackOver(Database.layerFromPath(":memory:")))

const services = Effect.gen(function* () {
  return {
    db: (yield* Database.Service).db,
    events: yield* EventV2.Service,
    sessions: yield* SessionV2.Service,
  }
})

// ── Real git fixtures ─────────────────────────────────────────────────────────────────────────

const gitIn = (cwd: string, args: string[]) =>
  Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })

const makeRepo = async (root: string) => {
  await fs.mkdir(root, { recursive: true })
  expectExit0(gitIn(root, ["init", "-b", "main"]), "git init")
  gitIn(root, ["config", "user.email", "test@deepagent.local"])
  gitIn(root, ["config", "user.name", "DeepAgent Test"])
  await fs.writeFile(path.join(root, "README.md"), "# fixture repo\n")
  expectExit0(gitIn(root, ["add", "-A"]), "git commit")
  expectExit0(gitIn(root, ["commit", "-m", "init"]), "git commit")
  return fs.realpath(root)
}

function expectExit0(proc: ReturnType<typeof gitIn>, what: string) {
  if (proc.exitCode !== 0) throw new Error(`${what} failed: ${proc.stderr.toString()}`)
}

const rev = (repo: string, ref: string) => gitIn(repo, ["rev-parse", ref]).stdout.toString().trim()
const branchExists = (repo: string, branch: string) =>
  gitIn(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0

const specFor = (parentSessionID: SessionSchema.ID, toolCallID: string, directory: string) => ({
  parentSessionID,
  parentMessageID: SessionMessage.ID.make(`msg_parent_${toolCallID}`),
  toolCallID,
  deliveryMode: "foreground" as const,
  prompt: new Prompt({ text: "Do the isolated work." }),
  agent: "general",
  child: {
    title: `task: ${toolCallID}`,
    location: { directory: AbsolutePath.make(directory) },
    permissions: [{ action: "edit", resource: "*", effect: "deny" as const }],
    workspace: { mode: "worktree" as const },
  },
})

type testDb = Database.Interface["db"]

const runRow = (db: testDb, runID: string) =>
  db
    .select()
    .from(TaskRunTable)
    .where(eq(TaskRunTable.run_id, runID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) => (row === undefined ? Effect.die(`task_run missing: ${runID}`) : Effect.succeed(row))),
    )

const eventsOf = (db: testDb, runID: string) =>
  db
    .select({ type: TaskRunEventTable.type, reason: TaskRunEventTable.reason })
    .from(TaskRunEventTable)
    .where(eq(TaskRunEventTable.run_id, runID))
    .all()
    .pipe(Effect.orDie)

/**
 * A completed, released isolated run whose retained branch carries one commit beyond the base —
 * the PR-review input state. The commit simulates the child's own committed work inside its
 * worktree (a write-capable child commits via its own tools before the terminal release).
 */
const settledRunWithCommit = (toolCallID: string, file: string, content: string) =>
  Effect.gen(function* () {
    const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
    const { db, events, sessions } = yield* services
    const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })
    const submitted = yield* TaskRunAuthority.submit(db, events, sessions, specFor(parent.id, toolCallID, repo))
    const row = yield* runRow(db, submitted.run.runID)
    // The child commits inside its worktree.
    yield* Effect.promise(() => fs.writeFile(path.join(row.worktree_directory!, file), content))
    expectExit0(gitIn(row.worktree_directory!, ["add", "-A"]), "worker add")
    expectExit0(gitIn(row.worktree_directory!, ["commit", "-m", `implement ${file}`]), "worker commit")
    const tip = rev(repo, `refs/heads/${row.worktree_branch}`)

    const claimed = yield* TaskRunAuthority.claim(db, {
      runID: submitted.run.runID,
      ownerToken: `owner-${toolCallID}`,
      leaseMs: 60_000,
      now: 1_000,
    })
    yield* TaskRunAuthority.settle(db, {
      runID: submitted.run.runID,
      ownerToken: `owner-${toolCallID}`,
      claimGeneration: claimed.claimGeneration,
      state: "completed",
      reason: "done",
      output: "implemented",
      now: 2_000,
    })
    yield* TaskWorkspace.release(db, { runID: submitted.run.runID })
    const settled = yield* runRow(db, submitted.run.runID)
    expect(settled.worktree_state).toBe("removed")
    return { repo, db, events, sessions, parent, run: settled, tip, base: settled.workspace_base_commit! }
  })

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────

describe("Core V2 TaskPRReview", () => {
  it.effect("eligible lists this parent's never-reviewed released isolated runs only", () =>
    Effect.gen(function* () {
      const settled = yield* settledRunWithCommit("call-pr-elig-2", "elig.txt", "eligible\n")
      const { db, events, sessions } = settled
      const isolated = yield* TaskRunAuthority.submit(
        db,
        events,
        sessions,
        specFor(settled.parent.id, "call-pr-elig-1", settled.repo),
      )

      const eligible = yield* TaskPRReview.eligible(db, { parentSessionID: settled.parent.id })
      // The in-flight isolated run (state 'admitted', worktree 'ready') is not review-eligible;
      // only the terminal released one is.
      expect(eligible.map((row) => row.run_id)).toEqual([settled.run.run_id])

      const otherParent = yield* sessions.create({ location: { directory: AbsolutePath.make(settled.repo) } })
      expect(yield* TaskPRReview.eligible(db, { parentSessionID: otherParent.id })).toEqual([])
      void isolated
    }),
  )

  it.effect("submitReview CAS: removed→submitted with the PR receipt; retries adopt; divergent keys conflict", () =>
    Effect.gen(function* () {
      const { db, repo, run, tip } = yield* settledRunWithCommit("call-pr-submit-1", "submit.txt", "submitted\n")
      const key = TaskPRReview.operationKey({ runID: run.run_id, tip })

      const first = yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 3_000 })
      expect(first.status).toBe("submitted")
      const row = yield* runRow(db, run.run_id)
      expect(row.worktree_state).toBe("submitted")
      expect(row.pr_operation_key).toBe(key)
      expect(row.pr_started_at).toBe(3_000)
      expect(row.pr_id).toBe(TaskPRReview.prID(key))
      expect((yield* eventsOf(db, run.run_id)).map((event) => event.type)).toContain("pr_review_submitted")

      // Crash retry: same key adopts without a second event or timestamp drift.
      const retry = yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 4_000 })
      expect(retry.status).toBe("adopted")
      const after = yield* runRow(db, run.run_id)
      expect(after.pr_started_at).toBe(3_000)
      expect((yield* eventsOf(db, run.run_id)).filter((event) => event.type === "pr_review_submitted")).toHaveLength(1)

      // A different key (divergent reviewed material) loses the CAS and fails closed.
      const conflict = yield* TaskPRReview.submitReview(db, {
        runID: run.run_id,
        key: TaskPRReview.operationKey({ runID: run.run_id, tip: rev(repo, "refs/heads/main") }),
        now: 5_000,
      }).pipe(Effect.flip)
      expect(conflict).toMatchObject({ _tag: "TaskPRReview.Error", code: "pr_conflict" })
      expect((yield* runRow(db, run.run_id)).pr_operation_key).toBe(key)
    }),
  )

  it.effect("merge leaves the parent checkout untouched during review, then lands atomically; cleanup deletes the branch", () =>
    Effect.gen(function* () {
      const { db, repo, run, tip } = yield* settledRunWithCommit("call-pr-merge-1", "merged.txt", "merged content\n")
      const key = TaskPRReview.operationKey({ runID: run.run_id, tip })
      yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 3_000 })

      // DURING the review the parent checkout is untouched: same HEAD, same files, clean tree.
      const parentBefore = rev(repo, "refs/heads/main")
      const checkoutFilesBefore = yield* Effect.promise(() => fs.readdir(repo))
      expect(rev(repo, "HEAD")).toBe(parentBefore)
      expect(yield* Effect.promise(() => fs.readdir(repo))).toEqual(checkoutFilesBefore)
      expect(gitIn(repo, ["status", "--porcelain"]).stdout.toString().trim()).toBe("")

      const merged = yield* TaskPRReview.merge(db, { runID: run.run_id, key, now: 4_000 })
      expect(merged.mode).toBe("fast_forward")
      expect(rev(repo, "refs/heads/main")).toBe(tip)
      // The merge itself lands in the checked-out parent branch atomically: the file is on disk
      // and the checkout settles clean (no phantom staged deletion from a ref-only move).
      expect(yield* Effect.promise(() => fs.readFile(path.join(repo, "merged.txt"), "utf8"))).toBe("merged content\n")
      expect(gitIn(repo, ["status", "--porcelain"]).stdout.toString().trim()).toBe("")
      expect((yield* eventsOf(db, run.run_id)).map((event) => event.type)).toContain("pr_merged")

      const cleaned = yield* TaskPRReview.cleanup(db, { runID: run.run_id, key, now: 5_000 })
      expect(cleaned.status).toBe("merged")
      const row = yield* runRow(db, run.run_id)
      expect(row.worktree_state).toBe("removed")
      expect(row.pr_operation_key).toBe(key)
      expect(branchExists(repo, row.worktree_branch!)).toBe(false)
    }),
  )

  it.effect("merge produces a merge commit when the parent advanced; the tree carries both changes", () =>
    Effect.gen(function* () {
      const { db, repo, run, tip } = yield* settledRunWithCommit("call-pr-merge-2", "feature.txt", "feature\n")
      // The parent advances past the worktree base while the review ran.
      yield* Effect.promise(() => fs.writeFile(path.join(repo, "parent.txt"), "parent advanced\n"))
      expectExit0(gitIn(repo, ["add", "-A"]), "parent add")
      expectExit0(gitIn(repo, ["commit", "-m", "parent advances"]), "parent commit")
      const parentTip = rev(repo, "refs/heads/main")

      const key = TaskPRReview.operationKey({ runID: run.run_id, tip })
      yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 3_000 })
      const merged = yield* TaskPRReview.merge(db, { runID: run.run_id, key, now: 4_000 })
      expect(merged.mode).toBe("merge_commit")
      const newTip = rev(repo, "refs/heads/main")
      expect(newTip).not.toBe(parentTip)
      expect(newTip).not.toBe(tip)
      const parents = gitIn(repo, ["log", "--format=%P", "-1", newTip]).stdout.toString().trim().split(/\s+/)
      expect(parents.sort()).toEqual([parentTip, tip].sort())
      expect(gitIn(repo, ["show", `${newTip}:feature.txt`]).stdout.toString()).toBe("feature\n")
      expect(gitIn(repo, ["show", `${newTip}:parent.txt`]).stdout.toString()).toBe("parent advanced\n")
      // The in-checkout merge lands both sides on disk and settles the checkout clean.
      expect(yield* Effect.promise(() => fs.readFile(path.join(repo, "feature.txt"), "utf8"))).toBe("feature\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(repo, "parent.txt"), "utf8"))).toBe(
        "parent advanced\n",
      )
      expect(gitIn(repo, ["status", "--porcelain"]).stdout.toString().trim()).toBe("")
    }),
  )

  it.effect("a conflicting parent fails the merge closed: no ref movement, run stays submitted", () =>
    Effect.gen(function* () {
      const { db, repo, run, tip } = yield* settledRunWithCommit("call-pr-conflict-1", "clash.txt", "worker version\n")
      yield* Effect.promise(() => fs.writeFile(path.join(repo, "clash.txt"), "parent version\n"))
      expectExit0(gitIn(repo, ["add", "-A"]), "parent add")
      expectExit0(gitIn(repo, ["commit", "-m", "parent diverges"]), "parent commit")
      const parentTip = rev(repo, "refs/heads/main")

      const key = TaskPRReview.operationKey({ runID: run.run_id, tip })
      yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 3_000 })
      const conflict = yield* TaskPRReview.merge(db, { runID: run.run_id, key, now: 4_000 }).pipe(Effect.flip)
      expect(conflict).toMatchObject({ _tag: "TaskPRReview.Error", code: "merge_conflict" })
      expect(rev(repo, "refs/heads/main")).toBe(parentTip)
      expect((yield* runRow(db, run.run_id)).worktree_state).toBe("submitted")
      expect(branchExists(repo, run.worktree_branch!)).toBe(true)
    }),
  )

  it.effect("changes_requested retains the branch and never moves the parent branch", () =>
    Effect.gen(function* () {
      const { db, repo, run, tip } = yield* settledRunWithCommit("call-pr-retain-1", "retained.txt", "retained\n")
      const parentBefore = rev(repo, "refs/heads/main")
      const key = TaskPRReview.operationKey({ runID: run.run_id, tip })
      yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 3_000 })

      const retained = yield* TaskPRReview.retain(db, {
        runID: run.run_id,
        key,
        verdict: "changes_requested",
        rationale: "Known bad value",
        now: 4_000,
      })
      expect(retained.status).toBe("retained")
      const row = yield* runRow(db, run.run_id)
      expect(row.worktree_state).toBe("retained")
      expect(rev(repo, "refs/heads/main")).toBe(parentBefore)
      expect(branchExists(repo, row.worktree_branch!)).toBe(true)
      expect((yield* eventsOf(db, run.run_id)).map((event) => event.type)).toContain("pr_changes_requested")

      // Re-submitting the SAME reviewed tip converges on the recorded decision, not a new cycle.
      const converged = yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 5_000 })
      expect(converged.status).toBe("decided")
    }),
  )

  it.effect("crash between merge and cleanup converges on retry: adopt the merge, prune the branch once", () =>
    Effect.gen(function* () {
      const { db, repo, run, tip } = yield* settledRunWithCommit("call-pr-crash-1", "crash.txt", "crash proof\n")
      const key = TaskPRReview.operationKey({ runID: run.run_id, tip })
      yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 3_000 })

      // Crash window: the physical merge landed, the cleanup CAS did not.
      const first = yield* TaskPRReview.merge(db, { runID: run.run_id, key, now: 4_000 })
      expect(first.mode).toBe("fast_forward")
      expect((yield* runRow(db, run.run_id)).worktree_state).toBe("submitted")

      // Retry from the tool: merge is adopted (already merged), cleanup converges exactly once.
      const again = yield* TaskPRReview.merge(db, { runID: run.run_id, key, now: 5_000 })
      expect(again.mode).toBe("already_merged")
      const cleaned = yield* TaskPRReview.cleanup(db, { runID: run.run_id, key, now: 6_000 })
      expect(cleaned.status).toBe("merged")
      const row = yield* runRow(db, run.run_id)
      expect(row.worktree_state).toBe("removed")
      expect(branchExists(repo, row.worktree_branch!)).toBe(false)
      expect(rev(repo, "refs/heads/main")).toBe(tip)
      expect(
        (yield* eventsOf(db, run.run_id)).filter((event) => event.type === "pr_merged"),
      ).toHaveLength(1)
    }),
  )

  it.effect("a completed merged cycle converges: submitReview reports merged without re-merging", () =>
    Effect.gen(function* () {
      const { db, repo, run, tip } = yield* settledRunWithCommit("call-pr-done-1", "done.txt", "done\n")
      const key = TaskPRReview.operationKey({ runID: run.run_id, tip })
      yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 3_000 })
      yield* TaskPRReview.merge(db, { runID: run.run_id, key, now: 4_000 })
      yield* TaskPRReview.cleanup(db, { runID: run.run_id, key, now: 5_000 })
      const mainBefore = rev(repo, "refs/heads/main")

      const converged = yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 6_000 })
      expect(converged.status).toBe("merged")
      expect(rev(repo, "refs/heads/main")).toBe(mainBefore)
    }),
  )

  it.effect("undoMerge restores the recorded parent tip and checkout once, with a durable audit receipt", () =>
    Effect.gen(function* () {
      const { db, repo, run, tip, base } = yield* settledRunWithCommit("call-pr-undo-1", "undo.txt", "undo me\n")
      const key = TaskPRReview.operationKey({ runID: run.run_id, tip })
      yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 3_000 })
      yield* TaskPRReview.merge(db, { runID: run.run_id, key, now: 4_000 })
      yield* TaskPRReview.cleanup(db, { runID: run.run_id, key, now: 5_000 })

      const undone = yield* TaskPRReview.undoMerge(db, { runID: run.run_id, key, undoKey: "user-undo-1", now: 6_000 })
      expect(undone).toMatchObject({ status: "undone", before: base })
      expect(rev(repo, "refs/heads/main")).toBe(base)
      expect(yield* Effect.promise(() => Bun.file(path.join(repo, "undo.txt")).exists())).toBe(false)
      expect(gitIn(repo, ["status", "--porcelain"]).stdout.toString().trim()).toBe("")
      const audit = (yield* eventsOf(db, run.run_id)).filter((event) => event.type === "pr_merge_undone")
      expect(audit).toHaveLength(1)
      expect(audit[0]?.reason).toContain("user-undo-1")
      expect((yield* TaskPRReview.submitReview(db, { runID: run.run_id, key })).status).toBe("undone")

      expect((yield* TaskPRReview.undoMerge(db, { runID: run.run_id, key, undoKey: "user-undo-1" })).status).toBe("undone")
      expect((yield* eventsOf(db, run.run_id)).filter((event) => event.type === "pr_merge_undone")).toHaveLength(1)
      const conflict = yield* TaskPRReview.undoMerge(db, { runID: run.run_id, key, undoKey: "another-key" }).pipe(Effect.flip)
      expect(conflict).toMatchObject({ code: "undo_conflict" })
    }),
  )

  it.effect("undoMerge refuses a dirty checkout and a parent that advanced after the merge", () =>
    Effect.gen(function* () {
      const { db, repo, run, tip } = yield* settledRunWithCommit("call-pr-undo-2", "undo-guard.txt", "worker\n")
      const key = TaskPRReview.operationKey({ runID: run.run_id, tip })
      yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 3_000 })
      yield* TaskPRReview.merge(db, { runID: run.run_id, key, now: 4_000 })
      yield* TaskPRReview.cleanup(db, { runID: run.run_id, key, now: 5_000 })
      yield* Effect.promise(() => fs.writeFile(path.join(repo, "dirty.txt"), "keep me\n"))
      const dirty = yield* TaskPRReview.undoMerge(db, { runID: run.run_id, key, undoKey: "guard-undo" }).pipe(Effect.flip)
      expect(dirty).toMatchObject({ code: "undo_conflict" })
      expect(rev(repo, "refs/heads/main")).toBe(tip)
      expect((yield* eventsOf(db, run.run_id)).filter((event) => event.type === "pr_merge_undone")).toHaveLength(0)

      expectExit0(gitIn(repo, ["add", "-A"]), "add subsequent work")
      expectExit0(gitIn(repo, ["commit", "-m", "work after merge"]), "commit subsequent work")
      const advanced = rev(repo, "refs/heads/main")
      const stale = yield* TaskPRReview.undoMerge(db, { runID: run.run_id, key, undoKey: "guard-undo" }).pipe(Effect.flip)
      expect(stale).toMatchObject({ code: "undo_conflict" })
      expect(rev(repo, "refs/heads/main")).toBe(advanced)
    }),
  )

  it.effect("undoMerge uses the before/after receipt for an unchecked merge-commit ref", () =>
    Effect.gen(function* () {
      const { db, repo, run, tip } = yield* settledRunWithCommit("call-pr-undo-3", "feature-undo.txt", "feature\n")
      yield* Effect.promise(() => fs.writeFile(path.join(repo, "parent-undo.txt"), "parent\n"))
      expectExit0(gitIn(repo, ["add", "-A"]), "parent add")
      expectExit0(gitIn(repo, ["commit", "-m", "parent advances"]), "parent commit")
      const before = rev(repo, "refs/heads/main")
      const key = TaskPRReview.operationKey({ runID: run.run_id, tip })
      yield* TaskPRReview.submitReview(db, { runID: run.run_id, key, now: 3_000 })
      expect((yield* TaskPRReview.merge(db, { runID: run.run_id, key, now: 4_000 })).mode).toBe("merge_commit")
      yield* TaskPRReview.cleanup(db, { runID: run.run_id, key, now: 5_000 })
      const after = rev(repo, "refs/heads/main")
      expectExit0(gitIn(repo, ["checkout", "-b", "other"]), "leave parent branch unchecked")

      yield* TaskPRReview.undoMerge(db, { runID: run.run_id, key, undoKey: "uncheckout-undo" })
      expect(rev(repo, "refs/heads/main")).toBe(before)
      expect(rev(repo, "HEAD")).toBe(after)
      expect(gitIn(repo, ["status", "--porcelain"]).stdout.toString().trim()).toBe("")
      expect((yield* eventsOf(db, run.run_id)).filter((event) => event.type === "pr_merge_undone")).toHaveLength(1)
    }),
  )

  it.effect("submitReview refuses non-isolated and in-flight runs (fail closed)", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => makeRepo(path.join(tmpRoot(), "repo")))
      const { db, events, sessions } = yield* services
      const parent = yield* sessions.create({ location: { directory: AbsolutePath.make(repo) } })
      const shared = yield* TaskRunAuthority.submit(db, events, sessions, {
        ...specFor(parent.id, "call-pr-refuse-shared", repo),
        child: {
          title: "shared",
          location: { directory: AbsolutePath.make(repo) },
          permissions: [{ action: "edit", resource: "*", effect: "deny" as const }],
        },
      })
      const key = TaskPRReview.operationKey({ runID: shared.run.runID, tip: rev(repo, "HEAD") })
      const notIsolated = yield* TaskPRReview.submitReview(db, { runID: shared.run.runID, key, now: 1_000 }).pipe(
        Effect.flip,
      )
      expect(notIsolated).toMatchObject({ _tag: "TaskPRReview.Error", code: "not_isolated" })

      const isolated = yield* TaskRunAuthority.submit(
        db,
        events,
        sessions,
        specFor(parent.id, "call-pr-refuse-live", repo),
      )
      const inFlight = yield* TaskPRReview.submitReview(db, {
        runID: isolated.run.runID,
        key: TaskPRReview.operationKey({ runID: isolated.run.runID, tip: rev(repo, "HEAD") }),
        now: 1_000,
      }).pipe(Effect.flip)
      expect(inFlight).toMatchObject({ _tag: "TaskPRReview.Error", code: "not_reviewable" })
    }),
  )
})
