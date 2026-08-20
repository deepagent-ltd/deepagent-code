import { describe, expect } from "bun:test"
import { ProjectScopeKey, SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { SessionProviderOwnerLeaseTable } from "@deepagent-code/core/context-federation/session-sql"
import { ProjectScopeIdentityTable, SecurityNamespaceTable } from "@deepagent-code/core/context-federation/sql"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import turnStageEvidenceMigration from "@deepagent-code/core/database/migration/20260820120000_session_turn_stage_evidence"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { MessageTable, SessionTable } from "@deepagent-code/core/session/sql"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ContextActivationReceipt } from "../../src/context-federation/activation-receipt"
import {
  SessionLegacyActivityRunTable,
  SessionLegacyActivityTable,
  SessionLegacyActivityTerminalTable,
} from "../../src/session/activity-sql"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionPromptIntent } from "../../src/session/prompt-intent"
import { SessionToolRequestReceiptTable } from "../../src/session/tool-request-receipt.sql"
import { TurnDeadlineWatchdog } from "../../src/session/turn-deadline-watchdog"
import { TurnStageEvidence } from "../../src/session/turn-stage-evidence"
import { testEffect } from "../lib/effect"

const database = Database.layerFromPath(":memory:")
const it = testEffect(database)
const sessionID = SessionID.make("ses_turn_stage_evidence_test")
const namespace = SecurityNamespaceID.make("sec_turn_stage_evidence_test")
const projectScope = ProjectScopeKey.make("prjctx_turn_stage_evidence_test")
const providerOwnerToken = "turn-stage-evidence-fixture"
const releasedKnowledgeBinding = DeepAgentReleasedSnapshot.binding(undefined)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  // The stage-evidence migration ships unregistered (mainline registers it); apply it here.
  yield* DatabaseMigration.applyOnly(db, [turnStageEvidenceMigration])
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
    .values({ id: namespace, kind: "implicit_local", binding_hash: "stage-evidence-namespace", created_at: 1 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(ProjectScopeIdentityTable)
    .values({
      security_namespace_id: namespace,
      project_scope_key: projectScope,
      project_kind: "registered_root",
      project_identity_hash: "stage-evidence-project",
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
      slug: "stage-evidence",
      directory: "/project",
      title: "stage-evidence",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const claim = (input: { intentID: string; messageID: MessageID }) =>
  SessionPromptIntent.claim({
    intentID: input.intentID,
    sessionID,
    source: "composer",
    variant: "original",
    payloadHash: `payload-${input.intentID}`,
    messageID: input.messageID,
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

// Drives the durable state machine (claim -> materializeTurn) to a live activity + run,
// exactly like the provider-turn path does before its first stage-evidence write.
const liveActivity = (intentID: string) =>
  Effect.gen(function* () {
    const trigger = yield* claim({ intentID, messageID: MessageID.make(`msg_${intentID}`) })
    expect(trigger.kind).toBe("claimed")
    if (trigger.kind !== "claimed") return yield* Effect.die("claim not claimed")
    const materialized = yield* SessionPromptIntent.materializeTurn({
      receipt: trigger.receipt,
      message: message(trigger.receipt.messageID),
    })
    if (!("run" in materialized)) return yield* Effect.die("materializeTurn produced no run")
    return { run: materialized.run, receipt: trigger.receipt }
  })

describe("TurnStageEvidence", () => {
  it.effect("records the provider-turn stage sequence forward-only on a state-machine driven activity", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const { run } = yield* liveActivity("intent_stage_sequence")
      const activityID = run.activityID

      // The same single-statement upserts prompt.ts performs at each boundary.
      yield* TurnStageEvidence.record(db, {
        sessionID,
        activityID,
        stage: "activity_claimed",
        details: { via: "steer_claim" },
        now: 100,
      })
      yield* TurnStageEvidence.record(db, { sessionID, activityID, stage: "snapshot_started", now: 101 })
      yield* TurnStageEvidence.record(db, { sessionID, activityID, stage: "snapshot_finished", now: 102 })
      yield* TurnStageEvidence.record(db, {
        sessionID,
        activityID,
        stage: "history_loaded",
        details: { messages: 3 },
        now: 103,
      })
      // request_prepared reuses the enclosing receipt transaction in prompt.ts.
      yield* db
        .transaction((tx) =>
          TurnStageEvidence.recordInTransaction(tx, {
            sessionID,
            activityID,
            stage: "request_prepared",
            details: { receiptID: "receipt-stage-sequence", requestOrdinal: 1 },
            now: 104,
          }),
        )
        .pipe(Effect.orDie)
      yield* TurnStageEvidence.record(db, { sessionID, activityID, stage: "provider_dispatch_started", now: 105 })
      yield* TurnStageEvidence.record(db, {
        sessionID,
        activityID,
        stage: "terminal_settled",
        details: { state: "completed" },
        now: 106,
      })

      // One row per (session_id, activity_id), holding the furthest stage.
      const rows = yield* TurnStageEvidence.recent(db, { sessionID })
      expect(rows.filter((row) => row.activity_id === activityID)).toHaveLength(1)
      const latest = yield* TurnStageEvidence.latest(db, { sessionID, activityID })
      expect(latest).toMatchObject({
        session_id: sessionID,
        activity_id: activityID,
        stage: "terminal_settled",
        stage_at: 106,
        details: { state: "completed" },
      })

      // Forward-only: an earlier stage from a retried turn cannot regress the row.
      yield* TurnStageEvidence.record(db, { sessionID, activityID, stage: "snapshot_started", now: 107 })
      const still = yield* TurnStageEvidence.latest(db, { sessionID, activityID })
      expect(still).toMatchObject({ stage: "terminal_settled", stage_at: 106, updated_at: latest!.updated_at })

      // Same-stage re-settlement updates attribution details (equal order passes the guard).
      yield* TurnStageEvidence.record(db, {
        sessionID,
        activityID,
        stage: "terminal_settled",
        details: { state: "failed", reasonCode: "provider_error" },
        now: 108,
      })
      const rewritten = yield* TurnStageEvidence.latest(db, { sessionID, activityID })
      expect(rewritten).toMatchObject({
        stage: "terminal_settled",
        stage_at: 108,
        details: { state: "failed", reasonCode: "provider_error" },
      })
    }),
  )

  it.effect("a failed evidence write never interrupts the turn (FK violation is swallowed)", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      // No such session row -> FK violation; record() must log and succeed.
      yield* TurnStageEvidence.record(db, {
        sessionID: "ses_missing_fk_target",
        activityID: "act_missing_fk",
        stage: "activity_claimed",
      })
      const rows = yield* TurnStageEvidence.recent(db, { sessionID: "ses_missing_fk_target" })
      expect(rows).toEqual([])
    }),
  )
})

describe("TurnDeadlineWatchdog", () => {
  it.effect("the watchdog flag ships OFF with a ten-minute default deadline", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      expect(flags.providerPreDispatchWatchdog).toBe(false)
      expect(flags.providerPreDispatchDeadlineMs).toBe(10 * 60_000)
    }).pipe(Effect.provide(RuntimeFlags.layer({}))),
  )

  it.effect("flag ON: fails a stale activity without dispatch evidence through the existing terminal path", () =>
    Effect.gen(function* () {
      yield* setup
      const databaseService = yield* Database.Service
      const { run } = yield* liveActivity("intent_watchdog_stale")

      const outcomes = yield* TurnDeadlineWatchdog.sweep({ database: databaseService, deadlineMs: 0 })
      expect(outcomes.find((outcome) => outcome.activityID === run.activityID)).toMatchObject({
        kind: "failed",
        runID: run.runID,
      })

      // Existing terminalization path: typed terminal reason on the activity + terminal rows.
      const { db } = databaseService
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityTable)
          .where(sql`${SessionLegacyActivityTable.activity_id} = ${run.activityID}`)
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "failed" })
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityTerminalTable)
          .where(sql`${SessionLegacyActivityTerminalTable.activity_id} = ${run.activityID}`)
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        state: "failed",
        reason_code: TurnDeadlineWatchdog.ReasonCode,
        source: "same_process_recovery",
        run_id: run.runID,
      })
      // Run row is terminalized alongside the activity (exact retry stays possible).
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityRunTable)
          .where(sql`${SessionLegacyActivityRunTable.run_id} = ${run.runID}`)
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "failed", terminal_reason: TurnDeadlineWatchdog.ReasonCode })

      // Record-only evidence shows the watchdog settled the turn.
      expect(
        yield* TurnStageEvidence.latest(db, { sessionID, activityID: run.activityID }),
      ).toMatchObject({
        stage: "terminal_settled",
        details: { reasonCode: TurnDeadlineWatchdog.ReasonCode, via: "pre_dispatch_deadline_watchdog" },
      })

      // Second sweep is a no-op for this activity (no longer active).
      const rerun = yield* TurnDeadlineWatchdog.sweep({ database: databaseService, deadlineMs: 0 })
      expect(rerun.some((outcome) => outcome.activityID === run.activityID)).toBe(false)
    }),
  )

  it.effect("flag ON: skips an activity whose stage evidence already shows dispatch progress", () =>
    Effect.gen(function* () {
      yield* setup
      const databaseService = yield* Database.Service
      const { db } = databaseService
      const { run } = yield* liveActivity("intent_watchdog_dispatched")
      // Durable dispatch-side evidence (as prompt.ts writes when the receipt is prepared).
      yield* TurnStageEvidence.record(db, {
        sessionID,
        activityID: run.activityID,
        stage: "request_prepared",
        details: { receiptID: "receipt-watchdog-dispatched" },
      })

      const outcomes = yield* TurnDeadlineWatchdog.sweep({ database: databaseService, deadlineMs: 0 })
      expect(outcomes.find((outcome) => outcome.activityID === run.activityID)).toMatchObject({
        kind: "skipped",
        reason: "stage_evidence_present",
      })
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityTable)
          .where(sql`${SessionLegacyActivityTable.activity_id} = ${run.activityID}`)
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "active" })
    }),
  )

  it.effect("flag ON: never touches an activity that already has a durable receipt", () =>
    Effect.gen(function* () {
      yield* setup
      const databaseService = yield* Database.Service
      const { db } = databaseService
      const { run, receipt } = yield* liveActivity("intent_watchdog_receipt")

      const assistantID = MessageID.make("msg_watchdog_receipt_assistant")
      yield* db
        .insert(MessageTable)
        .values({
          id: assistantID,
          session_id: sessionID,
          time_created: 2,
          data: {
            role: "assistant",
            parentID: receipt.messageID,
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
        .insert(SessionToolRequestReceiptTable) // fixture-exempt: seeds durable receipt evidence; no dispatch exists to produce it naturally
        .values({
          receipt_id: "receipt-watchdog-present",
          request_ordinal: 1,
          session_id: sessionID,
          user_message_id: receipt.messageID,
          assistant_message_id: assistantID,
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
          registry_tool_ids: [],
          permission_filtered_tool_ids: [],
          final_offered_tool_ids: [],
          call_ids: [],
          adapter_tool_capability: "unknown",
          prompt_epoch: 0,
          prompt_window_id: "window-watchdog-present",
          effective_history_hash: "history-watchdog-present",
          request_input_hash: "input-watchdog-present",
          response_chain_reuse_decision: "not_supported",
          response_chain_refusal_reason: "fixture_path_not_stateful",
          provider_state: "preparing",
          owner_token: providerOwnerToken,
          request_state: "prepared",
          created_at: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)

      const outcomes = yield* TurnDeadlineWatchdog.sweep({ database: databaseService, deadlineMs: 0 })
      expect(outcomes.find((outcome) => outcome.activityID === run.activityID)).toMatchObject({
        kind: "skipped",
        reason: "receipt_present",
      })
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityTable)
          .where(sql`${SessionLegacyActivityTable.activity_id} = ${run.activityID}`)
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ state: "active" })
    }),
  )
})

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
  revision: "readiness-stage-evidence",
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
