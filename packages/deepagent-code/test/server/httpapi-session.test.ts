import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Cause, Config, Effect, Exit, Layer, Schedule, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Flag } from "@deepagent-code/core/flag/flag"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"

import { InstanceBootstrap } from "../../src/project/bootstrap"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import * as HttpSessionError from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import { MaintenancePaths } from "../../src/server/routes/instance/httpapi/groups/maintenance"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Database } from "@deepagent-code/core/database/database"
import { Hash } from "@deepagent-code/core/util/hash"
import { CapabilityLoadAdapter } from "@deepagent-code/core/system-context/capability-load-adapter"
import { EventTable } from "@deepagent-code/core/event/sql"
import {
  SessionHistoryStateTable,
  SessionInputTable,
  SessionIntentTable,
  SessionMessageTable,
  SessionTable,
  MessageTable,
  PartTable,
} from "@deepagent-code/core/session/sql"
import { SessionToolRequestReceiptTable } from "@/session/tool-request-receipt.sql"
import { SessionPromptEpochTable } from "@/session/prompt-epoch.sql"
import { CompactionRequestTable } from "@deepagent-code/core/session/compaction-request.sql"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { builtinToolNames } from "@deepagent-code/core/tool/builtins"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "@deepagent-code/core/session/runner/v2-tool-effect.sql"
import { DeepAgentEventOutboxTable } from "@deepagent-code/core/deepagent/event-outbox-sql"
import { DeepAgentEventConsumerDeliveryTable } from "@deepagent-code/core/deepagent/event-consumer-sql"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import * as DateTime from "effect/DateTime"
import * as Log from "@deepagent-code/core/util/log"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { seedIndeterminateProviderAuthority } from "../fixture/provider-recovery"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { testEffect } from "../lib/effect"
import { CapabilityPaths } from "../../src/server/routes/instance/httpapi/groups/capability"
import { ContextPaths } from "../../src/server/routes/instance/httpapi/groups/context"
import { SystemContextPaths } from "../../src/server/routes/instance/httpapi/groups/system-context"

void Log.init({ print: false })

const originalWorkspaces = Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES
const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    Database.defaultLayer,
    httpApiLayer,
  ),
)

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function createTextMessage(sessionID: SessionIDType, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    const info = yield* svc.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    const part = yield* svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text",
      text,
    })
    return { info, part }
  })
}

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, localAdapter(input.directory))
      return yield* Workspace.Service.use((svc) =>
        svc.create({
          type: input.type,
          branch: null,
          extra: null,
          projectID: input.projectID,
        }),
      )
    }),
    (info) => Workspace.use.remove(info.id).pipe(Effect.ignore),
  )

const insertLegacyAssistantMessage = (sessionID: SessionIDType, seq = 1, time = seq) =>
  Effect.gen(function* () {
    const message = new SessionMessage.Assistant({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
        variant: ModelV2.VariantID.make("default"),
      },
      time: { created: DateTime.makeUnsafe(time) },
      content: [],
    })
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: message.id,
          session_id: sessionID,
          type: message.type,
          seq,
          time_created: time,
          data: {
            time: { created: time },
            agent: message.agent,
            model: message.model,
            content: message.content,
          } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    return message
  })

const insertCorruptV2Message = (sessionID: SessionIDType, time = 1) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: SessionMessage.ID.create(),
          session_id: sessionID,
          type: "assistant",
          seq: time,
          time_created: time,
          data: {} as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
  })

const setLegacySummaryDiff = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({
        summary_additions: 1,
        summary_deletions: 0,
        summary_files: 1,
        summary_diffs: [{ additions: 1, deletions: 0 }],
      })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
  })

const getWorkspaceID = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ workspaceID: SessionTable.workspace_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
  })

const clearSessionPath = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  })

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

function readSessionEvent(response: HttpClientResponse.HttpClientResponse) {
  return response.stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.startsWith("data: ")),
    Stream.runHead,
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error("session event cursor replay timed out")),
    }),
    Effect.flatMap((line) =>
      line._tag === "None"
        ? Effect.die("session event stream ended before replay")
        : Effect.succeed(JSON.parse(line.value.slice(6)) as { seq: number; type: string }),
    ),
  )
}

// The dev V2-owner chain (mint keypair + verifier env) is armed process-wide by test/preload.ts:
// Reference defaults cache on first access, so arming must precede every test file. See
// test/lib/v2-owner.ts for why the keypair is a process-wide singleton.
afterEach(async () => {
  Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session HttpApi", () => {
  it.live("reads a V2 session by ID and returns a typed miss", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const headers = { "x-deepagent-code-directory": directory, "content-type": "application/json" }
      const created = yield* requestJson<{ data: { id: string; title: string } }>("/api/session", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      })
      const found = yield* requestJson<{ data: { id: string; title: string } }>(`/api/session/${created.data.id}`, {
        headers,
      })
      expect(found.data).toMatchObject(created.data)

      const missing = yield* request("/api/session/ses_missing_v2_get", { headers })
      expect(missing.status).toBe(404)
      expect(yield* responseJson(missing)).toMatchObject({ _tag: "SessionNotFoundError" })
    }),
  )

  it.live("blocks compatibility history mutations while a Core V2 drain is active", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const gate = Promise.withResolvers<void>()
      yield* llm.hold("held V2 response", gate.promise)
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const headers = { "x-deepagent-code-directory": directory, "content-type": "application/json" }
      const session = yield* createSession({
        title: "V2 mutation exclusion",
        model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
      }).pipe(provideInstanceEffect(directory))
      const seeded = yield* createTextMessage(session.id, "must survive the active drain")

      const admitted = yield* request(`/api/session/${session.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "msg_v2_mutation_exclusion", prompt: { text: "stay active" } }),
      })
      expect(admitted.status).toBe(200)
      yield* llm.wait(1)

      const revert = yield* request(pathFor(SessionPaths.revert, { sessionID: session.id }), {
        method: "POST",
        headers,
        body: JSON.stringify({ messageID: seeded.info.id }),
      })
      const deleted = yield* request(
        pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: seeded.info.id }),
        { method: "DELETE", headers },
      )
      const shell = yield* request(pathFor(SessionPaths.shell, { sessionID: session.id }), {
        method: "POST",
        headers,
        body: JSON.stringify({ agent: "build", command: "true" }),
      })

      expect(revert.status).toBe(409)
      expect(yield* responseJson(revert)).toMatchObject({ _tag: "SessionBusyError", sessionID: session.id })
      expect(deleted.status).toBe(409)
      expect(yield* responseJson(deleted)).toMatchObject({ _tag: "SessionBusyError", sessionID: session.id })
      expect(shell.status).toBe(409)
      expect(yield* responseJson(shell)).toMatchObject({ _tag: "SessionBusyError", sessionID: session.id })
      expect(
        yield* Session.Service.use((service) =>
          service.getMessage({
            sessionID: session.id,
            messageID: seeded.info.id,
          }),
        ),
      ).toBeDefined()

      gate.resolve()
      const waited = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
      expect(waited.status).toBe(204)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    15_000,
  )

  it.live("executes normal V2 prompts on the production Location runtime while resume false remains admit-only", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("production runtime reached", { usage: { input: 1, output: 1 } })
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const { db } = yield* Database.Service
      const headers = { "x-deepagent-code-directory": directory }
      const session = yield* createSession({
        title: "V2 HTTP production execution contract",
        model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
      }).pipe(provideInstanceEffect(directory))
      const inputsBefore = (yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).length
      const receiptsBefore = (yield* db.select().from(V2ProviderTurnReceiptTable).all().pipe(Effect.orDie)).length
      const toolsBefore = (yield* db.select().from(SessionToolRequestReceiptTable).all().pipe(Effect.orDie)).length

      const admitted = yield* request(`/api/session/${session.id}/prompt`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ id: "msg_v2_admit_only", prompt: { text: "admit only" }, resume: false }),
      })
      expect(admitted.status).toBe(200)
      expect((yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).length - inputsBefore).toBe(1)
      expect((yield* db.select().from(V2ProviderTurnReceiptTable).all().pipe(Effect.orDie)).length).toBe(receiptsBefore)
      expect((yield* db.select().from(SessionToolRequestReceiptTable).all().pipe(Effect.orDie)).length).toBe(
        toolsBefore,
      )

      const resumed = yield* request(`/api/session/${session.id}/prompt`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ id: "msg_v2_resume", prompt: { text: "execute normally" } }),
      })
      expect(resumed.status).toBe(200)
      // Readiness before settle: the wake is advisory, so /wait can resolve in the admit→wake→active
      // window before the drain dispatches. The mock server hit is the published signal that the
      // provider turn actually started.
      yield* llm.wait(1)
      const waited = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
      expect(waited.status).toBe(204)

      const inputsAfter = (yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).length
      expect(inputsAfter - inputsBefore).toBe(2)
      const receipt = yield* db
        .select({ state: V2ProviderTurnReceiptTable.state, provider: V2ProviderTurnReceiptTable.provider_id })
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, session.id))
        .get()
        .pipe(Effect.orDie)
      const executionEvents = yield* db
        .select({ type: EventTable.type, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, session.id))
        .all()
        .pipe(Effect.orDie)
      const deliveredOutbox = yield* db
        .select({
          eventType: DeepAgentEventOutboxTable.event_type,
          outboxState: DeepAgentEventOutboxTable.status,
          deliveryState: DeepAgentEventConsumerDeliveryTable.status,
        })
        .from(DeepAgentEventOutboxTable)
        .leftJoin(
          DeepAgentEventConsumerDeliveryTable,
          eq(DeepAgentEventConsumerDeliveryTable.outbox_id, DeepAgentEventOutboxTable.outbox_id),
        )
        .where(eq(DeepAgentEventOutboxTable.aggregate_id, session.id))
        .all()
        .pipe(
          Effect.orDie,
          Effect.flatMap((rows) =>
            rows.some(
              (row) =>
                row.eventType === "session.execution.succeeded" &&
                row.outboxState === "published" &&
                row.deliveryState === "resolved",
            )
              ? Effect.succeed(rows)
              : Effect.fail(new Error("V2 outbox delivery has not settled")),
          ),
          Effect.retry({ times: 30, schedule: Schedule.spaced("100 millis") }),
        )
      expect({ calls: yield* llm.calls, receipt }).toEqual({
        calls: 1,
        receipt: { state: "settled", provider: "test" },
      })
      expect(executionEvents.at(-1)?.type).toBe("session.execution.succeeded.1")
      expect(deliveredOutbox.some((row) => row.eventType === "session.execution.succeeded")).toBe(true)
      expect(deliveredOutbox.every((row) => row.outboxState === "published" && row.deliveryState === "resolved")).toBe(
        true,
      )
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    30_000,
  )

  it.live("advertises and executes Core context tools through the production HTTP runtime", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.tool("code_intel", { intent: "search", query: "SessionV2" })
      yield* llm.text("context tool completed", { usage: { input: 1, output: 1 } })
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const { db } = yield* Database.Service
      const headers = { "x-deepagent-code-directory": directory }
      const session = yield* createSession({
        title: "V2 HTTP production context tool contract",
        model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
      }).pipe(provideInstanceEffect(directory))

      const response = yield* request(`/api/session/${session.id}/prompt`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ id: "msg_v2_context_tool", prompt: { text: "inspect SessionV2" } }),
      })
      expect(response.status).toBe(200)
      // Same readiness discipline as the sibling execution test: wait for the provider hit before
      // the settle call so the tool-advertisement assertions cannot observe the pre-drain window.
      yield* llm.wait(1)
      const waited = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
      expect(waited.status).toBe(204)

      const inputs = yield* llm.inputs
      const advertised = ((inputs[0]?.tools ?? []) as Array<{ function?: { name?: string } }>).flatMap((tool) =>
        tool.function?.name ? [tool.function.name] : [],
      )
      const admissions = yield* db
        .select({ name: V2ToolEffectAdmissionTable.tool_name, kind: V2ToolEffectAdmissionTable.effect_kind })
        .from(V2ToolEffectAdmissionTable)
        .where(eq(V2ToolEffectAdmissionTable.session_id, session.id))
        .all()
        .pipe(Effect.orDie)
      const effects = yield* db
        .select({
          name: V2ToolEffectTable.tool_name,
          kind: V2ToolEffectTable.effect_kind,
          state: V2ToolEffectTable.state,
        })
        .from(V2ToolEffectTable)
        .where(eq(V2ToolEffectTable.session_id, session.id))
        .all()
        .pipe(Effect.orDie)

      expect(advertised).toContain("code_intel")
      expect(advertised).toContain("context_query")
      expect(yield* llm.calls).toBe(2)
      expect(admissions).toEqual([{ name: "code_intel", kind: "read_only" }])
      expect(effects).toEqual([{ name: "code_intel", kind: "read_only", state: "settled" }])
      expect(JSON.stringify(inputs[1])).toContain("schemaVersion")
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    30_000,
  )

  // RI-113 production request snapshot oracle: on the real production HTTP stack the EXACT
  // shipped builtin surface plus the default-on host-owned debug, profile, and query_log tools
  // must reach the provider request,
  // and the durable prepared turn must record the same set at all three lowering stages.
  it.live("records the exact production tool surface in the durable request snapshot", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("snapshot recorded", { usage: { input: 1, output: 1 } })
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const { db } = yield* Database.Service
      const headers = { "x-deepagent-code-directory": directory }
      const session = yield* createSession({
        title: "V2 production request snapshot",
        model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
      }).pipe(provideInstanceEffect(directory))

      const response = yield* request(`/api/session/${session.id}/prompt`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ id: "msg_v2_snapshot", prompt: { text: "record the tool surface" } }),
      })
      expect(response.status).toBe(200)
      yield* llm.wait(1)
      const waited = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
      expect(waited.status).toBe(204)

      // The Core set derives from the registry authority itself (pinned to the product
      // inventory by the RI-113 exact gate); the enabled host tools are registered through
      // ApplicationTools after the instance RuntimeFlags are read.
      // This proves the wiring — declaration →
      // Location registration → materialize → permission/model filter → provider request →
      // durable receipt — without duplicating the Core tool list literal.
      // Project.defaultLayer uses this same production flag layer for the instance registry.
      const flags = yield* RuntimeFlags.Service.pipe(Effect.provide(RuntimeFlags.defaultLayer))
      expect(flags.debugTool).toBe(true)
      expect(flags.profileTool).toBe(true)
      const expected = [...builtinToolNames, "debug", "profile", "query_log"].sort()
      const inputs = yield* llm.inputs
      const advertised = ((inputs[0]?.tools ?? []) as Array<{ function?: { name?: string } }>)
        .flatMap((tool) => (tool.function?.name ? [tool.function.name] : []))
        .sort()
      expect(advertised).toEqual(expected)

      const receipt = yield* db
        .select({ prepared: V2ProviderTurnReceiptTable.prepared_turn })
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, session.id))
        .get()
        .pipe(Effect.orDie)
      expect(receipt?.prepared?.tool_registry_ids?.slice().sort()).toEqual(expected)
      expect(receipt?.prepared?.tool_permission_filtered_ids?.slice().sort()).toEqual(expected)
      expect(receipt?.prepared?.tool_final_offered_ids?.slice().sort()).toEqual(expected)
      expect(receipt?.prepared?.tool_definition_hash).toHaveLength(64)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    30_000,
  )

  it.effect("maps busy sessions to public session busy errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const exit = yield* HttpSessionError.mapBusy(Effect.fail(new Session.BusyError({ sessionID }))).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionBusyError",
          sessionID,
          message: `Session is busy: ${sessionID}`,
        })
      }
    }),
  )

  it.instance(
    "returns declared not found errors for read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory }
        const missingSession = SessionID.descending()
        const missingSessionBody = {
          name: "NotFoundError",
          data: { message: `Session not found: ${missingSession}` },
        }

        const get = yield* request(pathFor(SessionPaths.get, { sessionID: missingSession }), { headers })
        expect(get.status).toBe(404)
        expect(yield* responseJson(get)).toEqual(missingSessionBody)

        const children = yield* request(pathFor(SessionPaths.children, { sessionID: missingSession }), { headers })
        expect(children.status).toBe(404)
        expect(yield* responseJson(children)).toEqual(missingSessionBody)

        const todo = yield* request(pathFor(SessionPaths.todo, { sessionID: missingSession }), { headers })
        expect(todo.status).toBe(404)
        expect(yield* responseJson(todo)).toEqual(missingSessionBody)

        const messages = yield* request(pathFor(SessionPaths.messages, { sessionID: missingSession }), { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(missingSessionBody)

        const continuationResolutions = yield* request(
          pathFor(SessionPaths.continuationResolution, { sessionID: missingSession }),
          { headers },
        )
        expect(continuationResolutions.status).toBe(404)
        expect(yield* responseJson(continuationResolutions)).toEqual(missingSessionBody)

        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: missingSession }), {
          headers,
          method: "DELETE",
        })
        expect(remove.status).toBe(404)
        expect(yield* responseJson(remove)).toEqual(missingSessionBody)

        const prompt = yield* request(pathFor(SessionPaths.prompt, { sessionID: missingSession }), {
          headers: { ...headers, "content-type": "application/json" },
          method: "POST",
          body: JSON.stringify({ agent: "build", noReply: true, parts: [{ type: "text", text: "hello" }] }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(missingSessionBody)

        const abort = yield* request(pathFor(SessionPaths.abort, { sessionID: missingSession }), {
          headers,
          method: "POST",
        })
        expect(abort.status).toBe(200)
        expect(yield* responseJson(abort)).toBe(true)

        const session = yield* createSession({ title: "missing message" })
        const missingMessage = MessageID.ascending()
        const message = yield* request(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID: missingMessage }),
          { headers },
        )
        expect(message.status).toBe(404)
        expect(yield* responseJson(message)).toEqual({
          name: "NotFoundError",
          data: { message: `Message not found: ${missingMessage}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "serves read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory }
        const parent = yield* createSession({ title: "parent" })
        const child = yield* createSession({ title: "child", parentID: parent.id })
        const message = yield* createTextMessage(parent.id, "hello")
        yield* createTextMessage(parent.id, "world")

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(parent.id)
        expect(Object.hasOwn(listed[0]!, "parentID")).toBe(false)

        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toEqual({})

        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ execution_claim_token: 1 })
          .where(eq(SessionTable.id, parent.id))
          .run()
          .pipe(Effect.orDie)
        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toMatchObject({
          [parent.id]: { type: "recovery_required", message: expect.any(String) },
        })
        yield* db
          .update(SessionTable)
          .set({ execution_claim_token: null })
          .where(eq(SessionTable.id, parent.id))
          .run()
          .pipe(Effect.orDie)

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: parent.id }), { headers }),
        ).toMatchObject({ id: parent.id, title: "parent" })

        expect(
          (yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parent.id }), {
            headers,
          })).map((item) => item.id),
        ).toEqual([child.id])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID: parent.id }), { headers }),
        ).toEqual([])
        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.continuationResolution, { sessionID: parent.id }), {
            headers,
          }),
        ).toEqual([])
        const invalidContinuationResolution = yield* request(
          pathFor(SessionPaths.continuationResolution, { sessionID: parent.id }),
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ decision: "replay" }),
          },
        )
        expect(invalidContinuationResolution.status).toBe(400)
        const missingContinuationResolution = yield* request(
          pathFor(SessionPaths.continuationResolution, { sessionID: parent.id }),
          {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              runID: "run-missing",
              failureID: "failure-missing",
              commandID: "command-missing",
              decision: "replay",
              reason: "missing continuation must be typed",
            }),
          },
        )
        // V2-only closure (RI-92/RI-71): the legacy continuation-resolution state machine is refused
        // outright under the Core V2-only profile — the durable maintenance recovery command surface is
        // the only authority — so a missing continuation can never be reached; the typed 503 is the
        // contract (read routes above still return 200/[] and schema-invalid payloads still 400).
        expect(missingContinuationResolution.status).toBe(503)
        expect(yield* responseJson(missingContinuationResolution)).toEqual({
          _tag: "ServiceUnavailableError",
          service: "session.continuation-resolution",
          message:
            `Core V2-only runtime cannot apply the legacy recovery state machine for ${parent.id}; ` +
            "use the exact durable maintenance recovery command surface",
        })

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        const messages = yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1`, {
          headers,
        })
        const messagePage = yield* json<SessionV1.WithParts[]>(messages)
        const nextCursor = messages.headers["x-next-cursor"]
        expect(nextCursor).toBeTruthy()
        expect(messagePage[0]?.parts[0]).toMatchObject({ type: "text" })

        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?before=${nextCursor}`, {
            headers,
          })).status,
        ).toBe(200)
        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1&before=invalid`, {
            headers,
          })).status,
        ).toBe(400)

        expect(
          yield* requestJson<SessionV1.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })

        yield* insertLegacyAssistantMessage(parent.id)

        expect(
          (yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${parent.id}/message`, {
            headers,
          })).data,
        ).toMatchObject([{ type: "assistant" }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )
  it.instance(
    "status and the maintenance listing surface the typed redrive-blocked reason",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory }
        const { db } = yield* Database.Service
        yield* seedIndeterminateProviderAuthority(db, {
          sessionId: "ses_redrive_blocked",
          attemptId: "att_redrive_blocked",
          activityId: "act_redrive_blocked",
          requestHash: "d".repeat(64),
        })

        // The killed Session surfaces recovery_required WITH the typed blocked reason.
        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toMatchObject({
          ses_redrive_blocked: {
            type: "recovery_required",
            blockedReason: "recovery_required",
            message: expect.any(String),
          },
        })
        // The maintenance listing carries the same fenced Session with its reason code.
        expect(
          yield* requestJson<{ blocked: { sessionID: string; blockedReason: string }[]; count: number }>(
            MaintenancePaths.recoveryRedriveBlocked,
            { headers },
          ),
        ).toEqual({
          blocked: [{ sessionID: "ses_redrive_blocked", blockedReason: "recovery_required" }],
          count: 1,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )


  it.live("uses the persisted session directory for prompt requests", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("ok", { usage: { input: 1, output: 1 } })

      const config = testProviderConfig(llm.url)
      const sessionDirectory = yield* tmpdirScoped({ git: true, config })
      const requestDirectory = yield* tmpdirScoped({ git: true, config })
      const session = yield* createSession({ title: "directory regression" }).pipe(
        provideInstanceEffect(sessionDirectory),
      )

      const response = yield* request(
        `${pathFor(SessionPaths.prompt, { sessionID: session.id })}?directory=${encodeURIComponent(requestDirectory)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "which directory?" }],
          }),
        },
      )

      expect(response.status).toBe(200)
      yield* responseJson(response)

      const messages = yield* Session.use
        .messages({ sessionID: session.id })
        .pipe(provideInstanceEffect(sessionDirectory), Effect.orDie)
      const assistant = messages.find((message) => message.info.role === "assistant")
      expect(assistant?.info.role === "assistant" ? assistant.info.path : undefined).toEqual({
        cwd: sessionDirectory,
        root: sessionDirectory,
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    15_000,
  )

  it.instance(
    "creates and immediately admits input to a Core V2 session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const id = "ses_http_v2_create"
        const headers = {
          "content-type": "application/json",
          "x-deepagent-code-directory": test.directory,
        }
        const created = yield* request("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ id, agent: "build" }),
        })
        expect(created.status).toBe(200)
        expect(yield* responseJson(created)).toMatchObject({
          data: { id, agent: "build", location: { directory: test.directory } },
        })

        const admitted = yield* request(`/api/session/${id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: "msg_http_v2_create", prompt: { text: "hello" }, resume: false }),
        })
        expect(admitted.status).toBe(200)
        expect(yield* responseJson(admitted)).toMatchObject({
          data: { id: "msg_http_v2_create", sessionID: id, prompt: { text: "hello" } },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live("reads capability diagnostics from durable rows in only the routed workspace", () =>
    Effect.gen(function* () {
      const left = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
      const right = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
      const create = (id: string, directory: string) =>
        request("/api/session", {
          method: "POST",
          headers: { "content-type": "application/json", "x-deepagent-code-directory": directory },
          body: JSON.stringify({ id, agent: "build" }),
        })
      const [leftCreate, rightCreate] = yield* Effect.all(
        [create("ses_capability_http_left", left), create("ses_capability_http_right", right)],
        { concurrency: "unbounded" },
      )
      expect(leftCreate.status).toBe(200)
      expect(rightCreate.status).toBe(200)

      const body = "Durable capability body"
      const bodyHash = `sha256:${Hash.sha256(body)}`
      yield* CapabilityLoadAdapter.sessionCapabilityLoad((yield* Database.Service).db, {
        request: {
          capabilityId: "deepagent.code-read",
          version: "1.0.0-beta.0",
          bodyHash,
          runtimeHash: "runtime-http",
          permissionHash: "permission-http",
          bodyRef: "capability://deepagent.code-read@1.0.0-beta.0",
          body,
          declaredDigest: bodyHash,
          catalogSnapshotId: "capability_catalog:http",
          requiredPermissions: ["read"],
          grantedPermissions: ["read"],
          requiredRuntimeFeatures: [],
        },
        identity: {
          sessionId: "ses_capability_http_left",
          activityId: "activity-http-left",
          turnId: "turn-http-left",
        },
        contextEpoch: "epoch-http-left",
      })
      expect(
        yield* CapabilityLoadAdapter.recordedCapabilityLoadsForDirectory((yield* Database.Service).db, left),
      ).toHaveLength(1)

      const responses = yield* Effect.all(
        [
          request(CapabilityPaths.loadReceipts, { headers: { "x-deepagent-code-directory": left } }),
          request(CapabilityPaths.loadReceipts, { headers: { "x-deepagent-code-directory": right } }),
          request(SystemContextPaths.snapshot, { headers: { "x-deepagent-code-directory": left } }),
          request(SystemContextPaths.snapshot, { headers: { "x-deepagent-code-directory": right } }),
        ],
        { concurrency: "unbounded" },
      )
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200])
      const [leftReceipts, rightReceipts, leftSnapshot, rightSnapshot] = yield* Effect.all(
        responses.map(json<unknown>),
        { concurrency: "unbounded" },
      )
      expect(leftReceipts).toMatchObject({
        count: 1,
        receipts: [expect.objectContaining({ capabilityId: "deepagent.code-read", bodyHash })],
      })
      expect(rightReceipts).toEqual({ count: 0, receipts: [] })
      expect(leftSnapshot).toMatchObject({
        loadedCapabilityCount: 1,
        loadedCapabilities: [expect.objectContaining({ capabilityId: "deepagent.code-read", bodyHash })],
      })
      expect(rightSnapshot).toMatchObject({ loadedCapabilityCount: 0, loadedCapabilities: [] })
    }),
  )

  it.live("routes every context diagnostic through the owning workspace", () =>
    Effect.gen(function* () {
      const left = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
      const right = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
      const sessionID = "ses_context_http_left"
      const created = yield* request("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-deepagent-code-directory": left },
        body: JSON.stringify({ id: sessionID, agent: "build" }),
      })
      expect(created.status).toBe(200)

      const query = new URLSearchParams({ session_id: sessionID })
      const headers = (directory: string) => ({ "x-deepagent-code-directory": directory })
      const responses = yield* Effect.all(
        [
          request(`${ContextPaths.readiness}?${query}`, { headers: headers(left) }),
          request(`${ContextPaths.eventsCursor}?${query}`, { headers: headers(left) }),
          request(`${ContextPaths.events}?${query}`, { headers: headers(left) }),
          request(`${ContextPaths.readiness}?${query}`, { headers: headers(right) }),
          request(`${ContextPaths.eventsCursor}?${query}`, { headers: headers(right) }),
          request(`${ContextPaths.events}?${query}`, { headers: headers(right) }),
        ],
        { concurrency: "unbounded" },
      )

      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 404, 404, 404])
    }),
  )

  it.instance(
    "returns v2 public request errors for cursor and workspace query failures",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory }
        const session = yield* createSession({ title: "v2 cursor" })
        const firstMessage = yield* insertLegacyAssistantMessage(session.id, 1, 2)
        const secondMessage = yield* insertLegacyAssistantMessage(session.id, 2, 1)

        const sessionPage = yield* request(
          `/api/session?${new URLSearchParams({
            limit: "1",
            order: "asc",
            directory: test.directory,
            search: "v2",
          })}`,
          { headers },
        )
        const sessionCursor = (yield* json<{ data: Session.Info[]; cursor: { next?: string } }>(sessionPage)).cursor
          .next
        expect(sessionCursor).toBeTruthy()
        expect(JSON.parse(Buffer.from(sessionCursor!, "base64url").toString("utf8"))).toMatchObject({
          order: "asc",
          directory: test.directory,
          search: "v2",
          anchor: { id: session.id, direction: "next" },
        })

        const sessionNextPage = yield* request(`/api/session?cursor=${sessionCursor}`, { headers })
        expect(sessionNextPage.status).toBe(200)

        const invalidSessionCursor = yield* request(`/api/session?cursor=invalid`, { headers })
        expect(invalidSessionCursor.status).toBe(400)
        expect(yield* responseJson(invalidSessionCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })

        const invalidWorkspace = yield* request(`/api/session?workspace=bad`, { headers })
        expect(invalidWorkspace.status).toBe(400)
        expect(yield* responseJson(invalidWorkspace)).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "Query",
        })

        const messagePage = yield* request(`/api/session/${session.id}/message?limit=1`, { headers })
        const messageBody = yield* json<{ data: SessionMessage.Message[]; cursor: { next?: string } }>(messagePage)
        const messageCursor = messageBody.cursor.next
        expect(messageCursor).toBeTruthy()
        expect(messageBody.data.map((message) => message.id)).toEqual([secondMessage.id])
        expect(JSON.parse(Buffer.from(messageCursor!, "base64url").toString("utf8"))).toEqual({
          id: secondMessage.id,
          order: "desc",
          direction: "next",
        })

        const nextMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${messageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(nextMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const legacyMessageCursor = Buffer.from(
          JSON.stringify({ id: secondMessage.id, time: 1, order: "desc", direction: "next" }),
        ).toString("base64url")
        const legacyMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${legacyMessageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(legacyMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const messageCursorWithOrder = yield* request(
          `/api/session/${session.id}/message?cursor=${messageCursor}&order=asc`,
          { headers },
        )
        expect(messageCursorWithOrder.status).toBe(400)
        expect(yield* responseJson(messageCursorWithOrder)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Cursor cannot be combined with order",
        })

        const invalidMessageCursor = yield* request(`/api/session/${session.id}/message?cursor=invalid`, { headers })
        expect(invalidMessageCursor.status).toBe(400)
        expect(yield* responseJson(invalidMessageCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns a populated public context for a retained session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory }
        const session = yield* createSession({ title: "context readback" })
        const message = yield* insertLegacyAssistantMessage(session.id)

        const response = yield* request(`/api/session/${session.id}/context`, { headers })
        expect(response.status).toBe(200)
        const body = yield* json<{ data: SessionMessage.Message[] }>(response)
        expect(body.data).toEqual([
          expect.objectContaining({ id: message.id, type: "assistant" }),
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "replays session events after the durable HTTP watermark",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory }
        const created = yield* requestJson<{ data: { id: string } }>("/api/session", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        const sessionID = created.data.id
        const watermark = yield* requestJson<{ cursor: number | null }>(`/api/session/${sessionID}/events/cursor`, {
          headers,
        })
        expect(watermark.cursor).toBeNumber()
        if (watermark.cursor === null) return yield* Effect.die("created session has no durable event cursor")

        const admitted = yield* request(`/api/session/${sessionID}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: "msg_v2_cursor_tail", prompt: { text: "cursor tail" }, resume: false }),
        })
        expect(admitted.status).toBe(200)
        const next = yield* requestJson<{ cursor: number | null }>(`/api/session/${sessionID}/events/cursor`, {
          headers,
        })
        expect(next.cursor).toBeGreaterThan(watermark.cursor)

        const replay = yield* request(`/api/session/${sessionID}/events?after=${watermark.cursor}`, { headers })
        expect(replay.status).toBe(200)
        expect(replay.headers["content-type"]).toContain("text/event-stream")
        expect(yield* readSessionEvent(replay)).toMatchObject({
          seq: next.cursor,
          type: "session.next.prompt.admitted",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    15_000,
  )

  it.instance(
    "recovers legacy messages from the v2 public messages endpoint",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory }
        const session = yield* createSession({ title: "legacy recovery" })
        const legacy = yield* createTextMessage(session.id, "recover me")

        const response = yield* request(`/api/session/${session.id}/message?limit=10`, { headers })
        expect(response.status).toBe(200)
        const body = yield* json<{ data: SessionMessage.Message[] }>(response)
        expect(body.data.map((message) => message.id)).toEqual([SessionMessage.ID.make(legacy.info.id)])
        expect(body.data[0]).toMatchObject({
          id: legacy.info.id,
          type: "user",
          text: "recover me",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public not found errors for missing sessions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory }
        const missing = SessionID.descending()
        const expected = {
          _tag: "SessionNotFoundError",
          sessionID: missing,
          message: `Session not found: ${missing}`,
        }

        const messages = yield* request(`/api/session/${missing}/message`, { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(expected)

        const context = yield* request(`/api/session/${missing}/context`, { headers })
        expect(context.status).toBe(404)
        expect(yield* responseJson(context)).toEqual(expected)

        const compact = yield* request(`/api/session/${missing}/compact`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ providerID: "test", modelID: "test-model" }),
        })
        expect(compact.status).toBe(404)
        expect(yield* responseJson(compact)).toEqual(expected)

        const wait = yield* request(`/api/session/${missing}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(404)
        expect(yield* responseJson(wait)).toEqual(expected)

        const prompt = yield* request(`/api/session/${missing}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text: "hello" } }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(expected)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "durably records one v2 prompt for exact message-ID retries",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory }
        const session = yield* createSession({ title: "v2 prompt recording" })

        const recordPrompt = () =>
          request(`/api/session/${session.id}/prompt`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "hello" }, resume: false }),
          })
        const first = yield* recordPrompt()
        const retried = yield* recordPrompt()
        type PromptBody = { id: string; prompt: { text: string }; delivery: string; promotedSeq?: number }
        const firstBody = yield* json<{ data: PromptBody }>(first)
        const retriedBody = yield* json<{ data: PromptBody }>(retried)
        expect(first.status).toBe(200)
        expect(retried.status).toBe(200)
        expect(retriedBody).toEqual(firstBody)
        expect(firstBody).toMatchObject({
          data: { id: "msg_http_prompt", prompt: { text: "hello" }, delivery: "steer" },
        })

        const messages = yield* requestJson<{ data: PromptBody[] }>(`/api/session/${session.id}/message`, {
          headers,
        })
        expect(messages.data).toHaveLength(0)
        const admitted = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_http_prompt")))
            .get()
            .pipe(Effect.orDie),
        )
        expect(admitted).toMatchObject({
          id: "msg_http_prompt",
          session_id: session.id,
          delivery: "steer",
          promoted_seq: null,
        })
        const conflict = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "goodbye" }, resume: false }),
        })
        expect(conflict.status).toBe(409)
        expect(yield* responseJson(conflict)).toEqual({
          _tag: "ConflictError",
          message: "Prompt message ID conflicts with an existing durable record: msg_http_prompt",
          resource: "msg_http_prompt",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "routes v2 public session operations to the Core services",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory }
        const session = yield* createSession({ title: "v2 unavailable" })

        // The summary model identity is a required contract field: omitting it is a typed 400
        // rejection at decode, never a defaulted identity.
        const compactMissingModel = yield* request(`/api/session/${session.id}/compact`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(compactMissingModel.status).toBe(400)

        // With an explicit model the call enters the native compaction chain — an empty session
        // history is the next typed guard, surfaced as a 503 carrying the concrete reason.
        const compact = yield* request(`/api/session/${session.id}/compact`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ providerID: "test", modelID: "test-model" }),
        })
        expect(compact.status).toBe(503)
        expect(yield* responseJson(compact)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "manual compaction requires a non-empty session history",
          service: "session.compact",
        })

        // W1: session.wait is now REAL (SessionExecution.awaitIdle) — an idle session resolves
        // immediately with NoContent instead of the pre-W1 typed-unavailable 503.
        const wait = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(204)

        // Admit-only (resume:false): this case pins the ROUTING contract — the Core V2 prompt
        // service must persist the durable session_input row with the steered delivery. Scheduling
        // a real drain here would be incidental (nothing below asserts its outcome), and with no
        // provider configured the drain exhausts its bounded rejection retries in the background
        // while the test tears the instance down, racing scope close into a spurious timeout.
        const prompt = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: "msg_execution_unavailable", prompt: { text: "hello" }, resume: false }),
        })
        expect(prompt.status).toBe(200)
        expect(yield* responseJson(prompt)).toMatchObject({
          data: {
            id: "msg_execution_unavailable",
            sessionID: session.id,
            prompt: { text: "hello" },
            delivery: "steer",
          },
        })
        const admitted = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_execution_unavailable")))
            .get()
            .pipe(Effect.orDie),
        )
        expect(admitted).toMatchObject({
          id: "msg_execution_unavailable",
          session_id: session.id,
          delivery: "steer",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    // Boots a real server instance over a git repo; runs 3-4s under load — the default
    // 5s timeout flakes under parallel suite load.
    30_000,
  )

  it.live("settles a manual compaction through the v2 public compact endpoint with an explicit model", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("reply one", { usage: { input: 1, output: 1 } })
      yield* llm.text("reply two", { usage: { input: 1, output: 1 } })
      yield* llm.text("Summary of the exchanges", { usage: { input: 1, output: 1 } })
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const headers = { "x-deepagent-code-directory": directory, "content-type": "application/json" }
      const session = yield* createSession({
        title: "v2 public compact",
        model: { providerID: ProviderV2.ID.make("test"), id: ModelV2.ID.make("test-model") },
      }).pipe(provideInstanceEffect(directory))

      // Sequential rounds with an idle wait between them: back-to-back prompts coalesce into a
      // single steered activity (one provider turn), which would leave the summary turn without a
      // queued mock response.
      const rounds = [
        ["msg_v2_compact_first", "first exchange about apples"],
        ["msg_v2_compact_second", "second exchange"],
      ] as const
      for (const [index, [id, text]] of rounds.entries()) {
        const admitted = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ id, prompt: { text } }),
        })
        expect(admitted.status).toBe(200)
        yield* llm.wait(index + 1)
        const waitedRound = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
        expect(waitedRound.status).toBe(204)
      }

      const compact = yield* request(`/api/session/${session.id}/compact`, {
        method: "POST",
        headers,
        body: JSON.stringify({ providerID: "test", modelID: "test-model" }),
      })
      expect(compact.status).toBe(204)

      // The summary provider turn is the third mock-LLM hit, and the durable request settled with
      // the explicit model identity recorded at admission.
      expect(yield* llm.calls).toBe(3)
      const settled = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(CompactionRequestTable)
          .where(eq(CompactionRequestTable.session_id, session.id))
          .get()
          .pipe(Effect.orDie),
      )
      expect(settled).toMatchObject({
        status: "settled",
        outcome: "compacted",
        provider_id: "test",
        model_id: "test-model",
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
    30_000,
  )

  it.instance(
    "rejects recovery-required prompt admission before durable input or Provider dispatch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "Recovery required HTTP preflight" })
        yield* createTextMessage(session.id, "bootstrap history authority")
        yield* MessageV2.promptHistoryProjectionEffect(session.id)
        const { db } = yield* Database.Service
        const reason = "provider outcome is unknown after process restart"
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const now = Date.now()
                yield* tx
                  .update(SessionPromptEpochTable)
                  .set({ authority_state: "recovery_required", recovery_reason: reason })
                  .where(eq(SessionPromptEpochTable.session_id, session.id))
                  .run()
                yield* tx
                  .insert(SessionHistoryStateTable)
                  .values({
                    session_id: session.id,
                    state: "recovery_required",
                    reason,
                    time_created: now,
                    time_updated: now,
                  })
                  .onConflictDoUpdate({
                    target: SessionHistoryStateTable.session_id,
                    set: { state: "recovery_required", reason, time_updated: now },
                  })
                  .run()
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        const headers = { "x-deepagent-code-directory": test.directory, "content-type": "application/json" }
        const body = JSON.stringify({
          messageID: MessageID.ascending(),
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "must not be admitted" }],
        })

        const prompt = yield* request(pathFor(SessionPaths.prompt, { sessionID: session.id }), {
          method: "POST",
          headers,
          body,
        })
        const promptAsync = yield* request(pathFor(SessionPaths.promptAsync, { sessionID: session.id }), {
          method: "POST",
          headers,
          body,
        })

        expect(prompt.status).toBe(409)
        expect(promptAsync.status).toBe(409)
        expect(yield* responseJson(prompt)).toEqual({
          _tag: "ConflictError",
          message: reason,
          resource: `session:${session.id}`,
        })
        expect(yield* responseJson(promptAsync)).toEqual({
          _tag: "ConflictError",
          message: reason,
          resource: `session:${session.id}`,
        })
        expect(
          yield* db
            .select()
            .from(SessionIntentTable)
            .where(eq(SessionIntentTable.session_id, session.id))
            .all()
            .pipe(Effect.orDie),
        ).toHaveLength(0)
        expect(
          yield* db
            .select()
            .from(SessionToolRequestReceiptTable)
            .where(eq(SessionToolRequestReceiptTable.session_id, session.id))
            .all()
            .pipe(Effect.orDie),
        ).toHaveLength(0)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns safe v2 unknown errors for corrupt projected messages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 corrupt message" })
        yield* insertCorruptV2Message(session.id)

        const messages = yield* request(`/api/session/${session.id}/message`, {
          headers: { "x-deepagent-code-directory": test.directory },
        })
        const messagesBody = yield* responseJson(messages)
        expect(messages.status).toBe(500)
        expect(messagesBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((messagesBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(messagesBody)).not.toContain("assistant")

        const context = yield* request(`/api/session/${session.id}/context`, {
          headers: { "x-deepagent-code-directory": test.directory },
        })
        const contextBody = yield* responseJson(context)
        expect(context.status).toBe(500)
        expect(contextBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((contextBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(contextBody)).not.toContain("assistant")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves sessions with migrated summary diffs missing file details",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "legacy diff" })
        yield* setLegacySummaryDiff(session.id)

        const response = yield* request(pathFor(SessionPaths.get, { sessionID: session.id }), {
          headers: { "x-deepagent-code-directory": test.directory },
        })

        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).summary?.diffs).toBeUndefined()
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves lifecycle mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory, "content-type": "application/json" }

        const createdEmpty = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
        })
        expect(createdEmpty.id).toBeTruthy()

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created" }),
        })
        expect(created.title).toBe("created")

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "updated", time: { archived: 1 } }),
        })
        expect(updated).toMatchObject({ id: created.id, title: "updated", time: { archived: 1 } })

        const forked = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ intentID: "http-fork-intent" }),
        })
        expect(forked.id).not.toBe(created.id)

        const forkRetry = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ intentID: "http-fork-intent" }),
        })
        expect(forkRetry.id).toBe(forked.id)

        const forkConflict = yield* request(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ intentID: "http-fork-intent", isolate: "worktree" }),
        })
        expect(forkConflict.status).toBe(409)
        expect(yield* responseJson(forkConflict)).toEqual({
          _tag: "ConflictError",
          message: "fork intent was reused with different input",
          resource: "fork_intent:http-fork-intent",
        })

        const forkedWithoutContentType = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers: { "x-deepagent-code-directory": test.directory },
            body: JSON.stringify({ intentID: "http-fork-without-content-type" }),
          },
        )
        expect(forkedWithoutContentType.id).not.toBe(created.id)

        const legacyForkWithoutIntent = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({}),
          },
        )
        expect(legacyForkWithoutIntent.id).not.toBe(created.id)

        const legacyForkWithoutBody = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers,
          },
        )
        expect(legacyForkWithoutBody.id).not.toBe(created.id)
        expect(legacyForkWithoutBody.id).not.toBe(legacyForkWithoutIntent.id)

        const invalidForkIntent = yield* request(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: JSON.stringify({ intentID: "" }),
        })
        expect(invalidForkIntent.status).toBe(400)

        const invalidFork = yield* request(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: "{",
        })
        expect(invalidFork.status).toBe(400)

        const forkedWhitespace = yield* request(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: "  \n",
        })
        expect(forkedWhitespace.status).toBe(200)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.abort, { sessionID: created.id }), {
            method: "POST",
            headers,
          }),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: created.id }), {
            method: "DELETE",
            headers,
          }),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "persists selected workspace id when creating a session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        Flag.DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES = true
        const project = yield* Project.use.fromDirectory(test.directory)
        const workspace = yield* createLocalWorkspace({
          projectID: project.project.id,
          type: "session-create-workspace",
          directory: path.join(test.directory, ".workspace-local"),
        })

        const created = yield* requestJson<Session.Info>(`${SessionPaths.create}?workspace=${workspace.id}`, {
          method: "POST",
          headers: { "x-deepagent-code-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ title: "workspace session" }),
        })
        const messages = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID: created.id })}?workspace=${workspace.id}`,
          {
            headers: { "x-deepagent-code-directory": test.directory },
          },
        )

        expect(created).toMatchObject({ id: created.id, workspaceID: workspace.id })
        expect(messages.status).toBe(200)
        expect(yield* getWorkspaceID(created.id)).toEqual({ workspaceID: workspace.id })
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "validates archived timestamp values",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "archived" })
        const body = JSON.stringify({ time: { archived: -1 } })

        const response = yield* request(pathFor(SessionPaths.update, { sessionID: session.id }), {
          method: "PATCH",
          headers,
          body,
        })
        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).time.archived).toBe(-1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "uses project-scoped path and directory precedence",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const currentDir = path.join(test.directory, "packages", "deepagent-code", "src")
        yield* Effect.promise(() => mkdir(currentDir, { recursive: true }))

        const store = yield* InstanceStore.Service
        const { pathSession, pathlessSession } = yield* store.provide(
          { directory: currentDir },
          Effect.gen(function* () {
            return {
              pathSession: yield* createSession(),
              pathlessSession: yield* createSession(),
            }
          }).pipe(Effect.provideService(TestInstance, { directory: currentDir }), Effect.provide(Session.defaultLayer)),
        )
        yield* clearSessionPath(pathlessSession.id)

        const query = new URLSearchParams({
          scope: "project",
          path: "packages/deepagent-code/src",
          directory: currentDir,
        })
        const headers = { "x-deepagent-code-directory": test.directory }
        const sessions = (yield* json<Session.Info[]>(
          yield* request(`${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)

        expect(sessions).toContain(pathSession.id)
        expect(sessions).not.toContain(pathlessSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves paginated message link headers",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory }
        const session = yield* createSession({ title: "messages" })
        yield* createTextMessage(session.id, "first")
        yield* createTextMessage(session.id, "second")
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`

        const response = yield* request(route, { headers })

        expect(response.headers["x-next-cursor"]).toBeTruthy()
        expect(response.headers["link"]).toContain("limit=1")
        expect(response.headers["access-control-expose-headers"]?.toLowerCase()).toContain("x-next-cursor")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps message mutation routes from writing legacy projections outside V2 authority",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const db = (yield* Database.Service).db
        const headers = { "x-deepagent-code-directory": test.directory, "content-type": "application/json" }
        for (const authority of [false, true]) {
          const session = yield* createSession({ title: authority ? "V2 message" : "historical message" })
          const message = yield* createTextMessage(session.id, "original")
          if (!authority) yield* db.update(SessionTable).set({ v2_authority: false }).where(eq(SessionTable.id, session.id)).run()
          const snapshot = () =>
            Effect.gen(function* () {
              return {
                session: yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get(),
                messages: yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, session.id)).all(),
                parts: yield* db.select().from(PartTable).where(eq(PartTable.session_id, session.id)).all(),
                v2Messages: yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, session.id)).all(),
                inputs: yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, session.id)).all(),
                events: yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all(),
              }
            })
          const before = yield* snapshot()
          const mutations = [
            {
              path: pathFor(SessionPaths.updatePart, { sessionID: session.id, messageID: message.info.id, partID: message.part.id }),
              method: "PATCH", service: "session.updatePart", body: JSON.stringify({ ...message.part, text: "changed" }),
            },
            {
              path: pathFor(SessionPaths.deletePart, { sessionID: session.id, messageID: message.info.id, partID: message.part.id }),
              method: "DELETE", service: "session.deletePart",
            },
            {
              path: pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: message.info.id }),
              method: "DELETE", service: "session.deleteMessage",
            },
          ] as const
          yield* Effect.forEach(
            mutations,
            (mutation) => Effect.gen(function* () {
              const response = yield* request(mutation.path, {
                method: mutation.method,
                headers,
                ...("body" in mutation ? { body: mutation.body } : {}),
              })
              expect(response.status).toBe(authority ? 503 : 409)
              expect(yield* responseJson(response)).toMatchObject(
                authority
                  ? { _tag: "ServiceUnavailableError", service: mutation.service }
                  : { _tag: "ConflictError", resource: "legacy_session_requires_adoption" },
              )
              expect(yield* snapshot()).toEqual(before)
            }),
            { concurrency: 1 },
          )
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects part updates whose path and body ids disagree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "part mismatch" })
        const message = yield* createTextMessage(session.id, "first")
        const response = yield* request(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: message.info.id,
            partID: message.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...message.part, id: PartID.ascending() }),
          },
        )

        expect(response.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves remaining non-LLM session mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-deepagent-code-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "remaining" })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.revert, { sessionID: session.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ messageID: MessageID.ascending() }),
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.unrevert, { sessionID: session.id }), {
            method: "POST",
            headers,
          }),
        ).toMatchObject({ id: session.id })

        const permissionID = String(PermissionV1.ID.ascending())
        const permission = yield* request(
          pathFor(SessionPaths.permissions, {
            sessionID: session.id,
            permissionID,
          }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ response: "once" }),
          },
        )
        expect(permission.status).toBe(404)
        expect(yield* responseJson(permission)).toEqual({
          _tag: "PermissionNotFoundError",
          requestID: permissionID,
          message: `Permission request not found: ${permissionID}`,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
