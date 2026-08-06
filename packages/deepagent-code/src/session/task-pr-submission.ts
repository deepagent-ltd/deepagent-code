import { Effect } from "effect"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { DEFAULT_WORKER_IDENTITY } from "@/agent/collaboration-identity"
import { coordinator } from "@/agent/pr-collaboration"
import { PRQueue } from "@/agent/pr-queue"
import { Git } from "@/git"
import { MessageID, SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"

export type SubmittedPR = {
  readonly id: string
  readonly workerCommit: string
}

export const submitAutomaticWorktree = Effect.fn("TaskPRSubmission.submitAutomaticWorktree")(function* (input: {
  git: Git.Interface
  queue: PRQueue.Interface
  info: Worktree.Info
  parentDirectory: string
  parentSessionID: SessionID
  workerSessionID: SessionID
  reviewerSessionID: SessionID
  batchID: MessageID
  prID: string
  description: string
  prompt: string
}) {
  const workerDirectory = FSUtil.resolve(input.info.directory)
  const status = yield* input.git.porcelainStatus(workerDirectory)
  if (!status) {
    return yield* Effect.fail(new Error(`Unable to inspect automatic worktree at ${workerDirectory}`))
  }
  const existing = (yield* input.queue.list()).find(
    (entry) =>
      entry.parentID === input.parentSessionID &&
      entry.workerID === input.workerSessionID &&
      !["merged", "conflicted", "rejected", "superseded"].includes(entry.status),
  )
  if (existing?.workerHead && ["awaiting_review", "approved", "merging"].includes(existing.status)) {
    const workerHead = yield* input.git.resolveRef(workerDirectory)
    if (status.clean && workerHead === existing.workerHead) {
      return { id: existing.id, workerCommit: existing.workerHead } satisfies SubmittedPR
    }
    return yield* Effect.fail(
      new Error(
        `PR ${existing.id} is already ${existing.status}, but the worker has unsubmitted changes; worker preserved at ${workerDirectory}`,
      ),
    )
  }
  if (existing && !["draft", "changes_requested"].includes(existing.status)) {
    return yield* Effect.fail(
      new Error(`PR ${existing.id} is already ${existing.status}; worker preserved at ${workerDirectory}`),
    )
  }
  const id = existing?.id ?? input.prID
  if (!existing) {
    const admitted = yield* coordinator
      .admit({
        id,
        parentID: input.parentSessionID,
        workerID: input.workerSessionID,
        reviewerID: input.reviewerSessionID,
        parentDirectory: input.parentDirectory,
        workerDirectory,
        metadata: { batchID: input.batchID, description: input.description, prompt: input.prompt },
      })
      .pipe(Effect.provideService(Git.Service, input.git), Effect.provideService(PRQueue.Service, input.queue))
    if (admitted.type !== "admitted") {
      return yield* Effect.fail(
        new Error(`PR admission failed (${admitted.reason}); worker preserved at ${workerDirectory}`),
      )
    }
  }
  const committed = yield* coordinator
    .commitWorker({
      id,
      workerID: input.workerSessionID,
      paths: status.paths,
      message: `chore(deepagent): submit ${input.description.replace(/\s+/g, " ").trim().slice(0, 100) || "subagent work"}`,
      identity: DEFAULT_WORKER_IDENTITY,
    })
    .pipe(Effect.provideService(Git.Service, input.git), Effect.provideService(PRQueue.Service, input.queue))
  if (committed.type === "committed") {
    if (committed.state.workerCommit) {
      return { id, workerCommit: committed.state.workerCommit } satisfies SubmittedPR
    }
    return yield* Effect.fail(new Error(`PR submission did not produce a worker commit for ${id}`))
  }
  if (committed.reason === "no-changes" && (!existing || existing.status === "draft")) {
    yield* input.queue.supersede(id)
    return undefined
  }
  return yield* Effect.fail(
    new Error(`PR submission failed (${committed.reason}); worker preserved at ${workerDirectory}`),
  )
})

export * as TaskPRSubmission from "./task-pr-submission"
