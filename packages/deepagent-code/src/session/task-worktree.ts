import { Cause, Data, Effect } from "effect"
import { join } from "path"
import { Database } from "@deepagent-code/core/database/database"
import { Global } from "@deepagent-code/core/global"
import { TaskRunEventTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { Hash } from "@deepagent-code/core/util/hash"
import { and, eq, isNull } from "drizzle-orm"
import { Identifier } from "@/id/id"
import { Worktree } from "@/worktree"
import { Git } from "@/git"

export class TaskWorktreeError extends Data.TaggedError("TaskWorktree.Error")<{
  readonly runID: string
  readonly code: "worktree_unavailable" | "worktree_conflict" | "worktree_outcome_unknown"
  readonly message: string
}> {}

export function reuseExact(input: {
  readonly runID: string
  readonly childSessionID: string
  readonly childDirectory: string
  readonly repositoryRoot: string
  readonly git: Git.Interface
  readonly flock: EffectFlock.Interface
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const current = yield* db
      .select({
        state: TaskRunTable.state,
        version: TaskRunTable.version,
        continuationOfRunID: TaskRunTable.continuation_of_run_id,
        childSessionID: TaskRunTable.child_session_id,
        workspaceMode: TaskRunTable.workspace_mode,
        operationKey: TaskRunTable.workspace_operation_key,
        worktreeState: TaskRunTable.worktree_state,
        worktreeDirectory: TaskRunTable.worktree_directory,
        worktreeBranch: TaskRunTable.worktree_branch,
      })
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, input.runID))
      .get()
      .pipe(Effect.orDie)
    if (
      !current ||
      current.state !== "admitted" ||
      current.childSessionID !== input.childSessionID ||
      current.workspaceMode !== "worktree" ||
      current.operationKey !== input.childSessionID ||
      !current.continuationOfRunID
    ) {
      return yield* new TaskWorktreeError({
        runID: input.runID,
        code: "worktree_conflict",
        message: "Run is not eligible to reuse an existing durable child worktree",
      })
    }

    const predecessor = yield* db
      .select({
        operationKey: TaskRunTable.workspace_operation_key,
        repositoryRoot: TaskRunTable.workspace_repository_root,
        worktreeState: TaskRunTable.worktree_state,
        worktreeDirectory: TaskRunTable.worktree_directory,
        worktreeBranch: TaskRunTable.worktree_branch,
      })
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, current.continuationOfRunID))
      .get()
      .pipe(Effect.orDie)
    if (
      !predecessor ||
      predecessor.operationKey !== input.childSessionID ||
      predecessor.repositoryRoot !== input.repositoryRoot ||
      !["ready", "retained", "submitted"].includes(predecessor.worktreeState) ||
      predecessor.worktreeDirectory !== input.childDirectory ||
      !predecessor.worktreeBranch ||
      current.worktreeState === "conflict" ||
      (current.worktreeState !== "none" &&
        (current.worktreeDirectory !== predecessor.worktreeDirectory ||
          current.worktreeBranch !== predecessor.worktreeBranch))
    ) {
      return yield* new TaskWorktreeError({
        runID: input.runID,
        code: "worktree_conflict",
        message: "Predecessor receipt cannot prove exact worktree continuity",
      })
    }

    const now = input.now ?? Date.now()
    if (current.worktreeState === "none") {
      yield* markStarted({
        runID: input.runID,
        expectedVersion: current.version,
        directory: predecessor.worktreeDirectory,
        branch: predecessor.worktreeBranch,
        now,
      })
    }

    const observed = yield* input.flock
      .withLock(
        Effect.gen(function* () {
          const commonDir = yield* input.git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: input.childDirectory,
          })
          const parentCommonDir = yield* input.git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: input.repositoryRoot,
          })
          return {
            branch: yield* input.git.branch(input.childDirectory),
            commonDir: commonDir.exitCode === 0 ? commonDir.text().trim() : undefined,
            parentCommonDir: parentCommonDir.exitCode === 0 ? parentCommonDir.text().trim() : undefined,
          }
        }),
        `task-workspace:${input.repositoryRoot}`,
      )
      .pipe(Effect.exit)
    if (observed._tag === "Failure") {
      const message = String(Cause.squash(observed.cause))
      yield* requireRecovery({ runID: input.runID, code: "worktree_outcome_unknown", message, now })
      return yield* new TaskWorktreeError({
        runID: input.runID,
        code: "worktree_outcome_unknown",
        message,
      })
    }
    if (
      observed.value.branch !== predecessor.worktreeBranch ||
      !observed.value.commonDir ||
      observed.value.commonDir !== observed.value.parentCommonDir
    ) {
      const message = "Existing child directory no longer matches its repository and branch receipt"
      yield* requireRecovery({ runID: input.runID, code: "worktree_conflict", message, now })
      return yield* new TaskWorktreeError({ runID: input.runID, code: "worktree_conflict", message })
    }

    if (current.worktreeState !== "ready") {
      yield* markReady({
        runID: input.runID,
        directory: predecessor.worktreeDirectory,
        branch: predecessor.worktreeBranch,
        now,
      })
    }
    return {
      name: predecessor.worktreeBranch.slice(predecessor.worktreeBranch.lastIndexOf("/") + 1),
      directory: predecessor.worktreeDirectory,
      branch: predecessor.worktreeBranch,
    } satisfies Worktree.Info
  })
}

export function ensureExact(input: {
  readonly runID: string
  readonly repositoryRoot: string
  readonly baseCommit: string
  readonly worktree: Worktree.Interface
  readonly flock: EffectFlock.Interface
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const current = yield* db
      .select({
        state: TaskRunTable.state,
        version: TaskRunTable.version,
        workspaceMode: TaskRunTable.workspace_mode,
        operationKey: TaskRunTable.workspace_operation_key,
        worktreeState: TaskRunTable.worktree_state,
        worktreeDirectory: TaskRunTable.worktree_directory,
        worktreeBranch: TaskRunTable.worktree_branch,
        receiptBase: TaskRunTable.workspace_base_commit,
      })
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, input.runID))
      .get()
      .pipe(Effect.orDie)
    if (!current) return yield* Effect.die(new Error(`Task worktree run ${input.runID} not found`))
    if (current.state !== "admitted" || current.workspaceMode !== "worktree" || !current.operationKey) {
      return yield* new TaskWorktreeError({
        runID: input.runID,
        code: "worktree_conflict",
        message: "Run is not eligible for a run-owned worktree",
      })
    }

    const digest = Hash.sha256(current.operationKey).slice(0, 24)
    const name = `task-${digest}`
    const directory = join(
      Global.Path.data,
      "worktree",
      "durable",
      Hash.sha256(input.repositoryRoot).slice(0, 16),
      name,
    )
    const branch = `deepagent-code/${name}`
    if (current.receiptBase !== input.baseCommit) {
      return yield* new TaskWorktreeError({
        runID: input.runID,
        code: "worktree_conflict",
        message: `Frozen base ${current.receiptBase ?? "absent"} does not match ${input.baseCommit}`,
      })
    }
    if (current.worktreeState === "conflict") {
      return yield* new TaskWorktreeError({
        runID: input.runID,
        code: "worktree_conflict",
        message: "Worktree receipt is already in conflict",
      })
    }
    if (
      current.worktreeState === "ready" &&
      (current.worktreeDirectory !== directory || current.worktreeBranch !== branch)
    ) {
      return yield* new TaskWorktreeError({
        runID: input.runID,
        code: "worktree_conflict",
        message: "Ready worktree receipt does not match the frozen operation identity",
      })
    }

    const now = input.now ?? Date.now()
    if (current.worktreeState === "none") {
      yield* markStarted({
        runID: input.runID,
        expectedVersion: current.version,
        directory,
        branch,
        now,
      })
    }

    const attempt = input.flock.withLock(
      input.worktree.ensureExact({
        operationKey: current.operationKey,
        name,
        directory,
        worktreeBranch: branch,
        baseCommit: input.baseCommit,
      }),
      `task-workspace:${input.repositoryRoot}`,
    )
    const result = yield* attempt.pipe(Effect.exit)
    if (result._tag === "Failure") {
      const error = Cause.squash(result.cause)
      const code =
        error instanceof Worktree.WorktreeExactConflictError ? "worktree_conflict" : "worktree_outcome_unknown"
      const message = error instanceof Error ? error.message : String(error)
      yield* requireRecovery({ runID: input.runID, code, message, now })
      return yield* new TaskWorktreeError({ runID: input.runID, code, message })
    }

    if (current.worktreeState === "ready") return result.value
    yield* markReady({ runID: input.runID, directory, branch, now })
    return result.value
  })
}

function markStarted(input: {
  readonly runID: string
  readonly expectedVersion: number
  readonly directory: string
  readonly branch: string
  readonly now: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              worktree_state: "admitting",
              worktree_started_at: input.now,
              worktree_directory: input.directory,
              worktree_branch: input.branch,
              version: input.expectedVersion + 1,
              time_updated: input.now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, input.expectedVersion),
                eq(TaskRunTable.state, "admitted"),
                eq(TaskRunTable.worktree_state, "none"),
                isNull(TaskRunTable.execution_owner),
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) {
            return yield* new TaskWorktreeError({
              runID: input.runID,
              code: "worktree_conflict",
              message: "Worktree start lost its run version fence",
            })
          }
          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.runID,
              version: updated.version,
              type: "worktree_started",
              from_state: "admitted",
              to_state: "admitted",
              reason: `${input.branch}:${input.directory}`,
              time_created: input.now,
            })
            .run()
            .pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )
  })
}

function markReady(input: {
  readonly runID: string
  readonly directory: string
  readonly branch: string
  readonly now: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select({ version: TaskRunTable.version })
            .from(TaskRunTable)
            .where(eq(TaskRunTable.run_id, input.runID))
            .get()
            .pipe(Effect.orDie)
          if (!current) return yield* Effect.die(new Error(`Task worktree run ${input.runID} disappeared`))
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              worktree_state: "ready",
              worktree_directory: input.directory,
              worktree_branch: input.branch,
              version: current.version + 1,
              time_updated: input.now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, current.version),
                eq(TaskRunTable.state, "admitted"),
                eq(TaskRunTable.worktree_state, "admitting"),
                isNull(TaskRunTable.execution_owner),
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) {
            return yield* new TaskWorktreeError({
              runID: input.runID,
              code: "worktree_outcome_unknown",
              message: "Worktree ready receipt lost its run version fence",
            })
          }
          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.runID,
              version: updated.version,
              type: "worktree_ready",
              from_state: "admitted",
              to_state: "admitted",
              reason: `${input.branch}:${input.directory}`,
              time_created: input.now,
            })
            .run()
            .pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )
  })
}

function requireRecovery(input: {
  readonly runID: string
  readonly code: "worktree_conflict" | "worktree_outcome_unknown"
  readonly message: string
  readonly now: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select({ version: TaskRunTable.version })
            .from(TaskRunTable)
            .where(eq(TaskRunTable.run_id, input.runID))
            .get()
            .pipe(Effect.orDie)
          if (!current) return
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              state: "recovery_required",
              reason: input.code,
              error: { code: input.code, message: input.message },
              worktree_state: "conflict",
              version: current.version + 1,
              time_updated: input.now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, current.version),
                eq(TaskRunTable.state, "admitted"),
                isNull(TaskRunTable.execution_owner),
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return
          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.runID,
              version: updated.version,
              type: "recovery_required",
              from_state: "admitted",
              to_state: "recovery_required",
              reason: `${input.code}:${input.message}`,
              time_created: input.now,
            })
            .run()
            .pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )
  })
}

export * as TaskWorktree from "./task-worktree"
