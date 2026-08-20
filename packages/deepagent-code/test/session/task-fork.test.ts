import { describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { SessionForkIntentTable } from "@deepagent-code/core/session/sql"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { TaskFork } from "@/session/task-fork"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// QUAL-007: the core SessionProjector is the canonical V1-event projection path (session/message/part
// rows); without it the minimal layer never materializes sessions created through events.
const it = testEffect(
  Layer.mergeAll(Session.defaultLayer.pipe(Layer.provide(SessionProjector.defaultLayer)), Database.defaultLayer),
)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }

const addUser = Effect.fn("TaskForkTest.addUser")(function* (
  sessionID: SessionID,
  text: string,
  source?: string,
  synthetic = source !== undefined,
) {
  const sessions = yield* Session.Service
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model,
    ...(source
      ? {
          metadata: {
            deepagent: {
              contextProvenance: {
                source,
                ownerSessionID: sessionID,
                ownerPromptEpoch: 0,
                durable: true,
              },
            },
          },
        }
      : {}),
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: message.id,
    type: "text",
    text,
    synthetic,
  })
  return message.id
})

const addAssistant = Effect.fn("TaskForkTest.addAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  text: string,
) {
  const sessions = yield* Session.Service
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    time: { created: Date.now(), completed: Date.now() },
    parentID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "test",
    agent: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: message.id,
    type: "text",
    text,
  })
})

describe("TaskFork durable authority", () => {
  it.instance("sanitizes parent runtime context and adopts an exact retry", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({})
      const first = yield* addUser(parent.id, "real user intent")
      yield* addAssistant(parent.id, first, "real assistant response")
      yield* addUser(parent.id, "parent runtime continuation", "compaction_continue")
      yield* addUser(parent.id, "legacy synthetic runtime hint", undefined, true)
      const current = yield* addUser(parent.id, "current user intent")
      const sessionsForParts = yield* Session.Service
      yield* sessionsForParts.updatePart({
        id: PartID.ascending(),
        sessionID: parent.id,
        messageID: current,
        type: "text",
        text: "mixed runtime reminder",
        synthetic: true,
      })
      yield* addAssistant(parent.id, current, "current assistant response")
      const cutoff = yield* addUser(parent.id, "task request boundary")
      const childSessionID = SessionID.descending()

      const childID = yield* TaskFork.forkForTask({
        runID: "task-run-authority",
        childSessionID,
        parentSessionID: parent.id,
        cutoffMessageID: cutoff,
        requestHash: "request-a",
        childDepth: 2,
        childDirectory: test.directory,
      })
      expect(childID).toBe(childSessionID)

      const child = yield* sessions.get(childID)
      const projection = yield* MessageV2.promptHistoryProjectionEffect(childID)
      const worldState = yield* MessageV2.promptWorldStateProjectionEffect(childID)
      const childIDs = new Set(projection.messages.map((message) => message.info.id))

      expect(child.parentID).toBe(parent.id)
      expect(worldState?.rendered).toContain("<world-state>")
      expect(
        projection.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.type === "text" &&
              (part.text.includes("runtime continuation") ||
                part.text.includes("legacy synthetic") ||
                part.text.includes("mixed runtime")),
          ),
        ),
      ).toBe(false)
      expect(
        projection.messages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "current user intent"),
        ),
      ).toBe(true)
      expect(
        projection.messages.every(
          (message) => message.info.role !== "assistant" || childIDs.has(message.info.parentID),
        ),
      ).toBe(true)

      const deepagent = child.metadata?.deepagent as Record<string, unknown>
      const manifest = deepagent.task_fork_manifest as Record<string, unknown>
      expect(deepagent.subagentDepth).toBe(2)
      expect(manifest.forkMode).toBe("task")
      expect(manifest.manifestState).toBe("complete")
      expect(manifest.sanitationPolicyVersion).toBe(3)

      const { db } = yield* Database.Service
      const intent = yield* db
        .select()
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.intent_id, "task-fork:task-run-authority"))
        .get()
        .pipe(Effect.orDie)
      expect(intent?.fork_mode).toBe("task")
      expect(intent?.target_session_id).toBe(childID)
      expect(intent?.target_world_state_baseline_hash).toBe(worldState?.hash)
      expect(intent?.sanitation_policy_version).toBe(3)
      expect(intent?.state).toBe("complete")
      expect(intent?.side_effects_completed_at).not.toBeNull()

      const retry = yield* TaskFork.forkForTask({
        runID: "task-run-authority",
        childSessionID,
        parentSessionID: parent.id,
        cutoffMessageID: cutoff,
        requestHash: "request-a",
        childDepth: 2,
        childDirectory: test.directory,
      })
      expect(retry).toBe(childID)

      const invalidRollback = yield* db
        .update(SessionForkIntentTable)
        .set({ state: "committed", event_cursor: 1, time_completed: null })
        .where(eq(SessionForkIntentTable.intent_id, "task-fork:task-run-authority"))
        .run()
        .pipe(Effect.exit)
      expect(invalidRollback._tag).toBe("Failure")
      yield* sessions.recoverForks()
      const recovered = yield* db
        .select()
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.intent_id, "task-fork:task-run-authority"))
        .get()
        .pipe(Effect.orDie)
      expect(recovered?.state).toBe("complete")
      expect(recovered?.event_cursor).toBe(recovered?.event_count)

      const conflict = yield* Effect.flip(
        TaskFork.forkForTask({
          runID: "task-run-authority",
          childSessionID,
          parentSessionID: parent.id,
          cutoffMessageID: cutoff,
          requestHash: "request-b",
          childDepth: 2,
          childDirectory: test.directory,
        }),
      )
      expect(conflict).toBeInstanceOf(TaskFork.ForkManifestConflictError)

      yield* sessions.remove(childID)
      yield* sessions.remove(parent.id)
    }),
  )
})
