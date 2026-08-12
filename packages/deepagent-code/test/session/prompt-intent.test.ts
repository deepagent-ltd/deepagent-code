import { describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import {
  MessageTable,
  PartTable,
  SessionInputTable,
  SessionIntentTable,
  SessionSteerTable,
  SessionTable,
} from "@deepagent-code/core/session/sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionMutationEpoch } from "../../src/session/mutation-epoch"
import { SessionPromptIntent } from "../../src/session/prompt-intent"
import {
  SessionActivityAdmissionTable,
  SessionActivityProgressTable,
  SessionLegacyActivityAdmissionTable,
  SessionLegacyActivityRunTable,
  SessionLegacyActivityTable,
  SessionLegacyActivityTerminalTable,
} from "../../src/session/activity-sql"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionToolRequestReceiptTable } from "../../src/session/tool-request-receipt.sql"
import { testEffect } from "../lib/effect"

const database = Database.layerFromPath(":memory:")
const it = testEffect(database)
const sessionID = SessionID.make("ses_prompt_intent_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectV2.ID.global,
      slug: "intent-test",
      directory: "/project",
      title: "intent-test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const claim = (input: {
  intentID: string
  messageID: MessageID
  variant?: SessionPromptIntent.Variant
  payloadHash?: string
  source?: SessionPromptIntent.Source
  executionMode?: SessionPromptIntent.ExecutionMode
}) =>
  SessionPromptIntent.claim({
    intentID: input.intentID,
    sessionID,
    source: input.source ?? "composer",
    variant: input.variant ?? "original",
    payloadHash: input.payloadHash ?? "payload-a",
    messageID: input.messageID,
    executionMode: input.executionMode,
  })

const message = (messageID: MessageID): { info: SessionV1.User; parts: SessionV1.Part[] } => ({
  info: {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
  },
  parts: [
    {
      id: PartID.make(`prt_${messageID}`),
      messageID,
      sessionID,
      type: "text",
      text: "atomic prompt",
    },
  ],
})

describe("SessionPromptIntent", () => {
  it.effect("exact retry with a different transport message ID returns the original admission", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_exact", messageID: MessageID.make("msg_exact_first") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      yield* SessionPromptIntent.complete({
        intentID: first.receipt.intentID,
        ownerToken: first.receipt.ownerToken,
        messageID: first.receipt.messageID,
        delivery: "turn",
      })

      const retry = yield* claim({ intentID: "intent_exact", messageID: MessageID.make("msg_exact_retry") })
      expect(retry.kind).toBe("admitted")
      expect(String(retry.receipt.messageID)).toBe("msg_exact_first")
    }),
  )

  it.effect("a concurrent claimant cannot execute the same intent", () =>
    Effect.gen(function* () {
      yield* setup
      yield* claim({ intentID: "intent_in_progress", messageID: MessageID.make("msg_in_progress") })
      const error = yield* claim({
        intentID: "intent_in_progress",
        messageID: MessageID.make("msg_other_transport"),
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionPromptIntent.InProgress)
    }),
  )

  it.effect("variant or payload changes conflict instead of creating a second admission", () =>
    Effect.gen(function* () {
      yield* setup
      yield* SessionPromptIntent.prepare({ intentID: "intent_variant", sessionID, source: "intelligence" })
      yield* claim({
        intentID: "intent_variant",
        messageID: MessageID.make("msg_variant"),
        source: "intelligence",
      })
      const error = yield* claim({
        intentID: "intent_variant",
        messageID: MessageID.make("msg_variant_retry"),
        source: "intelligence",
        variant: "rewritten",
        payloadHash: "payload-b",
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionPromptIntent.Conflict)
    }),
  )

  it.effect("different intents may admit identical payloads", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_same_text_a", messageID: MessageID.make("msg_same_a") })
      const second = yield* claim({ intentID: "intent_same_text_b", messageID: MessageID.make("msg_same_b") })
      expect(first.kind).toBe("claimed")
      expect(second.kind).toBe("claimed")
      const { db } = yield* Database.Service
      const rows = yield* db.select().from(SessionIntentTable).all().pipe(Effect.orDie)
      expect(rows.filter((row) => row.intent_id.startsWith("intent_same_text_"))).toHaveLength(2)
    }),
  )

  it.effect("direct message, parts, and admitted receipt commit atomically and ACK retry is exact", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_atomic", messageID: MessageID.make("msg_atomic") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      const admitted = yield* SessionPromptIntent.materializeTurn({
        receipt: first.receipt,
        message: message(first.receipt.messageID),
      })
      expect(admitted.state).toBe("admitted")
      yield* SessionPromptIntent.complete({
        intentID: first.receipt.intentID,
        ownerToken: first.receipt.ownerToken,
        messageID: first.receipt.messageID,
        delivery: "turn",
      })

      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.id, first.receipt.messageID))
          .get()
          .pipe(Effect.orDie),
      ).toBeDefined()
      expect(
        yield* db
          .select()
          .from(PartTable)
          .where(eq(PartTable.message_id, first.receipt.messageID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      const retry = yield* claim({ intentID: "intent_atomic", messageID: MessageID.make("msg_atomic_retry") })
      expect(retry.kind).toBe("admitted")
      expect(retry.receipt.messageID).toBe(first.receipt.messageID)
      expect(yield* db.select().from(SessionActivityAdmissionTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* db.select().from(SessionLegacyActivityAdmissionTable).all().pipe(Effect.orDie)).toMatchObject([
        { ordinal: 0, role: "trigger" },
      ])
      expect(
        (yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).filter(
          (row) => String(row.id) === String(first.receipt.messageID),
        ),
      ).toHaveLength(0)
    }),
  )

  it.effect("deferred admission creates no Activity until an explicit resume claims exactly one run", () =>
    Effect.gen(function* () {
      yield* setup
      const deferred = yield* claim({
        intentID: "intent_deferred_resume",
        messageID: MessageID.make("msg_deferred_resume"),
        executionMode: "deferred",
      })
      expect(deferred.kind).toBe("claimed")
      if (deferred.kind !== "claimed") return
      const materialized = yield* SessionPromptIntent.materializeTurn({
        receipt: deferred.receipt,
        message: message(deferred.receipt.messageID),
        executionMode: "deferred",
      })
      expect(materialized.executionMode).toBe("deferred")
      expect("run" in materialized).toBeFalse()

      const { db } = yield* Database.Service
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(
        yield* db
          .select()
          .from(SessionIntentTable)
          .where(eq(SessionIntentTable.intent_id, deferred.receipt.intentID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ execution_mode: "deferred", execution_state: "pending", execution_claim_id: null })

      const run = yield* SessionPromptIntent.claimDeferredActivity({
        sessionID,
        messageID: deferred.receipt.messageID,
      })
      expect(run).toBeDefined()
      if (!run) return
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toMatchObject([
        { run_id: run.runID, activity_id: run.activityID, state: "running" },
      ])
      expect(yield* db.select().from(SessionLegacyActivityAdmissionTable).all().pipe(Effect.orDie)).toMatchObject([
        { activity_id: run.activityID, ordinal: 0, role: "trigger" },
      ])
      expect(
        yield* db
          .select()
          .from(SessionIntentTable)
          .where(eq(SessionIntentTable.intent_id, deferred.receipt.intentID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ execution_state: "claimed", execution_claim_id: run.runID })
      expect(
        yield* SessionPromptIntent.claimDeferredActivity({ sessionID, messageID: deferred.receipt.messageID }),
      ).toBeUndefined()
    }),
  )

  it.effect("a normal run absorbs deferred context and freezes its membership ordinal into progress", () =>
    Effect.gen(function* () {
      yield* setup
      const deferred = yield* claim({
        intentID: "intent_deferred_absorbed",
        messageID: MessageID.make("msg_deferred_absorbed"),
        executionMode: "deferred",
      })
      if (deferred.kind !== "claimed") return
      yield* SessionPromptIntent.materializeTurn({
        receipt: deferred.receipt,
        message: message(deferred.receipt.messageID),
        executionMode: "deferred",
      })

      const trigger = yield* claim({
        intentID: "intent_run_absorbs_deferred",
        messageID: MessageID.make("msg_run_absorbs_deferred"),
        executionMode: "run_now",
      })
      if (trigger.kind !== "claimed") return
      const materialized = yield* SessionPromptIntent.materializeTurn({
        receipt: trigger.receipt,
        message: message(trigger.receipt.messageID),
        executionMode: "run_now",
      })
      expect("run" in materialized).toBeTrue()
      if (!("run" in materialized)) return

      const { db } = yield* Database.Service
      expect(yield* db.select().from(SessionLegacyActivityAdmissionTable).all().pipe(Effect.orDie)).toMatchObject([
        { activity_id: materialized.run.activityID, ordinal: 0, role: "trigger" },
        { activity_id: materialized.run.activityID, ordinal: 1, role: "deferred_context" },
      ])
      expect(
        yield* db
          .select()
          .from(SessionIntentTable)
          .where(eq(SessionIntentTable.intent_id, deferred.receipt.intentID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ execution_state: "absorbed", execution_claim_id: materialized.run.runID })

      const boundary = yield* SessionPromptIntent.freezeProviderInputBoundary(materialized.run)
      expect(boundary).toMatchObject({ kind: "ready", boundary: { membershipOrdinal: 1 } })
      if (boundary.kind !== "ready") return
      const assistantID = MessageID.make("msg_absorbed_progress_assistant")
      yield* db
        .insert(MessageTable)
        .values({
          id: assistantID,
          session_id: sessionID,
          time_created: 2,
          data: {
            role: "assistant",
            parentID: trigger.receipt.messageID,
            mode: "build",
            agent: "build",
            path: { cwd: "/project", root: "/project" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("test"),
            providerID: ProviderV2.ID.make("test"),
            time: { created: 2 },
          } as typeof MessageTable.$inferInsert.data,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionToolRequestReceiptTable)
        .values({
          receipt_id: "receipt-absorbed-boundary",
          request_ordinal: 1,
          session_id: sessionID,
          user_message_id: trigger.receipt.messageID,
          assistant_message_id: assistantID,
          provider_id: "test",
          model_id: "test",
          registry_tool_ids: [],
          permission_filtered_tool_ids: [],
          final_offered_tool_ids: [],
          call_ids: [],
          provider_state: "preparing",
          request_state: "prepared",
          created_at: 2,
        })
        .run()
        .pipe(Effect.orDie)
      yield* SessionPromptIntent.beginProgress({
        activityID: materialized.run.activityID,
        assistantMessageID: assistantID,
        providerReceiptID: "receipt-absorbed-boundary",
        membershipOrdinal: boundary.boundary.membershipOrdinal,
      })
      expect(
        yield* db
          .select()
          .from(SessionActivityProgressTable)
          .where(eq(SessionActivityProgressTable.assistant_message_id, assistantID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ input_membership_ordinal: 1, state: "provisional" })
    }),
  )

  it.effect("typed question rejection atomically terminalizes a progress revision and exact-replays", () =>
    Effect.gen(function* () {
      yield* setup
      const trigger = yield* claim({
        intentID: "intent_question_rejected",
        messageID: MessageID.make("msg_question_rejected_user"),
      })
      if (trigger.kind !== "claimed") return
      const materialized = yield* SessionPromptIntent.materializeTurn({
        receipt: trigger.receipt,
        message: message(trigger.receipt.messageID),
      })
      if (!("run" in materialized)) return
      const boundary = yield* SessionPromptIntent.freezeProviderInputBoundary(materialized.run)
      if (boundary.kind !== "ready") return

      const { db } = yield* Database.Service
      const assistantID = MessageID.make("msg_question_rejected_assistant")
      yield* db
        .insert(MessageTable)
        .values({
          id: assistantID,
          session_id: sessionID,
          time_created: 2,
          data: {
            role: "assistant",
            parentID: trigger.receipt.messageID,
            mode: "build",
            agent: "build",
            path: { cwd: "/project", root: "/project" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("test"),
            providerID: ProviderV2.ID.make("test"),
            time: { created: 2, completed: 3 },
            finish: "tool-calls",
          } as typeof MessageTable.$inferInsert.data,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionToolRequestReceiptTable)
        .values({
          receipt_id: "receipt-question-rejected",
          request_ordinal: 1,
          session_id: sessionID,
          user_message_id: trigger.receipt.messageID,
          assistant_message_id: assistantID,
          provider_id: "test",
          model_id: "test",
          registry_tool_ids: ["question"],
          permission_filtered_tool_ids: ["question"],
          final_offered_tool_ids: ["question"],
          call_ids: ["call-question-rejected"],
          provider_state: "settled",
          terminal_at: 3,
          response_fingerprint: "response-question-rejected",
          request_state: "dispatched",
          created_at: 2,
        })
        .run()
        .pipe(Effect.orDie)
      yield* SessionPromptIntent.beginProgress({
        activityID: materialized.run.activityID,
        assistantMessageID: assistantID,
        providerReceiptID: "receipt-question-rejected",
        membershipOrdinal: boundary.boundary.membershipOrdinal,
      })
      const decision = {
        state: "interrupted" as const,
        reasonCode: "user_rejected_question",
        source: "host_stop" as const,
        operationID: `${materialized.run.runID}:terminal`,
        ownerToken: materialized.run.ownerToken,
      }

      expect(
        yield* SessionPromptIntent.finalizeActivityWithRevision({
          run: materialized.run,
          assistantMessageID: assistantID,
          decision,
        }),
      ).toMatchObject({ kind: "terminal_committed" })
      expect(
        yield* db
          .select()
          .from(SessionActivityProgressTable)
          .where(eq(SessionActivityProgressTable.assistant_message_id, assistantID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "progress", input_membership_ordinal: 0 })
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityTable)
          .where(eq(SessionLegacyActivityTable.activity_id, materialized.run.activityID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "interrupted", terminal_reason: "user_rejected_question" })
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityRunTable)
          .where(eq(SessionLegacyActivityRunTable.run_id, materialized.run.runID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "interrupted", terminal_reason: "user_rejected_question" })
      expect(yield* db.select().from(SessionLegacyActivityTerminalTable).all().pipe(Effect.orDie)).toMatchObject([
        {
          activity_id: materialized.run.activityID,
          run_id: materialized.run.runID,
          state: "interrupted",
          reason_code: "user_rejected_question",
          membership_ordinal: 0,
        },
      ])
      expect(
        yield* SessionPromptIntent.finalizeActivityWithRevision({
          run: materialized.run,
          assistantMessageID: assistantID,
          decision,
        }),
      ).toMatchObject({ kind: "exact_replay" })
      const divergent = yield* SessionPromptIntent.finalizeActivityWithRevision({
        run: materialized.run,
        assistantMessageID: assistantID,
        decision: { ...decision, reasonCode: "different_reason" },
      }).pipe(Effect.exit)
      expect(Exit.isFailure(divergent)).toBeTrue()
    }),
  )

  it.effect("host-only terminal exact-replays and rejects divergent ordinal or payload", () =>
    Effect.gen(function* () {
      yield* setup
      const trigger = yield* claim({
        intentID: "intent_host_only_terminal",
        messageID: MessageID.make("msg_host_only_terminal"),
      })
      if (trigger.kind !== "claimed") return
      const materialized = yield* SessionPromptIntent.materializeTurn({
        receipt: trigger.receipt,
        message: message(trigger.receipt.messageID),
      })
      if (!("run" in materialized) || !materialized.run) return
      const boundary = yield* SessionPromptIntent.freezeProviderInputBoundary(materialized.run)
      if (boundary.kind !== "ready") return
      const decision = {
        state: "failed" as const,
        reasonCode: "structured_finalizer_unsupported",
        source: "host_stop" as const,
        operationID: `${materialized.run.runID}:terminal`,
        ownerToken: materialized.run.ownerToken,
      }

      expect(
        yield* SessionPromptIntent.finalizeActivityWithoutRevision({
          run: materialized.run,
          membershipOrdinal: boundary.boundary.membershipOrdinal,
          decision,
        }),
      ).toMatchObject({ kind: "terminal_committed" })
      expect(
        yield* SessionPromptIntent.finalizeActivityWithoutRevision({
          run: materialized.run,
          membershipOrdinal: boundary.boundary.membershipOrdinal,
          decision,
        }),
      ).toMatchObject({ kind: "exact_replay" })
      expect(
        Exit.isFailure(
          yield* SessionPromptIntent.finalizeActivityWithoutRevision({
            run: materialized.run,
            membershipOrdinal: boundary.boundary.membershipOrdinal + 1,
            decision,
          }).pipe(Effect.exit),
        ),
      ).toBeTrue()
      expect(
        Exit.isFailure(
          yield* SessionPromptIntent.finalizeActivityWithoutRevision({
            run: materialized.run,
            membershipOrdinal: boundary.boundary.membershipOrdinal,
            decision: { ...decision, reasonCode: "different_reason" },
          }).pipe(Effect.exit),
        ),
      ).toBeTrue()
    }),
  )

  it.effect("terminal provider receipts settle provisional progress deterministically after restart", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_progress", messageID: MessageID.make("msg_progress_user") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      yield* SessionPromptIntent.materializeTurn({
        receipt: first.receipt,
        message: message(first.receipt.messageID),
      })
      const activity = yield* SessionPromptIntent.activityForMessage({
        sessionID,
        messageID: first.receipt.messageID,
      })
      expect(activity?.state).toBe("active")
      if (!activity) return
      const { db } = yield* Database.Service
      const assistantID = MessageID.make("msg_progress_assistant")
      yield* db
        .insert(MessageTable)
        .values({
          id: assistantID,
          session_id: sessionID,
          time_created: 2,
          data: {
            role: "assistant",
            parentID: first.receipt.messageID,
            mode: "build",
            agent: "build",
            path: { cwd: "/project", root: "/project" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("test"),
            providerID: ProviderV2.ID.make("test"),
            time: { created: 2, completed: 3 },
            finish: "stop",
          } as typeof MessageTable.$inferInsert.data,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values([
          {
            id: PartID.make("prt_progress_preamble"),
            message_id: assistantID,
            session_id: sessionID,
            time_created: 2,
            data: { type: "text", text: "final preamble" } as typeof PartTable.$inferInsert.data,
          },
          {
            id: PartID.make("prt_progress_final"),
            message_id: assistantID,
            session_id: sessionID,
            time_created: 2,
            data: { type: "text", text: "final answer" } as typeof PartTable.$inferInsert.data,
          },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionToolRequestReceiptTable)
        .values({
          receipt_id: "receipt-progress-final",
          request_ordinal: 1,
          session_id: sessionID,
          user_message_id: first.receipt.messageID,
          assistant_message_id: assistantID,
          provider_id: "test",
          model_id: "test",
          registry_tool_ids: [],
          permission_filtered_tool_ids: [],
          final_offered_tool_ids: [],
          call_ids: [],
          provider_state: "settled",
          terminal_at: 3,
          response_fingerprint: "response-final",
          request_state: "dispatched",
          created_at: 2,
        })
        .run()
        .pipe(Effect.orDie)
      yield* SessionPromptIntent.beginProgress({
        activityID: activity.activityID,
        assistantMessageID: assistantID,
        providerReceiptID: "receipt-progress-final",
      })

      expect(yield* SessionPromptIntent.recoverActiveActivities()).toEqual([])
      expect(yield* SessionPromptIntent.recoverActiveActivities("next-process-owner")).toEqual([
        { activityID: activity.activityID, sessionID, assistantMessageID: assistantID },
      ])
      expect(
        yield* db
          .select()
          .from(SessionActivityProgressTable)
          .where(eq(SessionActivityProgressTable.assistant_message_id, assistantID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        state: "final",
        text_part_id: expect.stringMatching(/^prt_progress_/),
        response_fingerprint: "response-final",
      })
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityTable)
          .where(eq(SessionLegacyActivityTable.activity_id, activity.activityID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "recovery_required", terminal_reason: "host_terminal_decision_missing" })
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toMatchObject([
        { state: "recovery_required", terminal_reason: "host_terminal_decision_missing" },
      ])
      expect(yield* db.select().from(SessionLegacyActivityTerminalTable).all().pipe(Effect.orDie)).toMatchObject([
        {
          activity_id: activity.activityID,
          state: "recovery_required",
          reason_code: "host_terminal_decision_missing",
          source: "restart_recovery",
          assistant_message_id: assistantID,
          progress_revision: 0,
          membership_ordinal: 0,
        },
      ])
      expect(yield* SessionPromptIntent.recoverActiveActivities("next-process-owner")).toEqual([])
      expect(
        yield* db
          .select({ data: PartTable.data })
          .from(PartTable)
          .where(eq(PartTable.message_id, assistantID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: {
              deepagent_activity_progress: {
                activity_id: activity.activityID,
                revision: 0,
                state: "final",
              },
            },
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: {
              deepagent_activity_progress: {
                activity_id: activity.activityID,
                revision: 0,
                state: "final",
              },
            },
          }),
        }),
      ])
    }),
  )

  it.effect(
    "terminal tool progress becomes recovery-required after restart instead of leaving an orphan active owner",
    () =>
      Effect.gen(function* () {
        yield* setup
        const first = yield* claim({
          intentID: "intent_progress_tool",
          messageID: MessageID.make("msg_progress_tool_user"),
        })
        expect(first.kind).toBe("claimed")
        if (first.kind !== "claimed") return
        yield* SessionPromptIntent.materializeTurn({
          receipt: first.receipt,
          message: message(first.receipt.messageID),
        })
        const activity = yield* SessionPromptIntent.activityForMessage({
          sessionID,
          messageID: first.receipt.messageID,
        })
        expect(activity?.state).toBe("active")
        if (!activity) return
        const { db } = yield* Database.Service
        const assistantID = MessageID.make("msg_progress_tool_assistant")
        yield* db
          .insert(MessageTable)
          .values({
            id: assistantID,
            session_id: sessionID,
            time_created: 2,
            data: {
              role: "assistant",
              parentID: first.receipt.messageID,
              mode: "build",
              agent: "build",
              path: { cwd: "/project", root: "/project" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ModelV2.ID.make("test"),
              providerID: ProviderV2.ID.make("test"),
              time: { created: 2, completed: 3 },
              finish: "tool-calls",
            } as typeof MessageTable.$inferInsert.data,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(PartTable)
          .values({
            id: PartID.make("prt_progress_tool_text"),
            message_id: assistantID,
            session_id: sessionID,
            time_created: 2,
            data: { type: "text", text: "working" } as typeof PartTable.$inferInsert.data,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionToolRequestReceiptTable)
          .values({
            receipt_id: "receipt-progress-tool",
            request_ordinal: 1,
            session_id: sessionID,
            user_message_id: first.receipt.messageID,
            assistant_message_id: assistantID,
            provider_id: "test",
            model_id: "test",
            registry_tool_ids: ["read"],
            permission_filtered_tool_ids: ["read"],
            final_offered_tool_ids: ["read"],
            call_ids: ["call-progress-tool"],
            provider_state: "settled",
            terminal_at: 3,
            response_fingerprint: "response-progress-tool",
            request_state: "dispatched",
            created_at: 2,
          })
          .run()
          .pipe(Effect.orDie)
        yield* SessionPromptIntent.beginProgress({
          activityID: activity.activityID,
          assistantMessageID: assistantID,
          providerReceiptID: "receipt-progress-tool",
        })

        expect(yield* SessionPromptIntent.recoverActiveActivities("next-process-owner")).toEqual([
          { activityID: activity.activityID, sessionID, assistantMessageID: assistantID },
        ])
        expect(
          yield* db
            .select()
            .from(SessionActivityProgressTable)
            .where(eq(SessionActivityProgressTable.assistant_message_id, assistantID))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({ state: "progress", finish_observed: "tool-calls" })
        expect(
          yield* db
            .select()
            .from(SessionLegacyActivityTable)
            .where(eq(SessionLegacyActivityTable.activity_id, activity.activityID))
            .get()
            .pipe(Effect.orDie),
        ).toMatchObject({
          state: "recovery_required",
          terminal_reason: "host_terminal_decision_missing",
        })
        expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toMatchObject([
          { state: "recovery_required", terminal_reason: "host_terminal_decision_missing" },
        ])
        expect(yield* db.select().from(SessionLegacyActivityTerminalTable).all().pipe(Effect.orDie)).toMatchObject([
          {
            activity_id: activity.activityID,
            state: "recovery_required",
            reason_code: "host_terminal_decision_missing",
            source: "restart_recovery",
            assistant_message_id: assistantID,
            progress_revision: 0,
            membership_ordinal: 0,
          },
        ])
      }),
  )

  it.effect("projects reasoning-only progress from durable authority without persisting it in message JSON", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({
        intentID: "intent_reasoning_projection",
        messageID: MessageID.make("msg_reasoning_projection_user"),
      })
      if (first.kind !== "claimed") return
      yield* SessionPromptIntent.complete({
        intentID: first.receipt.intentID,
        ownerToken: first.receipt.ownerToken,
        messageID: first.receipt.messageID,
        delivery: "turn",
      })
      const activity = yield* SessionPromptIntent.activityForMessage({
        sessionID,
        messageID: first.receipt.messageID,
      })
      if (!activity) return
      const assistantID = MessageID.make("msg_reasoning_projection_assistant")
      const { db } = yield* Database.Service
      yield* db
        .insert(MessageTable)
        .values({
          id: assistantID,
          session_id: sessionID,
          time_created: 20,
          data: {
            role: "assistant",
            parentID: first.receipt.messageID,
            mode: "build",
            agent: "build",
            path: { cwd: "/project", root: "/project" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelV2.ID.make("test"),
            providerID: ProviderV2.ID.make("test"),
            time: { created: 20 },
          } as typeof MessageTable.$inferInsert.data,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values({
          id: PartID.make("prt_reasoning_projection"),
          message_id: assistantID,
          session_id: sessionID,
          time_created: 20,
          data: { type: "reasoning", text: "checking remote state" } as typeof PartTable.$inferInsert.data,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionToolRequestReceiptTable)
        .values({
          receipt_id: "receipt-reasoning-projection",
          request_ordinal: 1,
          session_id: sessionID,
          user_message_id: first.receipt.messageID,
          assistant_message_id: assistantID,
          provider_id: "test",
          model_id: "test",
          registry_tool_ids: [],
          permission_filtered_tool_ids: [],
          final_offered_tool_ids: [],
          call_ids: [],
          provider_state: "preparing",
          request_state: "prepared",
          created_at: 20,
        })
        .run()
        .pipe(Effect.orDie)
      yield* SessionPromptIntent.beginProgress({
        activityID: activity.activityID,
        assistantMessageID: assistantID,
        providerReceiptID: "receipt-reasoning-projection",
      })

      expect((yield* MessageV2.get({ sessionID, messageID: assistantID })).info).toMatchObject({
        activityProgress: { activityID: activity.activityID, revision: 0, state: "provisional" },
      })
      expect(
        (yield* MessageV2.page({ sessionID, limit: 10 })).items.find((item) => item.info.id === assistantID)?.info,
      ).toMatchObject({ activityProgress: { activityID: activity.activityID, revision: 0, state: "provisional" } })

      yield* SessionPromptIntent.interruptActivity(activity.activityID)
      expect((yield* MessageV2.get({ sessionID, messageID: assistantID })).info).toMatchObject({
        activityProgress: {
          activityID: activity.activityID,
          revision: 0,
          state: "interrupted",
          terminalReason: "aborted_before_provider_settlement",
        },
      })
      expect(
        (yield* db.select({ data: MessageTable.data }).from(MessageTable).where(eq(MessageTable.id, assistantID)).get())
          ?.data,
      ).not.toHaveProperty("activityProgress")
    }),
  )

  it.effect("a revert epoch prevents an old direct request from materializing any message", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_stale", messageID: MessageID.make("msg_stale") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ mutation_epoch: first.receipt.mutationEpoch + 1 })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const error = yield* SessionPromptIntent.materializeTurn({
        receipt: first.receipt,
        message: message(first.receipt.messageID),
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionMutationEpoch.Stale)
      expect(
        yield* db
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.id, first.receipt.messageID))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.effect("a conflicting message ID rolls back parts and keeps the intent unadmitted", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_conflict", messageID: MessageID.make("msg_conflict") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      const { db } = yield* Database.Service
      const conflict: typeof MessageTable.$inferInsert = {
        id: first.receipt.messageID,
        session_id: sessionID,
        data: {
          role: "user",
          time: { created: 1 },
          agent: "other",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        } as typeof MessageTable.$inferInsert.data,
      }
      yield* db.insert(MessageTable).values(conflict).run().pipe(Effect.orDie)
      const error = yield* SessionPromptIntent.materializeTurn({
        receipt: first.receipt,
        message: message(first.receipt.messageID),
      }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionPromptIntent.Conflict)
      expect(
        yield* db
          .select()
          .from(PartTable)
          .where(eq(PartTable.message_id, first.receipt.messageID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
      const intent = yield* db
        .select()
        .from(SessionIntentTable)
        .where(eq(SessionIntentTable.intent_id, first.receipt.intentID))
        .get()
        .pipe(Effect.orDie)
      expect(intent?.state).toBe("admitting")
    }),
  )

  it.effect("ACK-loss recovery reconciles the reserved direct message without re-execution", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_ack_loss", messageID: MessageID.make("msg_ack_loss") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      const { db } = yield* Database.Service
      const message: typeof MessageTable.$inferInsert = {
        id: first.receipt.messageID,
        session_id: sessionID,
        time_created: 1,
        data: {
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        } as typeof MessageTable.$inferInsert.data,
      }
      yield* db.insert(MessageTable).values(message).run().pipe(Effect.orDie)

      const retry = yield* claim({
        intentID: "intent_ack_loss",
        messageID: MessageID.make("msg_ack_loss_retry"),
      })
      expect(retry.kind).toBe("admitted")
      expect(String(retry.receipt.messageID)).toBe("msg_ack_loss")
    }),
  )

  it.effect("complete with goal_steer delivery stamps the correct delivery in the database", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_goal_steer", messageID: MessageID.make("msg_goal_steer") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      yield* SessionPromptIntent.complete({
        intentID: first.receipt.intentID,
        ownerToken: first.receipt.ownerToken,
        messageID: first.receipt.messageID,
        delivery: "goal_steer",
      })
      const { db } = yield* Database.Service
      const intent = yield* db
        .select()
        .from(SessionIntentTable)
        .where(eq(SessionIntentTable.intent_id, "intent_goal_steer"))
        .get()
        .pipe(Effect.orDie)
      expect(intent?.state).toBe("admitted")
      expect(intent?.delivery).toBe("goal_steer")
    }),
  )

  it.effect("complete with queue delivery stamps the correct delivery in the database", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_queue", messageID: MessageID.make("msg_queue") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      yield* SessionPromptIntent.complete({
        intentID: first.receipt.intentID,
        ownerToken: first.receipt.ownerToken,
        messageID: first.receipt.messageID,
        delivery: "queue",
      })
      const { db } = yield* Database.Service
      const intent = yield* db
        .select()
        .from(SessionIntentTable)
        .where(eq(SessionIntentTable.intent_id, "intent_queue"))
        .get()
        .pipe(Effect.orDie)
      expect(intent?.state).toBe("admitted")
      expect(intent?.delivery).toBe("queue")
    }),
  )
})
