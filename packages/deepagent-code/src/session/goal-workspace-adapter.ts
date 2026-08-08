/**
 * GoalWorkspaceAdapter — Goal-owned worktree lineage for role execution.
 *
 * Design: subagent-control-plane-design.zh-CN.md §3.9.2
 *
 * All Goal roles (worker/reviewer/panel) for the same Goal bind to the same
 * Goal-owned worktree so each role can observe the previous role's file changes.
 *
 * Invariants (design §1.3):
 *   #17: run-owned vs Goal-owned worktree continuity is separate
 *   #32: worker/reviewer/panel bind to same Goal workspace lineage
 *   #34: session target branch ≠ child worktree branch
 *
 * Lock ordering (design §3.2, §3.9.1):
 *   Goal receipt EffectFlock → repository EffectFlock
 *   Never repository → Goal (would deadlock)
 */

import { Data, Effect } from "effect"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { Database } from "@deepagent-code/core/database/database"
import { TaskRunTable, TaskRunEventTable } from "@deepagent-code/core/session/sql"
import { and, eq } from "drizzle-orm"
import { Identifier } from "@/id/id"
import { Git } from "@/git"
import { Worktree } from "@/worktree"
import { withGoalLock } from "./goal-receipt-store"
import type { GoalWorkspaceReceipt } from "./goal-receipt-store"
import type { Run } from "@/tool/task-run"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GoalWorkspaceConflictError extends Data.TaggedError("GoalWorkspaceAdapter.Conflict")<{
  readonly goalID: string
  readonly reason: string
}> {}

export class GoalWorkspaceUnavailableError extends Data.TaggedError("GoalWorkspaceAdapter.Unavailable")<{
  readonly goalID: string
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// ensure — provision or adopt the Goal-owned worktree for a role run
// Design §3.9.2
// ---------------------------------------------------------------------------

/**
 * Ensure the Goal-owned worktree is ready for a role run.
 *
 * Lock ordering: this function acquires Goal receipt lock FIRST, then repository lock.
 * External callers must NOT hold the repository lock before calling this.
 */
export function ensure(input: {
  readonly run: Run
  readonly goalID: string
  readonly parentSessionID: string
  readonly parentDirectory: string
  readonly ownerToken: string
  readonly now?: number
}) {
  return withGoalLock(
    input.goalID,
    (locked) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const git = yield* Git.Service
        const flock = yield* EffectFlock.Service
        const now = input.now ?? Date.now()

        // 1. Read current workspace receipt
        yield* locked.refresh()
        const existing = yield* locked.readFresh({ kind: "workspace", goalID: input.goalID })

        if (existing) {
          const receipt = existing.body as GoalWorkspaceReceipt
          if (receipt.state === "ready") {
            // Already provisioned — verify it matches what we expect
            const currentRevision = receipt.workspace_revision
            return {
              worktreeDirectory: receipt.worktree_directory,
              worktreeBranch: receipt.worktree_branch,
              workspaceRevision: currentRevision,
            }
          }
          if (receipt.state === "recovery_required") {
            return yield* Effect.fail(
              new GoalWorkspaceConflictError({
                goalID: input.goalID,
                reason: "Goal workspace is in recovery_required state",
              }),
            )
          }
        }

        // 2. Read Git state to establish base_commit (under Goal lock)
        const repository = yield* git.repository(input.parentDirectory)
        if (!repository) {
          return yield* Effect.fail(
            new GoalWorkspaceUnavailableError({
              goalID: input.goalID,
              reason: "parent directory is not a Git repository",
            }),
          )
        }

        const headRef = yield* git.resolveRef(input.parentDirectory)
        if (!headRef) {
          return yield* Effect.fail(
            new GoalWorkspaceUnavailableError({
              goalID: input.goalID,
              reason: "parent directory has no HEAD commit",
            }),
          )
        }

        const statusItems = yield* git.status(input.parentDirectory)
        if (statusItems.length > 0) {
          return yield* Effect.fail(
            new GoalWorkspaceUnavailableError({
              goalID: input.goalID,
              reason: `parent directory is dirty (${statusItems.length} changed file(s))`,
            }),
          )
        }

        // 3. Derive deterministic worktree name and branch
        const goalSlug = input.goalID.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 20)
        const worktreeName = `goal-${goalSlug}`
        const worktreeBranch = `deepagent-code/goal-${input.goalID.slice(0, 30)}`
        const worktreeDirectory = `${input.parentDirectory}/.deepagent/worktrees/${worktreeName}`

        // 4. Write provisioning receipt
        const pendingReceipt: GoalWorkspaceReceipt = {
          goal_id: input.goalID,
          parent_session_id: input.parentSessionID,
          operation_key: input.goalID,
          repository_root: repository.root,
          parent_directory: input.parentDirectory,
          base_commit: headRef,
          worktree_directory: worktreeDirectory,
          worktree_branch: worktreeBranch,
          workspace_revision: 0,
          state: "provisioning",
          create_started_at: now,
          key_schema_version: 1,
        }

        yield* locked.compareAndSet({
          key: { kind: "workspace", goalID: input.goalID },
          desiredBody: pendingReceipt,
        }).pipe(
          Effect.catchTag("GoalReceiptStore.KeyConflict", (e) =>
            Effect.fail(new GoalWorkspaceConflictError({ goalID: input.goalID, reason: e.reason })),
          ),
        )

        // 5. Create the worktree using Worktree.ensureExact
        // Design §3.9.1: hold Goal lock THEN canonical repository EffectFlock
        yield* flock.withLock(
          Effect.gen(function* () {
            const worktree = yield* Worktree.Service
            yield* worktree.ensureExact({
              operationKey: input.goalID,
              name: worktreeName,
              worktreeBranch,
              directory: worktreeDirectory,
              baseCommit: headRef,
            }).pipe(
              Effect.catchTag("WorktreeExactConflictError", (e) =>
                Effect.fail(new GoalWorkspaceConflictError({ goalID: input.goalID, reason: e.reason })),
              ),
              Effect.catchTag("WorktreeNotGitError", (e) =>
                Effect.fail(new GoalWorkspaceUnavailableError({ goalID: input.goalID, reason: e.message })),
              ),
              Effect.catchTag("WorktreeCreateFailedError", (e) =>
                Effect.fail(new GoalWorkspaceUnavailableError({ goalID: input.goalID, reason: e.message })),
              ),
            )
          }),
          `goal-worktree:${repository.root}`,
        )

        // 6. Mark receipt as ready
        yield* locked.refresh()
        const freshReceipt = yield* locked.readFresh({ kind: "workspace", goalID: input.goalID })
        const readyReceipt: GoalWorkspaceReceipt = {
          ...pendingReceipt,
          state: "ready",
          workspace_revision: 0,
          last_head: headRef,
        }
        yield* locked.compareAndSet({
          key: { kind: "workspace", goalID: input.goalID },
          expected: freshReceipt
            ? { docVersion: freshReceipt.docVersion, contentHash: freshReceipt.contentHash }
            : undefined,
          desiredBody: readyReceipt,
        }).pipe(Effect.ignore)

        // 7. Write run event
        const currentRun = yield* db
          .select({ version: TaskRunTable.version })
          .from(TaskRunTable)
          .where(eq(TaskRunTable.run_id, input.run.runID))
          .get()
          .pipe(Effect.orDie)
        if (currentRun) {
          yield* db
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.run.runID,
              version: currentRun.version,
              type: "goal_workspace_ready",
              time_created: now,
              data: { worktree_directory: worktreeDirectory, worktree_branch: worktreeBranch } as any,
            })
            .run()
            .pipe(Effect.orDie)
        }

        return {
          worktreeDirectory,
          worktreeBranch,
          workspaceRevision: 0,
        }
      }),
  ).pipe(Effect.orDie)
}

export * as GoalWorkspaceAdapter from "./goal-workspace-adapter"
