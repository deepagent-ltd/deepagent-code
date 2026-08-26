import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Cause, Effect, Exit } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionTable, TaskRunEventTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { Git } from "@/git"
import { SessionID, MessageID } from "@/session/schema"
import { TaskWorktree, TaskWorktreeError } from "@/session/task-worktree"
import { Worktree } from "@/worktree"
import { testEffect } from "../lib/effect"

// §L3c task-worktree receipts (src/session/task-worktree.ts): durable run-owned worktree adoption
// against a REAL in-memory DB with FAKE git/flock/worktree inputs (the run's receipt rows are the only
// state that matters). Closes the known test gaps:
//   1. worktree_conflict — reuseExact / ensureExact rejection branches (typed TaskWorktreeError).
//   2. worktree_outcome_unknown — requireRecovery({ code: "worktree_outcome_unknown" }) persists
//      recovery_required when the workspace probe / worktree layer cannot be proven.
//   3. markReady CAS — a lost version fence (row mutated between start and ready) fails the update
//      and surfaces worktree_outcome_unknown WITHOUT flipping the run to recovery.

const it = testEffect(Database.layerFromPath(":memory:"))

const parentSessionID = SessionID.make("ses_task_worktree_parent")
const childA = SessionID.make("ses_task_worktree_child_a")
const childB = SessionID.make("ses_task_worktree_child_b")
const childC = SessionID.make("ses_task_worktree_child_c")
const repositoryRoot = "/repo/task-worktree"
const now = 5_000

// ── fixtures ──────────────────────────────────────────────────────────────────

const seedParent = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: parentSessionID,
      project_id: ProjectV2.ID.global,
      slug: "task-worktree-parent",
      directory: "/project",
      title: "task-worktree",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

type TaskState =
  | "admitted"
  | "provisioning"
  | "researching"
  | "finalizing"
  | "completed"
  | "error"
  | "cancelled"
  | "interrupted"
  | "queued"
  | "running"
  | "failed"
  | "closed"
  | "recovery_required"

type WorktreeState = "none" | "admitting" | "ready" | "conflict" | "retained" | "submitted" | "removed"

const insertRun = (input: {
  runID: string
  childSessionID: SessionID
  state?: TaskState
  workspaceMode?: "worktree" | "shared"
  operationKey?: string | null
  continuationOfRunID?: string | null
  generation?: number
  worktreeState?: WorktreeState
  worktreeDirectory?: string | null
  worktreeBranch?: string | null
  repositoryRoot?: string | null
  baseCommit?: string | null
  executionOwner?: string | null
  version?: number
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(TaskRunTable)
      .values({
        run_id: input.runID,
        request_hash: `request-${input.runID}`,
        parent_session_id: parentSessionID,
        parent_message_id: MessageID.make(`msg_task_worktree_${input.runID}`),
        tool_call_id: `call_${input.runID}`,
        child_session_id: input.childSessionID,
        generation: input.generation ?? 1,
        delivery_mode: "foreground",
        phase: "admission",
        state: input.state ?? "admitted",
        version: input.version ?? 0,
        workspace_mode: input.workspaceMode ?? "worktree",
        workspace_operation_key: input.operationKey ?? null,
        continuation_of_run_id: input.continuationOfRunID ?? null,
        workspace_repository_root: input.repositoryRoot ?? null,
        workspace_base_commit: input.baseCommit ?? null,
        worktree_state: input.worktreeState ?? "none",
        worktree_directory: input.worktreeDirectory ?? null,
        worktree_branch: input.worktreeBranch ?? null,
        execution_owner: input.executionOwner ?? null,
        time_created: 1_000,
        time_updated: 1_000,
      })
      .run()
      .pipe(Effect.orDie)
  })

const getRun = (runID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.run_id, runID)).get().pipe(Effect.orDie)
    if (!row) return yield* Effect.die(new Error(`task_run ${runID} missing`))
    return row
  })

const getEvents = (runID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.select().from(TaskRunEventTable).where(eq(TaskRunEventTable.run_id, runID)).all().pipe(Effect.orDie)
  })

const failureOf = <A>(exit: Exit.Exit<A, unknown>): TaskWorktreeError => {
  if (Exit.isSuccess(exit)) throw new Error(`expected Failure, got Success(${JSON.stringify(exit.value)})`)
  const error = Cause.squash(exit.cause)
  expect(error).toBeInstanceOf(TaskWorktreeError)
  return error as TaskWorktreeError
}

// ── fake inputs (git / flock / worktree never touch the real repo) ──────────

const gitResult = (text: string): Git.Result => ({
  exitCode: 0,
  text: () => text,
  stdout: Buffer.from(text),
  stderr: Buffer.alloc(0),
  truncated: false,
})

const fakeGit = (input: { branch: string; commonDir?: string }): Git.Interface =>
  ({
    run: () => Effect.succeed(gitResult(`${input.commonDir ?? "/common/git"}
`)),
    branch: () => Effect.succeed(input.branch),
  }) as unknown as Git.Interface

const passthroughFlock = {
  acquire: () => Effect.void,
  withLock: (body: Effect.Effect<unknown, unknown, unknown>) => body,
} as unknown as EffectFlock.Interface

const failingFlock = {
  acquire: () => Effect.void,
  withLock: () => Effect.fail(new Error("flock exploded")),
} as unknown as EffectFlock.Interface

// Mutates the run row between markStarted and markReady — the CAS must then lose its fence.
const stealingFlock = (runID: string): EffectFlock.Interface =>
  ({
    acquire: () => Effect.void,
    withLock: (body: Effect.Effect<unknown, unknown, unknown>) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .update(TaskRunTable)
          .set({ execution_owner: "sneaky-owner" })
          .where(eq(TaskRunTable.run_id, runID))
          .run()
          .pipe(Effect.orDie)
        return yield* body
      }),
  }) as unknown as EffectFlock.Interface

const fakeWorktree = (input: { result?: Worktree.Info; error?: Worktree.WorktreeExactConflictError | Error }): Worktree.Interface =>
  ({
    ensureExact: () =>
      input.error
        ? Effect.fail(input.error)
        : Effect.succeed(input.result ?? { name: "task-x", branch: "deepagent-code/task-x", directory: "/wt/child" }),
  }) as unknown as Worktree.Interface

// ── tests ────────────────────────────────────────────────────────────────────

describe("task-worktree (durable run worktree receipts)", () => {
  it.effect("reuseExact → worktree_conflict when the run is not eligible to reuse a child worktree", () =>
    Effect.gen(function* () {
      yield* seedParent
      // state is NOT admitted → the reuse eligibility gate fails.
      yield* insertRun({ runID: "run-ineligible", childSessionID: childA, state: "provisioning" })

      const exit = yield* TaskWorktree.reuseExact({
        runID: "run-ineligible",
        childSessionID: childA,
        childDirectory: "/wt/child",
        repositoryRoot,
        git: fakeGit({ branch: "agent/expected" }),
        flock: passthroughFlock,
        now,
      }).pipe(Effect.exit)

      const error = failureOf(exit)
      expect(error.code).toBe("worktree_conflict")
      expect(error.message).toContain("not eligible")

      // rejection is side-effect free: no state change, no version bump, no events
      const row = yield* getRun("run-ineligible")
      expect(row.state).toBe("provisioning")
      expect(row.version).toBe(0)
      expect((yield* getEvents("run-ineligible")).length).toBe(0)
    }))

  it.effect("reuseExact → worktree_conflict when the predecessor receipt cannot prove continuity", () =>
    Effect.gen(function* () {
      yield* seedParent
      // predecessor exists but its worktree_state is NOT ready/retained/submitted;
      // it is a completed earlier generation of the SAME child session
      yield* insertRun({
        runID: "run-pred",
        childSessionID: childA,
        generation: 1,
        state: "completed",
        operationKey: childA,
        worktreeState: "none",
        repositoryRoot,
      })
      yield* insertRun({
        runID: "run-current",
        childSessionID: childA,
        generation: 2,
        operationKey: childA,
        continuationOfRunID: "run-pred",
        worktreeState: "none",
      })

      const exit = yield* TaskWorktree.reuseExact({
        runID: "run-current",
        childSessionID: childA,
        childDirectory: "/wt/child",
        repositoryRoot,
        git: fakeGit({ branch: "agent/expected" }),
        flock: passthroughFlock,
        now,
      }).pipe(Effect.exit)

      const error = failureOf(exit)
      expect(error.code).toBe("worktree_conflict")
      expect(error.message).toContain("Predecessor receipt")

      const row = yield* getRun("run-current")
      expect(row.state).toBe("admitted")
      expect(row.version).toBe(0)
      expect((yield* getEvents("run-current")).length).toBe(0)
    }))

  it.effect("reuseExact → worktree_outcome_unknown and persists recovery_required when the workspace probe fails", () =>
    Effect.gen(function* () {
      yield* seedParent
      yield* insertRun({
        runID: "run-pred",
        childSessionID: childA,
        generation: 1,
        state: "completed",
        operationKey: childA,
        worktreeState: "ready",
        worktreeDirectory: "/wt/child",
        worktreeBranch: "agent/expected",
        repositoryRoot,
      })
      yield* insertRun({
        runID: "run-current",
        childSessionID: childA,
        generation: 2,
        operationKey: childA,
        continuationOfRunID: "run-pred",
        worktreeState: "none",
      })

      const exit = yield* TaskWorktree.reuseExact({
        runID: "run-current",
        childSessionID: childA,
        childDirectory: "/wt/child",
        repositoryRoot,
        git: fakeGit({ branch: "agent/expected" }),
        flock: failingFlock,
        now,
      }).pipe(Effect.exit)

      const error = failureOf(exit)
      expect(error.code).toBe("worktree_outcome_unknown")
      expect(error.message).toContain("flock exploded")

      // markStarted advanced the fence once; requireRecovery moved the run to recovery_required
      const row = yield* getRun("run-current")
      expect(row.state).toBe("recovery_required")
      expect(row.reason).toBe("worktree_outcome_unknown")
      expect(row.worktree_state).toBe("conflict")
      expect(row.error).toEqual({ code: "worktree_outcome_unknown", message: "Error: flock exploded" })
      expect(row.version).toBe(2)

      const events = yield* getEvents("run-current")
      expect(events.map((event) => event.type).sort()).toEqual(["recovery_required", "worktree_started"])
      const recovery = events.find((event) => event.type === "recovery_required")
      expect(recovery?.from_state).toBe("admitted")
      expect(recovery?.to_state).toBe("recovery_required")
      expect(recovery?.reason).toContain("worktree_outcome_unknown")
    }))

  it.effect("reuseExact → worktree_conflict and persists recovery_required when the observed worktree no longer matches the receipt", () =>
    Effect.gen(function* () {
      yield* seedParent
      yield* insertRun({
        runID: "run-pred",
        childSessionID: childA,
        generation: 1,
        state: "completed",
        operationKey: childA,
        worktreeState: "ready",
        worktreeDirectory: "/wt/child",
        worktreeBranch: "agent/expected",
        repositoryRoot,
      })
      yield* insertRun({
        runID: "run-current",
        childSessionID: childA,
        generation: 2,
        operationKey: childA,
        continuationOfRunID: "run-pred",
        worktreeState: "none",
      })

      // probe succeeds but the observed branch differs from the receipt
      const exit = yield* TaskWorktree.reuseExact({
        runID: "run-current",
        childSessionID: childA,
        childDirectory: "/wt/child",
        repositoryRoot,
        git: fakeGit({ branch: "agent/other" }),
        flock: passthroughFlock,
        now,
      }).pipe(Effect.exit)

      const error = failureOf(exit)
      expect(error.code).toBe("worktree_conflict")
      expect(error.message).toContain("no longer matches")

      const row = yield* getRun("run-current")
      expect(row.state).toBe("recovery_required")
      expect(row.reason).toBe("worktree_conflict")
      expect(row.worktree_state).toBe("conflict")
      expect(row.error?.code).toBe("worktree_conflict")
      expect((yield* getEvents("run-current")).some((event) => event.type === "recovery_required")).toBe(true)
    }))

  it.effect("ensureExact classifies conflicts vs unknown failures and persists recovery_required", () =>
    Effect.gen(function* () {
      yield* seedParent

      // (a) frozen-base mismatch → worktree_conflict, side-effect free
      yield* insertRun({ runID: "run-base", childSessionID: childA, operationKey: childA, baseCommit: "base-abc", worktreeState: "none" })
      const exitA = yield* TaskWorktree.ensureExact({
        runID: "run-base",
        repositoryRoot,
        baseCommit: "base-xyz",
        worktree: fakeWorktree({}),
        flock: passthroughFlock,
        now,
      }).pipe(Effect.exit)
      const errorA = failureOf(exitA)
      expect(errorA.code).toBe("worktree_conflict")
      expect(errorA.message).toContain("Frozen base")
      const rowA = yield* getRun("run-base")
      expect(rowA.state).toBe("admitted")
      expect(rowA.version).toBe(0)
      expect((yield* getEvents("run-base")).length).toBe(0)

      // (b) WorktreeExactConflictError → classified worktree_conflict + recovery_required
      yield* insertRun({
        runID: "run-exact-conflict",
        childSessionID: childB,
        operationKey: childB,
        baseCommit: "base-abc",
        worktreeState: "none",
      })
      const exitB = yield* TaskWorktree.ensureExact({
        runID: "run-exact-conflict",
        repositoryRoot,
        baseCommit: "base-abc",
        worktree: fakeWorktree({
          error: new Worktree.WorktreeExactConflictError({ operationKey: childB, reason: "existing worktree HEAD mismatch" }),
        }),
        flock: passthroughFlock,
        now,
      }).pipe(Effect.exit)
      const errorB = failureOf(exitB)
      expect(errorB.code).toBe("worktree_conflict")
      const rowB = yield* getRun("run-exact-conflict")
      expect(rowB.state).toBe("recovery_required")
      expect(rowB.reason).toBe("worktree_conflict")
      expect(rowB.worktree_state).toBe("conflict")
      expect((yield* getEvents("run-exact-conflict")).some((event) => event.type === "recovery_required")).toBe(true)

      // (c) non-conflict worktree failure → worktree_outcome_unknown + recovery_required
      yield* insertRun({
        runID: "run-unknown",
        childSessionID: childC,
        operationKey: childC,
        baseCommit: "base-abc",
        worktreeState: "none",
      })
      const exitC = yield* TaskWorktree.ensureExact({
        runID: "run-unknown",
        repositoryRoot,
        baseCommit: "base-abc",
        worktree: fakeWorktree({ error: new Error("ensureExact exploded") }),
        flock: passthroughFlock,
        now,
      }).pipe(Effect.exit)
      const errorC = failureOf(exitC)
      expect(errorC.code).toBe("worktree_outcome_unknown")
      expect(errorC.message).toContain("ensureExact exploded")
      const rowC = yield* getRun("run-unknown")
      expect(rowC.state).toBe("recovery_required")
      expect(rowC.reason).toBe("worktree_outcome_unknown")
      expect(rowC.worktree_state).toBe("conflict")
      expect(rowC.error).toEqual({ code: "worktree_outcome_unknown", message: "ensureExact exploded" })
      expect((yield* getEvents("run-unknown")).some((event) => event.type === "recovery_required")).toBe(true)
    }))

  it.effect("markReady → worktree_outcome_unknown when the version fence is lost between start and ready", () =>
    Effect.gen(function* () {
      yield* seedParent
      yield* insertRun({
        runID: "run-pred",
        childSessionID: childA,
        generation: 1,
        state: "completed",
        operationKey: childA,
        worktreeState: "ready",
        worktreeDirectory: "/wt/child",
        worktreeBranch: "agent/expected",
        repositoryRoot,
      })
      yield* insertRun({
        runID: "run-current",
        childSessionID: childA,
        generation: 2,
        operationKey: childA,
        continuationOfRunID: "run-pred",
        worktreeState: "none",
      })

      // between markStarted and markReady the flock steals the run (execution_owner set,
      // version left stale) → markReady's CAS predicate matches 0 rows
      const exit = yield* TaskWorktree.reuseExact({
        runID: "run-current",
        childSessionID: childA,
        childDirectory: "/wt/child",
        repositoryRoot,
        git: fakeGit({ branch: "agent/expected" }),
        flock: stealingFlock("run-current"),
        now,
      }).pipe(Effect.exit)

      const error = failureOf(exit)
      expect(error.code).toBe("worktree_outcome_unknown")
      expect(error.message).toContain("ready receipt lost its run version fence")

      // CAS failure does NOT flip the run to recovery — it stays admitted/admitting
      const row = yield* getRun("run-current")
      expect(row.state).toBe("admitted")
      expect(row.worktree_state).toBe("admitting")
      expect(row.execution_owner).toBe("sneaky-owner")
      expect(row.version).toBe(1)
      const events = yield* getEvents("run-current")
      expect(events.map((event) => event.type)).toEqual(["worktree_started"])
    }))
})
