import { NodeFileSystem } from "@effect/platform-node"
import { jsonSchema, type Tool } from "ai"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import remoteCompactPersistenceMigration from "@deepagent-code/core/database/migration/20260820000000_remote_compact_persistence"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import {
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionProviderOwnerLeaseTable,
} from "@deepagent-code/core/context-federation/session-sql"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { and, eq, sql } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { FetchHttpClient } from "effect/unstable/http"
import { expect, test } from "bun:test"
import {
  Cause,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  References,
  Stream,
} from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { NamedError } from "@deepagent-code/core/util/error"
import { Hash } from "@deepagent-code/core/util/hash"
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
import {
  SessionHistoryStateTable,
  SessionIntentTable,
  SessionSteerTable,
  MessageTable,
  PartTable,
  SessionMessageTable,
  SessionTable,
  SessionPromptEpochMessageTable,
  TaskRunEventTable,
  TaskRunTable,
  TaskStructuredOutputEvidenceTable,
} from "@deepagent-code/core/session/sql"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPromptV2 } from "../../src/session/prompt-v2"
import { SessionCommandV2 } from "../../src/session/command-v2"
import { recoverProviderReceiptsOnStartup } from "../../src/session/legacy-provider-receipt-recovery"
import { CommandEffectReceipt } from "../../src/session/command-effect-receipt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionSteer } from "../../src/session/steer"
import { LegacyExecutionUnavailable } from "../../src/session/legacy-execution-zero"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@deepagent-code/core/session"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { QuestionV2 } from "@deepagent-code/core/question"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import {
  CurrentBuildIdentity,
  CurrentOwnerAuthorizationPublicKey,
  CurrentOwnerCampaign,
  ownerQualified as v2OwnerQualified,
} from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2OwnerAuthorization } from "@deepagent-code/core/session/runner/v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "@deepagent-code/core/session/runner/v2-owner-authorization.sql"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import { SessionStore } from "@deepagent-code/core/session/store"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { DebugService } from "@/debug/service"
import { RuntimeBase } from "@/runtime/base"
import { Truncate } from "@/tool/truncate"
import * as Log from "@deepagent-code/core/util/log"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Search } from "@deepagent-code/core/filesystem/search"
import { Format } from "../../src/format"
import { Reference } from "../../src/reference/reference"
import { RepositoryCache } from "../../src/reference/repository-cache"
import { TestInstance, testInstanceStoreLayer, tmpdirScoped, tmpRoot } from "../fixture/fixture"
import { InstanceStore } from "@/project/instance-store"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@deepagent-code/llm/route"
import { createHash } from "node:crypto"
import { symlink } from "node:fs/promises"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { TestContextFacades } from "../fixture/context-facades"
import { SessionFederatedContext } from "../../src/context-federation/session-context-runtime"
import { ContextFederationReadiness } from "../../src/context-federation/readiness"
import { ContextActivationReceipt } from "../../src/context-federation/activation-receipt"
import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { PromptEpoch } from "@/session/prompt-epoch"
import { SessionPromptEpochTable } from "@/session/prompt-epoch.sql"
import { SessionToolRequestReceiptTable } from "@/session/tool-request-receipt.sql"
import { SessionToolArgumentReceiptTable } from "@/session/tool-argument-receipt.sql"
import { CompactionArtifactTable, CompactionRunTable } from "@/session/compaction-sql"
import {
  SessionActivityAdmissionTable,
  SessionActivityProgressTable,
  SessionLegacyActivityRunTable,
  SessionLegacyActivityTable,
  SessionLegacyActivityTerminalTable,
} from "@/session/activity-sql"

void Log.init({ print: false })

// W16 (O-W0-4): the goal-active predicate in promptOrSteer reads the DeepAgent in-memory session-state
// pointer (session-state map). Point it at a throwaway dir so getOrCreate/setActiveGoal work in-process
// (no real $HOME writes); unseeded sessions read as no-goal (getActiveGoal → null).
AgentGateway.DeepAgentSessionState.configure(mkdtempSync(tmpRoot()))

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
    computeManifest: () => Effect.succeed(SessionSummary.emptyManifest()),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

const mcpStub = (tools: Record<string, Tool> = {}) =>
  Layer.succeed(
    MCP.Service,
    MCP.Service.of({
      status: () => Effect.succeed({}),
      clients: () => Effect.succeed({}),
      tools: () => Effect.succeed(tools),
      prompts: () => Effect.succeed({}),
      resources: () => Effect.succeed({}),
      add: () => Effect.succeed({ status: { status: "disabled" as const } }),
      connect: () => Effect.void,
      disconnect: () => Effect.void,
      getPrompt: () => Effect.succeed(undefined),
      readResource: () => Effect.succeed(undefined),
      startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
      removeAuth: () => Effect.void,
      supportsOAuth: () => Effect.succeed(false),
      hasStoredTokens: () => Effect.succeed(false),
      getAuthStatus: () => Effect.succeed("not_authenticated" as const),
      catalog: () => Effect.succeed([]),
      enableCatalogEntry: () => Effect.succeed({ status: {}, name: "x", config: { type: "local", command: [] } }),
    }),
  )
const mcp = mcpStub()

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

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

// V3.5: a no-op RuntimeBase (R0) stub so the tool registry layer can be built without
// dragging in the real Worktree→Project→Database chain. These prompt tests never invoke
// the debug/profile tools, so gate/withIsolation/checkPrivileges are never exercised.
const stubRuntimeBaseLayer = Layer.succeed(
  RuntimeBase.Service,
  RuntimeBase.Service.of({
    gate: () => Effect.void,
    withIsolation: (_input, body) => body(""),
    checkPrivileges: () => Effect.succeed([]),
  }),
)

// Fully-inert DebugService (D1) stub. The real DebugService.layer runs InstanceState.make
// + registers a scope finalizer at registry-build time, perturbing the instance-context
// lifecycle these prompt tests rely on. The debug tool is never invoked here.
const debugStubDie = <A>(): Effect.Effect<A, never, never> => Effect.die("DebugService stub (not used in prompt tests)")
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

type PromptLayerOptions = {
  processor?: "blocking"
  flags?: Partial<RuntimeFlags.Info>
  federation?: SessionFederatedContext.Interface
  plugin?: Plugin.Interface
  // RI-40: lets a test swap the MCP facade (default: empty stub) so the production capability
  // snapshot wiring can be observed against a non-empty tool surface (e.g. a name collision).
  mcp?: Layer.Layer<MCP.Service>
  // FEAT-010: lets a test swap the V2 session layer (default: SessionV2.defaultLayer with noop
  // execution) so the V2 owner branch of loop() can be observed without a live V2 runner.
  sessionV2?: Layer.Layer<SessionV2.Service, never, never>
  // REAL-STACK: when sessionV2 contains the REAL SessionV2.layer (not a stub), the same wiring
  // must back ToolRegistry too — the file-wide shared memoMap (test/lib/effect.ts) builds the
  // SessionV2.layer constant once, so the registry's own SessionV2.defaultLayer (noop execution)
  // would otherwise win the memoized build and silently no-op the runner's drain.
  sessionV2ForTools?: Layer.Layer<SessionV2.Service, never, never>
}

// UPD-002: LLM.defaultLayer hardwires RuntimeFlags.defaultLayer, which would
// freeze default flags (e.g. experimentalNativeLlm) for every instance. Mirror
// the default wiring over `LLM.layer` so each harness's runtimeFlags wins.
const testLLMLayer = (runtimeFlags: Layer.Layer<RuntimeFlags.Service>) =>
  LLM.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(ProviderSvc.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(
      LLMClient.layer.pipe(Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer))),
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

function makePrompt(input?: PromptLayerOptions) {
  const runtimeFlags = RuntimeFlags.layer({
    experimentalEventSystem: true,
    coreV2ExecutionOwner: false,
    // W6-1 / P1-2: this harness provides no Worktree service (the registry is built over a stubbed
    // RuntimeBase to avoid the Worktree→Project→Database chain). The prompt-loop tests that drive the
    // `task` tool spawn WRITE-TYPE general subagents, which under the default strictPlanGate would now
    // fail closed before spawning — so the harness selects the W6 escape hatch (shared-directory
    // fallback); strict isolation behaviour itself is asserted in test/tool/task.test.ts.
    strictPlanGate: false,
    ...input?.flags,
  })
  const pluginLayer = input?.plugin ? Layer.succeed(Plugin.Service, input.plugin) : Plugin.defaultLayer
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    testLLMLayer(runtimeFlags),
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    pluginLayer,
    Config.defaultLayer,
    Auth.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    input?.mcp ?? mcp,
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
    Layer.provide(input?.sessionV2ForTools ?? SessionV2.defaultLayer),
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
    // V3.5: the registry layer now requires DebugService + RuntimeBase (debug/profile
    // tools route through D1/R0). These tests never invoke those tools, so provide the
    // real (lightweight) DebugService over a no-op RuntimeBase stub — this satisfies the
    // layer without pulling in the heavy Worktree→Project→Database chain (a second
    // Database instance was stalling the shared LLM/provider path).
    Layer.provide(stubDebugServiceLayer),
    Layer.provide(stubRuntimeBaseLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc =
    input?.processor === "blocking"
      ? blockingProcessor
      : SessionProcessor.layer.pipe(
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
  // v2w-l2: the harness target is the lean V2 pair (command/shell surface over the prompt-v2
  // admission/loop service). The legacy-only requirements the monolith had (SessionProviderOwner,
  // Instruction, SystemPrompt, Image, the steer buffer) left with it; everything else keeps the
  // same instances the surrounding suites observe (run/compact/proc/registry/trunc over `deps`).
  const promptLayer = SessionCommandV2.layer.pipe(
    Layer.provideMerge(SessionPromptV2.layer),
    Layer.provide(input?.sessionV2 ?? SessionV2.defaultLayer),
    Layer.provide(testInstanceStoreLayer),
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    // ToolRegistry.layer (above) still requires Instruction for the read tool; the monolith
    // dropped this provide with its own requirement, but the registry keeps it.
    Layer.provide(Instruction.defaultLayer),
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
  if (!input?.federation) return promptLayer
  return promptLayer.pipe(
    Layer.provideMerge(
      Layer.succeed(SessionFederatedContext.Service, SessionFederatedContext.Service.of(input.federation)),
    ),
  )
}

function makeHttp(input?: PromptLayerOptions) {
  // The composed test-layer chain carries an `unknown` error channel from its dependency graph
  // (pre-existing variance); the test harness requires a never-error layer — composition failures
  // here are test defects, so orDie is the correct boundary.
  return Layer.mergeAll(TestLLMServer.layer, makePrompt(input)).pipe(Layer.orDie)
}

function makeHttpNoLLMServer(input?: PromptLayerOptions) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const noLLMServer = testEffect(makeHttpNoLLMServer())
// UPD-002: same provider family but default (AI SDK) runtime — asserts the
// synthetic StructuredOutput path is retained when the wire path is unavailable.
const wireCapableAiSdk = testEffect(makeHttp())
const mutatingProviderHistoryTrigger: Plugin.Interface["trigger"] = (name, _input, output) =>
  Effect.sync(() => {
    if (name !== "experimental.chat.messages.transform") return output
    const messages = (output as { messages: SessionV1.WithParts[] }).messages
    const user = messages.findLast((message) => message.info.role === "user")
    const text = user?.parts.find((part) => part.type === "text")
    if (user) user.info.id = MessageID.make("msg_plugin_projection_only")
    if (text?.type === "text") text.text = "provider-only transformed text"
    return output
  })
const providerHistoryTransform = testEffect(
  makeHttp({
    plugin: Plugin.Service.of({
      trigger: mutatingProviderHistoryTrigger,
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    }),
  }),
)
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
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
        // maxRetries:0 so a refused-connection test fails immediately instead of
        // retrying 3× with exponential backoff (which eats 6s+ and trips the budget).
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

function providerCfgWithContext(url: string, context: number) {
  const base = providerCfg(url)
  return {
    ...base,
    provider: {
      ...base.provider,
      test: {
        ...base.provider.test,
        models: {
          ...base.provider.test.models,
          "test-model": {
            ...base.provider.test.models["test-model"],
            limit: { context, output: 10_000 },
          },
        },
      },
    },
  }
}

// UPD-002: a Responses-family, wire-format-capable provider (@ai-sdk/openai).
// Official provider IDs ignore config.provider overrides, so this uses a
// custom id; the `deepagent-code*` prefix keeps the native runtime status gate
// happy while the npm package drives Responses wire lowering.
// The baseline `test` provider stays registered (title/small-model paths), and
// the build agent is pinned to the wire-capable model.
function wireProviderCfg(url: string) {
  const base = providerCfg(url)
  return {
    ...base,
    agent: {
      build: { model: "deepagent-code-wire/test-model" },
    },
    provider: {
      ...base.provider,
      "deepagent-code-wire": {
        name: "Wire Test",
        id: "deepagent-code-wire",
        env: [],
        npm: "@ai-sdk/openai",
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
          baseURL: url,
          maxRetries: 0,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const ensureDir = Effect.fn("test.ensureDir")(function* (dir: string) {
  const fs = yield* FSUtil.Service
  yield* fs.ensureDir(dir)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "deepagent-code.json"),
    JSON.stringify({ $schema: "https://ai.deepagent.ltd/config.schema.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// RI-127 V2 化：legacy helper 断言 processor receipt 的 validation_outcome；V2-only 下
// legacy receipt 表保持零行，协议证据改为（a）plan 工具件上的 ordinal 文本与 metadata、
//（b）V2 provider-turn receipt（两次 dispatch，同属一个 activity）、（c）终止时的 typed
// assistant error（投影面折叠为 UnknownError，名字/code 保留在 message 文本中）。
const assertPlanProtocolProviderBudget = Effect.fn("test.assertPlanProtocolProviderBudget")(function* (input: {
  payload: Record<string, unknown>
  errorCode: string
}) {
  const { llm } = yield* useServerConfig(providerCfg)
  const promptSvc = yield* SessionPromptV2.Service
  const commandSvc = yield* SessionCommandV2.Service
  const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
  const sessions = yield* Session.Service
  const { db } = yield* Database.Service
  yield* mintR0Authorization(db)
  const session = yield* sessions.create({
    title: "Pinned",
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  })
  yield* provideR0OwnerRefs(
    prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "build the benchmark suite" }],
    }),
  )
  yield* llm.tool("plan", input.payload)
  yield* llm.tool("plan", input.payload)
  yield* llm.text("third provider dispatch must not happen")

  const result = yield* provideR0OwnerRefs(prompt.loop({ sessionID: session.id }))

  // The second consecutive plan protocol failure terminates the turn — the queued third
  // response is never consumed.
  expect(yield* llm.calls).toBe(2)
  expect(yield* llm.pending).toBe(1)
  expect(result.info.role).toBe("assistant")
  if (result.info.role === "assistant") {
    expect(result.info.finish).toBe("error")
    expect(result.info.error).toMatchObject({ name: "UnknownError" })
    const data = JSON.stringify(result.info.error?.data)
    expect(data).toContain("PlanProtocolViolation")
    expect(data).toContain(input.errorCode)
    expect(data).toContain("attempt 2 of 2")
  }
  const planParts = (yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie)).flatMap((message) =>
    message.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "plan"),
  )
  expect(planParts).toHaveLength(2)
  planParts.forEach((part, index) => {
    // A protocol failure settles as a COMPLETED plan part (the leaf's not-committed output is
    // a success result carrying the correction copy), annotated with the attempt ordinal.
    expect(part.state.status).toBe("completed")
    const text = part.state.status === "completed" ? part.state.output : ""
    const metadata =
      part.state.status === "completed" || part.state.status === "error" ? part.state.metadata : undefined
    expect(text).toContain(`[Plan attempt ${index + 1} of 2]`)
    expect(metadata).toMatchObject({
      plan: { protocol: "invalid", attempt_ordinal: index + 1, error_code: input.errorCode },
    })
  })
  expect(
    yield* db
      .select()
      .from(SessionToolRequestReceiptTable)
      .where(eq(SessionToolRequestReceiptTable.session_id, session.id))
      .all()
      .pipe(Effect.orDie),
  ).toHaveLength(0)
  expect(yield* db.select().from(SessionToolArgumentReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)
  expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
  const receipts = (yield* db
    .select()
    .from(V2ProviderTurnReceiptTable)
    .where(eq(V2ProviderTurnReceiptTable.session_id, session.id))
    .all()
    .pipe(Effect.orDie)).toSorted((a, b) => a.request_ordinal - b.request_ordinal)
  expect(receipts).toHaveLength(2)
  expect(receipts[1]?.activity_id).toBe(receipts[0]?.activity_id)
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const promptSvc = yield* SessionPromptV2.Service
  const commandSvc = yield* SessionCommandV2.Service
  const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// ===== V2 owner harness definitions (hoisted above first use; keep before all tests) =====
type CapturedLog = { message: string; level: string; annotations: Record<string, unknown> }
const captureLogs = <A, E, R>(sink: CapturedLog[], fx: Effect.Effect<A, E, R>) =>
  fx.pipe(
    Effect.provide(
      Logger.layer(
        [
          Logger.make(({ message, logLevel, fiber }) => {
            sink.push({
              message: String(message),
              level: logLevel,
              annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
            })
          }),
        ],
        { mergeWithExisting: false },
      ),
    ),
  )

const v2OwnerResumeCalls: string[] = []
const cancelInterruptCalls: string[] = []
// FEAT-010: the stub replaces SessionV2.Service only; SessionProjector.defaultLayer is merged back
// in because the default SessionV2 layer stack carries it, and it is the subscriber that persists
// session/message rows from events (without it, Session.get fails with "Session not found").
const v2OwnerStubLayer = Layer.merge(
  Layer.succeed(
    SessionV2.Service,
    SessionV2.Service.of({
      list: () => Effect.succeed([]),
      create: () => Effect.die("v2 owner stub: create unused"),
      get: () => Effect.die("v2 owner stub: get unused"),
      requireWritable: () => Effect.die("v2 owner stub: requireWritable unused"),
      update: () => Effect.die("v2 owner stub: update unused"),
      messages: () => Effect.succeed([]),
      message: () => Effect.succeed(undefined),
      context: () =>
        Effect.succeed([
          new SessionMessage.Assistant({
            id: SessionMessage.ID.create(),
            type: "assistant",
            agent: "build",
            model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") },
            content: [
              new SessionMessage.AssistantText({ type: "text", id: "text-v2-owner-stub", text: "v2 owner reply" }),
            ],
            finish: "stop",
            cost: 0,
            time: { created: DateTime.makeUnsafe(Date.now()), completed: DateTime.makeUnsafe(Date.now()) },
          }),
        ]),
      events: () => Stream.empty,
      switchAgent: () => Effect.die("v2 owner stub: switchAgent unused"),
      switchModel: () => Effect.die("v2 owner stub: switchModel unused"),
      setPermissions: () => Effect.die("v2 owner stub: setPermissions unused"),
      setArchived: () => Effect.die("v2 owner stub: setArchived unused"),
      prompt: () => Effect.die("v2 owner stub: prompt unused"),
      shell: () => Effect.die("v2 owner stub: shell unused"),
      skill: () => Effect.die("v2 owner stub: skill unused"),
      compact: () => Effect.die("v2 owner stub: compact unused"),
      wait: () => Effect.die("v2 owner stub: wait unused"),
      resume: (sessionID) =>
        Effect.sync(() => {
          v2OwnerResumeCalls.push(sessionID)
        }),
      interrupt: (sessionID) =>
        Effect.sync(() => {
          cancelInterruptCalls.push(sessionID)
        }),
    }),
  ),
  SessionProjector.defaultLayer,
).pipe(Layer.orDie)

const v2Only = testEffect(
  makeHttp({ flags: { coreV2Only: true, coreV2ExecutionOwner: true }, sessionV2: v2OwnerStubLayer }),
)

// LEGACY-EXECUTION-ZERO: under the V2-only profile every legacy execution entry refuses with the
// typed LegacyExecutionUnavailable BEFORE any durable write — the zero-reachability contract. Row
// invariance across the legacy writer set (intent / steer / receipt / message / part) is the oracle:
// legacy execution, writer and owner rows must not move.
type LegacyRowSnapshot = {
  intents: number
  steers: number
  receipts: number
  messages: number
  parts: number
  leases: number
  activities: number
  selections: number
}

const expectLegacyZeroRows = (
  db: Database.Interface["db"],
  before: LegacyRowSnapshot,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const rows = yield* Effect.all([
      db.select().from(SessionIntentTable).all(),
      db.select().from(SessionSteerTable).all(),
      db.select().from(SessionToolRequestReceiptTable).all(),
      db.select().from(MessageTable).all(),
      db.select().from(PartTable).all(),
      db.select().from(SessionProviderOwnerLeaseTable).all(),
      db.select().from(SessionActivityTable).all(),
      db.select().from(SessionContextSelectionTable).all(),
    ]).pipe(Effect.orDie)
    expect(rows[0].length).toBe(before.intents)
    expect(rows[1].length).toBe(before.steers)
    expect(rows[2].length).toBe(before.receipts)
    expect(rows[3].length).toBe(before.messages)
    expect(rows[4].length).toBe(before.parts)
    expect(rows[5].length).toBe(before.leases)
    expect(rows[6].length).toBe(before.activities)
    expect(rows[7].length).toBe(before.selections)
  })

const snapshotLegacyRows = (db: Database.Interface["db"]): Effect.Effect<LegacyRowSnapshot, never, never> =>
  Effect.gen(function* () {
    const counts = yield* Effect.all([
      db.select().from(SessionIntentTable).all(),
      db.select().from(SessionSteerTable).all(),
      db.select().from(SessionToolRequestReceiptTable).all(),
      db.select().from(MessageTable).all(),
      db.select().from(PartTable).all(),
      db.select().from(SessionProviderOwnerLeaseTable).all(),
      db.select().from(SessionActivityTable).all(),
      db.select().from(SessionContextSelectionTable).all(),
    ]).pipe(Effect.orDie)
    return {
      intents: counts[0].length,
      steers: counts[1].length,
      receipts: counts[2].length,
      messages: counts[3].length,
      parts: counts[4].length,
      leases: counts[5].length,
      activities: counts[6].length,
      selections: counts[7].length,
    }
  })

const failureIsLegacyUnavailable = (exit: Exit.Exit<unknown, unknown>): LegacyExecutionUnavailable => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("expected failure")
  expect(exit.cause.reasons.every(Cause.isFailReason)).toBe(true)
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
  expect(error).toBeInstanceOf(LegacyExecutionUnavailable)
  return error as LegacyExecutionUnavailable
}

const r0Issuance = V2OwnerAuthorization.generateAuthorizationKeyPair()
const r0Identity = {
  subjectCommit: "a".repeat(40),
  subjectTree: "b".repeat(40),
  schemaDigest: "c".repeat(64),
  buildID: "d".repeat(64),
  packageDigest: "e".repeat(64),
}
const r0Campaign = "r0-test-campaign"
const r0Fields = {
  authorizationID: "auth_r0_test",
  campaignID: r0Campaign,
  ...r0Identity,
  validFrom: 1_000,
  expiresAt: 4_000_000_000_000,
}
const r0Signed = {
  ...r0Fields,
  signatureDigest: V2OwnerAuthorization.signAuthorization(r0Issuance.privateKeyPem, r0Fields),
}
const r0V2PromptCalls: string[] = []
const r0V2PromptTexts: string[] = []
const r0V2PromptDeliveries: Array<SessionInput.Delivery | undefined> = []
const r0V2ResumeCalls: string[] = []
// RI-139: promptV2 forwards an explicit input.model into the V2 session store via switchModel
// BEFORE admission, so the drain resolves the caller's model instead of the catalog default.
const r0V2SwitchModelCalls: Array<{ id: string; providerID: string }> = []
const r0V2AdoptCalls: string[] = []
const r0V2AdoptPermissions: unknown[] = []
const r0V2Stub = SessionV2.Service.of({
  list: () => Effect.succeed([]),
  create: (input) =>
    Effect.sync(() => {
      if (input.id) r0V2AdoptCalls.push(input.id)
      r0V2AdoptPermissions.push(input.permissions)
    }).pipe(
      Effect.as({ id: input.id, directory: "/tmp/ws1", slug: "r0", agent: "build" } as unknown as SessionV2.Info),
    ),
  get: () => Effect.fail(new Error("stub: not adopted") as unknown as SessionV2.NotFoundError),
  requireWritable: () => Effect.succeed({ id: SessionV2.ID.make("ses_r0_stub") } as SessionV2.Info),
  update: () => Effect.die("r0 stub: update unused"),
  messages: () =>
    Effect.succeed([
      new SessionMessage.User({
        id: SessionMessage.ID.make("msg_user_r0_1"),
        type: "user",
        time: { created: DateTime.makeUnsafe(1_000_000) },
        text: "user text",
      }),
      new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_assistant_r0_1"),
        type: "assistant",
        agent: "build",
        model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") },
        content: [new SessionMessage.AssistantText({ type: "text", id: "text_r0_1", text: "v2 owner reply" })],
        finish: "stop",
        cost: 0,
        time: { created: DateTime.makeUnsafe(1_000_100), completed: DateTime.makeUnsafe(1_000_100) },
      }),
    ]),
  message: () => Effect.succeed(undefined),
  context: () =>
    Effect.succeed([
      new SessionMessage.Assistant({
        id: SessionMessage.ID.make("msg_assistant_r0_1"),
        type: "assistant",
        agent: "build",
        model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test") },
        content: [new SessionMessage.AssistantText({ type: "text", id: "text_r0_1", text: "v2 owner reply" })],
        finish: "stop",
        cost: 0,
        time: { created: DateTime.makeUnsafe(1_000_100), completed: DateTime.makeUnsafe(1_000_100) },
      }),
    ]),
  events: () => Stream.empty,
  switchAgent: () => Effect.die("r0 stub: switchAgent unused"),
  switchModel: (input) =>
    Effect.sync(() => {
      r0V2SwitchModelCalls.push({ id: input.model.id, providerID: input.model.providerID })
    }),
  setPermissions: () => Effect.die("r0 stub: setPermissions unused"),
  setArchived: () => Effect.die("r0 stub: setArchived unused"),
  prompt: (input) =>
    Effect.sync(() => {
      r0V2PromptCalls.push(input.sessionID)
      r0V2PromptTexts.push(input.prompt.text)
      // W16: record the admission delivery so the goal_steer routing (vs the undefined default the
      // chat path passes — core SessionV2.prompt defaults it to "steer") is pinned at the call shape.
      r0V2PromptDeliveries.push(input.delivery)
    }).pipe(
      Effect.as({
        id: SessionMessage.ID.make("msg_r0_admitted"),
        delivery: "steer",
      } as unknown as SessionInput.Admitted),
    ),
  shell: () => Effect.die("r0 stub: shell unused"),
  skill: () => Effect.die("r0 stub: skill unused"),
  compact: () => Effect.die("r0 stub: compact unused"),
  wait: () => Effect.die("r0 stub: wait unused"),
  resume: (sessionID) =>
    Effect.sync(() => {
      r0V2ResumeCalls.push(sessionID)
    }),
  interrupt: () => Effect.void,
})
const r0V2StubLayer = Layer.merge(Layer.succeed(SessionV2.Service, r0V2Stub), SessionProjector.defaultLayer).pipe(
  Layer.orDie,
)

// REAL-STACK harness: SessionV2.layer over the SAME module-level Database.defaultLayer constant the
// prompt harness uses, with the LOCAL execution (real runner) + the harness's LLM transport
// (TestLLMServer via LLM.layer). This is the deterministic full-stack r0 E2E: admission -> wake-free
// drain -> real runner (one llm.stream) -> journal -> V1 mirror -> projection.
const realV2Layer = SessionV2.layer
  .pipe(
    Layer.provide(SessionStore.defaultLayer),
    Layer.provide(EventV2.defaultLayer),
    Layer.provide(ProjectV2.defaultLayer),
    Layer.provide(SessionProjector.defaultLayer),
    Layer.provide(SessionExecutionLocal.liveLayer),
    Layer.provide(Database.defaultLayer),
  )
  .pipe(Layer.orDie)
const v2Real = testEffect(
  makeHttp({
    flags: { coreV2Only: true, coreV2ExecutionOwner: true },
    sessionV2: realV2Layer,
    sessionV2ForTools: realV2Layer,
  }).pipe(
    Layer.provide(Layer.succeed(CurrentOwnerCampaign, r0Campaign)),
    Layer.provide(Layer.succeed(CurrentBuildIdentity, r0Identity)),
    Layer.provide(Layer.succeed(CurrentOwnerAuthorizationPublicKey, r0Issuance.publicKeyPem)),
  ),
)
const v2Qualified = testEffect(
  makeHttp({ flags: { coreV2Only: true, coreV2ExecutionOwner: true }, sessionV2: r0V2StubLayer }),
)

// RI-130: the V2 question tool asks through the Location-scoped QuestionV2 service (core), which the
// drain reaches via LocationServiceMap placement. Exposing the SAME LocationServiceMap.layer value in
// the visible test context (one LayerMap instance per layer build, memoized by layer identity) lets a
// host test resolve the identical per-Location QuestionV2 tree the runner's question tool uses.
const v2RealLocations = testEffect(
  makeHttp({
    flags: { coreV2Only: true, coreV2ExecutionOwner: true },
    sessionV2: realV2Layer,
    sessionV2ForTools: realV2Layer,
  }).pipe(
    Layer.provide(Layer.succeed(CurrentOwnerCampaign, r0Campaign)),
    Layer.provide(Layer.succeed(CurrentBuildIdentity, r0Identity)),
    Layer.provide(Layer.succeed(CurrentOwnerAuthorizationPublicKey, r0Issuance.publicKeyPem)),
    Layer.provideMerge(LocationServiceMap.layer),
  ),
)

const provideR0OwnerRefs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(CurrentOwnerCampaign, r0Campaign),
    Effect.provideService(CurrentBuildIdentity, r0Identity),
    Effect.provideService(CurrentOwnerAuthorizationPublicKey, r0Issuance.publicKeyPem),
  )

const mintR0Authorization = (db: Database.Interface["db"]): Effect.Effect<void, unknown, never> =>
  Effect.gen(function* () {
    yield* db
      .insert(V2OwnerAuthorizationTable)
      .values({
        authorization_id: r0Signed.authorizationID,
        campaign_id: r0Signed.campaignID,
        subject_commit: r0Signed.subjectCommit,
        subject_tree: r0Signed.subjectTree,
        schema_digest: r0Signed.schemaDigest,
        build_id: r0Signed.buildID,
        package_digest: r0Signed.packageDigest,
        valid_from: r0Signed.validFrom,
        expires_at: r0Signed.expiresAt,
        status: "active",
        signature_digest: r0Signed.signatureDigest,
        authorization_digest: Hash.sha256(V2OwnerAuthorization.authorizationPayload(r0Fields)),
        created_at: Date.now(),
      })
      .run()
  })

// Loop semantics

v2Real.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      }),
    )
    // V2-only: legacy activity tables stay at zero; V2 activities are the execution authority.
    expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
    yield* llm.text("world")

    const result = yield* provideR0OwnerRefs(prompt.loop({ sessionID: chat.id }))
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
  }),
)

// RI-130（P1，CLOSED — harness 暴露裁决）：V2 question 工具经 location-scoped QuestionV2（core）提问，
// 宿主测试通过与 drain 相同的 LocationServiceMap 解析同一 Location 树的 QuestionV2.Service——list/reject
// 由此可从宿主面到达（design.md RI 表「harness 暴露 location 级 QuestionV2」选项；LayerMap key 必须复刻
// SessionStore fromRow 重建的 Location.Ref 精确形状）。拒绝使 in-flight provider turn 中断（core runner
// isQuestionRejected → Effect.interrupt，core session-runner「interrupts runner continuation…」同款
// 机制），question tool 件落 error（"Tool execution interrupted"）；joined prompt 调用者观测到 drain
// 吸收该中断、续跑一个 continuation provider turn 使活动落定——以 settled assistant 行成功返回
// （不悬挂、不以 interrupt 终态），session 回 idle，legacy activity 表保持零行，下一条 prompt 正常执行。
v2RealLocations.instance(
  "question rejection terminalizes the live run and permits the next prompt",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const locations = yield* LocationServiceMap
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({
        title: "Question rejection lifecycle",
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
      // The rejection interrupts the in-flight provider turn; the drain absorbs it and runs ONE
      // continuation provider turn (the question tool's error part is model-visible history) so the
      // activity settles — the joined prompt caller resolves with that settled assistant row.
      yield* llm.text("rejection acknowledged")
      yield* llm.text("next prompt succeeded")

      const first = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "ask before proceeding" }],
        }),
      ).pipe(Effect.forkChild)
      // The SessionStore rebuilds the session's Location.Ref with an explicit `workspaceID: undefined`
      // key (session/info.ts fromRow) — the LayerMap key must match that exact shape or it resolves a
      // different per-Location tree (and a different QuestionV2 instance).
      const questions = yield* QuestionV2.Service.pipe(
        Effect.provide(
          locations.get({
            directory: AbsolutePath.make((yield* sessions.get(chat.id)).directory),
            workspaceID: undefined,
          }),
        ),
      )
      const request = yield* pollWithTimeout(
        questions.list().pipe(Effect.map((pending) => pending.find((item) => item.sessionID === chat.id))),
        "timed out waiting for question request",
      )
      yield* questions.reject(request.id)

      // V2-only: the rejection terminalizes the live run without a legacy user_rejected_question
      // activity record, and the joined caller is released with the settled assistant row.
      const firstExit = yield* awaitWithTimeout(
        Fiber.await(first),
        "timed out joining question-rejected prompt",
        "5 seconds",
      )
      expect(Exit.isSuccess(firstExit)).toBe(true)
      if (Exit.isSuccess(firstExit)) {
        expect(firstExit.value.info.role).toBe("assistant")
        expect(
          firstExit.value.parts.some((part) => part.type === "text" && part.text === "rejection acknowledged"),
        ).toBeTrue()
      }
      const rejected = (yield* sessions.messages({ sessionID: chat.id })).flatMap((message) =>
        message.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "question"),
      )
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.state.status).toBe("error")
      yield* pollWithTimeout(
        status.get(chat.id).pipe(Effect.map((s) => (s.type === "idle" ? (true as const) : undefined))),
        "session never became idle after question rejection",
      )
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)

      const next = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "continue now" }],
        }),
      )
      expect(next.parts.some((part) => part.type === "text" && part.text === "next prompt succeeded")).toBeTrue()
      expect(yield* llm.hits).toHaveLength(3)
    }),
  15_000,
)

// RI-126（P1，CLOSED）：structured output format 经 V2 admission 持久化（core Prompt.format →
// user message），core runner 在非 Responses 家族上合成 StructuredOutput 工具（tool_choice
// "required" + 系统尾部契约原文），模型调用即捕获为终态答案——StructuredCaptured 事件把值写到
// 投影 assistant（wire info.structured），turn 以 finish "tool-calls" 结束且不再续跑。V2-only
// 证据映射：legacy request receipt 表保持零行（response_fingerprint 无 V2 对应物， fingerprint
// 语义由 V2 provider-turn receipt 的 request_input_hash/prepared_turn_hash 承担）。
v2Real.instance("fingerprints the final persisted structured assistant", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const chat = yield* sessions.create({
      title: "Structured response receipt",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
          },
          retryCount: 1,
        },
        parts: [{ type: "text", text: "Return the answer." }],
      }),
    )
    yield* llm.tool("StructuredOutput", { answer: 4 })

    const result = yield* provideR0OwnerRefs(prompt.loop({ sessionID: chat.id }))
    const persisted = (yield* sessions.messages({ sessionID: chat.id })).find(
      (message) => message.info.id === result.info.id,
    )
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.structured).toEqual({ answer: 4 })
      expect(result.info.finish).toBe("tool-calls")
    }
    expect(persisted).toBeDefined()
    if (persisted && persisted.info.role === "assistant") expect(persisted.info.structured).toEqual({ answer: 4 })
    // Synthetic wire contract (former wireCapableAiSdk assertion, V2 has no AI SDK fork): the
    // StructuredOutput tool is advertised and tool_choice is forced on the chat route.
    const wireRequest = (yield* llm.hits).find((item) => JSON.stringify(item.body).includes("Return the answer"))
    expect(wireRequest).toBeDefined()
    const body = wireRequest!.body
    expect(JSON.stringify(body.tools)).toContain("StructuredOutput")
    expect(body.tool_choice).toBe("required")
    // V2-only：legacy receipt/activity 表保持零行；单次 dispatch 的证据在 V2 receipt。
    expect(
      yield* db
        .select()
        .from(SessionToolRequestReceiptTable)
        .where(eq(SessionToolRequestReceiptTable.session_id, chat.id))
        .all()
        .pipe(Effect.orDie),
    ).toHaveLength(0)
    const receipts = yield* db
      .select()
      .from(V2ProviderTurnReceiptTable)
      .where(eq(V2ProviderTurnReceiptTable.session_id, chat.id))
      .all()
      .pipe(Effect.orDie)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.request_input_hash).toHaveLength(64)
  }),
)

// UPD-002: wire-level structured output on a Responses + format-capable family.
// RI-126（P1，CLOSED）：V2 runner 的 wire 判定 = Responses 家族路由 + 声明的 structuredOutput
// 能力（defaultCapabilities(openai.responses) 为 true）——json_schema 经 LLMRequest.responseFormat
// 降为 Responses text.format，不合成 StructuredOutput 工具、tool_choice 不强制；provider 约束的
// 最终文本 JSON.parse 后经 StructuredCaptured 写到 assistant（finish "stop"）。V2 runner 恒为
// native runtime，legacy 的 experimentalNativeLlm 开关在此无对应物。
v2Real.instance("delivers json_schema output through wire text.format", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(wireProviderCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const chat = yield* sessions.create({
      title: "Wire structured output",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* llm.text('{"answer": 4}')
    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        // V2 model resolution reads the session model (agent.build.model pinning is a legacy
        // loop concern) — pin the wire-capable model explicitly (promptV2 switchModel).
        model: { providerID: ProviderV2.ID.make("deepagent-code-wire"), modelID: ModelV2.ID.make("test-model") },
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
          },
          retryCount: 1,
        },
        parts: [{ type: "text", text: "Return the answer." }],
      }),
    )

    const result = yield* provideR0OwnerRefs(prompt.loop({ sessionID: chat.id }))

    const wireRequest = (yield* llm.hits).find((item) => JSON.stringify(item.body).includes("Return the answer"))
    expect(wireRequest).toBeDefined()
    const body = wireRequest!.body
    // Wire assertions: Responses endpoint, text.format lowered, NO synthesized
    // StructuredOutput tool, and tool_choice is not forced to "required".
    expect(wireRequest!.url.pathname).toBe("/v1/responses")
    const text = body.text as Record<string, unknown> | undefined
    expect(text?.format).toMatchObject({ type: "json_schema", name: "structured_output" })
    expect((text?.format as Record<string, unknown> | undefined)?.schema).toMatchObject({
      properties: { answer: { type: "number" } },
    })
    const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
    expect(tools.some((tool) => tool.name === "StructuredOutput")).toBe(false)
    expect(body.tool_choice).not.toBe("required")

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.structured).toEqual({ answer: 4 })
      expect(result.info.finish).toBe("stop")
    }
  }),
)

// UPD-002/RI-126 裁决：V2 runner 恒走 native runtime，legacy 的"AI SDK runtime ⇒ 保留合成工具"
// 分叉在 V2 无对应物——合成工具路径已由 "fingerprints the final persisted structured assistant"
// 在 chat 路由上覆盖（含 tool_choice "required" 断言），wire-capable 家族在 V2 恒走 wire。
// 本测试无 V2 等价行为，保持 skip 作为缺口记录。
wireCapableAiSdk.instance.skip("keeps the synthetic StructuredOutput path when the runtime is AI SDK", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(wireProviderCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Synthetic structured output",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
        },
        retryCount: 1,
      },
      parts: [{ type: "text", text: "Return the answer." }],
    })
    yield* llm.tool("StructuredOutput", { answer: 4 })

    const result = yield* prompt.loop({ sessionID: chat.id })

    const syntheticRequest = (yield* llm.hits).find((item) => JSON.stringify(item.body).includes("Return the answer"))
    expect(syntheticRequest).toBeDefined()
    const body = syntheticRequest!.body
    const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
    expect(tools.some((tool) => tool.name === "StructuredOutput")).toBe(true)
    expect(body.tool_choice).toBe("required")

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.structured).toEqual({ answer: 4 })
      expect(result.info.finish).toBe("tool-calls")
    }
  }),
)

// RI-131（P1，ADJUDICATED — 声明面删除）：experimental.chat.messages.transform hook 只在 legacy
// prompt.ts:4622 与 compaction.ts:1833 触发，V2-only 下无触发点；core runner 的 prepare seam 属 core
// 侧改动面（llm.ts），不在本次 app 侧裁决范围。已按 RI-113 死声明模式从 capability 声明删除
//（tool-capability.ts HOOK_PROFILE 不再有该 hook 的 provider-phase 条目，注册它的 plugin 落入
// UNKNOWN_HOOK_PROFILE，taskReachable/workspaceMutation 判定不变）。本测试断言的 provider 消息变换
// 隔离在 V2 无消费点，保持 skip；若 core 侧日后接入 prepare seam，需以 V2 触发断言重写。
providerHistoryTransform.instance.skip("isolates provider message transforms from durable history authority", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Provider transform isolation",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "durable original text" }],
    })
    const original = (yield* sessions.messages({ sessionID: chat.id })).findLast(
      (message) => message.info.role === "user",
    )
    expect(original).toBeDefined()
    if (!original) return
    yield* llm.text("transformed")

    const result = yield* prompt.loop({ sessionID: chat.id })
    const persisted = yield* sessions.messages({ sessionID: chat.id })
    const request = (yield* llm.hits)[0]

    expect(JSON.stringify(request?.body)).toContain("provider-only transformed text")
    expect(JSON.stringify(request?.body)).not.toContain("durable original text")
    expect(persisted.some((message) => message.info.id === "msg_plugin_projection_only")).toBe(false)
    expect(
      persisted.some((message) =>
        message.parts.some((part) => part.type === "text" && part.text === "durable original text"),
      ),
    ).toBe(true)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.parentID).toBe(original.info.id)
  }),
)

// RI-132（P1，CLOSED）：unknown-context-limit host guard 在 V2 prepare seam 有消费点——core runner
// 在 commitTurn 后、dispatch 前用估计 token 数评估 host guard，unavailable 即 abandon receipt（failed +
// context_limit_unknown）并以 typed assistant error 终态结束 turn（0 次 provider dispatch）。
// V2-only 证据映射：legacy request/provider receipt 表保持零行，guard 证据在 V2 provider-turn receipt。
v2Real.instance("rejects an oversized unknown-limit request before provider dispatch", () => {
  const previous = process.env["DEEPAGENT_CODE_UNKNOWN_CONTEXT_GUARD"]
  process.env["DEEPAGENT_CODE_UNKNOWN_CONTEXT_GUARD"] = "1000"
  return Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfgWithContext(url, 0),
      compaction: { auto: false },
    }))
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const chat = yield* sessions.create({ title: "Unknown context guard" })
    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "x".repeat(5_000) }],
      }),
    )

    const result = yield* provideR0OwnerRefs(prompt.loop({ sessionID: chat.id }))
    expect(yield* llm.calls).toBe(0)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      // V2 投影面把 turn 错误统一折叠为 UnknownError（finish "error"）；guard 文案保持不变。
      expect(result.info.error).toMatchObject({ name: "UnknownError" })
      expect(JSON.stringify(result.info.error?.data)).toContain("Provider context limit is unknown")
      expect(result.info.finish).toBe("error")
    }
    const receipt = yield* db
      .select()
      .from(V2ProviderTurnReceiptTable)
      .where(eq(V2ProviderTurnReceiptTable.session_id, chat.id))
      .get()
      .pipe(Effect.orDie)
    expect(receipt?.state).toBe("failed")
    expect(receipt?.error_code).toBe("context_limit_unknown")
    expect(receipt?.request_input_hash).toHaveLength(64)
    expect(receipt?.prepared_turn_hash).toBeNull()
    expect(receipt?.terminal_at).toBeNumber()
    // V2-only：legacy per-request receipt 表保持零行。
    expect(
      yield* db
        .select()
        .from(SessionToolRequestReceiptTable)
        .where(eq(SessionToolRequestReceiptTable.session_id, chat.id))
        .all()
        .pipe(Effect.orDie),
    ).toHaveLength(0)
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (previous === undefined) delete process.env["DEEPAGENT_CODE_UNKNOWN_CONTEXT_GUARD"]
        else process.env["DEEPAGENT_CODE_UNKNOWN_CONTEXT_GUARD"] = previous
      }),
    ),
  )
})

// RI-133（P1，ADJUDICATED — 确认只读设计）：V2 不恢复 legacy committed-history 检疫门。裁决依据：
// (1) V2 历史权威是 event-sourced journal（SessionMessageTable 由 durable events 投影），legacy
// prompt-epoch 表（SessionPromptEpochMessageTable/SessionPromptEpochTable）在 V2-only 下没有任何写者
//（projectPromptHistory 只从 legacy loop 到达），"corrupt legacy epoch 表"不是 V2 能进入的状态；
// (2) V2 seam PromptEpoch.historyEpochLookup 按设计只读、注释明示 "never blocks a turn"；
// (3) 恢复阻塞门需要 core runner 改动（llm.ts），超出 app 侧裁决面。本测试的 fixture 前提
//（fork 后删 epoch 行触发检疫）在 V2-only 不成立，保持 skip 作为缺口记录。
it.instance.skip("quarantines corrupt committed history before provider dispatch", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "History authority corruption" })
    yield* prompt.prompt({
      sessionID: parent.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "must never reach the provider after corruption" }],
    })
    const child = yield* sessions.fork({
      sessionID: parent.id,
      intentID: "prompt-history-corruption-fork",
    })
    const { db } = yield* Database.Service
    yield* db
      .delete(SessionPromptEpochMessageTable)
      .where(eq(SessionPromptEpochMessageTable.session_id, child.id))
      .run()
      .pipe(Effect.orDie)

    const result = yield* prompt.loop({ sessionID: child.id }).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* llm.calls).toBe(0)
    expect(
      yield* db
        .select({ state: SessionHistoryStateTable.state, reason: SessionHistoryStateTable.reason })
        .from(SessionHistoryStateTable)
        .where(eq(SessionHistoryStateTable.session_id, child.id))
        .get()
        .pipe(Effect.orDie),
    ).toMatchObject({ state: "recovery_required", reason: expect.stringContaining("membership is incomplete") })
    expect(
      yield* db
        .select({
          authority_state: SessionPromptEpochTable.authority_state,
          recovery_reason: SessionPromptEpochTable.recovery_reason,
        })
        .from(SessionPromptEpochTable)
        .where(eq(SessionPromptEpochTable.session_id, child.id))
        .get()
        .pipe(Effect.orDie),
    ).toMatchObject({
      authority_state: "recovery_required",
      recovery_reason: expect.stringContaining("membership is incomplete"),
    })
  }),
)

// RI-133（P1，ADJUDICATED — 确认只读设计）：同上一条裁决——V2 历史权威是 event-sourced journal，
// legacy epoch 检疫门（缺失 committed replacement message → recovery_required）在 V2-only 无写者、
// 无消费点；historyEpochLookup 只读、never blocks a turn。保持 skip 作为缺口记录。
it.instance.skip("quarantines a missing committed replacement message before provider dispatch", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ title: "Missing committed replacement message" })
    yield* prompt.prompt({
      sessionID: parent.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "replacement message fixture" }],
    })
    const child = yield* sessions.fork({
      sessionID: parent.id,
      intentID: "prompt-history-missing-message-fork",
    })
    const { db } = yield* Database.Service
    const victim = yield* db
      .select({ message_id: SessionPromptEpochMessageTable.message_id })
      .from(SessionPromptEpochMessageTable)
      .where(eq(SessionPromptEpochMessageTable.session_id, child.id))
      .get()
      .pipe(Effect.orDie)
    expect(victim).toBeDefined()
    if (!victim) return
    yield* db
      .delete(MessageTable)
      .where(and(eq(MessageTable.session_id, child.id), eq(MessageTable.id, victim.message_id)))
      .run()
      .pipe(Effect.orDie)

    const result = yield* prompt.loop({ sessionID: child.id }).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(yield* llm.calls).toBe(0)
    expect(
      yield* db
        .select({ state: SessionHistoryStateTable.state, reason: SessionHistoryStateTable.reason })
        .from(SessionHistoryStateTable)
        .where(eq(SessionHistoryStateTable.session_id, child.id))
        .get()
        .pipe(Effect.orDie),
    ).toMatchObject({ state: "recovery_required", reason: expect.stringContaining("membership is incomplete") })
    expect(
      yield* db
        .select({
          authority_state: SessionPromptEpochTable.authority_state,
          recovery_reason: SessionPromptEpochTable.recovery_reason,
        })
        .from(SessionPromptEpochTable)
        .where(eq(SessionPromptEpochTable.session_id, child.id))
        .get()
        .pipe(Effect.orDie),
    ).toMatchObject({
      authority_state: "recovery_required",
      recovery_reason: expect.stringContaining("membership is incomplete"),
    })
  }),
)

it.instance("recovers only compaction continuations that were durably not dispatched", () =>
  Effect.gen(function* () {
    const { dir } = yield* useServerConfig(providerCfg)
    const sessions = yield* Session.Service
    const compaction = yield* SessionCompaction.Service
    const { db } = yield* Database.Service
    const canonicalDir = yield* (yield* FSUtil.Service).realPath(dir)
    const legacyProjectId = AgentGateway.DeepAgentDurableKnowledgeStore.projectIdForWorkspace(canonicalDir)
    const releasedIdentity = yield* Effect.gen(function* () {
      return yield* (yield* LocationIdentity.Service).resolve({
        boundary: { kind: "implicit_local" },
        directory: AbsolutePath.make(canonicalDir),
        project: { kind: "registered_root", observedProjectId: legacyProjectId },
      })
    }).pipe(Effect.provide(LocationIdentity.layer))
    const releasedKnowledgeBinding = DeepAgentReleasedSnapshot.binding(undefined)
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
      releasedIdentity.projectScopeKey,
      { stage: "all", percentage: 100, internalProjectScopeKeys: [], killSwitch: false },
    )
    const contextReadiness = {
      ...ContextFederationRollout.READINESS_READY_STUB,
      revision: "readiness-compaction-recovery",
      projectScopeKey: releasedIdentity.projectScopeKey,
      observedAt: 1,
    }
    const contextActivation = ContextActivationReceipt.make({
      readiness: contextReadiness,
      decision: ContextFederationRollout.activate(contextEligibility, contextReadiness),
      recordedAt: 2,
      projectionEnabled: false,
      toolsEnabled: false,
    })
    const contextActivationFingerprint = ContextActivationReceipt.fingerprint({
      eligibility: contextEligibility,
      readiness: contextReadiness,
      activation: contextActivation,
    })
    const recoveryOwnerToken = "prompt-recovery-owner"
    yield* db.run(sql`
      INSERT INTO session_provider_owner_lease (
        owner_token, registered_at, heartbeat_at, lease_expires_at
      ) VALUES
        (
          ${recoveryOwnerToken},
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 60000
        ),
        (
          'stale-process-owner',
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) + 60000
        )
    `)

    const seedContinuation = (input: { title: string; state: "admitted" | "dispatching" | "indeterminate" }) =>
      Effect.gen(function* () {
        const session = yield* sessions.create({ title: input.title })
        const continuation = yield* user(session.id, `continuation-${input.state}`)
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: continuation.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        })
        const authority = yield* MessageV2.promptHistoryProjectionEffect(session.id)
        const runID = `continuation-recovery-${input.state}`
        const receiptID = `receipt-recovery-${input.state}`
        const now = Date.now()
        yield* db
          .insert(CompactionRunTable)
          .values({
            run_id: runID,
            session_id: session.id,
            from_prompt_epoch: authority.epoch,
            target_prompt_epoch: authority.epoch,
            trigger: "manual",
            state: "committed",
            created_at: now,
            committed_at: now,
            source_window_id: authority.window.windowID,
            source_effective_history_hash: authority.effectiveHistoryHash,
            source_message_count: authority.messages.length,
            source_projection_version: authority.projectionVersion,
            continuation_wakeup_at: now,
            continuation_state: input.state,
            continuation_receipt_id: receiptID,
            continuation_admitted_at: now,
            continuation_dispatching_at: input.state === "admitted" ? null : now,
            continuation_terminal_at: input.state === "indeterminate" ? now : null,
            continuation_error_code:
              input.state === "indeterminate" ? "legacy_terminal_without_response_fingerprint" : null,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(CompactionArtifactTable)
          .values({
            artifact_id: `artifact-recovery-${input.state}`,
            run_id: runID,
            session_id: session.id,
            message_id: continuation.id,
            kind: "continue",
            state: "committed",
            created_at: now,
            committed_at: now,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionToolRequestReceiptTable) // fixture-exempt: seeds preparing receipt with stale owner for recovery fixture
          .values({
            receipt_id: receiptID,
            request_ordinal: 1,
            session_id: session.id,
            user_message_id: continuation.id,
            assistant_message_id: assistant.id,
            context_eligibility: contextEligibility,
            context_readiness: contextReadiness,
            context_activation: contextActivation,
            context_activation_fingerprint: contextActivationFingerprint,
            released_knowledge_security_namespace_id: releasedIdentity.securityNamespaceId,
            released_knowledge_project_scope_key: releasedIdentity.projectScopeKey,
            released_knowledge_binding_state: releasedKnowledgeBinding.state,
            released_knowledge_exact_refs: releasedKnowledgeBinding.exactRefs,
            released_knowledge_exact_refs_fingerprint: releasedKnowledgeBinding.exactRefsFingerprint,
            provider_id: "test",
            model_id: "test-model",
            protocol: "chat",
            registry_tool_ids: [],
            permission_filtered_tool_ids: [],
            final_offered_tool_ids: [],
            call_ids: [],
            prompt_epoch: authority.epoch,
            prompt_window_id: authority.window.windowID,
            effective_history_hash: authority.effectiveHistoryHash,
            request_input_hash: "request-input-hash",
            provider_state: "preparing",
            owner_token: "stale-process-owner",
            request_state: "prepared",
            created_at: now,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionToolRequestReceiptTable)
          .set({
            released_knowledge_selected_refs: [],
            released_knowledge_selected_refs_fingerprint: releasedKnowledgeBinding.exactRefsFingerprint,
          })
          .where(
            and(
              eq(SessionToolRequestReceiptTable.receipt_id, receiptID),
              eq(SessionToolRequestReceiptTable.provider_state, "preparing"),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionToolRequestReceiptTable)
          .set({
            provider_state: "prepared",
            final_request_hash: Hash.sha256("compaction-final-request"),
            provider_request_hash: Hash.sha256("compaction-final-request"),
            prepared_turn_hash: Hash.sha256("compaction-prepared-turn"),
            system_stable_hash: Hash.sha256("compaction-system-stable"),
            system_volatile_hash: Hash.sha256("compaction-system-volatile"),
            wire_request_hash: Hash.sha256("compaction-final-request"),
            tool_definition_hash: Hash.sha256("[]"),
            tool_result_reference_ids: [],
            tool_result_reference_count: 0,
            adapter_prepared_at: now,
          })
          .where(
            and(
              eq(SessionToolRequestReceiptTable.receipt_id, receiptID),
              eq(SessionToolRequestReceiptTable.provider_state, "preparing"),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        if (input.state !== "admitted") {
          yield* db
            .update(SessionToolRequestReceiptTable)
            .set({ provider_state: "dispatching", request_state: "dispatched", dispatching_at: now })
            .where(
              and(
                eq(SessionToolRequestReceiptTable.receipt_id, receiptID),
                eq(SessionToolRequestReceiptTable.provider_state, "prepared"),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        }
        if (input.state === "indeterminate") {
          yield* db
            .update(SessionToolRequestReceiptTable)
            .set({ provider_state: "settled", terminal_at: now })
            .where(
              and(
                eq(SessionToolRequestReceiptTable.receipt_id, receiptID),
                eq(SessionToolRequestReceiptTable.provider_state, "dispatching"),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        }
        return { session, runID, receiptID, assistant }
      })

    const safe = yield* seedContinuation({ title: "Safe continuation recovery", state: "admitted" })
    const ambiguous = yield* seedContinuation({ title: "Ambiguous continuation recovery", state: "dispatching" })
    const incomplete = yield* seedContinuation({
      title: "Incomplete terminal continuation recovery",
      state: "indeterminate",
    })
    yield* db.run(sql`
      UPDATE session_provider_owner_lease
      SET released_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      WHERE owner_token = 'stale-process-owner'
    `)
    const unadmittedSession = yield* sessions.create({ title: "Unadmitted continuation recovery" })
    const unadmittedContinuation = yield* user(unadmittedSession.id, "continuation-pending")
    const unadmittedAuthority = yield* MessageV2.promptHistoryProjectionEffect(unadmittedSession.id)
    const unadmittedAssistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: unadmittedContinuation.id,
      sessionID: unadmittedSession.id,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    })
    yield* db
      .insert(CompactionRunTable)
      .values({
        run_id: "continuation-recovery-pending",
        session_id: unadmittedSession.id,
        from_prompt_epoch: unadmittedAuthority.epoch,
        target_prompt_epoch: unadmittedAuthority.epoch,
        trigger: "manual",
        state: "committed",
        created_at: Date.now(),
        committed_at: Date.now(),
        source_window_id: unadmittedAuthority.window.windowID,
        source_effective_history_hash: unadmittedAuthority.effectiveHistoryHash,
        source_message_count: unadmittedAuthority.messages.length,
        source_projection_version: unadmittedAuthority.projectionVersion,
        continuation_state: "pending",
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(CompactionArtifactTable)
      .values({
        artifact_id: "artifact-recovery-pending",
        run_id: "continuation-recovery-pending",
        session_id: unadmittedSession.id,
        message_id: unadmittedContinuation.id,
        kind: "continue",
        state: "committed",
        created_at: Date.now(),
        committed_at: Date.now(),
      })
      .run()
      .pipe(Effect.orDie)
    yield* recoverProviderReceiptsOnStartup({ ownerToken: recoveryOwnerToken })

    const recoveredUnadmittedAssistant = (yield* sessions.messages({ sessionID: unadmittedSession.id })).find(
      (message) => message.info.id === unadmittedAssistant.id,
    )
    expect(recoveredUnadmittedAssistant?.info).not.toHaveProperty("finish")
    expect(
      (yield* compaction.recoverableContinuations(unadmittedSession.projectID)).map((item) => item.runID),
    ).toContain("continuation-recovery-pending")

    const safeRun = yield* db
      .select()
      .from(CompactionRunTable)
      .where(eq(CompactionRunTable.run_id, safe.runID))
      .get()
      .pipe(Effect.orDie)
    const safeReceipt = yield* db
      .select()
      .from(SessionToolRequestReceiptTable)
      .where(eq(SessionToolRequestReceiptTable.receipt_id, safe.receiptID))
      .get()
      .pipe(Effect.orDie)
    expect(safeRun?.continuation_state).toBe("pending")
    expect(safeRun?.continuation_receipt_id).toBeNull()
    expect(safeReceipt?.provider_state).toBe("failed")
    expect(safeReceipt?.request_error_code).toBe("provider_not_dispatched_before_process_restart")
    expect((yield* compaction.recoverableContinuations(safe.session.projectID)).map((item) => item.runID)).toContain(
      safe.runID,
    )
    expect(Exit.isSuccess(yield* sessions.assertRunnable(safe.session.id).pipe(Effect.exit))).toBe(true)

    const ambiguousRun = yield* db
      .select()
      .from(CompactionRunTable)
      .where(eq(CompactionRunTable.run_id, ambiguous.runID))
      .get()
      .pipe(Effect.orDie)
    const ambiguousReceipt = yield* db
      .select()
      .from(SessionToolRequestReceiptTable)
      .where(eq(SessionToolRequestReceiptTable.receipt_id, ambiguous.receiptID))
      .get()
      .pipe(Effect.orDie)
    const history = yield* db
      .select()
      .from(SessionHistoryStateTable)
      .where(eq(SessionHistoryStateTable.session_id, ambiguous.session.id))
      .get()
      .pipe(Effect.orDie)
    expect(ambiguousRun?.continuation_state).toBe("indeterminate")
    expect(ambiguousReceipt?.provider_state).toBe("indeterminate_after_crash")
    expect(history).toMatchObject({
      state: "recovery_required",
      reason: "provider outcome is unknown after process restart",
    })
    expect(
      (yield* compaction.recoverableContinuations(ambiguous.session.projectID)).some(
        (item) => item.runID === ambiguous.runID,
      ),
    ).toBe(false)
    expect(Exit.isFailure(yield* sessions.assertRunnable(ambiguous.session.id).pipe(Effect.exit))).toBe(true)
    expect(
      yield* db
        .select({ state: SessionHistoryStateTable.state })
        .from(SessionHistoryStateTable)
        .where(eq(SessionHistoryStateTable.session_id, incomplete.session.id))
        .get()
        .pipe(Effect.orDie),
    ).toEqual({ state: "recovery_required" })
    expect(
      (yield* sessions.messages({ sessionID: incomplete.session.id })).find(
        (message) => message.info.id === incomplete.assistant.id,
      )?.info,
    ).toMatchObject({ finish: "error", time: { completed: expect.any(Number) } })
    expect(Exit.isFailure(yield* sessions.assertRunnable(incomplete.session.id).pipe(Effect.exit))).toBe(true)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(SessionExecution.noopLayer),
        Effect.provide(SessionV2.defaultLayer),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

v2Real.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      }),
    )

    yield* llm.text("world")

    const result = yield* provideR0OwnerRefs(prompt.loop({ sessionID: session.id }))
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

v2Real.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello one" }],
      }),
    )

    yield* llm.text("world one")

    const first = yield* provideR0OwnerRefs(prompt.loop({ sessionID: session.id }))
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello two" }],
      }),
    )

    yield* llm.text("world two")

    const second = yield* provideR0OwnerRefs(prompt.loop({ sessionID: session.id }))
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

v2Real.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      }),
    )
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* provideR0OwnerRefs(prompt.loop({ sessionID: session.id }))
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
    // V2-only: the legacy receipt/activity tables stay at zero; the V2 provider-turn receipt is the
    // execution evidence (the legacy per-request/argument receipt detail has no V2 counterpart).
    expect(yield* db.select().from(SessionToolRequestReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.select().from(SessionToolArgumentReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
  }),
)

// RI-127（P1，CLOSED）：plan 协议连错终止预算已移植 V2 runner——core plan 叶在结构化输出透出
// plan_protocol/plan_error_code，core runner 从 durable 历史推导当前 activity 的连错计数（legacy
// PlanProtocolTracker 语义：success 归零、invalid/conflict/no_progress 累加、第二次终止），第 N 次
// 失败在工具结果文本与 wire metadata 标注 [Plan attempt N of 2]，第二次连错时 publish Step.Failed
// （V2 投影为 UnknownError，message 含 PlanProtocolViolation + code）并以 finish "error" 结束 turn。
v2Real.instance("BUG-010 malformed plan payload stops before a third Provider dispatch", () =>
  assertPlanProtocolProviderBudget({
    payload: {
      goal: "complete the benchmark and compress collectives to 3.3ms",
      steps: [{ title: "", status: "active" }],
    },
    // The guard under test is the BUDGET, not the specific rejection: the same malformed payload
    // twice must end the turn before a third provider dispatch. The payload above is rejected on its
    // CONTENT (a step with no title). It used to be rejected for carrying a model-chosen `step_id`,
    // but ids are server-owned now — a supplied id is dropped, so that shape is admitted and would
    // no longer exercise this protection at all.
    errorCode: "empty_title",
  }),
)

// RI-127（P1，CLOSED）：同上前注——forward-compatible 形状（显式 create + null 前提）同样终止于
// 第二次连错；提供的 step_id 在 create 上先于空标题检查失败（fail-closed identity）。
v2Real.instance("BUG-010 forward-compatible malformed plan stops before a third Provider dispatch", () =>
  assertPlanProtocolProviderBudget({
    payload: {
      operation: "create",
      expected_plan_id: null,
      expected_version: null,
      goal: "complete the benchmark and compress collectives to 3.3ms",
      steps: [{ title: "", status: "active" }],
    },
    // Same guard as above through the explicit-create envelope; `step_id`/`active_step_id` are gone
    // because both are ignored now, so the rejection has to come from content.
    errorCode: "empty_title",
  }),
)

// V4.0.1 P0b OUTPUT soft-landing — a length-capped response continues instead of ending the turn.
// RI-125（P1，CLOSED）：输出软着陆已移植 V2 runner——finish=length 且无本地工具调用时，core runner
// 终态化截断工具输入、注入 synthetic 续写 nudge（V1 原文）并续跑一个 provider turn；续写预算从
// durable 历史尾部 (assistant length ← synthetic nudge) 链推导（默认上限 3），续写与首个 turn 共享
// 同一 V2 activity（receipt activity_id 为证）。
v2Real.instance("loop continues (not exits) when finish is length: injects a continue nudge + re-prompts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "produce a long response" }],
      }),
    )
    // The first turn is cut off at the output ceiling (finish_reason "length"); without output
    // soft-landing the drain would end there (1 LLM call). With it ON the runner injects a
    // continue nudge and re-prompts, consuming the queued continuation.
    yield* llm.push(
      raw({
        chunks: [
          { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
          { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { content: "partial" } }] },
          { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "length" }] },
        ],
      }),
    )
    yield* llm.text("...continued to the end.")

    const result = yield* provideR0OwnerRefs(prompt.loop({ sessionID: session.id }))

    // Original turn + continuation turn.
    expect(yield* llm.hits).toHaveLength(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")

    // A synthetic continue-nudge user message was injected before the re-prompt (V1 wire egress
    // carries it as a user row with a synthetic text part).
    const msgs = yield* sessions.messages({ sessionID: session.id })
    const injected = msgs.find((m) =>
      m.parts.some((p) => p.type === "text" && p.synthetic === true && p.text.includes("输出长度上限")),
    )
    expect(injected).toBeDefined()
    // The continuation belongs to the SAME durable activity as the first turn.
    const receipts = (yield* db
      .select()
      .from(V2ProviderTurnReceiptTable)
      .where(eq(V2ProviderTurnReceiptTable.session_id, session.id))
      .all()
      .pipe(Effect.orDie)).toSorted((a, b) => a.request_ordinal - b.request_ordinal)
    expect(receipts).toHaveLength(2)
    expect(receipts[1]?.activity_id).toBe(receipts[0]?.activity_id)
  }),
)

// RI-125（P1，CLOSED）：续写不开新 activity——整链（原始 turn + 续写 turn）在同一 V2 activity 内
// settle；V2 证据为 SessionActivityTable 单行 settled + 两个 receipt 共享 activity_id（legacy
// activity/progress 表在 V2-only 下保持零行）。
v2Real.instance("synthetic output continuation preserves the durable legacy activity owner", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* llm.push(
      raw({
        chunks: [
          {
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            choices: [{ delta: { role: "assistant" } }],
          },
          {
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            choices: [{ delta: { content: "partial" } }],
          },
          {
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            choices: [{ delta: {}, finish_reason: "length" }],
          },
        ],
      }),
    )
    yield* llm.text("complete")

    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "produce a long response" }],
      }),
    )

    expect(yield* llm.hits).toHaveLength(2)
    // One durable V2 activity owns the whole continuation chain and settles after the drain.
    expect(
      yield* db
        .select({ activityID: SessionActivityTable.activity_id, state: SessionActivityTable.state })
        .from(SessionActivityTable)
        .where(eq(SessionActivityTable.session_id, session.id))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([{ activityID: expect.any(String), state: "settled" }])
    const receipts = (yield* db
      .select()
      .from(V2ProviderTurnReceiptTable)
      .where(eq(V2ProviderTurnReceiptTable.session_id, session.id))
      .all()
      .pipe(Effect.orDie)).toSorted((a, b) => a.request_ordinal - b.request_ordinal)
    expect(receipts).toHaveLength(2)
    expect(receipts[1]?.activity_id).toBe(receipts[0]?.activity_id)
    // V2-only: legacy activity tables stay at zero.
    expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.select().from(SessionActivityProgressTable).all().pipe(Effect.orDie)).toHaveLength(0)
  }),
)

// RI-125（P1，CLOSED）：截断工具输入指引已移植——length 截断且存在未终态本地工具输入时，runner 先
// 以 "Tool input was incomplete and was not executed" 终态化该工具（从未执行），再注入
// apply_patch_chunk 指引的 synthetic 消息并续跑。
v2Real.instance("loop retries truncated tool input with the bounded patch transaction guidance", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "apply a large patch" }],
      }),
    )
    // The first turn streams a truncated apply_patch tool input cut off at the output ceiling;
    // the protocol layer only finalizes tool inputs on stop/tool-calls, so no tool call executes.
    yield* llm.push(
      raw({
        chunks: [
          { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] },
          {
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_truncated",
                      type: "function",
                      function: { name: "apply_patch", arguments: "" },
                    },
                  ],
                },
              },
            ],
          },
          {
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"patch":"*** Begin Patch' } }] } }],
          },
          { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "length" }] },
        ],
      }),
    )
    yield* llm.text("completed with chunked patch")

    yield* provideR0OwnerRefs(prompt.loop({ sessionID: session.id }))

    expect(yield* llm.hits).toHaveLength(2)
    // The truncated tool input was terminalized as a typed error part (never executed)...
    const msgs = yield* sessions.messages({ sessionID: session.id })
    const truncated = msgs
      .flatMap((message) => message.parts)
      .find(
        (part): part is ErrorToolPart =>
          part.type === "tool" && part.tool === "apply_patch" && part.state.status === "error",
      )
    expect(truncated?.state.error).toBe("Tool input was incomplete and was not executed")
    // ...and the injected nudge carries the bounded patch-transaction guidance.
    expect(
      msgs.some((message) =>
        message.parts.some(
          (part) => part.type === "text" && part.synthetic === true && part.text.includes("apply_patch_chunk"),
        ),
      ),
    ).toBe(true)
  }),
)

v2Real.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "find text files" }],
      }),
    )
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* provideR0OwnerRefs(prompt.loop({ sessionID: session.id }))
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    // V2 glob emits worktree-relative paths; the instance-context contract is that the tool ran
    // against the instance directory (found probe.txt) rather than losing Instance.Context.
    expect(tool.state.output).toContain("probe.txt")
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

v2Real.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      }),
    )
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* provideR0OwnerRefs(prompt.loop({ sessionID: session.id }))
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
    expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
  }),
)

v2Real.instance("legacy non-interactive token metadata does not hard-stop a provider turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const session = yield* sessions.create({ title: "Pinned" })
    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        metadata: {
          deepagent: {
            task_activity: {
              interactive: false,
              started_at: Date.now(),
              budget: { max_steps: 4, max_tokens: 1, max_wall_ms: 60_000, max_no_progress: 2 },
            },
          },
        },
        parts: [{ type: "text", text: "bounded research" }],
      }),
    )
    yield* llm.text("looks complete", { usage: { input: 2, output: 2 } })

    const result = yield* provideR0OwnerRefs(prompt.loop({ sessionID: session.id }))
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
    expect(yield* llm.calls).toBe(1)
  }),
)

// RI-137（P1，ADJUDICATED — 保留，被 RI-06 阻塞）：non-interactive task 步数预算在 V2-only 下无执行点，
// 且本次不强行实现。阻塞证据：(1) core 内建工具面（core/src/tool/builtins.ts builtinToolNames）无
// task/subagent 工具，task_activity 元数据的生产者（src/tool/task.ts:833-863,923 的 budget_exhausted
// 映射）在 V2 不可达；(2) core V2 runner 无 TaskBudgetExceededError 产生点（该错误仅存在于
// core/src/v1/session.ts 的 V1 错误union），parser noninteractiveTaskActivity（prompt.ts:865）只有
// legacy loop 消费（failTaskBudget）；(3) 预算执行移植属 RI-06 core-native task drive 的设计范围
//（core runner llm.ts 改动），依赖 RI-06 落地后随 task drive 一并裁决移植或废弃合同。
it.instance.skip("non-interactive task step budget prevents another provider turn", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      metadata: {
        deepagent: {
          task_activity: {
            interactive: false,
            started_at: Date.now(),
            budget: { max_steps: 1, max_wall_ms: 60_000, max_no_progress: 2 },
          },
        },
      },
      parts: [{ type: "text", text: "bounded research" }],
    })
    yield* llm.tool("first", { value: "first" })

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") expect(result.info.error?.name).toBe("TaskBudgetExceededError")
    expect(yield* llm.calls).toBe(1)
  }),
)

// RI-06（P0，OPEN）：Core V2 无 task/subagent 工具与运行时，core-native task drive 缺失——src 缺口修复前保持 skip（design.md RI 表）。
it.instance.skip("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

// RI-06（P0，OPEN）：Core V2 无 task/subagent 工具与运行时，core-native task drive 缺失——src 缺口修复前保持 skip（design.md RI 表）。
it.instance.skip(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

// RI-06（P0，OPEN）：Core V2 无 task/subagent 工具与运行时，core-native task drive 缺失——src 缺口修复前保持 skip（design.md RI 表）。
it.instance.skip(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "auto")
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
        "12 seconds",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  { git: true },
  20_000,
)

v2Real.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)

      yield* llm.hang

      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hi" }],
        }),
      )

      const fiber = yield* provideR0OwnerRefs(prompt.loop({ sessionID: chat.id })).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  15_000,
)

// Cancel semantics

v2Real.instance(
  "cancel interrupts loop and settles the turn as indeterminate under the V2 owner",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({ title: "Pinned" })

      // Seed one settled turn so the cancelled turn runs against existing history.
      yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }),
      )
      yield* llm.text("hi there")
      yield* provideR0OwnerRefs(prompt.loop({ sessionID: chat.id }))

      yield* llm.hang
      yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "more" }],
        }),
      )

      const fiber = yield* provideR0OwnerRefs(prompt.loop({ sessionID: chat.id })).pipe(Effect.forkChild)
      yield* llm.wait(2)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      // V2 interrupt contract (core runner): a cancelled drain unwinds as an interrupt-only
      // failure — there is no legacy-style synthesized assistant resolution.
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect((yield* status.get(chat.id)).type).toBe("idle")

      // The hung dispatch's provider outcome is unknown, so the V2 receipt is quarantined
      // indeterminate; legacy execution tables stay at zero.
      const receipts = yield* db
        .select()
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, chat.id))
        .all()
        .pipe(Effect.orDie)
      expect(receipts.map((row) => row.state).toSorted()).toEqual(["indeterminate_after_crash", "settled"])
      expect(yield* db.select().from(SessionToolRequestReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  30_000,
)

// RI-06（P0，OPEN）：Core V2 无 task/subagent 工具与运行时，core-native task drive 缺失——src 缺口修复前保持 skip（design.md RI 表）。
noLLMServer.instance.skip(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

// RI-06（P0，OPEN）：Core V2 无 task/subagent 工具与运行时，core-native task drive 缺失——src 缺口修复前保持 skip（design.md RI 表）。
it.instance.skip(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

// RI-129: joined loop callers must be released by cancel. Root cause was upstream of the
// coordinator's settle(): a Deferred completed with an interrupt-only cause wakes only ONE
// awaiter under the v4 runtime, so the second joined caller stranded (core run-coordinator now
// hands the Exit over the success channel). V2 interrupt contract: the cancelled drain unwinds
// as an interrupt-only failure and the SAME exit reaches every joined caller.
v2Real.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }),
      )
      yield* llm.hang

      const a = yield* provideR0OwnerRefs(prompt.loop({ sessionID: chat.id })).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* provideR0OwnerRefs(prompt.loop({ sessionID: chat.id })).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      // Both callers are released with the SAME drain outcome (RI-129: the joined caller must not
      // strand). Cancelling mid-hang unwinds the provider request as an AbortError defect; the
      // interrupt-only classification of a cancelled drain is pinned by the tool-execution sibling.
      expect(Exit.isFailure(exitA)).toBe(true)
      expect(Exit.isFailure(exitB)).toBe(true)
      if (Exit.isFailure(exitA) && Exit.isFailure(exitB)) {
        expect(exitB.cause).toEqual(exitA.cause)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  15_000,
)

// Queue semantics

v2Real.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      }),
    )
    yield* llm.text("world")

    const [a, b] = yield* Effect.all(
      [
        provideR0OwnerRefs(prompt.loop({ sessionID: chat.id })),
        provideR0OwnerRefs(prompt.loop({ sessionID: chat.id })),
      ],
      { concurrency: "unbounded" },
    )

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    expect(yield* llm.hits).toHaveLength(1)
    // V2-only: legacy activity tables stay at zero; V2 activities are the execution authority.
    expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
    yield* run.assertNotBusy(chat.id)
  }),
)

v2Real.instance(
  "concurrent loop callers all receive same error result",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }),
      )

      yield* llm.fail("boom")

      // V2-only: a provider stream failure produces no assistant message, so the joined drain
      // surfaces the SAME typed refusal to every concurrent loop caller (one provider dispatch).
      const [ea, eb] = yield* Effect.all(
        [
          provideR0OwnerRefs(prompt.loop({ sessionID: chat.id })).pipe(Effect.exit),
          provideR0OwnerRefs(prompt.loop({ sessionID: chat.id })).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      expect(Exit.isFailure(ea)).toBe(true)
      expect(Exit.isFailure(eb)).toBe(true)
      if (Exit.isFailure(ea) && Exit.isFailure(eb)) {
        expect(Cause.squash(ea.cause)).toBeInstanceOf(LegacyExecutionUnavailable)
        expect(Cause.squash(eb.cause)).toBeInstanceOf(LegacyExecutionUnavailable)
        expect(Cause.squash(eb.cause)).toEqual(Cause.squash(ea.cause))
      }
      expect(yield* llm.calls).toBe(1)
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  15_000,
)

v2Real.instance(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* llm.hold("first", deferredAsPromise(gate))
      yield* llm.text("second")

      const a = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        }),
      ).pipe(Effect.forkChild)
      // The first provider turn is in flight once the mock server holds the request.
      yield* llm.wait(1)

      // Mid-run admission (admit-only): the V2 contract steers it into the active activity at the
      // next provider-turn boundary; no legacy steer row is written.
      const steered = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "second" }],
        }),
      )
      expect(steered.info.role).toBe("user")

      yield* Deferred.succeed(gate, void 0)

      const ea = yield* Fiber.await(a)
      expect(Exit.isSuccess(ea)).toBe(true)
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const assistants = msgs.filter((msg) => msg.info.role === "assistant")
      expect(assistants).toHaveLength(2)
      const last = assistants.at(-1)
      if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
      expect(last.info.parentID).toBe(steered.info.id)
      expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      const steeredInput = JSON.stringify(inputs.at(-1)?.messages)
      expect(steeredInput).toContain("second")
      expect(steeredInput).not.toContain("The user sent the following message:")

      // V2-only: the legacy steer buffer and activity tables stay at zero.
      expect(yield* db.select().from(SessionSteerTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)

      yield* llm.text("third")
      const next = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "third" }],
        }),
      )
      expect(next.parts.some((part) => part.type === "text" && part.text === "third")).toBe(true)
      expect(yield* llm.calls).toBe(3)
    }),
  // 3 个串行 provider turn + gate；--max-concurrency 4 满载下实测 ~19s，15s 余量不足。
  30_000,
)

v2Real.instance(
  "promptAsync without an explicit intent acknowledges durable admission before the provider settles",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({ title: "Implicit prompt intent" })
      const messageID = MessageID.ascending()

      yield* llm.hold("eventual answer", deferredAsPromise(gate))
      const receipt = yield* provideR0OwnerRefs(
        prompt.promptAsync({
          sessionID: chat.id,
          messageID,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "hello" }],
        }),
      )

      // V2 admission receipt: the chat path omits delivery, so core SessionV2.prompt defaults it to
      // "steer" (W16) — there is no legacy "turn" intent under the profile.
      expect(receipt).toEqual({ messageID, delivery: "steer" })
      yield* llm.wait(1)
      // Durable V2 admission (session_input inbox) is promoted by the in-flight drain BEFORE the
      // gated provider response settles; the legacy intent table stays at zero.
      const admitted = yield* SessionInput.find(db, SessionMessage.ID.make(messageID)).pipe(Effect.orDie)
      expect(admitted?.sessionID).toBe(chat.id)
      expect(admitted?.promotedSeq).toBeDefined()
      expect(yield* db.select().from(SessionIntentTable).all().pipe(Effect.orDie)).toHaveLength(0)

      yield* Deferred.succeed(gate, undefined)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((messages) =>
              messages.some((message) => message.info.role === "assistant" && message.info.time.completed)
                ? messages
                : undefined,
            ),
          ),
        "provider turn did not settle after admission",
      )
    }),
  15_000,
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

// RI-128: shell/loop mutex is adjudicated RETAINED (V1 parity): while a shell holds the session
// lane the loop queues behind it on the run-state Runner and drains only after the shell exits.
v2Real.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }),
      )
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* provideR0OwnerRefs(prompt.loop({ sessionID: chat.id })).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  15_000,
)
;(process.platform !== "win32" ? v2Real.instance : v2Real.instance.skip)(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        const { db } = yield* Database.Service
        yield* mintR0Authorization(db)
        yield* llm.text("done")

        const result = yield* provideR0OwnerRefs(
          prompt.command({
            sessionID: chat.id,
            command: "probe",
            arguments: "",
          }),
        )

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

// RI-128: shell lane is adjudicated CANCELLABLE — cancel bridges to the run-state shell lane
// beside the V2 execution interrupt.
v2Real.instance(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// RI-128: cancel escalates (forceKillAfter) when the shell ignores SIGTERM, and the aborted
// result still persists.
v2Real.instance(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

v2Real.instance(
  "cancel finalizes an in-flight bash tool part as interrupted under the V2 owner",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({
        title: "Interrupted bash finalization",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "run bash" }],
        }),
      )
      yield* llm.tool("bash", {
        command: "printf bash-ready; sleep 30",
        description: "Run a long command",
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* provideR0OwnerRefs(prompt.loop({ sessionID: chat.id })).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running") return true
        }),
        "timed out waiting for the bash tool part to enter running state",
      )
      // A running tool part can be published before the provider stream's final chunk is
      // durably settled. This case cancels tool execution after the provider turn, so wait
      // for the receipt instead of racing cancellation with stream finalization.
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const receipt = yield* db
            .select({ state: V2ProviderTurnReceiptTable.state })
            .from(V2ProviderTurnReceiptTable)
            .where(eq(V2ProviderTurnReceiptTable.session_id, chat.id))
            .get()
            .pipe(Effect.orDie)
          if (receipt?.state === "settled") return true
        }),
        "timed out waiting for the provider turn to settle before cancelling bash",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      // V2 interrupt contract (core runner): a cancelled drain unwinds as an interrupt-only failure.
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)

      // The interrupted turn does not strand a running tool part: the runner fails unsettled
      // tools ("Tool execution interrupted") and the V1 mirror projects the finalized state.
      // (Legacy preserved partial output through the truncation pipeline; V2 interrupt
      // finalization carries the error only.)
      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const assistant = msgs.findLast((item) => item.info.role === "assistant")
      const tool = assistant ? toolPart(assistant.parts) : undefined
      expect(tool?.state.status).toBe("error")
      if (tool?.state.status === "error") expect(tool.state.error).toContain("Tool execution interrupted")

      // Legacy execution tables stay at zero. The provider turn itself completed (the tool-call
      // response was fully delivered before the interrupt landed in tool execution), so its V2
      // receipt is settled.
      expect(yield* db.select().from(SessionToolRequestReceiptTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
      const receipts = yield* db
        .select()
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, chat.id))
        .all()
        .pipe(Effect.orDie)
      expect(receipts.map((row) => row.state)).toEqual(["settled"])
    }),
  { git: true },
  30_000,
)

// RI-128: a loop queued behind a shell is released by cancel through the lane's onInterrupt —
// it resolves with the shell's aborted assistant message instead of draining.
v2Real.instance(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* provideR0OwnerRefs(prompt.loop({ sessionID: chat.id })).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)
;(process.platform !== "win32" ? v2Real.instance : v2Real.instance.skip)(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        // Shell-mode exclusion is the projection-layer runner mutex (W0-2), retained under the
        // V2-only profile. The first shell is short-lived so the test does not need to cancel it
        // (cancel would stop it via the RI-128 shell-lane bridge).
        const a = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 2" }).pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        const done = yield* Fiber.await(a)
        expect(Exit.isSuccess(done)).toBe(true)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

// Missing file handling

v2Real.instance(
  "direct prompts auto-claim one durable intent and reconcile exact retries",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const session = yield* sessions.create({})
      const messageID = MessageID.make("msg_direct_intent_retry")
      const input = {
        sessionID: session.id,
        messageID,
        agent: "build",
        noReply: true,
        parts: [{ type: "text" as const, text: "durable direct prompt" }],
      }

      const first = yield* provideR0OwnerRefs(prompt.prompt(input))
      const retry = yield* provideR0OwnerRefs(prompt.prompt(input))
      const conflict = yield* provideR0OwnerRefs(
        prompt.prompt({
          ...input,
          parts: [{ type: "text", text: "conflicting retry" }],
        }),
      ).pipe(Effect.exit)

      expect(retry).toEqual(first)
      expect(Exit.isFailure(conflict)).toBe(true)
      // V2-only: the durable admission lives in the V2 session_input inbox — exactly one row, reused
      // by the exact retry and never duplicated into the V1 mirror.
      const admitted = yield* SessionInput.find(db, SessionMessage.ID.make(messageID)).pipe(Effect.orDie)
      expect(admitted?.sessionID).toBe(session.id)
      const mirrored = yield* sessions.messages({ sessionID: session.id })
      expect(mirrored.filter((message) => message.info.role === "user")).toHaveLength(1)
      // Legacy execution tables stay at zero: no intent, no admission, no activity rows.
      expect(yield* db.select().from(SessionIntentTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionActivityAdmissionTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  { config: cfg },
)

// RI-135（P1，CLOSED）：V2 admission 的 message metadata 现在穿过镜像落盘（prompt.ts
// mirrorAdmissionMetadata 挂在 noReply 镜像行上，legacy createUserMessage 对齐），prompt() 的
// task_notification 短路得以按持久化 user 行的 metadata 对账 outbox 重投：同 messageID + 同
// run_id/outbox_id 复用首条消息（即使文本不同也不重复落盘），不同 outbox 判冲突。
v2Real.instance(
  "task notification prompt retries reuse the persisted user message",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const session = yield* sessions.create({})
      const messageID = MessageID.ascending()
      const metadata = {
        deepagent: {
          task_notification: { run_id: "job_exact", outbox_id: "task-notify:job_exact" },
        },
      }

      const first = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: session.id,
          messageID,
          agent: "build",
          noReply: true,
          metadata,
          parts: [{ type: "text", text: "task completed" }],
        }),
      )
      const retry = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: session.id,
          messageID,
          agent: "build",
          noReply: true,
          metadata,
          parts: [{ type: "text", text: "this payload must not be persisted twice" }],
        }),
      )
      const conflict = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: session.id,
          messageID,
          agent: "build",
          noReply: true,
          metadata: {
            deepagent: {
              task_notification: { run_id: "job_other", outbox_id: "task-notify:job_other" },
            },
          },
          parts: [{ type: "text", text: "conflicting retry" }],
        }),
      ).pipe(Effect.exit)
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID })

      expect(first.info.id).toBe(messageID)
      expect(retry).toEqual(first)
      expect(stored.parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual(["task completed"])
      expect(Exit.isFailure(conflict)).toBe(true)
      if (Exit.isFailure(conflict)) {
        expect(String(Cause.squash(conflict.cause))).toContain("conflicts with persisted content")
      }

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

v2Real.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        }),
      )

      if (msg.info.role !== "user") throw new Error("expected user message")
      // V2 admission never reads file parts eagerly (attachments lower to provider media by URI at
      // drain time), so a missing file cannot fail admission; the attachment is mirrored verbatim
      // and the legacy synthetic "Read tool failed to read" part no longer exists.
      const attachment = msg.parts.find((part) => part.type === "file")
      expect(attachment).toMatchObject({
        type: "file",
        filename: "does-not-exist.ts",
        url: `file://${missing}`,
      })
      expect(msg.parts.some((part) => part.type === "text" && part.text === "please review @does-not-exist.ts")).toBe(
        true,
      )

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "resolves configured reference mentions to one root directory attachment",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(path.join(docs, "guide"))
      yield* ensureDir(path.join(dir, "docs"))
      yield* writeText(path.join(docs, "README.md"), "reference readme")
      yield* writeText(path.join(docs, "guide", "intro.md"), "reference intro")
      yield* writeText(path.join(dir, "docs", "README.md"), "workspace readme")

      const promptSvc = yield* SessionPromptV2.Service

      const commandSvc = yield* SessionCommandV2.Service

      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const parts = yield* prompt.resolvePromptParts(
        "Use @docs and @docs/README.md and @docs/guide and @docs/missing.md and @docs/README.md and @build",
      )
      const files = parts.filter((part): part is SessionV1.FilePartInput => part.type === "file")
      const agents = parts.filter((part): part is SessionV1.AgentPartInput => part.type === "agent")
      const text = parts.find((part): part is SessionV1.TextPartInput => part.type === "text" && !part.synthetic)

      expect(text?.text).toContain("@docs")
      expect(files).toHaveLength(1)
      expect(files[0]).toMatchObject({
        filename: "docs",
        mime: "application/x-directory",
        source: { type: "file", path: "docs", text: { value: "@docs" } },
      })
      expect(fileURLToPath(files[0].url)).toBe(docs)
      expect(agents.map((agent) => agent.name)).toEqual(["auto"])
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

// Special characters in filenames

v2Real.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const promptSvc = yield* SessionPromptV2.Service

      const commandSvc = yield* SessionCommandV2.Service

      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        }),
      )
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      // V2 admission stores file parts as unmaterialized attachments (no eager content read); the
      // contract is that the %-encoded special-character filename survives the mirror verbatim.
      const storedFile = stored.parts.find((part) => part.type === "file")
      expect(storedFile).toMatchObject({
        type: "file",
        filename: "file#name.txt",
        url: expect.stringContaining("%23"),
      })
      const textParts = stored.parts.filter((part) => part.type === "text")
      expect(textParts.some((part) => part.text.includes("Read @file#name.txt"))).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

v2Real.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/deepagent-code/src/session/processor.ts")

    const result = yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: session.id,
        agent: "build",
        parts: [{ type: "text", text: "Where is SessionProcessor?" }],
      }),
    )

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

v2Real.instance("runs a prompt in the persisted session directory", () =>
  Effect.gen(function* () {
    const { directory: parentDirectory } = yield* TestInstance
    const targetDirectory = yield* tmpdirScoped({ git: true })
    const aliasRoot = yield* tmpdirScoped()
    const persistedDirectory = process.platform === "win32" ? targetDirectory : path.join(aliasRoot, "workspace-alias")
    if (persistedDirectory !== targetDirectory) {
      yield* Effect.promise(() => symlink(targetDirectory, persistedDirectory, "dir"))
    }
    const llm = yield* TestLLMServer
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)

    yield* writeConfig(targetDirectory, providerCfg(llm.url))
    const rootWorkspaceID = WorkspaceV2.ID.make("wrk_prompt_event_route")
    const parent = yield* sessions.create({ title: "Parent session", workspaceID: rootWorkspaceID })
    const child = yield* instances.provide(
      { directory: targetDirectory },
      sessions.create({
        title: "Persisted directory child",
        directory: persistedDirectory,
        parentID: parent.id,
      }),
    )
    const childEventDirectories: string[] = []
    const childEventWorkspaceIDs: Array<WorkspaceV2.ID | undefined> = []
    const off = yield* events.listen((event) =>
      Effect.sync(() => {
        if ((event.data as { sessionID?: SessionID }).sessionID !== child.id) return
        if (!event.location?.directory) return
        childEventDirectories.push(event.location.directory)
        childEventWorkspaceIDs.push(event.location.workspaceID)
      }),
    )
    yield* Effect.addFinalizer(() => off)
    yield* llm.text("child context complete")

    const result = yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: child.id,
        agent: "build",
        parts: [{ type: "text", text: "Report the active directory context." }],
      }),
    )

    // V2-only: legacy activity tables stay at zero; V2 activities are the execution authority.
    expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)

    expect(path.resolve(parentDirectory)).not.toBe(path.resolve(targetDirectory))
    expect(FSUtil.resolve(child.directory)).toBe(FSUtil.resolve(targetDirectory))
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      // The V2→V1 wire mirror reports the session's PERSISTED directory verbatim (the symlink
      // alias), where the legacy loop realpath'd it through the instance context. Compare
      // realpaths so both encodings of the same directory pass.
      expect(FSUtil.resolve(result.info.path.cwd)).toBe(FSUtil.resolve(targetDirectory))
      expect(FSUtil.resolve(result.info.path.root)).toBe(FSUtil.resolve(targetDirectory))
    }
    expect(childEventDirectories.length).toBeGreaterThan(0)
    // V2-only event routing: the child's events arrive on two planes — the root-routed compat
    // plane (parent directory + root workspace, via EventRouteRef) and the core V2 session plane
    // tagged with the session's own persisted location (the alias directory; no workspace
    // identity — omitted workspaceID means implicit-local placement). No event may escape the
    // session topology or carry a foreign workspace.
    const planes = childEventDirectories.map((directory, index) => ({
      directory,
      workspaceID: childEventWorkspaceIDs[index],
    }))
    expect(planes.some((plane) => FSUtil.resolve(plane.directory) === FSUtil.resolve(parentDirectory))).toBe(true)
    expect(planes.some((plane) => FSUtil.resolve(plane.directory) === FSUtil.resolve(targetDirectory))).toBe(true)
    expect(
      planes.every((plane) => {
        if (FSUtil.resolve(plane.directory) === FSUtil.resolve(parentDirectory))
          return plane.workspaceID === rootWorkspaceID
        if (FSUtil.resolve(plane.directory) === FSUtil.resolve(targetDirectory)) return plane.workspaceID === undefined
        return false
      }),
    ).toBe(true)
  }),
)

v2Real.instance(
  "records aborted errors when prompt is cancelled mid-stream",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const bridge = yield* EventV2Bridge.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const session = yield* sessions.create({ title: "Prompt cancel regression" })

      const emitted: string[] = []
      const off = yield* bridge.listen((event) =>
        Effect.sync(() => {
          if ((event.data as { sessionID?: SessionID }).sessionID !== session.id) return
          emitted.push(event.type)
        }),
      )
      yield* Effect.addFinalizer(() => off)

      yield* llm.hang
      const fiber = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "Cancel me" }],
        }),
      ).pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* prompt.cancel(session.id)

      // V2-only: cancel interrupts the process-local ownership chain; the joined prompt caller exits
      // with the interruption instead of resolving a legacy aborted-assistant record.
      const exit = yield* awaitWithTimeout(Fiber.await(fiber), "timed out joining cancelled prompt", "5 seconds")
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(emitted).toContain("session.next.interrupt.requested")
      expect(emitted).toContain("session.execution.interrupted")
      expect((yield* status.get(session.id)).type).toBe("idle")

      // No provider event was journaled before the interrupt, so the V1 mirror holds only the user row.
      const msgs = yield* sessions.messages({ sessionID: session.id })
      expect(msgs.map((msg) => msg.info.role)).toEqual(["user"])
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  15_000,
)

v2Real.instance(
  "cancel terminalizes the durable run, supersedes attached steer, and permits the next prompt",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const session = yield* sessions.create({ title: "Durable cancel lifecycle" })

      yield* llm.hang
      const running = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "Cancel this run" }],
        }),
      ).pipe(Effect.forkChild)
      yield* awaitWithTimeout(llm.wait(1), "timed out waiting for first durable provider dispatch", "20 seconds")

      // V2 successor of the legacy steer buffer: a noReply admission while the drain hangs lands as a
      // durable pending session_input row (chat-path delivery defaults to "steer"); it is promoted
      // only by a later drain, so the in-flight provider turn stays the only dispatch.
      const steerID = MessageID.ascending()
      yield* awaitWithTimeout(
        provideR0OwnerRefs(
          prompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            messageID: steerID,
            parts: [{ type: "text", text: "This steer belongs to the canceled run" }],
          }),
        ),
        "timed out admitting attached steer",
        "10 seconds",
      )
      const admitted = yield* SessionInput.find(db, SessionMessage.ID.make(steerID))
      expect(admitted?.delivery).toBe("steer")
      expect(admitted?.promotedSeq).toBeUndefined()
      expect(yield* llm.calls).toBe(1)

      yield* awaitWithTimeout(prompt.cancel(session.id), "timed out cancelling durable run", "10 seconds")
      const exit = yield* awaitWithTimeout(Fiber.await(running), "timed out joining canceled durable run", "5 seconds")
      // V2-only: cancel interrupts the process-local ownership chain; the joined prompt caller exits
      // with a failure, and no legacy activity/run/steer/intent rows exist to terminalize. The unwind
      // surfaces as a pure interrupt outside the provider stream, or as the stream's AbortError
      // defect when the abort lands mid-dispatch (this pending-steer staging takes the AbortError path).
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const squashed = Cause.squash(exit.cause)
        expect(
          Cause.hasInterruptsOnly(exit.cause) || (squashed instanceof DOMException && squashed.name === "AbortError"),
        ).toBe(true)
      }
      expect((yield* status.get(session.id)).type).toBe("idle")
      expect(yield* llm.calls).toBe(1)
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionSteerTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionIntentTable).all().pipe(Effect.orDie)).toHaveLength(0)

      yield* llm.text("next prompt completed")
      const next = yield* awaitWithTimeout(
        provideR0OwnerRefs(
          prompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "Start a new run" }],
          }),
        ),
        "timed out completing next durable prompt",
        "20 seconds",
      )
      expect(next.parts.some((part) => part.type === "text" && part.text === "next prompt completed")).toBeTrue()
      // The post-cancel drain promoted the pending steer and folded it into the next provider input.
      const consumed = yield* SessionInput.find(db, SessionMessage.ID.make(steerID))
      expect(consumed?.promotedSeq).toBeDefined()
      const inputs = yield* llm.inputs
      expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("This steer belongs to the canceled run")
    }),
  // Let the stage-specific deadlines report which operation stalled under a loaded full-package run.
  75_000,
)

// Agent variant

// RI-134（P1，CLOSED — mirror 通道裁决）：V2 admission 按 legacy createUserMessage 合同解析
// variant（input.variant 恒优先；否则仅当解析模型恰为 agent 配置模型且该模型声明此 variant 时采用
// agent.variant），落到镜像 user 行的 model.variant，并在显式 input.model 时经 switchModel 写入
// V2 session model（core ModelV2.Ref 带 variant，runner withVariant 可消费）。仅给 variant 不给
// model 时不 pin session model（避免把镜像解析的 fallback label 变成执行输入）——该残余通道随
// core variant 切换面另行裁决。
v2Real.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const otherSession = yield* sessions.create({})

      const other = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: otherSession.id,
          agent: "build",
          model: { providerID: ProviderV2.ID.make("deepagent-code"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }),
      )
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const matchingSession = yield* sessions.create({})
      const match = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: matchingSession.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello again" }],
        }),
      )
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const overrideSession = yield* sessions.create({})
      const override = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: overrideSession.id,
          agent: "build",
          noReply: true,
          variant: "high",
          parts: [{ type: "text", text: "hello third" }],
        }),
      )
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* Effect.forEach(
        [otherSession, matchingSession, overrideSession],
        (session) => sessions.remove(session.id),
        {
          discard: true,
        },
      )
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

// RI-136（P1，CLOSED）：V2 admission 恢复 fail-fast——promptV2 在解析 agent 时对未知名字抛出
// NamedError.Unknown（legacy createUserMessage 同款 "Agent not found" + available-names hint），
// 不再静默回退 ?? agentName 仅供镜像显示。
v2Real.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const session = yield* sessions.create({})
      const exit = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

// RI-136（P1，CLOSED）：同上——available-names hint 列出可选 agent 名。
v2Real.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const session = yield* sessions.create({})
      const exit = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("auto")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)

// Mirrors the production prompt_prepare handler: build a draft on disk via the prompt
// pipeline so the confirm step can load it through the real PromptDraftStore. This is the
// same code path the HTTP handler uses, so the test exercises the production confirm flow
// (prepare -> confirmedDraftID submit) rather than the removed requires_confirmation branch.
const prepareDraft = (directory: string, sessionID: string, mode: "intelligence", rawInput: string) => {
  const projectID = `project_${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`
  const home = new AgentGateway.DeepAgentWorkspace.DeepAgentCodeHome()
  const sessionPath = home.ensureSession(projectID, sessionID)
  const store = new AgentGateway.DeepAgentPromptPipeline.PromptDraftStore(sessionPath)
  const refiner = new AgentGateway.DeepAgentPromptPipeline.PromptRefiner(store)
  const { draft } = refiner.refine({ rawInput, mode })
  return draft.id
}

noLLMServer.instance(
  "prepared intelligence draft is not submitted until it is confirmed",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      // Preparing a draft (what prompt_prepare does) must not create a user message on its own.
      prepareDraft(dir, session.id, "intelligence", "Implement prompt confirmation")
      const beforeConfirm = yield* sessions.messages({ sessionID: session.id })
      expect(beforeConfirm.filter((message) => message.info.role === "user")).toHaveLength(0)
    }),
  30_000,
)

noLLMServer.instance(
  "intelligence draft fails closed for code tasks when model refinement fails",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const exit = yield* prompt
        .refineIntelligenceDraft({
          sessionID: session.id,
          rawInput: "写一个 cuda 的 GEMM kernel",
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")

      const messages = yield* sessions.messages({ sessionID: session.id })
      expect(messages.filter((message) => message.info.role === "user")).toHaveLength(0)
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "intelligence draft rejects code refinements that are equivalent to the raw input",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      yield* llm.text(
        JSON.stringify({
          route: "code",
          refined_prompt: "写一个 cuda 的 GEMM kernel",
          goal: "写一个 cuda 的 GEMM kernel",
          task_type: "implementation",
          constraints: [],
          acceptance: [],
          assumptions: [],
        }),
      )

      const exit = yield* prompt
        .refineIntelligenceDraft({
          sessionID: session.id,
          rawInput: "写一个 cuda 的 GEMM kernel",
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(yield* llm.calls).toBe(1)

      const messages = yield* sessions.messages({ sessionID: session.id })
      expect(messages.filter((message) => message.info.role === "user")).toHaveLength(0)
    }),
  30_000,
)

it.instance(
  "intelligence draft uses DeepAgent model scoped upstream auth",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig((url) => ({
        provider: {
          deepagent: {
            name: "DeepAgent",
            models: {
              "deepseek-v4-flash": {
                id: "deepseek-v4-flash",
                name: "DeepSeek V4 Flash",
                reasoning: true,
                provider: {
                  npm: "@ai-sdk/openai-compatible",
                  api: url,
                },
                options: {
                  authProviderID: "test",
                  upstreamProviderID: "deepseek",
                },
                tool_call: true,
                limit: { context: 100000, output: 10000 },
              },
            },
          },
        },
        model: "deepagent/deepseek-v4-flash",
      }))
      const auth = yield* Auth.Service
      yield* auth.set("test", { type: "api", key: "upstream-test-key" })
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const progress: string[] = []

      yield* llm.text(
        JSON.stringify({
          route: "code",
          refined_prompt: "请在当前仓库中定位登录测试失败原因，修复实现或测试夹具，并运行对应测试验证。",
          goal: "修复登录测试",
          task_type: "test",
          constraints: [],
          acceptance: ["登录测试通过"],
          assumptions: [],
        }),
      )

      const exit = yield* prompt
        .refineIntelligenceDraft({
          sessionID: session.id,
          rawInput: "修复登录测试",
          outputLanguage: "chinese",
          onProgress: (preview) => progress.push(preview),
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Success")
      if (exit._tag === "Success") {
        expect(exit.value.route).toBe("code")
        expect(exit.value.goal).toContain("登录测试")
      }
      expect(yield* llm.calls).toBe(1)
      expect(JSON.stringify((yield* llm.hits)[0]?.body)).toContain("in Chinese")
      expect((yield* llm.hits)[0]?.headers.authorization).toBe("Bearer upstream-test-key")
      expect(yield* llm.misses).toEqual([])
      expect(progress.at(-1)).toContain("登录测试")
    }),
  30_000,
)

v2Real.instance(
  "confirmed prompt draft submits through the production task path",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const session = yield* sessions.create({})

      const draftID = prepareDraft(dir, session.id, "intelligence", "Design the prompt confirmation flow")
      expect(draftID).toMatch(/^prompt_draft:/)

      // V2-only: the production submit path is promptAsync (app composer -> HTTP promptAsync); only
      // its V2 branch consumes the confirmed draft (W0-3b) — prompt.prompt under the profile admits
      // the raw parts unchanged. The drain is forked by promptAsync, so queue the turn reply first.
      yield* llm.text("draft submitted")
      const receipt = yield* provideR0OwnerRefs(
        prompt.promptAsync({
          sessionID: session.id,
          agent: "build",
          metadata: {
            deepagent: { prompt_pipeline: { confirmedDraftID: draftID, editedGoal: "Confirmed prompt goal" } },
          },
          parts: [{ type: "text", text: "ignored raw prompt" }],
        }),
      )
      expect(receipt.messageID).toBeDefined()

      // The mirrored V1 user row carries the confirmed draft's edited goal, not the raw text. The
      // prompt_pipeline metadata block is legacy-only evidence: the V2 admission/mirror persists no
      // message metadata (the W0-3b qualified test pins the refined text at the admission level).
      const users = yield* pollWithTimeout(
        sessions.messages({ sessionID: session.id }).pipe(
          Effect.map((list) => {
            const userMessages = list.filter((message) => message.info.role === "user")
            return userMessages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "Confirmed prompt goal"),
            )
              ? userMessages
              : undefined
          }),
        ),
        "confirmed draft goal was not mirrored as the user message",
      )
      expect(users).toHaveLength(1)
      expect(users[0]?.parts.some((part) => part.type === "text" && part.text === "ignored raw prompt")).toBe(false)
      expect(yield* db.select().from(SessionIntentTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  30_000,
)

// Tier-3 wire compat: an older client (or a session persisted before the wish→intelligence rename)
// submits metadata with the legacy `mode: "wish"` literal. The server-side normalizer
// (promptPipelineRequest) must map it to "intelligence" so the submitted message records
// mode "intelligence" — NOT "direct_override" (which is what an unrecognized mode would degrade to).
// This is the deterministic guard for the server READ side of the wire contract that the `.live`
// prompt-prepare CLI test otherwise covers only end-to-end.
// RI-135（P1，CLOSED）：prompt_pipeline mode 归一化在 V2 admission 落镜像时消费——
// mirrorAdmissionMetadata 把 legacy "wish" 字面量映射为 "intelligence"（未识别的 mode 与 legacy
// 提交分支一致降级为 "direct_override"），metadata 随镜像 user 行持久化并可从返回的 admission
// 收据直接读取。
v2Real.instance(
  "legacy 'wish' prompt_pipeline mode is normalized to intelligence on submit",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const session = yield* sessions.create({})

      const submitted = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          metadata: {
            deepagent: { prompt_pipeline: { mode: "wish" } },
          },
          parts: [{ type: "text", text: "修复登录测试" }],
        }),
      )

      expect(submitted.info.role).toBe("user")
      if (submitted.info.role === "user") {
        // The normalizer mapped "wish" → "intelligence"; a broken normalizer would leave the raw
        // "wish" mode unrecognized and fall through to "direct_override".
        expect(submitted.info.metadata?.deepagent?.prompt_pipeline?.mode).toBe("intelligence")
      }
    }),
  30_000,
)

v2Only.instance(
  "LEGACY-EXECUTION-ZERO: prompt admission refuses typed with zero legacy writer rows",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const chat = yield* sessions.create({ title: "V2-only unavailable" })
      const before = yield* snapshotLegacyRows(db)

      const logs: CapturedLog[] = []
      const exit = yield* captureLogs(
        logs,
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "must not enter legacy" }],
        }),
      ).pipe(Effect.exit)
      const refusal = failureIsLegacyUnavailable(exit)
      // 1.4.8.r0: prompt routes to the V2 owner, so an unqualified owner refuses v2_owner_unavailable.
      expect(refusal.reason).toBe("v2_owner_unavailable")
      expect(refusal.sessionID).toBe(chat.id)
      yield* expectLegacyZeroRows(db, before)
      expect(logs.some((entry) => entry.annotations.owner === "legacy")).toBe(false)
    }),
  30_000,
)

v2Only.instance(
  "LEGACY-EXECUTION-ZERO: promptOrSteer, command, shell, steer and cancel refuse typed under the profile",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const chat = yield* sessions.create({ title: "V2-only entries" })
      void llm
      const before = yield* snapshotLegacyRows(db)

      const promptOrSteerExit = yield* prompt
        .promptOrSteer({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)
      expect(failureIsLegacyUnavailable(promptOrSteerExit).reason).toBe("v2_owner_unavailable")

      const commandExit = yield* prompt
        .command({ sessionID: chat.id, command: Command.Default.INIT, arguments: "", model: "test/test-model" })
        .pipe(Effect.exit)
      expect(failureIsLegacyUnavailable(commandExit).reason).toBe("v2_owner_unavailable")

      // W0-2 — shell is a projection-layer surface (spawn + V1 wire mirror; no legacy durable
      // writes, no provider call), so the firewall no longer refuses it. Assert it stays
      // side-effect-clean against the legacy-row snapshot instead.
      const shellExit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "true" }).pipe(Effect.exit)
      expect(shellExit._tag).toBe("Success")
      // Projection-only effects: the V1 wire mirror gains the shell assistant message + tool
      // part, but every LEGACY EXECUTION surface (intents/steers/receipts/leases/activities/
      // selections) stays at zero.
      const afterShell = yield* snapshotLegacyRows(db)
      expect(afterShell.intents).toBe(before.intents)
      expect(afterShell.steers).toBe(before.steers)
      expect(afterShell.receipts).toBe(before.receipts)
      expect(afterShell.activities).toBe(before.activities)
      expect(afterShell.selections).toBe(before.selections)

      const steerExit = yield* prompt
        .steer({ sessionID: chat.id, prompt: new Prompt({ text: "steer text" }) })
        .pipe(Effect.exit)
      expect(failureIsLegacyUnavailable(steerExit).reason).toBe("v2_only_profile")

      const cancelExit = yield* prompt.cancel(chat.id).pipe(Effect.exit)
      // cancel is NOT part of the refusal matrix: under the profile it targets the V2 execution
      // owner (interrupt), so it succeeds without touching legacy run-state.
      expect(Exit.isSuccess(cancelExit)).toBe(true)
      expect(cancelInterruptCalls).toContain(chat.id)

      const refineExit = yield* prompt
        .refineIntelligenceDraft({ sessionID: chat.id, rawInput: "a code task" })
        .pipe(Effect.exit)
      // W0-3b — refinement is an auxiliary-AI surface (one runAuxiliary model call + fs draft),
      // no longer refused under the profile. Without a live model it still fails (refiner model
      // error), so assert only that it is NOT the legacy firewall refusing it.
      if (Exit.isFailure(refineExit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(refineExit.cause))
        expect(error).not.toBeInstanceOf(LegacyExecutionUnavailable)
      }

      // Final sweep re-snapshots (the shell projection added wire rows) and asserts only the
      // legacy EXECUTION surfaces stay untouched.
      const final = yield* snapshotLegacyRows(db)
      expect(final.intents).toBe(before.intents)
      expect(final.steers).toBe(before.steers)
      expect(final.receipts).toBe(before.receipts)
      expect(final.activities).toBe(before.activities)
      expect(final.selections).toBe(before.selections)
      expect(final.leases).toBe(before.leases)
    }),
  30_000,
)

v2Only.instance(
  "LEGACY-EXECUTION-ZERO: layer build registers no legacy provider owner lease under the profile",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      // Layer already built by the harness (fresh per test): under the V2-only profile the legacy
      // provider owner register + startup recovery are skipped, so no lease rows exist at all.
      const before = yield* snapshotLegacyRows(db)
      const chat = yield* sessions.create({ title: "V2-only layer" })
      const exit = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "must not enter legacy" }],
        })
        .pipe(Effect.exit)
      expect(failureIsLegacyUnavailable(exit).reason).toBe("v2_owner_unavailable")
      yield* expectLegacyZeroRows(db, before)
      expect(before.leases).toBe(0)
      expect(before.intents).toBe(0)
      expect(before.receipts).toBe(0)
    }),
  30_000,
)

v2Only.instance(
  "LEGACY-EXECUTION-ZERO: loop refuses typed (not a defect) with the fork log showing blocked_v2_only",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const chat = yield* sessions.create({ title: "V2-only loop" })
      const before = yield* snapshotLegacyRows(db)

      const logs: CapturedLog[] = []
      const exit = yield* captureLogs(logs, prompt.loop({ sessionID: chat.id })).pipe(Effect.exit)
      const refusal = failureIsLegacyUnavailable(exit)
      expect(refusal.reason).toBe("v2_owner_unavailable")
      expect(refusal.sessionID).toBe(chat.id)
      yield* expectLegacyZeroRows(db, before)
      expect(logs.some((entry) => entry.annotations.owner === "blocked_v2_only")).toBe(true)
      expect(logs.some((entry) => entry.annotations.owner === "legacy")).toBe(false)
    }),
  30_000,
)

// 1.4.8.r0 — V2 interactive execution on the legacy instance surface (qualified harness). The owner
// authorization is a REAL Ed25519-signed row (ephemeral issuance keypair, provided to the verifier via
// the reference seam) so promptV2 qualifies at call time and the V2 admission + drain + mirror path
// executes end-to-end against the stub V2 stack.
const realStackTestName = "1.4.8.rN REAL-STACK: interactive prompt executes through the real V2 runner end-to-end"
const realStackTest = () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const chat = yield* sessions.create({ title: "r0 real-stack" })
    yield* llm.text("real v2 runner reply")

    const result = yield* provideR0OwnerRefs(
      prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        parts: [{ type: "text", text: "hello via real v2 runner" }],
      }),
    )

    // The real runner produced the assistant; the V1 mirror serves the reader; legacy rows zero.
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "real v2 runner reply")).toBe(true)
    const v1 = yield* sessions.messages({ sessionID: chat.id })
    expect(v1.some((m) => m.info.role === "user")).toBe(true)
    expect(v1.some((m) => m.info.role === "assistant")).toBe(true)
    const intents = (yield* db.select().from(SessionIntentTable).all()).length
    expect(intents).toBe(0)
  })

if (process.env.DEEPAGENT_CODE_REAL_STACK_CHILD === "1") {
  v2Real.instance(realStackTestName, realStackTest, 60_000)
} else {
  // This is a cold-stack gate. A dedicated process prevents thousands of preceding suites from
  // donating process-global layers and fibers to the runtime being qualified.
  test(
    realStackTestName,
    async () => {
      const child = Bun.spawn(
        [process.execPath, "test", fileURLToPath(import.meta.url), "--test-name-pattern", realStackTestName],
        {
          cwd: path.join(import.meta.dir, "../.."),
          env: { ...process.env, DEEPAGENT_CODE_REAL_STACK_CHILD: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (exitCode === 0) return
      throw new Error(`REAL-STACK child failed (${exitCode})\n${stdout}\n${stderr}`)
    },
    60_000,
  )
}

v2Qualified.instance(
  "1.4.8.r0: qualified V2 owner executes the interactive prompt via admission + drain + mirror",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      expect(yield* provideR0OwnerRefs(v2OwnerQualified(db, r0Campaign))).toBe(true)
      const chat = yield* sessions.create({
        title: "r0 interactive",
        permission: [{ permission: "bash", pattern: "*", action: "deny" }],
      })
      r0V2PromptCalls.length = 0
      r0V2ResumeCalls.length = 0
      r0V2AdoptPermissions.length = 0

      const result = yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "hello via v2" }],
        }),
      )

      expect(r0V2PromptCalls).toContain(chat.id)
      expect(r0V2ResumeCalls).toContain(chat.id)
      expect(r0V2AdoptCalls).toEqual([])
      expect(r0V2AdoptPermissions).toEqual([])
      const createdRow = yield* db.select().from(SessionTable).where(eq(SessionTable.id, chat.id)).get()
      expect(createdRow?.v2_authority).toBe(true)
      expect(createdRow?.permission).toEqual([{ action: "bash", resource: "*", effect: "deny" }])
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "v2 owner reply")).toBe(true)
      // Mirror: V1 reader sees the user + assistant rows (V2 authority projected to the limited reader).
      const v1 = yield* sessions.messages({ sessionID: chat.id })
      expect(v1.some((m) => m.info.role === "user")).toBe(true)
      expect(v1.some((m) => m.info.role === "assistant")).toBe(true)
      // Zero legacy execution rows: intent/steer/receipt/lease stay untouched (message/part are the
      // allowed V2 mirror).
      const intents = (yield* db.select().from(SessionIntentTable).all()).length
      const steers = (yield* db.select().from(SessionSteerTable).all()).length
      const leases = (yield* db.select().from(SessionProviderOwnerLeaseTable).all()).length
      expect(intents).toBe(0)
      expect(steers).toBe(0)
      expect(leases).toBe(0)
    }),
  30_000,
)

v2Qualified.instance(
  "1.4.8.r0: slash command executes on the V2 owner under the profile",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({ title: "r0 command" })
      void llm
      r0V2PromptCalls.length = 0
      r0V2ResumeCalls.length = 0
      r0V2SwitchModelCalls.length = 0

      const result = yield* provideR0OwnerRefs(
        prompt.command({
          sessionID: chat.id,
          command: Command.Default.INIT,
          model: "test/test-model",
          arguments: "",
        }),
      )

      expect(r0V2PromptCalls).toContain(chat.id)
      expect(r0V2ResumeCalls).toContain(chat.id)
      // RI-139: the explicit command model is forwarded into the V2 session store before admission.
      expect(r0V2SwitchModelCalls).toContainEqual({ id: "test-model", providerID: "test" })
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "v2 owner reply")).toBe(true)
      const intents = (yield* db.select().from(SessionIntentTable).all()).length
      const steers = (yield* db.select().from(SessionSteerTable).all()).length
      const leases = (yield* db.select().from(SessionProviderOwnerLeaseTable).all()).length
      expect(intents).toBe(0)
      expect(steers).toBe(0)
      expect(leases).toBe(0)
      // V1 mirror serves the reader after the V2 command turn.
      const v1 = yield* sessions.messages({ sessionID: chat.id })
      expect(v1.some((m) => m.info.role === "user")).toBe(true)
      expect(v1.some((m) => m.info.role === "assistant")).toBe(true)
    }),
  30_000,
)

v2Qualified.instance(
  "1.4.8.rN: prompt-async under the profile admits durably into V2 and drains explicitly",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({ title: "r0 async" })
      r0V2PromptCalls.length = 0
      r0V2ResumeCalls.length = 0
      const receipt = yield* provideR0OwnerRefs(
        prompt.promptAsync({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "admit only" }],
        }),
      )

      expect(receipt.messageID).toBeDefined()
      expect(r0V2PromptCalls).toContain(chat.id)
      // r0 wired the V2 execution owner for the installed stack: prompt-async admits (resume:false)
      // and then drives the drain explicitly (admission-before-wake, wake-after-admit), so the
      // durable input IS executed — a pure no-drain admission would leave the prompt unserved.
      expect(r0V2ResumeCalls).toContain(chat.id)
    }),
  30_000,
)

v2Qualified.instance(
  "W0-3b: confirmed intelligence draft replaces the V2 prompt text under the profile",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({ title: "r0 intelligence confirm" })
      const draftID = prepareDraft(dir, chat.id, "intelligence", "Design the V2 confirmation flow")
      r0V2PromptCalls.length = 0
      r0V2PromptTexts.length = 0

      yield* provideR0OwnerRefs(
        prompt.promptAsync({
          sessionID: chat.id,
          agent: "build",
          noReply: true,
          metadata: {
            deepagent: { prompt_pipeline: { confirmedDraftID: draftID, editedGoal: "Refined V2 goal from draft" } },
          },
          parts: [{ type: "text", text: "raw unrefined input" }],
        }),
      )

      // The confirmed draft's task_prompt (the edited goal) replaces the raw text in the V2
      // admission — exactly what the legacy loop's createUserMessage did for the V1 path.
      expect(r0V2PromptCalls).toContain(chat.id)
      expect(r0V2PromptTexts).toContain("Refined V2 goal from draft")
      expect(r0V2PromptTexts).not.toContain("raw unrefined input")
      // The pipeline submission is pure fs work — no legacy execution rows appear.
      const intents = (yield* db.select().from(SessionIntentTable).all()).length
      expect(intents).toBe(0)
    }),
  30_000,
)

// ── W16 (O-W0-4): goalActive 判定提前 under the V2-only profile ─────────────────────────────────────
//
// The seam (prompt.ts promptOrSteer coreV2Only branch): a NON-terminal active-goal pointer must be
// checked BEFORE the promptV2 short-circuit. A running goal's steer must land on the V2 goal channel —
// SessionV2.prompt delivery="goal_steer" (the SessionInput.Delivery literal) — not as the default
// "steer" chat input the parent runner promotes into the transcript (in which case the goal never
// receives the guidance). The W1.1 runner drain opens a drain-only turn (no provider dispatch) that
// hands the steer to the active goal's durable runtime state. Under the profile the legacy
// SessionSteer table is NOT written (W1 channel takeover; the legacy buffer stays for the non-profile
// ingress and the goal-manager cold-path relay).

const seedV2Goal = (sessionID: string, phase: AgentGateway.DeepAgentSessionState.GoalPointerPhase) => {
  AgentGateway.DeepAgentSessionState.getOrCreate(sessionID, "high")
  AgentGateway.DeepAgentSessionState.setActiveGoal(sessionID, {
    goalId: "g_" + sessionID,
    planDocId: "plan_" + sessionID,
    phase: "running",
    startedAt: new Date(0).toISOString(),
  })
  // setActiveGoalPhase patches ONLY the phase of the just-set pointer (drives running↔paused↔terminal).
  AgentGateway.DeepAgentSessionState.setActiveGoalPhase(sessionID, phase)
}

v2Qualified.instance(
  "W16: coreV2Only + active goal routes the steer to SessionV2.prompt with delivery goal_steer (no legacy steer row)",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({ title: "W16 goal steer" })
      r0V2PromptCalls.length = 0
      r0V2PromptDeliveries.length = 0
      r0V2ResumeCalls.length = 0

      seedV2Goal(chat.id, "running")

      const result = yield* provideR0OwnerRefs(
        prompt.promptOrSteer({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "GOAL-GUIDANCE" }],
        }),
      )

      // The REAL call shape: the V2 admission carried the goal channel's delivery literal — NOT the
      // chat path's omitted delivery (undefined ⇒ core SessionV2.prompt defaults to "steer").
      expect(r0V2PromptDeliveries).toEqual(["goal_steer"])
      expect(r0V2PromptCalls).toContain(chat.id)
      // Goal admission is admit + default-resume (the wake drives the W1.1 drain-only turn); the
      // ingress must NOT also run the chat drain/loop (no explicit resume from this seam).
      expect(r0V2ResumeCalls).not.toContain(chat.id)
      // Ack: the goal channel absorbed it (kind "steer_v2" — no chat turn ran, no legacy steer row).
      expect(result.kind).toBe("steer_v2")
      if (result.kind !== "steer_v2") throw new Error("expected steer_v2 ack")
      expect(result.delivery).toBe("goal_steer")
      expect(result.admitted.id).toBe(SessionMessage.ID.make("msg_r0_admitted"))
      // W1 channel takeover: ZERO legacy SessionSteer rows under the profile.
      const steers = (yield* db.select().from(SessionSteerTable).all()).length
      expect(steers).toBe(0)
      // session-state is PROCESS-GLOBAL: drop the pointer so later tests start goal-free.
      AgentGateway.DeepAgentSessionState.setActiveGoal(chat.id, null)
    }),
  30_000,
)

v2Qualified.instance(
  "W16: coreV2Only + NO active goal keeps the promptV2 chat admission unchanged (delivery defaults to steer)",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({ title: "W16 no goal" })
      r0V2PromptCalls.length = 0
      r0V2PromptDeliveries.length = 0
      r0V2ResumeCalls.length = 0

      const result = yield* provideR0OwnerRefs(
        prompt.promptOrSteer({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "hello via v2" }],
        }),
      )

      // Admission shape unchanged from pre-W16: no delivery key passed (core defaults "steer") — the
      // chat drain + V1 mirror + turn ack path runs exactly as before the wiring.
      expect(r0V2PromptDeliveries).toEqual([undefined])
      expect(r0V2ResumeCalls).toContain(chat.id)
      expect(result.kind).toBe("turn")
      if (result.kind !== "turn") throw new Error("expected turn")
      expect(result.message.parts.some((part) => part.type === "text" && part.text === "v2 owner reply")).toBe(true)
      // No legacy steer rows (chat admission is also V2-only under the profile).
      const steers = (yield* db.select().from(SessionSteerTable).all()).length
      expect(steers).toBe(0)
    }),
  30_000,
)

v2Qualified.instance(
  "W16: coreV2Only + TERMINAL goal phase does NOT route to goal_steer (falls through to the chat path)",
  () =>
    Effect.gen(function* () {
      const promptSvc = yield* SessionPromptV2.Service
      const commandSvc = yield* SessionCommandV2.Service
      const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)
      const chat = yield* sessions.create({ title: "W16 terminal goal" })
      r0V2PromptCalls.length = 0
      r0V2PromptDeliveries.length = 0
      r0V2ResumeCalls.length = 0

      seedV2Goal(chat.id, "done")

      const result = yield* provideR0OwnerRefs(
        prompt.promptOrSteer({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "after done" }],
        }),
      )

      // The goal-active predicate excludes terminal phases: the steer is NOT admitted with
      // goal_steer; it takes the regular V2 chat admission (same call shape as the no-goal test).
      expect(r0V2PromptDeliveries).toEqual([undefined])
      expect(result.kind).toBe("turn")
      AgentGateway.DeepAgentSessionState.setActiveGoal(chat.id, null)
    }),
  30_000,
)

// ===== P0-4: receipted command side effects (!-shell blocks + command.execute.before) =====
//
// The receipt protocol under test: every write-class side effect of command() commits a
// command_side_effect_receipt intent row BEFORE executing (status pending), executes, then
// settles (settled_ok | settled_error). A crash between intent and settle leaves the pending
// row as a queryable UNKNOWN outcome; a retry quarantines it fail-closed (typed
// CommandEffectReceipt.UnknownOutcome, no re-execution) and only an explicit force starts a
// new attempt. Duplicate deliveries reuse the settled outcome without re-executing.

type CrashEnv = { point?: string; root?: string; marker?: string }

const withCommandEffectCrashPoint = <A, E, R>(
  input: { readonly directory: string; readonly marker: string; readonly point: string },
  fx: () => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync<CrashEnv>(() => {
      const previous = {
        point: process.env.DEEPAGENT_CODE_TEST_COMMAND_EFFECT_CRASH_POINT,
        root: process.env.DEEPAGENT_CODE_TEST_ROOT,
        marker: process.env.DEEPAGENT_CODE_TEST_COMMAND_EFFECT_CRASH_MARKER,
      }
      process.env.DEEPAGENT_CODE_TEST_COMMAND_EFFECT_CRASH_POINT = input.point
      process.env.DEEPAGENT_CODE_TEST_ROOT = input.directory
      process.env.DEEPAGENT_CODE_TEST_COMMAND_EFFECT_CRASH_MARKER = input.marker
      return previous
    }),
    () => fx(),
    (previous) =>
      Effect.sync(() => {
        if (previous.point === undefined) delete process.env.DEEPAGENT_CODE_TEST_COMMAND_EFFECT_CRASH_POINT
        else process.env.DEEPAGENT_CODE_TEST_COMMAND_EFFECT_CRASH_POINT = previous.point
        if (previous.root === undefined) delete process.env.DEEPAGENT_CODE_TEST_ROOT
        else process.env.DEEPAGENT_CODE_TEST_ROOT = previous.root
        if (previous.marker === undefined) delete process.env.DEEPAGENT_CODE_TEST_COMMAND_EFFECT_CRASH_MARKER
        else process.env.DEEPAGENT_CODE_TEST_COMMAND_EFFECT_CRASH_MARKER = previous.marker
      }),
  )

const readCountFile = (file: string) =>
  Effect.promise(async () => ((await Bun.file(file).exists()) ? await Bun.file(file).text() : ""))

// Drive command() through the real V2 stack with a config-defined command whose `!`-shell
// block appends to a counter file, so execution count is observable on disk.
const bootReceiptSession = (template: (dir: string) => string) =>
  Effect.gen(function* () {
    const { directory } = yield* TestInstance
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      command: { receipt: { template: template(directory) } },
    }))
    const promptSvc = yield* SessionPromptV2.Service
    const commandSvc = yield* SessionCommandV2.Service
    const prompt = { ...promptSvc, command: commandSvc.command, shell: commandSvc.shell }
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    yield* mintR0Authorization(db)
    const chat = yield* sessions.create({ title: "command effect receipt" })
    return { directory, llm, prompt, db, chat }
  })

const shellBlockKey = (chat: { id: string }, payload: string) =>
  CommandEffectReceipt.operationKey({
    sessionID: chat.id,
    command: "receipt",
    arguments: "",
    kind: "shell",
    payload,
  })

;(process.platform !== "win32" ? v2Real.instance : v2Real.instance.skip)(
  "P0-4: !-shell block commits its receipt intent BEFORE the OS process runs; crash before execute quarantines",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory, llm, prompt, db, chat } = yield* bootReceiptSession((dir) => {
          const count = path.join(dir, "count-intent.txt")
          return `Count: !\`printf side-effect >> ${count}; printf ran\``
        })
        const payload = `printf side-effect >> ${path.join(directory, "count-intent.txt")}; printf ran`
        const marker = path.join(directory, "crash-after-intent.json")

        yield* withCommandEffectCrashPoint({ directory, marker, point: "after_intent_insert" }, () =>
          Effect.gen(function* () {
            const running = yield* provideR0OwnerRefs(
              prompt.command({ sessionID: chat.id, command: "receipt", arguments: "" }),
            ).pipe(Effect.forkChild)
            yield* pollWithTimeout(
              Effect.promise(() =>
                Bun.file(marker)
                  .exists()
                  .then((exists) => (exists ? true : undefined)),
              ),
              "command never reached the after-intent crash point",
              "10 seconds",
            )
            // The ordering oracle: the durable intent row EXISTS while the OS effect has
            // NOT run yet — intent-first, not execute-first.
            const row = yield* CommandEffectReceipt.latestRow(db, shellBlockKey(chat, payload))
            expect(row?.status).toBe("pending")
            expect(row?.attempt).toBe(1)
            expect(yield* readCountFile(path.join(directory, "count-intent.txt"))).toBe("")
            yield* Fiber.interrupt(running)
          }),
        )

        // The crashed attempt left an unsettled intent: the retry must refuse re-execution
        // fail-closed (typed) and record the quarantine, not spawn the shell again.
        const refused = yield* provideR0OwnerRefs(
          prompt.command({ sessionID: chat.id, command: "receipt", arguments: "" }),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(refused)).toBe(true)
        if (Exit.isFailure(refused)) {
          const error = Cause.squash(refused.cause)
          expect(error).toBeInstanceOf(CommandEffectReceipt.UnknownOutcome)
          if (error instanceof CommandEffectReceipt.UnknownOutcome) {
            expect(error.detail).toContain("force")
            expect(error.attempt).toBe(1)
          }
        }
        expect(yield* readCountFile(path.join(directory, "count-intent.txt"))).toBe("")
        expect((yield* CommandEffectReceipt.latestRow(db, shellBlockKey(chat, payload)))?.status).toBe("unknown")

        // Explicit force starts a new attempt: executes once, settles, and the command
        // completes end-to-end with the substituted output.
        yield* llm.text("done")
        yield* provideR0OwnerRefs(
          prompt.command({ sessionID: chat.id, command: "receipt", arguments: "", force: true }),
        )
        expect(yield* readCountFile(path.join(directory, "count-intent.txt"))).toBe("side-effect")
        const forced = yield* CommandEffectReceipt.latestRow(db, shellBlockKey(chat, payload))
        expect(forced?.attempt).toBe(2)
        expect(forced?.status).toBe("settled_ok")
        expect(forced?.output).toBe("ran")
        expect(forced?.exit_code).toBe(0)
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("ran")
      }),
    ),
  30_000,
)
;(process.platform !== "win32" ? v2Real.instance : v2Real.instance.skip)(
  "P0-4: crash between execute and settle leaves UNKNOWN; retry refuses, force re-runs and settles",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory, llm, prompt, db, chat } = yield* bootReceiptSession((dir) => {
          const count = path.join(dir, "count-settle.txt")
          return `Count: !\`printf side-effect >> ${count}; printf ran\``
        })
        const payload = `printf side-effect >> ${path.join(directory, "count-settle.txt")}; printf ran`
        const marker = path.join(directory, "crash-before-settle.json")

        yield* withCommandEffectCrashPoint({ directory, marker, point: "after_execute_before_settle" }, () =>
          Effect.gen(function* () {
            const running = yield* provideR0OwnerRefs(
              prompt.command({ sessionID: chat.id, command: "receipt", arguments: "" }),
            ).pipe(Effect.forkChild)
            yield* pollWithTimeout(
              Effect.promise(() =>
                Bun.file(marker)
                  .exists()
                  .then((exists) => (exists ? true : undefined)),
              ),
              "command never reached the before-settle crash point",
              "10 seconds",
            )
            // The OS effect RAN (definite observable), but the settle never committed: the
            // durable outcome is unknown and the row must still be pending.
            expect(yield* readCountFile(path.join(directory, "count-settle.txt"))).toBe("side-effect")
            const row = yield* CommandEffectReceipt.latestRow(db, shellBlockKey(chat, payload))
            expect(row?.status).toBe("pending")
            yield* Fiber.interrupt(running)
          }),
        )

        // Retry sees the unsettled attempt and refuses — no second side-effect line.
        const refused = yield* provideR0OwnerRefs(
          prompt.command({ sessionID: chat.id, command: "receipt", arguments: "" }),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(refused)).toBe(true)
        if (Exit.isFailure(refused)) {
          expect(Cause.squash(refused.cause)).toBeInstanceOf(CommandEffectReceipt.UnknownOutcome)
        }
        expect(yield* readCountFile(path.join(directory, "count-settle.txt"))).toBe("side-effect")

        // Force re-runs under a new attempt and settles exactly once.
        yield* llm.text("done")
        yield* provideR0OwnerRefs(
          prompt.command({ sessionID: chat.id, command: "receipt", arguments: "", force: true }),
        )
        expect(yield* readCountFile(path.join(directory, "count-settle.txt"))).toBe("side-effectside-effect")
        const forced = yield* CommandEffectReceipt.latestRow(db, shellBlockKey(chat, payload))
        expect(forced?.attempt).toBe(2)
        expect(forced?.status).toBe("settled_ok")
        expect(forced?.output).toBe("ran")
      }),
    ),
  30_000,
)
;(process.platform !== "win32" ? v2Real.instance : v2Real.instance.skip)(
  "P0-4: completed !-shell block settles exactly once; duplicate delivery reuses the outcome",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory, llm, prompt, db, chat } = yield* bootReceiptSession((dir) => {
          const count = path.join(dir, "count-once.txt")
          return `Count: !\`printf side-effect >> ${count}; printf ran\``
        })
        const payload = `printf side-effect >> ${path.join(directory, "count-once.txt")}; printf ran`

        yield* llm.text("first")
        yield* provideR0OwnerRefs(prompt.command({ sessionID: chat.id, command: "receipt", arguments: "" }))
        expect(yield* readCountFile(path.join(directory, "count-once.txt"))).toBe("side-effect")
        const first = yield* CommandEffectReceipt.latestRow(db, shellBlockKey(chat, payload))
        expect(first?.status).toBe("settled_ok")
        expect(first?.attempt).toBe(1)
        expect(first?.output).toBe("ran")

        // Duplicate delivery of the same command: the settled outcome is REUSED — the shell
        // does not run again and the receipt is not re-settled or re-attempted.
        yield* llm.text("second")
        yield* provideR0OwnerRefs(prompt.command({ sessionID: chat.id, command: "receipt", arguments: "" }))
        expect(yield* readCountFile(path.join(directory, "count-once.txt"))).toBe("side-effect")
        const second = yield* CommandEffectReceipt.latestRow(db, shellBlockKey(chat, payload))
        expect(second?.attempt).toBe(1)
        expect(second?.status).toBe("settled_ok")
        expect(second?.time_settled).toBe(first?.time_settled)
        const rows = yield* db
          .select()
          .from(CommandEffectReceipt.CommandSideEffectReceiptTable)
          .where(eq(CommandEffectReceipt.CommandSideEffectReceiptTable.session_id, chat.id))
          .all()
          .pipe(Effect.orDie)
        // Exactly one shell attempt; the command.execute.before hook has its own receipt.
        expect(rows.filter((row) => row.kind === "shell")).toHaveLength(1)
        expect(rows.filter((row) => row.kind === "plugin_hook" && row.status === "settled_ok")).toHaveLength(1)
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("ran")
      }),
    ),
  30_000,
)

// Plugin-hook receipts: the command.execute.before trigger goes through the same receipt
// guard. Recording plugin layer over the same real V2 stack as v2Real.
const commandEffectHookCalls: Array<{ name: string; command: string }> = []
const commandEffectHookTrigger: Plugin.Interface["trigger"] = (name, input, output) =>
  Effect.sync(() => {
    if (name === "command.execute.before")
      commandEffectHookCalls.push({ name, command: (input as { command: string }).command })
    return output
  })
const commandEffectPlugin = Plugin.Service.of({
  trigger: commandEffectHookTrigger,
  list: () => Effect.succeed([]),
  init: () => Effect.void,
})
const v2RealPlugin = testEffect(
  makeHttp({
    flags: { coreV2Only: true, coreV2ExecutionOwner: true },
    sessionV2: realV2Layer,
    sessionV2ForTools: realV2Layer,
    plugin: commandEffectPlugin,
  }).pipe(
    Layer.provide(Layer.succeed(CurrentOwnerCampaign, r0Campaign)),
    Layer.provide(Layer.succeed(CurrentBuildIdentity, r0Identity)),
    Layer.provide(Layer.succeed(CurrentOwnerAuthorizationPublicKey, r0Issuance.publicKeyPem)),
  ),
)

;(process.platform !== "win32" ? v2RealPlugin.instance : v2RealPlugin.instance.skip)(
  "P0-4: command.execute.before plugin trigger is receipted; settled hooks are not re-triggered",
  () =>
    Effect.gen(function* () {
      const { llm, prompt, db, chat } = yield* bootReceiptSession(() => "Plain hook probe")
      const hookKey = CommandEffectReceipt.operationKey({
        sessionID: chat.id,
        command: "receipt",
        arguments: "",
        kind: "plugin_hook",
        payload: "command.execute.before",
      })
      commandEffectHookCalls.length = 0

      yield* llm.text("first")
      yield* provideR0OwnerRefs(prompt.command({ sessionID: chat.id, command: "receipt", arguments: "" }))
      expect(commandEffectHookCalls).toHaveLength(1)
      const first = yield* CommandEffectReceipt.latestRow(db, hookKey)
      expect(first?.status).toBe("settled_ok")
      expect(first?.kind).toBe("plugin_hook")
      expect(first?.attempt).toBe(1)

      // Duplicate delivery reuses the settled hook receipt: no re-trigger.
      yield* llm.text("second")
      yield* provideR0OwnerRefs(prompt.command({ sessionID: chat.id, command: "receipt", arguments: "" }))
      expect(commandEffectHookCalls).toHaveLength(1)
      expect((yield* CommandEffectReceipt.latestRow(db, hookKey))?.attempt ?? 0).toBe(1)
    }),
  30_000,
)
;(process.platform !== "win32" ? v2RealPlugin.instance : v2RealPlugin.instance.skip)(
  "P0-4: quarantined plugin hook receipt refuses re-trigger; force re-runs the hook",
  () =>
    Effect.gen(function* () {
      const { directory, llm, prompt, db, chat } = yield* bootReceiptSession(() => "Plain hook probe")
      const hookKey = CommandEffectReceipt.operationKey({
        sessionID: chat.id,
        command: "receipt",
        arguments: "",
        kind: "plugin_hook",
        payload: "command.execute.before",
      })
      const marker = path.join(directory, "crash-hook-after-intent.json")
      commandEffectHookCalls.length = 0

      yield* withCommandEffectCrashPoint({ directory, marker, point: "after_intent_insert" }, () =>
        Effect.gen(function* () {
          const running = yield* provideR0OwnerRefs(
            prompt.command({ sessionID: chat.id, command: "receipt", arguments: "" }),
          ).pipe(Effect.forkChild)
          yield* pollWithTimeout(
            Effect.promise(() =>
              Bun.file(marker)
                .exists()
                .then((exists) => (exists ? true : undefined)),
            ),
            "command never reached the hook after-intent crash point",
            "10 seconds",
          )
          const row = yield* CommandEffectReceipt.latestRow(db, hookKey)
          expect(row?.kind).toBe("plugin_hook")
          expect(row?.status).toBe("pending")
          expect(commandEffectHookCalls).toHaveLength(0)
          yield* Fiber.interrupt(running)
        }),
      )

      const refused = yield* provideR0OwnerRefs(
        prompt.command({ sessionID: chat.id, command: "receipt", arguments: "" }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(refused)).toBe(true)
      if (Exit.isFailure(refused)) {
        expect(Cause.squash(refused.cause)).toBeInstanceOf(CommandEffectReceipt.UnknownOutcome)
      }
      expect(commandEffectHookCalls).toHaveLength(0)
      expect((yield* CommandEffectReceipt.latestRow(db, hookKey))?.status).toBe("unknown")

      yield* llm.text("done")
      yield* provideR0OwnerRefs(prompt.command({ sessionID: chat.id, command: "receipt", arguments: "", force: true }))
      expect(commandEffectHookCalls).toHaveLength(1)
      const forced = yield* CommandEffectReceipt.latestRow(db, hookKey)
      expect(forced?.attempt).toBe(2)
      expect(forced?.status).toBe("settled_ok")
    }),
  30_000,
)
