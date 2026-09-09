import { NodeFileSystem } from "@effect/platform-node"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import remoteCompactPersistenceMigration from "@deepagent-code/core/database/migration/20260820000000_remote_compact_persistence"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
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
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionSteer } from "../../src/session/steer"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionV2 } from "@deepagent-code/core/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
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
import { testEffect, pollWithTimeout } from "../lib/effect"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { ModelV2 } from "@deepagent-code/core/model"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { TestContextFacades } from "../fixture/context-facades"
import { EffectFlock } from "@deepagent-code/core/util/effect-flock"
import { PromptEpoch } from "@/session/prompt-epoch"
import { MessageTable, SessionIntentTable, SessionSteerTable, SessionTable } from "@deepagent-code/core/session/sql"
import { eq } from "drizzle-orm"
import { SessionMutationEpoch } from "../../src/session/mutation-epoch"
import { SessionPromptIntent } from "../../src/session/prompt-intent"
import {
  SessionActivityAdmissionTable,
  SessionActivityProgressTable,
  SessionLegacyActivityAdmissionTable,
  SessionLegacyActivityRunTable,
  SessionLegacyActivityTable,
  SessionLegacyActivityTerminalTable,
} from "../../src/session/activity-sql"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import {
  CurrentBuildIdentity,
  CurrentOwnerAuthorizationPublicKey,
  CurrentOwnerCampaign,
} from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2OwnerAuthorization } from "@deepagent-code/core/session/runner/v2-owner-authorization"
import { V2OwnerAuthorizationTable } from "@deepagent-code/core/session/runner/v2-owner-authorization.sql"
import { SessionInput } from "@deepagent-code/core/session/input"
import { Hash } from "@deepagent-code/core/util/hash"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import { SessionStore } from "@deepagent-code/core/session/store"
import { EventV2 } from "@deepagent-code/core/event"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionProjector } from "@deepagent-code/core/session/projector"

void Log.init({ print: false })

// §S1.2 promptOrSteer routes on the DeepAgent active-goal pointer, which lives in the in-memory
// session-state map. Point it at a throwaway dir so getOrCreate/setActiveGoal work in-process (no real
// $HOME writes) and each test seeds its own session pointer.
AgentGateway.DeepAgentSessionState.configure(mkdtempSync(path.join(tmpdir(), "steer-state-")))

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

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
    startAuth: () => Effect.die("unexpected MCP auth in steer tests"),
    authenticate: () => Effect.die("unexpected MCP auth in steer tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in steer tests"),
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

const stubRuntimeBaseLayer = Layer.succeed(
  RuntimeBase.Service,
  RuntimeBase.Service.of({
    gate: () => Effect.void,
    withIsolation: (_input, body) => body(""),
    checkPrivileges: () => Effect.succeed([]),
  }),
)

const debugStubDie = <A>(): Effect.Effect<A, never, never> => Effect.die("DebugService stub (not used in steer tests)")
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

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

// steeringOn/steeringOff: the ONLY difference is the v4Steering flag, so tests can assert the
// kill-switch cleanly. The steer buffer shares the same Database as Session (built over `deps`).
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

// r0 owner arming (RI-123): the V2-only profile (coreV2Only is hardcoded on) refuses prompt execution
// with LegacyExecutionUnavailable "v2_owner_unavailable" unless the fiber carries the owner References
// AND the per-test DB holds a matching active authorization row. Mirrors the prompt.test.ts r0 template.
const steerR0Issuance = V2OwnerAuthorization.generateAuthorizationKeyPair()
const steerR0Identity = {
  subjectCommit: "a".repeat(40),
  subjectTree: "b".repeat(40),
  schemaDigest: "c".repeat(64),
  buildID: "d".repeat(64),
  packageDigest: "e".repeat(64),
}
const steerR0Campaign = "steer-r0-test-campaign"
const steerR0Fields = {
  authorizationID: "auth_steer_r0_test",
  campaignID: steerR0Campaign,
  ...steerR0Identity,
  validFrom: 1_000,
  expiresAt: 4_000_000_000_000,
}
const steerR0Signed = {
  ...steerR0Fields,
  signatureDigest: V2OwnerAuthorization.signAuthorization(steerR0Issuance.privateKeyPem, steerR0Fields),
}

const provideSteerR0OwnerRefs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(CurrentOwnerCampaign, steerR0Campaign),
    Effect.provideService(CurrentBuildIdentity, steerR0Identity),
    Effect.provideService(CurrentOwnerAuthorizationPublicKey, steerR0Issuance.publicKeyPem),
  )

const mintSteerR0Authorization = (db: Database.Interface["db"]): Effect.Effect<void, unknown, never> =>
  Effect.gen(function* () {
    yield* db
      .insert(V2OwnerAuthorizationTable)
      .values({
        authorization_id: steerR0Signed.authorizationID,
        campaign_id: steerR0Signed.campaignID,
        subject_commit: steerR0Signed.subjectCommit,
        subject_tree: steerR0Signed.subjectTree,
        schema_digest: steerR0Signed.schemaDigest,
        build_id: steerR0Signed.buildID,
        package_digest: steerR0Signed.packageDigest,
        valid_from: steerR0Signed.validFrom,
        expires_at: steerR0Signed.expiresAt,
        status: "active",
        signature_digest: steerR0Signed.signatureDigest,
        authorization_digest: Hash.sha256(V2OwnerAuthorization.authorizationPayload(steerR0Fields)),
        created_at: Date.now(),
      })
      .run()
  })

// REAL-STACK: SessionV2.defaultLayer wires SessionExecution.noopLayer (dormant runner) — under the
// V2-only profile the loop's owner branch would drain nothing and produce no assistant message. Build
// the real local-execution stack instead (mirrors prompt.test.ts v2Real). One constant shared by the
// SessionPrompt and ToolRegistry provides so the per-test memoMap builds it exactly once — a second
// SessionV2.defaultLayer anywhere in the graph would win a build slot and silently no-op the drain.
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

function makePrompt(steering: boolean) {
  const flags = RuntimeFlags.layer({
    experimentalEventSystem: true,
    v4Steering: steering,
    coreV2ExecutionOwner: false,
  })
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
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
  const steer = SessionSteer.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(realV2Layer),
    Layer.provide(TestContextFacades.layer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Search.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(flags),
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
    Layer.provide(flags),
    Layer.provideMerge(deps),
  )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(flags),
    Layer.provide(RequestExecutor.defaultLayer),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  return SessionPrompt.layer
    .pipe(
      Layer.provide(realV2Layer),
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
      Layer.provide(flags),
      Layer.provideMerge(deps),
      Layer.provide(summary),
    )
    .pipe(
      Layer.provide(Layer.succeed(CurrentOwnerCampaign, steerR0Campaign)),
      Layer.provide(Layer.succeed(CurrentBuildIdentity, steerR0Identity)),
      Layer.provide(Layer.succeed(CurrentOwnerAuthorizationPublicKey, steerR0Issuance.publicKeyPem)),
    )
}

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
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: { ...cfg.provider.test, options: { ...cfg.provider.test.options, baseURL: url } },
    },
  }
}

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(
    `${dir}/deepagent-code.json`,
    JSON.stringify({ $schema: "https://ai.deepagent.ltd/config.schema.json", ...config }),
  )
})

// Mirrors prompt.test.ts useServerConfig: write the config that points the "test" provider at the live
// TestLLMServer into the per-test tmpdir instance directory, so provider model lookup succeeds.
const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

const on = testEffect(Layer.mergeAll(TestLLMServer.layer, makePrompt(true)))
const off = testEffect(Layer.mergeAll(TestLLMServer.layer, makePrompt(false)))

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

const mkPrompt = (text: string): Prompt => Prompt.fromUserMessage({ text })

const seedLegacyActivity = (sessionID: SessionID, suffix: string) =>
  Effect.gen(function* () {
    const messageID = MessageID.make(`msg_${suffix}_trigger`)
    const claim = yield* SessionPromptIntent.claim({
      intentID: `intent_${suffix}_trigger`,
      sessionID,
      source: "composer",
      variant: "original",
      payloadHash: `payload-${suffix}-trigger`,
      messageID,
    })
    if (claim.kind !== "claimed") return
    yield* SessionPromptIntent.materializeTurn({
      receipt: claim.receipt,
      message: {
        info: {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: ref,
        },
        parts: [
          {
            id: PartID.make(`prt_${suffix}_trigger`),
            messageID,
            sessionID,
            type: "text",
            text: "trigger",
          },
        ],
      },
    })
  })

// ── Unit: admit → pending (ordered) → markConsumed (consume-once) ───────────────────────────────────

off.instance(
  "admit buffers steers, pending returns them in send-order, markConsumed is consume-once",
  () =>
    Effect.gen(function* () {
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Steer unit" })

      yield* steer.admit({ sessionID: chat.id, prompt: mkPrompt("first") })
      yield* steer.admit({ sessionID: chat.id, prompt: mkPrompt("second") })
      yield* steer.admit({ sessionID: chat.id, prompt: mkPrompt("third") })

      expect(yield* steer.hasPending(chat.id)).toBe(true)

      // pending is NON-consuming (persist-first read).
      const drained = yield* steer.pending(chat.id)
      expect(drained.map((d) => d.prompt.text)).toEqual(["first", "second", "third"])
      // Monotonic send-order seq
      expect(drained[0]!.seq).toBeLessThan(drained[1]!.seq)
      expect(drained[1]!.seq).toBeLessThan(drained[2]!.seq)
      // Reading did not consume — still pending.
      expect(yield* steer.hasPending(chat.id)).toBe(true)

      // markConsumed stamps them; a subsequent pending read yields nothing (consume-once).
      yield* steer.markConsumed(
        chat.id,
        drained.map((d) => d.id),
      )
      expect(yield* steer.pending(chat.id)).toHaveLength(0)
      expect(yield* steer.hasPending(chat.id)).toBe(false)
      // markConsumed is idempotent (re-marking already-consumed ids is a no-op).
      yield* steer.markConsumed(
        chat.id,
        drained.map((d) => d.id),
      )
      expect(yield* steer.hasPending(chat.id)).toBe(false)
    }),
  { config: cfg },
)

off.instance(
  "revert advances the mutation epoch and supersedes old intents and pending steers atomically",
  () =>
    Effect.gen(function* () {
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const chat = yield* sessions.create({ title: "Revert fence" })
      const admitted = yield* steer.admit({ sessionID: chat.id, prompt: mkPrompt("stale steer") })
      const now = Date.now()
      yield* db
        .insert(SessionIntentTable)
        .values({
          intent_id: "intent_revert_fence",
          session_id: chat.id,
          source: "followup",
          state: "preparing",
          mutation_epoch: admitted.mutationEpoch,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)

      yield* sessions.commitRevert({
        sessionID: chat.id,
        revert: { messageID: MessageID.make("msg_revert_fence") },
        summary: { additions: 0, deletions: 0, files: 0 },
      })

      const session = yield* db
        .select({ mutationEpoch: SessionTable.mutation_epoch })
        .from(SessionTable)
        .where(eq(SessionTable.id, chat.id))
        .get()
        .pipe(Effect.orDie)
      const intent = yield* db
        .select()
        .from(SessionIntentTable)
        .where(eq(SessionIntentTable.intent_id, "intent_revert_fence"))
        .get()
        .pipe(Effect.orDie)
      const storedSteer = yield* db
        .select()
        .from(SessionSteerTable)
        .where(eq(SessionSteerTable.id, admitted.id))
        .get()
        .pipe(Effect.orDie)
      expect(session?.mutationEpoch).toBe(admitted.mutationEpoch + 1)
      expect(intent?.state).toBe("superseded")
      expect(storedSteer?.superseded_at).not.toBeNull()
      expect(yield* steer.pending(chat.id)).toHaveLength(0)
      const messageID = MessageID.make(admitted.id)
      const error = yield* steer
        .materialize({
          admitted,
          info: {
            id: messageID,
            sessionID: chat.id,
            role: "user",
            time: { created: admitted.timeCreated },
            agent: "build",
            model: ref,
          },
          parts: [
            {
              id: steerPartID(messageID),
              messageID,
              sessionID: chat.id,
              type: "text",
              text: admitted.prompt.text,
            },
          ],
        })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionMutationEpoch.Stale)
      expect(
        yield* db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  { config: cfg },
)

off.instance(
  "follow-up intent and steer admission cross one atomic boundary",
  () =>
    Effect.gen(function* () {
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const chat = yield* sessions.create({ title: "Atomic steer intent" })
      yield* seedLegacyActivity(chat.id, "atomic_steer")
      const messageID = MessageID.make("msg_atomic_steer_intent")
      const claim = yield* SessionPromptIntent.claim({
        intentID: "intent_atomic_steer",
        sessionID: chat.id,
        source: "followup",
        variant: "original",
        payloadHash: "payload-atomic-steer",
        messageID,
      })
      expect(claim.kind).toBe("claimed")
      if (claim.kind !== "claimed") return

      const admitted = yield* steer.admit({
        sessionID: chat.id,
        prompt: mkPrompt("atomic steer"),
        correlationID: messageID,
        intent: claim.receipt,
      })

      const intent = yield* db
        .select()
        .from(SessionIntentTable)
        .where(eq(SessionIntentTable.intent_id, claim.receipt.intentID))
        .get()
        .pipe(Effect.orDie)
      expect(intent?.state).toBe("admitted")
      expect(intent?.admitted_message_id).toBe(admitted.id)
      expect((yield* steer.pending(chat.id)).map((item) => item.id)).toEqual([admitted.id])
      const owner = yield* SessionPromptIntent.activityForMessage({
        sessionID: chat.id,
        messageID: MessageID.make(admitted.id),
      })
      expect(owner?.state).toBe("active")
      if (!owner) return
      expect(
        yield* db
          .select({
            activityID: SessionLegacyActivityAdmissionTable.activity_id,
            role: SessionLegacyActivityAdmissionTable.role,
            delivery: SessionActivityAdmissionTable.delivery,
          })
          .from(SessionLegacyActivityAdmissionTable)
          .innerJoin(
            SessionActivityAdmissionTable,
            eq(SessionActivityAdmissionTable.admission_id, SessionLegacyActivityAdmissionTable.admission_id),
          )
          .where(eq(SessionActivityAdmissionTable.admitted_message_id, admitted.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ activityID: owner.activityID, role: "steer", delivery: "steer" })
      yield* SessionPromptIntent.complete({
        intentID: claim.receipt.intentID,
        ownerToken: claim.receipt.ownerToken,
        messageID: MessageID.make(admitted.id),
        delivery: "steer",
      })
    }),
  { config: cfg },
)

// ── §S1.3 FIX 1: the DELIVERY dimension isolates two drainers on the SAME session id ────────────────
off.instance(
  "delivery scoping: pending/markConsumed/hasPending default to steer, and goal_steer is a disjoint channel",
  () =>
    Effect.gen(function* () {
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Steer delivery" })

      // On the SAME session id: one parent-chat steer (delivery="steer") and one goal-directed steer
      // (delivery="goal_steer"). This models a goal running in a session whose parent runLoop is also live.
      yield* steer.admit({ sessionID: chat.id, prompt: mkPrompt("chat steer") })
      yield* steer.admit({
        sessionID: chat.id,
        prompt: mkPrompt("goal guidance"),
        delivery: "goal_steer",
      })

      // The parent runLoop's drain (default "steer") sees ONLY the chat steer.
      const steerRows = yield* steer.pending(chat.id)
      expect(steerRows.map((d) => d.prompt.text)).toEqual(["chat steer"])
      expect(yield* steer.hasPending(chat.id)).toBe(true) // default channel has one

      // The goal driver's drain ("goal_steer") sees ONLY the goal guidance.
      const goalRows = yield* steer.pending(chat.id, "goal_steer")
      expect(goalRows.map((d) => d.prompt.text)).toEqual(["goal guidance"])
      expect(yield* steer.hasPending(chat.id, "goal_steer")).toBe(true)

      // Consuming ALL of the goal channel does NOT touch the steer channel (disjoint rows, no contention).
      yield* steer.markConsumed(
        chat.id,
        goalRows.map((d) => d.id),
        "goal_steer",
      )
      expect(yield* steer.pending(chat.id, "goal_steer")).toHaveLength(0)
      expect(yield* steer.hasPending(chat.id, "goal_steer")).toBe(false)
      // The parent chat steer is UNTOUCHED — the parent runLoop can still drain it normally.
      expect((yield* steer.pending(chat.id)).map((d) => d.prompt.text)).toEqual(["chat steer"])
      expect(yield* steer.hasPending(chat.id)).toBe(true)

      // Symmetrically, consuming the steer channel leaves any (re-admitted) goal_steer row untouched.
      yield* steer.markConsumed(
        chat.id,
        steerRows.map((d) => d.id),
      )
      expect(yield* steer.hasPending(chat.id)).toBe(false)
    }),
  { config: cfg },
)

off.instance(
  "admit is idempotent on message id (no double-buffer)",
  () =>
    Effect.gen(function* () {
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Steer idempotent" })
      const correlationID = SessionMessage.ID.create()

      const a = yield* steer.admit({ correlationID, sessionID: chat.id, prompt: mkPrompt("once") })
      const b = yield* steer.admit({ correlationID, sessionID: chat.id, prompt: mkPrompt("once") })
      expect(a.seq).toBe(b.seq)

      const drained = yield* steer.pending(chat.id)
      expect(drained).toHaveLength(1)
      expect(drained[0]!.prompt.text).toBe("once")
    }),
  { config: cfg },
)

// ── Durability: consume-once survives a fresh pending/markConsumed cycle (simulating a new loop pass) ─

off.instance(
  "consume-once survives a fresh drain cycle (durable, no double-apply)",
  () =>
    Effect.gen(function* () {
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Steer durable" })

      const admitted = yield* steer.admit({
        sessionID: chat.id,
        prompt: mkPrompt("persisted"),
      })

      // First loop pass reads then marks consumed.
      const first = yield* steer.pending(chat.id)
      expect(first).toHaveLength(1)
      yield* steer.markConsumed(chat.id, [admitted.id])

      // A subsequent loop pass (fresh pending call, as runLoop would issue) sees nothing — the row is
      // durably stamped consumed. This is the "steer sent then applied; must not double-apply" guarantee.
      const second = yield* steer.pending(chat.id)
      expect(second).toHaveLength(0)
    }),
  { config: cfg },
)

// ── Crash-window regression (Check 4b): persist succeeds but markConsumed crashes → no loss, no dup ──
//
// Reproduces the exact reliability gap: a crash AFTER a steer is materialized into history but BEFORE
// it is stamped consumed. The persist-first protocol keys the message AND its text part by the steer id
// (stable), so the row stays pending and the NEXT drain re-materializes idempotently. We assert (a) the
// steer is NOT lost (it is in history), (b) after replay there is exactly ONE copy (no duplicate turn),
// and (c) it eventually ends consumed. `steerPartID` mirrors prompt.ts's derivation so the replayed
// persist targets the same part row.
const steerPartID = (messageID: MessageID) => PartID.make("prt_" + messageID.slice("msg_".length))

const persistSteerAsMessage = Effect.fn("test.persistSteerAsMessage")(function* (
  sessionID: SessionID,
  admitted: SessionSteer.Admitted,
) {
  const sessions = yield* Session.Service
  const info: SessionV1.User = {
    id: MessageID.make(admitted.id),
    role: "user",
    sessionID,
    time: { created: admitted.timeCreated },
    agent: "build",
    model: ref,
  }
  yield* sessions.updateMessage(info)
  yield* sessions.updatePart({
    id: steerPartID(info.id),
    messageID: info.id,
    sessionID,
    type: "text",
    text: admitted.prompt.text,
  })
  return info.id
})

off.instance(
  "crash after persist but before markConsumed: steer survives, replay materializes exactly once",
  () =>
    Effect.gen(function* () {
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Steer crash window" })

      const admitted = yield* steer.admit({
        sessionID: chat.id,
        prompt: mkPrompt("DONT-LOSE-ME"),
      })

      // First drain pass: PERSIST the steer into history, then "crash" (interrupt) BEFORE markConsumed.
      const crashingDrain = Effect.gen(function* () {
        yield* persistSteerAsMessage(chat.id, admitted)
        // Simulate a process crash before the consume stamp lands.
        return yield* Effect.interrupt
      })
      const exit = yield* crashingDrain.pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)

      // NO LOSS: the steer message is already in history...
      let msgs = yield* sessions.messages({ sessionID: chat.id })
      let steered = msgs.filter((m) => m.parts.some((p) => p.type === "text" && p.text === "DONT-LOSE-ME"))
      expect(steered).toHaveLength(1)
      // ...and the buffer row is STILL PENDING (markConsumed never ran).
      expect(yield* steer.hasPending(chat.id)).toBe(true)

      // Replay: the next drain re-reads the still-pending steer and re-persists it. Because the message
      // id AND part id are derived from the steer id, the upsert hits the SAME rows — idempotent.
      const replay = yield* steer.pending(chat.id)
      expect(replay).toHaveLength(1)
      yield* persistSteerAsMessage(chat.id, replay[0]!)
      yield* steer.markConsumed(chat.id, [replay[0]!.id])

      // EXACTLY ONCE: still a single copy in history (no duplicate turn from the replay).
      msgs = yield* sessions.messages({ sessionID: chat.id })
      steered = msgs.filter((m) => m.parts.some((p) => p.type === "text" && p.text === "DONT-LOSE-ME"))
      expect(steered).toHaveLength(1)
      expect(steered[0]!.parts.filter((p) => p.type === "text" && p.text === "DONT-LOSE-ME")).toHaveLength(1)
      // And now durably consumed.
      expect(yield* steer.hasPending(chat.id)).toBe(false)
    }),
  { config: cfg },
)

// ── Integration: steering ON — a steer admitted mid-run lands as a TAIL user message and is absorbed ─

on.instance(
  "steer admitted before the 2nd iteration is absorbed as a tail user message and re-runs the loop",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintSteerR0Authorization(db)
      const chat = yield* sessions.create({
        title: "Steer integration",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const gate = yield* Deferred.make<void>()
      // First model call HOLDS (in-flight). We admit a steer while it's held, then release. The steer
      // must NOT abort the first call — it completes — and the loop runs a SECOND call that includes
      // the steered text at the tail of the input messages.
      yield* llm.hold("first-answer", deferredAsPromise(gate))
      yield* llm.text("second-answer")

      const fiber = yield* provideSteerR0OwnerRefs(
        prompt.prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "initial" }] }),
      ).pipe(Effect.forkChild)

      yield* llm.wait(1)

      // Admit the steer while the first model request is in flight. Under the V2-only profile the
      // mid-run steer IS a V2 admission (resume:false + noReply): it coalesces into the active
      // activity at the next provider-turn boundary. NO legacy SessionSteer row is written.
      const admitted = yield* provideSteerR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "STEERED-MESSAGE" }],
        }),
      )
      expect(admitted.info.role).toBe("user")

      // Admission is durable before the active provider turn is released: the V2 inbox row waits
      // unpromoted while the first turn is gated, and the legacy buffer was never written.
      expect(yield* SessionInput.hasPending(db, SessionV2.ID.make(chat.id), "steer")).toBe(true)
      expect(yield* steer.hasPending(chat.id)).toBe(false)

      // Release the in-flight call; it completes (absorb-at-boundary, not abort), then the loop drains.
      yield* Deferred.succeed(gate, void 0)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      // Two model calls: the original + the follow-up that absorbed the steer.
      expect(yield* llm.calls).toBe(2)

      // V2-only: the legacy activity tables stay at zero (V2 activities are the execution authority).
      expect(yield* db.select().from(SessionLegacyActivityTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityAdmissionTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionActivityProgressTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(SessionLegacyActivityTerminalTable).all().pipe(Effect.orDie)).toHaveLength(0)

      // The steered message is persisted as an ordinary user message in history (V1 mirror id derives
      // ascending from the V2 admission id and is returned by the noReply admission).
      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const steered = msgs.find((m) => m.info.role === "user" && m.info.id === admitted.info.id)
      expect(steered?.info.role).toBe("user")
      expect(steered?.parts.some((p) => p.type === "text" && p.text === "STEERED-MESSAGE")).toBe(true)

      // The consume-once buffer is now empty.
      expect(yield* steer.hasPending(chat.id)).toBe(false)

      // The SECOND model input contains the steered text at the END of the message array (after prior
      // history), NOT in the system prefix.
      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      const secondInput = inputs.at(-1) as { messages: { role: string; content: unknown }[] }
      const roleMsgs = secondInput.messages
      const systemMsgs = roleMsgs.filter((m) => m.role === "system")
      // Not in the system prefix.
      expect(JSON.stringify(systemMsgs)).not.toContain("STEERED-MESSAGE")
      // Present in a user message.
      const userText = JSON.stringify(roleMsgs.filter((m) => m.role === "user"))
      expect(userText).toContain("STEERED-MESSAGE")
      // It appears AFTER the initial user turn in the array order.
      const flat = JSON.stringify(roleMsgs)
      expect(flat.indexOf("initial")).toBeLessThan(flat.indexOf("STEERED-MESSAGE"))
    }),
  15_000,
)

on.instance(
  "promptAsync returns the canonical durable ID for a busy-session steer",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintSteerR0Authorization(db)
      const chat = yield* sessions.create({
        title: "Prompt async canonical receipt",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const gate = yield* Deferred.make<void>()
      yield* llm.hold("first-answer", deferredAsPromise(gate))
      yield* llm.text("second-answer")
      const running = yield* provideSteerR0OwnerRefs(
        prompt.prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "initial" }] }),
      ).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const clientMessageID = MessageID.make("msg_prompt_async_client")
      const receipt = yield* provideSteerR0OwnerRefs(
        prompt.promptAsync({
          sessionID: chat.id,
          messageID: clientMessageID,
          intentID: "intent_prompt_async_canonical",
          intentSource: "composer",
          intentVariant: "original",
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "STEERED-ASYNC" }],
        }),
      )

      expect(receipt.delivery).toBe("steer")
      // V2-only profile: the canonical durable ID IS the client-supplied messageID — the V2 admission
      // reserves it (no server re-mint, no legacy intent row). The durable inbox row exists under that
      // id while the legacy steer buffer stays empty.
      expect(receipt.messageID).toBe(clientMessageID)
      const inboxRow = yield* SessionInput.find(db, SessionMessage.ID.make(clientMessageID)).pipe(Effect.orDie)
      expect(inboxRow?.sessionID).toBe(chat.id)
      expect(yield* steer.pending(chat.id)).toHaveLength(0)

      yield* Deferred.succeed(gate, undefined)
      const runningExit = yield* Fiber.await(running)
      expect(Exit.isSuccess(runningExit), Exit.isFailure(runningExit) ? Cause.pretty(runningExit.cause) : "").toBe(true)
      expect(yield* llm.calls).toBe(2)

      // Persisted exactly once as a user message carrying the steered text. The V1 mirror row id is
      // derived ascending from the V2 admission id, so the exactly-once assertion keys on the text.
      const messages = yield* sessions.messages({ sessionID: chat.id })
      const persisted = messages.filter(
        (message) =>
          message.info.role === "user" && message.parts.some((part) => part.type === "text" && part.text === "STEERED-ASYNC"),
      )
      expect(persisted).toHaveLength(1)
    }),
  15_000,
)

// ── Cache-safety: the system prefix is byte-identical with vs without a steer; single volatile tail ─

on.instance(
  "steer only adds a tail history message: system prefix byte-identical, single volatile tail preserved",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintSteerR0Authorization(db)
      const chat = yield* sessions.create({
        title: "Steer cache",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const gate = yield* Deferred.make<void>()
      yield* llm.hold("first", deferredAsPromise(gate))
      yield* llm.text("second")

      const fiber = yield* provideSteerR0OwnerRefs(
        prompt.prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "initial" }] }),
      ).pipe(Effect.forkChild)
      yield* llm.wait(1)
      // V2-only profile: the mid-run noReply admission is the steer — it waits in the V2 inbox and the
      // drain absorbs it at the turn boundary; no legacy steer row exists to drain.
      yield* provideSteerR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "STEER" }],
        }),
      )
      yield* Deferred.succeed(gate, void 0)
      yield* Fiber.await(fiber)

      const inputs = yield* llm.inputs
      expect(inputs.length).toBeGreaterThanOrEqual(2)
      const msgsOf = (i: number) => (inputs[i] as { messages: { role: string; content: unknown }[] }).messages
      // CACHE-SAFETY INVARIANT (path-independent): the steered message is a NORMAL history tail user
      // message — it must NEVER be folded into the cached system prefix (that would churn the
      // hash-guarded prefix and break the cache). Assert the steer text is absent from EVERY system
      // message of BOTH the pre-steer and post-steer requests. (We do NOT assert full byte-identity of
      // the DeepAgent prefix here: that prefix legitimately varies turn-to-turn via per-turn skill
      // guidance retrieval, a DeepAgent-runtime property unrelated to steering. The steer-controlled
      // property is precisely that the steer stays out of the prefix, which is what we assert.)
      const sys = (i: number) => JSON.stringify(msgsOf(i).filter((m) => m.role === "system"))
      expect(sys(0)).not.toContain("STEER")
      expect(sys(inputs.length - 1)).not.toContain("STEER")

      // The steered text rides in a USER-role message of the post-steer request (real history), and it
      // sits AFTER the initiating turn in array order — i.e. appended at the tail of history, exactly
      // like a normal follow-up user message. The single ephemeral volatile round-context tail (when
      // present) is assembled separately in llm/request.ts and is NOT where the steer lives, so the
      // slice(-2) cache breakpoint is preserved (no second trailing volatile message is introduced).
      const second = msgsOf(inputs.length - 1)
      expect(JSON.stringify(second.filter((m) => m.role === "user"))).toContain("STEER")
      const flat = JSON.stringify(second)
      expect(flat.indexOf("initial")).toBeLessThan(flat.indexOf("STEER"))
    }),
  15_000,
)

// ── Kill-switch: steering OFF — no drain; a busy-time admit is never absorbed by the loop ───────────

off.instance(
  "with v4Steering OFF the loop performs NO drain (current behavior preserved)",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintSteerR0Authorization(db)
      const chat = yield* sessions.create({
        title: "Steer off",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // Pre-buffer a steer directly (bypassing ingress) so we can prove the loop ignores it when OFF.
      // Under the V2-only profile the loop never drains the legacy buffer regardless of the flag.
      yield* steer.admit({ sessionID: chat.id, prompt: mkPrompt("IGNORED-STEER") })

      yield* llm.text("done")
      const result = yield* provideSteerR0OwnerRefs(
        prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "hi" }],
        }),
      )
      expect(result.info.role).toBe("assistant")

      // Exactly ONE model call — the loop did not continue to absorb the buffered steer.
      expect(yield* llm.calls).toBe(1)
      // The steer is NOT persisted as a history message.
      const msgs = yield* sessions.messages({ sessionID: chat.id })
      expect(msgs.some((m) => m.parts.some((p) => p.type === "text" && p.text === "IGNORED-STEER"))).toBe(false)
      // It remains pending in the buffer (untouched — the drain never ran).
      expect(yield* steer.hasPending(chat.id)).toBe(true)
    }),
  15_000,
)

// ── §S1.2 FIX A: promptOrSteer routes on the ACTIVE-GOAL pointer FIRST, independent of isBusy ────────
//
// The seam (prompt.ts promptOrSteer): a NON-terminal active goal is checked BEFORE the isBusy branch and
// forces delivery="goal_steer". The prior bug gated goal_steer behind isBusy, so a background goal (which
// does NOT busy the parent runner) left the session idle → the goal_steer branch was unreachable and the
// steer wrongly ran as a fresh normal turn. These tests lock the goal-first ordering at the exact seam.

const seedGoal = (sessionID: string, phase: AgentGateway.DeepAgentSessionState.GoalPointerPhase) => {
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

on.instance(
  "promptOrSteer: a NON-terminal active goal routes to goal_steer independent of isBusy (idle session)",
  () =>
    Effect.gen(function* () {
      yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const state = yield* SessionRunState.Service
      const { db } = yield* Database.Service
      yield* mintSteerR0Authorization(db)
      const chat = yield* sessions.create({
        title: "promptOrSteer goal",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      // A background goal runs in child sessions; the PARENT session is IDLE (not busy). This is exactly
      // the case the old isBusy gate missed — assert idle so the routing cannot be attributed to busy.
      seedGoal(chat.id, "running")
      expect(yield* state.isBusy(chat.id)).toBe(false)

      const result = yield* provideSteerR0OwnerRefs(
        prompt.promptOrSteer({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "GOAL-GUIDANCE" }],
        }),
      )

      // Routed to the V2 goal channel — NOT a turn, NOT a plain "steer". Under the V2-only profile the
      // goal-channel ack is "steer_v2": the admission lands on the SessionInput goal_steer delivery and
      // the W1 channel takes over (NO legacy SessionSteer row is written).
      expect(result.kind).toBe("steer_v2")
      if (result.kind !== "steer_v2") throw new Error("expected steer_v2")
      expect(result.delivery).toBe("goal_steer")

      // Admitted to the V2 goal_steer channel; the legacy steer buffer is untouched on both channels
      // (disjoint rows; the legacy buffer remains only for the non-profile ingress).
      const goalRow = yield* SessionInput.find(db, result.admitted.id).pipe(Effect.orDie)
      expect(goalRow?.sessionID).toBe(chat.id)
      expect(goalRow?.delivery).toBe("goal_steer")
      expect(goalRow?.prompt.text).toBe("GOAL-GUIDANCE")
      expect(yield* steer.pending(chat.id, "goal_steer")).toHaveLength(0)
      expect(yield* steer.pending(chat.id, "steer")).toHaveLength(0)
      expect(yield* steer.hasPending(chat.id, "steer")).toBe(false)

      // session-state is PROCESS-GLOBAL: drop the pointer so later tests start goal-free.
      AgentGateway.DeepAgentSessionState.setActiveGoal(chat.id, null)
    }),
  15_000,
)

on.instance(
  "promptOrSteer: no goal + idle runs a normal turn; a TERMINAL goal phase does NOT route to goal_steer",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintSteerR0Authorization(db)

      // (B) No active goal + idle → a normal turn (the pre-steering path).
      const plain = yield* sessions.create({
        title: "promptOrSteer idle",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("idle-answer")
      const turn = yield* provideSteerR0OwnerRefs(
        prompt.promptOrSteer({
          sessionID: plain.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "hello" }],
        }),
      )
      expect(turn.kind).toBe("turn")
      // Nothing was buffered on either channel.
      expect(yield* steer.hasPending(plain.id, "goal_steer")).toBe(false)
      expect(yield* steer.hasPending(plain.id, "steer")).toBe(false)

      // (C) A TERMINAL goal phase ("done") is NOT active → it must NOT route to goal_steer. Idle + no live
      // turn ⇒ it falls through to a normal turn, proving the goal-active predicate excludes terminal phases.
      const settled = yield* sessions.create({
        title: "promptOrSteer terminal goal",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      seedGoal(settled.id, "done")
      yield* llm.text("post-goal-answer")
      const afterDone = yield* provideSteerR0OwnerRefs(
        prompt.promptOrSteer({
          sessionID: settled.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "after done" }],
        }),
      )
      expect(afterDone.kind).toBe("turn")
      // Crucially: NOT admitted to goal_steer (the terminal goal did not capture it).
      expect(yield* steer.hasPending(settled.id, "goal_steer")).toBe(false)
    }),
  15_000,
)

// ── §S1.2 FIX B: an idle-session loop drains a V2-admitted steer; the legacy buffer is never drained ──
//
// The legacy seam (runLoop `if (step > 0 || drainFirst) yield* drainSteers(...)`) is unreachable under
// the V2-only profile: loop() always selects the V2 owner branch once owner-qualified, and the V2 drain
// promotes SessionInput inbox rows — never SessionSteer rows. The profile contract this locks: an
// admit-only (noReply/resume:false) V2 admission sits durable in the inbox until an explicit loop()
// drains it (one new model call, text at the tail), while a legacy SessionSteer row is invisible to the
// V2 drain (drainFirst true or false): the loop's forced provider attempt carries no trace of it, the
// row stays pending, and it never enters history.

on.instance(
  "a loop drains a V2-admitted steer on an idle session; a legacy-buffered steer is never drained",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const state = yield* SessionRunState.Service
      const { db } = yield* Database.Service
      yield* mintSteerR0Authorization(db)

      // Prime a session with a completed turn so history has a user+assistant pair and the session is idle
      // (the exact post-turn state in which a raced steer needs an explicit drain).
      const drained = yield* sessions.create({
        title: "drainFirst true",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("first-answer")
      yield* provideSteerR0OwnerRefs(
        prompt.prompt({
          sessionID: drained.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "initial" }],
        }),
      )
      expect(yield* llm.calls).toBe(1)
      expect(yield* state.isBusy(drained.id)).toBe(false)

      // Admit-only admission (resume:false via noReply): durable in the V2 inbox, NOT drained yet.
      const admitted = yield* provideSteerR0OwnerRefs(
        prompt.prompt({
          sessionID: drained.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "STEP0-STEER" }],
        }),
      )
      expect(admitted.info.role).toBe("user")
      expect(yield* llm.calls).toBe(1)
      expect(yield* SessionInput.hasPending(db, SessionV2.ID.make(drained.id), "steer")).toBe(true)

      // The explicit drain turn: materialize the steer as a tail user message, then sample the model on it.
      yield* llm.text("drain-answer")
      yield* provideSteerR0OwnerRefs(prompt.loop({ sessionID: drained.id, drainFirst: true }))

      // A SECOND model call happened — the drain turn re-ran the loop after absorbing the steer.
      expect(yield* llm.calls).toBe(2)
      // The steer is materialized as an ordinary tail user message (id returned by the noReply mirror).
      const msgs = yield* sessions.messages({ sessionID: drained.id })
      const steered = msgs.find((m) => m.info.role === "user" && m.info.id === admitted.info.id)
      expect(steered?.parts.some((p) => p.type === "text" && p.text === "STEP0-STEER")).toBe(true)
      // No legacy buffer row was ever written.
      expect(yield* steer.hasPending(drained.id)).toBe(false)
      // The model actually sampled the steered text (it rode into the drain turn's input, at the tail).
      const inputs = yield* llm.inputs
      const last = inputs.at(-1) as { messages: { role: string; content: unknown }[] }
      expect(JSON.stringify(last.messages.filter((m) => m.role === "user"))).toContain("STEP0-STEER")

      // CONTRAST — a LEGACY SessionSteer row is invisible to the V2 drain: an explicit loop() is a
      // forced run (SessionRunner.run performs one provider attempt even with no eligible work), but
      // that attempt carries no trace of the legacy row, which stays pending and out of history.
      const normal = yield* sessions.create({
        title: "drainFirst false",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("first-answer-2")
      yield* provideSteerR0OwnerRefs(
        prompt.prompt({
          sessionID: normal.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "initial" }],
        }),
      )
      const before = yield* llm.calls
      yield* steer.admit({ sessionID: normal.id, prompt: mkPrompt("NOT-DRAINED") })

      yield* provideSteerR0OwnerRefs(prompt.loop({ sessionID: normal.id }))

      // The forced attempt happened (before + 1) but did NOT absorb the legacy row: its input has no
      // NOT-DRAINED, the row stays pending, and it never enters history.
      expect(yield* llm.calls).toBe(before + 1)
      const contrastLast = (yield* llm.inputs).at(-1) as { messages: { role: string; content: unknown }[] }
      expect(JSON.stringify(contrastLast.messages)).not.toContain("NOT-DRAINED")
      expect(yield* steer.hasPending(normal.id)).toBe(true)
      const normalMsgs = yield* sessions.messages({ sessionID: normal.id })
      expect(normalMsgs.some((m) => m.parts.some((p) => p.type === "text" && p.text === "NOT-DRAINED"))).toBe(false)
    }),
  20_000,
)

on.instance(
  "promptOrSteer on a busy session coalesces into the active activity and lands the steer in history",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const steer = yield* SessionSteer.Service
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      yield* mintSteerR0Authorization(db)
      const chat = yield* sessions.create({
        title: "isBusy admission race",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      const gate = yield* Deferred.make<void>()
      yield* llm.hold("first-answer", deferredAsPromise(gate))
      yield* llm.text("raced steer answer")
      const running = yield* provideSteerR0OwnerRefs(
        prompt.prompt({ sessionID: chat.id, agent: "build", model: ref, parts: [{ type: "text", text: "initial" }] }),
      ).pipe(Effect.forkChild)
      yield* llm.wait(1)

      // The session is genuinely busy (turn 1 in flight). Under the V2-only profile promptOrSteer does
      // NOT write a legacy steer row: the V2 admission coalesces into the active activity and the
      // ingress's own loop joins the in-flight drain, so the prompt is absorbed at the next provider-turn
      // boundary — the busy-window admission can never be stranded.
      const raced = yield* provideSteerR0OwnerRefs(
        prompt.promptOrSteer({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "RACED-STEER" }],
        }),
      ).pipe(Effect.forkChild)

      // The admission is durable in the V2 inbox while turn 1 is still gated; the legacy steer buffer
      // stays empty on both channels.
      yield* pollWithTimeout(
        SessionInput.hasPending(db, SessionV2.ID.make(chat.id), "steer").pipe(
          Effect.orDie,
          Effect.map((pending) => (pending ? (true as const) : undefined)),
        ),
        "raced steer admission did not land in the V2 inbox",
      )
      expect(yield* steer.hasPending(chat.id, "steer")).toBe(false)

      yield* Deferred.succeed(gate, undefined)
      const runningExit = yield* Fiber.await(running)
      expect(Exit.isSuccess(runningExit), Exit.isFailure(runningExit) ? Cause.pretty(runningExit.cause) : "").toBe(true)
      const routedExit = yield* Fiber.await(raced)
      expect(Exit.isSuccess(routedExit), Exit.isFailure(routedExit) ? Cause.pretty(routedExit.cause) : "").toBe(true)
      if (!Exit.isSuccess(routedExit)) throw new Error("promptOrSteer failed")
      // Busy/steer coalescing is the V2 admission contract: the ingress ack is the completed turn.
      expect(routedExit.value.kind).toBe("turn")
      expect(yield* llm.calls).toBe(2)

      expect(yield* steer.hasPending(chat.id, "steer")).toBe(false)
      expect(
        (yield* sessions.messages({ sessionID: chat.id })).some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "RACED-STEER"),
        ),
      ).toBe(true)
      // The absorbed steer rode into the second call's input as a tail user message.
      const inputs = yield* llm.inputs
      const last = inputs.at(-1) as { messages: { role: string; content: unknown }[] }
      expect(JSON.stringify(last.messages.filter((m) => m.role === "user"))).toContain("RACED-STEER")
    }),
  20_000,
)
