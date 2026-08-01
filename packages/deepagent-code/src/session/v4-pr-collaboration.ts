export * as V4PRCollaboration from "./v4-pr-collaboration"

import { Effect } from "effect"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { KeyedMutex } from "@deepagent-code/core/effect/keyed-mutex"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { coordinator, ensureSessionBranch } from "@/agent/pr-collaboration"
import { PRQueue } from "@/agent/pr-queue"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Git } from "@/git"
import { InstanceStore } from "@/project/instance-store"
import type { CompletedTurn } from "./multi-agent-runtime"
import { Session } from "./session"
import { SessionID } from "./schema"
import { cleanupAgentWorktree, createAgentWorktree } from "./agent-worktree"

const parentLocks = KeyedMutex.makeUnsafe<SessionID>()

export const eventDirectory = (event: DeepAgentEvent.Event): string | undefined => {
  const directory = (event.payload as { directory?: unknown } | null)?.directory
  if (typeof directory === "string") return directory
  if (!event.workspaceID.startsWith("wrk")) return event.workspaceID
}

export const ensureEventParent = (input: {
  readonly sessions: Session.Interface
  readonly instanceStore: InstanceStore.Interface
  readonly parentSessionID: SessionID
  readonly directory: string
  readonly workspaceID?: WorkspaceV2.ID
  readonly correlationID?: string
}) =>
  parentLocks.withLock(input.parentSessionID)(
    Effect.gen(function* () {
      const context = yield* input.instanceStore.load({ directory: input.directory })
      const withContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(InstanceRef, context),
          Effect.provideService(WorkspaceRef, input.workspaceID),
        )
      const existing = yield* withContext(input.sessions.get(input.parentSessionID)).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      if (existing) return existing
      return yield* withContext(
        input.sessions.create({
          id: input.parentSessionID,
          title: `V4 event ${input.correlationID ?? input.parentSessionID}`,
          directory: input.directory,
          ...(input.workspaceID ? { workspaceID: input.workspaceID } : {}),
          metadata: {
            correlationID: input.correlationID,
            deepagent: { v4_event: { correlation_id: input.correlationID } },
          },
        }),
      )
    }),
  )

export interface Dependencies {
  readonly sessions: Session.Interface
  readonly instanceStore: InstanceStore.Interface
  readonly git: Git.Interface
  readonly queue: PRQueue.Interface
  readonly bus: DeepAgentEventBus.Interface
  readonly approvalQueue: ApprovalQueue.Interface
}

export const make = (deps: Dependencies) =>
  (input: {
    readonly event: DeepAgentEvent.Event
    readonly parentSessionID: SessionID
    readonly turns: ReadonlyArray<CompletedTurn>
  }) =>
    Effect.gen(function* () {
      const directory = eventDirectory(input.event)
      if (!directory) return
      const workspaceID = input.event.workspaceID.startsWith("wrk")
        ? WorkspaceV2.ID.make(input.event.workspaceID)
        : undefined
      yield* ensureEventParent({
        sessions: deps.sessions,
        instanceStore: deps.instanceStore,
        parentSessionID: input.parentSessionID,
        directory,
        workspaceID,
        correlationID: input.event.correlationID ?? input.event.id,
      })

      const failures: string[] = []
      const parentHead = yield* deps.git.resolveRef(directory)
      const candidates = parentHead
        ? yield* Effect.forEach(
            input.turns,
            (turn) =>
              Effect.gen(function* () {
                if (!turn.continuationRef || !turn.sessionID) {
                  if (turn.task.requiredAutonomy === "level_2") failures.push(`${turn.task.id}:continuation_missing`)
                  return undefined
                }
                const workerHead = yield* deps.git.resolveRef(directory, turn.continuationRef)
                if (!workerHead) {
                  failures.push(`${turn.task.id}:invalid_continuation`)
                  return undefined
                }
                const range = yield* deps.git.commitRange(directory, parentHead, workerHead)
                if (!range || range.commits.length === 0 || range.paths.length === 0) return undefined
                return { turn, workerID: turn.sessionID, workerHead }
              }),
            { concurrency: 1 },
          ).pipe(Effect.map((items) => items.filter((item): item is NonNullable<typeof item> => item !== undefined)))
        : []
      if (!parentHead) failures.push("parent_head_missing")

      const branchReady =
        candidates.length > 0 &&
        (yield* ensureSessionBranch({
          git: deps.git,
          directory,
          sessionID: input.parentSessionID,
        }).pipe(Effect.orElseSucceed(() => false)))
      if (candidates.length > 0 && !branchReady) failures.push("parent_branch_unavailable")
      const queued = branchReady
        ? yield* Effect.forEach(
            candidates,
            ({ turn, workerID, workerHead }) =>
              Effect.gen(function* () {
                const reviewerID = SessionID.make(
                  `ses_v4_reviewer_${input.event.id.replace(/^dae_/, "")}_${turn.task.id.replace(/[^a-zA-Z0-9]/g, "_")}`,
                )
                const id = `pr:v4:${input.event.id}:${turn.task.id}`
                const existing = yield* deps.queue.get(id)
                if (existing) {
                  if (
                    existing.parentID === input.parentSessionID &&
                    existing.workerID === workerID &&
                    existing.reviewerID === reviewerID &&
                    existing.metadata?.origin === "v4-event-runtime" &&
                    existing.metadata?.eventID === input.event.id &&
                    existing.metadata?.taskID === turn.task.id
                  ) {
                    return id
                  }
                  failures.push(`${turn.task.id}:duplicate_pr_identity`)
                  return
                }
                const worktree = yield* Effect.promise(() =>
                  createAgentWorktree({
                    eventDirectory: directory,
                    label: `v4-pr-${input.event.id}-${turn.task.id}`,
                    baseRef: workerHead,
                  }),
                )
                if (!worktree) {
                  failures.push(`${turn.task.id}:revision_worktree_unavailable`)
                  return
                }
                yield* deps.sessions.setDirectory({ sessionID: SessionID.make(workerID), directory: worktree.directory })
                const admitted = yield* coordinator
                  .admitCommitted({
                    id,
                    parentID: input.parentSessionID,
                    workerID,
                    reviewerID,
                    parentDirectory: directory,
                    workerDirectory: worktree.directory,
                    workerCommit: workerHead,
                    cleanupRequired: true,
                    metadata: {
                      origin: "v4-event-runtime",
                      batchID: input.event.id,
                      eventID: input.event.id,
                      taskID: turn.task.id,
                      description: turn.task.intent,
                      prompt: turn.task.intent,
                      continuationRef: workerHead,
                      revisionBranch: worktree.branch,
                    },
                  })
                  .pipe(
                    Effect.provideService(Git.Service, deps.git),
                    Effect.provideService(PRQueue.Service, deps.queue),
                  )
                if (admitted.type === "admitted") return id
                const cleaned = yield* Effect.promise(() => cleanupAgentWorktree(worktree))
                if (!cleaned) failures.push(`${turn.task.id}:revision_worktree_cleanup_failed`)
                if (admitted.reason !== "no-changes") failures.push(`${turn.task.id}:${admitted.reason}`)
              }),
            { concurrency: 1 },
          ).pipe(Effect.map((items) => items.filter((item): item is string => item !== undefined)))
        : []

      if (queued.length === 0 && failures.length === 0) return
      const escalation = yield* deps.bus.publish({
        type: "agent.task.needs_human",
        source: "system",
        workspaceID: input.event.workspaceID,
        ...(input.event.projectID ? { projectID: input.event.projectID } : {}),
        correlationID: input.event.correlationID ?? input.event.id,
        causationID: input.event.id,
        idempotencyKey: `v4-pr:${input.event.id}:review-ready`,
        priority: "high",
        payload: {
          taskID: input.event.id,
          agentID: "system",
          capability: "pr_finalize",
          intent: `Review and integrate V4 event ${input.event.id}`,
          reason: failures.length > 0 ? `pr_admission_failed:${failures.join(",")}` : "pr_review_required",
          parentSessionID: input.parentSessionID,
          prIDs: queued,
        },
      })
      yield* deps.approvalQueue.offer(escalation)
    })
