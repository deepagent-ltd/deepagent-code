/**
 * Task fork adapter.
 *
 * Task forks deliberately use the same Session.fork authority as foreground forks. The adapter only
 * supplies task identity, child location and the versioned sanitation mode; it must not maintain a
 * second raw MessageTable clone protocol.
 */

import { Data, Effect } from "effect"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "./session"

export class ForkManifestConflictError extends Data.TaggedError("TaskFork.ManifestConflict")<{
  readonly childSessionID: SessionID
  readonly reason: string
}> {}

export type ForkManifest = {
  readonly manifestVersion: number
  readonly forkIntentID: string
  readonly forkMode: "task"
  readonly parentSessionID: SessionID
  readonly sourcePromptEpoch: number
  readonly sourceWindowID: string
  readonly sourceEffectiveHistoryHash: string
  readonly targetPromptEpoch: number
  readonly targetWindowID: string
  readonly targetEffectiveHistoryHash: string
  readonly targetWorldStateBaselineHash: string
  readonly sanitationPolicyVersion: number
  readonly manifestState: "prepared" | "complete"
}

export function forkForTask(input: {
  readonly runID: string
  readonly childSessionID: SessionID
  readonly parentSessionID: SessionID
  readonly cutoffMessageID: string
  readonly requestHash: string
  readonly childDepth: number
  readonly childDirectory: string
}) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const child = yield* sessions
      .fork({
        sessionID: input.parentSessionID,
        intentID: `task-fork:${input.runID}`,
        messageID: MessageID.make(input.cutoffMessageID),
        directory: input.childDirectory,
        forkMode: "task",
        targetSessionID: input.childSessionID,
        childDepth: input.childDepth,
        taskRequestHash: input.requestHash,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new ForkManifestConflictError({
              childSessionID: input.childSessionID,
              reason: error instanceof Session.ForkConflict ? error.reason : error.message,
            }),
        ),
      )
    if (child.id !== input.childSessionID) {
      return yield* new ForkManifestConflictError({
        childSessionID: input.childSessionID,
        reason: `fork authority returned unexpected child ${child.id}`,
      })
    }
    return child.id
  })
}

export * as TaskFork from "./task-fork"
