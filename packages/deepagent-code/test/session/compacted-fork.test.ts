import { describe, expect } from "bun:test"
import { existsSync, unlinkSync } from "node:fs"
import path from "node:path"
import { Database } from "@deepagent-code/core/database/database"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import {
  SessionForkAdmissionTable,
  SessionForkIntentTable,
  SessionPromptEpochMessageTable,
} from "@deepagent-code/core/session/sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { MessageV2 } from "@/session/message-v2"
import { contextStoreRoot, loadForkOrigin } from "@/session/context-ledger"
import { Session } from "@/session/session"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// QUAL-007: the core SessionProjector is the canonical V1-event projection path (session/message/part
// rows); without it the minimal layer never materializes sessions created through events.
const it = testEffect(
  Layer.mergeAll(Session.defaultLayer.pipe(Layer.provide(SessionProjector.defaultLayer)), Database.defaultLayer),
)

const addUser = Effect.fn("CompactedForkTest.addUser")(function* (sessionID: SessionID, text?: string) {
  const sessions = yield* Session.Service
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
  })
  if (text) {
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: message.id,
      type: "text",
      text,
    })
  }
  return message.id
})

const addAssistant = Effect.fn("CompactedForkTest.addAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  text: string,
  summary = false,
) {
  const sessions = yield* Session.Service
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    time: { created: Date.now(), completed: Date.now() },
    parentID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "test",
    agent: "test",
    path: { cwd: "/", root: "/" },
    summary,
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
  return message.id
})

const fixture = Effect.fn("CompactedForkTest.fixture")(function* () {
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({})
  const retiredUser = yield* addUser(parent.id, "retired user")
  yield* addAssistant(parent.id, retiredUser, "retired assistant")
  const retainedUser = yield* addUser(parent.id, "retained user")
  yield* addAssistant(parent.id, retainedUser, "retained assistant")
  const marker = yield* addUser(parent.id)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: parent.id,
    messageID: marker,
    type: "compaction",
    auto: false,
    tail_start_id: retainedUser,
  })
  yield* addAssistant(parent.id, marker, "checkpoint summary", true)
  const currentUser = yield* addUser(parent.id, "current user")
  yield* addAssistant(parent.id, currentUser, "current assistant")
  return { sessions, parent, retiredUser, currentUser }
})

function visibleShape(messages: SessionV1.WithParts[]) {
  return messages.map((message) => ({
    role: message.info.role,
    summary: message.info.role === "assistant" ? message.info.summary : undefined,
    parts: message.parts.map((part) => ({
      type: part.type,
      text: part.type === "text" ? part.text : undefined,
      tail: part.type === "compaction" ? Boolean(part.tail_start_id) : undefined,
    })),
  }))
}

describe("Session compacted fork authority", () => {
  it.instance("clones only effective history into an independent child window", () =>
    Effect.gen(function* () {
      const data = yield* fixture()
      const parentProjection = yield* MessageV2.promptHistoryProjectionEffect(data.parent.id)
      const child = yield* data.sessions.fork({ sessionID: data.parent.id, intentID: "fork-test-effective" })
      const childProjection = yield* MessageV2.promptHistoryProjectionEffect(child.id)
      const childPhysical = (yield* MessageV2.stream(child.id)).reverse()

      expect(parentProjection.messages).toHaveLength(6)
      expect(childPhysical).toHaveLength(parentProjection.messages.length)
      expect(visibleShape(childProjection.messages)).toEqual(visibleShape(parentProjection.messages))
      expect(childProjection.window.windowID).not.toBe(parentProjection.window.windowID)
      expect(childProjection.window.firstWindowID).not.toBe(parentProjection.window.firstWindowID)
      expect(childProjection.epoch).toBe(1)
      expect(
        childProjection.messages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text.includes("retired")),
        ),
      ).toBe(false)

      const followup = yield* addUser(child.id, "child followup")
      const afterFollowup = yield* MessageV2.promptHistoryProjectionEffect(child.id)
      expect(afterFollowup.orderedMessageIDs).toContain(followup)
      expect(afterFollowup.orderedMessageIDs.slice(0, childProjection.messages.length)).toEqual(
        childProjection.orderedMessageIDs,
      )

      const retry = yield* data.sessions.fork({ sessionID: data.parent.id, intentID: "fork-test-effective" })
      expect(retry.id).toBe(child.id)
      const { db } = yield* Database.Service
      const replacement = yield* db
        .select({ message_id: SessionPromptEpochMessageTable.message_id })
        .from(SessionPromptEpochMessageTable)
        .where(eq(SessionPromptEpochMessageTable.session_id, child.id))
        .orderBy(SessionPromptEpochMessageTable.ordinal)
        .all()
        .pipe(Effect.orDie)
      expect(replacement.map((row) => row.message_id)).toEqual(childProjection.orderedMessageIDs)
      const intent = yield* db
        .select()
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.intent_id, "fork-test-effective"))
        .get()
        .pipe(Effect.orDie)
      expect(intent?.state).toBe("complete")
      expect(intent?.event_cursor).toBe(intent?.event_count)
      expect(intent?.side_effects_completed_at).not.toBeNull()
      const admission = yield* db
        .select()
        .from(SessionForkAdmissionTable)
        .where(eq(SessionForkAdmissionTable.intent_id, "fork-test-effective"))
        .get()
        .pipe(Effect.orDie)
      expect(admission).toMatchObject({
        state: "manifest_committed",
        source_session_id: data.parent.id,
        target_session_id: child.id,
      })
      const invalidCursor = yield* db
        .update(SessionForkIntentTable)
        .set({ event_cursor: (intent?.event_count ?? 0) + 1 })
        .where(eq(SessionForkIntentTable.intent_id, "fork-test-effective"))
        .run()
        .pipe(Effect.exit)
      expect(invalidCursor._tag).toBe("Failure")

      const invalidReceiptReset = yield* db
        .update(SessionForkIntentTable)
        .set({ side_effects_completed_at: null })
        .where(eq(SessionForkIntentTable.intent_id, "fork-test-effective"))
        .run()
        .pipe(Effect.exit)
      expect(invalidReceiptReset._tag).toBe("Failure")
      expect(loadForkOrigin(child.id)?.parentSessionID).toBe(data.parent.id)

      yield* data.sessions.remove(child.id)
      yield* data.sessions.remove(data.parent.id)
    }),
  )

  it.instance("recovers a complete fork after side-effect receipt commit fails", () =>
    Effect.gen(function* () {
      const data = yield* fixture()
      const { db } = yield* Database.Service
      const triggerName = "test_fork_side_effect_receipt_failure"
      yield* db.run(sql`
        CREATE TRIGGER ${sql.raw(triggerName)}
        BEFORE UPDATE OF side_effects_completed_at ON session_fork_intent
        WHEN NEW.intent_id = 'fork-test-receipt-recovery' AND NEW.side_effects_completed_at IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'test_side_effect_receipt_failure');
        END
      `)
      const failed = yield* data.sessions
        .fork({ sessionID: data.parent.id, intentID: "fork-test-receipt-recovery" })
        .pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      yield* db.run(sql`DROP TRIGGER ${sql.raw(triggerName)}`)

      const intent = yield* db
        .select()
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.intent_id, "fork-test-receipt-recovery"))
        .get()
        .pipe(Effect.orDie)
      expect(intent?.state).toBe("complete")
      expect(intent?.side_effects_completed_at).toBeNull()
      if (!intent) return
      const blocked = yield* data.sessions.assertRunnable(intent.target_session_id).pipe(Effect.exit)
      expect(blocked._tag).toBe("Failure")
      const originPath = path.join(contextStoreRoot(intent.target_session_id), "fork-origin.json")
      if (existsSync(originPath)) unlinkSync(originPath)
      yield* data.sessions.recoverForks()
      const recovered = yield* db
        .select()
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.intent_id, "fork-test-receipt-recovery"))
        .get()
        .pipe(Effect.orDie)
      expect(recovered?.side_effects_completed_at).not.toBeNull()
      expect(loadForkOrigin(intent.target_session_id)?.parentSessionID).toBe(data.parent.id)
      yield* data.sessions.assertRunnable(intent.target_session_id)

      yield* data.sessions.remove(intent.target_session_id)
      yield* data.sessions.remove(data.parent.id)
    }),
  )

  it.instance("coalesces concurrent retries for the same fork intent", () =>
    Effect.gen(function* () {
      const data = yield* fixture()
      const children = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          data.sessions.fork({ sessionID: data.parent.id, intentID: "fork-test-concurrent-retry" }),
        ),
        { concurrency: "unbounded" },
      )

      expect(new Set(children.map((child) => child.id)).size).toBe(1)
      const projection = yield* MessageV2.promptHistoryProjectionEffect(children[0]!.id)
      expect(visibleShape(projection.messages)).toEqual(
        visibleShape((yield* MessageV2.promptHistoryProjectionEffect(data.parent.id)).messages),
      )

      yield* data.sessions.remove(children[0]!.id)
      yield* data.sessions.remove(data.parent.id)
    }),
  )

  it.instance("isolates concurrent fork intents into distinct child lineages", () =>
    Effect.gen(function* () {
      const data = yield* fixture()
      const [left, right] = yield* Effect.all(
        [
          data.sessions.fork({ sessionID: data.parent.id, intentID: "fork-test-lineage-left" }),
          data.sessions.fork({ sessionID: data.parent.id, intentID: "fork-test-lineage-right" }),
        ],
        { concurrency: "unbounded" },
      )
      const [leftProjection, rightProjection] = yield* Effect.all([
        MessageV2.promptHistoryProjectionEffect(left.id),
        MessageV2.promptHistoryProjectionEffect(right.id),
      ])

      expect(left.id).not.toBe(right.id)
      expect(leftProjection.window.windowID).not.toBe(rightProjection.window.windowID)
      expect(leftProjection.window.firstWindowID).not.toBe(rightProjection.window.firstWindowID)
      const leftMessageIDs = new Set(leftProjection.messages.map((message) => message.info.id))
      expect(rightProjection.messages.every((message) => !leftMessageIDs.has(message.info.id))).toBe(true)
      expect(visibleShape(leftProjection.messages)).toEqual(visibleShape(rightProjection.messages))

      yield* data.sessions.remove(left.id)
      yield* data.sessions.remove(right.id)
      yield* data.sessions.remove(data.parent.id)
    }),
  )

  it.instance("rejects conflicting inputs that race on one fork intent", () =>
    Effect.gen(function* () {
      const data = yield* fixture()
      const outcomes = yield* Effect.all(
        [
          data.sessions.fork({ sessionID: data.parent.id, intentID: "fork-test-concurrent-conflict" }),
          data.sessions.fork({
            sessionID: data.parent.id,
            intentID: "fork-test-concurrent-conflict",
            messageID: data.currentUser,
          }),
        ].map((operation) =>
          operation.pipe(
            Effect.match({
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            }),
          ),
        ),
        { concurrency: "unbounded" },
      )
      const succeeded = outcomes.filter((outcome) => outcome.ok)
      const failed = outcomes.filter((outcome) => !outcome.ok)

      expect(succeeded).toHaveLength(1)
      expect(failed).toHaveLength(1)
      expect(failed[0]?.error).toBeInstanceOf(Session.ForkConflict)
      if (!failed[0] || failed[0].ok) return
      if (!(failed[0].error instanceof Session.ForkConflict)) return
      expect(failed[0].error.reason).toContain("different input")

      yield* data.sessions.remove(succeeded[0]!.value.id)
      yield* data.sessions.remove(data.parent.id)
    }),
  )

  it.instance("rejects retired cutoffs and conflicting intent reuse", () =>
    Effect.gen(function* () {
      const data = yield* fixture()
      const retired = yield* Effect.flip(
        data.sessions.fork({
          sessionID: data.parent.id,
          intentID: "fork-test-retired-cutoff",
          messageID: data.retiredUser,
        }),
      )
      expect(retired).toBeInstanceOf(Session.ForkConflict)
      if (!(retired instanceof Session.ForkConflict)) throw retired
      expect(retired.reason).toContain("cutoff")

      const child = yield* data.sessions.fork({ sessionID: data.parent.id, intentID: "fork-test-conflict" })
      const conflict = yield* Effect.flip(
        data.sessions.fork({
          sessionID: data.parent.id,
          intentID: "fork-test-conflict",
          messageID: data.currentUser,
        }),
      )
      expect(conflict).toBeInstanceOf(Session.ForkConflict)
      if (!(conflict instanceof Session.ForkConflict)) throw conflict
      expect(conflict.reason).toContain("reused")

      yield* data.sessions.remove(child.id)
      yield* data.sessions.remove(data.parent.id)
    }),
  )

  it.instance("forks at an active cutoff without splitting the checkpoint or parent chain", () =>
    Effect.gen(function* () {
      const data = yield* fixture()
      const child = yield* data.sessions.fork({
        sessionID: data.parent.id,
        intentID: "fork-test-active-cutoff",
        messageID: data.currentUser,
      })
      const projection = yield* MessageV2.promptHistoryProjectionEffect(child.id)

      expect(projection.epoch).toBe(1)
      expect(projection.messages).toHaveLength(4)
      expect(projection.messages[0]?.info.role).toBe("user")
      expect(projection.messages[1]?.info.role).toBe("assistant")
      expect(projection.messages[1]?.info.role === "assistant" && projection.messages[1].info.summary).toBe(true)
      expect(
        projection.messages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text.includes("current")),
        ),
      ).toBe(false)
      const messageIDs = new Set(projection.messages.map((message) => message.info.id))
      expect(
        projection.messages.every(
          (message) => message.info.role !== "assistant" || messageIDs.has(message.info.parentID),
        ),
      ).toBe(true)

      yield* data.sessions.remove(child.id)
      yield* data.sessions.remove(data.parent.id)
    }),
  )
})
