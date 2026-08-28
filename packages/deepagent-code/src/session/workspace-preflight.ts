import { Data, Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { TaskRunEventTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { Hash } from "@deepagent-code/core/util/hash"
import { and, eq, isNull } from "drizzle-orm"
import { Git } from "@/git"
import { Identifier } from "@/id/id"

export function reuse(input: {
  readonly runID: string
  readonly childSessionID: string
  readonly childDirectory: string
  readonly git?: Git.Interface
  readonly flock?: EffectFlock.Interface
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const current = yield* db
      .select({
        state: TaskRunTable.state,
        preflightState: TaskRunTable.workspace_preflight_state,
        continuationOfRunID: TaskRunTable.continuation_of_run_id,
        childSessionID: TaskRunTable.child_session_id,
        workspaceMode: TaskRunTable.workspace_mode,
        workspaceOwner: TaskRunTable.workspace_owner,
        operationKey: TaskRunTable.workspace_operation_key,
        repositoryRoot: TaskRunTable.workspace_repository_root,
        baseCommit: TaskRunTable.workspace_base_commit,
        parentBranch: TaskRunTable.workspace_parent_branch,
        statusHash: TaskRunTable.workspace_status_hash,
        targetBranch: TaskRunTable.workspace_target_branch,
        branchState: TaskRunTable.workspace_branch_state,
      })
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, input.runID))
      .get()
      .pipe(Effect.orDie)
    if (!current) return yield* Effect.die(new Error(`Workspace continuation run ${input.runID} not found`))
    if (
      current.state !== "admitted" ||
      current.childSessionID !== input.childSessionID ||
      current.workspaceMode !== "worktree" ||
      current.operationKey !== input.childSessionID ||
      !current.continuationOfRunID
    ) {
      return yield* new WorkspacePreflightError({
        runID: input.runID,
        code: "workspace_preflight_conflict",
        message: "Run is not eligible to reuse a durable child workspace",
      })
    }
    if (
      current.preflightState === "ready" &&
      current.repositoryRoot &&
      current.baseCommit &&
      current.statusHash &&
      (current.workspaceOwner === "caller" || (current.branchState === "ready" && current.targetBranch))
    ) {
      return {
        repositoryRoot: current.repositoryRoot,
        baseCommit: current.baseCommit,
        ...(current.parentBranch ? { parentBranch: current.parentBranch } : {}),
        statusHash: current.statusHash,
      } satisfies Receipt
    }

    const predecessor = yield* db
      .select({
        childSessionID: TaskRunTable.child_session_id,
        operationKey: TaskRunTable.workspace_operation_key,
        workspaceOwner: TaskRunTable.workspace_owner,
        preflightState: TaskRunTable.workspace_preflight_state,
        repositoryRoot: TaskRunTable.workspace_repository_root,
        baseCommit: TaskRunTable.workspace_base_commit,
        parentBranch: TaskRunTable.workspace_parent_branch,
        statusHash: TaskRunTable.workspace_status_hash,
        worktreeState: TaskRunTable.worktree_state,
        worktreeDirectory: TaskRunTable.worktree_directory,
        worktreeBranch: TaskRunTable.worktree_branch,
        targetBranch: TaskRunTable.workspace_target_branch,
        branchState: TaskRunTable.workspace_branch_state,
      })
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, current.continuationOfRunID))
      .get()
      .pipe(Effect.orDie)
    const now = input.now ?? Date.now()
    if (
      !predecessor ||
      predecessor.childSessionID !== input.childSessionID ||
      predecessor.operationKey !== input.childSessionID ||
      predecessor.workspaceOwner !== current.workspaceOwner ||
      predecessor.preflightState !== "ready" ||
      !["ready", "retained", "submitted"].includes(predecessor.worktreeState) ||
      predecessor.worktreeDirectory !== input.childDirectory ||
      !predecessor.worktreeBranch ||
      (current.workspaceOwner === "run" && (predecessor.branchState !== "ready" || !predecessor.targetBranch)) ||
      !predecessor.repositoryRoot ||
      !predecessor.baseCommit ||
      !predecessor.statusHash
    ) {
      return yield* fail({
        runID: input.runID,
        code: "workspace_preflight_conflict",
        message: "Predecessor workspace receipt cannot prove child workspace continuity",
        now,
      })
    }
    if (!input.git || !input.flock) {
      return yield* fail({
        runID: input.runID,
        code: "workspace_unavailable",
        message: "Workspace continuation requires Git and canonical repository locking",
        now,
      })
    }

    return yield* input.flock.withLock(
      Effect.gen(function* () {
        const branch = yield* input.git!.branch(input.childDirectory)
        const parentBranch =
          current.workspaceOwner === "run" ? yield* input.git!.branch(predecessor.repositoryRoot!) : undefined
        const commonDir = yield* input.git!.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
          cwd: input.childDirectory,
        })
        const parentCommonDir = yield* input.git!.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
          cwd: predecessor.repositoryRoot!,
        })
        if (
          branch !== predecessor.worktreeBranch ||
          (current.workspaceOwner === "run" && parentBranch !== predecessor.targetBranch) ||
          commonDir.exitCode !== 0 ||
          parentCommonDir.exitCode !== 0 ||
          commonDir.text().trim() !== parentCommonDir.text().trim()
        ) {
          return yield* fail({
            runID: input.runID,
            code: "workspace_preflight_conflict",
            message: "Child directory no longer matches the predecessor repository and branch receipt",
            now,
          })
        }
        const receipt = {
          repositoryRoot: predecessor.repositoryRoot!,
          baseCommit: predecessor.baseCommit!,
          ...(predecessor.parentBranch ? { parentBranch: predecessor.parentBranch } : {}),
          statusHash: predecessor.statusHash!,
        } satisfies Receipt
        if (current.preflightState !== "ready") {
          yield* ready({ runID: input.runID, receipt, now })
        }
        if (predecessor.targetBranch) {
          yield* reuseBranch({ runID: input.runID, targetBranch: predecessor.targetBranch, now })
        }
        return receipt
      }),
      `task-workspace:${predecessor.repositoryRoot}`,
    )
  })
}

export type Receipt = {
  readonly repositoryRoot: string
  readonly baseCommit: string
  readonly parentBranch?: string
  readonly statusHash: string
}

export class WorkspacePreflightError extends Data.TaggedError("TaskWorkspacePreflight.Error")<{
  readonly runID: string
  readonly code: "workspace_unavailable" | "workspace_dirty" | "workspace_preflight_conflict"
  readonly message: string
}> {}

export function ensure(input: {
  readonly runID: string
  readonly parentDirectory: string
  readonly mutationCapability: "read_only" | "write"
  readonly workspaceMode: "shared" | "worktree"
  readonly git?: Git.Interface
  readonly flock?: EffectFlock.Interface
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const existing = yield* db
      .select({
        state: TaskRunTable.state,
        version: TaskRunTable.version,
        preflightState: TaskRunTable.workspace_preflight_state,
        repositoryRoot: TaskRunTable.workspace_repository_root,
        baseCommit: TaskRunTable.workspace_base_commit,
        parentBranch: TaskRunTable.workspace_parent_branch,
        statusHash: TaskRunTable.workspace_status_hash,
        mutationCapability: TaskRunTable.mutation_capability,
        workspaceMode: TaskRunTable.workspace_mode,
      })
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, input.runID))
      .get()
      .pipe(Effect.orDie)
    if (!existing) return yield* Effect.die(new Error(`Workspace preflight run ${input.runID} not found`))
    if (existing.mutationCapability !== input.mutationCapability || existing.workspaceMode !== input.workspaceMode) {
      return yield* new WorkspacePreflightError({
        runID: input.runID,
        code: "workspace_preflight_conflict",
        message: "Workspace policy does not match the frozen admission receipt",
      })
    }
    if (existing.preflightState === "ready" && existing.repositoryRoot && existing.baseCommit && existing.statusHash) {
      return {
        repositoryRoot: existing.repositoryRoot,
        baseCommit: existing.baseCommit,
        ...(existing.parentBranch ? { parentBranch: existing.parentBranch } : {}),
        statusHash: existing.statusHash,
      } satisfies Receipt
    }
    if (existing.preflightState === "failed") {
      return yield* new WorkspacePreflightError({
        runID: input.runID,
        code: "workspace_preflight_conflict",
        message: "Workspace preflight already failed for this run",
      })
    }
    if (existing.state !== "admitted") {
      return yield* new WorkspacePreflightError({
        runID: input.runID,
        code: "workspace_preflight_conflict",
        message: `Workspace preflight cannot run from state ${existing.state}`,
      })
    }

    const now = input.now ?? Date.now()
    if (!existing.preflightState || existing.preflightState === "legacy") {
      yield* mutateReceipt({
        runID: input.runID,
        expectedVersion: existing.version,
        event: "workspace_preflight_started",
        state: "pending",
        now,
      })
    }

    const repository = input.git ? yield* input.git.repository(input.parentDirectory) : undefined
    if (!repository) {
      if (input.mutationCapability === "write" || input.workspaceMode === "worktree") {
        return yield* fail({
          runID: input.runID,
          code: "workspace_unavailable",
          message: "Writer and isolated tasks require a Git repository and workspace lock service",
          now,
        })
      }
      return yield* ready({
        runID: input.runID,
        receipt: {
          repositoryRoot: input.parentDirectory,
          baseCommit: "non-git",
          statusHash: Hash.sha256("[]"),
        },
        now,
      })
    }
    if (!input.flock) {
      return yield* fail({
        runID: input.runID,
        code: "workspace_unavailable",
        message: "Canonical repository locking is unavailable",
        now,
      })
    }

    return yield* input.flock.withLock(
      Effect.gen(function* () {
        const exactRepository = yield* input.git!.repository(input.parentDirectory)
        const baseCommit = yield* input.git!.resolveRef(input.parentDirectory)
        const parentBranch = yield* input.git!.branch(input.parentDirectory)
        const status = yield* input.git!.porcelainStatus(input.parentDirectory)
        if (!exactRepository || exactRepository.root !== repository.root || !baseCommit || !status) {
          return yield* fail({
            runID: input.runID,
            code: "workspace_preflight_conflict",
            message: "Repository identity changed or could not be read while holding the workspace lock",
            now,
          })
        }
        if (input.mutationCapability === "write" && !status.clean) {
          return yield* fail({
            runID: input.runID,
            code: "workspace_dirty",
            message: `Automatic writer tasks require a clean workspace (paths: ${status.paths.join(", ")})`,
            now,
          })
        }
        return yield* ready({
          runID: input.runID,
          receipt: {
            repositoryRoot: exactRepository.root,
            baseCommit,
            ...(parentBranch ? { parentBranch } : {}),
            statusHash: Hash.sha256(
              JSON.stringify(
                status.entries
                  .map((entry) => ({ file: entry.file, status: entry.status }))
                  .toSorted((a, b) => a.file.localeCompare(b.file) || a.status.localeCompare(b.status)),
              ),
            ),
          },
          now,
        })
      }),
      `task-workspace:${repository.root}`,
    )
  })
}

function ready(input: { readonly runID: string; readonly receipt: Receipt; readonly now: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select({ version: TaskRunTable.version, state: TaskRunTable.state })
            .from(TaskRunTable)
            .where(eq(TaskRunTable.run_id, input.runID))
            .get()
            .pipe(Effect.orDie)
          if (!current || current.state !== "admitted") {
            return yield* new WorkspacePreflightError({
              runID: input.runID,
              code: "workspace_preflight_conflict",
              message: "Run changed while workspace preflight was in progress",
            })
          }
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              workspace_preflight_state: "ready",
              workspace_preflight_at: input.now,
              workspace_repository_root: input.receipt.repositoryRoot,
              workspace_base_commit: input.receipt.baseCommit,
              workspace_parent_branch: input.receipt.parentBranch ?? null,
              workspace_status_hash: input.receipt.statusHash,
              workspace_preflight_error_code: null,
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
          if (!updated) {
            return yield* new WorkspacePreflightError({
              runID: input.runID,
              code: "workspace_preflight_conflict",
              message: "Workspace preflight receipt lost its run version fence",
            })
          }
          yield* insertEvent(tx, {
            runID: input.runID,
            version: updated.version,
            type: "workspace_preflight_ready",
            reason: `base=${input.receipt.baseCommit} status=${input.receipt.statusHash}`,
            now: input.now,
          })
          return input.receipt
        }),
      { behavior: "immediate" },
    )
  })
}

function reuseBranch(input: { readonly runID: string; readonly targetBranch: string; readonly now: number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select({
              version: TaskRunTable.version,
              state: TaskRunTable.state,
              preflightState: TaskRunTable.workspace_preflight_state,
              branchState: TaskRunTable.workspace_branch_state,
              targetBranch: TaskRunTable.workspace_target_branch,
            })
            .from(TaskRunTable)
            .where(eq(TaskRunTable.run_id, input.runID))
            .get()
            .pipe(Effect.orDie)
          if (
            current?.state === "admitted" &&
            current.preflightState === "ready" &&
            current.branchState === "ready" &&
            current.targetBranch === input.targetBranch
          ) {
            return
          }
          if (!current || current.state !== "admitted" || current.preflightState !== "ready") {
            return yield* new WorkspacePreflightError({
              runID: input.runID,
              code: "workspace_preflight_conflict",
              message: "Branch reuse requires a ready continuation preflight receipt",
            })
          }
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              workspace_branch_state: "ready",
              workspace_target_branch: input.targetBranch,
              version: current.version + 1,
              time_updated: input.now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, current.version),
                eq(TaskRunTable.state, "admitted"),
                eq(TaskRunTable.workspace_preflight_state, "ready"),
                eq(TaskRunTable.workspace_branch_state, "none"),
                isNull(TaskRunTable.execution_owner),
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) {
            return yield* new WorkspacePreflightError({
              runID: input.runID,
              code: "workspace_preflight_conflict",
              message: "Branch reuse lost its run version fence",
            })
          }
          yield* insertEvent(tx, {
            runID: input.runID,
            version: updated.version,
            type: "session_branch_ready",
            reason: `reused:${input.targetBranch}`,
            now: input.now,
          })
        }),
      { behavior: "immediate" },
    )
  })
}

function fail(input: {
  readonly runID: string
  readonly code: WorkspacePreflightError["code"]
  readonly message: string
  readonly now: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.transaction(
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
              workspace_preflight_state: "failed",
              workspace_preflight_at: input.now,
              workspace_preflight_error_code: input.code,
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
          yield* insertEvent(tx, {
            runID: input.runID,
            version: updated.version,
            type: "workspace_preflight_failed",
            reason: `${input.code}:${input.message}`,
            now: input.now,
          })
        }),
      { behavior: "immediate" },
    )
    return yield* new WorkspacePreflightError(input)
  })
}

function mutateReceipt(input: {
  readonly runID: string
  readonly expectedVersion: number
  readonly event: string
  readonly state: "pending"
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
              workspace_preflight_state: input.state,
              workspace_preflight_at: input.now,
              version: input.expectedVersion + 1,
              time_updated: input.now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, input.expectedVersion),
                eq(TaskRunTable.state, "admitted"),
                isNull(TaskRunTable.execution_owner),
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) {
            return yield* new WorkspacePreflightError({
              runID: input.runID,
              code: "workspace_preflight_conflict",
              message: "Workspace preflight start lost its run version fence",
            })
          }
          yield* insertEvent(tx, {
            runID: input.runID,
            version: updated.version,
            type: input.event,
            reason: "workspace_preflight_started",
            now: input.now,
          })
        }),
      { behavior: "immediate" },
    )
  })
}

type Transaction = Parameters<Database.Interface["db"]["transaction"]>[0] extends (tx: infer T) => unknown ? T : never

function insertEvent(
  tx: Transaction,
  input: {
    readonly runID: string
    readonly version: number
    readonly type: string
    readonly reason: string
    readonly now: number
  },
) {
  return tx
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
}

export * as TaskWorkspacePreflight from "./workspace-preflight"
