import { describe, expect } from "bun:test"
import { ProjectScopeKey, SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { SessionProviderOwnerLeaseTable } from "@deepagent-code/core/context-federation/session-sql"
import { ProjectScopeIdentityTable, SecurityNamespaceTable } from "@deepagent-code/core/context-federation/sql"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { DeepAgentActivityAuthority } from "@deepagent-code/core/deepagent/index"
import {
  SessionActivityObjectiveTable,
  SessionActivityPermissionEffectDispatchTable,
} from "@deepagent-code/core/deepagent/activity-authority.sql"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ModelV2 } from "@deepagent-code/core/model"
import { Hash } from "@deepagent-code/core/util/hash"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import {
  MessageTable,
  PartTable,
  SessionInputTable,
  SessionIntentTable,
  SessionSteerTable,
  SessionTable,
} from "@deepagent-code/core/session/sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { MessageV2 } from "../../src/session/message-v2"
import { ContextActivationReceipt } from "../../src/context-federation/activation-receipt"
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
const namespace = SecurityNamespaceID.make("sec_prompt_intent_test")
const projectScope = ProjectScopeKey.make("prjctx_prompt_intent_test")
const releasedKnowledgeBinding = DeepAgentReleasedSnapshot.binding(undefined)
const providerOwnerToken = "prompt-intent-fixture"

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(SessionProviderOwnerLeaseTable)
    .values({
      owner_token: providerOwnerToken,
      registered_at: sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`,
      heartbeat_at: sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`,
      lease_expires_at: sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 31536000000`,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SecurityNamespaceTable)
    .values({ id: namespace, kind: "implicit_local", binding_hash: "prompt-intent-namespace", created_at: 1 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(ProjectScopeIdentityTable)
    .values({
      security_namespace_id: namespace,
      project_scope_key: projectScope,
      project_kind: "registered_root",
      project_identity_hash: "prompt-intent-project",
      observed_project_id: ProjectV2.ID.global,
      created_at: 1,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
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

  it.effect("an exact retry takes over an unexpired claim owned by a dead process", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({
        intentID: "intent_process_restart",
        messageID: MessageID.make("msg_process_restart"),
      })
      expect(first.kind).toBe("claimed")
      const { db } = yield* Database.Service
      yield* db
        .update(SessionIntentTable)
        .set({
          owner_token: "2147483647:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002",
          lease_expires_at: Date.now() + 30_000,
        })
        .where(eq(SessionIntentTable.intent_id, "intent_process_restart"))
        .run()
        .pipe(Effect.orDie)

      const retry = yield* claim({
        intentID: "intent_process_restart",
        messageID: MessageID.make("msg_process_restart_retry"),
      })
      expect(retry.kind).toBe("claimed")
      if (retry.kind !== "claimed") return
      expect(retry.receipt.messageID).toBe(MessageID.make("msg_process_restart"))
      expect(retry.receipt.ownerToken).not.toBe(first.kind === "claimed" ? first.receipt.ownerToken : undefined)
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
      yield* preparingProviderReceipt({
        db,
        receiptID: "receipt-absorbed-boundary",
        userMessageID: trigger.receipt.messageID,
        assistantMessageID: assistantID,
        registryToolIDs: [],
      })
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
      yield* settledProviderReceipt({
        db,
        receiptID: "receipt-question-rejected",
        userMessageID: trigger.receipt.messageID,
        assistantMessageID: assistantID,
        registryToolIDs: ["question"],
        permissionFilteredToolIDs: ["question"],
        finalOfferedToolIDs: ["question"],
        callIDs: ["call-question-rejected"],
        responseFingerprint: "response-question-rejected",
      })
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

  it.effect("a follow-up arriving after the provider boundary resumes the same finalizing run", () =>
    Effect.gen(function* () {
      yield* setup
      const trigger = yield* claim({
        intentID: "intent_finalizing_followup",
        messageID: MessageID.make("msg_finalizing_followup_user"),
      })
      if (trigger.kind !== "claimed") return
      const materialized = yield* SessionPromptIntent.materializeTurn({
        receipt: trigger.receipt,
        message: message(trigger.receipt.messageID),
      })
      if (!("run" in materialized) || !materialized.run) return
      const boundary = yield* SessionPromptIntent.freezeProviderInputBoundary(materialized.run)
      if (boundary.kind !== "ready") return

      const { db } = yield* Database.Service
      const assistantID = MessageID.make("msg_finalizing_followup_assistant")
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
            finish: "stop",
          } as typeof MessageTable.$inferInsert.data,
        })
        .run()
        .pipe(Effect.orDie)
      yield* settledProviderReceipt({
        db,
        receiptID: "receipt-finalizing-followup",
        userMessageID: trigger.receipt.messageID,
        assistantMessageID: assistantID,
        registryToolIDs: [],
        permissionFilteredToolIDs: [],
        finalOfferedToolIDs: [],
        callIDs: [],
        responseFingerprint: "response-finalizing-followup",
      })
      yield* SessionPromptIntent.beginProgress({
        activityID: materialized.run.activityID,
        assistantMessageID: assistantID,
        providerReceiptID: "receipt-finalizing-followup",
        membershipOrdinal: boundary.boundary.membershipOrdinal,
      })

      const steerID = SessionMessage.ID.make("msg_finalizing_followup_steer")
      const admissionID = "admission-finalizing-followup-steer"
      const steerClaim = yield* claim({
        intentID: "intent_finalizing_followup_steer",
        messageID: MessageID.make(steerID),
        source: "followup",
      })
      if (steerClaim.kind !== "claimed") return
      yield* db
        .insert(SessionSteerTable)
        .values({
          id: steerID,
          session_id: sessionID,
          correlation_id: steerID,
          prompt: Prompt.fromUserMessage({ text: "follow up" }),
          delivery: "steer",
          mutation_epoch: materialized.run.mutationEpoch,
          time_created: 3,
        })
        .run()
        .pipe(Effect.orDie)
      yield* SessionPromptIntent.complete({
        intentID: steerClaim.receipt.intentID,
        ownerToken: steerClaim.receipt.ownerToken,
        messageID: MessageID.make(steerID),
        delivery: "steer",
      })
      yield* db
        .insert(SessionActivityAdmissionTable) // fixture-exempt: seeds legacy-intent admission row for steer fixture
        .values({
          admission_id: admissionID,
          session_id: sessionID,
          source_kind: "legacy_intent",
          legacy_intent_id: steerClaim.receipt.intentID,
          admitted_message_id: steerID,
          delivery: "steer",
          payload_fingerprint_kind: "payload_hash",
          payload_fingerprint: "payload-a",
          execution_mode: "run_now",
          created_at: 3,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionLegacyActivityAdmissionTable)
        .values({
          activity_id: materialized.run.activityID,
          admission_id: admissionID,
          ordinal: boundary.boundary.membershipOrdinal + 1,
          role: "steer",
          attached_at: 3,
        })
        .run()
        .pipe(Effect.orDie)

      yield* SessionPromptIntent.markRunFinalizing(materialized.run)
      expect(
        yield* SessionPromptIntent.finalizeActivityWithRevision({
          run: materialized.run,
          assistantMessageID: assistantID,
          decision: {
            state: "settled",
            reasonCode: "provider_final",
            source: "provider_final",
            operationID: `${materialized.run.runID}:terminal`,
            ownerToken: materialized.run.ownerToken,
          },
        }),
      ).toEqual({ kind: "follow_up_required", membershipOrdinal: boundary.boundary.membershipOrdinal + 1 })
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityRunTable)
          .where(eq(SessionLegacyActivityRunTable.run_id, materialized.run.runID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "finalizing", activity_id: materialized.run.activityID })
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityTerminalTable)
          .where(eq(SessionLegacyActivityTerminalTable.activity_id, materialized.run.activityID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])

      yield* SessionPromptIntent.markRunRunning(materialized.run)
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityRunTable)
          .where(eq(SessionLegacyActivityRunTable.run_id, materialized.run.runID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "running", activity_id: materialized.run.activityID })
    }),
  )

  it.effect("direct interruption settles a monitoring objective with the legacy activity", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_interrupt", messageID: MessageID.make("msg_interrupt_user") })
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
      const current = yield* DeepAgentActivityAuthority.reconstruct({
        activityKind: "legacy",
        activityID: activity.activityID,
      })
      yield* DeepAgentActivityAuthority.configure({
        activityKind: "legacy",
        activityID: activity.activityID,
        expectedVersion: current.objective.version,
        objectiveText: "interrupt the monitored activity",
        completionCriteria: [{ kind: "plan_complete" }],
        enforcementState: "monitoring",
        stallThreshold: 2,
      })

      yield* SessionPromptIntent.interruptActivity(activity.activityID)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityTable)
          .where(eq(SessionLegacyActivityTable.activity_id, activity.activityID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "interrupted", terminal_reason: "aborted_before_provider_settlement" })
      expect(
        yield* db
          .select()
          .from(SessionActivityObjectiveTable)
          .where(eq(SessionActivityObjectiveTable.activity_id, activity.activityID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "interrupted", terminal_reason: "aborted_before_provider_settlement" })
    }),
  )

  it.effect("terminal provider receipts settle provisional progress deterministically after restart", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({ intentID: "intent_progress", messageID: MessageID.make("msg_progress_user") })
      expect(first.kind).toBe("claimed")
      if (first.kind !== "claimed") return
      const materialized = yield* SessionPromptIntent.materializeTurn({
        receipt: first.receipt,
        message: message(first.receipt.messageID),
      })
      if (!("run" in materialized) || !materialized.run) return
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
      yield* settledProviderReceipt({
        db,
        receiptID: "receipt-progress-final",
        userMessageID: first.receipt.messageID,
        assistantMessageID: assistantID,
        registryToolIDs: [],
        permissionFilteredToolIDs: [],
        finalOfferedToolIDs: [],
        callIDs: [],
        responseFingerprint: "response-final",
      })
      yield* SessionPromptIntent.beginProgress({
        activityID: activity.activityID,
        assistantMessageID: assistantID,
        providerReceiptID: "receipt-progress-final",
      })
      yield* SessionPromptIntent.markRunFinalizing(materialized.run)

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

  it.effect("restart activity recovery quarantines permission effects through the Core authority", () =>
    Effect.gen(function* () {
      yield* setup
      const first = yield* claim({
        intentID: "intent_permission_recovery",
        messageID: MessageID.make("msg_permission_recovery_user"),
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
      yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({
        ownerID: "prompt-recovery-old-owner",
        leaseMs: 60_000,
      })
      const permissionRequest = yield* DeepAgentActivityAuthority.requestPermission({
        activityKind: "legacy",
        activityID: activity.activityID,
        requestID: "permission-prompt-recovery",
        requestKind: "tool",
        idempotencyKey: "permission-prompt-recovery-request",
        permission: "read",
        patterns: ["stable.ts"],
        alwaysPatterns: ["stable.ts"],
        metadata: {},
        tool: { messageID: "assistant-permission-recovery", callID: "call-permission-recovery" },
        ownerID: "prompt-recovery-old-owner",
      })
      yield* DeepAgentActivityAuthority.decidePermission({
        requestID: permissionRequest.requestID,
        idempotencyKey: "permission-prompt-recovery-decision",
        decision: "approved_always",
        actorType: "user",
        actorID: "test-user",
      })
      yield* DeepAgentActivityAuthority.beginPermissionEffect({
        requestID: permissionRequest.requestID,
        toolName: "read",
        consumerID: "tool:assistant-permission-recovery:call-permission-recovery",
        idempotencyKey: "permission-prompt-recovery-effect",
        ownerID: "prompt-recovery-old-owner",
      })
      yield* DeepAgentActivityAuthority.releasePermissionOwner("prompt-recovery-old-owner")
      yield* DeepAgentActivityAuthority.heartbeatPermissionOwner({
        ownerID: "prompt-recovery-new-owner",
        leaseMs: 60_000,
      })
      const database = yield* Database.Service

      expect(
        yield* SessionPromptIntent.recoverActiveActivities("next-process-owner", (input) =>
          DeepAgentActivityAuthority.recoverActivity({
            activityKind: "legacy",
            ...input,
            recoveryOwnerID: "prompt-recovery-new-owner",
          }).pipe(Effect.provideService(Database.Service, database), Effect.orDie),
        ),
      ).toEqual([{ activityID: activity.activityID, sessionID }])
      const { db } = database
      expect(
        yield* db
          .select({ state: SessionActivityPermissionEffectDispatchTable.state })
          .from(SessionActivityPermissionEffectDispatchTable)
          .where(eq(SessionActivityPermissionEffectDispatchTable.request_id, permissionRequest.requestID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "unknown" })
      expect(
        yield* db
          .select({ state: SessionLegacyActivityTable.state })
          .from(SessionLegacyActivityTable)
          .where(eq(SessionLegacyActivityTable.activity_id, activity.activityID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "recovery_required" })
      expect(
        yield* db
          .select({ state: SessionActivityObjectiveTable.state })
          .from(SessionActivityObjectiveTable)
          .where(eq(SessionActivityObjectiveTable.activity_id, activity.activityID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "recovery_required" })
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
        const current = yield* DeepAgentActivityAuthority.reconstruct({
          activityKind: "legacy",
          activityID: activity.activityID,
        })
        yield* DeepAgentActivityAuthority.configure({
          activityKind: "legacy",
          activityID: activity.activityID,
          expectedVersion: current.objective.version,
          objectiveText: "recover the monitored tool activity",
          completionCriteria: [{ kind: "plan_complete" }],
          enforcementState: "monitoring",
          stallThreshold: 2,
        })
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
        yield* settledProviderReceipt({
          db,
          receiptID: "receipt-progress-tool",
          userMessageID: first.receipt.messageID,
          assistantMessageID: assistantID,
          registryToolIDs: ["read"],
          permissionFilteredToolIDs: ["read"],
          finalOfferedToolIDs: ["read"],
          callIDs: ["call-progress-tool"],
          responseFingerprint: "response-progress-tool",
        })
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
      yield* preparingProviderReceipt({
        db,
        receiptID: "receipt-reasoning-projection",
        userMessageID: first.receipt.messageID,
        assistantMessageID: assistantID,
        registryToolIDs: [],
      })
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

function settledProviderReceipt(input: {
  readonly db: Database.Interface["db"]
  readonly receiptID: string
  readonly userMessageID: MessageID
  readonly assistantMessageID: MessageID
  readonly registryToolIDs: readonly string[]
  readonly permissionFilteredToolIDs: readonly string[]
  readonly finalOfferedToolIDs: readonly string[]
  readonly callIDs: readonly string[]
  readonly responseFingerprint: string
}) {
  return Effect.gen(function* () {
    yield* preparingProviderReceipt(input)
    const sealed = yield* input.db
      .update(SessionToolRequestReceiptTable)
      .set({
        permission_filtered_tool_ids: [...input.permissionFilteredToolIDs],
        adapter_tool_capability: "supported",
        adapter_lowering_outcome: "ok",
        released_knowledge_selected_refs: [],
        released_knowledge_selected_refs_fingerprint: releasedKnowledgeBinding.exactRefsFingerprint,
      })
      .where(
        and(
          eq(SessionToolRequestReceiptTable.receipt_id, input.receiptID),
          eq(SessionToolRequestReceiptTable.provider_state, "preparing"),
        ),
      )
      .returning({ receiptID: SessionToolRequestReceiptTable.receipt_id })
      .get()
      .pipe(Effect.orDie)
    if (!sealed) return yield* Effect.die(`selected refs seal lost: ${input.receiptID}`)
    yield* transitionProviderReceipt({
      db: input.db,
      receiptID: input.receiptID,
      from: "preparing",
      to: "prepared",
      values: {
        final_request_hash: Hash.sha256(`request-${input.receiptID}`),
        provider_request_hash: Hash.sha256(`request-${input.receiptID}`),
        final_offered_tool_ids: [...input.finalOfferedToolIDs],
        tool_definition_hash: Hash.sha256(`tools-${input.receiptID}`),
        prepared_turn_hash: Hash.sha256(`prepared-turn-${input.receiptID}`),
        system_stable_hash: Hash.sha256(`system-stable-${input.receiptID}`),
        system_volatile_hash: Hash.sha256(`system-volatile-${input.receiptID}`),
        wire_request_hash: Hash.sha256(`request-${input.receiptID}`),
        tool_result_reference_ids: [],
        tool_result_reference_count: 0,
        adapter_prepared_at: 3,
      },
    })
    yield* transitionProviderReceipt({
      db: input.db,
      receiptID: input.receiptID,
      from: "prepared",
      to: "dispatching",
      values: { request_state: "dispatched", dispatching_at: 4 },
    })
    yield* transitionProviderReceipt({
      db: input.db,
      receiptID: input.receiptID,
      from: "dispatching",
      to: "streaming",
      values: { streaming_at: 5 },
    })
    yield* transitionProviderReceipt({
      db: input.db,
      receiptID: input.receiptID,
      from: "streaming",
      to: "settled",
      values: {
        call_ids: [...input.callIDs],
        terminal_at: 6,
        response_fingerprint: input.responseFingerprint,
      },
    })
  })
}

function preparingProviderReceipt(input: {
  readonly db: Database.Interface["db"]
  readonly receiptID: string
  readonly userMessageID: MessageID
  readonly assistantMessageID: MessageID
  readonly registryToolIDs: readonly string[]
}) {
  return input.db
    .insert(SessionToolRequestReceiptTable) // fixture-exempt: seeds preparing receipt for prompt-intent fixture
    .values({
      receipt_id: input.receiptID,
      request_ordinal: 1,
      session_id: sessionID,
      user_message_id: input.userMessageID,
      assistant_message_id: input.assistantMessageID,
      context_eligibility: contextEligibility,
      context_readiness: contextReadiness,
      context_activation: contextActivation,
      context_activation_fingerprint: contextActivationFingerprint,
      released_knowledge_security_namespace_id: namespace,
      released_knowledge_project_scope_key: projectScope,
      released_knowledge_binding_state: releasedKnowledgeBinding.state,
      released_knowledge_exact_refs: releasedKnowledgeBinding.exactRefs,
      released_knowledge_exact_refs_fingerprint: releasedKnowledgeBinding.exactRefsFingerprint,
      provider_id: "test",
      model_id: "test",
      protocol: "test",
      registry_tool_ids: [...input.registryToolIDs],
      permission_filtered_tool_ids: [],
      final_offered_tool_ids: [],
      call_ids: [],
      adapter_tool_capability: "unknown",
      prompt_epoch: 0,
      prompt_window_id: `window-${input.receiptID}`,
      effective_history_hash: `history-${input.receiptID}`,
      request_input_hash: `input-${input.receiptID}`,
      response_chain_reuse_decision: "not_supported",
      response_chain_refusal_reason: "fixture_path_not_stateful",
      provider_state: "preparing",
      owner_token: providerOwnerToken,
      request_state: "prepared",
      created_at: 2,
    })
    .run()
    .pipe(Effect.orDie)
}

function transitionProviderReceipt(input: {
  readonly db: Database.Interface["db"]
  readonly receiptID: string
  readonly from: typeof SessionToolRequestReceiptTable.$inferSelect.provider_state
  readonly to: typeof SessionToolRequestReceiptTable.$inferSelect.provider_state
  readonly values: Partial<typeof SessionToolRequestReceiptTable.$inferInsert>
}) {
  return input.db
    .update(SessionToolRequestReceiptTable)
    .set({ ...input.values, provider_state: input.to })
    .where(
      and(
        eq(SessionToolRequestReceiptTable.receipt_id, input.receiptID),
        eq(SessionToolRequestReceiptTable.provider_state, input.from),
      ),
    )
    .returning({ receiptID: SessionToolRequestReceiptTable.receipt_id })
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((updated) =>
        updated ? Effect.void : Effect.die(`provider receipt transition lost: ${input.receiptID}: ${input.from}`),
      ),
    )
}

const contextEligibility = ContextFederationRollout.resolveProject(
  ContextFederationRollout.resolve(
    {
      contextFederationShadow: false,
      locationIndexesV2Shadow: false,
      contextProjectionV2: false,
      contextQueryToolsV2: false,
      coreV2ExecutionOwner: false,
    },
    { coreV2ParityVerified: false },
  ),
  projectScope,
  { stage: "all", percentage: 100, internalProjectScopeKeys: [], killSwitch: false },
)
const contextReadiness = {
  ...ContextFederationRollout.READINESS_READY_STUB,
  revision: "readiness-prompt-intent",
  projectScopeKey: projectScope,
  observedAt: 1,
}
const contextDecision = ContextFederationRollout.activate(contextEligibility, contextReadiness)
const contextActivation = ContextActivationReceipt.make({
  readiness: contextReadiness,
  decision: contextDecision,
  recordedAt: 2,
  projectionEnabled: false,
  toolsEnabled: false,
})
const contextActivationFingerprint = ContextActivationReceipt.fingerprint({
  eligibility: contextEligibility,
  readiness: contextReadiness,
  activation: contextActivation,
})
