import { Effect } from "effect"
import { Git } from "@/git"
import { PRQueue } from "./pr-queue"
import type { ReviewVerdictContract } from "@/collaboration/review-contract"

export const DEFAULT_WORKER_IDENTITY = {
  name: "coauthor-deepagent",
  email: "coauthor@deepagent.ltd",
} as const satisfies Git.CommitIdentity

export type CollaborationStatus = "admitted" | "committed" | "queued" | "merged" | "merge-conflict" | "merge-failed"

export interface CollaborationState {
  readonly id: string
  readonly parentDirectory: string
  readonly repositoryRoot: string
  readonly targetBranch: string
  readonly parentHead: string
  readonly workerDirectory: string
  readonly workerCommit?: string
  readonly status: CollaborationStatus
  readonly mergeDiagnostic?: string
  readonly conflictPaths?: readonly string[]
  readonly cleanupRequired: boolean
}

export type AdmissionResult =
  | { readonly type: "admitted"; readonly state: CollaborationState }
  | {
      readonly type: "rejected"
      readonly reason: "not-a-repository" | "detached-head" | "protected-target" | "missing-head" | "dirty-parent"
      readonly paths?: readonly string[]
    }

export type CommitResult =
  | { readonly type: "committed"; readonly state: CollaborationState }
  | { readonly type: "rejected"; readonly reason: "not-admitted" | "no-changes" | "commit-failed" }

export type MergeResult =
  | { readonly type: "merged"; readonly state: CollaborationState }
  | { readonly type: "rejected"; readonly reason: "not-committed" | "senior-approval-required" }
  | { readonly type: "review-needed"; readonly state: CollaborationState }
  | { readonly type: "conflict"; readonly state: CollaborationState; readonly abortSucceeded: boolean }
  | { readonly type: "failed"; readonly state: CollaborationState; readonly abortSucceeded: boolean }

export interface CollaborationCoordinator {
  readonly admit: (input: {
    readonly id: string
    readonly parentID: string
    readonly workerID: string
    readonly reviewerID: string
    readonly parentDirectory: string
    readonly workerDirectory: string
    readonly metadata?: Record<string, unknown>
  }) => Effect.Effect<AdmissionResult, PRQueue.PRQueueError, Git.Service | PRQueue.Service>
  readonly commitWorker: (input: {
    readonly id: string
    readonly workerID: string
    readonly paths: readonly string[]
    readonly message: string
    readonly identity?: Git.CommitIdentity
  }) => Effect.Effect<CommitResult, PRQueue.PRQueueError, Git.Service | PRQueue.Service>
  readonly mergeApproved: (input: {
    readonly id: string
    readonly parentDirectory: string
    readonly approval: ReviewVerdictContract
  }) => Effect.Effect<MergeResult, PRQueue.PRQueueError, Git.Service | PRQueue.Service>
}

const protectedTarget = (branch: string) => branch === "main"

const collaborationState = (entry: PRQueue.Entry): CollaborationState | undefined => {
  const metadata = entry.metadata
  if (!metadata) return undefined
  const parentDirectory = metadata.parentDirectory
  const repositoryRoot = metadata.repositoryRoot
  const targetBranch = metadata.targetBranch
  const parentHead = metadata.parentHead
  const workerDirectory = metadata.workerDirectory
  if (
    typeof parentDirectory !== "string" ||
    typeof repositoryRoot !== "string" ||
    typeof targetBranch !== "string" ||
    typeof parentHead !== "string" ||
    typeof workerDirectory !== "string"
  )
    return undefined

  const status: CollaborationStatus =
    entry.status === "merged"
      ? "merged"
      : entry.status === "conflicted"
        ? "merge-conflict"
        : entry.status === "merging"
          ? "queued"
          : entry.workerHead
            ? "queued"
            : "admitted"

  return {
    id: entry.id,
    parentDirectory,
    repositoryRoot,
    targetBranch,
    parentHead,
    workerDirectory,
    ...(entry.workerHead ? { workerCommit: entry.workerHead } : {}),
    status,
    ...(entry.mergeDiagnostic ? { mergeDiagnostic: entry.mergeDiagnostic } : {}),
    cleanupRequired: status !== "merged",
  }
}

const queueMetadata = (input: {
  readonly parentDirectory: string
  readonly repositoryRoot: string
  readonly targetBranch: string
  readonly parentHead: string
  readonly workerDirectory: string
  readonly metadata?: Record<string, unknown>
}): Record<string, unknown> => ({
  ...input.metadata,
  parentDirectory: input.parentDirectory,
  repositoryRoot: input.repositoryRoot,
  targetBranch: input.targetBranch,
  parentHead: input.parentHead,
  workerDirectory: input.workerDirectory,
})

export const coordinator: CollaborationCoordinator = {
  admit: (input) =>
    Effect.gen(function* () {
      const git = yield* Git.Service
      const queue = yield* PRQueue.Service
      const repository = yield* git.repository(input.parentDirectory)
      if (!repository) return { type: "rejected", reason: "not-a-repository" } as const

      const [targetBranch, parentHead, status] = yield* Effect.all([
        git.branch(input.parentDirectory),
        git.resolveRef(input.parentDirectory),
        git.porcelainStatus(input.parentDirectory),
      ])
      if (!targetBranch) return { type: "rejected", reason: "detached-head" } as const
      if (protectedTarget(targetBranch)) return { type: "rejected", reason: "protected-target" } as const
      if (!parentHead) return { type: "rejected", reason: "missing-head" } as const
      if (!status || !status.clean) return { type: "rejected", reason: "dirty-parent", paths: status?.paths ?? [] } as const

      const entry = yield* queue.create({
        id: input.id,
        parentID: input.parentID,
        workerID: input.workerID,
        reviewerID: input.reviewerID,
        sha: parentHead,
        metadata: queueMetadata({
          parentDirectory: input.parentDirectory,
          repositoryRoot: repository.root,
          targetBranch,
          parentHead,
          workerDirectory: input.workerDirectory,
          metadata: input.metadata,
        }),
      })
      const state = collaborationState(entry)
      if (!state) return yield* Effect.die("PR queue entry lacks collaboration metadata")
      return { type: "admitted", state } as const
    }),

  commitWorker: (input) =>
    Effect.gen(function* () {
      const git = yield* Git.Service
      const queue = yield* PRQueue.Service
      const entry = yield* queue.get(input.id)
      const state = entry && collaborationState(entry)
      if (!entry || !state || entry.workerID !== input.workerID || entry.status !== "draft" || entry.workerHead)
        return { type: "rejected", reason: "not-admitted" } as const
      if (input.paths.length === 0) return { type: "rejected", reason: "no-changes" } as const

      const commit = yield* git.commitScoped(state.workerDirectory, {
        paths: [...new Set(input.paths)],
        message: input.message,
        author: input.identity ?? DEFAULT_WORKER_IDENTITY,
      })
      if (commit.exitCode !== 0) return { type: "rejected", reason: "commit-failed" } as const

      const workerCommit = yield* git.resolveRef(state.workerDirectory)
      if (!workerCommit || workerCommit === state.parentHead) return { type: "rejected", reason: "no-changes" } as const
      const range = yield* git.commitRange(state.workerDirectory, state.parentHead, workerCommit)
      if (!range || range.commits.length === 0 || range.paths.length === 0) return { type: "rejected", reason: "no-changes" } as const

      const submitted = yield* queue.resubmit({
        id: entry.id,
        workerID: entry.workerID,
        sha: workerCommit,
        workerHead: workerCommit,
        findings: range.paths,
      })
      if (!submitted) return { type: "rejected", reason: "not-admitted" } as const
      const queued = yield* queue.claimForReview(entry.parentID)
      if (!queued || queued.id !== entry.id) return { type: "rejected", reason: "not-admitted" } as const
      const resultState = collaborationState(queued)
      if (!resultState) return yield* Effect.die("PR queue entry lacks collaboration metadata")
      return { type: "committed", state: { ...resultState, status: "queued" } } as const
    }),

  mergeApproved: (input) =>
    Effect.gen(function* () {
      const git = yield* Git.Service
      const queue = yield* PRQueue.Service
      const entry = yield* queue.get(input.id)
      const state = entry && collaborationState(entry)
      if (!entry || !state || !entry.workerHead || entry.status !== "approved")
        return { type: "rejected", reason: "not-committed" } as const
      if (
        input.approval.reviewer.role !== "senior-reviewer" ||
        input.approval.verdict !== "approve" ||
        input.approval.implementationCommitSha !== entry.workerHead
      )
        return { type: "rejected", reason: "senior-approval-required" } as const

      const currentParentHead = yield* git.resolveRef(input.parentDirectory)
      if (currentParentHead !== state.parentHead) {
        return {
          type: "review-needed",
          state: {
            ...state,
            status: "queued",
            mergeDiagnostic: `Parent HEAD advanced since admission (expected ${state.parentHead}, found ${currentParentHead ?? "missing"}); review and rebase required.`,
          },
        } as const
      }

      const merging = yield* queue.claimMerge({ id: entry.id, parentID: entry.parentID })
      if (!merging) return { type: "rejected", reason: "not-committed" } as const

      const merge = yield* git.mergeInto(input.parentDirectory, merging.workerHead ?? merging.sha)
      if (merge.type === "merged") {
        const completed = yield* queue.completeMerge({ id: merging.id, parentID: merging.parentID })
        const mergedState = completed && collaborationState(completed)
        if (!mergedState) return yield* Effect.die("PR queue entry lacks collaboration metadata")
        return { type: "merged", state: mergedState } as const
      }
      if (merge.type === "conflict") {
        const aborted = yield* git.abortMerge(input.parentDirectory)
        const conflicted = yield* queue.conflictMerge({
          id: merging.id,
          parentID: merging.parentID,
          diagnostic: merge.diagnostic,
        })
        const conflictState = conflicted && collaborationState(conflicted)
        if (!conflictState) return yield* Effect.die("PR queue entry lacks collaboration metadata")
        return { type: "conflict", state: { ...conflictState, conflictPaths: merge.paths }, abortSucceeded: aborted.exitCode === 0 } as const
      }
      const aborted = yield* git.abortMerge(input.parentDirectory)
      const failed = yield* queue.conflictMerge({
        id: merging.id,
        parentID: merging.parentID,
        diagnostic: merge.diagnostic,
      })
      const failedState = failed && collaborationState(failed)
      if (!failedState) return yield* Effect.die("PR queue entry lacks collaboration metadata")
      return {
        type: "failed",
        state: { ...failedState, status: "merge-failed" },
        abortSucceeded: aborted.exitCode === 0,
      } as const
    }),
}
