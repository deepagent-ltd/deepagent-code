/**
 * activity progress projection §7.1 — runtime & read-projection deterministic regressions (#1-#17, #5 lives in
 * prompt.test.ts). The computed `activityProgress` marker must always be derived on read from the
 * durable progress/activity authority (session_activity_progress ⋈ session_legacy_activity), never
 * persisted into message JSON, and crash/recovery paths must upgrade it monotonically without ever
 * fabricating receipts, messages, revisions or provider invocations.
 *
 * Harness mirrors bug-008-activity-leak.test.ts (same layer stack, TestLLMServer only). Crash
 * injection reuses src/session/activity-crash-test.ts via the DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_*
 * env vars; the P1/P2/P6 points were added there + instrumented minimally in prompt.ts.
 * No authority-table rows are ever inserted directly — everything is driven through the real state
 * machine (prompt.prompt / TestLLMServer / cancel / recovery callers).
 */
import { expect, test } from "bun:test"
import { Database as BunSQLite } from "bun:sqlite"
import { existsSync } from "node:fs"
import os from "node:os"
import { Effect, Fiber, Layer } from "effect"
import path from "path"
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import remoteCompactPersistenceMigration from "@deepagent-code/core/database/migration/20260820000000_remote_compact_persistence"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Search } from "@deepagent-code/core/filesystem/search"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { MessageTable } from "@deepagent-code/core/session/sql"
import { EventTable } from "@deepagent-code/core/event/sql"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import * as Log from "@deepagent-code/core/util/log"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Global } from "@deepagent-code/core/global"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@deepagent-code/llm/route"
import { and, asc, eq } from "drizzle-orm"
import { MessageID, SessionID } from "@/session/schema"
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
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionPromptIntent } from "../../src/session/prompt-intent"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionSteer } from "../../src/session/steer"
import { SessionStatus } from "../../src/session/status"
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
import { ContextFederationReadiness } from "../../src/context-federation/readiness"
import { PromptEpoch } from "@/session/prompt-epoch"
import { MessageV2 } from "@/session/message-v2"
import {
  SessionActivityProgressTable,
  SessionLegacyActivityAdmissionTable,
  SessionLegacyActivityRunTable,
  SessionLegacyActivityTable,
  SessionLegacyActivityTerminalTable,
} from "@/session/activity-sql"
import { SessionToolRequestReceiptTable } from "@/session/tool-request-receipt.sql"
import type { Point as ActivityCrashPoint } from "../../src/session/activity-crash-test"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { TestContextFacades } from "../fixture/context-facades"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer, reply } from "../lib/llm-server"

void Log.init({ print: false })

void ProviderV2
void ModelV2

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
    startAuth: () => Effect.die("unexpected MCP auth in activity-progress-projection runtime tests"),
    authenticate: () => Effect.die("unexpected MCP auth in activity-progress-projection runtime tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in activity-progress-projection runtime tests"),
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

const stubRuntimeBaseLayer = Layer.succeed(
  RuntimeBase.Service,
  RuntimeBase.Service.of({
    gate: () => Effect.void,
    withIsolation: (_input, body) => body(""),
    checkPrivileges: () => Effect.succeed([]),
  }),
)
const debugStubDie = <A>(): Effect.Effect<A, never, never> =>
  Effect.die("DebugService stub (not used in activity-progress-projection runtime tests)")
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

const testLLMLayer = (runtimeFlags: Layer.Layer<RuntimeFlags.Service>) =>
  LLM.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(ProviderSvc.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(
      Layer.mergeAll(
        AgentGateway.layer({ enabled: true, runsDir: Global.Path.agent.runs }),
        LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
      ),
    ),
    Layer.provide(runtimeFlags),
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

function makePrompt() {
  const runtimeFlags = RuntimeFlags.layer({
    experimentalEventSystem: true,
    coreV2ExecutionOwner: false,
  })
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    testLLMLayer(runtimeFlags),
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

const it = testEffect(Layer.mergeAll(TestLLMServer.layer, makePrompt()))

const cfg = {
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

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "deepagent-code.json"),
    JSON.stringify({ $schema: "https://deepagent-code.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

const allowAll = [{ permission: "*", pattern: "*", action: "allow" }] as const

// ---------------------------------------------------------------------------
// crash-env helpers (mirrors bug-008's acquireUseRelease env handling)
// ---------------------------------------------------------------------------
const CRASH_ENV = {
  point: "DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_POINT",
  root: "DEEPAGENT_CODE_TEST_ROOT",
  marker: "DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_MARKER",
} as const

function setCrashEnv(point: ActivityCrashPoint, dir: string, marker: string) {
  const prev = {
    point: process.env[CRASH_ENV.point],
    root: process.env[CRASH_ENV.root],
    marker: process.env[CRASH_ENV.marker],
  }
  process.env[CRASH_ENV.point] = point
  process.env[CRASH_ENV.root] = dir
  process.env[CRASH_ENV.marker] = marker
  return prev
}

function restoreCrashEnv(prev: ReturnType<typeof setCrashEnv>) {
  const apply = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  apply(CRASH_ENV.point, prev.point)
  apply(CRASH_ENV.root, prev.root)
  apply(CRASH_ENV.marker, prev.marker)
}

const crashScoped = <A, E, R>(
  input: { dir: string; point: ActivityCrashPoint; marker: string },
  body: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => setCrashEnv(input.point, input.dir, input.marker)),
    () => body,
    (prev) => Effect.sync(() => restoreCrashEnv(prev)),
  )

const waitMarker = (marker: string, what: string) =>
  pollWithTimeout(
    Effect.promise(async () => ((await Bun.file(marker).exists()) ? true : undefined)),
    what,
    "15 seconds",
  )

// ---------------------------------------------------------------------------
// read-side helpers
// ---------------------------------------------------------------------------
type MessageUpdatedPayload = {
  sessionID?: string
  info?: { id?: string; activityProgress?: SessionV1.ActivityProgress }
}

const messageUpdatedEvents = (db: Database.Interface["db"], sessionID: string) =>
  db
    .select()
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, "message.updated.1")))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)

const eventsForMessage = (rows: { data: Record<string, unknown> }[], messageID: string) =>
  rows.filter((row) => (row.data as MessageUpdatedPayload).info?.id === messageID)

const markerEventsForMessage = (rows: { data: Record<string, unknown> }[], messageID: string) =>
  eventsForMessage(rows, messageID).filter((row) => (row.data as MessageUpdatedPayload).info?.activityProgress)

const markerOf = (info: SessionV1.Info) => (info.role === "assistant" ? info.activityProgress : undefined)

const progressRows = (db: Database.Interface["db"], activityID: string) =>
  db
    .select()
    .from(SessionActivityProgressTable)
    .where(eq(SessionActivityProgressTable.activity_id, activityID))
    .orderBy(asc(SessionActivityProgressTable.revision))
    .all()
    .pipe(Effect.orDie)

const activityForSession = (db: Database.Interface["db"], sessionID: string) =>
  db
    .select()
    .from(SessionLegacyActivityTable)
    .where(eq(SessionLegacyActivityTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)

const dbProvide = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* effect.pipe(Effect.provideService(Database.Service, database))
  })

// ---------------------------------------------------------------------------
// §7.1 #1 — reasoning+tool without text: settlement only writes the progress
// authority; hydrate computes the marker; text_part_id stays NULL.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #1: reasoning+tool turn settles only the progress authority with NULL text_part_id",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database
      const session = yield* sessions.create({ title: "reasoning+tool settlement", permission: allowAll })

      yield* llm.push(
        reply()
          .reason("checking the workspace first")
          .tool("bash", { command: "echo activity-progress-projection", description: "emit marker", workdir: path.resolve(dir) }),
      )
      yield* llm.text("turn complete")
      yield* awaitWithTimeout(
        prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "reason then call a tool, no text before the tool" }],
        }),
        "timed out running the reasoning+tool turn",
        "20 seconds",
      )

      const msgs = yield* sessions.messages({ sessionID: session.id })
      const toolAssistant = msgs.find(
        (message) => message.info.role === "assistant" && message.parts.some((part) => part.type === "tool"),
      )
      expect(toolAssistant).toBeDefined()
      if (!toolAssistant) return
      // The reasoning+tool assistant message carries NO text part of its own.
      expect(toolAssistant.parts.some((part) => part.type === "text")).toBe(false)

      const activities = yield* activityForSession(db, session.id)
      expect(activities).toHaveLength(1)
      const activity = activities[0]!
      const rows = yield* progressRows(db, activity.activity_id)
      // Settlement only wrote the progress authority: rev 0 (reason+tool) has text_part_id NULL,
      // rev 1 (closing text) carries the text part.
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        assistant_message_id: toolAssistant.info.id,
        revision: 0,
        state: "progress",
        text_part_id: null,
      })
      expect(rows[1]).toMatchObject({ revision: 1, state: "final" })
      expect(rows[1]!.text_part_id).not.toBeNull()

      // The marker was never persisted into message JSON ...
      const stored = yield* db
        .select({ id: MessageTable.id, data: MessageTable.data })
        .from(MessageTable)
        .where(eq(MessageTable.session_id, session.id))
        .all()
        .pipe(Effect.orDie)
      for (const row of stored) expect(row.data).not.toHaveProperty("activityProgress")

      // ... yet hydrate returns the computed projection.
      const hydrated = yield* MessageV2.get({ sessionID: session.id, messageID: toolAssistant.info.id }).pipe(
        Effect.provideService(Database.Service, database),
      )
      expect(markerOf(hydrated.info)).toMatchObject({ activityID: activity.activity_id, revision: 0, state: "progress" })
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// §7.1 #2 — beginProgress committed, provider not dispatched yet: the owning
// message projects `provisional` immediately (no wait for the first
// text/reasoning part) and supersedes the activity's older progress revision.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #2: provisional projection appears before provider dispatch without waiting for parts",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database
      const session = yield* sessions.create({ title: "provisional before dispatch", permission: allowAll })
      const marker = path.join(dir, "activity_progress_projection-p2-dispatch.json")

      yield* llm.push(
        reply()
          .reason("step one")
          .tool("bash", { command: "sleep 1; echo step-one", description: "slow tool", workdir: path.resolve(dir) }),
      )
      yield* llm.text("second response must never be dispatched")
      const baselineCalls = yield* llm.calls
      const running = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "two provider requests in one activity" }],
        })
        .pipe(Effect.forkChild)

      // Arm P2 only AFTER revision 0 settled to "progress": the second request's beginProgress
      // happens strictly after the bash tool finishes, so the env flip cannot be missed and the
      // first request's dispatch already happened.
      yield* Effect.acquireUseRelease(
        pollWithTimeout(
          Effect.gen(function* () {
            const activities = yield* activityForSession(db, session.id)
            if (activities.length !== 1) return
            const rows = yield* progressRows(db, activities[0]!.activity_id)
            if (rows.length === 1 && rows[0]!.state === "progress") return true
          }),
          "timed out waiting for revision 0 to settle to progress",
        ).pipe(Effect.flatMap(() => Effect.sync(() => setCrashEnv("after_provisional_event_before_provider_dispatch", dir, marker)))),
        () =>
          Effect.gen(function* () {
            yield* waitMarker(marker, "timed out waiting for the second beginProgress crash point")
            // Exactly ONE provider invocation so far: the second request never dispatched.
            expect(yield* llm.calls).toBe(baselineCalls + 1)

            const msgs = yield* sessions.messages({ sessionID: session.id })
            const assistants = msgs.filter((message) => message.info.role === "assistant")
            expect(assistants).toHaveLength(2)
            const [first, second] = assistants as [typeof assistants[number], typeof assistants[number]]
            // The new owning message has no text/reasoning/tool part yet — the projection did NOT
            // wait for the first part.
            expect(second.parts.some((part) => ["text", "reasoning", "tool"].includes(part.type))).toBe(false)
            expect(markerOf(second.info)).toMatchObject({ revision: 1, state: "provisional" })
            // The older progress revision is superseded: it stays "progress" but is no longer the
            // activity's latest/effective revision.
            expect(markerOf(first.info)).toMatchObject({ revision: 0, state: "progress" })
            const activity = (yield* activityForSession(db, session.id))[0]!
            expect(markerOf(second.info)?.activityID).toBe(activity.activity_id)

            const rows = yield* progressRows(db, activity.activity_id)
            expect(rows).toMatchObject([
              { revision: 0, state: "progress" },
              { revision: 1, state: "provisional", text_part_id: null },
            ])

            yield* prompt.cancel(session.id)
            yield* awaitWithTimeout(Fiber.await(running), "timed out joining the crashed turn", "10 seconds")
          }),
        (prev) => Effect.sync(() => restoreCrashEnv(prev)),
      )
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// §7.1 #3 — P1 crash (after beginProgress commit, before provisional event):
// hydrate reads provisional, no marker event was published, 0 provider calls.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #3: crash between beginProgress commit and provisional event still hydrates provisional",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database
      const session = yield* sessions.create({ title: "P1 crash", permission: allowAll })
      const marker = path.join(dir, "activity_progress_projection-p1.json")
      yield* llm.text("must never be dispatched")
      const baselineCalls = yield* llm.calls

      yield* crashScoped({ dir, point: "after_begin_progress_commit_before_provisional_event", marker },
        Effect.gen(function* () {
          const running = yield* prompt
            .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "crash at P1" }] })
            .pipe(Effect.forkChild)
          yield* waitMarker(marker, "timed out waiting for the P1 crash point")

          // Progress authority committed: provisional row, NULL text_part_id.
          const activity = (yield* activityForSession(db, session.id))[0]!
          expect(yield* progressRows(db, activity.activity_id)).toMatchObject([
            { revision: 0, state: "provisional", text_part_id: null },
          ])

          // HTTP/hydrate reads the provisional projection straight from the authority.
          const msgs = yield* sessions.messages({ sessionID: session.id })
          const assistant = msgs.findLast((message) => message.info.role === "assistant")
          expect(assistant).toBeDefined()
          const hydrated = yield* MessageV2.get({ sessionID: session.id, messageID: assistant!.info.id }).pipe(
            Effect.provideService(Database.Service, database),
          )
          expect(markerOf(hydrated.info)).toMatchObject({ revision: 0, state: "provisional" })

          // The provisional message.updated event was NOT published yet.
          const events = yield* messageUpdatedEvents(db, session.id)
          expect(markerEventsForMessage(events, assistant!.info.id)).toHaveLength(0)

          // Provider invocation count is still zero.
          expect(yield* llm.calls).toBe(baselineCalls)

          yield* prompt.cancel(session.id)
          yield* awaitWithTimeout(Fiber.await(running), "timed out joining the P1-crashed turn", "10 seconds")
        }),
      )

      // Cancel terminalized the activity through the regular path; the provisional row was never
      // mutated by the crash or the cancel.
      expect((yield* activityForSession(db, session.id))[0]).toMatchObject({ state: "interrupted" })
      const activity = (yield* activityForSession(db, session.id))[0]!
      expect(yield* progressRows(db, activity.activity_id)).toMatchObject([{ revision: 0, state: "provisional" }])
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// §7.1 #4 — P2 crash (after provisional event, before dispatch): recovery
// monotonically upgrades the SAME revision to recovery_required, still 0 calls.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #4: recovery monotonically upgrades the provisional revision after a P2 crash",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database
      const session = yield* sessions.create({ title: "P2 crash", permission: allowAll })
      const marker = path.join(dir, "activity_progress_projection-p2.json")
      yield* llm.text("must never be dispatched")
      const baselineCalls = yield* llm.calls

      yield* crashScoped({ dir, point: "after_provisional_event_before_provider_dispatch", marker },
        Effect.gen(function* () {
          const running = yield* prompt
            .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "crash at P2" }] })
            .pipe(Effect.forkChild)
          yield* waitMarker(marker, "timed out waiting for the P2 crash point")

          const msgs = yield* sessions.messages({ sessionID: session.id })
          const assistant = msgs.findLast((message) => message.info.role === "assistant")!
          const activity = (yield* activityForSession(db, session.id))[0]!

          // The provisional marker event WAS published before the crash.
          const eventsBefore = yield* messageUpdatedEvents(db, session.id)
          const provisional = markerEventsForMessage(eventsBefore, assistant.info.id)
          expect(provisional).toHaveLength(1)
          expect((provisional[0]!.data as MessageUpdatedPayload).info?.activityProgress).toMatchObject({
            revision: 0,
            state: "provisional",
          })
          expect(yield* llm.calls).toBe(baselineCalls)

          // Simulated restart recovery (same authority order as the prompt layer: receipt
          // transitions happen inside recoverActiveActivities for pre-dispatch receipts).
          const recovered = yield* SessionPromptIntent.recoverActiveActivities("activity_progress_projection-recovery-owner", {
            includeCurrentOwner: true,
            sessionID: session.id,
            source: "same_process_recovery",
          }).pipe(Effect.provideService(Database.Service, database))
          expect(recovered).toHaveLength(1)
          expect(recovered[0]).toMatchObject({ activityID: activity.activity_id, assistantMessageID: assistant.info.id })

          // Same revision, monotonically upgraded provisional -> recovery_required.
          expect(yield* progressRows(db, activity.activity_id)).toMatchObject([
            { revision: 0, state: "recovery_required" },
          ])
          // The pre-dispatch receipt was terminalized without any provider involvement.
          const receipt = yield* db
            .select()
            .from(SessionToolRequestReceiptTable)
            .where(eq(SessionToolRequestReceiptTable.assistant_message_id, assistant.info.id))
            .get()
            .pipe(Effect.orDie)
          expect(receipt).toMatchObject({ provider_state: "failed", request_error_code: "pre_dispatch_owner_lost" })
          expect((yield* activityForSession(db, session.id))[0]).toMatchObject({
            state: "failed",
            terminal_reason: "pre_dispatch_owner_lost",
          })
          expect(
            yield* db
              .select()
              .from(SessionLegacyActivityTerminalTable)
              .where(eq(SessionLegacyActivityTerminalTable.activity_id, activity.activity_id))
              .all()
              .pipe(Effect.orDie),
          ).toMatchObject([{ state: "failed", progress_revision: 0, assistant_message_id: assistant.info.id }])
          expect(yield* llm.calls).toBe(baselineCalls)

          yield* prompt.cancel(session.id)
          // The parked fiber's terminal replay legitimately diverges from the recovery-committed
          // terminal (the real process was dead); the exit status is intentionally not asserted.
          yield* awaitWithTimeout(Fiber.await(running), "timed out joining the P2-crashed turn", "10 seconds")
        }),
      )
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// §7.1 #6 — provider-backed interrupted assistant with ZERO parts: the
// physical terminal authority projects over (replaces) the older progress.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #6: zero-part interrupted assistant projects the terminal state over old progress",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database
      const session = yield* sessions.create({ title: "zero-part terminal", permission: allowAll })
      const marker = path.join(dir, "activity_progress_projection-zero-part.json")

      yield* llm.push(
        reply()
          .reason("first request reasoning")
          .tool("bash", { command: "sleep 1; echo ok", description: "slow tool", workdir: path.resolve(dir) }),
      )
      yield* llm.text("never dispatched")
      const running = yield* prompt
        .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "abort mid activity" }] })
        .pipe(Effect.forkChild)

      yield* Effect.acquireUseRelease(
        pollWithTimeout(
          Effect.gen(function* () {
            const activities = yield* activityForSession(db, session.id)
            if (activities.length !== 1) return
            const rows = yield* progressRows(db, activities[0]!.activity_id)
            if (rows.length === 1 && rows[0]!.state === "progress") return true
          }),
          "timed out waiting for revision 0 to settle to progress",
        ).pipe(Effect.flatMap(() => Effect.sync(() => setCrashEnv("after_provisional_event_before_provider_dispatch", dir, marker)))),
        () =>
          Effect.gen(function* () {
            yield* waitMarker(marker, "timed out waiting for the second beginProgress crash point")
            // Abort the parked turn: the provider-backed second assistant message has zero parts.
            yield* prompt.cancel(session.id)
            yield* awaitWithTimeout(Fiber.await(running), "timed out joining the aborted turn", "10 seconds")
          }),
        (prev) => Effect.sync(() => restoreCrashEnv(prev)),
      )

      const activity = (yield* activityForSession(db, session.id))[0]!
      expect(activity).toMatchObject({ state: "interrupted", terminal_reason: "user_cancelled" })

      const msgs = yield* sessions.messages({ sessionID: session.id })
      const assistants = msgs.filter((message) => message.info.role === "assistant")
      expect(assistants).toHaveLength(2)
      const [older, terminal] = assistants as [typeof assistants[number], typeof assistants[number]]

      // The interrupted assistant is provider-backed (receipt bound) but produced zero parts.
      expect(terminal.parts.some((part) => ["text", "reasoning", "tool"].includes(part.type))).toBe(false)
      expect(
        yield* db
          .select({ receiptID: SessionToolRequestReceiptTable.receipt_id })
          .from(SessionToolRequestReceiptTable)
          .where(eq(SessionToolRequestReceiptTable.assistant_message_id, terminal.info.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)

      // Physical rows were NOT tampered with: rev 0 settled "progress", rev 1 stays provisional.
      expect(yield* progressRows(db, activity.activity_id)).toMatchObject([
        { revision: 0, state: "progress" },
        { revision: 1, state: "provisional" },
      ])
      // The terminal authority row was written revisionless: it references NO assistant message
      // and NO progress revision (the crash happened before the finalizer bound them), so nothing
      // was fabricated — the read projection derives the terminal state purely from the existing
      // progress rows + activity state.
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityTerminalTable)
          .where(eq(SessionLegacyActivityTerminalTable.activity_id, activity.activity_id))
          .all()
          .pipe(Effect.orDie),
      ).toMatchObject([
        { state: "interrupted", source: "cancel", assistant_message_id: null, progress_revision: null },
      ])

      // The zero-part owning message projects the effective terminal state, replacing the older
      // progress as the activity's effective marker; the older revision keeps its own state.
      expect(markerOf(terminal.info)).toMatchObject({
        revision: 1,
        state: "interrupted",
        terminalReason: "user_cancelled",
      })
      expect(markerOf(older.info)).toMatchObject({ revision: 0, state: "progress" })
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// shared helper: create a steer-placeholder activity through the legal
// steer.admit lifecycle while a turn is parked before materialization
// (same recipe as bug-008). Used by #9 and #17 C/D.
// ---------------------------------------------------------------------------
const makeSteerPlaceholder = Effect.fn("test.makeSteerPlaceholder")(function* (
  sessionID: SessionID,
  dir: string,
) {
  const prompt = yield* SessionPrompt.Service
  const steer = yield* SessionSteer.Service
  const marker = path.join(dir, `activity_progress_projection-placeholder-${Math.random().toString(36).slice(2)}.json`)
  return yield* crashScoped(
    { dir, point: "after_coordinator_reserve", marker },
    Effect.gen(function* () {
      const running = yield* prompt
        .prompt({ sessionID, agent: "build", parts: [{ type: "text", text: "turn dies before materialization" }] })
        .pipe(Effect.forkChild)
      yield* waitMarker(marker, "timed out waiting for the coordinator reserve crash point")
      yield* steer.admit({ sessionID, prompt: new Prompt({ text: "activity-progress-projection steer placeholder" }) })
      yield* prompt.cancel(sessionID)
      // Exit status intentionally not asserted: the parked turn dies inside the window.
      yield* awaitWithTimeout(Fiber.await(running), "timed out joining the parked placeholder turn", "10 seconds")
      const database = yield* Database.Service
      const placeholder = yield* database.db
        .select()
        .from(SessionLegacyActivityTable)
        .where(eq(SessionLegacyActivityTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!placeholder || placeholder.state !== "active")
        return yield* Effect.die("steer placeholder activity was not created")
      return placeholder.activity_id
    }),
  )
})

// ---------------------------------------------------------------------------
// §7.1 #7 — latest physical progress row stays "progress" but the Activity is
// recovery_required: reads derive the effective terminal state; recovery adds
// NO receipt, message or progress revision.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #7: recovery_required projects over the settled progress row without fabricating authority rows",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database
      const session = yield* sessions.create({ title: "recovery over settled progress", permission: allowAll })
      const marker = path.join(dir, "activity_progress_projection-p7.json")

      yield* llm.push(
        reply()
          .reason("settle once then park")
          .tool("bash", { command: "echo p7", description: "settle tool", workdir: path.resolve(dir) }),
      )
      // No second reply queued: after the crash point the loop cannot dispatch anything.
      const running = yield* crashScoped({ dir, point: "after_progress_settle_before_next_admission", marker },
        Effect.gen(function* () {
          const fiber = yield* prompt
            .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "settle then crash" }] })
            .pipe(Effect.forkChild)
          yield* waitMarker(marker, "timed out waiting for the post-settlement crash point")

          const activity = (yield* activityForSession(db, session.id))[0]!
          const assistant = (yield* sessions.messages({ sessionID: session.id }))
            .findLast((message) => message.info.role === "assistant")!
          // The settled progress row exists and the receipt is terminal ("settled").
          expect(yield* progressRows(db, activity.activity_id)).toMatchObject([{ revision: 0, state: "progress" }])
          const receiptsBefore = yield* db
            .select()
            .from(SessionToolRequestReceiptTable)
            .all()
            .pipe(Effect.orDie)
          const messagesBefore = yield* db
            .select({ id: MessageTable.id })
            .from(MessageTable)
            .where(eq(MessageTable.session_id, session.id))
            .all()
            .pipe(Effect.orDie)

          // Simulated restart recovery: the receipt already terminalized, so recovery only
          // terminalizes the ACTIVITY; the progress row is left untouched (no-op settle).
          const recovered = yield* SessionPromptIntent.recoverActiveActivities("activity_progress_projection-p7-owner", {
            includeCurrentOwner: true,
            sessionID: session.id,
            source: "same_process_recovery",
          }).pipe(Effect.provideService(Database.Service, database))
          expect(recovered).toHaveLength(1)
          expect(recovered[0]).toMatchObject({ activityID: activity.activity_id, assistantMessageID: assistant.info.id })

          // Authority bookkeeping: nothing new was fabricated.
          expect(yield* progressRows(db, activity.activity_id)).toMatchObject([{ revision: 0, state: "progress" }])
          expect((yield* db.select().from(SessionToolRequestReceiptTable).all().pipe(Effect.orDie)).length).toBe(
            receiptsBefore.length,
          )
          expect(
            (
              yield* db
                .select({ id: MessageTable.id })
                .from(MessageTable)
                .where(eq(MessageTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie)
            ).length,
          ).toBe(messagesBefore.length)

          expect((yield* activityForSession(db, session.id))[0]).toMatchObject({
            state: "recovery_required",
            terminal_reason: "host_terminal_decision_missing",
          })
          expect(
            yield* db
              .select()
              .from(SessionLegacyActivityTerminalTable)
              .where(eq(SessionLegacyActivityTerminalTable.activity_id, activity.activity_id))
              .all()
              .pipe(Effect.orDie),
          ).toMatchObject([{ state: "recovery_required", progress_revision: 0 }])

          // The canonical marker event is published exactly once by the dedicated publisher,
          // re-deriving the effective state from the untouched progress row.
          const before = markerEventsForMessage(yield* messageUpdatedEvents(db, session.id), assistant.info.id).length
          yield* sessions.publishMessageProjection({ sessionID: session.id, messageID: assistant.info.id })
          const projected = markerEventsForMessage(yield* messageUpdatedEvents(db, session.id), assistant.info.id)
          expect(projected.length).toBe(before + 1)
          expect((projected.at(-1)!.data as MessageUpdatedPayload).info?.activityProgress).toMatchObject({
            revision: 0,
            state: "recovery_required",
            terminalReason: "host_terminal_decision_missing",
          })
          // The read projection agrees with the event.
          expect(
            markerOf((yield* sessions.getMessage({ sessionID: session.id, messageID: assistant.info.id })).info),
          ).toMatchObject({ revision: 0, state: "recovery_required" })

          yield* prompt.cancel(session.id)
          // The parked fiber's terminal replay legitimately diverges from the recovery-committed
          // terminal (the real process was dead); the exit status is intentionally not asserted.
          yield* awaitWithTimeout(Fiber.await(fiber), "timed out joining the crashed turn", "10 seconds")
        }),
      )
      void running
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// §7.1 #8 — Abort after a settled progress, before the next admission: the
// terminal authority reuses the OLD row's revision and the Activity terminal
// state; the physical progress row is never tampered with.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #8: abort after settlement terminalizes with the old revision without touching the progress row",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database
      const session = yield* sessions.create({ title: "abort after settlement", permission: allowAll })
      const marker = path.join(dir, "activity_progress_projection-p8.json")

      yield* llm.push(
        reply()
          .reason("settle then wait for abort")
          .tool("bash", { command: "echo p8", description: "settle tool", workdir: path.resolve(dir) }),
      )
      yield* crashScoped({ dir, point: "after_progress_settle_before_next_admission", marker },
        Effect.gen(function* () {
          const running = yield* prompt
            .prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "settle then abort" }] })
            .pipe(Effect.forkChild)
          yield* waitMarker(marker, "timed out waiting for the post-settlement crash point")
          yield* prompt.cancel(session.id)
          yield* awaitWithTimeout(Fiber.await(running), "timed out joining the aborted turn", "10 seconds")
        }),
      )

      const activity = (yield* activityForSession(db, session.id))[0]!
      expect(activity).toMatchObject({ state: "interrupted", terminal_reason: "user_cancelled" })
      // The settled progress row is physically untouched (no rewrite, no extra revision).
      expect(yield* progressRows(db, activity.activity_id)).toMatchObject([{ revision: 0, state: "progress" }])
      // The terminal authority references the OLD revision.
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityTerminalTable)
          .where(eq(SessionLegacyActivityTerminalTable.activity_id, activity.activity_id))
          .all()
          .pipe(Effect.orDie),
      ).toMatchObject([{ state: "interrupted", progress_revision: 0 }])

      // Nothing was fabricated: exactly user + assistant messages and one receipt.
      const msgs = yield* sessions.messages({ sessionID: session.id })
      expect(msgs.filter((message) => message.info.role === "assistant")).toHaveLength(1)
      expect(
        yield* db
          .select()
          .from(SessionToolRequestReceiptTable)
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)

      // The read projection derives the terminal state from authority only.
      const assistant = msgs.findLast((message) => message.info.role === "assistant")!
      expect(markerOf(assistant.info)).toMatchObject({
        revision: 0,
        state: "interrupted",
        terminalReason: "user_cancelled",
      })
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// §7.1 #9 — Activity terminal BEFORE its first progress admission (steer
// placeholder): nothing is fabricated — no projection, message or revision.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #9: terminalizing a pre-admission activity fabricates no projection, message or revision",
  () =>
    Effect.gen(function* () {
      const { dir } = yield* useServerConfig(providerCfg)
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database
      const session = yield* sessions.create({ title: "terminal before first admission" })

      const placeholderID = yield* makeSteerPlaceholder(session.id, dir)
      const eventsBefore = (yield* messageUpdatedEvents(db, session.id)).length

      // Recovery deliberately skips the run_now/pending/no-run placeholder shape ...
      expect(
        yield* SessionPromptIntent.recoverActiveActivities("activity_progress_projection-p9-owner", {
          includeCurrentOwner: true,
          sessionID: session.id,
          source: "same_process_recovery",
        }).pipe(Effect.provideService(Database.Service, database)),
      ).toHaveLength(0)

      // ... so the dedicated retiral caller terminalizes it instead.
      const retired = yield* SessionPromptIntent.retireDisabledSteerActivity(session.id).pipe(
        Effect.provideService(Database.Service, database),
      )
      expect(retired).toMatchObject({ activityID: placeholderID, sessionID: session.id })
      // No latest progress exists: the DTO carries NO assistant message ID.
      expect(retired && "assistantMessageID" in retired).toBe(false)

      expect((yield* activityForSession(db, session.id))[0]).toMatchObject({
        state: "interrupted",
        terminal_reason: "steering_disabled_before_absorption",
      })
      // Nothing was fabricated anywhere.
      expect(
        yield* db
          .select()
          .from(SessionActivityProgressTable)
          .where(eq(SessionActivityProgressTable.activity_id, placeholderID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityTerminalTable)
          .where(eq(SessionLegacyActivityTerminalTable.activity_id, placeholderID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityRunTable)
          .where(eq(SessionLegacyActivityRunTable.session_id, session.id))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
      // Only the triggering steer admission exists — no fabricated extra admission.
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityAdmissionTable)
          .where(eq(SessionLegacyActivityAdmissionTable.activity_id, placeholderID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      expect(
        (yield* sessions.messages({ sessionID: session.id })).some((message) => message.info.role === "assistant"),
      ).toBe(false)
      expect((yield* messageUpdatedEvents(db, session.id)).length).toBe(eventsBefore)
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// §7.1 #10 — generic Session.updateMessage receiving an assistant object with
// a stale computed marker must strip it before publishing.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #10: updateMessage strips a stale computed activityProgress marker before publishing",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database
      const session = yield* sessions.create({ title: "stale marker strip", permission: allowAll })

      yield* llm.text("settled response")
      yield* awaitWithTimeout(
        prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "settle" }] }),
        "timed out running the settle turn",
        "20 seconds",
      )
      const assistant = (yield* sessions.messages({ sessionID: session.id })).findLast(
        (message) => message.info.role === "assistant",
      )!
      const hydrated = yield* MessageV2.get({ sessionID: session.id, messageID: assistant.info.id }).pipe(
        Effect.provideService(Database.Service, database),
      )
      expect(markerOf(hydrated.info)).toBeDefined()

      // A caller re-submits the assistant object carrying a fabricated/stale marker.
      const staleInfo = {
        ...hydrated.info,
        activityProgress: { activityID: "act_stale_fake", revision: 42, state: "final" } as SessionV1.ActivityProgress,
      }
      yield* sessions.updateMessage(staleInfo)

      const events = yield* messageUpdatedEvents(db, session.id)
      const own = eventsForMessage(events, assistant.info.id)
      expect(own.length).toBeGreaterThan(0)
      // The latest published projection carries NO stale computed marker ...
      expect((own.at(-1)!.data as MessageUpdatedPayload).info?.activityProgress).toBeUndefined()
      // ... while the earlier canonical marker event remains intact.
      const markerEvents = markerEventsForMessage(events, assistant.info.id)
      expect(markerEvents.length).toBeGreaterThan(0)
      expect((markerEvents.at(-1)!.data as MessageUpdatedPayload).info?.activityProgress).toMatchObject({
        revision: 0,
        state: "final",
      })
      // NOTE: updateMessage's commit callback persists the caller object verbatim (QUAL-007
      // upsert); the §7.1 #10 invariant is about the PUBLISHED projection, asserted above. The
      // read side never trusts stored markers — hydrate derives them from the authority.
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// §7.1 #11 — the core projector consuming the dedicated publisher's
// computed-marker events persists message JSON without the marker.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #11: projector persists message JSON without the computed marker emitted by the publisher",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database
      const session = yield* sessions.create({ title: "projector strip", permission: allowAll })

      yield* llm.text("marker-bearing projection")
      yield* awaitWithTimeout(
        prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "publish markers" }] }),
        "timed out running the turn",
        "20 seconds",
      )

      // The dedicated publisher DID emit computed-marker events ...
      const events = yield* messageUpdatedEvents(db, session.id)
      const withMarker = events.filter((row) => (row.data as MessageUpdatedPayload).info?.activityProgress)
      expect(withMarker.length).toBeGreaterThan(0)

      // ... yet every persisted message row stays marker-free.
      const stored = yield* db
        .select({ id: MessageTable.id, data: MessageTable.data })
        .from(MessageTable)
        .where(eq(MessageTable.session_id, session.id))
        .all()
        .pipe(Effect.orDie)
      expect(stored.length).toBeGreaterThan(0)
      for (const row of stored) expect(row.data).not.toHaveProperty("activityProgress")
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// §7.1 #12 — fork delivery publishing MessageUpdated directly: caller
// snapshots cannot forge markers; only helper re-derived canonical state
// propagates (here: nothing, since fork copies no activity authority).
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #12: fork delivery propagates only the stripped canonical projection, never caller markers",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database
      const session = yield* sessions.create({ title: "fork marker strip", permission: allowAll })

      yield* llm.text("settled before fork")
      yield* awaitWithTimeout(
        prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "settle before fork" }] }),
        "timed out running the settle turn",
        "20 seconds",
      )
      const sourceMarker = markerOf(
        (yield* sessions.messages({ sessionID: session.id })).findLast(
          (message) => message.info.role === "assistant",
        )!.info,
      )
      expect(sourceMarker).toBeDefined()

      const target = yield* sessions.fork({ sessionID: session.id, intentID: "fork-activity_progress_projection-marker-strip" })

      // Every message.updated event published for the target carries no marker ...
      const targetEvents = yield* messageUpdatedEvents(db, target.id)
      expect(targetEvents.length).toBeGreaterThan(0)
      for (const row of targetEvents)
        expect((row.data as MessageUpdatedPayload).info?.activityProgress).toBeUndefined()

      // ... and the target read paths agree: no fabricated marker survives the fork.
      const targetPage = yield* sessions.messagesPage({ sessionID: target.id, limit: 100 })
      expect(targetPage.items.length).toBeGreaterThan(0)
      for (const item of targetPage.items) expect(markerOf(item.info)).toBeUndefined()
      for (const item of yield* sessions.messages({ sessionID: target.id }))
        expect(markerOf(item.info)).toBeUndefined()

      // The source session still projects its canonical marker.
      expect(
        markerOf(
          (yield* sessions.messages({ sessionID: session.id })).findLast(
            (message) => message.info.role === "assistant",
          )!.info,
        ),
      ).toEqual(sourceMarker)
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// §7.1 #13 — a late plain message update cannot regress the App marker, and
// subsequent hydrates keep the canonical marker.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #13: late marker-less updates never regress the canonical computed marker",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const session = yield* sessions.create({ title: "late update", permission: allowAll })

      yield* llm.text("settled")
      yield* awaitWithTimeout(
        prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "settle" }] }),
        "timed out running the settle turn",
        "20 seconds",
      )
      const hydrated = yield* MessageV2.get({
        sessionID: session.id,
        messageID: (yield* sessions.messages({ sessionID: session.id })).findLast(
          (message) => message.info.role === "assistant",
        )!.info.id,
      }).pipe(Effect.provideService(Database.Service, database))
      const canonical = markerOf(hydrated.info)
      expect(canonical).toMatchObject({ state: "final" })
      if (hydrated.info.role !== "assistant") return yield* Effect.die("expected an assistant message")

      // A late update arrives WITHOUT any marker (old client snapshot).
      const { activityProgress: _, ...plain } = hydrated.info
      void _
      yield* sessions.updateMessage({ ...plain, time: { ...plain.time, updated: Date.now() } })

      // Single-message reads keep the canonical marker ...
      expect(
        markerOf((yield* sessions.getMessage({ sessionID: session.id, messageID: hydrated.info.id })).info),
      ).toEqual(canonical)
      expect(
        markerOf((yield* sessions.getClientMessage({ sessionID: session.id, messageID: hydrated.info.id })).info),
      ).toEqual(canonical)

      // ... as do page/full reads.
      const page = yield* sessions.messagesPage({ sessionID: session.id, limit: 100 })
      expect(markerOf(page.items.find((item) => item.info.id === hydrated.info.id)!.info)).toEqual(canonical)
      expect(
        markerOf(
          (yield* sessions.messages({ sessionID: session.id })).find((item) => item.info.id === hydrated.info.id)!
            .info,
        ),
      ).toEqual(canonical)
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// §7.1 #14 — page batch queries are N+1-free; empty pages, mixed user/assistant
// pages and cross-activity pages all come back correct.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #14: message pages are batch-hydrated (no N+1) and correct across empty/mixed/cross-activity pages",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database

      // Empty page on a fresh session.
      const emptySession = yield* sessions.create({ title: "empty page" })
      const emptyPage = yield* sessions.messagesPage({ sessionID: emptySession.id, limit: 10 })
      expect(emptyPage).toMatchObject({ items: [], more: false })
      expect(emptyPage.cursor).toBeUndefined()

      // Two sequential turns -> two distinct activities: cross-activity page.
      const session = yield* sessions.create({ title: "cross-activity pages", permission: allowAll })
      yield* llm.text("activity one answer")
      yield* awaitWithTimeout(
        prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "first turn" }] }),
        "timed out running turn one",
        "20 seconds",
      )
      yield* llm.text("activity two answer")
      yield* awaitWithTimeout(
        prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "second turn" }] }),
        "timed out running turn two",
        "20 seconds",
      )
      expect(yield* activityForSession(db, session.id)).toHaveLength(2)

      const full = yield* sessions.messages({ sessionID: session.id })
      expect(full).toHaveLength(4)
      // Mixed user/assistant page: every assistant carries its own activity's marker.
      const assistants = full.filter((message) => message.info.role === "assistant")
      expect(assistants).toHaveLength(2)
      const activityIDs = new Set(assistants.map((message) => markerOf(message.info)?.activityID))
      expect(activityIDs.size).toBe(2)
      for (const message of assistants) expect(markerOf(message.info)).toMatchObject({ state: "final" })

      // N+1 guard: a full page hydrate touches the progress authority through exactly one
      // batched query, regardless of how many assistant messages it contains.
      const dbAny = db as unknown as { session: { prepareQuery: (...args: never[]) => unknown } }
      const sessionAny = dbAny.session
      const original = sessionAny.prepareQuery
      let progressQueryCount = 0
      sessionAny.prepareQuery = function (this: unknown, query: { sql: string }, ...rest: never[]) {
        if (query.sql.includes("session_activity_progress")) progressQueryCount += 1
        return original.apply(this, [query, ...rest] as never[])
      } as typeof original
      try {
        const page = yield* sessions.messagesPage({ sessionID: session.id, limit: 100 })
        // sessions.messages walks pages newest-first, so the full list is already desc-ordered.
        expect(page.items.map((item) => item.info.id)).toEqual(full.map((message) => message.info.id))
        expect(page.more).toBe(false)
        for (const item of page.items)
          if (item.info.role === "assistant") expect(markerOf(item.info)).toBeDefined()
      } finally {
        sessionAny.prepareQuery = original
      }
      expect(progressQueryCount).toBeLessThanOrEqual(1)
      expect(progressQueryCount).toBeGreaterThanOrEqual(1)

      // Cursor walk with limit 2 reassembles the full history exactly.
      const walked: string[] = []
      let cursor: string | undefined
      do {
        const page = yield* sessions.messagesPage({ sessionID: session.id, limit: 2, before: cursor })
        walked.push(...page.items.map((item) => item.info.id))
        cursor = page.more ? page.cursor : undefined
      } while (cursor)
      // The backward walk reassembles the exact same message set (page order is newest-first).
      expect([...walked].sort()).toEqual([...full.map((message) => message.info.id)].sort())
    }),
  { git: true },
  90_000,
)

// ---------------------------------------------------------------------------
// §7.1 #15 — MessageV2.get and every single-message/page/full HTTP read return
// the exact same computed projection.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #15: get and all single-message read paths agree on the computed projection",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const session = yield* sessions.create({ title: "read-path agreement", permission: allowAll })

      yield* llm.push(
        reply()
          .reason("tool turn")
          .tool("bash", { command: "echo agreement", description: "tool", workdir: path.resolve(dir) }),
      )
      yield* llm.text("closing answer")
      yield* awaitWithTimeout(
        prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "agree" }] }),
        "timed out running the turn",
        "20 seconds",
      )

      const msgs = yield* sessions.messages({ sessionID: session.id })
      const toolAssistant = msgs.find(
        (message) => message.info.role === "assistant" && message.parts.some((part) => part.type === "tool"),
      )!
      const messageID = toolAssistant.info.id

      const viaGet = markerOf(
        (yield* MessageV2.get({ sessionID: session.id, messageID }).pipe(
          Effect.provideService(Database.Service, database),
        )).info,
      )
      expect(viaGet).toBeDefined()
      expect(markerOf((yield* sessions.getMessage({ sessionID: session.id, messageID })).info)).toEqual(viaGet)
      expect(markerOf((yield* sessions.getClientMessage({ sessionID: session.id, messageID })).info)).toEqual(viaGet)
      const page = yield* MessageV2.page({ sessionID: session.id, limit: 100 }).pipe(
        Effect.provideService(Database.Service, database),
      )
      expect(markerOf(page.items.find((item) => item.info.id === messageID)!.info)).toEqual(viaGet)
      const clientPage = yield* sessions.messagesPage({ sessionID: session.id, limit: 100 })
      expect(markerOf(clientPage.items.find((item) => item.info.id === messageID)!.info)).toEqual(viaGet)
      expect(markerOf(msgs.find((message) => message.info.id === messageID)!.info)).toEqual(viaGet)
    }),
  { git: true },
  60_000,
)

// ---------------------------------------------------------------------------
// §7.1 #16 — incident-fixture read-only projection (revision 8/9/10).
// The incident activity a6d06b2a… (session ses_0149b8…, revisions 0-10, terminal
// state=interrupted/AbortError) lives in a 1.4.6 production DB COPY. Resolve it via
// DEEPAGENT_CODE_INCIDENT_DB_PATH or the known snapshot path; SKIP when absent (the 4.8GB
// production snapshot is never committed). Opened READ-ONLY with NO migration applied, verifying the
// computed projection + integrity + ownership directly on the production schema.
// ---------------------------------------------------------------------------
const INCIDENT_ACTIVITY_ID = "a6d06b2a82ef234ab9dc71e3fd940292a21b34f4732f28aa19ba8416c4c5e5a9"
const incidentDbPath = () =>
  process.env.DEEPAGENT_CODE_INCIDENT_DB_PATH ??
  path.join(os.homedir(), ".deepagent", "code", "deepagent-code-production-snapshot-20260814-162627.db")

test("activity progress projection #16: incident DB copy opens read-only without migration and yields revision 8/9/10 projections", () => {
  const dbPath = incidentDbPath()
  if (!existsSync(dbPath)) return // no production DB copy here — skip rather than fabricate
  const db = new BunSQLite(dbPath, { readonly: true })
  try {
    // 1. Computed projection (latestRevision ⋈ activity state) derives effective states on the
    //    production schema WITHOUT any migration applied. rev 8/9 stay `progress`; the terminal
    //    rev 10 projects `interrupted` from the activity state.
    const rows = db
      .query(
        `SELECT p.revision,
                p.assistant_message_id,
                p.state AS progress_state,
                p.text_part_id AS text_part_id,
                a.state AS activity_state,
                CASE WHEN p.revision <> (SELECT max(revision) FROM session_activity_progress WHERE activity_id = p.activity_id)
                          OR a.state = 'active' THEN p.state
                     WHEN a.state = 'settled' THEN 'final'
                     ELSE a.state END AS effective_state
             FROM session_activity_progress p
             JOIN session_legacy_activity a ON a.activity_id = p.activity_id
            WHERE p.activity_id = ?
         ORDER BY p.revision`,
      )
      .all(INCIDENT_ACTIVITY_ID) as Array<{
      revision: number
      assistant_message_id: string
      progress_state: string
      text_part_id: string | null
      activity_state: string
      effective_state: string
    }>
    expect(rows.length).toBe(11)
    const byRevision = new Map(rows.map((row) => [row.revision, row]))
    expect(byRevision.get(8)?.effective_state).toBe("progress")
    expect(byRevision.get(9)?.effective_state).toBe("progress")
    expect(byRevision.get(10)?.effective_state).toBe("interrupted")
    expect(byRevision.get(10)?.activity_state).toBe("interrupted")
    // reasoning-only revisions keep text_part_id NULL (projection never fabricates a text part).
    expect(byRevision.get(8)?.text_part_id).toBeNull()
    expect(byRevision.get(9)?.text_part_id).toBeNull()
    // 2. Integrity check passes on the read-only copy (quick_check = the fast integrity scan).
    const integrity = db.query("PRAGMA quick_check").get() as Record<string, unknown>
    expect(Object.values(integrity ?? {})[0]).toBe("ok")
    // 3. Ownership consistency: every progress row's assistant message lives in the activity's session.
    const ownership = db
      .query(
        `SELECT count(*) AS n
           FROM session_activity_progress p
           JOIN message m ON m.id = p.assistant_message_id
           JOIN session_legacy_activity a ON a.activity_id = p.activity_id
          WHERE p.activity_id = ? AND m.session_id <> a.session_id`,
      )
      .get(INCIDENT_ACTIVITY_ID) as { n: number }
    expect(ownership.n).toBe(0)
  } finally {
    db.close()
  }
})

// ---------------------------------------------------------------------------
// §7.1 #17 — per-caller validation: settleProgress terminal / interruptActivity
// / recoverActiveActivities / retireDisabledSteerActivity return the message ID
// and publish exactly once when progress exists, and never publish without it.
// ---------------------------------------------------------------------------
it.instance(
  "activity progress projection #17: settlement/interrupt/recovery/retiral callers publish once with progress, never without",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const database = yield* Database.Service
      const { db } = database

      // (A) settleProgress terminal: a healthy turn settles and the terminal marker
      // is published exactly once for the owning message.
      const settledSession = yield* sessions.create({ title: "caller: settleProgress", permission: allowAll })
      yield* llm.text("settled once")
      yield* awaitWithTimeout(
        prompt.prompt({
          sessionID: settledSession.id,
          agent: "build",
          parts: [{ type: "text", text: "settle terminal" }],
        }),
        "timed out running the settle turn",
        "20 seconds",
      )
      const settledAssistant = (yield* sessions.messages({ sessionID: settledSession.id })).findLast(
        (message) => message.info.role === "assistant",
      )!
      const finals = markerEventsForMessage(
        yield* messageUpdatedEvents(db, settledSession.id),
        settledAssistant.info.id,
      ).filter(
        (row) => ((row.data as MessageUpdatedPayload).info?.activityProgress?.state ?? "") === "final",
      )
      expect(finals).toHaveLength(1)

      // (B) interruptActivity WITH latest progress: returns the owning message ID,
      // and the dedicated publisher emits exactly one more canonical marker.
      const interruptSession = yield* sessions.create({ title: "caller: interruptActivity", permission: allowAll })
      const interruptMarker = path.join(dir, "activity_progress_projection-p17-interrupt.json")
      yield* llm.push(
        reply()
          .reason("settle then park")
          .tool("bash", { command: "echo p17", description: "settle tool", workdir: path.resolve(dir) }),
      )
      const parked = yield* crashScoped(
        { dir, point: "after_progress_settle_before_next_admission", marker: interruptMarker },
        Effect.gen(function* () {
          const fiber = yield* prompt
            .prompt({
              sessionID: interruptSession.id,
              agent: "build",
              parts: [{ type: "text", text: "settle then interrupt" }],
            })
            .pipe(Effect.forkChild)
          yield* waitMarker(interruptMarker, "timed out waiting for the post-settlement crash point")

          const activityID = (yield* activityForSession(db, interruptSession.id))[0]!.activity_id
          const assistantID = MessageID.make((yield* progressRows(db, activityID))[0]!.assistant_message_id)
          const before = markerEventsForMessage(
            yield* messageUpdatedEvents(db, interruptSession.id),
            assistantID,
          ).length

          const invalidation = yield* SessionPromptIntent.interruptActivity(activityID).pipe(
            Effect.provideService(Database.Service, database),
          )
          expect(invalidation).toMatchObject({ activityID, assistantMessageID: assistantID })

          yield* sessions.publishMessageProjection({ sessionID: interruptSession.id, messageID: assistantID })
          const after = markerEventsForMessage(
            yield* messageUpdatedEvents(db, interruptSession.id),
            assistantID,
          )
          expect(after.length).toBe(before + 1)
          expect((after.at(-1)!.data as MessageUpdatedPayload).info?.activityProgress).toMatchObject({
            revision: 0,
            state: "interrupted",
            terminalReason: "aborted_before_provider_settlement",
          })

          // The physical settled row is untouched.
          expect(yield* progressRows(db, activityID)).toMatchObject([{ revision: 0, state: "progress" }])

          yield* prompt.cancel(interruptSession.id)
          // Exit status intentionally not asserted (terminal replay divergence, see #4/#7).
          yield* awaitWithTimeout(Fiber.await(fiber), "timed out joining the parked turn", "10 seconds")
        }),
      )
      void parked

      // (C) retireDisabledSteerActivity WITHOUT progress: no message ID, no publish.
      const retireSession = yield* sessions.create({ title: "caller: retireDisabledSteerActivity" })
      const placeholderID = yield* makeSteerPlaceholder(retireSession.id, dir)
      const retireBefore = (yield* messageUpdatedEvents(db, retireSession.id)).length
      const retired = yield* SessionPromptIntent.retireDisabledSteerActivity(retireSession.id).pipe(
        Effect.provideService(Database.Service, database),
      )
      expect(retired).toMatchObject({ activityID: placeholderID })
      expect(retired && "assistantMessageID" in retired).toBe(false)
      expect((yield* messageUpdatedEvents(db, retireSession.id)).length).toBe(retireBefore)

      // (D) interruptActivity WITHOUT progress: no message ID, no publish.
      const bareSession = yield* sessions.create({ title: "caller: interruptActivity (no progress)" })
      const barePlaceholderID = yield* makeSteerPlaceholder(bareSession.id, dir)
      const bareBefore = (yield* messageUpdatedEvents(db, bareSession.id)).length
      const bare = yield* SessionPromptIntent.interruptActivity(barePlaceholderID).pipe(
        Effect.provideService(Database.Service, database),
      )
      expect(bare).toMatchObject({ activityID: barePlaceholderID })
      expect(bare && "assistantMessageID" in bare).toBe(false)
      expect((yield* messageUpdatedEvents(db, bareSession.id)).length).toBe(bareBefore)

      // (E) recoverActiveActivities WITHOUT progress (placeholder shape): skipped by
      // design, returns [] and publishes nothing.
      expect(
        yield* SessionPromptIntent.recoverActiveActivities("activity_progress_projection-p17-owner", {
          includeCurrentOwner: true,
          sessionID: bareSession.id,
          source: "same_process_recovery",
        }).pipe(Effect.provideService(Database.Service, database)),
      ).toHaveLength(0)
      expect((yield* messageUpdatedEvents(db, bareSession.id)).length).toBe(bareBefore)
    }),
  { git: true },
  120_000,
)
