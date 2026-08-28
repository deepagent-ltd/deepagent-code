/**
 * SessionBranchProvisioner — durable session target-branch provisioning.
 *
 * Design: subagent-control-plane-design.zh-CN.md §3.2.1
 *
 * Wraps the existing ensureSessionBranch helper from pr-collaboration.ts with:
 *   - durable receipt written to task_run.workspace_branch_state
 *   - cross-process lock via EffectFlock on the repository root
 *   - crash recovery: if branch_state="admitting" on restart, query Git and adopt or conflict
 *
 * Invariants (design §1.3):
 *   #31 automatic writer session target branch must be durable provisioned
 *   #34 workspace_target_branch != worktree_branch (enforced by callers)
 *   #36 single legacy executor per SQLite/Location (EffectFlock guards provisioning)
 */

import { Data, Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { TaskRunEventTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { and, eq } from "drizzle-orm"
import { Git } from "@/git"
import { Identifier } from "@/id/id"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SessionBranchConflict extends Data.TaggedError("SessionBranchProvisioner.Conflict")<{
  readonly runID: string
  readonly desiredBranch: string
  readonly reason: string
}> {}

export class SessionBranchUnavailable extends Data.TaggedError("SessionBranchProvisioner.Unavailable")<{
  readonly runID: string
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// Core: ensureExact
// Design §3.2.1
// ---------------------------------------------------------------------------

export type BranchProvisionResult = {
  readonly targetBranch: string
  readonly baseCommit: string
}

/**
 * Provision the session target branch for an automatic writer run, durably.
 *
 * Flow:
 *   1. If workspace_branch_state = "ready" with matching branch/base → adopt
 *   2. CAS workspace_branch_state = "admitting" + record desired target/base
 *   3. Under EffectFlock(repositoryRoot): verify clean + attached + HEAD == base_commit
 *   4. Query or create refs/heads/<desired>
 *   5. CAS workspace_branch_state = "ready"
 *
 * Crash recovery: if state = "admitting" on restart, query Git state and:
 *   - branch exists and HEAD == base_commit → adopt (state=ready)
 *   - branch exists but HEAD differs → provisioning_conflict
 *   - branch absent → safe to re-attempt (re-run from step 3)
 */
export function ensureExact(input: {
  readonly runID: string
  readonly runVersion: number
  readonly parentSessionID: string
  readonly repositoryRoot: string
  readonly baseCommit: string
  readonly parentDirectory: string
  readonly now?: number
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const flock = yield* EffectFlock.Service
    const git = yield* Git.Service
    const now = input.now ?? Date.now()
    const desiredBranch = `deepagent-code/session-${input.parentSessionID}`

    // Step 1: check if already provisioned
    const existingRun = yield* db
      .select({
        version: TaskRunTable.version,
        branchState: TaskRunTable.workspace_branch_state,
        targetBranch: TaskRunTable.workspace_target_branch,
        baseCommit: TaskRunTable.workspace_base_commit,
      })
      .from(TaskRunTable)
      .where(eq(TaskRunTable.run_id, input.runID))
      .get()
      .pipe(Effect.orDie)

    if (!existingRun) return yield* Effect.die(new Error(`ensureExact: run ${input.runID} not found`))
    if (existingRun.version !== input.runVersion) {
      return yield* Effect.die(
        new Error(
          `ensureExact: run version changed before branch provisioning (expected ${input.runVersion}, got ${existingRun.version})`,
        ),
      )
    }

    if (existingRun.branchState === "ready" && existingRun.targetBranch && existingRun.baseCommit) {
      // Already provisioned — verify it still matches what we expect
      if (existingRun.targetBranch !== desiredBranch || existingRun.baseCommit !== input.baseCommit) {
        return yield* Effect.fail(
          new SessionBranchConflict({
            runID: input.runID,
            desiredBranch,
            reason: `existing receipt has branch=${existingRun.targetBranch}, base=${existingRun.baseCommit}`,
          }),
        )
      }
      const adopted = yield* flock.withLock(
        Effect.gen(function* () {
          const branch = yield* git.branch(input.parentDirectory)
          const head = yield* git.resolveRef(input.parentDirectory)
          if (branch !== desiredBranch || head !== input.baseCommit) {
            return yield* Effect.fail(
              new SessionBranchConflict({
                runID: input.runID,
                desiredBranch,
                reason: `ready receipt no longer matches Git branch/head (${branch ?? "detached"}/${head ?? "missing"})`,
              }),
            )
          }
          return { targetBranch: desiredBranch, baseCommit: input.baseCommit } satisfies BranchProvisionResult
        }),
        `task-workspace:${input.repositoryRoot}`,
      )
      return adopted
    }

    if (existingRun.branchState === "conflict") {
      return yield* Effect.fail(
        new SessionBranchConflict({
          runID: input.runID,
          desiredBranch,
          reason: "workspace_branch_state is already 'conflict'",
        }),
      )
    }

    // Step 2: CAS to "admitting" if not already in that state
    if (existingRun.branchState !== "admitting") {
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const casResult = yield* tx
              .update(TaskRunTable)
              .set({
                workspace_branch_state: "admitting",
                workspace_branch_started_at: now,
                workspace_target_branch: desiredBranch,
                workspace_base_commit: input.baseCommit,
                version: existingRun.version + 1,
                time_updated: now,
              })
              .where(
                and(
                  eq(TaskRunTable.run_id, input.runID),
                  eq(TaskRunTable.version, existingRun.version),
                  eq(TaskRunTable.workspace_branch_state, existingRun.branchState ?? "none"),
                ),
              )
              .returning({ version: TaskRunTable.version })
              .get()
              .pipe(Effect.orDie)
            if (!casResult) {
              return yield* Effect.die(
                new Error(`ensureExact: CAS to admitting lost for run ${input.runID} — concurrent provisioner`),
              )
            }
            yield* tx
              .insert(TaskRunEventTable)
              .values({
                event_id: Identifier.ascending("event"),
                run_id: input.runID,
                version: casResult.version,
                type: "session_branch_started",
                from_state: "admitted",
                to_state: "admitted",
                reason: desiredBranch,
                time_created: now,
              })
              .run()
              .pipe(Effect.orDie)
          }),
        { behavior: "immediate" },
      )
    }

    // Step 3+4: under cross-process lock, perform Git operations and CAS to "ready"
    const gitBody = Effect.gen(function* () {
      // Re-read current branch and status under lock
      const currentBranch = yield* git.branch(input.parentDirectory)
      if (!currentBranch) {
        return yield* Effect.fail(
          new SessionBranchUnavailable({
            runID: input.runID,
            reason: "parent checkout has detached HEAD; cannot create session branch",
          }),
        )
      }

      // If already on a non-protected branch that matches desired, adopt it
      const defaultBranchInfo = yield* git.defaultBranch(input.parentDirectory)
      const protectedBranches = new Set(["main", "master", "dev", defaultBranchInfo?.name].filter(Boolean))

      if (!protectedBranches.has(currentBranch)) {
        if (currentBranch !== desiredBranch) {
          return yield* Effect.fail(
            new SessionBranchConflict({
              runID: input.runID,
              desiredBranch,
              reason: `parent is on non-protected branch '${currentBranch}' which is not the desired '${desiredBranch}'`,
            }),
          )
        }
        // Already on the desired branch — verify HEAD matches base_commit
        const headResult = yield* git.run(["rev-parse", "HEAD"], { cwd: input.parentDirectory })
        const head = headResult.text().trim()
        if (head !== input.baseCommit) {
          return yield* Effect.fail(
            new SessionBranchConflict({
              runID: input.runID,
              desiredBranch,
              reason: `HEAD ${head} does not match expected base_commit ${input.baseCommit}`,
            }),
          )
        }
        return { targetBranch: desiredBranch, baseCommit: input.baseCommit } satisfies BranchProvisionResult
      }

      // Parent is on a protected branch — must create/switch to desired branch
      // Verify clean status first (design §3.2, workspace preflight should already have done this)
      const gitStatus = yield* git.status(input.parentDirectory)
      const isDirty = gitStatus.length > 0
      if (isDirty) {
        const paths = gitStatus.map((s) => s.file).join(", ")
        return yield* Effect.fail(
          new SessionBranchUnavailable({
            runID: input.runID,
            reason: `parent checkout is dirty; cannot create session branch (paths: ${paths})`,
          }),
        )
      }

      // Check if the desired branch already exists
      const showRefResult = yield* git
        .run(["show-ref", "--verify", "--quiet", `refs/heads/${desiredBranch}`], {
          cwd: input.parentDirectory,
        })
        .pipe(Effect.orElseSucceed(() => ({ exitCode: 1, text: () => "", truncated: false }) as const))

      if (showRefResult.exitCode === 0) {
        // Branch exists — verify it points to base_commit
        const refHashResult = yield* git.run(["rev-parse", `refs/heads/${desiredBranch}`], {
          cwd: input.parentDirectory,
        })
        const refHash = refHashResult.text().trim()
        if (refHash !== input.baseCommit) {
          return yield* Effect.fail(
            new SessionBranchConflict({
              runID: input.runID,
              desiredBranch,
              reason: `branch ${desiredBranch} already exists but points to ${refHash} not ${input.baseCommit}`,
            }),
          )
        }
        // Switch to existing branch
        const switched = yield* git.run(["switch", desiredBranch], { cwd: input.parentDirectory })
        if (switched.exitCode !== 0) {
          return yield* Effect.fail(
            new SessionBranchUnavailable({
              runID: input.runID,
              reason: `git switch ${desiredBranch} failed: ${switched.text().trim()}`,
            }),
          )
        }
      } else {
        // Create new branch at base_commit
        const created = yield* git.run(["switch", "-c", desiredBranch, input.baseCommit], {
          cwd: input.parentDirectory,
        })
        if (created.exitCode !== 0) {
          return yield* Effect.fail(
            new SessionBranchUnavailable({
              runID: input.runID,
              reason: `git switch -c ${desiredBranch} ${input.baseCommit} failed: ${created.text().trim()}`,
            }),
          )
        }
      }

      return { targetBranch: desiredBranch, baseCommit: input.baseCommit } satisfies BranchProvisionResult
    })
    const result = yield* flock.withLock(gitBody, `task-workspace:${input.repositoryRoot}`)

    // Step 5: CAS workspace_branch_state to "ready" (or "conflict" on failure)
    yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select({ version: TaskRunTable.version })
            .from(TaskRunTable)
            .where(eq(TaskRunTable.run_id, input.runID))
            .get()
            .pipe(Effect.orDie)
          if (!current) return yield* Effect.die(new Error(`ensureExact: run ${input.runID} disappeared`))
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              workspace_branch_state: "ready",
              workspace_target_branch: result.targetBranch,
              workspace_base_commit: result.baseCommit,
              version: current.version + 1,
              time_updated: now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, current.version),
                eq(TaskRunTable.workspace_branch_state, "admitting"),
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return yield* Effect.die(new Error(`ensureExact: ready receipt lost for ${input.runID}`))
          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.runID,
              version: updated.version,
              type: "session_branch_ready",
              from_state: "admitted",
              to_state: "admitted",
              reason: result.targetBranch,
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )

    return result
  }).pipe(
    // On any typed error, persist "conflict" state before propagating
    Effect.tapError((err) => {
      if (err instanceof SessionBranchConflict || err instanceof SessionBranchUnavailable) {
        return markConflict({ runID: input.runID, reason: err.reason, now: input.now ?? Date.now() }).pipe(
          Effect.ignore,
        )
      }
      return Effect.void
    }),
  )
}

function markConflict(input: { readonly runID: string; readonly reason: string; readonly now: number }) {
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
          if (!current) return false
          const updated = yield* tx
            .update(TaskRunTable)
            .set({
              workspace_branch_state: "conflict",
              version: current.version + 1,
              time_updated: input.now,
            })
            .where(
              and(
                eq(TaskRunTable.run_id, input.runID),
                eq(TaskRunTable.version, current.version),
                eq(TaskRunTable.workspace_branch_state, "admitting"),
              ),
            )
            .returning({ version: TaskRunTable.version })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return false
          yield* tx
            .insert(TaskRunEventTable)
            .values({
              event_id: Identifier.ascending("event"),
              run_id: input.runID,
              version: updated.version,
              type: "session_branch_conflict",
              from_state: "admitted",
              to_state: "admitted",
              reason: input.reason,
              time_created: input.now,
            })
            .run()
            .pipe(Effect.orDie)
          return true
        }),
      { behavior: "immediate" },
    )
  })
}

export * as SessionBranchProvisioner from "./branch-provisioner"
