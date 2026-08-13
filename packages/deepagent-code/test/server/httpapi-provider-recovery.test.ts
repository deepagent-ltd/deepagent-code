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
} from "@deepagent-code/core/context-federation/session-sql"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionHistoryStateTable, SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { and, eq } from "drizzle-orm"
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
      .insert(SessionActivityTable)
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
      .insert(SessionContextSelectionTable)
      .values({
        selection_id: selectionID,
        session_id: session.id,
        activity_id: activityID,
        revision: 0,
        trigger_input_id: user.id,
        location_key: "local",
        query_fingerprint: "query",
        authorization_fingerprint: "authorization",
        authorization_epoch: 0,
        execution_fingerprint: "execution",
        selected_source_fingerprint: "sources",
        observed_location_mutation_epoch: 0,
        next_revalidation_at: now + 60_000,
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
      .insert(SessionProviderAttemptTable)
      .values({
        attempt_id: providerAttemptID,
        session_id: session.id,
        activity_id: activityID,
        provider_turn_seq: 0,
        selection_id: selectionID,
        projection_hash: "projection",
        request_hash: requestHash,
        provider_id: model.providerID,
        state: "indeterminate_after_crash",
        created_at: now,
        error_code: "process_recovery",
      })
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
    .insert(SessionToolRequestReceiptTable)
    .values({
      receipt_id: receiptID,
      request_ordinal: 1,
      session_id: session.id,
      user_message_id: user.id,
      assistant_message_id: assistant.id,
      provider_attempt_id: providerAttempt ? providerAttemptID : null,
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
      final_request_hash: requestHash,
      provider_state: "indeterminate_after_crash",
      adapter_prepared_at: now,
      dispatching_at: now,
      terminal_at: now,
      owner_token: "dead-process",
      request_state: "dispatched",
      request_error_code: "provider_started_outcome_unknown_after_process_restart",
      created_at: now,
    })
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
