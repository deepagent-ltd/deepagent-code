/**
 * QUAL-002 regression suite for durable provider and activity recovery failures.
 *
 * event maintenance (receipt startup recovery shape): a provider turn that reached
 * dispatching/streaming before a process crash must be classified
 * `indeterminate_after_crash` by recoverProviderReceiptsOnStartup, already
 * settled turns must be untouched, and repeated startup recovery must be
 * idempotent.
 *
 * question dismissal (activity terminal authority shape): rejecting the pending
 * question request terminalizes the legacy activity (terminal authority row),
 * and the next prompt in the same session is admitted without being blocked
 * by recovery_required. The Question service exposes a single `reject`
 * dismissal path ("The user dismissed this question"); no separate dismiss
 * API exists, so reject covers the dismissal shape.
 *
 * provider recovery (abandoned resolution shape): an indeterminate receipt resolved
 * as abandoned unblocks the session for newly admitted messages, keeps
 * forking possible before the crashed turn cutoff, and repeated resolutions
 * are idempotent.
 *
 * Fixtures follow the legal-lifecycle seeding pattern of
 * provider-receipt-recovery.test.ts / legacy-provider-resolution.test.ts:
 * authority rows are inserted in their initial non-terminal state and then
 * advanced through trigger-legal transitions; `// fixture-exempt:` markers
 * satisfy the QUAL-003 gate for the unavoidable authority inserts.
 */
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { and, eq, sql } from "drizzle-orm"
import path from "path"
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import remoteCompactPersistenceMigration from "@deepagent-code/core/database/migration/20260820000000_remote_compact_persistence"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "@deepagent-code/core/context-federation/sql"
import { LocationKey, ProjectScopeKey, SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"
import {
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionProviderAttemptResolutionTable,
  SessionProviderAttemptTable,
  SessionProviderOwnerLeaseTable,
} from "@deepagent-code/core/context-federation/session-sql"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionHistoryStateTable, SessionInputTable, SessionIntentTable, SessionTable } from "@deepagent-code/core/session/sql"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionV2 } from "@deepagent-code/core/session"
import { Hash } from "@deepagent-code/core/util/hash"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Search } from "@deepagent-code/core/filesystem/search"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import * as Log from "@deepagent-code/core/util/log"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { recoverProviderReceiptsOnStartup, SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionSteer } from "../../src/session/steer"
import { SessionStatus } from "../../src/session/status"
import { MessageID, PartID } from "../../src/session/schema"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { DebugService } from "@/debug/service"
import { RuntimeBase } from "@/runtime/base"
import { Truncate } from "@/tool/truncate"
import { Format } from "../../src/format"
import { Reference } from "../../src/reference/reference"
import { RepositoryCache } from "../../src/reference/repository-cache"
import { PromptEpoch } from "@/session/prompt-epoch"
import { SessionPromptEpochTable } from "@/session/prompt-epoch.sql"
import { SessionToolRequestReceiptTable } from "@/session/tool-request-receipt.sql"
import { SessionLegacyProviderResolution } from "@/session/legacy-provider-resolution"
import { ContextActivationReceipt } from "@/context-federation/activation-receipt"
import { ContextFederationReadiness } from "../../src/context-federation/readiness"
import {
  SessionActivityAdmissionTable,
  SessionLegacyActivityRunTable,
  SessionLegacyActivityTable,
  SessionLegacyActivityTerminalTable,
} from "@/session/activity-sql"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { TestContextFacades } from "../fixture/context-facades"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

// ---------------------------------------------------------------------------
// event maintenance shape: receipt startup recovery (crash after dispatch/stream)
// ---------------------------------------------------------------------------

const crashProjectId = ProjectV2.ID.make("project-incident-recovery")
const crashSessionId = SessionSchema.ID.make("ses_incident_recovery")
const crashInputId = SessionMessage.ID.make("msg_incident_recovery")
const crashActivityId = "activity-incident-recovery"
const crashSelectionId = "selection-incident-recovery"
const crashNamespace = SecurityNamespaceID.make("sec_incident_recovery")
const crashProjectScope = ProjectScopeKey.make("prjctx_incident_recovery")
const crashLocation = LocationKey.make("loc_incident_recovery")
const crashBinding = DeepAgentReleasedSnapshot.binding(undefined)
const crashRecoveryOwner = "incident-recovery-owner"

const crashSessionLayer = Layer.succeed(
  Session.Service,
  {
    messages: () => Effect.succeed([]),
    updateMessage: () => Effect.die("incident recovery fixture has no assistant message"),
  } as unknown as Session.Interface,
)

function crashAttempt(providerTurnSeq: number) {
  return {
    attempt_id: `attempt-incident-${providerTurnSeq}`,
    session_id: crashSessionId,
    activity_id: crashActivityId,
    provider_turn_seq: providerTurnSeq,
    selection_id: crashSelectionId,
    projection_hash: "projection",
    request_hash: crashRequestHash(providerTurnSeq),
    provider_id: "provider-test",
    owner_token: "stale-owner",
    state: "prepared" as const,
    created_at: 100 + providerTurnSeq,
  }
}

function crashRequestHash(providerTurnSeq: number) {
  return Hash.sha256(`incident-request-${providerTurnSeq}`)
}

function crashPreparedTurnFields(providerTurnSeq: number) {
  return {
    final_request_hash: crashRequestHash(providerTurnSeq),
    provider_request_hash: crashRequestHash(providerTurnSeq),
    prepared_turn_hash: Hash.sha256(`incident-prepared-${providerTurnSeq}`),
    system_stable_hash: Hash.sha256(`incident-stable-${providerTurnSeq}`),
    system_volatile_hash: Hash.sha256(`incident-volatile-${providerTurnSeq}`),
    wire_request_hash: crashRequestHash(providerTurnSeq),
    tool_definition_hash: Hash.sha256("[]"),
    tool_result_reference_ids: [],
    tool_result_reference_count: 0,
  }
}

function crashReceipt(requestOrdinal: number) {
  return {
    receipt_id: `receipt-incident-${requestOrdinal}`,
    request_ordinal: requestOrdinal + 1,
    session_id: crashSessionId,
    user_message_id: crashInputId,
    provider_attempt_id: `attempt-incident-${requestOrdinal}`,
    context_selection_id: crashSelectionId,
    context_eligibility: crashContextEligibility,
    context_readiness: crashContextReadiness,
    context_activation: crashContextActivation,
    context_activation_fingerprint: crashContextActivationFingerprint,
    released_knowledge_security_namespace_id: crashNamespace,
    released_knowledge_project_scope_key: crashProjectScope,
    released_knowledge_binding_state: crashBinding.state,
    released_knowledge_exact_refs: crashBinding.exactRefs,
    released_knowledge_exact_refs_fingerprint: crashBinding.exactRefsFingerprint,
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
    prompt_window_id: "window-incident-recovery",
    effective_history_hash: "history-incident-recovery",
    request_input_hash: crashRequestHash(requestOrdinal),
    dispatching_at: null,
    streaming_at: null,
    owner_token: "stale-owner",
    request_state: "prepared" as const,
    created_at: 100,
  }
}

const crashContextEligibility = ContextFederationRollout.resolveProject(
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
  "project_scope_incident_recovery",
  { stage: "all", percentage: 100, internalProjectScopeKeys: [], killSwitch: false },
)
const crashContextReadiness = {
  ...ContextFederationRollout.READINESS_READY_STUB,
  revision: "readiness-incident-recovery",
  observedAt: 50,
  expiresAt: Number.MAX_SAFE_INTEGER,
}
const crashContextActivation = ContextActivationReceipt.make({
  readiness: crashContextReadiness,
  decision: ContextFederationRollout.activate(crashContextEligibility, crashContextReadiness),
  recordedAt: 100,
  projectionEnabled: true,
  toolsEnabled: true,
  selection: { selectionId: crashSelectionId, projectionHash: "projection" },
})
const crashContextActivationFingerprint = ContextActivationReceipt.fingerprint({
  eligibility: crashContextEligibility,
  readiness: crashContextReadiness,
  activation: crashContextActivation,
})

/**
 * Seeds a legal lifecycle (preparing -> prepared -> dispatching -> streaming)
 * for two provider turns: turn 0 crashes while streaming (stale owner lease),
 * turn 1 settles legally. Only trigger-legal UPDATE transitions are used to
 * advance state after the initial non-terminal inserts.
 */
function seedCrashFixture(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    yield* db.run(sql`
      INSERT INTO session_provider_owner_lease (
        owner_token, registered_at, heartbeat_at, lease_expires_at
      ) VALUES
        (
          ${crashRecoveryOwner},
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
      .values({ id: crashNamespace, kind: "implicit_local", binding_hash: "namespace-binding", created_at: 1 })
      .run()
    yield* db
      .insert(ProjectScopeIdentityTable)
      .values({
        security_namespace_id: crashNamespace,
        project_scope_key: crashProjectScope,
        project_kind: "registered_root",
        project_identity_hash: "project-identity",
        observed_project_id: crashProjectId,
        created_at: 1,
      })
      .run()
    yield* db
      .insert(LocationIdentityTable)
      .values({
        security_namespace_id: crashNamespace,
        location_key: crashLocation,
        project_scope_key: crashProjectScope,
        canonical_root: "/tmp/incident-recovery",
        observed_project_id: crashProjectId,
        created_at: 1,
      })
      .run()
    yield* db
      .insert(ProjectTable)
      .values({ id: crashProjectId, worktree: AbsolutePath.make("/tmp/incident-recovery"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: crashSessionId,
        project_id: crashProjectId,
        slug: "incident-recovery",
        directory: "/tmp/incident-recovery",
        title: "Incident recovery",
        version: "test",
      })
      .run()
    yield* db
      .insert(SessionInputTable)
      .values({
        id: crashInputId,
        session_id: crashSessionId,
        prompt: new Prompt({ text: "dispatch then crash" }),
        delivery: "steer",
        admitted_seq: 0,
        promoted_seq: 0,
      })
      .run()
    yield* db
      .insert(SessionActivityTable) // fixture-exempt: seeds active activity for event maintenance crash fixture
      .values({
        activity_id: crashActivityId,
        session_id: crashSessionId,
        ordinal: 0,
        trigger_input_id: crashInputId,
        delivery: "steer",
        state: "active",
        created_at: 100,
      })
      .run()
    yield* db
      .insert(SessionContextSelectionTable)
      .values({
        selection_id: crashSelectionId,
        session_id: crashSessionId,
        activity_id: crashActivityId,
        revision: 0,
        trigger_input_id: crashInputId,
        location_key: crashLocation,
        security_namespace_id: crashNamespace,
        project_scope_key: crashProjectScope,
        query_fingerprint: "query",
        authorization_fingerprint: "authorization",
        authorization_epoch: 1,
        execution_fingerprint: "execution",
        selected_source_fingerprint: "sources",
        observed_location_mutation_epoch: 1,
        next_revalidation_at: 100_000,
        released_knowledge_binding_state: crashBinding.state,
        released_knowledge_exact_refs: crashBinding.exactRefs,
        released_knowledge_exact_refs_fingerprint: crashBinding.exactRefsFingerprint,
        graph_revisions: "{}",
        graph_statuses: "[]",
        selected_refs: "[]",
        projection: "",
        projection_hash: "projection",
        token_count: 0,
        artifact_write_status: "degraded_unavailable",
        inline_audit: "{}",
        created_at: 100,
      })
      .run()
    yield* db
      .insert(SessionProviderAttemptTable) // fixture-exempt: seeds prepared attempts, advanced via legal transitions below
      .values([crashAttempt(0), crashAttempt(1)])
      .run()
    for (const providerTurnSeq of [0, 1]) {
      yield* db
        .update(SessionProviderAttemptTable)
        .set({
          prepared_turn_hash: crashPreparedTurnFields(providerTurnSeq).prepared_turn_hash,
          wire_request_hash: crashPreparedTurnFields(providerTurnSeq).wire_request_hash,
        })
        .where(eq(SessionProviderAttemptTable.attempt_id, `attempt-incident-${providerTurnSeq}`))
        .run()
    }
    yield* db
      .insert(SessionToolRequestReceiptTable) // fixture-exempt: seeds preparing receipts, advanced via legal transitions below
      .values([crashReceipt(0), crashReceipt(1)])
      .run()
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        released_knowledge_selected_refs: [],
        released_knowledge_selected_refs_fingerprint: crashBinding.exactRefsFingerprint,
      })
      .run()
    for (const providerTurnSeq of [0, 1]) {
      // Legal receipt lifecycle: preparing -> prepared.
      yield* db
        .update(SessionToolRequestReceiptTable)
        .set({ provider_state: "prepared", ...crashPreparedTurnFields(providerTurnSeq), adapter_prepared_at: 100 })
        .where(eq(SessionToolRequestReceiptTable.receipt_id, `receipt-incident-${providerTurnSeq}`))
        .run()
      // Legal attempt/receipt lifecycle: prepared -> dispatching -> streaming.
      yield* db
        .update(SessionProviderAttemptTable)
        .set({ state: "dispatching" })
        .where(eq(SessionProviderAttemptTable.attempt_id, `attempt-incident-${providerTurnSeq}`))
        .run()
      yield* db
        .update(SessionToolRequestReceiptTable)
        .set({ provider_state: "dispatching", request_state: "dispatched", dispatching_at: 101 })
        .where(eq(SessionToolRequestReceiptTable.receipt_id, `receipt-incident-${providerTurnSeq}`))
        .run()
      yield* db
        .update(SessionProviderAttemptTable)
        .set({ state: "streaming", first_event_at: 102 })
        .where(eq(SessionProviderAttemptTable.attempt_id, `attempt-incident-${providerTurnSeq}`))
        .run()
      yield* db
        .update(SessionToolRequestReceiptTable)
        .set({ provider_state: "streaming", streaming_at: 102 })
        .where(eq(SessionToolRequestReceiptTable.receipt_id, `receipt-incident-${providerTurnSeq}`))
        .run()
    }
    // Turn 1 settles legally before the crash: streaming -> settled.
    yield* db
      .update(SessionProviderAttemptTable)
      .set({ state: "settled", settled_at: 110 })
      .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-incident-1"))
      .run()
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        provider_state: "settled",
        terminal_at: 110,
        response_fingerprint: Hash.sha256("incident-settled-response"),
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-incident-1"))
      .run()
    // Simulate the crash: the owner lease of the in-flight turn is lost.
    yield* db.run(sql`
      UPDATE session_provider_owner_lease
      SET released_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      WHERE owner_token = 'stale-owner'
    `)
  })
}

describe("event maintenance incident regression: provider receipt startup recovery", () => {
  test("classifies a crashed streaming turn indeterminate_after_crash without touching settled turns", async () => {
    const database = Database.layerFromPath(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seedCrashFixture(db)
        const settledAttemptBefore = yield* db
          .select()
          .from(SessionProviderAttemptTable)
          .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-incident-1"))
          .get()
        const settledReceiptBefore = yield* db
          .select()
          .from(SessionToolRequestReceiptTable)
          .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-incident-1"))
          .get()

        yield* recoverProviderReceiptsOnStartup({ ownerToken: crashRecoveryOwner, now: 1_500 })

        expect(
          yield* db
            .select({
              state: SessionProviderAttemptTable.state,
              errorCode: SessionProviderAttemptTable.error_code,
            })
            .from(SessionProviderAttemptTable)
            .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-incident-0"))
            .get(),
        ).toEqual({ state: "indeterminate_after_crash", errorCode: "process_recovery" })
        expect(
          yield* db
            .select({
              state: SessionToolRequestReceiptTable.provider_state,
              terminalAt: SessionToolRequestReceiptTable.terminal_at,
              errorCode: SessionToolRequestReceiptTable.request_error_code,
            })
            .from(SessionToolRequestReceiptTable)
            .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-incident-0"))
            .get(),
        ).toEqual({
          state: "indeterminate_after_crash",
          terminalAt: 1_500,
          errorCode: "provider_started_outcome_unknown_after_process_restart",
        })
        // Settled turn must be untouched by the crash sweep.
        expect(
          yield* db
            .select()
            .from(SessionProviderAttemptTable)
            .where(eq(SessionProviderAttemptTable.attempt_id, "attempt-incident-1"))
            .get(),
        ).toEqual(settledAttemptBefore)
        expect(
          yield* db
            .select()
            .from(SessionToolRequestReceiptTable)
            .where(eq(SessionToolRequestReceiptTable.receipt_id, "receipt-incident-1"))
            .get(),
        ).toEqual(settledReceiptBefore)
        expect(
          yield* db
            .select({ state: SessionHistoryStateTable.state })
            .from(SessionHistoryStateTable)
            .where(eq(SessionHistoryStateTable.session_id, crashSessionId))
            .get(),
        ).toEqual({ state: "recovery_required" })
      }).pipe(Effect.provide(Layer.merge(database, crashSessionLayer))),
    )
  })

  test("repeated startup recovery is idempotent", async () => {
    const database = Database.layerFromPath(":memory:")
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seedCrashFixture(db)
        yield* recoverProviderReceiptsOnStartup({ ownerToken: crashRecoveryOwner, now: 1_500 })
        const attemptsAfterFirst = yield* db
          .select()
          .from(SessionProviderAttemptTable)
          .orderBy(SessionProviderAttemptTable.provider_turn_seq)
          .all()
        const receiptsAfterFirst = yield* db
          .select()
          .from(SessionToolRequestReceiptTable)
          .orderBy(SessionToolRequestReceiptTable.request_ordinal)
          .all()
        const historyAfterFirst = yield* db.select().from(SessionHistoryStateTable).all()

        // Second restart with a different clock must not mutate any row.
        yield* recoverProviderReceiptsOnStartup({ ownerToken: crashRecoveryOwner, now: 2_500 })

        expect(
          yield* db
            .select()
            .from(SessionProviderAttemptTable)
            .orderBy(SessionProviderAttemptTable.provider_turn_seq)
            .all(),
        ).toEqual(attemptsAfterFirst)
        expect(
          yield* db
            .select()
            .from(SessionToolRequestReceiptTable)
            .orderBy(SessionToolRequestReceiptTable.request_ordinal)
            .all(),
        ).toEqual(receiptsAfterFirst)
        expect(yield* db.select().from(SessionHistoryStateTable).all()).toEqual(historyAfterFirst)
        const leasesAfterSecond = yield* db
          .select()
          .from(SessionProviderOwnerLeaseTable)
          .orderBy(SessionProviderOwnerLeaseTable.owner_token)
          .all()
        yield* recoverProviderReceiptsOnStartup({ ownerToken: crashRecoveryOwner, now: 3_500 })
        expect(
          yield* db
            .select()
            .from(SessionProviderOwnerLeaseTable)
            .orderBy(SessionProviderOwnerLeaseTable.owner_token)
            .all(),
        ).toEqual(leasesAfterSecond)
      }).pipe(Effect.provide(Layer.merge(database, crashSessionLayer))),
    )
  })
})

// ---------------------------------------------------------------------------
// question dismissal shape: question rejection terminalizes the legacy activity and
// the next prompt admission is not blocked by recovery_required.
// ---------------------------------------------------------------------------

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
    computeManifest: () => Effect.succeed(SessionSummary.emptyManifest()),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in incident regression tests"),
    authenticate: () => Effect.die("unexpected MCP auth in incident regression tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in incident regression tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
    catalog: () => Effect.succeed([]),
    enableCatalogEntry: () => Effect.succeed({ status: {}, name: "x", config: { type: "local", command: [] } }),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
    typeDefinition: () => Effect.succeed([]),
    declaration: () => Effect.succeed([]),
    prepareTypeHierarchy: () => Effect.succeed([]),
    supertypes: () => Effect.succeed([]),
    subtypes: () => Effect.succeed([]),
    inlayHint: () => Effect.succeed([]),
    codeAction: () => Effect.succeed([]),
    executeCommand: () => Effect.succeed(null),
    prepareRename: () => Effect.succeed(null),
    rename: () => Effect.succeed(null),
    documentHighlight: () => Effect.succeed([]),
    foldingRange: () => Effect.succeed([]),
    selectionRange: () => Effect.succeed([]),
    completion: () => Effect.succeed(null),
    signatureHelp: () => Effect.succeed(null),
    serverCapabilities: () => Effect.succeed(undefined),
    workspaceDiagnostics: () => Effect.succeed({}),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

// No-op RuntimeBase stub (debug/profile tools are never invoked here).
const stubRuntimeBaseLayer = Layer.succeed(
  RuntimeBase.Service,
  RuntimeBase.Service.of({
    gate: () => Effect.void,
    withIsolation: (_input, body) => body(""),
    checkPrivileges: () => Effect.succeed([]),
  }),
)

const debugStubDie = <A>(): Effect.Effect<A, never> =>
  Effect.die("DebugService stub (not used in incident regression tests)")
const stubDebugServiceLayer = Layer.succeed(
  DebugService.Service,
  DebugService.Service.of({
    start: debugStubDie,
    setBreakpoints: debugStubDie,
    continue: debugStubDie,
    step: debugStubDie,
    stackTrace: debugStubDie,
    scopes: debugStubDie,
    variables: debugStubDie,
    evaluate: debugStubDie,
    terminate: debugStubDie,
    get: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
  }),
)

// UPD-005: the Gap 1/Gap 2 persistence migration is not registered in
// migration.gen.ts yet (mainline registers it). Apply it over the tracked history
// so compaction_run carries the mode columns the drizzle schema already declares.
const database = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const service = yield* Database.Service
    yield* DatabaseMigration.applyOnly(service.db, [remoteCompactPersistenceMigration])
    return service
  }),
).pipe(Layer.provide(Database.defaultLayer))

function makeIncidentPromptLayer() {
  const runtimeFlags = RuntimeFlags.layer({
    experimentalEventSystem: true,
    coreV2ExecutionOwner: false,
  })
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    Auth.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    FSUtil.defaultLayer,
    BackgroundJob.defaultLayer,
    status,
    database,
    EventV2Bridge.defaultLayer,
    PromptEpoch.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(TestContextFacades.layer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Search.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(runtimeFlags),
    Layer.provide(stubDebugServiceLayer),
    Layer.provide(stubRuntimeBaseLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(summary),
    Layer.provide(Image.defaultLayer),
    Layer.provide(runtimeFlags),
    Layer.provideMerge(deps),
  )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(runtimeFlags),
    Layer.provide(RequestExecutor.defaultLayer),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  const steer = SessionSteer.layer.pipe(Layer.provideMerge(deps))
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionV2.defaultLayer),
    Layer.provide(SessionProviderOwner.layer.pipe(Layer.provide(deps))),
    Layer.provide(testInstanceStoreLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(steer),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(LocationIdentity.layer.pipe(Layer.provide(deps))),
    Layer.provide(
      Layer.succeed(
        ContextFederationReadiness.Service,
        ContextFederationReadiness.Service.of({
          snapshot: () => Effect.succeed(ContextFederationRollout.READINESS_READY_STUB),
        }),
      ),
    ),
    Layer.provide(runtimeFlags),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

const incidentPrompt = testEffect(Layer.mergeAll(TestLLMServer.layer, makeIncidentPromptLayer()))

const incidentCfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
        maxRetries: 0,
      },
    },
  },
}

function incidentProviderCfg(url: string) {
  return {
    ...incidentCfg,
    provider: {
      ...incidentCfg.provider,
      test: {
        ...incidentCfg.provider.test,
        options: { ...incidentCfg.provider.test.options, baseURL: url },
      },
    },
  }
}

const writeIncidentConfig = Effect.fn("IncidentRegression.writeConfig")(function* (
  dir: string,
  config: Record<string, unknown>,
) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    path.join(dir, "deepagent-code.json"),
    JSON.stringify({ $schema: "https://deepagent-code.ai/config.json", ...config }),
  )
})

const useIncidentServerConfig = Effect.fn("IncidentRegression.useServerConfig")(
  function* (config: (url: string) => Record<string, unknown>) {
    const { directory: dir } = yield* TestInstance
    const llm = yield* TestLLMServer
    yield* writeIncidentConfig(dir, config(llm.url))
    return { dir, llm }
  },
)

incidentPrompt.instance(
  "question dismissal terminalizes the activity authority and unblocks the next prompt admission",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useIncidentServerConfig(incidentProviderCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const question = yield* Question.Service
      const { db } = yield* Database.Service
      const chat = yield* sessions.create({
        title: "question dismissal",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("question", {
        questions: [
          {
            question: "Continue with this approach?",
            header: "Continue",
            options: [{ label: "Yes", description: "Continue" }],
          },
        ],
      })
      yield* llm.text("post dismissal admission works")

      const first = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "ask before proceeding" }],
        })
        .pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        Effect.gen(function* () {
          const pending = yield* question.list()
          return pending.find((item) => item.sessionID === chat.id)
        }),
        "timed out waiting for question request",
      )
      yield* question.reject(request.id)
      const firstResult = yield* Fiber.join(first)
      expect(firstResult.info.role).toBe("assistant")

      // Terminal authority shape: the rejected run must leave terminal rows.
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toMatchObject([
        { state: "interrupted", terminal_reason: "user_rejected_question" },
      ])
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toMatchObject([
        { state: "interrupted", terminal_reason: "user_rejected_question" },
      ])
      expect(yield* db.select().from(SessionLegacyActivityTerminalTable).all().pipe(Effect.orDie)).toMatchObject([
        { state: "interrupted", reason_code: "user_rejected_question", source: "host_stop" },
      ])
      // No recovery_required quarantine may linger after a clean dismissal.
      expect(
        yield* db
          .select()
          .from(SessionHistoryStateTable)
          .where(
            and(
              eq(SessionHistoryStateTable.session_id, chat.id),
              eq(SessionHistoryStateTable.state, "recovery_required"),
            ),
          )
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select()
          .from(SessionPromptEpochTable)
          .where(
            and(
              eq(SessionPromptEpochTable.session_id, chat.id),
              eq(SessionPromptEpochTable.authority_state, "recovery_required"),
            ),
          )
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])

      // The next prompt in the same session must be admitted and run.
      const next = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "continue after dismissal" }],
      })
      expect(next.parts.some((part) => part.type === "text" && part.text === "post dismissal admission works")).toBeTrue()
      expect(yield* llm.hits).toHaveLength(2)
      expect(
        yield* db
          .select()
          .from(SessionActivityAdmissionTable)
          .where(eq(SessionActivityAdmissionTable.session_id, chat.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(2)
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toMatchObject([
        { state: "interrupted", terminal_reason: "user_rejected_question" },
        { state: "settled", terminal_reason: "assistant_completed" },
      ])
      expect(yield* db.select().from(SessionLegacyActivityTerminalTable).all().pipe(Effect.orDie)).toMatchObject([
        { state: "interrupted", reason_code: "user_rejected_question", source: "host_stop" },
        { state: "settled", reason_code: "assistant_completed", source: "provider_final" },
      ])
    }),
  15_000,
)

incidentPrompt.instance(
  "question dismissal residual: continue_loop_on_deny keeps the run alive after dismissal and still terminalizes the activity",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useIncidentServerConfig((url) => ({
        ...incidentProviderCfg(url),
        experimental: { continue_loop_on_deny: true },
      }))
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const question = yield* Question.Service
      const { db } = yield* Database.Service
      const chat = yield* sessions.create({
        title: "question dismissal continue_loop_on_deny",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("question", {
        questions: [
          {
            question: "Continue with this approach?",
            header: "Continue",
            options: [{ label: "Yes", description: "Continue" }],
          },
        ],
      })
      yield* llm.text("loop continued after deny")
      yield* llm.text("next prompt admitted after continue-on-deny")

      const first = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "ask before proceeding" }],
        })
        .pipe(Effect.forkChild)
      const request = yield* pollWithTimeout(
        Effect.gen(function* () {
          const pending = yield* question.list()
          return pending.find((item) => item.sessionID === chat.id)
        }),
        "timed out waiting for question request",
      )
      yield* question.reject(request.id)
      const firstResult = yield* Fiber.join(first)
      expect(firstResult.info.role).toBe("assistant")
      // The loop must NOT stop at the dismissal: the SAME run completes with the continuation text
      // (the rejection is a tool failure, not a typed stop reason, under continue_loop_on_deny).
      expect(
        firstResult.parts.some((part) => part.type === "text" && part.text === "loop continued after deny"),
      ).toBeTrue()
      // The rejection surfaced as a tool FAILURE carrying the failureCode, not a turn abort.
      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const questionPart = msgs
        .flatMap((m) => m.parts)
        .find((p) => p.type === "tool") as
        | { state: { status: string; metadata?: Record<string, unknown> } }
        | undefined
      expect(questionPart?.state.status).toBe("error")
      expect(questionPart?.state.metadata?.failureCode).toBe("user_rejected_question")

      // The SAME activity terminalizes at run end — settled, never interrupted, never left active.
      // (The run row uses its own terminal vocabulary: "completed" for a settled outcome.)
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toMatchObject([
        { state: "settled", terminal_reason: "assistant_completed" },
      ])
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toMatchObject([
        { state: "completed", terminal_reason: "assistant_completed" },
      ])
      expect(yield* db.select().from(SessionLegacyActivityTerminalTable).all().pipe(Effect.orDie)).toMatchObject([
        { state: "settled", reason_code: "assistant_completed", source: "provider_final" },
      ])
      // No recovery_required quarantine may linger after a continue-on-deny completion.
      expect(
        yield* db
          .select()
          .from(SessionHistoryStateTable)
          .where(
            and(
              eq(SessionHistoryStateTable.session_id, chat.id),
              eq(SessionHistoryStateTable.state, "recovery_required"),
            ),
          )
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select()
          .from(SessionPromptEpochTable)
          .where(
            and(
              eq(SessionPromptEpochTable.session_id, chat.id),
              eq(SessionPromptEpochTable.authority_state, "recovery_required"),
            ),
          )
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])

      // The next prompt in the same session must be admitted and run (no "requires recovery" conflict).
      const next = yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "continue after continue-on-deny" }],
      })
      expect(
        next.parts.some((part) => part.type === "text" && part.text === "next prompt admitted after continue-on-deny"),
      ).toBeTrue()
      expect(yield* llm.hits).toHaveLength(3)
      expect(
        yield* db
          .select()
          .from(SessionActivityAdmissionTable)
          .where(eq(SessionActivityAdmissionTable.session_id, chat.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(2)
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toMatchObject([
        { state: "settled", terminal_reason: "assistant_completed" },
        { state: "settled", terminal_reason: "assistant_completed" },
      ])
    }),
  15_000,
)

// ---------------------------------------------------------------------------
// provider recovery shape: abandoned resolution of an indeterminate receipt
// ---------------------------------------------------------------------------

const resolutionLayer = Layer.mergeAll(
  Session.defaultLayer,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
  SessionProjector.defaultLayer,
  SessionLegacyProviderResolution.defaultLayer,
  SessionProviderOwner.layer.pipe(Layer.provide(Database.defaultLayer)),
  LocationIdentity.defaultLayer,
)
const resolution = testEffect(resolutionLayer)
const resolutionModel = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") }
let nextMessageTime = 1

const addUser = Effect.fn("IncidentRegression.addUser")(function* (
  sessionID: Parameters<Session.Interface["get"]>[0],
  text: string,
) {
  const session = yield* Session.Service
  const message = yield* session.updateMessage({
    id: MessageID.ascending(`msg_${String(nextMessageTime++).padStart(26, "0")}`),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: resolutionModel,
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: message.id,
    type: "text",
    text,
  })
  return message
})

const addAssistant = Effect.fn("IncidentRegression.addAssistant")(function* (
  sessionID: Parameters<Session.Interface["get"]>[0],
  parentID: MessageID,
  completed = false,
) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(`msg_${String(nextMessageTime++).padStart(26, "0")}`),
    sessionID,
    role: "assistant",
    parentID,
    time: { created: Date.now(), ...(completed ? { completed: Date.now() } : {}) },
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: resolutionModel.modelID,
    providerID: resolutionModel.providerID,
    ...(completed ? { finish: "stop" as const } : {}),
  })
})

// Mirrors the legal-lifecycle crash fixture of legacy-provider-resolution.test.ts:
// rows are seeded in non-terminal states and advanced through the provider
// lifecycle updates before being left indeterminate by a simulated restart.
const seedIndeterminateProviderTurn = Effect.fn("IncidentRegression.seedIndeterminateProviderTurn")(
  function* (input: {
    session: Session.Info
    userMessageID: MessageID
    assistantMessageID: MessageID
    receiptID: string
    providerAttemptID: string
    activityID: string
    selectionID: string
    requestHash: string
    prompt?: { epoch: number; windowID: string; historyHash: string }
  }) {
    const db = (yield* Database.Service).db
    const owners = yield* SessionProviderOwner.Service
    const identity = yield* LocationIdentity.Service.use((service) =>
      service.resolve({
        boundary: { kind: "implicit_local" },
        directory: AbsolutePath.make(input.session.directory),
        project: { kind: "git", observedProjectId: input.session.projectID },
      }),
    )
    const binding = DeepAgentReleasedSnapshot.binding(undefined)
    const staleOwnerToken = `stale:${input.receiptID}`
    const recoveryOwnerToken = `recovery:${input.receiptID}`
    const now = Date.now()
    const preparedTurnHash = Hash.sha256(`prepared:${input.receiptID}`)
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
      identity.projectScopeKey,
      { stage: "all", percentage: 100, internalProjectScopeKeys: [], killSwitch: false },
    )
    const contextReadiness = {
      ...ContextFederationRollout.READINESS_READY_STUB,
      revision: `readiness:${input.receiptID}`,
      observedAt: now,
      expiresAt: now + 60_000,
    }
    const contextActivation = ContextActivationReceipt.make({
      readiness: contextReadiness,
      decision: ContextFederationRollout.activate(contextEligibility, contextReadiness),
      recordedAt: now,
      projectionEnabled: true,
      toolsEnabled: true,
      selection: { selectionId: input.selectionID, projectionHash: "projection" },
    })

    yield* owners.register({ ownerToken: staleOwnerToken, leaseMs: SessionProviderOwner.LeaseMs })
    yield* Effect.addFinalizer(() => owners.release({ ownerToken: staleOwnerToken }).pipe(Effect.ignore))
    yield* db
      .insert(SessionInputTable)
      .values({
        id: SessionMessage.ID.make(input.userMessageID),
        session_id: input.session.id,
        prompt: new Prompt({ text: "dispatch then crash" }),
        delivery: "steer",
        admitted_seq: 0,
        promoted_seq: 0,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionActivityTable) // fixture-exempt: seeds active activity for provider recovery abandoned-resolution fixture
      .values({
        activity_id: input.activityID,
        session_id: input.session.id,
        ordinal: 0,
        trigger_input_id: input.userMessageID,
        delivery: "steer",
        state: "active",
        created_at: now,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionContextSelectionTable)
      .values({
        selection_id: input.selectionID,
        session_id: input.session.id,
        activity_id: input.activityID,
        revision: 0,
        trigger_input_id: input.userMessageID,
        location_key: identity.locationKey,
        security_namespace_id: identity.securityNamespaceId,
        project_scope_key: identity.projectScopeKey,
        query_fingerprint: "query",
        authorization_fingerprint: "authorization",
        authorization_epoch: 0,
        execution_fingerprint: "execution",
        selected_source_fingerprint: "sources",
        observed_location_mutation_epoch: 0,
        next_revalidation_at: now + 60_000,
        released_knowledge_binding_state: binding.state,
        released_knowledge_exact_refs: binding.exactRefs,
        released_knowledge_exact_refs_fingerprint: binding.exactRefsFingerprint,
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
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionProviderAttemptTable) // fixture-exempt: seeds prepared attempt with stale owner for provider recovery crash fixture
      .values({
        attempt_id: input.providerAttemptID,
        session_id: input.session.id,
        activity_id: input.activityID,
        provider_turn_seq: 0,
        selection_id: input.selectionID,
        projection_hash: "projection",
        request_hash: input.requestHash,
        provider_id: resolutionModel.providerID,
        owner_token: staleOwnerToken,
        state: "prepared",
        created_at: now,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionToolRequestReceiptTable) // fixture-exempt: seeds preparing receipt for provider recovery crash fixture
      .values({
        receipt_id: input.receiptID,
        request_ordinal: 1,
        session_id: input.session.id,
        user_message_id: input.userMessageID,
        assistant_message_id: input.assistantMessageID,
        provider_attempt_id: input.providerAttemptID,
        context_selection_id: input.selectionID,
        context_eligibility: contextEligibility,
        context_readiness: contextReadiness,
        context_activation: contextActivation,
        context_activation_fingerprint: ContextActivationReceipt.fingerprint({
          eligibility: contextEligibility,
          readiness: contextReadiness,
          activation: contextActivation,
        }),
        released_knowledge_security_namespace_id: identity.securityNamespaceId,
        released_knowledge_project_scope_key: identity.projectScopeKey,
        released_knowledge_binding_state: binding.state,
        released_knowledge_exact_refs: binding.exactRefs,
        released_knowledge_exact_refs_fingerprint: binding.exactRefsFingerprint,
        provider_id: resolutionModel.providerID,
        model_id: resolutionModel.modelID,
        protocol: "chat",
        registry_tool_ids: [],
        permission_filtered_tool_ids: [],
        final_offered_tool_ids: [],
        call_ids: [],
        ...(input.prompt
          ? {
              prompt_epoch: input.prompt.epoch,
              prompt_window_id: input.prompt.windowID,
              effective_history_hash: input.prompt.historyHash,
            }
          : {}),
        request_input_hash: input.requestHash,
        provider_state: "preparing",
        owner_token: staleOwnerToken,
        request_state: "prepared",
        created_at: now,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .update(SessionProviderAttemptTable)
      .set({ prepared_turn_hash: preparedTurnHash, wire_request_hash: input.requestHash })
      .where(eq(SessionProviderAttemptTable.attempt_id, input.providerAttemptID))
      .run()
      .pipe(Effect.orDie)
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        released_knowledge_selected_refs: [],
        released_knowledge_selected_refs_fingerprint: binding.exactRefsFingerprint,
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, input.receiptID))
      .run()
      .pipe(Effect.orDie)
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        provider_state: "prepared",
        final_request_hash: input.requestHash,
        provider_request_hash: input.requestHash,
        adapter_prepared_at: now,
        tool_definition_hash: Hash.sha256("[]"),
        prepared_turn_hash: preparedTurnHash,
        system_stable_hash: Hash.sha256(`stable:${input.receiptID}`),
        system_volatile_hash: Hash.sha256(`volatile:${input.receiptID}`),
        wire_request_hash: input.requestHash,
        tool_result_reference_ids: [],
        tool_result_reference_count: 0,
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, input.receiptID))
      .run()
      .pipe(Effect.orDie)
    yield* db
      .update(SessionProviderAttemptTable)
      .set({ state: "dispatching" })
      .where(eq(SessionProviderAttemptTable.attempt_id, input.providerAttemptID))
      .run()
      .pipe(Effect.orDie)
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        provider_state: "indeterminate_after_crash",
        request_state: "dispatched",
        dispatching_at: now,
        terminal_at: now,
        request_error_code: "provider_started_outcome_unknown_after_process_restart",
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, input.receiptID))
      .run()
      .pipe(Effect.orDie)
    yield* owners.register({ ownerToken: recoveryOwnerToken, leaseMs: SessionProviderOwner.LeaseMs })
    yield* Effect.addFinalizer(() => owners.release({ ownerToken: recoveryOwnerToken }).pipe(Effect.ignore))
    yield* owners.release({ ownerToken: staleOwnerToken })
    yield* db
      .update(SessionProviderAttemptTable)
      .set({ state: "indeterminate_after_crash", error_code: "process_recovery" })
      .where(eq(SessionProviderAttemptTable.attempt_id, input.providerAttemptID))
      .run()
      .pipe(Effect.orDie)
    return { recoveryOwnerToken }
  },
)

resolution.instance(
  "provider recovery: abandoned resolution unblocks the session, permits cutoff forks, and is idempotent",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const recovery = yield* SessionLegacyProviderResolution.Service
      yield* TestInstance
      const { db } = yield* Database.Service
      const parent = yield* sessions.create({ title: "incident abandoned resolution parent" })
      const source = yield* sessions.fork({ sessionID: parent.id, intentID: "incident-abandoned-source" })
      const safeUser = yield* addUser(source.id, "completed before provider crash")
      const safeAssistant = yield* addAssistant(source.id, safeUser.id, true)
      const user = yield* addUser(source.id, "dispatch then crash")
      const assistant = yield* addAssistant(source.id, user.id)
      const authority = yield* MessageV2.promptHistoryProjectionEffect(source.id)
      if (!authority.worldStateBaselineHash) return yield* Effect.die("expected frozen source World State baseline")
      const receiptID = "receipt-incident-abandoned"
      const providerAttemptID = "attempt-incident-abandoned"
      const providerActivityID = "activity-incident-abandoned"
      const providerSelectionID = "selection-incident-abandoned"
      const seeded = yield* seedIndeterminateProviderTurn({
        session: source,
        userMessageID: user.id,
        assistantMessageID: assistant.id,
        receiptID,
        providerAttemptID,
        activityID: providerActivityID,
        selectionID: providerSelectionID,
        requestHash: Hash.sha256("incident-final-request-hash"),
        prompt: {
          epoch: authority.epoch,
          windowID: authority.window.windowID,
          historyHash: authority.effectiveHistoryHash,
        },
      })
      const now = Date.now()
      yield* db
        .update(SessionPromptEpochTable)
        .set({ authority_state: "recovery_required", recovery_reason: "provider outcome is unknown after restart" })
        .where(
          and(eq(SessionPromptEpochTable.session_id, source.id), eq(SessionPromptEpochTable.epoch, authority.epoch)),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(SessionHistoryStateTable)
        .set({
          state: "recovery_required",
          reason: "provider outcome is unknown after restart",
          time_updated: now,
        })
        .where(eq(SessionHistoryStateTable.session_id, source.id))
        .run()
        .pipe(Effect.orDie)

      const descriptors = yield* recovery.describe(source.id)
      expect(descriptors).toHaveLength(1)
      const [descriptor] = descriptors
      expect(descriptor).toMatchObject({
        receiptID,
        sessionID: source.id,
        providerState: "indeterminate_after_crash",
        promptEpoch: authority.epoch,
        continuationRecoverySupported: true,
      })

      // While the turn is indeterminate, forking before the crashed turn's
      // cutoff stays possible and cutoffs at/after it stay blocked.
      const prefixFork = yield* sessions.fork({
        sessionID: source.id,
        messageID: user.id,
        intentID: "fork-before-incident-abandoned-turn",
      })
      expect(
        (yield* sessions.messages({ sessionID: prefixFork.id })).map((message) => message.info.role),
      ).toEqual(["user", "assistant"])
      expect(
        yield* sessions
          .fork({
            sessionID: source.id,
            messageID: assistant.id,
            intentID: "fork-at-incident-abandoned-turn",
          })
          .pipe(Effect.flip),
      ).toMatchObject({
        _tag: "Session.ForkConflict",
        reason: expect.stringContaining("fork cutoff is outside the recoverable history prefix"),
      })

      if (!descriptor) return
      if (!descriptor.resolutionSupported)
        return yield* Effect.die(
          `expected a resolvable provider recovery descriptor: ${descriptor.unsupportedReasons.join(",")}`,
        )
      const command = {
        sessionID: source.id,
        commandID: "resolve-incident-abandoned",
        receiptID,
        decision: "abandoned" as const,
        expected: {
          providerState: "indeterminate_after_crash" as const,
          promptEpoch: descriptor.promptEpoch,
          sessionMutationEpoch: descriptor.sessionMutationEpoch,
          requestHash: descriptor.requestHash,
          historyHash: descriptor.historyHash,
          worldStateBaselineHash: descriptor.worldStateBaselineHash,
        },
        actorID: "test-user",
      }

      // Explicit abandoned resolution, then idempotent repeats.
      const first = yield* recovery.resolve(command)
      expect(first).toMatchObject({
        decision: "abandoned",
        sourcePromptEpoch: authority.epoch,
        successorPromptEpoch: authority.epoch + 1,
        sourceMutationEpoch: 0,
        successorMutationEpoch: 1,
      })
      const retry = yield* recovery.resolve(command)
      expect(retry).toEqual(first)
      const repeat = yield* recovery.resolve(command)
      expect(repeat).toEqual(first)
      expect(yield* recovery.describe(source.id)).toEqual([])
      expect(
        yield* db
          .select({ attemptID: SessionProviderAttemptResolutionTable.attempt_id, decision: SessionProviderAttemptResolutionTable.decision })
          .from(SessionProviderAttemptResolutionTable)
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ attemptID: providerAttemptID, decision: "abandoned" }])
      expect(
        yield* db
          .select({ state: SessionProviderAttemptTable.state })
          .from(SessionProviderAttemptTable)
          .where(eq(SessionProviderAttemptTable.attempt_id, providerAttemptID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "resolved_abandoned" })
      expect(
        yield* db
          .select({ state: SessionActivityTable.state })
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.activity_id, providerActivityID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "interrupted" })

      // Startup recovery after resolution must clear the quarantine to ready.
      yield* recoverProviderReceiptsOnStartup({ ownerToken: seeded.recoveryOwnerToken })
      expect(
        yield* db
          .select({ state: SessionHistoryStateTable.state })
          .from(SessionHistoryStateTable)
          .where(eq(SessionHistoryStateTable.session_id, source.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "ready" })

      // Forking stays possible after resolution: the safe prefix copies cleanly.
      const fork = yield* sessions.fork({
        sessionID: source.id,
        intentID: "fork-after-incident-abandoned-resolution",
      })
      expect(
        (yield* sessions.messages({ sessionID: fork.id })).map((message) => message.info.role),
      ).toEqual(["user", "assistant"])

      // The session keeps accepting newly admitted messages.
      const continued = yield* addUser(source.id, "continue after explicit abandon")
      const admittedAt = Date.now()
      yield* db
        .insert(SessionIntentTable)
        .values({
          intent_id: "incident-continue-after-explicit-abandon",
          session_id: source.id,
          source: "composer",
          state: "admitted",
          selected_variant: "original",
          selected_payload_hash: "test",
          delivery: "turn",
          admitted_message_id: continued.id,
          execution_mode: "legacy",
          execution_state: "legacy",
          mutation_epoch: first.successorMutationEpoch,
          version: 1,
          time_created: admittedAt,
          time_selected: admittedAt,
          time_admitted: admittedAt,
          time_updated: admittedAt,
        })
        .run()
        .pipe(Effect.orDie)
      const continuedProjection = yield* MessageV2.promptHistoryProjectionEffect(source.id)
      expect(continuedProjection.messages.map((message) => message.info.id)).toEqual([
        safeUser.id,
        safeAssistant.id,
        continued.id,
      ])
      expect(continuedProjection.epoch).toBe(authority.epoch + 1)
      expect(continuedProjection.recoveryResolutionID).toBe(first.resolutionID)
    }),
  { git: true },
  30_000,
)
