import { afterEach, describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Hash } from "@deepagent-code/core/util/hash"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import {
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionProviderAttemptRecoveryBridgeTable,
  SessionProviderAttemptResolutionTable,
  SessionProviderAttemptTable,
  SessionProviderOwnerLeaseTable,
} from "@deepagent-code/core/context-federation/session-sql"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "@deepagent-code/core/context-federation/sql"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionHistoryStateTable, SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { and, eq, sql } from "drizzle-orm"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { ProjectScopeKey, SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"
import { ContextActivationReceipt } from "@/context-federation/activation-receipt"
import { Effect, Layer } from "effect"
import { MessageV2 } from "@/session/message-v2"
import { SessionPromptEpochTable } from "@/session/prompt-epoch.sql"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionToolRequestReceiptTable } from "@/session/tool-request-receipt.sql"
import { SessionPaths } from "@/server/routes/instance/httpapi/groups/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const originalWorkspaceID = Flag.DEEPAGENT_CODE_WORKSPACE_ID
const it = testEffect(Layer.mergeAll(Session.defaultLayer, Database.defaultLayer, httpApiLayer))
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") }

type Descriptor = {
  receiptID: string
  providerState: "indeterminate_after_crash"
  promptEpoch: number
  requestHash: string
  historyHash: string
  worldStateBaselineHash?: string
  sessionMutationEpoch: number
  workspaceRecoverySupported: boolean
}

const pathFor = (sessionID: string) => SessionPaths.providerResolution.replace(":sessionID", sessionID)

const parseJson = <A>(response: { readonly json: Effect.Effect<unknown, unknown> }) =>
  response.json.pipe(Effect.map((body) => body as A))

const seedRecovery = Effect.fn("HttpProviderRecoveryTest.seedRecovery")(function* (
  title: string,
  providerAttempt = false,
) {
  const sessions = yield* Session.Service
  const { db } = yield* Database.Service
  const parent = yield* sessions.create({ title: `${title} parent` })
  const session = yield* sessions.fork({ sessionID: parent.id, intentID: `fork-${Hash.sha256(title).slice(0, 24)}` })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model,
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: session.id,
    messageID: user.id,
    type: "text",
    text: "dispatch this provider request",
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: user.id,
    time: { created: Date.now() },
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: session.directory, root: session.directory },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: model.modelID,
    providerID: model.providerID,
  })
  const authority = yield* MessageV2.promptHistoryProjectionEffect(session.id)
  if (!authority.worldStateBaselineHash) return yield* Effect.die("expected frozen source World State baseline")
  const now = Date.now()
  const receiptID = `receipt-${Hash.sha256(title).slice(0, 24)}`
  const requestHash = `request-${Hash.sha256(title).slice(0, 24)}`
  const providerAttemptID = `attempt-${Hash.sha256(title).slice(0, 24)}`
  const activityID = `activity-${Hash.sha256(title).slice(0, 24)}`
  const selectionID = `selection-${Hash.sha256(title).slice(0, 24)}`
  // Durable federation authority for the seeded selection/attempt/receipt chain: a synthesized
  // namespace/scope identity plus the crashed owner's token (its lease is seeded live below).
  const securityNamespaceID = `sec-${Hash.sha256(`${title}-ns`).slice(0, 24)}`
  const projectScopeKey = `prjctx-${Hash.sha256(`${title}-scope`).slice(0, 24)}`
  const ownerToken = `dead-${Hash.sha256(`${title}-owner`).slice(0, 20)}`
  // 64-hex wire identity hashes the durable turn guards demand; derived per fixture title.
  const finalRequestHash = Hash.sha256(`${title}-final-request`)
  const preparedTurnHash = Hash.sha256(`${title}-prepared-turn`)
  const systemStableHash = Hash.sha256(`${title}-system-stable`)
  const systemVolatileHash = Hash.sha256(`${title}-system-volatile`)
  const toolDefinitionHash = Hash.sha256(`${title}-tool-definition`)
  const contextActivationFingerprint = Hash.sha256(`${title}-context-activation`)
  // Typed federation fixture values the receipt columns demand: a not_requested decision whose
  // requested/enabled/project fields mirror between eligibility and activation (the semantic
  // guard compares them field-by-field as JSON).
  const fixtureRequested: ContextFederationRollout.Requested = {
    contextFederationShadow: false,
    locationIndexesV2Shadow: false,
    contextProjectionV2: false,
    contextQueryToolsV2: false,
    coreV2ExecutionOwner: false,
  }
  const fixtureEligibility: ContextFederationRollout.ProjectDecision = {
    requested: fixtureRequested,
    enabled: fixtureRequested,
    blocked: {},
    project: { projectScopeKey, stage: "all", bucket: 0, selected: false, killSwitch: false },
  }
  const fixtureReadiness: ContextFederationRollout.DerivedContextDataReadiness = {
    revision: Hash.sha256(`${title}-readiness`),
    state: "ready",
    identityBound: true,
    indexAvailable: true,
    storageHealthy: true,
    projectScopeKey,
    reasons: [],
    observedAt: now,
    expiresAt: now + 600_000,
  }
  const fixtureActivation: ContextActivationReceipt.Receipt = {
    schemaVersion: 1,
    recordedAt: now,
    readinessAgeMs: 0,
    readinessExpiresInMs: 600_000,
    outcome: "not_requested",
    enabledCapabilities: [],
    fallbackReasons: [],
    decision: fixtureEligibility,
    // The semantic guard forbids a selection reference without a bound selection row.
    ...(providerAttempt ? { selection: { selectionId: selectionID, projectionHash: "projection" } } : {}),
  }
  // DB-clock timestamp expression (the lease triggers reject host-skewed values).
  const dbNowMs = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`

  // The receipt/attempt owner guards demand a live exact owner lease at database time regardless
  // of whether an attempt is seeded; the fixture receipt always belongs to the crashed owner.
  yield* db
    .insert(SessionProviderOwnerLeaseTable)
    .values({
      owner_token: ownerToken,
      registered_at: dbNowMs,
      heartbeat_at: dbNowMs,
      lease_expires_at: sql`${dbNowMs} + 3600000`,
      released_at: null,
    } as never)
    .run()
    .pipe(Effect.orDie)

  // Every receipt demands a durable released-knowledge scope authority: synthesize the minimal
  // namespace/scope identity chain (the location identity is only needed by the selection guard
  // and stays with the attempt branch below).
  yield* db
    .insert(SecurityNamespaceTable)
    .values({
      id: securityNamespaceID,
      kind: "implicit_local",
      binding_hash: Hash.sha256(`${title}-binding`),
      created_at: now,
      retired_at: null,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(ProjectScopeIdentityTable)
    .values({
      security_namespace_id: securityNamespaceID,
      project_scope_key: projectScopeKey,
      project_kind: "registered_root",
      project_identity_hash: Hash.sha256(`${title}-project`),
      observed_project_id: `project-${Hash.sha256(title).slice(0, 16)}`,
      created_at: now,
      retired_at: null,
    })
    .run()
    .pipe(Effect.orDie)

  if (providerAttempt) {
    yield* db
      .insert(SessionInputTable)
      .values({
        id: SessionMessage.ID.make(user.id),
        session_id: session.id,
        prompt: new Prompt({ text: "dispatch this provider request" }),
        delivery: "steer",
        admitted_seq: 0,
        promoted_seq: 0,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionActivityTable) // fixture-exempt: seeds active activity for crash-recovery fixture
      .values({
        activity_id: activityID,
        session_id: session.id,
        ordinal: 0,
        trigger_input_id: user.id,
        delivery: "steer",
        state: "active",
        created_at: now,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(LocationIdentityTable)
      .values({
        security_namespace_id: securityNamespaceID,
        location_key: "local",
        project_scope_key: projectScopeKey,
        workspace_binding: null,
        canonical_root: `/recovery-fixture/${Hash.sha256(title).slice(0, 8)}`,
        observed_project_id: null,
        created_at: now,
        retired_at: null,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionContextSelectionTable)
      .values({
        selection_id: selectionID,
        session_id: session.id,
        activity_id: activityID,
        revision: 0,
        trigger_input_id: user.id,
        location_key: "local",
        security_namespace_id: SecurityNamespaceID.make(securityNamespaceID),
        project_scope_key: ProjectScopeKey.make(projectScopeKey),
        query_fingerprint: "query",
        authorization_fingerprint: "authorization",
        authorization_epoch: 0,
        execution_fingerprint: "execution",
        selected_source_fingerprint: "sources",
        observed_location_mutation_epoch: 0,
        next_revalidation_at: now + 60_000,
        released_knowledge_binding_state: "unavailable",
        released_knowledge_exact_refs: [],
        released_knowledge_exact_refs_fingerprint: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
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
      .insert(SessionProviderAttemptTable) // fixture-exempt: admitted prepared attempt; walked to the crashed state below
      .values({
        attempt_id: providerAttemptID,
        session_id: session.id,
        activity_id: activityID,
        provider_turn_seq: 0,
        selection_id: selectionID,
        projection_hash: "projection",
        request_hash: `input-${requestHash}`,
        provider_id: model.providerID,
        owner_token: ownerToken,
        state: "prepared",
        created_at: now,
      })
      .run()
      .pipe(Effect.orDie)
    // Seal the attempt's wire identity once (prepared→prepared), the sole admission path.
    yield* db
      .update(SessionProviderAttemptTable)
      .set({ prepared_turn_hash: preparedTurnHash, wire_request_hash: finalRequestHash })
      .where(eq(SessionProviderAttemptTable.attempt_id, providerAttemptID))
      .run()
      .pipe(Effect.orDie)
  }

  yield* db
    .update(SessionPromptEpochTable)
    .set({
      authority_state: "recovery_required",
      recovery_reason: "provider outcome unknown after restart",
    })
    .where(and(eq(SessionPromptEpochTable.session_id, session.id), eq(SessionPromptEpochTable.epoch, authority.epoch)))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionToolRequestReceiptTable) // fixture-exempt: bare 'preparing' receipt; walked through the durable lifecycle below
    .values({
      receipt_id: receiptID,
      request_ordinal: 1,
      session_id: session.id,
      user_message_id: user.id,
      assistant_message_id: assistant.id,
      provider_attempt_id: providerAttempt ? providerAttemptID : null,
      context_selection_id: providerAttempt ? selectionID : null,
      released_knowledge_security_namespace_id: SecurityNamespaceID.make(securityNamespaceID),
      released_knowledge_project_scope_key: ProjectScopeKey.make(projectScopeKey),
      released_knowledge_binding_state: "unavailable",
      released_knowledge_exact_refs: [],
      released_knowledge_exact_refs_fingerprint: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      provider_id: model.providerID,
      model_id: model.modelID,
      protocol: "chat",
      registry_tool_ids: [],
      permission_filtered_tool_ids: [],
      final_offered_tool_ids: [],
      call_ids: [],
      prompt_epoch: authority.epoch,
      prompt_window_id: authority.window.windowID,
      effective_history_hash: authority.effectiveHistoryHash,
      request_input_hash: `input-${requestHash}`,
      // Context activation semantics are admission-time bindings (immutable after insert).
      context_eligibility: fixtureEligibility,
      context_readiness: fixtureReadiness,
      context_activation: fixtureActivation,
      context_activation_fingerprint: contextActivationFingerprint,
      // The receipt insert guard only admits a bare provider_state='preparing' row; the seed then
      // walks the durable lifecycle (seal selected refs → prepared → dispatching → crash) so the
      // fixture lands on the same indeterminate state the legacy seed used to write directly.
      provider_state: "preparing",
      owner_token: ownerToken,
      request_state: "prepared",
      created_at: now,
    })
    .run()
    .pipe(Effect.orDie)
  // 1) seal selected refs once while still preparing.
  yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        released_knowledge_selected_refs: [],
        released_knowledge_selected_refs_fingerprint: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, receiptID))
      .run()
      .pipe(Effect.orDie)
    // 2) seal the prepared turn and admit the receipt as prepared.
    yield* db
      .update(SessionToolRequestReceiptTable)
      .set({
        provider_state: "prepared",
        final_request_hash: finalRequestHash,
        provider_request_hash: finalRequestHash,
        wire_request_hash: finalRequestHash,
        prepared_turn_hash: preparedTurnHash,
        system_stable_hash: systemStableHash,
        system_volatile_hash: systemVolatileHash,
        tool_definition_hash: toolDefinitionHash,
        adapter_prepared_at: now,
        final_offered_tool_ids: ["fixture_tool"],
      })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, receiptID))
      .run()
      .pipe(Effect.orDie)
  // 3) dispatch: the attempt first when present (wire identity must match), then the receipt.
  if (providerAttempt) {
    yield* db
      .update(SessionProviderAttemptTable)
      .set({ state: "dispatching" })
      .where(eq(SessionProviderAttemptTable.attempt_id, providerAttemptID))
      .run()
      .pipe(Effect.orDie)
  }
  yield* db
      .update(SessionToolRequestReceiptTable)
      .set({ provider_state: "dispatching", dispatching_at: now })
      .where(eq(SessionToolRequestReceiptTable.receipt_id, receiptID))
      .run()
      .pipe(Effect.orDie)
  // 4) simulate the process crash mid-dispatch: with an attempt present, the dead owner's lease
  // is released, a recovery process takes a fresh lease, and the crash sweep marks the attempt
  // indeterminate (the recovery owner guard demands exactly this stale-old/live-recovery pair).
  if (providerAttempt) {
    yield* db
      .update(SessionProviderOwnerLeaseTable)
      .set({ released_at: sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)` })
      .where(eq(SessionProviderOwnerLeaseTable.owner_token, ownerToken))
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionProviderOwnerLeaseTable)
      .values({
        owner_token: `recovery-${Hash.sha256(`${title}-recovery`).slice(0, 16)}`,
        registered_at: dbNowMs,
        heartbeat_at: dbNowMs,
        lease_expires_at: sql`${dbNowMs} + 3600000`,
        released_at: null,
      } as never)
      .run()
      .pipe(Effect.orDie)
    yield* db
      .update(SessionProviderAttemptTable)
      .set({ state: "indeterminate_after_crash", error_code: "process_recovery" })
      .where(eq(SessionProviderAttemptTable.attempt_id, providerAttemptID))
      .run()
      .pipe(Effect.orDie)
  }
  yield* db
    .update(SessionToolRequestReceiptTable)
    .set({
      provider_state: "indeterminate_after_crash",
      terminal_at: now,
      request_state: "dispatched",
      request_error_code: "provider_started_outcome_unknown_after_process_restart",
    })
    .where(eq(SessionToolRequestReceiptTable.receipt_id, receiptID))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(SessionHistoryStateTable)
    .set({
      state: "recovery_required",
      reason: "provider outcome unknown after restart",
      time_updated: now,
    })
    .where(eq(SessionHistoryStateTable.session_id, session.id))
    .run()
    .pipe(Effect.orDie)

  return { session, receiptID, ...(providerAttempt ? { providerAttemptID, activityID } : {}) }
})

const command = (descriptor: Descriptor, commandID: string) => ({
  commandID,
  receiptID: descriptor.receiptID,
  decision: "abandoned" as const,
  expected: {
    providerState: descriptor.providerState,
    promptEpoch: descriptor.promptEpoch,
    sessionMutationEpoch: descriptor.sessionMutationEpoch,
    requestHash: descriptor.requestHash,
    historyHash: descriptor.historyHash,
    worldStateBaselineHash: descriptor.worldStateBaselineHash!,
  },
})

afterEach(async () => {
  Flag.DEEPAGENT_CODE_WORKSPACE_ID = originalWorkspaceID
  await disposeAllInstances()
  await resetDatabase()
})

describe("provider recovery HttpApi", () => {
  it.instance(
    "enforces GET authority, exact retry, command conflict, stale CAS, and workspace ownership",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const { db } = yield* Database.Service
        const headers = { "content-type": "application/json" }

        const dual = yield* seedRecovery("http unified provider authority", true)
        if (!dual.providerAttemptID || !dual.activityID) return
        const contextPath = SessionPaths.contextAttemptResolve
          .replace(":sessionID", dual.session.id)
          .replace(":attemptID", dual.providerAttemptID)
        const independentlyResolved = yield* requestInDirectory(contextPath, instance.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            decision: "abandoned",
            reason: "must use unified provider recovery",
            riskAcknowledged: false,
          }),
        })
        expect(independentlyResolved.status).toBe(400)
        expect(yield* db.select().from(SessionProviderAttemptResolutionTable).all()).toEqual([])

        const dualList = yield* requestInDirectory(pathFor(dual.session.id), instance.directory, { headers })
        expect(dualList.status).toBe(200)
        const [dualDescriptor] = yield* parseJson<Descriptor[]>(dualList)
        if (!dualDescriptor) return
        const dualCommand = command(dualDescriptor, "http-provider-recovery-unified")
        const dualResponse = yield* requestInDirectory(pathFor(dual.session.id), instance.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(dualCommand),
        })
        expect(dualResponse.status).toBe(200)
        const dualResolution = yield* parseJson<{ resolutionID: string }>(dualResponse)
        const dualRetry = yield* requestInDirectory(pathFor(dual.session.id), instance.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(dualCommand),
        })
        expect(dualRetry.status).toBe(200)
        expect(yield* parseJson<{ resolutionID: string }>(dualRetry)).toEqual(dualResolution)
        expect(yield* db.select().from(SessionProviderAttemptRecoveryBridgeTable).get()).toMatchObject({
          resolution_id: dualResolution.resolutionID,
          attempt_id: dual.providerAttemptID,
          receipt_id: dual.receiptID,
          command_id: dualCommand.commandID,
        })
        expect(yield* db.select().from(SessionProviderAttemptResolutionTable).get()).toMatchObject({
          resolution_id: dualResolution.resolutionID,
          attempt_id: dual.providerAttemptID,
          decision: "abandoned",
        })
        expect(
          yield* db
            .select({ state: SessionProviderAttemptTable.state })
            .from(SessionProviderAttemptTable)
            .where(eq(SessionProviderAttemptTable.attempt_id, dual.providerAttemptID))
            .get(),
        ).toEqual({ state: "resolved_abandoned" })
        expect(
          yield* db
            .select({ state: SessionActivityTable.state })
            .from(SessionActivityTable)
            .where(eq(SessionActivityTable.activity_id, dual.activityID))
            .get(),
        ).toEqual({ state: "interrupted" })
        expect(
          yield* db
            .select({ state: SessionHistoryStateTable.state })
            .from(SessionHistoryStateTable)
            .where(eq(SessionHistoryStateTable.session_id, dual.session.id))
            .get(),
        ).toEqual({ state: "ready" })

        const exact = yield* seedRecovery("http exact retry")
        const listed = yield* requestInDirectory(pathFor(exact.session.id), instance.directory, { headers })
        expect(listed.status).toBe(200)
        const [descriptor] = yield* parseJson<Descriptor[]>(listed)
        expect(descriptor).toMatchObject({
          receiptID: exact.receiptID,
          providerState: "indeterminate_after_crash",
          workspaceRecoverySupported: true,
        })
        expect(descriptor?.worldStateBaselineHash).toStartWith("wsb1_")
        if (!descriptor) return
        const exactCommand = command(descriptor, "http-provider-recovery-exact")
        const first = yield* requestInDirectory(pathFor(exact.session.id), instance.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(exactCommand),
        })
        expect(first.status).toBe(200)
        const firstResolution = yield* parseJson<Record<string, unknown>>(first)
        const retry = yield* requestInDirectory(pathFor(exact.session.id), instance.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(exactCommand),
        })
        expect(retry.status).toBe(200)
        expect(yield* parseJson<Record<string, unknown>>(retry)).toEqual(firstResolution)

        const conflict = yield* requestInDirectory(pathFor(exact.session.id), instance.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...exactCommand, reason: "reuse the command ID with different authority" }),
        })
        expect(conflict.status).toBe(409)
        expect(yield* parseJson<Record<string, unknown>>(conflict)).toMatchObject({
          _tag: "ConflictError",
          resource: "command_id_conflict",
        })
        const cleared = yield* requestInDirectory(pathFor(exact.session.id), instance.directory, { headers })
        expect(cleared.status).toBe(200)
        expect(yield* parseJson<unknown[]>(cleared)).toEqual([])

        const stale = yield* seedRecovery("http stale cas")
        const staleList = yield* requestInDirectory(pathFor(stale.session.id), instance.directory, { headers })
        const [staleDescriptor] = yield* parseJson<Descriptor[]>(staleList)
        if (!staleDescriptor) return
        yield* db
          .update(SessionTable)
          .set({ mutation_epoch: staleDescriptor.sessionMutationEpoch + 1 })
          .where(eq(SessionTable.id, stale.session.id))
          .run()
          .pipe(Effect.orDie)
        const staleResponse = yield* requestInDirectory(pathFor(stale.session.id), instance.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(command(staleDescriptor, "http-provider-recovery-stale")),
        })
        expect(staleResponse.status).toBe(409)
        expect(yield* parseJson<Record<string, unknown>>(staleResponse)).toMatchObject({
          _tag: "ConflictError",
          resource: "stale_session_mutation",
        })

        const workspace = yield* seedRecovery("http workspace unsupported")
        const workspaceList = yield* requestInDirectory(pathFor(workspace.session.id), instance.directory, { headers })
        const [workspaceDescriptor] = yield* parseJson<Descriptor[]>(workspaceList)
        if (!workspaceDescriptor) return
        const workspaceID = WorkspaceV2.ID.make("wrk_00000000000000000000000000")
        Flag.DEEPAGENT_CODE_WORKSPACE_ID = workspaceID
        yield* db
          .update(SessionTable)
          .set({ workspace_id: workspaceID })
          .where(eq(SessionTable.id, workspace.session.id))
          .run()
          .pipe(Effect.orDie)
        const workspaceResponse = yield* requestInDirectory(pathFor(workspace.session.id), instance.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(command(workspaceDescriptor, "http-provider-recovery-workspace")),
        })
        expect(workspaceResponse.status).toBe(409)
        expect(yield* parseJson<Record<string, unknown>>(workspaceResponse)).toMatchObject({
          _tag: "ConflictError",
          resource: "workspace_recovery_not_supported",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )
})
