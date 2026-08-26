import { describe, expect, test } from "bun:test"
import {
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionProviderAttemptTable,
  SessionProviderOwnerLeaseTable,
} from "@deepagent-code/core/context-federation/session-sql"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "@deepagent-code/core/context-federation/sql"
import { LocationKey, ProjectScopeKey, SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import providerCrossStateRecoveryMigration from "@deepagent-code/core/database/migration/20260812061000_provider_cross_state_recovery"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionHistoryStateTable, SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { Hash } from "@deepagent-code/core/util/hash"
import { eq, inArray, sql } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { recoverProviderReceiptsOnStartup, rejectUndispatchedProviderTurn } from "../../src/session/prompt"
import { ContextActivationReceipt } from "../../src/context-federation/activation-receipt"
import { CompactionRunTable } from "../../src/session/compaction-sql"
import { Session } from "../../src/session/session"
import { SessionToolRequestReceiptTable } from "../../src/session/tool-request-receipt.sql"

const projectId = ProjectV2.ID.make("project-provider-recovery")
const sessionId = SessionSchema.ID.make("ses_provider_recovery")
const inputId = SessionMessage.ID.make("msg_provider_recovery")
const activityId = "activity-provider-recovery"
const selectionId = "selection-provider-recovery"
const namespace = SecurityNamespaceID.make("sec_provider_recovery")
const projectScope = ProjectScopeKey.make("prjctx_provider_recovery")
const location = LocationKey.make("loc_provider_recovery")
const releasedKnowledgeBinding = DeepAgentReleasedSnapshot.binding(undefined)
const recoveryOwner = "provider-recovery-owner"

describe("provider receipt startup recovery", () => {
  test("quarantines every linked attempt whose physical dispatch receipt started", async () => {
    const database = Database.layerFromPath(":memory:")
    const sessionLayer = Layer.succeed(Session.Service, {
      messages: () => Effect.succeed([]),
      updateMessage: () => Effect.die("recovery fixture has no assistant message"),
    } as unknown as Session.Interface)

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seed(db)
        yield* recoverProviderReceiptsOnStartup({ ownerToken: recoveryOwner, now: 1_500 })

        const attempts = (yield* db.select().from(SessionProviderAttemptTable).all()).toSorted(
          (left, right) => left.provider_turn_seq - right.provider_turn_seq,
        )
        expect(attempts.map((attempt) => [attempt.state, attempt.error_code])).toEqual([
          ["indeterminate_after_crash", "process_recovery"],
          ["indeterminate_after_crash", "process_recovery"],
          ["failed", "owner_lease_lost_before_dispatch"],
          ["settled", null],
          ["failed", "owner_lease_lost_before_dispatch"],
        ])

        const receipts = (yield* db.select().from(SessionToolRequestReceiptTable).all()).toSorted(
          (left, right) => left.request_ordinal - right.request_ordinal,
        )
        expect(receipts.map((receipt) => [receipt.provider_state, receipt.request_error_code])).toEqual([
          ["indeterminate_after_crash", "provider_started_outcome_unknown_after_process_restart"],
          ["indeterminate_after_crash", "provider_started_outcome_unknown_after_process_restart"],
          ["failed", "provider_not_dispatched_before_process_restart"],
          ["indeterminate_after_crash", "terminal_attempt_receipt_mismatch_after_process_restart"],
        ])
        expect(receipts.every((receipt) => receipt.context_selection_id === selectionId)).toBe(true)
        expect(receipts.map((receipt) => receipt.context_activation)).toEqual([
          contextActivation,
          contextActivation,
          contextActivation,
          contextActivation,
        ])
        expect(
          receipts.every((receipt) => receipt.context_activation_fingerprint === contextActivationFingerprint),
        ).toBe(true)
        expect(
          receipts.every(
            (receipt) =>
              receipt.released_knowledge_security_namespace_id === namespace &&
              receipt.released_knowledge_project_scope_key === projectScope &&
              receipt.released_knowledge_binding_state === "unavailable" &&
              receipt.released_knowledge_exact_refs_fingerprint === releasedKnowledgeBinding.exactRefsFingerprint &&
              receipt.released_knowledge_selected_refs_fingerprint === releasedKnowledgeBinding.exactRefsFingerprint,
          ),
        ).toBe(true)
        expect(receipts.every((receipt) => receipt.released_knowledge_selected_refs?.length === 0)).toBe(true)
        expect(
          yield* db
            .select({ state: SessionHistoryStateTable.state })
            .from(SessionHistoryStateTable)
            .where(eq(SessionHistoryStateTable.session_id, sessionId))
            .get(),
        ).toEqual({ state: "recovery_required" })
      }).pipe(Effect.provide(Layer.merge(database, sessionLayer))),
    )
  })

  test("quarantines exact cross-state attempts without reopening compaction continuation", async () => {
    const database = Database.layerFromPath(":memory:")
    const sessionLayer = Layer.succeed(Session.Service, {
      messages: () => Effect.succeed([]),
      updateMessage: () => Effect.die("recovery fixture has no assistant message"),
    } as unknown as Session.Interface)

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seed(db, { releaseStaleOwner: false })
        yield* db.run(sql`DROP TRIGGER session_tool_request_receipt_provider_transition`)
        yield* db
          .update(SessionToolRequestReceiptTable)
          .set({ provider_state: "prepared", request_state: "prepared", dispatching_at: null })
          .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-0"))
          .run()
        yield* db
          .update(SessionProviderAttemptTable)
          .set({ state: "dispatching" })
          .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-0"))
          .run()
        yield* db
          .update(SessionToolRequestReceiptTable)
          .set({ provider_state: "prepared", request_state: "prepared", dispatching_at: null, streaming_at: null })
          .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-1"))
          .run()
        yield* db
          .update(SessionProviderAttemptTable)
          .set({ state: "failed", settled_at: 110, error_code: "fixture_cross_state_failed" })
          .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-2"))
          .run()
        yield* db
          .update(SessionToolRequestReceiptTable)
          .set({ provider_state: "prepared", request_state: "prepared", dispatching_at: null })
          .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-3"))
          .run()
        yield* db
          .insert(CompactionRunTable)
          .values([
            {
              run_id: "compaction-provider-cross-state-dispatching",
              session_id: sessionId,
              from_prompt_epoch: 0,
              trigger: "turn_start",
              state: "committed",
              created_at: 100,
              source_window_id: "window-provider-cross-state-dispatching",
              source_effective_history_hash: "history-provider-cross-state-dispatching",
              source_message_count: 1,
              source_projection_version: 1,
              continuation_wakeup_at: 100,
              continuation_state: "admitted",
              continuation_receipt_id: "receipt-provider-recovery-0",
              continuation_admitted_at: 100,
            },
            {
              run_id: "compaction-provider-cross-state-streaming",
              session_id: sessionId,
              from_prompt_epoch: 1,
              trigger: "turn_start",
              state: "committed",
              created_at: 101,
              source_window_id: "window-provider-cross-state-streaming",
              source_effective_history_hash: "history-provider-cross-state-streaming",
              source_message_count: 1,
              source_projection_version: 1,
              continuation_wakeup_at: 101,
              continuation_state: "admitted",
              continuation_receipt_id: "receipt-provider-recovery-1",
              continuation_admitted_at: 101,
            },
            {
              run_id: "compaction-provider-cross-state-failed",
              session_id: sessionId,
              from_prompt_epoch: 2,
              trigger: "turn_start",
              state: "committed",
              created_at: 102,
              source_window_id: "window-provider-cross-state-failed",
              source_effective_history_hash: "history-provider-cross-state-failed",
              source_message_count: 1,
              source_projection_version: 1,
              continuation_wakeup_at: 102,
              continuation_state: "admitted",
              continuation_receipt_id: "receipt-provider-recovery-2",
              continuation_admitted_at: 102,
            },
            {
              run_id: "compaction-provider-cross-state-settled",
              session_id: sessionId,
              from_prompt_epoch: 3,
              trigger: "turn_start",
              state: "committed",
              created_at: 101,
              source_window_id: "window-provider-cross-state-settled",
              source_effective_history_hash: "history-provider-cross-state-settled",
              source_message_count: 1,
              source_projection_version: 1,
              continuation_wakeup_at: 101,
              continuation_state: "admitted",
              continuation_receipt_id: "receipt-provider-recovery-3",
              continuation_admitted_at: 101,
            },
          ])
          .run()
        yield* db.run(sql`
          UPDATE session_provider_owner_lease
          SET released_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
          WHERE owner_token = 'stale-owner'
        `)
        yield* DatabaseMigration.applyOnly(db, [providerCrossStateRecoveryMigration])

        yield* recoverProviderReceiptsOnStartup({ ownerToken: recoveryOwner, now: 1_500 })

        expect(
          yield* db
            .select({ state: SessionProviderAttemptTable.state, errorCode: SessionProviderAttemptTable.error_code })
            .from(SessionProviderAttemptTable)
            .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-0"))
            .get(),
        ).toEqual({ state: "indeterminate_after_crash", errorCode: "process_recovery" })
        expect(
          yield* db
            .select({ state: SessionProviderAttemptTable.state, errorCode: SessionProviderAttemptTable.error_code })
            .from(SessionProviderAttemptTable)
            .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-1"))
            .get(),
        ).toEqual({ state: "indeterminate_after_crash", errorCode: "process_recovery" })
        expect(
          yield* db
            .select({ state: SessionProviderAttemptTable.state, errorCode: SessionProviderAttemptTable.error_code })
            .from(SessionProviderAttemptTable)
            .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-2"))
            .get(),
        ).toEqual({ state: "failed", errorCode: "fixture_cross_state_failed" })
        expect(
          yield* db
            .select({ state: SessionProviderAttemptTable.state, errorCode: SessionProviderAttemptTable.error_code })
            .from(SessionProviderAttemptTable)
            .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-3"))
            .get(),
        ).toEqual({ state: "settled", errorCode: null })
        expect(
          yield* db
            .select({
              id: SessionToolRequestReceiptTable.receipt_id,
              state: SessionToolRequestReceiptTable.provider_state,
              errorCode: SessionToolRequestReceiptTable.request_error_code,
            })
            .from(SessionToolRequestReceiptTable)
            .where(
              inArray(SessionToolRequestReceiptTable.receipt_id, [
                "receipt-provider-recovery-0",
                "receipt-provider-recovery-1",
                "receipt-provider-recovery-2",
                "receipt-provider-recovery-3",
              ]),
            )
            .orderBy(SessionToolRequestReceiptTable.receipt_id)
            .all(),
        ).toEqual([
          {
            id: "receipt-provider-recovery-0",
            state: "indeterminate_after_crash",
            errorCode: "provider_started_outcome_unknown_after_process_restart",
          },
          {
            id: "receipt-provider-recovery-1",
            state: "indeterminate_after_crash",
            errorCode: "provider_started_outcome_unknown_after_process_restart",
          },
          {
            id: "receipt-provider-recovery-2",
            state: "indeterminate_after_crash",
            errorCode: "terminal_attempt_receipt_mismatch_after_process_restart",
          },
          {
            id: "receipt-provider-recovery-3",
            state: "indeterminate_after_crash",
            errorCode: "terminal_attempt_receipt_mismatch_after_process_restart",
          },
        ])
        expect(
          yield* db
            .select({ id: CompactionRunTable.run_id, state: CompactionRunTable.continuation_state })
            .from(CompactionRunTable)
            .where(
              inArray(CompactionRunTable.run_id, [
                "compaction-provider-cross-state-dispatching",
                "compaction-provider-cross-state-failed",
                "compaction-provider-cross-state-settled",
                "compaction-provider-cross-state-streaming",
              ]),
            )
            .orderBy(CompactionRunTable.run_id)
            .all(),
        ).toEqual([
          { id: "compaction-provider-cross-state-dispatching", state: "indeterminate" },
          { id: "compaction-provider-cross-state-failed", state: "indeterminate" },
          { id: "compaction-provider-cross-state-settled", state: "indeterminate" },
          { id: "compaction-provider-cross-state-streaming", state: "indeterminate" },
        ])
        expect(
          yield* db
            .select({ state: SessionHistoryStateTable.state })
            .from(SessionHistoryStateTable)
            .where(eq(SessionHistoryStateTable.session_id, sessionId))
            .get(),
        ).toEqual({ state: "recovery_required" })
      }).pipe(Effect.provide(Layer.merge(database, sessionLayer))),
    )
  })

  test("atomically rejects an expiry-before-dispatch receipt and its linked attempt", async () => {
    const database = Database.layerFromPath(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seed(db, { releaseStaleOwner: false })
        yield* db
          .insert(CompactionRunTable)
          .values({
            run_id: "compaction-provider-recovery",
            session_id: sessionId,
            from_prompt_epoch: 0,
            trigger: "turn_start",
            state: "committed",
            created_at: 100,
            source_window_id: "window-provider-recovery",
            source_effective_history_hash: "history-provider-recovery",
            source_message_count: 1,
            source_projection_version: 1,
            continuation_wakeup_at: 100,
            continuation_state: "admitted",
            continuation_receipt_id: "receipt-provider-recovery-2",
            continuation_admitted_at: 100,
          })
          .run()
        expect(
          Exit.isFailure(
            yield* rejectUndispatchedProviderTurn({
              receiptID: "receipt-provider-recovery-2",
              ownerToken: "stale-owner",
              providerAttemptID: "attempt-provider-recovery-4",
              errorCode: "provider_dispatch_readiness_expired",
              now: 499,
            }).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(
          yield* db
            .select({ state: SessionToolRequestReceiptTable.provider_state })
            .from(SessionToolRequestReceiptTable)
            .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-2"))
            .get(),
        ).toEqual({ state: "prepared" })
        expect(
          yield* db
            .select({ state: CompactionRunTable.continuation_state })
            .from(CompactionRunTable)
            .where(eq(CompactionRunTable.run_id, "compaction-provider-recovery"))
            .get(),
        ).toEqual({ state: "admitted" })
        yield* rejectUndispatchedProviderTurn({
          receiptID: "receipt-provider-recovery-2",
          ownerToken: "stale-owner",
          providerAttemptID: "attempt-provider-recovery-2",
          errorCode: "provider_dispatch_readiness_expired",
          now: 500,
        })

        expect(
          yield* db
            .select({
              state: SessionToolRequestReceiptTable.provider_state,
              requestState: SessionToolRequestReceiptTable.request_state,
              terminalAt: SessionToolRequestReceiptTable.terminal_at,
              errorCode: SessionToolRequestReceiptTable.request_error_code,
            })
            .from(SessionToolRequestReceiptTable)
            .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-2"))
            .get(),
        ).toEqual({
          state: "failed",
          requestState: "rejected",
          terminalAt: 500,
          errorCode: "provider_dispatch_readiness_expired",
        })
        expect(
          yield* db
            .select({
              state: SessionProviderAttemptTable.state,
              settledAt: SessionProviderAttemptTable.settled_at,
              errorCode: SessionProviderAttemptTable.error_code,
            })
            .from(SessionProviderAttemptTable)
            .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-2"))
            .get(),
        ).toEqual({
          state: "failed",
          settledAt: 500,
          errorCode: "provider_dispatch_readiness_expired",
        })
        expect(
          yield* db
            .select({
              state: CompactionRunTable.continuation_state,
              receiptID: CompactionRunTable.continuation_receipt_id,
              admittedAt: CompactionRunTable.continuation_admitted_at,
              wakeupAt: CompactionRunTable.continuation_wakeup_at,
              errorCode: CompactionRunTable.continuation_error_code,
            })
            .from(CompactionRunTable)
            .where(eq(CompactionRunTable.run_id, "compaction-provider-recovery"))
            .get(),
        ).toEqual({
          state: "pending",
          receiptID: null,
          admittedAt: null,
          wakeupAt: null,
          errorCode: "provider_dispatch_readiness_expired",
        })
      }).pipe(Effect.provide(database)),
    )
  })

  test("quarantines an inconsistent historical receipt without mutating the referenced attempt", async () => {
    const database = Database.layerFromPath(":memory:")
    const sessionLayer = Layer.succeed(Session.Service, {
      messages: () => Effect.succeed([]),
      updateMessage: () => Effect.die("recovery fixture has no assistant message"),
    } as unknown as Session.Interface)

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seed(db, { releaseStaleOwner: false })
        yield* db.run(sql`DROP TRIGGER session_provider_attempt_legal_update`)
        yield* db
          .update(SessionProviderAttemptTable)
          .set({ provider_id: "provider-corrupted" })
          .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-2"))
          .run()
        yield* db
          .update(SessionProviderAttemptTable)
          .set({ provider_id: "provider-corrupted-started" })
          .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-0"))
          .run()
        yield* db
          .insert(CompactionRunTable)
          .values([
            {
              run_id: "compaction-provider-identity-mismatch",
              session_id: sessionId,
              from_prompt_epoch: 0,
              trigger: "turn_start",
              state: "committed",
              created_at: 100,
              source_window_id: "window-provider-recovery",
              source_effective_history_hash: "history-provider-recovery",
              source_message_count: 1,
              source_projection_version: 1,
              continuation_wakeup_at: 100,
              continuation_state: "admitted",
              continuation_receipt_id: "receipt-provider-recovery-2",
              continuation_admitted_at: 100,
            },
            {
              run_id: "compaction-provider-started-identity-mismatch",
              session_id: sessionId,
              from_prompt_epoch: 1,
              trigger: "turn_start",
              state: "committed",
              created_at: 101,
              source_window_id: "window-provider-recovery-started",
              source_effective_history_hash: "history-provider-recovery-started",
              source_message_count: 1,
              source_projection_version: 1,
              continuation_wakeup_at: 101,
              continuation_state: "dispatching",
              continuation_receipt_id: "receipt-provider-recovery-0",
              continuation_admitted_at: 100,
              continuation_dispatching_at: 101,
            },
          ])
          .run()
        yield* db.run(sql`
          UPDATE session_provider_owner_lease
          SET released_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
          WHERE owner_token = 'stale-owner'
        `)

        yield* recoverProviderReceiptsOnStartup({ ownerToken: recoveryOwner, now: 1_500 })

        expect(
          yield* db
            .select({ state: SessionProviderAttemptTable.state, providerID: SessionProviderAttemptTable.provider_id })
            .from(SessionProviderAttemptTable)
            .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-2"))
            .get(),
        ).toEqual({ state: "prepared", providerID: "provider-corrupted" })
        expect(
          yield* db
            .select({ state: SessionProviderAttemptTable.state, providerID: SessionProviderAttemptTable.provider_id })
            .from(SessionProviderAttemptTable)
            .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-0"))
            .get(),
        ).toEqual({ state: "prepared", providerID: "provider-corrupted-started" })
        expect(
          yield* db
            .select({
              state: SessionToolRequestReceiptTable.provider_state,
              errorCode: SessionToolRequestReceiptTable.request_error_code,
            })
            .from(SessionToolRequestReceiptTable)
            .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-2"))
            .get(),
        ).toEqual({ state: "failed", errorCode: "provider_attempt_identity_mismatch_after_process_restart" })
        expect(
          yield* db
            .select({ state: CompactionRunTable.continuation_state })
            .from(CompactionRunTable)
            .where(eq(CompactionRunTable.run_id, "compaction-provider-identity-mismatch"))
            .get(),
        ).toEqual({ state: "admitted" })
        expect(
          yield* db
            .select({ state: CompactionRunTable.continuation_state })
            .from(CompactionRunTable)
            .where(eq(CompactionRunTable.run_id, "compaction-provider-started-identity-mismatch"))
            .get(),
        ).toEqual({ state: "dispatching" })
        expect(
          yield* db
            .select({ state: SessionHistoryStateTable.state })
            .from(SessionHistoryStateTable)
            .where(eq(SessionHistoryStateTable.session_id, sessionId))
            .get(),
        ).toEqual({ state: "recovery_required" })
      }).pipe(Effect.provide(Layer.merge(database, sessionLayer))),
    )
  })
})

function seed(db: Database.Interface["db"], options: { readonly releaseStaleOwner?: boolean } = {}) {
  const now = 100
  return Effect.gen(function* () {
    yield* db.run(sql`
      INSERT INTO session_provider_owner_lease (
        owner_token, registered_at, heartbeat_at, lease_expires_at
      ) VALUES
        (
          ${recoveryOwner},
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 60000
        ),
        (
          'stale-owner',
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 60000
        )
    `)
    yield* db
      .insert(SecurityNamespaceTable)
      .values({
        id: namespace,
        kind: "implicit_local",
        binding_hash: "namespace-binding",
        created_at: 1,
      })
      .run()
    yield* db
      .insert(ProjectScopeIdentityTable)
      .values({
        security_namespace_id: namespace,
        project_scope_key: projectScope,
        project_kind: "registered_root",
        project_identity_hash: "project-identity",
        observed_project_id: projectId,
        created_at: 1,
      })
      .run()
    yield* db
      .insert(LocationIdentityTable)
      .values({
        security_namespace_id: namespace,
        location_key: location,
        project_scope_key: projectScope,
        canonical_root: "/tmp/provider-recovery",
        observed_project_id: projectId,
        created_at: 1,
      })
      .run()
    yield* db
      .insert(ProjectTable)
      .values({
        id: projectId,
        worktree: AbsolutePath.make("/tmp/provider-recovery"),
        sandboxes: [],
      })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionId,
        project_id: projectId,
        slug: "provider-recovery",
        directory: "/tmp/provider-recovery",
        title: "Provider recovery",
        version: "test",
      })
      .run()
    yield* db
      .insert(SessionInputTable)
      .values({
        id: inputId,
        session_id: sessionId,
        prompt: new Prompt({ text: "recover provider attempt" }),
        delivery: "steer",
        admitted_seq: 0,
        promoted_seq: 0,
      })
      .run()
    yield* db
      .insert(SessionActivityTable) // fixture-exempt: seeds active activity for receipt-recovery fixture
      .values({
        activity_id: activityId,
        session_id: sessionId,
        ordinal: 0,
        trigger_input_id: inputId,
        delivery: "steer",
        state: "active",
        created_at: now,
      })
      .run()
    yield* db
      .insert(SessionContextSelectionTable)
      .values({
        selection_id: selectionId,
        session_id: sessionId,
        activity_id: activityId,
        revision: 0,
        trigger_input_id: inputId,
        location_key: location,
        security_namespace_id: namespace,
        project_scope_key: projectScope,
        query_fingerprint: "query",
        authorization_fingerprint: "authorization",
        authorization_epoch: 1,
        execution_fingerprint: "execution",
        selected_source_fingerprint: "sources",
        observed_location_mutation_epoch: 1,
        next_revalidation_at: now + 1_000,
        released_knowledge_binding_state: releasedKnowledgeBinding.state,
        released_knowledge_exact_refs: releasedKnowledgeBinding.exactRefs,
        released_knowledge_exact_refs_fingerprint: releasedKnowledgeBinding.exactRefsFingerprint,
        graph_revisions: "{}",
        graph_statuses: "[]",
        selected_refs: "[]",
        projection: "",
        projection_hash: "projection",
        token_count: 0,
        artifact_write_status: "degraded_unavailable",
        inline_audit: "{}",
        created_at: now,
      })
      .run()
    yield* db
      .insert(SessionProviderAttemptTable) // fixture-exempt: seeds attempt batch for receipt-recovery fixture
      .values([attempt(0), attempt(1), attempt(2), attempt(3), attempt(4)])
      .run()
    yield* Effect.forEach([0, 1, 2, 3], (providerTurnSeq) =>
      db
        .update(SessionProviderAttemptTable)
        .set({
          prepared_turn_hash: preparedTurnFields(providerTurnSeq).prepared_turn_hash,
          wire_request_hash: preparedTurnFields(providerTurnSeq).wire_request_hash,
        })
        .where(eq(SessionProviderAttemptTable.attempt_id, `attempt-provider-recovery-${providerTurnSeq}`))
        .run(),
    )
    yield* db
      .insert(SessionToolRequestReceiptTable) // fixture-exempt: seeds receipt batch for receipt-recovery fixture
      .values([receipt(0), receipt(1), receipt(2), receipt(3)])
      .run()
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        released_knowledge_selected_refs: [],
        released_knowledge_selected_refs_fingerprint: releasedKnowledgeBinding.exactRefsFingerprint,
      })
      .run()
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        provider_state: "prepared",
        ...preparedTurnFields(0),
        adapter_prepared_at: 100,
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-0"))
      .run()
    // Simulate a pre-authority crash row where the receipt committed dispatching before its linked attempt.
    yield* db.run(sql`DROP TRIGGER session_tool_request_receipt_attempt_wire_guard`)
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        provider_state: "dispatching",
        request_state: "dispatched",
        dispatching_at: 101,
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-0"))
      .run()
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        provider_state: "prepared",
        ...preparedTurnFields(1),
        adapter_prepared_at: 100,
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-1"))
      .run()
    yield* db
      .update(SessionProviderAttemptTable)
      .set({ state: "dispatching" })
      .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-1"))
      .run()
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        provider_state: "dispatching",
        request_state: "dispatched",
        dispatching_at: 101,
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-1"))
      .run()
    yield* db
      .update(SessionProviderAttemptTable)
      .set({ state: "streaming", first_event_at: 102 })
      .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-1"))
      .run()
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({ provider_state: "streaming", streaming_at: 102 })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-1"))
      .run()
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        provider_state: "prepared",
        ...preparedTurnFields(2),
        adapter_prepared_at: 100,
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-2"))
      .run()
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        provider_state: "prepared",
        ...preparedTurnFields(3),
        adapter_prepared_at: 100,
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-3"))
      .run()
    yield* db
      .update(SessionProviderAttemptTable)
      .set({ state: "dispatching" })
      .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-3"))
      .run()
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        provider_state: "dispatching",
        request_state: "dispatched",
        dispatching_at: 101,
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-provider-recovery-3"))
      .run()
    yield* db
      .update(SessionProviderAttemptTable)
      .set({ state: "settled", settled_at: 113 })
      .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-provider-recovery-3"))
      .run()
    if (options.releaseStaleOwner !== false)
      yield* db.run(sql`
        UPDATE session_provider_owner_lease
        SET released_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        WHERE owner_token = 'stale-owner'
      `)
  })
}

function attempt(providerTurnSeq: number) {
  return {
    attempt_id: `attempt-provider-recovery-${providerTurnSeq}`,
    session_id: sessionId,
    activity_id: activityId,
    provider_turn_seq: providerTurnSeq,
    selection_id: selectionId,
    projection_hash: "projection",
    request_hash: requestHash(providerTurnSeq),
    provider_id: "provider-test",
    owner_token: "stale-owner",
    state: "prepared" as const,
    created_at: 100 + providerTurnSeq,
  }
}

function requestHash(providerTurnSeq: number) {
  return Hash.sha256(`request-${providerTurnSeq}`)
}

function preparedTurnFields(providerTurnSeq: number) {
  return {
    final_request_hash: requestHash(providerTurnSeq),
    provider_request_hash: requestHash(providerTurnSeq),
    prepared_turn_hash: Hash.sha256(`prepared-${providerTurnSeq}`),
    system_stable_hash: Hash.sha256(`stable-${providerTurnSeq}`),
    system_volatile_hash: Hash.sha256(`volatile-${providerTurnSeq}`),
    wire_request_hash: requestHash(providerTurnSeq),
    tool_definition_hash: Hash.sha256("[]"),
    tool_result_reference_ids: [],
    tool_result_reference_count: 0,
  }
}

function receipt(requestOrdinal: number) {
  return {
    receipt_id: `receipt-provider-recovery-${requestOrdinal}`,
    request_ordinal: requestOrdinal + 1,
    session_id: sessionId,
    user_message_id: inputId,
    provider_attempt_id: `attempt-provider-recovery-${requestOrdinal}`,
    context_selection_id: selectionId,
    context_eligibility: contextEligibility,
    context_readiness: contextReadiness,
    context_activation: contextActivation,
    context_activation_fingerprint: contextActivationFingerprint,
    released_knowledge_security_namespace_id: namespace,
    released_knowledge_project_scope_key: projectScope,
    released_knowledge_binding_state: releasedKnowledgeBinding.state,
    released_knowledge_exact_refs: releasedKnowledgeBinding.exactRefs,
    released_knowledge_exact_refs_fingerprint: releasedKnowledgeBinding.exactRefsFingerprint,
    provider_id: "provider-test",
    model_id: "model-test",
    registry_tool_ids: [],
    permission_filtered_tool_ids: [],
    final_offered_tool_ids: [],
    call_ids: [],
    final_request_hash: null,
    provider_state: "preparing" as const,
    adapter_prepared_at: null,
    prompt_epoch: 0,
    prompt_window_id: "window-provider-recovery",
    effective_history_hash: "history-provider-recovery",
    request_input_hash: requestHash(requestOrdinal),
    dispatching_at: null,
    streaming_at: null,
    owner_token: "stale-owner",
    request_state: "prepared" as const,
    created_at: 100,
  }
}

const contextEligibility = ContextFederationRollout.resolveProject(
  ContextFederationRollout.resolve(
    {
      contextFederationShadow: true,
      locationIndexesV2Shadow: true,
      contextProjectionV2: true,
      contextQueryToolsV2: true,
      coreV2ExecutionOwner: false,
    },
    { coreV2ParityVerified: false },
  ),
  "project_scope_provider_recovery",
  { stage: "all", percentage: 100, internalProjectScopeKeys: [], killSwitch: false },
)
const contextReadiness = {
  ...ContextFederationRollout.READINESS_READY_STUB,
  revision: "readiness-provider-recovery",
  observedAt: 50,
  expiresAt: Number.MAX_SAFE_INTEGER,
}
const contextDecision = ContextFederationRollout.activate(contextEligibility, contextReadiness)
const contextActivation = ContextActivationReceipt.make({
  readiness: contextReadiness,
  decision: contextDecision,
  recordedAt: 100,
  projectionEnabled: true,
  toolsEnabled: true,
  selection: { selectionId, projectionHash: "projection" },
})
const contextActivationFingerprint = ContextActivationReceipt.fingerprint({
  eligibility: contextEligibility,
  readiness: contextReadiness,
  activation: contextActivation,
})
