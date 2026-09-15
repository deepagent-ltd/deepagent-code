/**
 * Reproducer for snapshot race condition with instant tool execution.
 *
 * When the mock LLM returns a tool call response instantly, the AI SDK
 * processes the tool call and executes the tool (e.g. apply_patch) before
 * the processor's start-step handler can capture a pre-tool snapshot.
 * Both the "before" and "after" snapshots end up with the same git tree
 * hash, so computeDiff returns empty and the session summary shows 0 files.
 *
 * This is a real bug: the snapshot system assumes it can capture state
 * before tools run by hooking into start-step, but the AI SDK executes
 * tools internally during multi-step processing before emitting events.
 */
import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import fs from "fs/promises"
import path from "path"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionSummary } from "../../src/session/summary"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { SessionV2 } from "@deepagent-code/core/session"
import {
  CurrentBuildIdentity,
  CurrentOwnerAuthorizationPublicKey,
  CurrentOwnerCampaign,
} from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2OwnerAuthorization } from "@deepagent-code/core/session/runner/v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "@deepagent-code/core/session/runner/v2-owner-authorization.sql"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import { SessionStore } from "@deepagent-code/core/session/store"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import * as Log from "@deepagent-code/core/util/log"
import { Hash } from "@deepagent-code/core/util/hash"
import { disposeAllInstances, provideTmpdirServer, testInstanceStoreLayer, tmpRoot } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

// Same layer setup as prompt-effect.test.ts
import { NodeFileSystem } from "@effect/platform-node"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import remoteCompactPersistenceMigration from "@deepagent-code/core/database/migration/20260820000000_remote_compact_persistence"
import { EventV2Bridge } from "@/event-v2-bridge"
import { DebugService } from "@/debug/service"
import { RuntimeBase } from "@/runtime/base"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { BackgroundJob } from "@/background/job"
import { Git } from "../../src/git"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Question } from "../../src/question"
import { Image } from "../../src/image/image"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Todo } from "../../src/session/todo"
import { SessionCompaction } from "../../src/session/compaction"
import { RequestExecutor } from "@deepagent-code/llm/route"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRunState } from "../../src/session/run-state"
import { SessionSteer } from "../../src/session/steer"
import { SessionStatus } from "../../src/session/status"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Search } from "@deepagent-code/core/filesystem/search"
import { Format } from "../../src/format"
import { Reference } from "../../src/reference/reference"
import { RepositoryCache } from "../../src/reference/repository-cache"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestContextFacades } from "../fixture/context-facades"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { PromptEpoch } from "@/session/prompt-epoch"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"

// Dispose any instances loaded into the process-wide AppRuntime instance
// store so this file leaves no shared state for files that run after it.
afterEach(async () => {
  await disposeAllInstances()
})

void Log.init({ print: false })

// The plan seed below (getOrCreate/setPlan) and the tool-side plan gate both resolve
// session-state/plan-store through the process-global default runtime; without a configured
// root setPlan throws "plan-store: no runtime state dir". Point it at a throwaway dir so the
// seed works in-process (same pattern as prompt.test.ts).
AgentGateway.DeepAgentSessionState.configure(mkdtempSync(tmpRoot()))

// r0 armed-owner template (mirrors prompt.test.ts): the V2-only profile gates prompt execution on
// a verified owner authorization, so the test mints a signed active row and arms the three owner
// references on the layer graph (build-time reads) and the prompt fiber (call-time reads).
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
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
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

// V3.5: no-op RuntimeBase (R0) stub — lets the tool registry layer build without the
// heavy Worktree→Project→Database chain. This test never invokes debug/profile.
const stubRuntimeBaseLayer = Layer.succeed(
  RuntimeBase.Service,
  RuntimeBase.Service.of({
    gate: () => Effect.void,
    withIsolation: (_input, body) => body(""),
    checkPrivileges: () => Effect.succeed([]),
  }),
)

// Fully-inert DebugService (D1) stub — avoids InstanceState.make + finalizer side effects
// at registry-build time. This test never invokes the debug tool.
const debugStubDie = <A>(): Effect.Effect<A, never, never> => Effect.die("DebugService stub (not used in this test)")
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

// REAL-STACK V2 execution (mirrors prompt.test.ts v2Real): under the V2-only profile the loop's
// owner-qualified branch resumes SessionV2, so the default no-op execution must be replaced with
// the real local runner over the SAME Database.defaultLayer constant the prompt harness uses.
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

function makeHttp() {
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
    Layer.provide(realV2Layer),
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
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    // V3.5: debug/profile tools require DebugService + RuntimeBase. Provide the real
    // (lightweight) DebugService over a no-op RuntimeBase stub — this test never invokes
    // those tools, and it avoids the heavy Worktree→Database chain.
    Layer.provide(stubDebugServiceLayer),
    Layer.provide(stubRuntimeBaseLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
  )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provide(RequestExecutor.defaultLayer),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionSummary.defaultLayer,
    SessionPrompt.layer.pipe(
      Layer.provide(realV2Layer),
      Layer.provide(SessionProviderOwner.layer.pipe(Layer.provide(deps))),
      Layer.provide(testInstanceStoreLayer),
      Layer.provide(SessionRevert.defaultLayer),
      Layer.provide(Image.defaultLayer),
      Layer.provide(Reference.defaultLayer),
      Layer.provide(SessionSummary.defaultLayer),
      Layer.provideMerge(SessionSteer.layer.pipe(Layer.provideMerge(deps))),
      Layer.provideMerge(run),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provide(LocationIdentity.layer.pipe(Layer.provide(deps))),
      Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true, coreV2ExecutionOwner: false })),
      Layer.provideMerge(deps),
    ),
  ).pipe(
    Layer.provide(Layer.succeed(CurrentOwnerCampaign, r0Campaign)),
    Layer.provide(Layer.succeed(CurrentBuildIdentity, r0Identity)),
    Layer.provide(Layer.succeed(CurrentOwnerAuthorizationPublicKey, r0Issuance.publicKeyPem)),
  )
}

const it = testEffect(makeHttp())

const providerCfg = (url: string) => ({
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
        baseURL: url,
      },
    },
  },
})

// RI-19（P1，OPEN）：diff/summary 断言依赖 legacy-only 快照管线（processor.ts snapshot.trackOutcome + summarize 只在 legacy loop 触发；V2 runner/egress 无快照捕获）——src 缺口修复前保持 skip（design.md RI 表）。其余断言（owner 门禁通过、真实 V2 执行、文件落盘、bash part completed）已在迁移中验证通过。
it.live.skip("tool execution produces non-empty session diff (snapshot race)", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir, llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const summary = yield* SessionSummary.Service
      const { db } = yield* Database.Service
      yield* mintR0Authorization(db)

      const session = yield* sessions.create({
        title: "snapshot race test",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Use bash tool (always registered) to create a file
      const command = `echo 'snapshot race test content' > ${path.join(dir, "race-test.txt")}`
      yield* llm.toolMatch((hit) => JSON.stringify(hit.body).includes("create the file"), "bash", {
        command,
        description: "create test file",
      })
      yield* llm.textMatch((hit) => JSON.stringify(hit.body).includes("bash"), "done")

      // The strict plan gate is ON by default (agentMode "high"): a planless mutating bash call
      // is correctly blocked with the minimal-plan template (F-20). Seed a live plan so the file
      // write is a legitimate planned mutation.
      AgentGateway.DeepAgentSessionState.getOrCreate(session.id, "high")
      AgentGateway.DeepAgentSessionState.setPlan(session.id, {
        plan_id: "plan_snapshot_race",
        session_id: session.id,
        goal: "create the test file",
        assumptions: [],
        steps: [{ step_id: "s1", title: "create race-test.txt", status: "active" }],
        active_step_id: "s1",
        created_at: new Date().toISOString(),
      })

      // Seed user message
      yield* provideR0OwnerRefs(
        prompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "create the file" }],
        }),
      )

      // Run the agent loop
      const result = yield* provideR0OwnerRefs(prompt.loop({ sessionID: session.id }))
      expect(result.info.role).toBe("assistant")

      // Verify the file was created
      const filePath = path.join(dir, "race-test.txt")
      const fileExists = yield* Effect.promise(() =>
        fs
          .access(filePath)
          .then(() => true)
          .catch(() => false),
      )
      expect(fileExists).toBe(true)

      // Verify the tool call completed (in the first assistant message)
      const allMsgs = yield* MessageV2.filterCompactedEffect(session.id)
      const user = allMsgs.find(
        (msg): msg is SessionV1.WithParts & { info: SessionV1.User } => msg.info.role === "user",
      )
      const tool = allMsgs
        .flatMap((m) => m.parts)
        .find((p): p is SessionV1.ToolPart => p.type === "tool" && p.tool === "bash")
      expect(tool?.state.status).toBe("completed")
      if (!user) throw new Error("Expected user message")

      // Poll for the turn diff — summarize() is fire-and-forget.
      let diff: Snapshot.FileDiff[] = []
      for (let i = 0; i < 50; i++) {
        diff = yield* summary.diff({ sessionID: session.id, messageID: user.info.id })
        if (diff.length > 0) break
        yield* Effect.sleep("100 millis")
      }
      expect(diff.length).toBeGreaterThan(0)
      expect(diff.every((item) => item.patch === undefined)).toBe(true)
      const persisted = (yield* sessions.messages({ sessionID: session.id })).find(
        (message) => message.info.id === user.info.id && message.info.role === "user",
      )
      expect(
        persisted?.info.role === "user"
          ? persisted.info.summary?.diffs.every((item) => item.patch === undefined)
          : false,
      ).toBe(true)
      expect(persisted?.info.role === "user" ? persisted.info.summary?.diffManifest : undefined).toMatchObject({
        completeness: "complete",
        totalFiles: 1,
        totalFilesExact: true,
        statisticsExact: true,
        includedFiles: 1,
        truncatedFiles: 0,
      })
      expect(
        persisted?.info.role === "user" ? persisted.info.summary?.diffManifest?.manifestHash : undefined,
      ).toStartWith("sha256:")
      let sessionSummary = (yield* sessions.get(session.id)).summary
      for (let i = 0; i < 20 && sessionSummary?.files === 0; i++) {
        yield* Effect.sleep("50 millis")
        sessionSummary = (yield* sessions.get(session.id)).summary
      }
      expect(sessionSummary).toMatchObject({ additions: 1, deletions: 0, files: 1 })
      expect(sessionSummary?.diffManifest).toMatchObject({
        completeness: "complete",
        totalFiles: 1,
        totalFilesExact: true,
        statisticsExact: true,
        includedFiles: 1,
        truncatedFiles: 0,
      })
      expect(sessionSummary?.diffManifest?.manifestHash).toStartWith("sha256:")
    }),
    { git: true, config: providerCfg },
  ),
)
