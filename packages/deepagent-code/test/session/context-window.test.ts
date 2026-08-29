import { describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import {
  PartTable,
  SessionForkAdmissionTable,
  SessionForkIntentTable,
  SessionHistoryStateTable,
  SessionPromptEpochMessageTable,
  SessionWorldStateBaselineTable,
} from "@deepagent-code/core/session/sql"
import { Effect, Layer } from "effect"
import { and, eq } from "drizzle-orm"
import { MessageV2 } from "@/session/message-v2"
import { SessionPromptEpochTable } from "@/session/prompt-epoch.sql"
import { Session } from "@/session/session"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// QUAL-007: the core SessionProjector materializes event-created sessions; without it message
// writes hit the session FK.
const it = testEffect(Layer.mergeAll(Session.defaultLayer, SessionProjector.defaultLayer, Database.defaultLayer))

const addUser = Effect.fn("ContextWindowTest.addUser")(function* (sessionID: SessionID, text: string) {
  const sessions = yield* Session.Service
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
  })
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: message.id,
    type: "text",
    text,
  })
  return { message, part }
})

const addSummary = Effect.fn("ContextWindowTest.addSummary")(function* (sessionID: SessionID, parentID: MessageID) {
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
    summary: true,
    cost: 0,
    tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: message.id,
    type: "text",
    text: "legacy summary",
  })
  return message
})

describe("Session context window authority", () => {
  it.instance("rejects cross-session checkpoint and window authority bindings", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const source = yield* sessions.create({})
      const target = yield* sessions.create({})
      const sourceUser = yield* addUser(source.id, "cross-session source")
      const { db } = yield* Database.Service

      const checkpointBinding = yield* db
        .insert(SessionPromptEpochTable)
        .values({
          session_id: target.id,
          epoch: 0,
          state: "active",
          checkpoint_user_id: sourceUser.message.id,
          checkpoint_assistant_id: null,
          retained_tail_start_id: null,
          source_end_message_id: null,
          checkpoint_hash: "cross-session-checkpoint",
          projection_version: 1,
          canonicalization_version: 1,
          base_message_count: 0,
          effective_history_hash: "cross-session-checkpoint",
          first_window_id: "target-invalid-first-window",
          previous_window_id: null,
          window_id: "target-invalid-window",
          world_state_baseline_hash: null,
          authority_state: "ready",
          recovery_reason: null,
          reason: "bootstrap",
          created_at: Date.now(),
          retired_at: null,
        })
        .run()
        .pipe(Effect.exit)
      expect(checkpointBinding._tag).toBe("Failure")

      const replacementBinding = yield* db
        .insert(SessionPromptEpochMessageTable)
        .values({
          session_id: target.id,
          prompt_epoch: 0,
          ordinal: 0,
          message_id: sourceUser.message.id,
        })
        .run()
        .pipe(Effect.exit)
      expect(replacementBinding._tag).toBe("Failure")

      const sourceProjection = yield* MessageV2.promptHistoryProjectionEffect(source.id)
      const targetProjection = yield* MessageV2.promptHistoryProjectionEffect(target.id)
      const windowBinding = yield* db
        .update(SessionPromptEpochTable)
        .set({ previous_window_id: sourceProjection.window.windowID })
        .where(and(eq(SessionPromptEpochTable.session_id, target.id), eq(SessionPromptEpochTable.state, "active")))
        .run()
        .pipe(Effect.exit)
      expect(windowBinding._tag).toBe("Failure")
      expect((yield* MessageV2.promptHistoryProjectionEffect(target.id)).window).toEqual(targetProjection.window)

      yield* sessions.remove(target.id)
      yield* sessions.remove(source.id)
    }),
  )

  it.instance("migrates a legacy compacted parent with a full World State baseline", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const legacy = yield* sessions.create({})
      yield* addUser(legacy.id, "retired")
      const marker = yield* addUser(legacy.id, "compact")
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: legacy.id,
        messageID: marker.message.id,
        type: "compaction",
        auto: false,
      })
      const summary = yield* addSummary(legacy.id, marker.message.id)

      const projection = yield* MessageV2.promptHistoryProjectionEffect(legacy.id)
      const worldState = yield* MessageV2.promptWorldStateProjectionEffect(legacy.id)
      const { db } = yield* Database.Service
      const rows = yield* db
        .select()
        .from(SessionWorldStateBaselineTable)
        .where(
          and(
            eq(SessionWorldStateBaselineTable.session_id, legacy.id),
            eq(SessionWorldStateBaselineTable.prompt_epoch, projection.epoch),
          ),
        )
        .all()
        .pipe(Effect.orDie)

      expect(projection.epoch).toBe(1)
      expect(worldState?.epoch).toBe(projection.epoch)
      expect(worldState?.windowID).toBe(projection.window.windowID)
      expect(worldState?.effectiveHistoryHash).toBe(projection.effectiveHistoryHash)
      expect(projection.messages.map((message) => message.info.id)).toEqual([marker.message.id, summary.id])
      expect(
        projection.messages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "retired"),
        ),
      ).toBe(false)
      expect(worldState?.rendered).toContain("<world-state>")
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.provenance === "legacy_migration")).toBe(true)

      yield* sessions.remove(legacy.id)
    }),
  )

  it.instance("rejects mutation of the committed replacement prefix", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({})
      yield* addUser(parent.id, "immutable source")
      const child = yield* sessions.fork({ sessionID: parent.id, intentID: "context-window-part-mutation" })
      const projection = yield* MessageV2.promptHistoryProjectionEffect(child.id)
      const text = projection.messages[0]?.parts.find((part) => part.type === "text")
      expect(text?.type).toBe("text")
      if (!text || text.type !== "text") return

      const { db } = yield* Database.Service
      const epochMutation = yield* db
        .update(SessionPromptEpochTable)
        .set({ checkpoint_hash: "tampered-binding" })
        .where(and(eq(SessionPromptEpochTable.session_id, child.id), eq(SessionPromptEpochTable.state, "active")))
        .run()
        .pipe(Effect.exit)
      expect(epochMutation._tag).toBe("Failure")
      const replacementMutation = yield* db
        .update(SessionPromptEpochMessageTable)
        .set({ ordinal: 1 })
        .where(
          and(
            eq(SessionPromptEpochMessageTable.session_id, child.id),
            eq(SessionPromptEpochMessageTable.prompt_epoch, projection.epoch),
          ),
        )
        .run()
        .pipe(Effect.exit)
      expect(replacementMutation._tag).toBe("Failure")
      const row = yield* db
        .select({ data: PartTable.data })
        .from(PartTable)
        .where(eq(PartTable.id, text.id))
        .get()
        .pipe(Effect.orDie)
      expect(row?.data.type).toBe("text")
      if (!row || row.data.type !== "text") return
      yield* db
        .update(PartTable)
        .set({ data: { ...row.data, text: "tampered after commit" } as typeof PartTable.$inferInsert.data })
        .where(eq(PartTable.id, text.id))
        .run()
        .pipe(Effect.orDie)

      const error = yield* Effect.flip(MessageV2.promptHistoryProjectionEffect(child.id))
      expect(error).toBeInstanceOf(MessageV2.HistoryAuthorityError)
      if (!(error instanceof MessageV2.HistoryAuthorityError)) return
      expect(error.reason).toContain("hash mismatch")
      const quarantinedEpoch = yield* db
        .select({
          authority_state: SessionPromptEpochTable.authority_state,
          recovery_reason: SessionPromptEpochTable.recovery_reason,
        })
        .from(SessionPromptEpochTable)
        .where(and(eq(SessionPromptEpochTable.session_id, child.id), eq(SessionPromptEpochTable.state, "active")))
        .get()
        .pipe(Effect.orDie)
      const quarantinedState = yield* db
        .select({ state: SessionHistoryStateTable.state, reason: SessionHistoryStateTable.reason })
        .from(SessionHistoryStateTable)
        .where(eq(SessionHistoryStateTable.session_id, child.id))
        .get()
        .pipe(Effect.orDie)
      expect(quarantinedEpoch).toMatchObject({
        authority_state: "recovery_required",
        recovery_reason: error.reason,
      })
      expect(quarantinedState).toEqual({ state: "recovery_required", reason: error.reason })
      const retry = yield* Effect.flip(MessageV2.promptHistoryProjectionEffect(child.id))
      expect(retry).toBeInstanceOf(MessageV2.HistoryAuthorityError)
      if (retry instanceof MessageV2.HistoryAuthorityError) expect(retry.reason).toBe(error.reason)

      yield* sessions.remove(child.id)
      yield* sessions.remove(parent.id)
    }),
  )

  it.instance("keeps prompt authority stable when asynchronous user summary metadata is updated", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const user = yield* addUser(session.id, "summary metadata is not prompt input")
      const before = yield* MessageV2.promptHistoryProjectionEffect(session.id)

      yield* sessions.updateMessage({
        ...user.message,
        summary: { diffs: [] },
      })

      const after = yield* MessageV2.promptHistoryProjectionEffect(session.id)
      expect(after.effectiveHistoryHash).toBe(before.effectiveHistoryHash)
      expect(after.window.windowID).toBe(before.window.windowID)
      expect(after.messages[0]?.info.summary).toEqual({ diffs: [] })

      yield* sessions.remove(session.id)
    }),
  )

  it.instance("fails closed when committed replacement membership is incomplete", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({})
      yield* addUser(parent.id, "replacement membership")
      const child = yield* sessions.fork({ sessionID: parent.id, intentID: "context-window-membership-missing" })
      const { db } = yield* Database.Service
      yield* db
        .delete(SessionPromptEpochMessageTable)
        .where(eq(SessionPromptEpochMessageTable.session_id, child.id))
        .run()
        .pipe(Effect.orDie)

      const error = yield* Effect.flip(MessageV2.promptHistoryProjectionEffect(child.id))
      expect(error).toBeInstanceOf(MessageV2.HistoryAuthorityError)
      if (!(error instanceof MessageV2.HistoryAuthorityError)) return
      expect(error.reason).toContain("membership is incomplete")
      const quarantined = yield* db
        .select({
          authority_state: SessionPromptEpochTable.authority_state,
          recovery_reason: SessionPromptEpochTable.recovery_reason,
        })
        .from(SessionPromptEpochTable)
        .where(and(eq(SessionPromptEpochTable.session_id, child.id), eq(SessionPromptEpochTable.state, "active")))
        .get()
        .pipe(Effect.orDie)
      expect(quarantined).toMatchObject({ authority_state: "recovery_required", recovery_reason: error.reason })

      yield* sessions.remove(child.id)
      yield* sessions.remove(parent.id)
    }),
  )

  it.instance("rejects a mutated World State baseline fragment", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({})
      yield* addUser(parent.id, "baseline source")
      const child = yield* sessions.fork({ sessionID: parent.id, intentID: "context-window-baseline-mutation" })
      const history = yield* MessageV2.promptHistoryProjectionEffect(child.id)
      const baseline = yield* MessageV2.promptWorldStateProjectionEffect(child.id)
      expect(baseline?.sections.length).toBeGreaterThan(0)
      const section = baseline?.sections[0]
      if (!section) return

      const { db } = yield* Database.Service
      yield* db
        .update(SessionWorldStateBaselineTable)
        .set({ fragment: `${section.fragment}\ncorrupt` })
        .where(
          and(
            eq(SessionWorldStateBaselineTable.session_id, child.id),
            eq(SessionWorldStateBaselineTable.prompt_epoch, history.epoch),
            eq(SessionWorldStateBaselineTable.section_id, section.sectionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)

      const error = yield* Effect.flip(MessageV2.promptWorldStateProjectionEffect(child.id))
      expect(error).toBeInstanceOf(MessageV2.HistoryAuthorityError)
      if (!(error instanceof MessageV2.HistoryAuthorityError)) return
      expect(error.reason).toContain("fragment hash mismatch")
      const quarantined = yield* db
        .select({
          authority_state: SessionPromptEpochTable.authority_state,
          recovery_reason: SessionPromptEpochTable.recovery_reason,
        })
        .from(SessionPromptEpochTable)
        .where(and(eq(SessionPromptEpochTable.session_id, child.id), eq(SessionPromptEpochTable.state, "active")))
        .get()
        .pipe(Effect.orDie)
      expect(quarantined).toMatchObject({ authority_state: "recovery_required", recovery_reason: error.reason })
      const quarantinedHistory = yield* Effect.flip(MessageV2.promptHistoryProjectionEffect(child.id))
      expect(quarantinedHistory).toBeInstanceOf(MessageV2.HistoryAuthorityError)
      if (quarantinedHistory instanceof MessageV2.HistoryAuthorityError) {
        expect(quarantinedHistory.reason).toBe(error.reason)
      }

      yield* sessions.remove(child.id)
      yield* sessions.remove(parent.id)
    }),
  )

  it.instance("accepts only a pristine current assistant at the provider dispatch boundary", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const user = yield* addUser(session.id, "provider boundary")
      const authority = yield* MessageV2.promptHistoryProjectionEffect(session.id)
      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(),
        sessionID: session.id,
        parentID: user.message.id,
        role: "assistant",
        mode: "build",
        agent: "build",
        path: { cwd: process.cwd(), root: process.cwd() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: Date.now() },
      }
      yield* sessions.updateMessage(assistant)

      expect(
        MessageV2.validateProviderPromptBoundary({
          authority,
          dispatch: yield* MessageV2.promptHistoryProjectionEffect(session.id),
          assistantMessageID: assistant.id,
          parentMessageID: user.message.id,
        }),
      ).toBeUndefined()

      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: assistant.id,
        type: "text",
        text: "unexpected pre-dispatch output",
      })
      expect(
        MessageV2.validateProviderPromptBoundary({
          authority,
          dispatch: yield* MessageV2.promptHistoryProjectionEffect(session.id),
          assistantMessageID: assistant.id,
          parentMessageID: user.message.id,
        }),
      ).toBe("current assistant draft is no longer pristine")

      yield* sessions.remove(session.id)
    }),
  )

  it.instance("quarantines a legacy task child whose sanitation cannot be proven", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const legacy = yield* sessions.create({
        metadata: {
          deepagent: {
            task_fork_manifest: {
              runID: "legacy-task-run",
              state: "complete",
            },
          },
        },
      })
      yield* addUser(legacy.id, "legacy copied context")

      const error = yield* Effect.flip(MessageV2.promptHistoryProjectionEffect(legacy.id))
      expect(error).toBeInstanceOf(MessageV2.HistoryAuthorityError)
      const { db } = yield* Database.Service
      const state = yield* db
        .select()
        .from(SessionHistoryStateTable)
        .where(eq(SessionHistoryStateTable.session_id, legacy.id))
        .get()
        .pipe(Effect.orDie)
      expect(state?.state).toBe("recovery_required")
      expect(state?.reason).toContain("legacy task fork")

      yield* sessions.remove(legacy.id)
    }),
  )

  it.instance("blocks a legacy fork before a new prompt can mutate physical history", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const legacy = yield* sessions.create({
        metadata: { forkedFrom: { parentSessionID: "ses_legacy_parent", forkedAt: Date.now() } },
      })

      const blocked = yield* sessions.assertRunnable(legacy.id).pipe(Effect.exit)
      expect(blocked._tag).toBe("Failure")
      expect((yield* sessions.messages({ sessionID: legacy.id })).length).toBe(0)

      yield* sessions.remove(legacy.id)
    }),
  )

  it.instance("quarantines a bootstrapped legacy task child instead of legalizing its raw history", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const legacy = yield* sessions.create({
        metadata: { deepagent: { task_fork_manifest: { runID: "legacy-bootstrapped-task" } } },
      })
      yield* addUser(legacy.id, "legacy physical task history")
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionPromptEpochTable)
        .values({
          session_id: legacy.id,
          epoch: 0,
          state: "active",
          checkpoint_user_id: null,
          checkpoint_assistant_id: null,
          retained_tail_start_id: null,
          source_end_message_id: null,
          checkpoint_hash: null,
          projection_version: null,
          canonicalization_version: null,
          base_message_count: null,
          effective_history_hash: null,
          first_window_id: null,
          previous_window_id: null,
          window_id: null,
          world_state_baseline_hash: null,
          authority_state: "legacy_pending",
          recovery_reason: null,
          reason: "bootstrap",
          created_at: Date.now(),
          retired_at: null,
        })
        .run()
        .pipe(Effect.orDie)

      const error = yield* Effect.flip(MessageV2.promptHistoryProjectionEffect(legacy.id))
      expect(error).toBeInstanceOf(MessageV2.HistoryAuthorityError)
      const epoch = yield* db
        .select()
        .from(SessionPromptEpochTable)
        .where(and(eq(SessionPromptEpochTable.session_id, legacy.id), eq(SessionPromptEpochTable.state, "active")))
        .get()
        .pipe(Effect.orDie)
      expect(epoch?.authority_state).toBe("recovery_required")
      expect(epoch?.recovery_reason).toContain("legacy task fork")

      yield* sessions.remove(legacy.id)
    }),
  )

  it.instance("quarantines a legacy foreground fork without a verifiable source projection", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const legacy = yield* sessions.create({
        metadata: { forkedFrom: { parentSessionID: "ses_legacy_parent", forkedAt: Date.now() } },
      })
      yield* addUser(legacy.id, "legacy copied physical history")

      const error = yield* Effect.flip(MessageV2.promptHistoryProjectionEffect(legacy.id))
      expect(error).toBeInstanceOf(MessageV2.HistoryAuthorityError)
      const { db } = yield* Database.Service
      const state = yield* db
        .select()
        .from(SessionHistoryStateTable)
        .where(eq(SessionHistoryStateTable.session_id, legacy.id))
        .get()
        .pipe(Effect.orDie)
      expect(state?.state).toBe("recovery_required")
      expect(state?.reason).toContain("legacy foreground fork")

      yield* sessions.remove(legacy.id)
    }),
  )

  it.instance("migrates a verifiable legacy foreground fork with post-fork child history", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const source = yield* sessions.create({})
      const first = yield* addUser(source.id, "legacy copied prefix")
      const cutoff = yield* addUser(source.id, "parent cutoff")
      const child = yield* sessions.create({
        metadata: {
          forkedFrom: {
            parentSessionID: source.id,
            cutoffMessageID: cutoff.message.id,
            forkedAt: Date.now() - 10,
          },
        },
      })
      const clonedMessage = yield* sessions.updateMessage({
        ...first.message,
        id: MessageID.ascending(),
        sessionID: child.id,
      })
      yield* sessions.updatePart({
        ...first.part,
        id: PartID.ascending(),
        messageID: clonedMessage.id,
        sessionID: child.id,
      })
      yield* addUser(child.id, "child-only continuation")

      yield* sessions.assertRunnable(child.id)

      const { db } = yield* Database.Service
      const intent = yield* db
        .select()
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.target_session_id, child.id))
        .get()
        .pipe(Effect.orDie)
      const admission = yield* db
        .select()
        .from(SessionForkAdmissionTable)
        .where(eq(SessionForkAdmissionTable.target_session_id, child.id))
        .get()
        .pipe(Effect.orDie)
      const projection = yield* MessageV2.promptHistoryProjectionEffect(child.id)
      const metadata = (yield* sessions.get(child.id)).metadata?.forkedFrom as Record<string, unknown> | undefined

      expect(intent?.state).toBe("complete")
      expect(intent?.event_count).toBe(0)
      expect(intent?.event_cursor).toBe(0)
      expect(intent?.side_effects_completed_at).not.toBeNull()
      expect(intent?.cloned_message_count).toBe(1)
      expect(admission?.state).toBe("manifest_committed")
      expect(metadata?.manifestState).toBe("complete")
      expect(projection.messages.filter((message) => message.info.role === "user")).toHaveLength(2)
      expect(
        projection.messages.flatMap((message) =>
          message.parts.filter((part) => part.type === "text").map((part) => part.text),
        ),
      ).toEqual(["legacy copied prefix", "child-only continuation"])

      // A later process may need to rebuild the authority rows after the manifest is complete.
      // The durable intent and side-effect receipt must be sufficient to authorize that rebuild.
      yield* db
        .delete(SessionPromptEpochMessageTable)
        .where(eq(SessionPromptEpochMessageTable.session_id, child.id))
        .run()
      yield* db
        .delete(SessionWorldStateBaselineTable)
        .where(eq(SessionWorldStateBaselineTable.session_id, child.id))
        .run()
      yield* db.delete(SessionPromptEpochTable).where(eq(SessionPromptEpochTable.session_id, child.id)).run()
      yield* db.delete(SessionHistoryStateTable).where(eq(SessionHistoryStateTable.session_id, child.id)).run()
      const rebuilt = yield* MessageV2.promptHistoryProjectionEffect(child.id)
      expect(rebuilt.worldStateBaselineHash).toBeDefined()

      yield* sessions.remove(child.id)
      yield* sessions.remove(source.id)
    }),
  )

  it.instance("rejects a legacy foreground fork whose copied prefix changed", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const source = yield* sessions.create({})
      yield* addUser(source.id, "authoritative source")
      const cutoff = yield* addUser(source.id, "parent cutoff")
      const child = yield* sessions.create({
        metadata: {
          forkedFrom: {
            parentSessionID: source.id,
            cutoffMessageID: cutoff.message.id,
            forkedAt: Date.now() - 10,
          },
        },
      })
      yield* addUser(child.id, "tampered child prefix")

      const error = yield* sessions.assertRunnable(child.id).pipe(Effect.flip)
      const { db } = yield* Database.Service
      const intent = yield* db
        .select({ intent_id: SessionForkIntentTable.intent_id })
        .from(SessionForkIntentTable)
        .where(eq(SessionForkIntentTable.target_session_id, child.id))
        .get()
        .pipe(Effect.orDie)

      expect(error).toBeInstanceOf(Session.UnavailableError)
      expect(error.reason).toContain("prefix does not match")
      expect(intent).toBeUndefined()

      yield* sessions.remove(child.id)
      yield* sessions.remove(source.id)
    }),
  )
})
