/**
 * BUG-008 third leak window — deterministic reproduction + regression test.
 *
 * Window: a turn enters `state.startRunning` (session busy) but dies BEFORE its
 * `materializeTurn` transaction commits. During that window a concurrent
 * `SessionSteer.admit` sees no active activity and creates a PLACEHOLDER legacy
 * activity (trigger = the steer admission, run_now/pending intent, no run row).
 * When the turn dies, nothing terminalizes that placeholder: the outer prompt
 * hook has no owned run yet, and `recoverActiveActivities` deliberately skips the
 * "run_now + pending + no run" shape. Every later admission then collides with
 * `SessionPromptIntent.Conflict: legacy activity <id> requires recovery before a
 * new turn` — exactly the live steer-boundary/activity-progress failure.
 *
 * The fix adopts the steer placeholder inside the next turn's materialization
 * transaction (route a of BUG-008), converging on the same durable state as the
 * healthy race ordering (turn materializes first, steer attaches as role "steer").
 *
 * Harness mirrors prompt.test.ts; no real LLM is ever called (TestLLMServer only).
 * No fixture rows are inserted directly — the leaked activity is produced through
 * the legal steer.admit lifecycle.
 */
import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import path from "path"
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { SessionV2 } from "@deepagent-code/core/session"
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
import { SessionIntentTable, SessionSteerTable } from "@deepagent-code/core/session/sql"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import * as Log from "@deepagent-code/core/util/log"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Global } from "@deepagent-code/core/global"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@deepagent-code/llm/route"
import { eq } from "drizzle-orm"
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
import {
  SessionLegacyActivityAdmissionTable,
  SessionLegacyActivityRunTable,
  SessionLegacyActivityTable,
  SessionLegacyActivityTerminalTable,
} from "@/session/activity-sql"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { TestContextFacades } from "../fixture/context-facades"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

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
    startAuth: () => Effect.die("unexpected MCP auth in bug-008 leak tests"),
    authenticate: () => Effect.die("unexpected MCP auth in bug-008 leak tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in bug-008 leak tests"),
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

// Mirrors prompt.test.ts: no-op RuntimeBase + inert DebugService stubs so the tool
// registry builds without the Worktree→Project→Database chain.
const stubRuntimeBaseLayer = Layer.succeed(
  RuntimeBase.Service,
  RuntimeBase.Service.of({
    gate: () => Effect.void,
    withIsolation: (_input, body) => body(""),
    checkPrivileges: () => Effect.succeed([]),
  }),
)
const debugStubDie = <A>(): Effect.Effect<A, never, never> =>
  Effect.die("DebugService stub (not used in bug-008 leak tests)")
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

it.instance(
  "BUG-008 third window: next turn adopts the steer-placeholder activity left by a turn that died before materialization",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const runState = yield* SessionRunState.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ title: "BUG-008 third window" })
      const marker = path.join(dir, "bug008-coordinator-reserve.json")
      const previousPoint = process.env.DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_POINT
      const previousRoot = process.env.DEEPAGENT_CODE_TEST_ROOT
      const previousMarker = process.env.DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_MARKER

      // Phase 1: the first turn dies INSIDE the third window — after the session
      // went busy, before its materializeTurn transaction committed. While it is
      // parked at the crash point, a concurrent steer.admit creates the
      // placeholder activity (no active activity exists yet).
      const placeholderID = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          process.env.DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_POINT = "after_coordinator_reserve"
          process.env.DEEPAGENT_CODE_TEST_ROOT = dir
          process.env.DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_MARKER = marker
        }),
        () =>
          Effect.gen(function* () {
            const running = yield* prompt
              .prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "First turn dies before materialization" }],
              })
              .pipe(Effect.forkChild)
            yield* pollWithTimeout(
              Effect.promise(async () => ((await Bun.file(marker).exists()) ? true : undefined)),
              "timed out waiting for the turn to reach the coordinator reserve crash point",
            )
            expect(yield* runState.isBusy(session.id)).toBe(true)
            // Turn is parked BEFORE admit: no activity row exists yet.
            expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)

            // Concurrent steer while the turn is busy: steer.admit sees no active
            // activity and creates the placeholder (trigger = steer admission).
            yield* steer.admit({
              sessionID: session.id,
              prompt: new Prompt({ text: "STEER PLACEHOLDER FOR BUG-008" }),
            })
            const placeholder = yield* db
              .select()
              .from(SessionLegacyActivityTable)
              .where(eq(SessionLegacyActivityTable.session_id, session.id))
              .get()
              .pipe(Effect.orDie)
            expect(placeholder).toMatchObject({ state: "active" })
            if (!placeholder) return yield* Effect.die("placeholder activity missing")

            // Simulate the in-window death (instance dispose): kill the parked
            // turn before it ever materializes. The outer prompt hook has no
            // owned run yet, so nothing terminalizes the placeholder.
            yield* awaitWithTimeout(prompt.cancel(session.id), "timed out cancelling the parked turn", "5 seconds")
            yield* awaitWithTimeout(Fiber.await(running), "timed out joining the canceled parked turn", "5 seconds")
            expect(yield* runState.isBusy(session.id)).toBe(false)

            // The leak: placeholder stays active with no run row; recovery skips
            // the run_now/pending/no-run shape, so it can never self-heal.
            expect(
              yield* db
                .select()
                .from(SessionLegacyActivityTable)
                .where(eq(SessionLegacyActivityTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie),
            ).toMatchObject([{ state: "active", terminal_reason: null }])
            expect(
              yield* db
                .select()
                .from(SessionLegacyActivityRunTable)
                .where(eq(SessionLegacyActivityRunTable.session_id, session.id))
                .all()
                .pipe(Effect.orDie),
            ).toHaveLength(0)
            return placeholder.activity_id
          }),
        () =>
          Effect.sync(() => {
            if (previousPoint === undefined) delete process.env.DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_POINT
            else process.env.DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_POINT = previousPoint
            if (previousRoot === undefined) delete process.env.DEEPAGENT_CODE_TEST_ROOT
            else process.env.DEEPAGENT_CODE_TEST_ROOT = previousRoot
            if (previousMarker === undefined) delete process.env.DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_MARKER
            else process.env.DEEPAGENT_CODE_TEST_ACTIVITY_CRASH_MARKER = previousMarker
          }),
      )

      // Phase 2: the next prompt must NOT collide with the leaked placeholder.
      // Pre-fix this fails with `SessionPromptIntent.Conflict: legacy activity
      // <id> requires recovery before a new turn`; post-fix the turn adopts the
      // placeholder and completes.
      yield* llm.text("placeholder adopted and completed")
      yield* llm.text("placeholder adopted and completed")
      const next = yield* awaitWithTimeout(
        prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "Second turn after the in-window death" }],
        }),
        "timed out running the prompt after the leaked placeholder",
        "15 seconds",
      )
      expect(next.parts.some((part) => part.type === "text" && part.text === "placeholder adopted and completed")).toBe(
        true,
      )

      // Adoption converges on EXACTLY the healthy race ordering's durable
      // state: ONE settled activity (the placeholder was undone, never
      // duplicated), turn membership ordinal 0 + re-attached steer ordinal 1.
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityTable)
          .where(eq(SessionLegacyActivityTable.session_id, session.id))
          .all()
          .pipe(Effect.orDie),
      ).toMatchObject([{ state: "settled" }])
      const adopted = yield* db
        .select()
        .from(SessionLegacyActivityTable)
        .where(eq(SessionLegacyActivityTable.session_id, session.id))
        .get()
        .pipe(Effect.orDie)
      expect(adopted).toBeTruthy()
      if (!adopted) return
      expect(adopted.activity_id).not.toBe(placeholderID)
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityAdmissionTable)
          .where(eq(SessionLegacyActivityAdmissionTable.activity_id, adopted.activity_id))
          .all()
          .pipe(Effect.orDie),
      ).toMatchObject([
        { ordinal: 0, role: "trigger" },
        { ordinal: 1, role: "steer" },
      ])
      expect(
        yield* db
          .select()
          .from(SessionLegacyActivityRunTable)
          .where(eq(SessionLegacyActivityRunTable.session_id, session.id))
          .all()
          .pipe(Effect.orDie),
      ).toMatchObject([{ activity_id: adopted.activity_id, state: "completed" }])
      // The orphaned steer was absorbed by the adopting turn, never lost.
      expect(
        yield* db
          .select()
          .from(SessionSteerTable)
          .where(eq(SessionSteerTable.session_id, session.id))
          .all()
          .pipe(Effect.orDie),
      ).toMatchObject([{ consumed_seq: expect.any(Number) }])
      expect(
        (yield* db
          .select({ state: SessionIntentTable.execution_state })
          .from(SessionIntentTable)
          .where(eq(SessionIntentTable.delivery, "steer"))
          .all()
          .pipe(Effect.orDie)).every((intent) => intent.state !== "pending"),
      ).toBe(true)
    }),
  { git: true },
  30_000,
)
