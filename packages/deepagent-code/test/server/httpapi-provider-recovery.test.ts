import { afterEach, describe, expect } from "bun:test"
import { Database } from "@deepagent-code/core/database/database"
import { Flag } from "@deepagent-code/core/flag/flag"
import { Hash } from "@deepagent-code/core/util/hash"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { SessionHistoryStateTable, SessionTable } from "@deepagent-code/core/session/sql"
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

const seedRecovery = Effect.fn("HttpProviderRecoveryTest.seedRecovery")(function* (title: string) {
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
      provider_attempt_id: null,
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

  return { session, receiptID }
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
