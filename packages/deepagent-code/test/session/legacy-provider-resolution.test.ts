import { expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { ModelV2 } from "@deepagent-code/core/model"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { NamedError } from "@deepagent-code/core/util/error"
import { Hash } from "@deepagent-code/core/util/hash"
import { ProviderV2 } from "@deepagent-code/core/provider"
import {
  SessionHistoryStateTable,
  SessionIntentTable,
  SessionPromptEpochMessageTable,
  SessionPromptEpochRecoveryTable,
  SessionTable,
  SessionToolRequestResolutionCommandTable,
  SessionToolRequestResolutionTable,
  SessionWorldStateBaselineTable,
} from "@deepagent-code/core/session/sql"
import { and, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ContextActivationReceipt } from "@/context-federation/activation-receipt"
import { EventSequenceTable, EventTable } from "@deepagent-code/core/event/sql"
import {
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionProviderAttemptRecoveryBridgeTable,
  SessionProviderAttemptResolutionTable,
  SessionProviderAttemptTable,
} from "@deepagent-code/core/context-federation/session-sql"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionInputTable } from "@deepagent-code/core/session/sql"
import { SessionLegacyProviderResolution } from "@/session/legacy-provider-resolution"
import { MessageV2 } from "@/session/message-v2"
import { SessionPromptEpochTable } from "@/session/prompt-epoch.sql"
import { recoverProviderReceiptsOnStartup } from "@/session/prompt"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionToolRequestReceiptTable } from "@/session/tool-request-receipt.sql"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const layer = Layer.mergeAll(
  Session.defaultLayer,
  Database.defaultLayer,
  EventV2Bridge.defaultLayer,
  SessionProjector.defaultLayer,
  SessionLegacyProviderResolution.defaultLayer,
  SessionProviderOwner.layer.pipe(Layer.provide(Database.defaultLayer)),
  LocationIdentity.defaultLayer,
)
const it = testEffect(layer)
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") }
let nextMessageTime = 1

const addUser = Effect.fn("LegacyProviderResolutionTest.addUser")(function* (
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
    model,
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

const addAssistant = Effect.fn("LegacyProviderResolutionTest.addAssistant")(function* (
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
    modelID: model.modelID,
    providerID: model.providerID,
    ...(completed ? { finish: "stop" as const } : {}),
  })
})

const seedIndeterminateProviderTurn = Effect.fn("LegacyProviderResolutionTest.seedIndeterminateProviderTurn")(
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
      .insert(SessionActivityTable) // fixture-exempt: seeds active activity for legacy-resolution fixture
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
      .insert(SessionProviderAttemptTable) // fixture-exempt: seeds prepared attempt with stale owner for crash fixture
      .values({
        attempt_id: input.providerAttemptID,
        session_id: input.session.id,
        activity_id: input.activityID,
        provider_turn_seq: 0,
        selection_id: input.selectionID,
        projection_hash: "projection",
        request_hash: input.requestHash,
        provider_id: model.providerID,
        owner_token: staleOwnerToken,
        state: "prepared",
        created_at: now,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionToolRequestReceiptTable) // fixture-exempt: seeds receipt mid-state for legacy-resolution fixture
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
        provider_id: model.providerID,
        model_id: model.modelID,
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

it.instance(
  "forks the safe prefix and resolves an ambiguous legacy provider turn exactly once",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const recovery = yield* SessionLegacyProviderResolution.Service
      yield* TestInstance
      const { db } = yield* Database.Service
      const parent = yield* sessions.create({ title: "recovery baseline parent" })
      const source = yield* sessions.fork({
        sessionID: parent.id,
        intentID: "recovery-baseline-source",
      })
      const safeUser = yield* addUser(source.id, "completed before provider crash")
      const safeAssistant = yield* addAssistant(source.id, safeUser.id, true)
      const failedUser = yield* addUser(source.id, "failed safely before provider crash")
      const failedAssistant = yield* addAssistant(source.id, failedUser.id)
      yield* sessions.updateMessage({
        ...failedAssistant,
        time: { ...failedAssistant.time, completed: Date.now() },
        error: new NamedError.Unknown({ message: "known terminal provider failure" }).toObject(),
      })
      const user = yield* addUser(source.id, "dispatch then crash")
      const assistant = yield* addAssistant(source.id, user.id)
      const unsafeTail = yield* addUser(source.id, "physical tail after ambiguous provider turn")
      const authority = yield* MessageV2.promptHistoryProjectionEffect(source.id)
      if (!authority.worldStateBaselineHash) return yield* Effect.die("expected frozen source World State baseline")
      const baselineHash = authority.worldStateBaselineHash
      const requestHash = Hash.sha256("final-request-hash")
      const receiptID = "receipt-ambiguous-provider-turn"
      const providerAttemptID = "attempt-ambiguous-provider-turn"
      const providerActivityID = "activity-ambiguous-provider-turn"
      const providerSelectionID = "selection-ambiguous-provider-turn"
      const seeded = yield* seedIndeterminateProviderTurn({
        session: source,
        userMessageID: user.id,
        assistantMessageID: assistant.id,
        receiptID,
        providerAttemptID,
        activityID: providerActivityID,
        selectionID: providerSelectionID,
        requestHash,
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

      const safeCutoff = yield* MessageV2.promptHistoryCutoffProjectionEffect({
        sessionID: source.id,
        cutoffMessageID: user.id,
      })
      expect(
        safeCutoff.messages.map((message) => [
          message.info.id,
          message.info.role,
          message.info.role === "assistant" ? message.info.parentID : undefined,
        ]),
      ).toEqual([
        [safeUser.id, "user", undefined],
        [safeAssistant.id, "assistant", safeUser.id],
        [failedUser.id, "user", undefined],
        [failedAssistant.id, "assistant", failedUser.id],
      ])

      const fork = yield* sessions.fork({
        sessionID: source.id,
        messageID: user.id,
        intentID: "fork-before-ambiguous-provider-turn",
      })
      expect((yield* sessions.messages({ sessionID: fork.id })).map((message) => message.info.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
      const ambiguousFork = yield* sessions
        .fork({
          sessionID: source.id,
          messageID: assistant.id,
          intentID: "fork-at-ambiguous-provider-turn",
        })
        .pipe(Effect.flip)
      expect(ambiguousFork).toMatchObject({
        _tag: "Session.ForkConflict",
        reason: expect.stringContaining("fork cutoff is outside the recoverable history prefix"),
      })
      const tailFork = yield* sessions
        .fork({
          sessionID: source.id,
          messageID: unsafeTail.id,
          intentID: "fork-after-ambiguous-provider-turn",
        })
        .pipe(Effect.flip)
      expect(tailFork).toMatchObject({
        _tag: "Session.ForkConflict",
        reason: expect.stringContaining("fork cutoff is outside the recoverable history prefix"),
      })

      const descriptors = yield* recovery.describe(source.id)
      expect(descriptors).toHaveLength(1)
      const [descriptor] = descriptors
      expect(descriptor).toMatchObject({
        receiptID,
        sessionID: source.id,
        providerState: "indeterminate_after_crash",
        promptEpoch: authority.epoch,
        requestHash,
        sessionMutationEpoch: 0,
        continuationRecoverySupported: true,
        workspaceRecoverySupported: true,
        sourceWorldStateBaselineStatus: "available",
        worldStateBaselineHash: baselineHash,
      })
      if (!descriptor) return
      if (!descriptor.resolutionSupported)
        return yield* Effect.die(
          `expected a resolvable provider recovery descriptor: ${descriptor.unsupportedReasons.join(",")}`,
        )
      if (!descriptor.worldStateBaselineHash)
        return yield* Effect.die("expected a resolvable provider recovery descriptor")
      const command = {
        sessionID: source.id,
        commandID: "resolve-ambiguous-provider-turn",
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
      const sourceBaseline = yield* db
        .select()
        .from(SessionWorldStateBaselineTable)
        .where(
          and(
            eq(SessionWorldStateBaselineTable.session_id, source.id),
            eq(SessionWorldStateBaselineTable.prompt_epoch, authority.epoch),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      expect(sourceBaseline.length).toBeGreaterThan(0)
      const assertRecoveryUnchanged = Effect.fnUntraced(function* () {
        expect(
          yield* db
            .select({ result: SessionToolRequestResolutionCommandTable.result_resolution_id })
            .from(SessionToolRequestResolutionCommandTable)
            .where(eq(SessionToolRequestResolutionCommandTable.session_id, source.id))
            .all()
            .pipe(Effect.orDie),
        ).not.toContainEqual(expect.objectContaining({ result: expect.any(String) }))
        expect(
          yield* db
            .select()
            .from(SessionToolRequestResolutionTable)
            .where(eq(SessionToolRequestResolutionTable.session_id, source.id))
            .all()
            .pipe(Effect.orDie),
        ).toEqual([])
        expect(
          yield* db
            .select({ epoch: SessionPromptEpochTable.epoch, state: SessionPromptEpochTable.state })
            .from(SessionPromptEpochTable)
            .where(eq(SessionPromptEpochTable.session_id, source.id))
            .orderBy(SessionPromptEpochTable.epoch)
            .all()
            .pipe(Effect.orDie),
        ).toEqual([{ epoch: authority.epoch, state: "active" }])
        expect(
          yield* db
            .select({ mutationEpoch: SessionTable.mutation_epoch })
            .from(SessionTable)
            .where(eq(SessionTable.id, source.id))
            .get()
            .pipe(Effect.orDie),
        ).toEqual({ mutationEpoch: 0 })
        expect(
          yield* db
            .select({ state: SessionHistoryStateTable.state })
            .from(SessionHistoryStateTable)
            .where(eq(SessionHistoryStateTable.session_id, source.id))
            .get()
            .pipe(Effect.orDie),
        ).toEqual({ state: "recovery_required" })
      })

      yield* db
        .delete(SessionWorldStateBaselineTable)
        .where(
          and(
            eq(SessionWorldStateBaselineTable.session_id, source.id),
            eq(SessionWorldStateBaselineTable.prompt_epoch, authority.epoch),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      const missingBaseline = yield* recovery
        .resolve({ ...command, commandID: "resolve-missing-world-state-baseline" })
        .pipe(Effect.flip)
      expect(missingBaseline).toMatchObject({ code: "source_world_state_baseline_missing" })
      yield* assertRecoveryUnchanged()
      yield* db.insert(SessionWorldStateBaselineTable).values(sourceBaseline).run().pipe(Effect.orDie)

      yield* db
        .delete(SessionWorldStateBaselineTable)
        .where(
          and(
            eq(SessionWorldStateBaselineTable.session_id, source.id),
            eq(SessionWorldStateBaselineTable.prompt_epoch, authority.epoch),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionWorldStateBaselineTable)
        .values(
          sourceBaseline.map((row, index) =>
            index === 0 ? { ...row, fragment: `${row.fragment}\ninvalid recovery baseline` } : row,
          ),
        )
        .run()
        .pipe(Effect.orDie)
      const invalidBaseline = yield* recovery
        .resolve({ ...command, commandID: "resolve-invalid-world-state-baseline" })
        .pipe(Effect.flip)
      expect(invalidBaseline).toMatchObject({ code: "source_world_state_baseline_invalid" })
      yield* assertRecoveryUnchanged()
      yield* db
        .delete(SessionWorldStateBaselineTable)
        .where(
          and(
            eq(SessionWorldStateBaselineTable.session_id, source.id),
            eq(SessionWorldStateBaselineTable.prompt_epoch, authority.epoch),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db.insert(SessionWorldStateBaselineTable).values(sourceBaseline).run().pipe(Effect.orDie)

      const sequenceBefore = yield* db
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, source.id))
        .get()
        .pipe(Effect.orDie)
      const first = yield* recovery.resolve(command)
      const retry = yield* recovery.resolve(command)
      expect(retry).toEqual(first)
      expect(
        yield* db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, source.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual(sequenceBefore)
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(
            and(
              eq(EventTable.aggregate_id, source.id),
              eq(EventTable.type, `${SessionLegacyProviderResolution.Event.Completed.type}.1`),
            ),
          )
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      const commandConflict = yield* recovery
        .resolve({ ...command, reason: "same command ID with different input" })
        .pipe(Effect.flip)
      expect(commandConflict).toBeInstanceOf(SessionLegacyProviderResolution.Conflict)
      if (!(commandConflict instanceof SessionLegacyProviderResolution.Conflict)) return
      expect(commandConflict.code).toBe("command_id_conflict")
      expect(first).toMatchObject({
        decision: "abandoned",
        sourcePromptEpoch: authority.epoch,
        successorPromptEpoch: authority.epoch + 1,
        sourceMutationEpoch: 0,
        successorMutationEpoch: 1,
      })
      expect(yield* recovery.describe(source.id)).toEqual([])

      const projection = yield* MessageV2.promptHistoryProjectionEffect(source.id)
      expect(projection.epoch).toBe(authority.epoch + 1)
      expect(projection.messages.map((message) => message.info.id)).toEqual([
        safeUser.id,
        safeAssistant.id,
        failedUser.id,
        failedAssistant.id,
      ])
      expect(projection.recoveryResolutionID).toBe(first.resolutionID)
      expect(
        yield* db
          .select({
            state: SessionPromptEpochTable.state,
            authorityState: SessionPromptEpochTable.authority_state,
            recoveryReason: SessionPromptEpochTable.recovery_reason,
          })
          .from(SessionPromptEpochTable)
          .where(
            and(eq(SessionPromptEpochTable.session_id, source.id), eq(SessionPromptEpochTable.epoch, authority.epoch)),
          )
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        state: "retired",
        authorityState: "recovery_required",
        recoveryReason: "provider outcome is unknown after restart",
      })
      expect(
        yield* db
          .select({ messageID: SessionPromptEpochMessageTable.message_id })
          .from(SessionPromptEpochMessageTable)
          .where(
            and(
              eq(SessionPromptEpochMessageTable.session_id, source.id),
              eq(SessionPromptEpochMessageTable.prompt_epoch, authority.epoch + 1),
            ),
          )
          .orderBy(SessionPromptEpochMessageTable.ordinal)
          .all()
          .pipe(Effect.orDie),
      ).toEqual([
        { messageID: safeUser.id },
        { messageID: safeAssistant.id },
        { messageID: failedUser.id },
        { messageID: failedAssistant.id },
      ])
      const successor = yield* db
        .select({ baselineHash: SessionPromptEpochTable.world_state_baseline_hash })
        .from(SessionPromptEpochTable)
        .where(
          and(
            eq(SessionPromptEpochTable.session_id, source.id),
            eq(SessionPromptEpochTable.epoch, authority.epoch + 1),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const baseline = yield* db
        .select({ provenance: SessionWorldStateBaselineTable.provenance })
        .from(SessionWorldStateBaselineTable)
        .where(
          and(
            eq(SessionWorldStateBaselineTable.session_id, source.id),
            eq(SessionWorldStateBaselineTable.prompt_epoch, authority.epoch + 1),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      expect(successor?.baselineHash).toStartWith("wsb1_")
      expect(baseline.length).toBeGreaterThan(0)
      expect(new Set(baseline.map((row) => row.provenance))).toEqual(new Set(["recovery_copied"]))
      expect(
        yield* db
          .select()
          .from(SessionPromptEpochRecoveryTable)
          .where(eq(SessionPromptEpochRecoveryTable.resolution_id, first.resolutionID))
          .get()
          .pipe(Effect.orDie),
      ).toBeDefined()
      expect(
        yield* db
          .select()
          .from(SessionProviderAttemptRecoveryBridgeTable)
          .where(eq(SessionProviderAttemptRecoveryBridgeTable.resolution_id, first.resolutionID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        resolution_id: first.resolutionID,
        attempt_id: providerAttemptID,
        receipt_id: receiptID,
        command_id: command.commandID,
      })
      expect(
        yield* db
          .select()
          .from(SessionProviderAttemptResolutionTable)
          .where(eq(SessionProviderAttemptResolutionTable.attempt_id, providerAttemptID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ resolution_id: first.resolutionID, decision: "abandoned" })
      expect(
        (yield* db
          .delete(SessionProviderAttemptResolutionTable)
          .where(eq(SessionProviderAttemptResolutionTable.attempt_id, providerAttemptID))
          .run()
          .pipe(Effect.orDie, Effect.exit))._tag,
      ).toBe("Failure")
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
      expect(
        yield* db
          .select()
          .from(SessionToolRequestResolutionTable)
          .where(eq(SessionToolRequestResolutionTable.resolution_id, first.resolutionID))
          .get()
          .pipe(Effect.orDie),
      ).toBeDefined()
      expect(
        yield* db
          .select({ mutationEpoch: SessionTable.mutation_epoch })
          .from(SessionTable)
          .where(eq(SessionTable.id, source.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ mutationEpoch: 1 })

      yield* recoverProviderReceiptsOnStartup({ ownerToken: seeded.recoveryOwnerToken })
      expect(
        yield* db
          .select({ state: SessionHistoryStateTable.state })
          .from(SessionHistoryStateTable)
          .where(eq(SessionHistoryStateTable.session_id, source.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "ready" })

      const continued = yield* addUser(source.id, "continue after explicit abandon")
      expect(
        (yield* MessageV2.promptHistoryProjectionEffect(source.id)).messages.map((message) => message.info.id),
      ).toEqual([safeUser.id, safeAssistant.id, failedUser.id, failedAssistant.id])
      const admittedAt = Date.now()
      yield* db
        .insert(SessionIntentTable)
        .values({
          intent_id: "continue-after-explicit-abandon",
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
        failedUser.id,
        failedAssistant.id,
        continued.id,
      ])
      yield* sessions.remove(source.id)
      yield* sessions.remove(parent.id)
      expect(
        yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, source.id))
          .get()
          .pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  { git: true },
  30_000,
)

it.instance(
  "keeps orphaned unknown outcomes visible and blocks every cutoff after their user boundary",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const recovery = yield* SessionLegacyProviderResolution.Service
      yield* TestInstance
      const { db } = yield* Database.Service
      const source = yield* sessions.create({ title: "orphaned provider outcome" })
      const before = yield* addUser(source.id, "before orphan")
      const beforeAssistant = yield* addAssistant(source.id, before.id, true)
      const orphanUser = yield* addUser(source.id, "dispatch before legacy migration")
      const orphanAssistant = yield* addAssistant(source.id, orphanUser.id)
      const tail = yield* addUser(source.id, "after orphan")
      const authority = yield* MessageV2.promptHistoryProjectionEffect(source.id)
      const now = Date.now()
      yield* seedIndeterminateProviderTurn({
        session: source,
        userMessageID: orphanUser.id,
        assistantMessageID: orphanAssistant.id,
        receiptID: "legacy-orphan-without-prompt-authority",
        providerAttemptID: "attempt-orphan-without-prompt-authority",
        activityID: "activity-orphan-without-prompt-authority",
        selectionID: "selection-orphan-without-prompt-authority",
        requestHash: Hash.sha256("legacy-orphan-without-prompt-authority"),
        prompt: {
          epoch: authority.epoch + 1_000,
          windowID: "missing-prompt-authority-window",
          historyHash: Hash.sha256("missing-prompt-authority-history"),
        },
      })
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

      const safe = yield* MessageV2.promptHistoryCutoffProjectionEffect({
        sessionID: source.id,
        cutoffMessageID: orphanUser.id,
      })
      expect(safe.messages.map((message) => message.info.id)).toEqual([before.id, beforeAssistant.id])
      const fork = yield* sessions.fork({
        sessionID: source.id,
        messageID: orphanUser.id,
        intentID: "fork-before-orphaned-provider-outcome",
      })
      expect((yield* sessions.messages({ sessionID: fork.id })).map((message) => message.info.role)).toEqual([
        "user",
        "assistant",
      ])
      for (const cutoffMessageID of [orphanAssistant.id, tail.id]) {
        expect(
          yield* sessions
            .fork({
              sessionID: source.id,
              messageID: cutoffMessageID,
              intentID: `fork-after-orphaned-provider-outcome-${cutoffMessageID}`,
            })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "Session.ForkConflict",
          reason: expect.stringContaining("fork cutoff is outside the recoverable history prefix"),
        })
      }

      expect(yield* recovery.describe(source.id)).toEqual([
        expect.objectContaining({
          receiptID: "legacy-orphan-without-prompt-authority",
          resolutionSupported: false,
          unsupportedReasons: expect.arrayContaining([
            "source_prompt_epoch_missing",
            "source_world_state_baseline_missing",
          ]),
        }),
      ])
      expect(
        yield* db
          .select()
          .from(SessionToolRequestResolutionCommandTable)
          .where(eq(SessionToolRequestResolutionCommandTable.session_id, source.id))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select()
          .from(SessionToolRequestResolutionTable)
          .where(eq(SessionToolRequestResolutionTable.session_id, source.id))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
    }),
  { git: true },
  30_000,
)
