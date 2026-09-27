import { projectLayer } from "./fixture/project-layer"
import { describe, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  TransportReason,
  ProviderInternalReason,
  InvalidRequestReason,
  NoRouteReason,
  type LLMClientShape,
  type LLMRequest,
} from "@deepagent-code/llm"
import { AgentGateway } from "../src/agent-gateway"
import { DeepAgentActivityAuthority, DeepAgentPlanStore } from "../src/deepagent"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import * as OpenAIResponses from "@deepagent-code/llm/protocols/openai-responses"
import { Database } from "@deepagent-code/core/database/database"
import { CompactionRequestTable } from "../src/session/compaction-request.sql"
import { SessionContextCheckpointTable, SessionModelPolicyReceiptTable } from "../src/session/long-context.sql"
import { EventV2 } from "@deepagent-code/core/event"
import { Hash } from "@deepagent-code/core/util/hash"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { PermissionSaved } from "@deepagent-code/core/permission/saved"
import { PermissionTable } from "@deepagent-code/core/permission/sql"
import { EventTable } from "@deepagent-code/core/event/sql"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { QuestionV2 } from "@deepagent-code/core/question"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { TaskTool } from "@deepagent-code/core/tool/task"
import { ContextSnapshotDecodeError } from "@deepagent-code/core/session/error"
import { SessionEvent } from "@deepagent-code/core/session/event"
import { SessionInput } from "@deepagent-code/core/session/input"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import { SessionContextEpoch } from "@deepagent-code/core/session/context-epoch"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import * as SessionRunnerLLM from "@deepagent-code/core/session/runner/llm"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import {
  ProductionV2Sources,
  type ProductionV2AdapterInput,
  type ProductionV2LocationIdentity,
} from "@deepagent-code/core/context-federation/production-adapters"
import {
  CurrentRuntimeFeatures,
  createRuntimeFeatureRegistry,
  type RuntimeFeatureRegistry,
} from "@deepagent-code/core/flag/runtime-features"
import { LocationKey, ProjectScopeKey, SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2ToolEffect } from "@deepagent-code/core/session/runner/v2-tool-effect"
import { V2ToolEffectAdmissionTable, V2ToolEffectTable } from "@deepagent-code/core/session/runner/v2-tool-effect.sql"
import {
  V2ProviderParityReceiptTable,
  V2ProviderTurnReceiptTable,
} from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import { SessionCompaction } from "@deepagent-code/core/session/compaction"
import { PreparedProviderTurn } from "@deepagent-code/core/session/runner/prepared-provider-turn"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { createPlanDoc, planScope, type PlanStep } from "@deepagent-code/core/deepagent/plan-controller"
import { planStoreRoot } from "@deepagent-code/core/deepagent/plan-store"
import {
  configure as configureSessionState,
  getOrCreate as getOrCreateSessionState,
  setActiveGoal as setActiveGoalPointer,
} from "@deepagent-code/core/deepagent/session-state"
import {
  makeGoalLoop,
  type ControllerDeps,
  type GraderPorts,
  type RollbackPort,
  type StepExecutor,
} from "@deepagent-code/core/deepagent/goal-loop"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { ToolOutputStore } from "@deepagent-code/core/tool-output-store"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Config } from "@deepagent-code/core/config"
import { ConfigAgent } from "@deepagent-code/core/config/agent"
import { ConfigCompaction } from "@deepagent-code/core/config/compaction"
import { Catalog } from "@deepagent-code/core/catalog"
import { Tool } from "@deepagent-code/core/tool/tool"
import { recoverReadDefect } from "@deepagent-code/core/tool/read-failure"
import {
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@deepagent-code/core/session/sql"
import { SessionActivityTable, SessionContextSelectionTable, SessionProviderAttemptTable } from "@deepagent-code/core/context-federation/session-sql"
import { SessionActivityProgressObservationTable } from "@deepagent-code/core/deepagent/activity-authority.sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SystemContext } from "@deepagent-code/core/system-context"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { makeCapabilityLoadTool } from "@deepagent-code/core/system-context/capability-load-tool"
import { capabilityBodyFor } from "@deepagent-code/core/system-context/capability-bodies"
import { SkillGuidance } from "@deepagent-code/core/skill/guidance"
import { ModelV2 } from "@deepagent-code/core/model"
import { Location } from "@deepagent-code/core/location"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { ProviderV2 } from "@deepagent-code/core/provider"
import {
  Cause,
  Context,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  LayerMap,
  Option,
  Schema,
  Stream,
} from "effect"
import { systemError } from "effect/PlatformError"
import { asc, desc, eq, sql } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { tmpRoot, tmpRootShared } from "./fixture/tmpdir"

const database = Database.layerFromPath(":memory:")
// W3.6: the runner appends selection evidence as a chronological system update after projected
// history. The harness has no production graph sources wired, so the four graphs resolve as:
const selectionEvidence = [
  "Context selection (this turn):",
  "- code: degraded_unavailable [rev code:unavailable] [adapter version code-intelligence.v1] (0 refs)",
  "- documents: degraded_unavailable [rev documents:unavailable] [adapter version documents-union.v1] (0 refs)",
  "- knowledge: empty [rev released:no-store] [adapter version released-knowledge.v1] (0 refs)",
  "- memory: empty [rev memory:no-store] [adapter version durable-memory.v1] (0 refs)",
].join("\n")
const withSelection = (parts: string[]) => parts
let currentSelectionIdentity: ProductionV2LocationIdentity | undefined
const selectionSources: ProductionV2AdapterInput = {
  get identity() {
    return currentSelectionIdentity
  },
}
const selectionSourcesLayer = Layer.succeed(ProductionV2Sources, selectionSources)
const providerTurns = V2ProviderTurn.layer.pipe(
  Layer.provide(SessionProviderOwner.layer.pipe(Layer.provide(database))),
  Layer.provide(database),
)
const events = EventV2.layer.pipe(Layer.provide(database))
const questions = QuestionV2.layer.pipe(Layer.provide(events))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const requests: LLMRequest[] = []
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined
// One-shot sealed streams served in order (call 1, call 2, ...).
let responseStreams: Array<Stream.Stream<LLMEvent, LLMError>> | undefined
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
let streamFailure: LLMError | undefined
let toolExecutionGate: Deferred.Deferred<void> | undefined
let toolExecutionsStarted: Deferred.Deferred<void> | undefined
let toolExecutionsReady = 5
let activeToolExecutions = 0
let maxActiveToolExecutions = 0
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      if (responseStream) {
        const stream = responseStream
        responseStream = undefined
        return stream
      }
      if (responseStreams !== undefined) {
        const stream = responseStreams.shift()
        if (stream !== undefined) return stream
      }
      const events = streamFailure
        ? Stream.fail(streamFailure)
        : Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
      if (!streamGate) return events
      return Stream.unwrap(
        (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(streamGate)),
          Effect.as(events),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const replacementModel = Model.make({ id: "replacement", provider: "fake", route: OpenAIChat.route })
const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 6_000, output: 50 } }),
})
const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})
// design §5.3 (C2-05): remote compact is a Responses-only feature, so the remote-compaction tests
// drive a Responses-route recovery model (the fake transport returns the same events regardless).
const responsesRecoveryModel = Model.make({
  id: "responses-recovery",
  provider: "fake",
  route: OpenAIResponses.route.with({ limits: { context: 20_000, output: 1_000 } }),
})
// B4 budget-warning tests: a window large enough that the harness compaction buffer (3_000) puts
// the trigger at 95%, leaving the ≥90% warning tier reachable without provoking compaction.
const budgetModel = Model.make({
  id: "budget",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 60_000, output: 1_000 } }),
})
const managedCompactModel = Model.make({
  id: "deepseek-flash",
  provider: "deepseek",
  route: OpenAIChat.route.with({ limits: { context: 4_000, output: 50 } }),
})
const managedObservationModel = Model.make({
  id: "deepseek-flash",
  provider: "deepseek",
  route: OpenAIChat.route.with({ limits: { context: 1_000_000, output: 50 } }),
})
const managedCatalogEntry = ModelV2.Info.empty(ProviderV2.ID.make("deepseek"), ModelV2.ID.make("deepseek-flash"))
const managedNoToolInfo = new ModelV2.Info({
  ...managedCatalogEntry,
  api: {
    id: managedCatalogEntry.id,
    type: "aisdk",
    package: "@ai-sdk/openai-compatible",
    url: "https://api.deepseek.com/v1",
    protocol: "openai-compatible.chat",
  },
})
const authorizations: Tool.Context[] = []
const permissionAssertions: PermissionV2.AssertInput[] = []
const executions: string[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    currentNoProgressOwnerID: () => Effect.succeed("v2-no-progress:test"),
    assert: (input) =>
      Effect.sync(() => {
        permissionAssertions.push(input)
      }),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const applications = ApplicationTools.layer
const registry = ToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(applications),
  Layer.provide(ToolOutputStore.defaultLayer),
)
const agents = AgentV2.layer
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, context) =>
          Effect.gen(function* () {
            authorizations.push(context)
            executions.push(text)
            activeToolExecutions++
            maxActiveToolExecutions = Math.max(maxActiveToolExecutions, activeToolExecutions)
            if (activeToolExecutions === toolExecutionsReady && toolExecutionsStarted) {
              yield* Deferred.succeed(toolExecutionsStarted, undefined)
            }
            if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => activeToolExecutions--))),
      }),
      defect: Tool.make({
        description: "Fail unexpectedly",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => Effect.die("unexpected tool defect"),
      }),
    }),
  ),
).pipe(Layer.provide(registry))
let modelResolveHook = Effect.void
let pricingLookupHook = Effect.void
let requireSessionModel = false
let currentModel = model
let currentModelInfo: ModelV2.Info | undefined
let currentPricingInfo: ModelV2.Info | undefined
const models = SessionRunnerModel.layerWith((session) =>
  modelResolveHook.pipe(
    Effect.flatMap(() =>
      requireSessionModel && !session.model
        ? Effect.fail(new SessionRunnerModel.ModelNotSelectedError({ sessionID: session.id }))
        : Effect.succeed({
            model: session.model?.id === "replacement" ? replacementModel : currentModel,
            ...(currentModelInfo ? { info: currentModelInfo } : {}),
          }),
    ),
  ),
)
const systemContextKey = SystemContext.Key.make("test/context")
let systemBaseline = "Initial context"
let systemRemoved = false
let systemUnavailable = false
let systemLoadHook = Effect.void
const skillBaselines = new Map<AgentV2.ID, string>()
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine(
            systemRemoved
              ? []
              : [
                  SystemContext.make({
                    key: systemContextKey,
                    codec: Schema.toCodecJson(Schema.String),
                    load: systemLoadHook.pipe(
                      Effect.andThen(
                        Effect.sync(() => (systemUnavailable ? SystemContext.unavailable : systemBaseline)),
                      ),
                    ),
                    baseline: String,
                    update: (_previous, current) => current,
                    removed: () => "System context source removed: test/context",
                  }),
                ],
          ),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(SystemContextRegistry.layer))
const location = Location.layer({ directory: AbsolutePath.make("/project") }).pipe(Layer.provide(projectLayer(database)))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: (agent) =>
    Effect.succeed(
      skillBaselines.has(agent.id)
        ? SystemContext.make({
            key: SystemContext.Key.make("test/skill-guidance"),
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(skillBaselines.get(agent.id)!),
            baseline: String,
            update: (_previous, current) => current,
            removed: () => "Skill guidance removed",
          })
        : SystemContext.empty,
    ),
})
const config = Layer.suspend(() =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({
              compaction: new ConfigCompaction.Info({
                buffer: 3_000,
                keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
              }),
              ...(configAgents === undefined ? {} : { agents: configAgents }),
            }),
          }),
        ]),
    }),
  ),
)
const noAutoConfig = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([new Config.Document({
      type: "document",
      info: new Config.Info({ compaction: new ConfigCompaction.Info({ auto: false }) }),
    })]),
  }),
)
const catalog = Layer.succeed(
  Catalog.Service,
  Catalog.Service.of({
    transform: () => Effect.die("unexpected catalog.transform"),
    provider: {
      get: () => Effect.die("unexpected catalog.provider.get"),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
    },
    model: {
      get: (providerID, modelID) =>
        pricingLookupHook.pipe(
          Effect.andThen(
            Effect.suspend(() =>
              currentPricingInfo
                ? Effect.succeed(currentPricingInfo)
                : Effect.fail(new Catalog.ModelNotFoundError({ providerID, modelID })),
            ),
          ),
        ),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
      default: () => Effect.succeed(Option.none<ModelV2.Info>()),
      small: () => Effect.succeed(Option.none<ModelV2.Info>()),
    },
  }),
)
// Config-level agent overrides for the drain-ceiling fallback tests (the production path: the
// AgentV2 registry is empty in the app runtime, so the budget arrives through config discovery).
let configAgents: Record<string, ConfigAgent.Info> | undefined
const testOwnerAuthorization = Layer.succeed(
  V2ProviderTurn.OwnerAuthorization,
  V2ProviderTurn.OwnerAuthorization.of({ authorize: () => Effect.succeed(true) }),
)
const sessionContext = SessionContext.layer.pipe(
  Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
  Layer.provide(database),
)
// Grant lookup wired through the optional capability seam: active only when a test opts in, so
// the default runner composition stays grant-less exactly like compositions without the V2
// permission capability.
let grantLookupActive = false
const permissionGrantLookup = (input: {
  readonly sessionID: string
  readonly toolCallID: string
  readonly toolName: string
}) =>
  Effect.succeed(
    (grantLookupActive
      ? [
          {
            receiptID: `grant_receipt_${input.toolCallID}`,
            ownerID: "grant_owner_1",
            state: "settled",
            version: 3,
          },
        ]
      : []) as readonly {
      readonly receiptID: string
      readonly ownerID: string
      readonly state: "started" | "settled" | "unknown"
      readonly version: number
    }[],
  )
const grantLookupLayer = Layer.succeedContext(
  Context.make(V2ToolEffect.CurrentPermissionGrantLookup, permissionGrantLookup),
)
// §16.3 order 4 — history-epoch bridge seam: same opt-in pattern as the grant lookup. When
// historyEpochValue is set, wired turns must record it as the receipt's history_prompt_epoch
// instead of the ContextEpoch revision.
let historyEpochValue: number | undefined
const historyEpochLookupLayer = Layer.succeedContext(
  Context.make(V2ProviderTurn.CurrentHistoryEpochLookup, (_sessionID: string) => Effect.succeed(historyEpochValue)),
)
// §16.3 order 5 F3 — remote compaction seam. remoteCompactionMode: undefined = unwired (local
// dispatch), "summary" = remote authority produces the summary, "fault" = remote faults (design §5.3:
// enters compact recovery — the remote result is unknown and is NEVER disguised as a local success),
// "refused" = the producer raises a TYPED refusal (W1.3: keeps its specific reason code).
let remoteCompactionMode: "summary" | "fault" | "refused" | undefined
let remoteCompactionCalls = 0
const remoteCompactionLayer = Layer.succeedContext(
  Context.make(SessionCompaction.CurrentRemoteCompaction, (_input) =>
    Effect.sync(() => remoteCompactionCalls++).pipe(Effect.andThen(
      remoteCompactionMode === "summary"
        ? Effect.succeed({ kind: "compacted" as const, summary: "## Remote\n- remote summary" })
        : remoteCompactionMode === "refused"
          ? Effect.fail(new SessionCompaction.RemoteCompactRefusedError({ reason: "network_unknown" }))
          : Effect.fail(new Error("remote compaction unavailable")),
    )),
  ),
)
// W7 — settle-hook recorder: verifies the runner invokes the injected hook once per settled drain
// (the deepagent-code composition injects the durable-learning admission there).
let settleHookInputs: SessionRunner.OnSessionSettledInput[] = []
const settleHookLayer = Layer.succeedContext(
  Context.make(SessionRunner.CurrentOnSessionSettled, (input) =>
    Effect.sync(() => {
      settleHookInputs.push(input)
    }),
  ),
)
const gateway = Layer.succeed(
  AgentGateway.Runtime,
  AgentGateway.Runtime.of({
    get snapshot() {
      return AgentGateway.snapshot()
    },
    get active() {
      return AgentGateway.isActiveDeepAgentRuntime()
    },
    get baseDir() {
      return AgentGateway.learningAuthorityConfig().baseDir
    },
    get runsDir() {
      return AgentGateway.learningAuthorityConfig().runsDir
    },
    get selfLearning() {
      return AgentGateway.selfLearningPolicy()
    },
    get durableLearning() {
      return AgentGateway.durableLearningEnabled()
    },
    withStorage: (operation) => operation(),
    ensureKnowledgeSeeded: AgentGateway.flushKnowledgeSeed,
    systemPrompt: AgentGateway.systemPrompt,
    volatileRoundContext: AgentGateway.volatileRoundContext,
    volatileContinuationContext: AgentGateway.volatileContinuationContext,
  }),
)
// The runner stack is a function of the runtime-feature registry so a test can run the WHOLE
// composition against an explicit registry (e.g. the `=false` staged fallback) — the process
// global is an immutable startup snapshot, so flipping env mid-test is intentionally unobservable.
const runnerStack = (features?: RuntimeFeatureRegistry, gitLayer = Git.defaultLayer, configLayer = config) => {
  const base =
    features === undefined
      ? SessionRunnerLLM.layer
      : SessionRunnerLLM.layer.pipe(Layer.provide(Layer.succeed(CurrentRuntimeFeatures, features)))
  return base.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(gitLayer),
    Layer.provide(providerTurns),
    Layer.provide(V2ToolEffect.layer.pipe(Layer.provide(database))),
    Layer.provide(grantLookupLayer),
    Layer.provide(historyEpochLookupLayer),
    Layer.provide(remoteCompactionLayer),
    Layer.provide(sessionContext),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(events),
    Layer.provide(Layer.mergeAll(client, permission)),
    Layer.provide(registry),
    Layer.provide(models),
    Layer.provide(systemContext),
    Layer.provide(location),
    Layer.provide(agents),
    Layer.provide(skillGuidance),
    Layer.provide(configLayer),
    Layer.provide(
      Layer.mergeAll(
        catalog,
        selectionSourcesLayer,
        ContextQueryAuthorization.defaultLayer,
        testOwnerAuthorization,
        settleHookLayer,
        gateway,
      ),
    ),
  )
}
const locationsFor = (runnerLayer: ReturnType<typeof runnerStack>) =>
  Layer.effect(
    LocationServiceMap,
    LayerMap.make(() => runnerLayer).pipe(
      // This harness supplies its instrumented runner as the complete keyed Location tree.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      Effect.map((service) => service as unknown as LocationServiceMap["Service"]),
    ),
  )
const executionFor = (runnerLayer: ReturnType<typeof runnerStack>) =>
  SessionExecutionLocal.layer.pipe(
    Layer.provide(events),
    Layer.provide(store),
    Layer.provide(TaskTool.delegationSlotLayer),
    Layer.provide(locationsFor(runnerLayer)),
  )
const sessionsFor = (runnerLayer: ReturnType<typeof runnerStack>) =>
  SessionV2.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(projectLayer(database)),
    Layer.provide(executionFor(runnerLayer)),
  )
// The production root carries Database.Service INTO the Location runner trees (app-runtime pipes
// Layer.provideMerge(Database.defaultLayer)), which is how the Core `task` tool's durable TaskRun
// authority reaches the ledger from inside a Location-scoped settle fiber. The harness must
// mirror that topology: the runner tree exposes Database.Service.
const runner = runnerStack().pipe(Layer.provideMerge(database))
const locations = locationsFor(runner)
const execution = executionFor(runner)
const sessions = sessionsFor(runner)
const containedRunner = SessionRunnerLLM.defaultLayer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(providerTurns),
  Layer.provide(V2ToolEffect.layer.pipe(Layer.provide(database))),
  Layer.provide(grantLookupLayer),
  Layer.provide(historyEpochLookupLayer),
  Layer.provide(sessionContext),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(events),
  Layer.provide(client),
  Layer.provide(registry),
  Layer.provide(models),
  Layer.provide(systemContext),
  Layer.provide(location),
  Layer.provide(agents),
  Layer.provide(skillGuidance),
  Layer.provide(config),
  Layer.provide(
    Layer.mergeAll(catalog, ContextQueryAuthorization.defaultLayer, Layer.succeed(ProductionV2Sources, {}), gateway),
  ),
)
const containedLocations = Layer.effect(
  LocationServiceMap,
  LayerMap.make(() => containedRunner).pipe(
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    Effect.map((service) => service as unknown as LocationServiceMap["Service"]),
  ),
)
const containedExecution = SessionExecutionLocal.layer.pipe(
  Layer.provide(events),
  Layer.provide(store),
  Layer.provide(containedLocations),
  Layer.provide(TaskTool.delegationSlotLayer),
)
const containedSessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projectLayer(database)),
  Layer.provide(containedExecution),
)
const it = testEffect(
  Layer.mergeAll(
    database,
    providerTurns,
    events,
    questions,
    projector,
    store,
    client,
    permission,
    applications,
    agents,
    registry,
    echo,
    models,
    systemContext,
    sessionContext,
    location,
    skillGuidance,
    config,
    Layer.mergeAll(
      runner,
      locations,
      execution,
      sessions,
      TaskTool.layer.pipe(Layer.provide(registry), Layer.provide(agents), Layer.provide(permission)),
      // Same memoized slot the fake map trees carry: capture the live SessionV2 service once.
      TaskTool.captureDelegationServiceLayer.pipe(Layer.provide(TaskTool.delegationSlotLayer), Layer.provide(sessions)),
    ),
  ),
)
const contained = testEffect(
  Layer.mergeAll(
    database,
    providerTurns,
    events,
    questions,
    projector,
    store,
    client,
    permission,
    applications,
    agents,
    registry,
    echo,
    models,
    systemContext,
    location,
    skillGuidance,
    config,
    Layer.mergeAll(containedRunner, containedLocations, containedExecution, containedSessions),
  ),
)
// W3.8 staged-fallback stack: the WHOLE composition runs against an explicit `=false` registry —
// the kill-switch resolves at process start (immutable snapshot), so the staged path is tested by
// injecting the registry at the runner layer, never by flipping process.env mid-test.
const stagedFeatures = createRuntimeFeatureRegistry(undefined, {
  DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION: "false",
})
const stagedRunner = runnerStack(stagedFeatures)
const staged = testEffect(
  Layer.mergeAll(
    database,
    providerTurns,
    events,
    questions,
    projector,
    store,
    client,
    permission,
    applications,
    agents,
    registry,
    echo,
    models,
    systemContext,
    location,
    skillGuidance,
    config,
    Layer.mergeAll(stagedRunner, locationsFor(stagedRunner), executionFor(stagedRunner), sessionsFor(stagedRunner)),
  ),
)
const noAutoRunner = runnerStack(undefined, Git.defaultLayer, noAutoConfig).pipe(Layer.provideMerge(database))
const noAuto = testEffect(
  Layer.mergeAll(
    database,
    providerTurns,
    events,
    questions,
    projector,
    store,
    client,
    permission,
    applications,
    agents,
    registry,
    echo,
    models,
    systemContext,
    location,
    skillGuidance,
    noAutoConfig,
    Layer.mergeAll(noAutoRunner, locationsFor(noAutoRunner), executionFor(noAutoRunner), sessionsFor(noAutoRunner)),
  ),
)
// Hold the observable workspace revision steady while exercising the real runner, authority,
// permission service, projector, and execution coordinator across multiple provider turns.
const unchangedGit = Layer.effect(
  Git.Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    return Git.Service.of({ ...git, patch: () => Effect.succeed(""), head: () => Effect.succeed("test-head") })
  }),
).pipe(Layer.provide(Git.defaultLayer))
const governedRunner = runnerStack(undefined, unchangedGit).pipe(Layer.provideMerge(database))
const governed = testEffect(
  Layer.mergeAll(
    database,
    providerTurns,
    events,
    projector,
    store,
    client,
    agents,
    registry,
    models,
    systemContext,
    location,
    skillGuidance,
    config,
    PermissionV2.layer.pipe(
      Layer.provide(events),
      Layer.provide(location),
      Layer.provide(agents),
      Layer.provide(store),
      Layer.provide(PermissionSaved.layer.pipe(Layer.provide(database))),
      Layer.provide(database),
    ),
    Layer.mergeAll(
      governedRunner,
      locationsFor(governedRunner),
      executionFor(governedRunner),
      sessionsFor(governedRunner),
    ),
  ),
)
const sessionID = SessionV2.ID.make("ses_runner_test")
const otherSessionID = SessionV2.ID.make("ses_runner_other")

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
        v2_authority: true,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  // AgentGateway is a PROCESS-GLOBAL: a prior test (in this file or another) that called
  // AgentGateway.configure({enabled:true}) leaves the DeepAgent runtime active, which prepends the
  // DeepAgent system prompt ("我是 DeepAgent Code…") and makes these transport tests' system-array
  // assertions order-dependent (green alone, red after a DeepAgent test). Reset to the DISABLED default
  // at the start of every test so the baseline is deterministic; the tests that specifically exercise the
  // DeepAgent prompt opt in explicitly with their own configure({enabled:true}).
  AgentGateway.configure({ enabled: false, agentMode: "high" })
  response = []
  systemBaseline = "Initial context"
  systemRemoved = false
  systemUnavailable = false
  systemLoadHook = Effect.void
  modelResolveHook = Effect.void
  pricingLookupHook = Effect.void
  requireSessionModel = false
  currentSelectionIdentity = undefined
  currentModel = model
  currentModelInfo = undefined
  currentPricingInfo = undefined
  skillBaselines.clear()
  configAgents = undefined
  responses = undefined
  streamFailure = undefined
  responseStream = undefined
  responseStreams = undefined
  remoteCompactionCalls = 0
  streamGate = undefined
  streamStarted = undefined
  toolExecutionGate = undefined
  toolExecutionsStarted = undefined
  toolExecutionsReady = 5
  activeToolExecutions = 0
  maxActiveToolExecutions = 0
  settleHookInputs = []
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

const registerSwitchAgents = AgentV2.Service.use((agents) =>
  agents.update((editor) => {
    editor.update(AgentV2.defaultID, (agent) => {
      agent.mode = "primary"
    })
    editor.update(AgentV2.ID.make("reviewer"), (agent) => {
      agent.mode = "primary"
    })
    editor.default(AgentV2.defaultID)
  }),
)

const seedStaleTool = Effect.fn("SessionRunnerTest.seedStaleTool")(function* (callID: string) {
  const eventService = yield* EventV2.Service
  const assistantMessageID = SessionMessage.ID.create()
  yield* eventService.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    timestamp: yield* DateTime.now,
    agent: "build",
    model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
  })
  yield* eventService.publish(SessionEvent.Tool.Called, {
    sessionID,
    timestamp: yield* DateTime.now,
    assistantMessageID,
    callID,
    tool: "echo",
    input: { text: "must remain running" },
    provider: { executed: false },
  })
})

const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable" }),
  })

const sealedResponse = (events: readonly LLMEvent[], label: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const seal = yield* V2ProviderTurn.CurrentRequestSeal
      if (!seal) return yield* Effect.die("V2 request seal is missing")
      yield* seal
        .seal({
          wireHash: Hash.sha256(`${label}:wire`),
          bodyHash: Hash.sha256(`${label}:body`),
          bodyLength: label.length,
          contentType: "application/json",
        })
        .pipe(Effect.orDie)
      return Stream.fromIterable(events)
    }),
  )

// Non-transport provider failure for terminal-path tests that specifically exercise route refusal.
const providerRefused = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new NoRouteReason({
      route: "openai-chat",
      provider: "fake" as never,
      model: "fake-model" as never,
    }),
  })

const setupOverflowRecovery = Effect.gen(function* () {
  yield* setup
  const session = yield* SessionV2.Service
  response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
  yield* session.prompt({
    sessionID,
    prompt: new Prompt({ text: "Earlier question ".repeat(700) }),
    resume: false,
  })
  yield* session.resume(sessionID)
  currentModel = recoveryModel
  requests.length = 0
  return session
})

const setupManualHistory = Effect.gen(function* () {
  yield* setup
  const session = yield* SessionV2.Service
  const execution = yield* SessionExecution.Service
  responses = [
    fragmentFixture("text", "manual-first", ["first settled reply"]).completeEvents,
    fragmentFixture("text", "manual-second", ["second settled reply"]).completeEvents,
  ]
  yield* session.prompt({ sessionID, prompt: new Prompt({ text: "first exchange" }) })
  yield* execution.awaitIdle(sessionID)
  yield* session.prompt({ sessionID, prompt: new Prompt({ text: "second exchange" }) })
  yield* execution.awaitIdle(sessionID)
  requests.length = 0
  return session
})

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

// B4: the volatile budget notice/warning rides as a chronological system message whose text starts
// with "BUDGET ".
const budgetNotices = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "system"
      ? message.content.flatMap((content) =>
          content.type === "text" && content.text.startsWith("BUDGET ") ? [content.text] : [],
        )
      : [],
  )

// The percentage the runner measured for THIS request: same estimateInputUsage the turn
// preparation used, over the request minus the notice itself (the notice never feeds back into
// the percentage that produced it).
const measuredBudgetPercent = (request: LLMRequest, notice: string, model: Model) => {
  const usage = SessionCompaction.estimateInputUsage(model, {
    system: request.system,
    messages: request.messages.filter(
      (message) =>
        !(
          message.role === "system" && message.content.some((content) => content.type === "text" && content.text === notice)
        ),
    ),
    tools: request.tools,
  })
  if (usage === undefined) throw new Error("expected the model to declare an input limit")
  return Math.round((usage.tokens / usage.context) * 100)
}

const replaySessionProjection = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* events.remove(id)
    // Durable admission/canonical authorities (inputs, activities, selections, attempts,
    // receipts) survive a projection replay exactly as they survive a production crash; the
    // projector accepts exact re-projection of admitted/promoted events. Only the message
    // projection is rebuilt.
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* events.replayAll(
      recorded.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
    )
  })

type FragmentKind = "text" | "reasoning" | "tool input"

type FragmentFixture = {
  readonly delta: EventV2.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent = { type: "text", id, text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent = { type: "reasoning", id, text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent = { type: "tool", id, state: { status: "pending", input: text } }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedAssistant: { type: "assistant", content: [expectedContent] },
        expectedContent,
      }
    }
  }
}

const verifyEphemeralDeltas = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Stream ${kind}`
    const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
    const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
    const expectedContext = [{ type: "user", text: prompt }, fixture.expectedAssistant]
    yield* session.prompt({ sessionID, prompt: new Prompt({ text: prompt }), resume: false })
    const events = yield* EventV2.Service
    const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    response = fixture.completeEvents

    yield* session.resume(sessionID)

    const { db } = yield* Database.Service
    const deltas = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(fixture.delta.type, 1)))
      .all()
      .pipe(Effect.orDie)
    expect(Array.from(yield* Fiber.join(live))).toHaveLength(32)
    expect(deltas).toHaveLength(0)
    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)

    yield* replaySessionProjection(sessionID)

    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)
  })

const verifyPartialFlushOnFailure = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Fail after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "partial"), ["Partial"])
    const failure = providerUnavailable()
    yield* session.prompt({ sessionID, prompt: new Prompt({ text: prompt }), resume: false })
    responseStream = Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure))

    expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider unavailable" },
        content: [fixture.expectedContent],
      },
    ])
  })

const verifyPartialFlushOnInterruption = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Interrupt after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
    const streamed = yield* Deferred.make<void>()
    yield* session.prompt({ sessionID, prompt: new Prompt({ text: prompt }), resume: false })
    responseStream = Stream.concat(
      Stream.fromIterable(fixture.partialEvents),
      Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
    )

    const fiber = yield* session.resume(sessionID).pipe(Effect.forkChild)
    yield* Deferred.await(streamed)
    yield* session.interrupt(sessionID)
    yield* Fiber.await(fiber)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        content: [
          kind === "tool input"
            ? { type: "tool", id: fragmentID(kind, "interrupted"), state: { status: "error" } }
            : fixture.expectedContent,
        ],
      },
    ])
  })

describe("SessionRunnerLLM", () => {
  for (const reply of ["once", "always", "reject"] as const) {
    governed.effect(`V2 no-progress ${reply} reply resumes or ends the same activity`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const permission = yield* PermissionV2.Service
        const { db } = yield* Database.Service
        const truncated = [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "length" }),
          LLMEvent.finish({ reason: "length" }),
        ]
        responseStreams = [
          sealedResponse(truncated, "no-progress-1"),
          sealedResponse(truncated, "no-progress-2"),
          sealedResponse(truncated, "no-progress-3"),
          sealedResponse(fragmentFixture("text", "after-approval", ["Done"]).completeEvents, "approved"),
        ]
        requests.length = 0
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Finish the unchanged task" }), resume: false })
        yield* session.resume(sessionID)

        const [activity] = yield* db
          .select()
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        expect(activity).toBeDefined()
        const ref = { activityKind: "v2" as const, activityID: activity!.activity_id }
        const stalled = yield* DeepAgentActivityAuthority.reconstruct(ref)
        const observations = yield* db
          .select()
          .from(SessionActivityProgressObservationTable)
          .where(eq(SessionActivityProgressObservationTable.activity_id, activity!.activity_id))
          .orderBy(asc(SessionActivityProgressObservationTable.revision))
          .all()
          .pipe(Effect.orDie)
        expect(observations.map((row) => row.no_progress_count)).toEqual([0, 1, 2])
        expect(requests).toHaveLength(3)
        expect(stalled.objective).toMatchObject({ state: "needs_human", terminalReason: "no_progress" })
        const [challenge] = yield* permission.forSession(sessionID)
        expect(challenge).toMatchObject({ action: "doom_loop", metadata: { kind: "no_progress" } })
        expect((yield* DeepAgentActivityAuthority.permissionRequestForRequest(challenge!.id))?.state).toBe("pending")

        yield* session.resume(sessionID)
        expect(requests).toHaveLength(3)
        yield* permission.reply({ requestID: challenge!.id, reply })
        expect(yield* permission.forSession(sessionID)).toEqual([])
        expect((yield* DeepAgentActivityAuthority.permissionDecisionForRequest(challenge!.id))?.decision).toBe(
          reply === "once" ? "approved_once" : reply === "always" ? "approved_always" : "interrupted",
        )
        if (reply === "reject") {
          expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective.state).toBe("interrupted")
          yield* session.resume(sessionID)
          expect(requests).toHaveLength(3)
          expect((yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.activity_id, activity!.activity_id)).get().pipe(Effect.orDie))?.state).toBe("interrupted")
          return
        }

        expect((yield* DeepAgentActivityAuthority.reconstruct(ref)).objective.state).toBe("active")
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(4)
        expect((yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.activity_id, activity!.activity_id)).get().pipe(Effect.orDie))?.state).toBe("settled")
        expect((yield* session.context(sessionID)).at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
        if (reply === "always")
          expect(yield* db.select().from(PermissionTable).where(eq(PermissionTable.action, "doom_loop")).all().pipe(Effect.orDie)).toMatchObject([{ resource: "activity" }])
      }),
    )
  }

  for (const [providerID, apiModelID, policyKey] of [
    ["deepseek", "deepseek-v4-pro", "deepseek-v4-pro"],
    ["deepseek", "deepseek-flash", "deepseek-v4-flash"],
    ["moonshotai", "kimi-k3", "kimi-k3"],
    ["zhipuai", "glm-5.2", "glm-5.2"],
  ] as const) {
    it.effect(`blocks ${apiModelID} before any provider attempt with a real assembled request`, () =>
      Effect.gen(function* () {
        yield* setup
        currentModel = Model.make({
          id: apiModelID,
          provider: providerID,
          route: OpenAIChat.route.with({ limits: { context: 4_096, output: 50 } }),
        })
        const session = yield* SessionV2.Service
        const { db } = yield* Database.Service
        requests.length = 0
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "long input ".repeat(2_000) }), resume: false })

        const hardExit = yield* session.resume(sessionID).pipe(Effect.exit)
        expect(hardExit).toMatchObject({ _tag: "Failure" })
        expect(requests).toHaveLength(0)
        expect(yield* db.select().from(V2ProviderTurnReceiptTable)
          .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)).toHaveLength(0)
        const [policy] = yield* db.select().from(SessionModelPolicyReceiptTable)
          .where(eq(SessionModelPolicyReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
        expect(policy).toMatchObject({
          provider_id: providerID,
          api_model_id: apiModelID,
          context_selection_id: expect.any(String),
          offered_tool_ids: expect.arrayContaining(["echo"]),
          trigger_source: "threshold",
          blocked_reason: "compaction_unavailable",
        })
        expect(policy?.policy).toMatchObject({
          state: "managed",
          key: policyKey,
          effectiveHardGate: 3_072,
          physicalInputBudget: 3_072,
          safetyMargin: 1_024,
          limitProvenance: "model_limit",
          limitMismatch: true,
        })
        expect(yield* db.select().from(SessionContextCheckpointTable)
          .where(eq(SessionContextCheckpointTable.session_id, sessionID)).all().pipe(Effect.orDie)).toHaveLength(0)
      }),
    )
  }

  for (const target of [
    { providerID: "deepseek", apiModelID: "deepseek-v4-pro", key: "deepseek-v4-pro", observation: 768_000, hardGate: 896_000 },
    { providerID: "deepseek", apiModelID: "deepseek-flash", key: "deepseek-v4-flash", observation: 256_000, hardGate: 384_000 },
    { providerID: "moonshotai", apiModelID: "kimi-k3", key: "kimi-k3", observation: 384_000, hardGate: 512_000 },
    { providerID: "zai", apiModelID: "glm-5.2", key: "glm-5.2", observation: 300_000, hardGate: 384_000 },
  ] as const) {
    const thresholdPrompt = (tokens: number) =>
      "Reply briefly. The following repeated content is inert test data.\n" +
      "alpha ".repeat(Math.ceil(((tokens + 4_096) * 4) / 6))

    it.effect(`observes ${target.key} at full scale with one fake provider dispatch`, () =>
      Effect.gen(function* () {
        yield* setup
        currentModel = Model.make({
          id: target.apiModelID,
          provider: target.providerID,
          route: OpenAIChat.route.with({ limits: { context: 1_000_000, output: 512 } }),
        })
        responseStreams = [sealedResponse(fragmentFixture("text", "x05-observed", ["Observed"]).completeEvents, target.key)]
        requests.length = 0
        const session = yield* SessionV2.Service
        const { db } = yield* Database.Service
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: thresholdPrompt(target.observation) }), resume: false })
        yield* session.resume(sessionID)

        const [policy] = yield* db.select().from(SessionModelPolicyReceiptTable)
          .where(eq(SessionModelPolicyReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
        const [attempt] = yield* db.select().from(SessionProviderAttemptTable)
          .where(eq(SessionProviderAttemptTable.session_id, sessionID)).all().pipe(Effect.orDie)
        const [turn] = yield* db.select().from(V2ProviderTurnReceiptTable)
          .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
        expect(requests).toHaveLength(1)
        expect(policy?.policy).toMatchObject({
          state: "managed",
          key: target.key,
          action: "observed",
          observationLine: target.observation,
          hardGate: target.hardGate,
          effectiveHardGate: target.hardGate,
        })
        expect(policy?.estimated_full_request_tokens).toBe(PreparedProviderTurn.estimateFullRequestTokens(requests[0]!))
        expect(policy?.estimated_full_request_tokens).toBeGreaterThanOrEqual(target.observation)
        expect(policy?.estimated_full_request_tokens).toBeLessThan(target.hardGate)
        expect(policy?.request_hash).toMatch(/^[0-9a-f]{64}$/)
        expect(policy?.context_selection_id).toBeTruthy()
        expect(policy?.context_projection_hash).toBeTruthy()
        expect(policy?.offered_tool_ids).toEqual(requests[0]!.tools.map((tool) => tool.name))
        expect(policy?.degraded_tool_ids).toEqual([])
        expect(requests[0]!.messages.flatMap((message) => message.content)
          .filter((part) => part.type === "text" && part.text.includes("Context selection (this turn):"))).toHaveLength(1)
        expect(policy?.provider_attempt_id).toBe(attempt?.attempt_id)
        expect(turn?.provider_attempt_id).toBe(attempt?.attempt_id)
        expect(attempt?.state).toBe("settled")
        expect(turn?.state).toBe("settled")
        expect(yield* db.select().from(SessionContextCheckpointTable)
          .where(eq(SessionContextCheckpointTable.session_id, sessionID)).all().pipe(Effect.orDie)).toHaveLength(0)
      }),
    )

    noAuto.effect(`blocks ${target.key} at its physical hard gate before fake provider dispatch`, () =>
      Effect.gen(function* () {
        yield* setup
        currentModel = Model.make({
          id: target.apiModelID,
          provider: target.providerID,
          route: OpenAIChat.route.with({ limits: { context: 1_000_000, output: 512 } }),
        })
        requests.length = 0
        const session = yield* SessionV2.Service
        const { db } = yield* Database.Service
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: thresholdPrompt(target.hardGate) }), resume: false })
        expect((yield* session.resume(sessionID).pipe(Effect.exit))._tag).toBe("Failure")

        const [policy] = yield* db.select().from(SessionModelPolicyReceiptTable)
          .where(eq(SessionModelPolicyReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
        expect(policy?.policy).toMatchObject({
          state: "managed",
          key: target.key,
          action: "hard_gate_blocked",
          hardGate: target.hardGate,
          effectiveHardGate: target.hardGate,
        })
        expect(policy?.estimated_full_request_tokens).toBeGreaterThanOrEqual(target.hardGate)
        expect(policy?.trigger_source).toBe("threshold")
        expect(policy?.blocked_reason).toBe("auto_compaction_disabled")
        expect(policy?.provider_attempt_id).toBeNull()
        expect(requests).toHaveLength(0)
        expect(yield* db.select().from(SessionProviderAttemptTable)
          .where(eq(SessionProviderAttemptTable.session_id, sessionID)).all().pipe(Effect.orDie)).toHaveLength(0)
        expect(yield* db.select().from(V2ProviderTurnReceiptTable)
          .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)).toHaveLength(0)
        expect(yield* db.select().from(SessionContextCheckpointTable)
          .where(eq(SessionContextCheckpointTable.session_id, sessionID)).all().pipe(Effect.orDie)).toHaveLength(0)
      }),
    )
  }

  it.effect("hard-gate compaction does not dispatch a summary beyond the physical input budget", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      response = fragmentFixture("text", "budget-earlier", ["Earlier settled"]).completeEvents
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "x".repeat(38_000) }), resume: false })
      yield* session.resume(sessionID)

      currentModel = Model.make({
        id: "deepseek-flash",
        provider: "deepseek",
        route: OpenAIChat.route.with({ limits: { context: 10_000, output: 512 } }),
      })
      currentModelInfo = managedNoToolInfo
      requests.length = 0
      responses = [fragmentFixture("text", "unsafe-hard-summary", ["summary must not dispatch"]).completeEvents]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue after the long history" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)

      const policies = yield* db.select().from(SessionModelPolicyReceiptTable)
        .where(eq(SessionModelPolicyReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
      const policy = policies.findLast((row) => row.policy.state === "managed")
      expect(policy?.policy).toMatchObject({ state: "managed", action: "hard_gate_compact" })
      expect(policy?.blocked_reason).toBe("compaction_unavailable")
      expect(requests).toHaveLength(0)
      expect(yield* db.select().from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie))
        .toHaveLength(1)
    }),
  )

  it.effect("commits a checkpoint before hard-gate compaction and rebuilds the selected request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      response = fragmentFixture("text", "hard-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      currentModel = managedCompactModel
      currentModelInfo = managedNoToolInfo
      requests.length = 0
      responses = [
        fragmentFixture("text", "hard-summary", ["## Goal\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "hard-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recent exact request ".repeat(500) }),
        resume: false,
      })
      expect(yield* session.resume(sessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Success" })

      expect(requests).toHaveLength(2)
      expect(requests[0]?.tools).toEqual([])
      expect(userTexts(requests[1])[0]).toContain("<summary>\n## Goal\n- Preserve the task\n</summary>")
      expect(JSON.stringify(requests[1]?.messages)).toContain("Context checkpoint (durable authority references")
      const [checkpoint] = yield* db.select().from(SessionContextCheckpointTable)
        .where(eq(SessionContextCheckpointTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(checkpoint).toMatchObject({ session_id: sessionID, activity_id: expect.any(String) })
      expect(checkpoint?.content).toMatchObject({
        schema_version: "context_checkpoint.v1",
        context_selection_refs: expect.arrayContaining([expect.stringMatching(/^selection:/)]),
        source_selection_id: expect.any(String),
        projection_hash: expect.any(String),
        graph_revisions: expect.any(String),
        graph_statuses: expect.any(String),
        selected_refs: expect.any(String),
        goal: { plan_ref: null, goal_ref: expect.stringMatching(/^activity_objective:v2:/), state: "active" },
        task_refs: [],
        approval_refs: [],
        evidence_refs: [],
        degraded: expect.arrayContaining(["plan_authority_unavailable", "retained_tail_boundary_unbound"]),
      })
      const policies = yield* db.select().from(SessionModelPolicyReceiptTable)
        .where(eq(SessionModelPolicyReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(policies.some((row) => row.checkpoint_id === checkpoint?.checkpoint_id && row.checkpoint_hash === checkpoint?.content_hash)).toBe(true)
      expect(policies).toHaveLength(3)
      expect(policies.filter((row) => row.policy.state === "unmanaged")).toHaveLength(1)
      const managedPolicies = policies.filter((row) => row.policy.state === "managed")
      expect(managedPolicies).toHaveLength(2)
      expect(managedPolicies.find((row) => row.checkpoint_id !== null)?.context_selection_id).not.toBe(
        managedPolicies.find((row) => row.checkpoint_id === null)?.context_selection_id,
      )
      expect((yield* db.select().from(SessionContextSelectionTable)
        .where(eq(SessionContextSelectionTable.session_id, sessionID)).all().pipe(Effect.orDie)).length).toBeGreaterThanOrEqual(2)

      // A modified artifact cannot be projected into another provider turn after restart/resume.
      yield* db.update(SessionContextCheckpointTable).set({ content: { tampered: true } })
        .where(eq(SessionContextCheckpointTable.checkpoint_id, checkpoint!.checkpoint_id)).pipe(Effect.orDie)
      requests.length = 0
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue after restart" }), resume: false })
      expect(yield* session.resume(sessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("keeps the prompt epoch unchanged when a hard-gate summary is empty", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      response = fragmentFixture("text", "hard-earlier", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)
      const [before] = yield* db.select().from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID)).all().pipe(Effect.orDie)

      currentModel = managedCompactModel
      currentModelInfo = managedNoToolInfo
      requests.length = 0
      responses = [[]]
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recent exact request ".repeat(500) }),
        resume: false,
      })
      expect(yield* session.resume(sessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })

      const [after] = yield* db.select().from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(after?.revision).toBe(before?.revision)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools).toEqual([])
      expect(yield* db.select().from(SessionContextCheckpointTable)
        .where(eq(SessionContextCheckpointTable.session_id, sessionID)).all().pipe(Effect.orDie)).toHaveLength(1)
      const policies = yield* db.select().from(SessionModelPolicyReceiptTable)
        .where(eq(SessionModelPolicyReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(policies.find((row) => row.blocked_reason === "compaction_unavailable")?.provider_attempt_id).toBeNull()
      expect(yield* db.select().from(SessionProviderAttemptTable)
        .where(eq(SessionProviderAttemptTable.session_id, sessionID)).all().pipe(Effect.orDie)).toHaveLength(2)
    }),
  )

  it.effect("records an observation at full-request scale without a model-facing reminder or compaction", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = managedObservationModel
      currentModelInfo = managedNoToolInfo
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      response = fragmentFixture("text", "observed", ["Observed answer"]).completeEvents
      requests.length = 0
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "x".repeat(1_030_000) }), resume: false })
      expect(yield* session.resume(sessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Success" })

      expect(requests).toHaveLength(1)
      expect(budgetNotices(requests[0]!)).toHaveLength(0)
      const [policy] = yield* db.select().from(SessionModelPolicyReceiptTable)
        .where(eq(SessionModelPolicyReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(policy?.policy).toMatchObject({ state: "managed", action: "observed" })
      expect(policy?.degraded_tool_ids).toEqual(expect.arrayContaining(["echo", "defect", "task"]))
      expect(policy?.trigger_source).toBe("none")
      const [receipt] = yield* db.select().from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(receipt?.provider_id).toBe("deepseek")
      expect(policy?.provider_attempt_id).toBe(receipt?.provider_attempt_id)
      expect(PreparedProviderTurn.estimateFullRequestTokens(requests[0]!)).toBe(policy?.estimated_full_request_tokens)
      expect(yield* db.select().from(SessionContextCheckpointTable)
        .where(eq(SessionContextCheckpointTable.session_id, sessionID)).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )

  it.effect("W7: invokes the injected onSessionSettled hook once after a settled drain", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "w7-text", ["W7 answer"]).completeEvents
      requests.length = 0
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "W7 settle" }), resume: false })
      yield* session.resume(sessionID)

      expect(settleHookInputs).toHaveLength(1)
      expect(settleHookInputs[0]?.sessionID).toBe(sessionID)
      // The workspace path is the runner's Location project root (informational; the deepagent-code
      // admission derives its authoritative workspacePath from the canonical Session row).
      expect(settleHookInputs[0]?.workspacePath).toBe("/")
      expect(settleHookInputs[0]?.activityId).toMatch(/^activity_/)
    }),
  )

  it.effect("does not dispatch a forced empty Session without a durable provider receipt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const emptySessionID = SessionV2.ID.make("ses_forced_empty_receipt")
      yield* insertSession(emptySessionID)

      requests.length = 0
      yield* session.resume(emptySessionID)

      expect(requests).toEqual([])
      expect(
        yield* db
          .select()
          .from(V2ProviderTurnReceiptTable)
          .where(eq(V2ProviderTurnReceiptTable.session_id, emptySessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(yield* session.context(emptySessionID)).toEqual([])
    }),
  )

  it.effect("advertises and executes a globally attached application tool", () =>
    Effect.gen(function* () {
      yield* setup
      const applicationTools = yield* ApplicationTools.Service
      const session = yield* SessionV2.Service
      const contexts: Tool.Context[] = []
      yield* applicationTools.register({
        application_context: Tool.make({
          description: "Read application context",
          input: Schema.Struct({ query: Schema.String }),
          output: Schema.Struct({ answer: Schema.String }),
          execute: ({ query }, context) =>
            Effect.sync(() => {
              contexts.push(context)
              return { answer: query.toUpperCase() }
            }),
        }),
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Use application context" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-application", name: "application_context", input: { query: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("application_context")
      expect(contexts).toEqual([
        {
          sessionID,
          agent: AgentV2.ID.make("auto"),
          assistantMessageID: expect.stringMatching(/^msg_/),
          toolCallID: "call-application",
        },
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use application context" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-application",
              state: { status: "completed", structured: { answer: "HELLO" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("starts a real runner turn after default prompt recording", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []

      const message = yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Run automatically" }) })

      expect(requests).toHaveLength(1)
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: message.id, type: "user", text: "Run automatically" },
      ])
    }),
  )

  it.effect("records the bridged history epoch on the turn receipt when the seam is wired", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      historyEpochValue = 42
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          historyEpochValue = undefined
        }),
      )
      requests.length = 0
      responses = undefined
      response = []
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Epoch bridge turn" }) })
      const receipts = yield* db
        .select()
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(receipts.length).toBeGreaterThan(0)
      // The receipt identity tracks the durable history-window boundary supplied by the bridge,
      // not the ContextEpoch revision.
      expect(receipts.at(-1)?.history_prompt_epoch).toBe(42)
    }),
  )

  it.effect("keeps the ContextEpoch revision identity when the epoch lookup yields nothing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      historyEpochValue = undefined
      requests.length = 0
      responses = undefined
      response = []
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "No epoch bridge" }) })
      const receipts = yield* db
        .select()
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(receipts.length).toBeGreaterThan(0)
      // Absent lookup result degrades to the pre-seam identity (fresh session: ContextEpoch
      // revision 0), exactly like compositions without the seam.
      expect(receipts.at(-1)?.history_prompt_epoch).toBe(0)
    }),
  )

  it.effect("records parity from the production V2 runner after the exact wire seal", () =>
    Effect.gen(function* () {
      yield* setup
      const campaign = {
        id: "runner-production-parity",
        case: "admission_activity" as const,
        evidence: ["shadow_snapshot", "recorded_provider", "real_session_replay"] as const,
      }
      process.env.DEEPAGENT_CODE_V2_PARITY_CAMPAIGN = campaign.id
      process.env.DEEPAGENT_CODE_V2_PARITY_CASE = campaign.case
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          delete process.env.DEEPAGENT_CODE_V2_PARITY_CAMPAIGN
          delete process.env.DEEPAGENT_CODE_V2_PARITY_CASE
        }),
      )
      const session = yield* SessionV2.Service
      const service = yield* V2ProviderTurn.Service
      const { db } = yield* Database.Service
      const events = fragmentFixture("text", "text-parity", ["Parity"]).completeEvents
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Record production parity" }), resume: false })
      responseStream = Stream.unwrap(
        Effect.gen(function* () {
          const seal = yield* V2ProviderTurn.CurrentRequestSeal
          if (!seal) return yield* Effect.die("V2 request seal is missing")
          yield* seal
            .seal({
              wireHash: Hash.sha256("runner-production-parity-wire"),
              bodyHash: Hash.sha256("runner-production-parity-body"),
              bodyLength: 31,
              contentType: "application/json",
            })
            .pipe(Effect.orDie)
          const receipt = yield* db.select().from(V2ProviderTurnReceiptTable).get().pipe(Effect.orDie)
          if (!receipt?.prepared_turn)
            return yield* Effect.die("V2 prepared turn was not sealed before provider execution")
          const legacyReceiptID = "legacy-runner-production-parity"
          const legacy = {
            ...receipt.prepared_turn,
            owner: "legacy_native" as const,
            receipt_id: legacyReceiptID,
          }
          const triggers = yield* db
            .all<{
              name: string
            }>(sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'session_tool_request_receipt'`)
            .pipe(Effect.orDie)
          yield* Effect.forEach(
            triggers,
            (trigger) => {
              if (!/^[A-Za-z0-9_]+$/.test(trigger.name)) return Effect.die("Invalid SQLite trigger name")
              return db.run(sql.raw(`DROP TRIGGER ${trigger.name}`)).pipe(Effect.orDie)
            },
            { discard: true },
          )
          yield* db
            .run(
              sql`
              INSERT INTO session_tool_request_receipt (
                receipt_id, request_ordinal, session_id, user_message_id, provider_id, model_id, protocol,
                registry_tool_ids, permission_filtered_tool_ids, final_offered_tool_ids, call_ids,
                request_state, provider_state, prepared_turn_hash, wire_request_hash, response_fingerprint, created_at
              ) VALUES (
                ${legacyReceiptID}, ${legacy.request_ordinal}, ${legacy.session_id}, ${legacy.user_message_id},
                ${legacy.sampling_provider_id}, ${legacy.sampling_model_id}, ${"openai-chat"},
                ${"[]"}, ${"[]"}, ${"[]"}, ${"[]"}, ${"prepared"}, ${"prepared"},
                ${legacy.request_hash}, ${legacy.wire_request_hash}, ${null}, ${Date.now()}
              )
            `,
            )
            .pipe(Effect.orDie)
          yield* service
            .recordBaselinePrepared({ campaign, legacyReceiptId: legacyReceiptID, preparedTurn: legacy })
            .pipe(Effect.orDie)
          const fingerprint = Hash.sha256("runner-production-parity-response")
          yield* db
            .run(
              sql`UPDATE session_tool_request_receipt
              SET provider_state = ${"settled"}, response_fingerprint = ${fingerprint}
              WHERE receipt_id = ${legacyReceiptID}`,
            )
            .pipe(Effect.orDie)
          yield* service
            .settleBaseline({
              campaign,
              legacyReceiptId: legacyReceiptID,
              outcomeArtifact: events,
              legacyResponseFingerprint: fingerprint,
            })
            .pipe(Effect.orDie)
          return Stream.fromIterable(events)
        }),
      )

      yield* session.resume(sessionID)

      expect(yield* db.select().from(V2ProviderParityReceiptTable).all().pipe(Effect.orDie)).toMatchObject([
        {
          campaign_id: campaign.id,
          case_name: campaign.case,
          verified: true,
          evidence: ["real_session_replay", "recorded_provider", "shadow_snapshot"],
        },
      ])
      expect(yield* service.parityVerified(campaign.id)).toBe(false)
    }),
  )

  contained.effect("rejects an unverified V2 owner campaign before the provider call", () =>
    Effect.gen(function* () {
      yield* setup
      process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN = "runner-owner-incomplete"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN
        }),
      )
      const session = yield* SessionV2.Service
      requests.length = 0
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Do not dispatch" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(0)
    }),
  )

  contained.effect("rejects a parity campaign before V2 receipt, provider, or tool effects", () =>
    Effect.gen(function* () {
      yield* setup
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN
          delete process.env.DEEPAGENT_CODE_V2_PARITY_CAMPAIGN
          delete process.env.DEEPAGENT_CODE_V2_PARITY_CASE
        }),
      )
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-contained", name: "echo", input: { text: "must not execute" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Do not run parity" }), resume: false })
      yield* seedStaleTool("call-stale-before-owner-gate")
      const contextBefore = yield* session.context(sessionID)

      const rejections: string[] = []
      yield* Effect.forEach(
        [
          { id: "no-campaign" },
          { id: "owner-only", owner: "runner-contained-owner" },
          { id: "parity-only", parity: "runner-contained-parity" },
        ] as const,
        (attempt) =>
          Effect.gen(function* () {
            delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN
            delete process.env.DEEPAGENT_CODE_V2_PARITY_CAMPAIGN
            delete process.env.DEEPAGENT_CODE_V2_PARITY_CASE
            if ("owner" in attempt) process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN = attempt.owner
            if ("parity" in attempt) {
              process.env.DEEPAGENT_CODE_V2_PARITY_CAMPAIGN = attempt.parity
              process.env.DEEPAGENT_CODE_V2_PARITY_CASE = "admission_activity"
            }
            const error = yield* session.resume(sessionID).pipe(Effect.flip)
            if (!(error instanceof V2ProviderTurn.ConflictError))
              return yield* Effect.die(`Unexpected contained runner error: ${error._tag}`)
            expect(error.reason).toBe("v2_owner_campaign_not_verified")
            rejections.push(`${attempt.id}:${error.reason}`)
            expect(JSON.stringify(yield* session.context(sessionID))).toBe(JSON.stringify(contextBefore))
          }),
        { discard: true },
      )
      const receipts = yield* db.select().from(V2ProviderTurnReceiptTable).all().pipe(Effect.orDie)
      const contextAfter = yield* session.context(sessionID)
      const staleToolStateMutations = JSON.stringify(contextAfter) === JSON.stringify(contextBefore) ? 0 : 1
      expect(rejections).toEqual([
        "no-campaign:v2_owner_campaign_not_verified",
        "owner-only:v2_owner_campaign_not_verified",
        "parity-only:v2_owner_campaign_not_verified",
      ])
      expect(receipts).toHaveLength(0)
      expect(requests).toHaveLength(0)
      expect(authorizations).toHaveLength(0)
      expect(executions).toHaveLength(0)
      expect(staleToolStateMutations).toBe(0)
    }),
  )

  it.effect("rejects an authorized mixed owner and parity mode before stale tool cleanup", () =>
    Effect.gen(function* () {
      yield* setup
      process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN = "runner-mixed-owner"
      process.env.DEEPAGENT_CODE_V2_PARITY_CAMPAIGN = "runner-mixed-parity"
      process.env.DEEPAGENT_CODE_V2_PARITY_CASE = "admission_activity"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          delete process.env.DEEPAGENT_CODE_V2_OWNER_CAMPAIGN
          delete process.env.DEEPAGENT_CODE_V2_PARITY_CAMPAIGN
          delete process.env.DEEPAGENT_CODE_V2_PARITY_CASE
        }),
      )
      const session = yield* SessionV2.Service
      requests.length = 0
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Reject mixed execution modes" }), resume: false })
      yield* seedStaleTool("call-stale-before-mixed-mode-gate")
      const contextBefore = yield* session.context(sessionID)

      const error = yield* session.resume(sessionID).pipe(Effect.flip)
      if (!(error instanceof V2ProviderTurn.ConflictError))
        return yield* Effect.die(`Unexpected mixed-mode runner error: ${error._tag}`)
      expect(error.reason).toBe("v2_owner_cannot_record_shadow_parity")
      expect(requests).toHaveLength(0)
      expect(yield* session.context(sessionID)).toEqual(contextBefore)
    }),
  )

  it.effect("streams one request with registry definitions from chronological V2 user history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect", "task"])
      expect(requests[0]?.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "user", content: [{ type: "text", text: "Second" }] },
        { role: "system", content: [{ type: "text", text: selectionEvidence }] },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(2)
    }),
  )

  it.effect("retries the first provider turn after system context becomes available", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.create()
      systemUnavailable = true
      yield* session.prompt({ id: messageID, sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SystemContext.InitializationBlocked)
      expect(requests).toHaveLength(0)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      systemUnavailable = false
      yield* session.prompt({ id: messageID, sessionID, prompt: new Prompt({ text: "First" }) })
      yield* (yield* SessionExecution.Service).awaitIdle(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "system"])
    }),
  )

  it.effect("interrupts a source Location runner after a Session moves", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: { directory: AbsolutePath.make("/moved") },
      })
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
    }),
  )

  it.effect("fails gracefully when a stored context snapshot cannot be decoded", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      response = []
      yield* session.resume(sessionID)
      yield* db
        .update(SessionContextEpochTable)
        .set({ snapshot: { invalid: { value: "bad" } } })
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ContextSnapshotDecodeError)
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("does not create a source Location epoch after a concurrent Session move", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      let moved = false
      systemLoadHook = Effect.suspend(() => {
        if (moved) return Effect.void
        moved = true
        return events
          .publish(SessionEvent.Moved, {
            sessionID,
            timestamp: DateTime.makeUnsafe(1),
            location: { directory: AbsolutePath.make("/moved") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()
      expect((yield* session.get(sessionID)).location.directory).toBe(AbsolutePath.make("/moved"))
    }),
  )

  it.effect("reuses one durable baseline after the context producer changes", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        withSelection(["Initial context"]),
        withSelection(["Initial context"]),
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system", "system"])
      expect(requests[1]?.messages.at(-2)?.content).toEqual([{ type: "text", text: "Changed context" }])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.context.updated.1"))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("includes the effective default agent system before durable context", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.update((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-build", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(
        withSelection(["Build agent instructions", "Initial context"]),
      )
    }),
  )

  it.effect("filters model-visible tools with the same Session restrictions enforced by leaves", () =>
    Effect.gen(function* () {
      yield* setup
      yield* (yield* Database.Service).db
        .update(SessionTable)
        .set({ permission: [{ action: "echo", resource: "*", effect: "deny" }] })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Do not expose denied tools" }), resume: false })

      requests.length = 0
      responseStream = sealedResponse(
        fragmentFixture("text", "text-session-permission", ["Done"]).completeEvents,
        "permission-filtered-tools",
      )
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["defect", "task"])
      const receipt = yield* (yield* Database.Service).db
        .select()
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(receipt?.prepared_turn).toMatchObject({
        tool_registry_ids: ["defect", "echo", "task"],
        tool_permission_filtered_ids: ["defect", "task"],
        tool_final_offered_ids: ["defect", "task"],
        context_readiness: "fallback",
        context_selected_refs: [],
      })
    }),
  )

  it.effect("keeps task schema finalizers tool-free at the provider boundary", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "Convert the persisted result to JSON without reading again",
          metadata: { deepagent_code_task_finalizer: true },
        }),
        resume: false,
      })
      requests.length = 0
      responseStream = sealedResponse(
        fragmentFixture("text", "task-finalizer", ['{"result":"done"}']).completeEvents,
        "task-finalizer-no-tools",
      )
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools).toEqual([])
      expect(requests[0]?.toolChoice).toMatchObject({ type: "none" })
      const receipt = yield* (yield* Database.Service).db
        .select()
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(receipt?.prepared_turn).toMatchObject({ tool_choice: "none", tool_final_offered_ids: [] })
    }),
  )

  it.effect("forwards a durable child mode override into the gateway request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({
          text: "Finish the delegated task",
          metadata: { deepagent: { agent_mode_override: "xhigh" } },
        }),
        resume: false,
      })
      requests.length = 0
      responseStream = sealedResponse(
        fragmentFixture("text", "child-mode-override", ["Done"]).completeEvents,
        "child-mode-override",
      )
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.metadata?.deepagent).toEqual({ agent_mode_override: "xhigh" })
    }),
  )

  it.effect("omits tools and records the real lowering stages when the model does not support tools", () =>
    Effect.gen(function* () {
      yield* setup
      const info = ModelV2.Info.empty(ProviderV2.ID.make("fake"), ModelV2.ID.make("fake-model"))
      currentModelInfo = new ModelV2.Info({
        ...info,
        api: {
          id: info.id,
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: "https://example.test/v1",
          protocol: "openai-compatible.chat",
        },
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Use no tools" }), resume: false })

      requests.length = 0
      responseStream = sealedResponse(
        fragmentFixture("text", "text-no-tools", ["Done"]).completeEvents,
        "unsupported-tools",
      )
      yield* session.resume(sessionID)

      expect(requests[0]?.tools).toEqual([])
      const receipt = yield* (yield* Database.Service).db
        .select()
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(receipt?.prepared_turn).toMatchObject({
        tool_registry_ids: ["defect", "echo", "task"],
        tool_permission_filtered_ids: ["defect", "echo", "task"],
        tool_final_offered_ids: [],
        tool_capability: "unsupported",
        tool_lowering_outcome: "omitted_no_support",
      })
    }),
  )

  it.effect("typed-fails an explicitly selected unknown Agent before provider dispatch", () =>
    Effect.gen(function* () {
      yield* setup
      yield* (yield* Database.Service).db
        .update(SessionTable)
        .set({ agent: "missing-agent" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Never run with an unknown agent" }),
        resume: false,
      })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (Exit.isFailure(exit))
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "AgentV2.NotFoundError",
          id: "missing-agent",
        })
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("uses the Location-scoped production source frame inside the actual runner", () =>
    Effect.gen(function* () {
      yield* setup
      currentSelectionIdentity = {
        securityNamespaceId: SecurityNamespaceID.make("ns:runner-production"),
        projectScopeKey: ProjectScopeKey.make("scope:runner-production"),
        locationKey: LocationKey.make("location:runner-production"),
        legacyProjectId: "project:runner-production",
      }
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Use the production selection frame" }),
        resume: false,
      })
      responseStream = sealedResponse(
        fragmentFixture("text", "text-production-frame", ["Done"]).completeEvents,
        "production-frame",
      )

      yield* session.resume(sessionID)

      const row = yield* (yield* Database.Service).db
        .select()
        .from(SessionContextSelectionTable)
        .where(eq(SessionContextSelectionTable.session_id, sessionID))
        .orderBy(desc(SessionContextSelectionTable.revision))
        .get()
        .pipe(Effect.orDie)
      expect(row).toMatchObject({
        security_namespace_id: "ns:runner-production",
        project_scope_key: "scope:runner-production",
        location_key: "location:runner-production",
      })
      expect(row?.security_namespace_id).not.toBe("v2:local")
    }),
  )

  staged.effect("W3.8 M3: an explicit =false keeps the request byte-identical (no selection evidence part)", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-false-flag", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      // The pre-W3 wire shape: no "Context selection (this turn):" update. The default-ON twin is
      // asserted by the request-history tests above, so this negative proves the
      // byte-invariance of the explicit kill-switch — the staged adapters + no evidence tail.
      // The whole composition runs against an explicit `=false` registry (the `staged` stack):
      // the kill-switch resolves at process start, so mid-process env mutation is not the seam.
      const system = requests.at(-1)?.system.map((part) => part.text) ?? []
      expect(system.join("\n")).not.toContain("Context selection (this turn):")
      expect(system).toEqual(["Initial context"])
      expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain("Context selection (this turn):")
      // Selection row still carries explicit four-graph statuses (staged source_disabled), never
      // v2-none — the =false fallback stays a REAL selection.
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionContextSelectionTable)
        .where(eq(SessionContextSelectionTable.session_id, sessionID))
        .orderBy(desc(SessionContextSelectionTable.revision))
        .get()
      const statuses = JSON.parse(row?.graph_statuses ?? "{}") as Record<string, { status: string; reasonCode: string }>
      expect(Object.keys(statuses).sort()).toEqual(["code", "documents", "knowledge", "memory"])
      for (const status of Object.values(statuses)) {
        expect(status.status).toBe("degraded_unavailable")
        expect(status.reasonCode).toBe("source_disabled")
      }
    }),
  )

  it.effect("composes DeepAgent context with agent and durable System Context for active sessions", () =>
    Effect.gen(function* () {
      yield* setup
      AgentGateway.configure({ enabled: true, agentMode: "high" })
      try {
        const agent = yield* AgentV2.Service
        yield* agent.update((editor) =>
          editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.system = "Build agent instructions"
            agent.mode = "primary"
          }),
        )
        currentModel = Model.make({ id: "deepagent/default", provider: "deepagent", route: OpenAIChat.route })
        systemBaseline =
          "You are deepagent-code, an interactive CLI tool that helps users with software engineering tasks."
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

        requests.length = 0
        response = fragmentFixture("text", "text-deepagent", ["Done"]).completeEvents
        yield* session.resume(sessionID)

        const request = requests.at(-1)
        const system = request?.system.map((part) => part.text).join("\n") ?? ""
        expect(system).toContain("# DeepAgent Code")
        expect(system).toContain("# Environment")
        expect(system).toContain("# Available Tools")
        expect(system).toContain("echo")
        expect(system).toContain("Build agent instructions")
        expect(system).toContain("You are deepagent-code")
        const runtimeTail = request?.messages.at(-1)
        expect(runtimeTail?.role).toBe("user")
        expect(runtimeTail?.content.map((part) => (part.type === "text" ? part.text : "")).join("\n")).toContain(
          "<deepagent-round-context>",
        )
      } finally {
        AgentGateway.configure({ enabled: false, agentMode: "high" })
      }
    }),
  )

  // -------------------------------------------------------------------------------------------------
  // RI-143 — governed plan-status fallback widened to every non-compaction agent (V1 parity,
  // session/llm/request.ts non-managed branch). A general-mode gateway (enabled but NOT
  // model-managed → runtime.active false) with a committed plan injects <plan-status> for ANY
  // non-compaction agent; without a committed plan nothing is injected; the goal-worker keeps its
  // injection (regression); the compaction agent stays excluded.
  // -------------------------------------------------------------------------------------------------
  const seedCommittedPlan = (sid: string, planID: string) =>
    DeepAgentPlanStore.setPlanDoc(sid, {
      plan_id: planID,
      session_id: sid,
      goal: "ri-143 goal",
      assumptions: [],
      steps: [{ step_id: "step_1", title: "ri-143 step", status: "active" as const }],
      active_step_id: "step_1",
      created_at: new Date().toISOString(),
    })
  const ri143Turn = Effect.fn("SessionRunnerTest.ri143Turn")(function* (input: {
    sid: SessionV2.ID
    agent: string
    planID?: string
  }) {
    const agent = yield* AgentV2.Service
    yield* agent.update((editor) => {
      editor.update(AgentV2.ID.make("build"), (item) => {
        item.mode = "primary"
      })
      editor.update(AgentV2.ID.make("goal-worker"), (item) => {
        item.mode = "subagent"
        item.hidden = true
      })
      editor.update(AgentV2.ID.make("compaction"), (item) => {
        item.hidden = true
      })
    })
    yield* insertSession(input.sid)
    yield* (yield* Database.Service).db
      .update(SessionTable)
      .set({ agent: input.agent })
      .where(eq(SessionTable.id, input.sid))
      .run()
      .pipe(Effect.orDie)
    if (input.planID !== undefined) seedCommittedPlan(input.sid, input.planID)
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID: input.sid, prompt: new Prompt({ text: "advance the plan" }), resume: false })
    requests.length = 0
    response = fragmentFixture("text", `text-ri143-${input.agent}`, ["Done"]).completeEvents
    yield* session.resume(input.sid)
    return (requests.at(-1)?.messages ?? []).map((message) =>
      message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
    )
  })

  it.effect("injects plan-status for a committed-plan general-mode session on a non-goal-worker agent", () =>
    Effect.gen(function* () {
      yield* setup
      AgentGateway.configure({ enabled: true, agentMode: "general" })
      try {
        const texts = yield* ri143Turn({
          sid: SessionV2.ID.make("ses_ri143_general"),
          agent: "build",
          planID: "plan_ri143_general",
        })
        const planStatus = texts.find((text) => text.includes("<plan-status>"))
        expect(planStatus).toBeDefined()
        expect(planStatus).toContain("plan_ri143_general")
      } finally {
        AgentGateway.configure({ enabled: false, agentMode: "high" })
      }
    }),
  )

  it.effect("injects no plan-status for a general-mode session without a committed plan", () =>
    Effect.gen(function* () {
      yield* setup
      AgentGateway.configure({ enabled: true, agentMode: "general" })
      try {
        const texts = yield* ri143Turn({ sid: SessionV2.ID.make("ses_ri143_noplan"), agent: "build" })
        expect(texts.some((text) => text.includes("<plan-status>"))).toBe(false)
      } finally {
        AgentGateway.configure({ enabled: false, agentMode: "high" })
      }
    }),
  )

  it.effect("keeps plan-status injection for the goal-worker (RI-143 regression)", () =>
    Effect.gen(function* () {
      yield* setup
      AgentGateway.configure({ enabled: true, agentMode: "general" })
      try {
        const texts = yield* ri143Turn({
          sid: SessionV2.ID.make("ses_ri143_worker"),
          agent: "goal-worker",
          planID: "plan_ri143_worker",
        })
        expect(texts.some((text) => text.includes("<plan-status>"))).toBe(true)
      } finally {
        AgentGateway.configure({ enabled: false, agentMode: "high" })
      }
    }),
  )

  it.effect("excludes the compaction agent from plan-status injection (V1 parity)", () =>
    Effect.gen(function* () {
      yield* setup
      AgentGateway.configure({ enabled: true, agentMode: "general" })
      try {
        const texts = yield* ri143Turn({
          sid: SessionV2.ID.make("ses_ri143_compaction"),
          agent: "compaction",
          planID: "plan_ri143_compaction",
        })
        expect(texts.some((text) => text.includes("<plan-status>"))).toBe(false)
      } finally {
        AgentGateway.configure({ enabled: false, agentMode: "high" })
      }
    }),
  )

  it.effect("uses the configured default agent system for omitted-agent sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.update((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(AgentV2.ID.make("reviewer"))
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-reviewer", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(
        withSelection(["Reviewer instructions", "Initial context"]),
      )
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("uses an explicitly selected non-build agent system", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const agent = yield* AgentV2.Service
      yield* agent.update((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-selected", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(
        withSelection(["Reviewer instructions", "Initial context"]),
      )
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("composes selected-agent skill guidance and replaces it after an agent switch", () =>
    Effect.gen(function* () {
      yield* setup
      yield* registerSwitchAgents
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      // The session's default agent is "auto" (AgentV2.defaultID, renamed from "build" in the mode
      // redesign); key the skill baseline on the ACTIVE agent so its guidance actually composes into the
      // system prompt. Keyed on "build" it never matched the running agent → guidance silently dropped.
      skillBaselines.set(AgentV2.defaultID, "Build skills")
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: "reviewer",
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        withSelection(["Initial context\n\nBuild skills"]),
        withSelection(["Initial context\n\nReviewer skills"]),
      ])
    }),
  )

  it.effect("retries first-epoch preparation when the selected agent changes during observation", () =>
    Effect.gen(function* () {
      yield* setup
      yield* registerSwitchAgents
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        withSelection(["Initial context\n\nReviewer skills"]),
      ])
    }),
  )

  it.effect("opens a queued activity once when the selected agent changes during observation", () =>
    Effect.gen(function* () {
      yield* setup
      yield* registerSwitchAgents
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Queued" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect((yield* session.context(sessionID)).filter((message) => message.type === "user")).toHaveLength(1)
    }),
  )

  it.effect("retries an agent switch before the final provider-dispatch boundary", () =>
    Effect.gen(function* () {
      yield* setup
      yield* registerSwitchAgents
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        withSelection(["Initial context\n\nReviewer skills"]),
      ])
      expect(
        yield* db
          .select({ replacementSeq: SessionContextEpochTable.replacement_seq })
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ replacementSeq: null })
    }),
  )

  it.effect("retries a model switch before the final provider-dispatch boundary", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = managedObservationModel
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.model)).toEqual([replacementModel])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        withSelection(["Initial context"]),
      ])
      const policies = yield* (yield* Database.Service).db.select().from(SessionModelPolicyReceiptTable)
        .where(eq(SessionModelPolicyReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(policies).toHaveLength(1)
      expect(policies[0]).toMatchObject({ api_model_id: "replacement", policy: { state: "unmanaged" } })
    }),
  )

  it.effect("fences an unchanged epoch read across an agent ABA replacement request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      response = []
      yield* session.resume(sessionID)
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: AgentV2.ID.make("reviewer"),
          })
          .pipe(
            Effect.andThen(
              events.publish(SessionEvent.AgentSwitched, {
                sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp: DateTime.makeUnsafe(2),
                agent: AgentV2.defaultID,
              }),
            ),
            Effect.asVoid,
          )
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(
        yield* db
          .select({ replacementSeq: SessionContextEpochTable.replacement_seq })
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ replacementSeq: null })
    }),
  )

  it.effect("rejects stale agent guidance when committing an existing-epoch replacement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      response = []
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: AgentV2.ID.make("reviewer"),
      })
      const context = (text: string) =>
        Effect.succeed(
          SystemContext.make({
            key: systemContextKey,
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(text),
            baseline: String,
            update: (_previous, current) => current,
          }),
        )
      const location = (yield* session.get(sessionID)).location

      expect(
        yield* SessionContextEpoch.prepare(
          db,
          events,
          context("Stale build context"),
          sessionID,
          location,
          AgentV2.defaultID,
        ).pipe(Effect.catchDefect(Effect.succeed)),
      ).toBeInstanceOf(SessionContextEpoch.AgentMismatch)

      expect(
        yield* SessionContextEpoch.prepare(
          db,
          events,
          context("Reviewer context"),
          sessionID,
          location,
          AgentV2.ID.make("reviewer"),
        ),
      ).toMatchObject({ baseline: "Reviewer context" })
    }),
  )

  it.effect("blocks a cross-agent provider turn while replacement context is unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      yield* registerSwitchAgents
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.defaultID, "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      response = []
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: AgentV2.ID.make("reviewer"),
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })

      requests.length = 0
      const blocked = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(blocked)).toBe(true)
      if (Exit.isFailure(blocked))
        expect(Cause.squash(blocked.cause)).toBeInstanceOf(SessionContextEpoch.AgentReplacementBlocked)
      expect(requests).toHaveLength(0)

      systemUnavailable = false
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        withSelection(["Initial context\n\nReviewer skills"]),
      ])
    }),
  )

  it.effect("admits removed context as a chronological System message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemRemoved = true
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system", "system"])
      expect(requests[1]?.messages.at(-2)?.content).toEqual([
        { type: "text", text: "System context source removed: test/context" },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("replaces the baseline lazily after a model switch and drops prior System updates", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        withSelection(["Initial context"]),
        withSelection(["Initial context"]),
        withSelection(["Replacement context"]),
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system", "system"])
      expect(requests[2]?.messages.map((message) => message.role)).toEqual(["user", "user", "user", "system"])
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "user",
        "model-switched",
        "user",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(5)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fourth" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("defers replacement while admitted context is temporarily unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      systemUnavailable = false
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        withSelection(["Initial context"]),
        withSelection(["Initial context"]),
        withSelection(["Replacement context"]),
      ])
    }),
  )

  it.effect("advances a pending replacement to the latest invalidation boundary", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement-1"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(2),
        model: { id: ModelV2.ID.make("replacement-2"), providerID: ProviderV2.ID.make("fake") },
      })
      const latest = yield* SessionInput.latestSeq(db, sessionID)

      expect(
        yield* db
          .select({ replacementSeq: SessionContextEpochTable.replacement_seq })
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ replacementSeq: latest })
    }),
  )

  it.effect("retries epoch preparation until observation-time invalidations settle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      requests.length = 0
      systemBaseline = "Changed context"
      let invalidations = 0
      systemLoadHook = Effect.suspend(() => {
        if (invalidations === 4) return Effect.void
        invalidations++
        return events
          .publish(SessionEvent.ModelSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(invalidations),
            model: { id: ModelV2.ID.make(`replacement-${invalidations}`), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })

      yield* session.resume(sessionID)

      expect(invalidations).toBe(4)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.system.map((part) => part.text)).toEqual(withSelection(["Changed context"]))
    }),
  )

  it.effect("replays retained context projections while replacement is pending", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })

      yield* replaySessionProjection(sessionID)
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)
      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(withSelection(["Replacement context"]))
    }),
  )

  it.effect("replaces the baseline lazily after completed compaction without reopening replacement on replay", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        withSelection(["Initial context"]),
        withSelection(["Replacement context"]),
      ])
      yield* replaySessionProjection(sessionID)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("automatically compacts into a completed summary and retained recent turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-first", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", ["## Goal\n- Preserve the task"]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain("## Goal")
      const earlierQuestionCount =
        requests
          .flatMap(userTexts)
          .join("\n")
          .match(/Earlier question/g)?.length ?? 0
      expect(earlierQuestionCount).toBeGreaterThanOrEqual(179)
      expect(earlierQuestionCount).toBeLessThanOrEqual(180)
      expect(userTexts(requests[1])).toHaveLength(1)
      expect(userTexts(requests[1])[0]).toContain("<summary>\n## Goal\n- Preserve the task\n</summary>")
      expect(userTexts(requests[1])[0]).toContain(`[User]: ${"Recent exact request ".repeat(180)}`)

      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.map((message) => message.type)).toEqual(["compaction", "assistant"])
      expect(context[0]).toMatchObject({
        type: "compaction",
        summary: "## Goal\n- Preserve the task",
      })

      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary-2", ["## Goal\n- Preserve the updated task"]).completeEvents,
        fragmentFixture("text", "text-final-2", ["Continued again"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Newest exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain(
        "<previous-summary>\n## Goal\n- Preserve the task\n</previous-summary>",
      )
      expect(userTexts(requests[0])[0]).toContain("Recent exact request")
      expect((yield* (yield* SessionStore.Service).context(sessionID))[0]).toMatchObject({
        type: "compaction",
        summary: "## Goal\n- Preserve the updated task",
      })
    }),
  )

  it.effect(
    "injects one volatile budget notice at ≥70% occupancy and drops it after compaction relieves the window",
    () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        // recoveryModel (context 20_000) with the harness buffer 3_000 ⇒ the compaction trigger
        // sits at 17_000 estimated tokens (85%), so a ~75% turn notices without compacting.
        currentModel = recoveryModel
        requests.length = 0
        response = fragmentFixture("text", "text-answer", ["Done"]).completeEvents
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "x".repeat(58_000) }), resume: false })
        yield* session.resume(sessionID)

        expect(requests).toHaveLength(1)
        const notices = budgetNotices(requests[0]!)
        expect(notices).toHaveLength(1)
        const notice = notices[0]!
        expect(notice).toMatch(
          /^BUDGET NOTICE: context window ~\d+% full\. Prefer completing the current subtask; avoid starting new large explorations\.$/,
        )
        const percent = Number(notice.match(/~(\d+)% full/)![1])
        expect(percent).toBeGreaterThanOrEqual(70)
        expect(percent).toBeLessThan(85)
        expect(percent).toBe(measuredBudgetPercent(requests[0]!, notice, recoveryModel))
        // Volatile only: nothing budget-shaped lands in durable history.
        expect(JSON.stringify(yield* session.context(sessionID))).not.toContain("BUDGET")

        // Grow past the 85% trigger: the turn compacts, the rebuilt request rides the compacted
        // history, and the notice is gone because occupancy fell below 70%.
        requests.length = 0
        responses = [
          fragmentFixture("text", "text-summary", ["## Goal\n- Preserve the task"]).completeEvents,
          fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
        ]
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "y".repeat(10_000) }), resume: false })
        yield* session.resume(sessionID)

        expect(requests).toHaveLength(2)
        // The summary dispatch never carries a budget part (it is built inside SessionCompaction,
        // not the turn-preparation path).
        expect(budgetNotices(requests[0]!)).toEqual([])
        expect(userTexts(requests[1]!)[0]).toContain("<conversation-checkpoint>")
        expect(userTexts(requests[1]!)[0]).toContain("Survival rules: this summary is notes, not proof.")
        expect(budgetNotices(requests[1]!)).toEqual([])
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "compaction", summary: "## Goal\n- Preserve the task" },
          { type: "assistant", finish: "stop" },
        ])
      }),
  )

  it.effect("escalates to one volatile budget warning at ≥90% occupancy when compaction is not yet due", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      // budgetModel (context 60_000) with the harness buffer 3_000 ⇒ the trigger sits at 57_000
      // estimated tokens (95%), so a ~92% turn warns WITHOUT provoking compaction.
      currentModel = budgetModel
      requests.length = 0
      response = fragmentFixture("text", "text-answer", ["Done"]).completeEvents
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "x".repeat(219_000) }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      const warnings = budgetNotices(requests[0]!)
      expect(warnings).toHaveLength(1)
      const warning = warnings[0]!
      expect(warning).toMatch(
        /^BUDGET WARNING: context window ~\d+% full; compaction is imminent\. Wrap up: record key state in durable form \(files\/plan\), avoid new tool-heavy detours\.$/,
      )
      const percent = Number(warning.match(/~(\d+)% full/)![1])
      expect(percent).toBeGreaterThanOrEqual(90)
      expect(percent).toBeLessThan(95)
      expect(percent).toBe(measuredBudgetPercent(requests[0]!, warning, budgetModel))
      expect(JSON.stringify(yield* session.context(sessionID))).not.toContain("BUDGET")
    }),
  )

  it.effect("forces one compaction and retries after provider context overflow", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      currentModel = Model.make({
        id: "deepseek-flash",
        provider: "deepseek",
        route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
      })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        fragmentFixture("text", "text-summary", ["## Goal\n- Recover overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1])[0]).toContain("## Goal")
      expect(userTexts(requests[2])[0]).toContain("<summary>\n## Goal\n- Recover overflow\n</summary>")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Goal\n- Recover overflow" },
        { type: "assistant", finish: "stop" },
      ])
      const policies = yield* (yield* Database.Service).db.select().from(SessionModelPolicyReceiptTable)
        .where(eq(SessionModelPolicyReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(policies.filter((row) => row.policy.state === "managed").map((row) => row.trigger_source).sort())
        .toEqual(["none", "provider_overflow"])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("uses the remote compaction summary and skips the local dispatch when the seam yields", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      remoteCompactionMode = "summary"
      currentModel = responsesRecoveryModel
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          remoteCompactionMode = undefined
        }),
      )
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        // Only ONE follow-up request: the retried turn. The local summary dispatch is skipped
        // because the remote authority produced the summary.
        fragmentFixture("text", "text-final", ["Recovered remote"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect((yield* (yield* SessionStore.Service).context(sessionID))[0]).toMatchObject({
        type: "compaction",
        summary: "## Remote\n- remote summary",
      })
    }),
  )

  it.effect("does not disguise a remote compact fault as a local success (design §5.3, C2-05)", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      remoteCompactionMode = "fault"
      currentModel = responsesRecoveryModel
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          remoteCompactionMode = undefined
        }),
      )
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        // The remote compact FAULTED and its result is unknown. Design §5.3: the turn must NOT invent
        // a local summary success — there is no /responses compact dispatch and no Compaction.Ended.
        // The original history stays readable; only the errant first request went out.
        fragmentFixture("text", "text-final", ["Recovered local"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      // Exactly one physical request: the remote compact never dispatched a fake local summary.
      expect(requests).toHaveLength(1)
      // No compaction marker was fabricated (history stays readable, no disguised success).
      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("never routes a non-Responses route to a /responses compact (Responses-only gate, C2-05)", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      // Wire the remote seam but keep the CHAT recovery model: the gate must reject the remote attempt
      // and fall through to the legitimate LOCAL summary — never a `/responses` request.
      remoteCompactionMode = "summary"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          remoteCompactionMode = undefined
        }),
      )
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        fragmentFixture("text", "text-summary", ["## Goal\n- Local fallback"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered local"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      // Zero requests carried a /responses route: the chat model was never routed to a remote compact.
      expect(requests.every((request) => request.model.route.id !== "openai-responses")).toBe(true)
      // The local summary ran (legitimate local compaction, not a disguised remote success).
      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(true)
    }),
  )

  it.effect("persists a second context overflow after one recovery", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const overflow = () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      responses = [
        overflow(),
        fragmentFixture("text", "text-summary", ["## Goal\n- Recover once"]).completeEvents,
        overflow(),
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("recovers once from a raw context overflow failure", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStream = Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidRequestReason({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        }),
      )
      responses = [
        fragmentFixture("text", "text-summary", ["## Goal\n- Recover raw overflow"]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Goal\n- Recover raw overflow" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("publishes the original overflow when recovery summarization fails", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
      expect(context.slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  it.effect("interrupts overflow recovery while the summary provider is running", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        fragmentFixture("text", "text-summary", ["## Goal\n- Interrupted"]).completeEvents,
      ]
      const firstGate = yield* Deferred.make<void>()
      const summaryGate = yield* Deferred.make<void>()
      streamGate = firstGate
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      streamGate = summaryGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      streamGate = undefined
      expect(requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("preserves effective System updates while compaction replacement is blocked", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.at(-1)?.system.map((part) => part.text)).toEqual(withSelection(["Initial context"]))
      expect(
        requests
          .at(-1)
          ?.messages.some(
            (message) =>
              message.role === "system" &&
              message.content[0]?.type === "text" &&
              message.content[0].text === "Changed context",
          ),
      ).toBe(true)
    }),
  )

  it.effect("projects reasoning and tool events without executing or continuing tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Use tools" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
        LLMEvent.reasoningEnd({ id: "reasoning-1" }),
        LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
        LLMEvent.toolInputDelta({ id: "call-error", name: "write", text: '{"path":"README.md"}' }),
        LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
        LLMEvent.toolCall({ id: "call-error", name: "write", input: { path: "README.md" }, providerExecuted: true }),
        LLMEvent.toolError({ id: "call-error", name: "write", message: "Denied" }),
        LLMEvent.toolResult({ id: "call-error", name: "write", result: { type: "error", value: "Denied" } }),
        LLMEvent.toolCall({
          id: "call-provider",
          name: "web_search",
          input: { query: "hello" },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.toolResult({
          id: "call-provider",
          name: "web_search",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Hello" },
              { type: "media", mediaType: "image/png", data: "data:image/png;base64,aGVsbG8=", filename: "hello.png" },
            ],
          },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "tool-calls",
          usage: {
            inputTokens: 10,
            nonCachedInputTokens: 8,
            outputTokens: 4,
            reasoningTokens: 1,
            cacheReadInputTokens: 2,
          },
        }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect", "task"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use tools" },
        {
          type: "assistant",
          finish: "tool-calls",
          tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
          content: [
            { type: "reasoning", id: "reasoning-1", text: "Think" },
            {
              type: "tool",
              id: "call-error",
              name: "write",
              state: {
                status: "error",
                input: { path: "README.md" },
                error: { type: "unknown", message: "Denied" },
              },
            },
            {
              type: "tool",
              id: "call-provider",
              name: "web_search",
              provider: { executed: true, metadata: { fake: { source: "provider" } } },
              state: {
                status: "completed",
                input: { query: "hello" },
                structured: {},
                content: [
                  { type: "text", text: "Hello" },
                  { type: "file", mime: "image/png", source: { type: "data", data: "aGVsbG8=" }, name: "hello.png" },
                ],
              },
            },
          ],
        },
      ])
      expect(yield* session.get(sessionID)).toMatchObject({
        cost: 0,
        tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
      })
    }),
  )

  it.effect("projects non-zero cost from the Location catalog pricing snapshot", () =>
    Effect.gen(function* () {
      yield* setup
      const pricing = ModelV2.Info.empty(ProviderV2.ID.make("fake"), ModelV2.ID.make("fake-model"))
      currentPricingInfo = new ModelV2.Info({
        ...pricing,
        cost: [{ input: 1, output: 2, cache: { read: 3, write: 4 } }],
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Account for this turn" }), resume: false })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "stop",
          usage: {
            inputTokens: 3_000_000,
            nonCachedInputTokens: 1_000_000,
            cacheReadInputTokens: 1_000_000,
            cacheWriteInputTokens: 1_000_000,
            outputTokens: 1_000_000,
          },
        }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.get(sessionID)).toMatchObject({
        cost: 10,
        tokens: {
          input: 1_000_000,
          output: 1_000_000,
          reasoning: 0,
          cache: { read: 1_000_000, write: 1_000_000 },
        },
      })
    }),
  )

  it.effect("continues with reloaded history after durably settling one local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = managedObservationModel
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Echo this" }), resume: false })

      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      streamGate = undefined
      streamStarted = undefined
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const policy = yield* (yield* Database.Service).db.select().from(SessionModelPolicyReceiptTable)
        .where(eq(SessionModelPolicyReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
      const turns = yield* (yield* Database.Service).db.select().from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(policy).toHaveLength(2)
      expect(policy.every((row) => row.policy.state === "managed" && row.policy.key === "deepseek-v4-flash" &&
        row.policy.action === "normal" && row.offered_tool_ids.includes("echo") &&
        turns.some((turn) => turn.provider_attempt_id === row.provider_attempt_id))).toBe(true)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "system"])
      expect(authorizations).toMatchObject([{ sessionID, toolCallID: "call-echo" }])
      expect(executions).toEqual(["hello"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo this" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              state: {
                status: "completed",
                input: { text: "hello" },
                structured: { text: "hello" },
                content: [{ type: "text", text: "hello" }],
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-final", text: "Done" }] },
      ])
    }),
  )

  it.effect("carries the exact capability L2 body into the continuation provider request", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const tools = yield* ToolRegistry.Service
      yield* tools.register({ capability_load: makeCapabilityLoadTool({ db }) }).pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Load the code-reading procedure" }),
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-capability-load",
            name: "capability_load",
            input: {
              schemaVersion: "capability-load-request.v1",
              capabilityId: "deepagent.code-read",
              reason: "operation_guidance",
              expectedActions: ["read"],
            },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-capability" }),
          LLMEvent.textDelta({ id: "text-after-capability", text: "Procedure loaded" }),
          LLMEvent.textEnd({ id: "text-after-capability" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      const body = capabilityBodyFor("deepagent.code-read", "1.0.0-beta.0")!.body
      const toolResult = requests[1]?.messages
        .flatMap((message) => (message.role === "tool" ? message.content : []))
        .find((content) => content.type === "tool-result")?.result
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[0])).not.toContain(body.split("\n")[1]!)
      expect(toolResult).toMatchObject({ type: "text" })
      if (toolResult?.type === "text") expect(String(toolResult.value)).toContain(body)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "system"])
    }),
  )

  it.effect("reloads a model switch before a tool-driven continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = managedObservationModel
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Echo this" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const run = yield* Effect.forkChild(session.resume(sessionID))
      yield* Deferred.await(toolExecutionsStarted)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)

      expect(requests.map((request) => request.model)).toEqual([managedObservationModel, replacementModel])
      const policy = yield* (yield* Database.Service).db.select().from(SessionModelPolicyReceiptTable)
        .where(eq(SessionModelPolicyReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(policy).toHaveLength(2)
      expect(policy.map((row) => row.policy.state).sort()).toEqual(["managed", "unmanaged"])
      expect(policy.find((row) => row.policy.state === "managed")?.policy).toMatchObject({
        state: "managed", key: "deepseek-v4-flash", action: "normal",
      })
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        withSelection(["Initial context"]),
        withSelection(["Replacement context"]),
      ])
    }),
  )

  it.effect("restores durable reasoning provider metadata in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Think first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
        LLMEvent.reasoningDelta({ id: "reasoning-anthropic", text: "Signed thought" }),
        LLMEvent.reasoningEnd({ id: "reasoning-anthropic", providerMetadata: { anthropic: { signature: "sig_1" } } }),
        LLMEvent.reasoningStart({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        }),
        LLMEvent.reasoningDelta({ id: "reasoning-openai", text: "Encrypted thought" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Think first" },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
            {
              type: "reasoning",
              text: "Encrypted thought",
              providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
            },
          ],
        },
      ])

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages[1]?.content).toEqual([
        { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
        {
          type: "reasoning",
          text: "Encrypted thought",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
      ])
    }),
  )

  it.effect("replays durable provider-executed tool results inline in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Search first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        }),
        LLMEvent.toolResult({
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "system"])
      expect(requests[1]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        },
        {
          type: "tool-result",
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        },
      ])
    }),
  )

  it.effect("starts recorded local tools eagerly and awaits settlement before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Echo five times" }), resume: false })

      requests.length = 0
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      const providerGate = yield* Deferred.make<void>()
      response = []
      responses = undefined
      const initial = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        ...Array.from({ length: 5 }, (_, index) =>
          LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
        ),
      ])
      const final = Stream.fromIterable([
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      streamGate = undefined
      responseStream = Stream.concat(
        initial,
        Stream.fromEffect(Deferred.await(providerGate)).pipe(Stream.flatMap(() => final)),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo five times" },
        {
          type: "assistant",
          content: Array.from({ length: 5 }, (_, index) => ({
            type: "tool",
            id: `call-echo-${index}`,
            state: { status: "running", input: { text: `${index}` } },
          })),
        },
      ])

      yield* Deferred.succeed(providerGate, undefined)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("settles repeated provider-local tool call IDs against their owning assistant messages", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Echo twice" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "first" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "second" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      grantLookupActive = true
      try {
        yield* session.resume(sessionID)
      } finally {
        grantLookupActive = false
      }

      expect(executions).toEqual(["first", "second"])
      expect(requests).toHaveLength(3)
      // Durable tool-effect authority: each settled call recorded exactly one terminal row bound
      // to the provider attempt/receipt of the turn that offered it, and — with the permission
      // capability seam active — each row binds the grant that authorized the call.
      const database = yield* Database.Service
      const admissions = yield* database.db
        .select()
        .from(V2ToolEffectAdmissionTable)
        .where(eq(V2ToolEffectAdmissionTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const effects = yield* database.db
        .select()
        .from(V2ToolEffectTable)
        .where(eq(V2ToolEffectTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(effects).toHaveLength(2)
      expect(admissions).toHaveLength(2)
      expect(admissions.map((admission) => admission.effect_kind)).toEqual(["mutating", "mutating"])
      expect(new Set(admissions.map((admission) => admission.receipt_id))).toEqual(
        new Set(effects.map((effect) => effect.receipt_id)),
      )
      expect(effects.map((effect) => effect.state)).toEqual(["settled", "settled"])
      expect(effects.map((effect) => effect.tool_name)).toEqual(["echo", "echo"])
      expect(effects.map((effect) => effect.tool_call_id)).toEqual(["tool_0", "tool_0"])
      expect(effects.map((effect) => effect.effect_kind)).toEqual(["mutating", "mutating"])
      expect(new Set(effects.map((effect) => effect.receipt_id)).size).toBe(2)
      expect(new Set(effects.map((effect) => effect.provider_attempt_id)).size).toBe(2)
      expect(effects.every((effect) => effect.outcome_hash.length === 64)).toBe(true)
      expect(effects.map((effect) => effect.grant_receipt_id)).toEqual(["grant_receipt_tool_0", "grant_receipt_tool_0"])
      expect(effects.every((effect) => effect.grant_owner_id === "grant_owner_1")).toBe(true)
      expect(effects.every((effect) => effect.grant_state === "settled" && effect.grant_version === 3)).toBe(true)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("joins concurrent resume calls into one active provider run", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Run once" }), resume: false })

      requests.length = 0
      responses = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-once" }),
        LLMEvent.textDelta({ id: "text-once", text: "Once" }),
        LLMEvent.textEnd({ id: "text-once" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Run once" },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-once", text: "Once" }] },
      ])
    }),
  )

  it.effect("steers an active provider turn with newly recorded prompts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Change direction"])
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
    }),
  )

  it.effect("starts queued input after the active activity settles", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Wait until the next activity" }),
        delivery: "queue",
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Wait until the next activity"])
    }),
  )

  it.effect("preserves durable queued input for a later wake after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Run after interrupt" }),
        delivery: "queue",
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Run after interrupt"])
    }),
  )

  it.effect("preserves durable steering input for a later resume after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Steer after interrupt" }),
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)

      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Steer after interrupt"])
    }),
  )

  it.effect("runs queued active inputs as separate FIFO activities", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Queue second" }), delivery: "queue" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Queue first", "Queue second"])
    }),
  )

  it.effect("opens queued input after idle steering activity settles", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start steering activity" }), resume: false })
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Queue later activity" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start steering activity"])
      expect(userTexts(requests[1]!)).toEqual(["Start steering activity", "Queue later activity"])
    }),
  )

  it.effect("coalesces steers into the active queued activity before starting the next queued activity", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      const firstGate = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      streamGate = firstGate

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Queue second" }), delivery: "queue" })
      streamGate = secondGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Steer first queued activity" }) })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Also steer first queued activity" }) })
      yield* Deferred.succeed(secondGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined

      expect(requests).toHaveLength(4)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer first queued activity",
        "Also steer first queued activity",
      ])
      expect(userTexts(requests[3]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer first queued activity",
        "Also steer first queued activity",
        "Queue second",
      ])
    }),
  )

  it.effect("coalesces multiple active steering prompts into one continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "First steer" }) })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Second steer" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "First steer", "Second steer"])
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("runs steering input accepted while the active provider turn fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerRefused()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Recover with this" }) })
      yield* Deferred.succeed(streamGate, undefined)
      expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe(streamFailure)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Recover with this"])
    }),
  )

  it.effect("quarantines a sealed post-dispatch stream failure as indeterminate instead of failed", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Stream fails after dispatch" }), resume: false })
      const failure = providerRefused()
      responseStream = Stream.unwrap(
        Effect.gen(function* () {
          const seal = yield* V2ProviderTurn.CurrentRequestSeal
          if (!seal) return yield* Effect.die("Provider request seal is missing")
          yield* seal
            .seal({
              wireHash: Hash.sha256("post-dispatch-failure-wire"),
              bodyHash: Hash.sha256("post-dispatch-failure-body"),
              bodyLength: 8,
              contentType: "application/json",
            })
            .pipe(Effect.orDie)
          return Stream.fail(failure)
        }),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)

      const receipts = () =>
        db
          .select()
          .from(V2ProviderTurnReceiptTable)
          .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
          .orderBy(asc(V2ProviderTurnReceiptTable.request_ordinal))
          .all()
          .pipe(Effect.orDie)
      const first = yield* receipts()
      expect(first).toHaveLength(1)
      expect(first[0]).toMatchObject({ state: "indeterminate_after_crash" })
      expect(first[0]?.error_code).toMatch(/^provider_stream_failed:/)
      expect(first[0]?.outcome_artifact).toEqual([])

      // A forced continuation must not silently rewrite the quarantined receipt into a retryable
      // `failed` row; it stays indeterminate and any new work opens a separate receipt.
      responseStream = Stream.unwrap(
        Effect.gen(function* () {
          const seal = yield* V2ProviderTurn.CurrentRequestSeal
          if (!seal) return yield* Effect.die("Continuation provider request seal is missing")
          yield* seal
            .seal({
              wireHash: Hash.sha256("post-quarantine-continuation-wire"),
              bodyHash: Hash.sha256("post-quarantine-continuation-body"),
              bodyLength: 9,
              contentType: "application/json",
            })
            .pipe(Effect.orDie)
          return Stream.fromIterable(fragmentFixture("text", "text-after-quarantine", ["Continued"]).completeEvents)
        }),
      )
      requests.length = 0
      yield* session.resume(sessionID)
      const after = yield* receipts()
      expect(after[0]).toMatchObject({
        receipt_id: first[0]?.receipt_id,
        state: "indeterminate_after_crash",
      })
      expect(after).toHaveLength(2)
      expect(after[1]).toMatchObject({ state: "settled" })
    }),
  )

  it.effect("quarantines a transient transport drop without opening a second physical attempt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Quarantine transport drop" }), resume: false })

      // A sealed request may have reached the provider even when the local stream emitted no
      // assistant event. The only honest outcome is one indeterminate receipt and no automatic
      // re-dispatch.
      requests.length = 0
      const sealThen = (wire: string, then: Stream.Stream<LLMEvent, LLMError>) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const seal = yield* V2ProviderTurn.CurrentRequestSeal
            if (!seal) return yield* Effect.die("Transport-drop request seal is missing")
            yield* seal
              .seal({
                wireHash: Hash.sha256(wire),
                bodyHash: Hash.sha256(`${wire}-body`),
                bodyLength: 4,
                contentType: "application/json",
              })
              .pipe(Effect.orDie)
            return then
          }),
        )
      const failure = providerUnavailable()
      responseStream = sealThen("transport-drop-fail", Stream.fail(failure))
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)

      const receipts = yield* db
        .select({ state: V2ProviderTurnReceiptTable.state, errorCode: V2ProviderTurnReceiptTable.error_code })
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
        .orderBy(asc(V2ProviderTurnReceiptTable.request_ordinal))
        .all()
        .pipe(Effect.orDie)
      expect(receipts).toEqual([
        { state: "indeterminate_after_crash", errorCode: expect.stringMatching(/^provider_stream_failed:/) },
      ])
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Quarantine transport drop" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  // The retry backoff is real time, so these two run on the live clock with an explicit budget.
  it.live(
    "retries a pre-dispatch DNS failure on a fresh attempt instead of ending the run",
    () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const { db } = yield* Database.Service
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "DNS briefly unavailable" }),
          resume: false,
        })

        const sealThen = (wire: string, then: Stream.Stream<LLMEvent, LLMError>) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const seal = yield* V2ProviderTurn.CurrentRequestSeal
              if (!seal) return yield* Effect.die("Retry-attempt request seal is missing")
              yield* seal
                .seal({
                  wireHash: Hash.sha256(wire),
                  bodyHash: Hash.sha256(`${wire}-body`),
                  bodyLength: 4,
                  contentType: "application/json",
                })
                .pipe(Effect.orDie)
              return then
            }),
          )

        requests.length = 0
        // Attempt 1: DNS resolution proves the request never reached the provider. Attempt 2: normal
        // completion. A pre-dispatch transport failure is safe to retry on a fresh sealed attempt.
        responseStreams = [
          sealThen(
            "pre-dispatch-dns-failure",
            Stream.fail(
              new LLMError({
                module: "test",
                method: "stream",
                reason: new TransportReason({
                  message: "getaddrinfo EAI_AGAIN api.example.test",
                  kind: "TransportError",
                  phase: "pre-dispatch",
                }),
              }),
            ),
          ),
          sealedResponse(fragmentFixture("text", "retry-succeeded", ["Recovered"]).completeEvents, "retry-succeeded"),
        ]

        yield* session.resume(sessionID)

        expect(requests).toHaveLength(2)
        const receipts = yield* db
          .select({ state: V2ProviderTurnReceiptTable.state, errorCode: V2ProviderTurnReceiptTable.error_code })
          .from(V2ProviderTurnReceiptTable)
          .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
          .orderBy(asc(V2ProviderTurnReceiptTable.request_ordinal))
          .all()
          .pipe(Effect.orDie)
        // The rejected attempt stays quarantined as indeterminate evidence; the retry opens a new
        // ordinal and settles. The quarantined row is never replayed.
        expect(receipts).toHaveLength(2)
        expect(receipts[0]).toMatchObject({
          state: "indeterminate_after_crash",
          errorCode: expect.stringMatching(/^provider_stream_failed:/),
        })
        expect(receipts[1]).toMatchObject({ state: "settled", errorCode: null })
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "user", text: "DNS briefly unavailable" },
          { type: "assistant", finish: "stop" },
        ])
      }),
    20_000,
  )

  // The retry backoff is real time, so these two run on the live clock with an explicit budget.
  it.live(
    "gives up after the bounded provider rejection retry budget is spent",
    () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const { db } = yield* Database.Service
        yield* session.prompt({
          sessionID,
          prompt: new Prompt({ text: "Provider permanently rejecting" }),
          resume: false,
        })

        const rejection = () =>
          new LLMError({
            module: "test",
            method: "stream",
            reason: new ProviderInternalReason({ message: "Provider request failed with HTTP 503", status: 503 }),
          })
        // A dispatched 503 is a sealed request: the receipt quarantines indeterminate (the state a
        // retry is allowed to re-open), exactly as it does in production. One sealed failing stream
        // per attempt, with the initial dispatch plus the full retry budget.
        const sealedRejection = (wire: string) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const seal = yield* V2ProviderTurn.CurrentRequestSeal
              if (!seal) return yield* Effect.die("Rejection request seal is missing")
              yield* seal
                .seal({
                  wireHash: Hash.sha256(wire),
                  bodyHash: Hash.sha256(`${wire}-body`),
                  bodyLength: 4,
                  contentType: "application/json",
                })
                .pipe(Effect.orDie)
              return Stream.fail(rejection())
            }),
          )
        requests.length = 0
        // Every attempt is rejected before generation. The runner retries a bounded number of times and
        // then surfaces the failure instead of looping forever.
        responseStreams = [
          sealedRejection("reject-1"),
          sealedRejection("reject-2"),
          sealedRejection("reject-3"),
          sealedRejection("reject-4"),
        ]

        const exit = yield* session.resume(sessionID).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(requests.length).toBe(4)
        const receipts = yield* db
          .select({ state: V2ProviderTurnReceiptTable.state })
          .from(V2ProviderTurnReceiptTable)
          .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
          .orderBy(asc(V2ProviderTurnReceiptTable.request_ordinal))
          .all()
          .pipe(Effect.orDie)
        expect(receipts).toHaveLength(4)
        expect(receipts.every((row) => row.state === "indeterminate_after_crash")).toBe(true)
      }),
    20_000,
  )

  it.effect("refuses provider continuation while a tool admission has no terminal evidence", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Do not replay the unknown tool" }),
        resume: false,
      })
      yield* (yield* Database.Service).db
        .insert(V2ToolEffectAdmissionTable)
        .values({
          admission_id: "admission_unknown_tool",
          session_id: sessionID,
          provider_attempt_id: "attempt_unknown_tool",
          receipt_id: "receipt_unknown_tool",
          tool_call_id: "call_unknown_tool",
          tool_name: "echo",
          effect_kind: "mutating",
          owner_token: "owner_unknown_tool",
          time_created: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (Exit.isFailure(exit))
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "V2ToolEffect.RecoveryRequiredError",
          sessionId: sessionID,
          pending: 1,
        })
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("terminalizes the admitted receipt when the context epoch rebuilds before dispatch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      // The in-memory database is shared across tests; reset any epoch left behind for this Session
      // so the rebuild observation starts from a deterministic first-epoch flow.
      yield* db
        .delete(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      let bumped = false
      pricingLookupHook = Effect.suspend(() => {
        if (bumped) return Effect.void
        bumped = true
        return db
          .update(SessionContextEpochTable)
          .set({ revision: sql`${SessionContextEpochTable.revision} + 1` })
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .run()
          .pipe(Effect.orDie)
      })
      requests.length = 0
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Epoch rebuild" }), resume: false })
      responseStream = Stream.unwrap(
        Effect.gen(function* () {
          const seal = yield* V2ProviderTurn.CurrentRequestSeal
          if (!seal) return yield* Effect.die("Post-rebuild provider request seal is missing")
          yield* seal
            .seal({
              wireHash: Hash.sha256("post-rebuild-wire"),
              bodyHash: Hash.sha256("post-rebuild-body"),
              bodyLength: 9,
              contentType: "application/json",
            })
            .pipe(Effect.orDie)
          return Stream.fromIterable(fragmentFixture("text", "text-after-rebuild", ["Recovered"]).completeEvents)
        }),
      )

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      const receipts = yield* db
        .select()
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
        .orderBy(asc(V2ProviderTurnReceiptTable.request_ordinal))
        .all()
        .pipe(Effect.orDie)
      expect(receipts).toHaveLength(2)
      expect(receipts[0]).toMatchObject({ state: "failed", error_code: "epoch_mismatch_rebuild" })
      expect(receipts[1]).toMatchObject({ state: "settled" })
      expect(receipts.some((receipt) => receipt.state === "preparing")).toBe(false)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Epoch rebuild" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("records a durable sealed receipt for the compaction summary provider request", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const { db } = yield* Database.Service
      const sealedResponse = (wire: string, events: readonly LLMEvent[], next?: () => void) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const seal = yield* V2ProviderTurn.CurrentRequestSeal
            if (!seal) return yield* Effect.die(`Provider request seal is missing for ${wire}`)
            yield* seal
              .seal({
                wireHash: Hash.sha256(`${wire}-wire`),
                bodyHash: Hash.sha256(`${wire}-body`),
                bodyLength: events.length,
                contentType: "application/json",
              })
              .pipe(Effect.orDie)
            next?.()
            return Stream.fromIterable(events)
          }),
        )
      responseStream = sealedResponse(
        "compaction-overflow-turn",
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        () => {
          responseStream = sealedResponse(
            "compaction-summary",
            fragmentFixture("text", "text-summary", ["## Goal\n- Sealed summary"]).completeEvents,
            () => {
              responseStream = sealedResponse(
                "compaction-final-turn",
                fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
              )
            },
          )
        },
      )
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1]!)[0]).toContain("## Goal")
      const receipts = yield* db
        .select()
        .from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
        .orderBy(asc(V2ProviderTurnReceiptTable.request_ordinal))
        .all()
        .pipe(Effect.orDie)
      // Earlier turn from setupOverflowRecovery, then: overflow turn, compaction summary, final turn.
      expect(receipts).toHaveLength(4)
      const [, overflow, summary, final] = receipts
      expect(overflow).toMatchObject({ state: "settled" })
      expect(summary).toMatchObject({
        state: "settled",
        owner_mode: "v2",
        user_message_id: overflow?.user_message_id,
        wire_request_hash: Hash.sha256("compaction-summary-wire"),
      })
      expect(final).toMatchObject({ state: "settled", user_message_id: summary?.user_message_id })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Goal\n- Sealed summary" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("durably fails local tools left running by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Recover interrupted tool" }), resume: false })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        name: "echo",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        text: '{"text":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        tool: "echo",
        input: { text: "stale" },
        provider: { executed: false },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "system"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-interrupted",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails hosted tools left running by a prior process before continuing inline", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover interrupted hosted tool" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        name: "web_search",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        text: '{"query":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        tool: "web_search",
        input: { query: "stale" },
        provider: { executed: true, metadata: { openai: { itemId: "call-hosted-interrupted" } } },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "system"])
      expect(requests[0]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "call-hosted-interrupted",
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "call-hosted-interrupted" } },
        },
        { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
      ])
    }),
  )

  it.effect("durably fails pending tool input left by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Recover interrupted tool input" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-pending-interrupted",
        name: "echo",
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "system"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool input" },
        { type: "assistant", content: [{ type: "tool", id: "call-pending-interrupted", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("starts the first queued activity when woken while idle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Wait for fresh activity" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Wait for fresh activity"])
    }),
  )

  it.effect("uses a fresh session's first steer model before resolving the provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      requireSessionModel = true
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "First desktop message", model: { providerID: "fake", id: "fake-model" } }),
        resume: false,
      })
      expect((yield* session.get(sessionID)).model).toBeUndefined()

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([model])
      expect(requests.map(userTexts)).toEqual([["First desktop message"]])
      expect((yield* session.get(sessionID)).model?.id).toBe(ModelV2.ID.make("fake-model"))
    }),
  )

  it.effect("uses each queued prompt's model when future queue inputs were already admitted", () =>
    Effect.gen(function* () {
      yield* setup
      requireSessionModel = true
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "First model", model: { providerID: "fake", id: "fake-model" } }),
        delivery: "queue",
        resume: false,
      })
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Second model", model: { providerID: "fake", id: "replacement" } }),
        delivery: "queue",
        resume: false,
      })
      expect((yield* session.get(sessionID)).model).toBeUndefined()

      requests.length = 0
      responses = Array.from({ length: 2 }, () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ])
      yield* session.resume(sessionID)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map(userTexts)).toEqual([["First model"], ["First model", "Second model"]])
      expect((yield* session.get(sessionID)).model?.id).toBe(ModelV2.ID.make("replacement"))
    }),
  )

  it.effect("does not spend one activity step budget across queued activities", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const queued = Array.from({ length: 26 }, (_, index) => `Queued activity ${index + 1}`)
      for (const text of queued) {
        yield* session.prompt({ sessionID, prompt: new Prompt({ text }), delivery: "queue", resume: false })
      }

      requests.length = 0
      responses = queued.map(() => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ])

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(queued.length)
      expect(userTexts(requests.at(-1)!)).toEqual(queued)
    }),
  )

  it.effect("retries inbox input after prompt projection rolls back", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const defect = new Error("fail after prompt promotion")
      let fail = true
      yield* events.project(SessionEvent.PromptLifecycle.Promoted, () => (fail ? Effect.die(defect) : Effect.void))
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Recover promoted input" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
      fail = false
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* (yield* SessionExecution.Service).wake(sessionID)
      while (requests.length === 0) yield* Effect.yieldNow

      expect(userTexts(requests[0]!)).toEqual(["Recover promoted input"])
    }),
  )

  it.effect("does not strand a committed promotion when a post-commit listener defects", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.listen((event) =>
        event.type === SessionEvent.PromptLifecycle.Promoted.type
          ? Effect.die("fail after prompt promotion commits")
          : Effect.void,
      )
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Run committed promotion" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Run committed promotion"])
    }),
  )

  it.effect("runs different sessions concurrently", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Run first" }), resume: false })
      yield* session.prompt({ sessionID: otherSessionID, prompt: new Prompt({ text: "Run second" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(otherSessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).toEqual([
        sessionID,
        otherSessionID,
      ])
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined
    }),
  )

  it.effect("bounds external session prompt cache keys", () =>
    Effect.gen(function* () {
      yield* setup
      const externalSessionID = SessionV2.ID.fromExternal({
        namespace: "discord",
        key: "thread-one",
      })
      const otherExternalSessionID = SessionV2.ID.fromExternal({
        namespace: "discord",
        key: "thread-two",
      })
      yield* insertSession(externalSessionID)
      yield* insertSession(otherExternalSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: externalSessionID,
        prompt: new Prompt({ text: "Run external session" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID: otherExternalSessionID,
        prompt: new Prompt({ text: "Run other external session" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(externalSessionID)
      yield* session.resume(otherExternalSessionID)

      const keys = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(keys).toEqual([externalSessionID.slice(4), otherExternalSessionID.slice(4)])
      expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    }),
  )

  it.effect("fans out one failed run and allows a later retry", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Retry after failure" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerRefused()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(secondExit).toEqual(firstExit)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("durably settles a missing read before continuing the provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        read: Tool.make({
          description: "Read a file",
          input: Schema.Struct({ path: Schema.String }),
          output: Schema.String,
          execute: ({ path }) =>
            Effect.die(
              systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "realPath",
                pathOrDescriptor: `/project/${path}`,
              }),
            ).pipe(Effect.catchDefect((defect) => recoverReadDefect(path, defect))),
        }),
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Read README then recover" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-missing-read", name: "read", input: { path: "README.md" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-error" }),
          LLMEvent.textDelta({ id: "text-after-error", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-error" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = undefined
      streamStarted = undefined

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Read README then recover" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-missing-read",
              state: { status: "error", error: { message: "Unable to read README.md" } },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-after-error", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("propagates unexpected local tool defects operationally", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Call defect" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-defect", name: "defect", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe("unexpected tool defect")

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call defect" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-defect",
              state: {
                status: "error",
                error: { type: "unknown", message: "Tool execution failed: unexpected tool defect" },
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("continues after a pending question is cancelled by the user", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const questions = yield* QuestionV2.Service
      yield* registry.register({
        question: Tool.make({
          description: "Ask the user",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: (_, context) =>
            questions.ask({ sessionID: context.sessionID, questions: [] }).pipe(Effect.as({}), Effect.orDie),
        }),
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Ask then stop" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-question", name: "question", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      let pending = yield* questions.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list()
      }
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.join(run)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-question",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])

      // A rejected Question is a known local cancellation, so the next admitted prompt can
      // continue. An unknown interrupted external tool still requires explicit recovery.
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue after question" }), resume: false })
      requests.length = 0
      responses = [[
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "after-question" }),
        LLMEvent.textDelta({ id: "after-question", text: "Continued" }),
        LLMEvent.textEnd({ id: "after-question" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        { type: "assistant" },
        { type: "user", text: "Continue after question" },
        { type: "assistant", content: [{ type: "text", text: "Continued" }] },
      ])
    }),
  )

  it.effect("awaits started local tools before surfacing provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Settle before failing" }), resume: false })
      const failure = providerUnavailable()
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-failure", name: "echo", input: { text: "settle" } }),
        ]),
        Stream.fail(failure),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Deferred.succeed(toolExecutionGate, undefined)
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
      toolExecutionGate = undefined

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Settle before failing" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-before-failure", state: { status: "completed", structured: { text: "settle" } } },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails blocked local tools when a provider turn is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Interrupt blocked tool" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-interrupt", name: "echo", input: { text: "blocked" } }),
        ]),
        Stream.never,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      yield* session.interrupt(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-before-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        { type: "assistant", content: [{ type: "tool", id: "call-before-interrupt", state: { status: "error" } }] },
      ])
      requests.length = 0
      responseStream = undefined
      response = []
      const recovery = yield* session.resume(sessionID).pipe(Effect.exit)
      expect(Exit.isFailure(recovery)).toBe(true)
      if (Exit.isFailure(recovery))
        expect(Cause.squash(recovery.cause)).toBeInstanceOf(V2ToolEffect.RecoveryRequiredError)
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("interrupts a blocked provider turn without local tool activity", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Interrupt provider" }), resume: false })
      requests.length = 0
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      streamGate = undefined
      streamStarted = undefined

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(requests).toHaveLength(1)
      yield* session.interrupt(sessionID)
    }),
  )

  it.effect("reclassifies the transport abort defect when a hung provider stream is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Interrupt hanging transport" }), resume: false })
      requests.length = 0
      const bodyOpened = yield* Deferred.make<void>()
      const controller = new AbortController()
      // Faithful stand-in for the production body stream: InterruptibleResponse wraps
      // `Stream.fromReadableStream` in `Stream.ensuring(... controller.abort())`, so interrupting
      // the drain aborts the fetch and the reader teardown rejects with an AbortError DOMException,
      // which surfaces as a defect that replaces the fiber's interrupt cause.
      responseStream = Stream.unwrap(
        Effect.as(
          Deferred.succeed(bodyOpened, undefined),
          Stream.ensuring(
            Stream.fromReadableStream({
              evaluate: () =>
                new ReadableStream<LLMEvent>({
                  start(body) {
                    controller.signal.addEventListener("abort", () =>
                      body.error(new DOMException("The operation was aborted.", "AbortError")),
                    )
                  },
                }),
              onError: () => providerUnavailable(),
            }),
            Effect.sync(() => controller.abort()),
          ),
        ),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(bodyOpened)
      yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(requests).toHaveLength(1)
      yield* session.interrupt(sessionID)
    }),
  )

  it.effect("durably fails blocked local tools when interrupted while awaiting settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Interrupt tool settlement" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-await-interrupt", name: "echo", input: { text: "blocked" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt tool settlement" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-await-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
      const { db } = yield* Database.Service
      const budgetEvents = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.durableType(SessionEvent.LoopBudget.Triggered)))
        .all()
        .pipe(Effect.orDie)
      expect(budgetEvents).toHaveLength(1)
      expect(budgetEvents[0]?.data).toMatchObject({ reason: "orphan_effect", effectIDs: [expect.any(String)] })
      const admissions = yield* db
        .select({ admissionId: V2ToolEffectAdmissionTable.admission_id })
        .from(V2ToolEffectAdmissionTable)
        .where(eq(V2ToolEffectAdmissionTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(budgetEvents[0]?.data["effectIDs"]).toEqual(admissions.map((effect) => effect.admissionId))
      yield* replaySessionProjection(sessionID)
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
        type: "assistant",
        content: [{ type: "tool", id: "call-await-interrupt", state: { status: "error" } }],
      })
    }),
  )

  it.effect("uses the configured final step for a durable text-only provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      const { db } = yield* Database.Service
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("auto"), (agent) => {
          agent.steps = 2
        }),
      )
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Finish at the configured limit" }),
        resume: false,
      })

      requests.length = 0
      executions.length = 0
      const configured = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-configured", name: "echo", input: { text: "done" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      const final = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-forbidden", name: "echo", input: { text: "forbidden" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      responseStream = Stream.unwrap(
        Effect.gen(function* () {
          const seal = yield* V2ProviderTurn.CurrentRequestSeal
          if (!seal) return yield* Effect.die("First configured provider request seal is missing")
          yield* seal
            .seal({
              wireHash: Hash.sha256("configured-step-one-wire"),
              bodyHash: Hash.sha256("configured-step-one-body"),
              bodyLength: 24,
              contentType: "application/json",
            })
            .pipe(Effect.orDie)
          responseStream = Stream.unwrap(
            Effect.gen(function* () {
              const seal = yield* V2ProviderTurn.CurrentRequestSeal
              if (!seal) return yield* Effect.die("Final configured provider request seal is missing")
              yield* seal
                .seal({
                  wireHash: Hash.sha256("configured-final-step-wire"),
                  bodyHash: Hash.sha256("configured-final-step-body"),
                  bodyLength: 28,
                  contentType: "application/json",
                })
                .pipe(Effect.orDie)
              return Stream.fromIterable(final)
            }),
          )
          return Stream.fromIterable(configured)
        }),
      )

      const failure = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "SessionRunner.StepLimitExceededError", limit: 2 })

      expect(requests).toHaveLength(2)
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[1]?.tools.map((tool) => tool.name)).toContain("echo")
      expect(requests[1]?.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(executions).toEqual(["done"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Finish at the configured limit" },
        { type: "assistant", content: [{ type: "tool", id: "call-configured", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "tool", id: "call-forbidden", state: { status: "error" } }] },
      ])
      const receipts = yield* db
        .select()
        .from(V2ProviderTurnReceiptTable)
        .orderBy(asc(V2ProviderTurnReceiptTable.request_ordinal))
        .all()
        .pipe(Effect.orDie)
      expect(receipts).toHaveLength(2)
      expect(receipts.map((receipt) => receipt.state)).toEqual(["settled", "settled"])
      expect(receipts[1]?.prepared_turn).toMatchObject({
        tool_choice: "none",
        tool_final_offered_ids: expect.arrayContaining(["echo"]),
        history_message_count: (requests[1]?.messages.length ?? 1) - 1,
      })
    }),
  )

  it.effect("runs past the default step ceiling when the agent budget is configured higher", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      // 30 > the MAX_STEPS fallback (25): before the drain honored the configured budget this
      // run died with StepLimitExceeded at turn 25; now the budget is the ceiling.
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("auto"), (agent) => {
          agent.steps = 30
        }),
      )
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Serial tool loop past the default ceiling" }),
        resume: false,
      })

      requests.length = 0
      const toolTurn = (i: number) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: `call-past-${i}`, name: "echo", input: { text: `turn${i}` } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      responseStreams = Array.from({ length: 29 }, (_, i) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const seal = yield* V2ProviderTurn.CurrentRequestSeal
            if (!seal) return yield* Effect.die(`Seal missing for serial turn ${i}`)
            yield* seal
              .seal({
                wireHash: Hash.sha256(`serial-turn-${i}-wire`),
                bodyHash: Hash.sha256(`serial-turn-${i}-body`),
                bodyLength: 12,
                contentType: "application/json",
              })
              .pipe(Effect.orDie)
            return Stream.fromIterable(toolTurn(i))
          }),
        ),
      )
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(30)
      // 29 tool turns + 1 final stop turn all ran; the transcript carries every assistant row.
      const context = yield* session.context(sessionID)
      expect(context[0]).toMatchObject({ type: "user", text: "Serial tool loop past the default ceiling" })
      expect(context.filter((m) => m.type === "assistant" && m.content?.[0]?.type === "tool")).toHaveLength(29)
      expect(context.at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
    }),
  )

  // RI-26 convergence W2: the Core `task` tool delegates to a child session (real drain, real
  // subagent turn) and the parent receives the child's final text as the tool result.
  it.effect("task delegates to a child session and returns the subagent result", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const agentsSvc = yield* AgentV2.Service
      yield* agentsSvc.update((editor) => {
        editor.update(AgentV2.defaultID, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "edit", resource: "*", effect: "ask" })
        })
        editor.update(AgentV2.ID.make("general"), (agent) => {
          agent.mode = "subagent"
          agent.permissions.push({ action: "*", resource: "*", effect: "deny" })
        })
        editor.default(AgentV2.defaultID)
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "delegate research" }), resume: false })

      requests.length = 0
      permissionAssertions.length = 0
      const sealed = (label: string, events: readonly LLMEvent[]) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const seal = yield* V2ProviderTurn.CurrentRequestSeal
            if (!seal) return yield* Effect.die(`Seal missing for ${label}`)
            yield* seal
              .seal({
                wireHash: Hash.sha256(`${label}-wire`),
                bodyHash: Hash.sha256(`${label}-body`),
                bodyLength: 12,
                contentType: "application/json",
              })
              .pipe(Effect.orDie)
            return Stream.fromIterable(events)
          }),
        )
      responseStreams = [
        sealed("task-parent-tool", [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-task-1",
            name: "task",
            input: {
              description: "research subagent",
              prompt: "Research and report the answer to 40+2.",
              subagent_type: "general",
            },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
        sealed("task-child", [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "task-child-text" }),
          LLMEvent.textDelta({ id: "task-child-text", text: "research complete: 42" }),
          LLMEvent.textEnd({ id: "task-child-text" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ]),
        sealed("task-parent-final", [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "task-parent-text" }),
          LLMEvent.textDelta({ id: "task-parent-text", text: "delegation done" }),
          LLMEvent.textEnd({ id: "task-parent-text" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ]),
      ]
      yield* session.resume(sessionID)
      // Parent consumed 3 provider turns: tool-call, (child ran its own), final.
      expect(requests).toHaveLength(3)
      const context = yield* session.context(sessionID)
      expect(context.at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
      // The parent's transcript carries the delegation result from the child's turn.
      expect(JSON.stringify(context)).toContain("research complete: 42")
      // Exactly one child session exists: direct child of the parent, running agent general.
      const { db } = yield* Database.Service
      const children = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(children).toHaveLength(1)
      expect(children[0]?.agent).toBe("general")
      expect(children[0]?.permission).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
      expect(permissionAssertions).toMatchObject([
        {
          action: "task",
          resources: ["general"],
          sessionID,
          agent: AgentV2.defaultID,
          source: { type: "tool", callID: "call-task-1" },
        },
      ])
      const childContext = yield* session.context(children[0]!.id as SessionV2.ID)
      expect(childContext[0]).toMatchObject({ type: "user", text: "Research and report the answer to 40+2." })
      expect(childContext.at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
    }),
  )

  it.effect("runs past the default step ceiling via the config-level agent budget alone", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      // The production shape: NO AgentV2 registry entry exists (the app runtime registers none),
      // the budget arrives through config discovery (`.deepagent-code/config.json`).
      configAgents = { auto: new ConfigAgent.Info({ steps: 30 }) }
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Serial tool loop on the config budget" }),
        resume: false,
      })

      requests.length = 0
      const toolTurn = (i: number) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: `call-config-${i}`, name: "echo", input: { text: `turn${i}` } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      responseStreams = Array.from({ length: 29 }, (_, i) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const seal = yield* V2ProviderTurn.CurrentRequestSeal
            if (!seal) return yield* Effect.die(`Seal missing for config serial turn ${i}`)
            yield* seal
              .seal({
                wireHash: Hash.sha256(`config-serial-turn-${i}-wire`),
                bodyHash: Hash.sha256(`config-serial-turn-${i}-body`),
                bodyLength: 12,
                contentType: "application/json",
              })
              .pipe(Effect.orDie)
            return Stream.fromIterable(toolTurn(i))
          }),
        ),
      )
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(30)
      expect(requests[29]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[29]?.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
    }),
  )

  it.effect("resets the configured step allowance when steering input is promoted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("auto"), (agent) => {
          agent.steps = 2
        }),
      )
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start work" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-steer", name: "echo", input: { text: "before" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-after-steer", name: "echo", input: { text: "after" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(requests[1]?.toolChoice).toBeUndefined()
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(executions).toEqual(["before", "after"])
    }),
  )

  it.effect("fails after the bounded number of local tool continuation steps", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Loop forever" }), resume: false })

      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      streamGate = undefined
      streamStarted = undefined
      responses = Array.from({ length: 25 }, (_, index) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])

      const failure = yield* session.resume(sessionID).pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "SessionRunner.StepLimitExceededError", sessionID, limit: 25 })
      expect(requests).toHaveLength(25)
      expect(executions).toHaveLength(24)
      const { db } = yield* Database.Service
      const budgetEvents = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.durableType(SessionEvent.LoopBudget.Triggered)))
        .all()
        .pipe(Effect.orDie)
      expect(budgetEvents).toHaveLength(1)
      expect(budgetEvents[0]?.data).toMatchObject({ reason: "steps", limit: 25, used: 25 })
      expect(
        yield* db
          .select({ state: SessionActivityTable.state })
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ state: "failed" }])
    }),
  )

  it.effect("stops a third identical tool call before execution and records the loop receipt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Repeat one tool" }), resume: false })
      requests.length = 0
      executions.length = 0
      responses = Array.from({ length: 3 }, (_, index) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: `call-repeat-${index}`, name: "echo", input: { text: "same" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])

      const failure = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "SessionRunner.RepeatedToolError", tool: "echo", count: 3 })
      expect(requests).toHaveLength(3)
      expect(executions).toEqual(["same", "same"])
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
        type: "assistant",
        content: [{ type: "tool", id: "call-repeat-2", state: { status: "error" } }],
      })
      const { db } = yield* Database.Service
      const budgetEvents = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.durableType(SessionEvent.LoopBudget.Triggered)))
        .all()
        .pipe(Effect.orDie)
      expect(budgetEvents).toHaveLength(1)
      expect(budgetEvents[0]?.data).toMatchObject({ reason: "repeated_tool", tool: "echo", used: 3 })
      expect(
        yield* db
          .select({ state: SessionActivityTable.state })
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ state: "failed" }])
    }),
  )

  it.effect("restores the active activity's settled tool streak on explicit resume", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Resume an active tool streak" }), resume: false })
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const promoted = yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      expect(promoted).toHaveLength(1)
      yield* (yield* SessionContext.Service).openActivity({ sessionId: sessionID, triggerInputId: promoted[0]! })
      // These are the committed tool-call/result facts left by prior provider turns. A fresh
      // runner drain must rebuild its detector from the active activity's durable event suffix.
      const assistantMessageID = SessionMessage.ID.create()
      for (const callID of ["before-restart-1", "before-restart-2"]) {
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          tool: "echo",
          input: { text: "same" },
          provider: { executed: false },
        })
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          structured: {},
          content: [],
          provider: { executed: false },
        })
      }
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "after-restart-3", name: "echo", input: { text: "same" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]
      const failure = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "SessionRunner.RepeatedToolError", tool: "echo", count: 3 })
      expect(executions).toEqual([])
    }),
  )

  it.effect("restores the active activity's spent step ceiling before another provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("auto"), (agent) => {
          agent.steps = 2
        }),
      )
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Resume a capped activity" }), resume: false })
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const promoted = yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      yield* (yield* SessionContext.Service).openActivity({ sessionId: sessionID, triggerInputId: promoted[0]! })
      for (const index of [1, 2]) {
        const assistantMessageID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          agent: "auto",
          model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
        })
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID: `before-restart-step-${index}`,
          tool: "echo",
          input: { text: `${index}` },
          provider: { executed: false },
        })
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID: `before-restart-step-${index}`,
          structured: {},
          content: [],
          provider: { executed: false },
        })
        yield* events.publish(SessionEvent.Step.Ended, {
          sessionID,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          finish: "tool-calls",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
      }
      requests.length = 0
      const failure = yield* session.resume(sessionID).pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "SessionRunner.StepLimitExceededError", limit: 2 })
      expect(requests).toHaveLength(0)
      const budgetEvents = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.durableType(SessionEvent.LoopBudget.Triggered)))
        .all()
        .pipe(Effect.orDie)
      expect(budgetEvents).toHaveLength(1)
      expect(budgetEvents[0]?.data).toMatchObject({ reason: "steps", limit: 2, used: 2 })
    }),
  )

  it.effect("resets restored steps at the latest already-promoted steer", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("auto"), (agent) => {
          agent.steps = 1
        }),
      )
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Original instruction" }), resume: false })
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const promoted = yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      yield* (yield* SessionContext.Service).openActivity({ sessionId: sessionID, triggerInputId: promoted[0]! })
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        agent: "auto",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "New steer" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Original instruction", "New steer"])
    }),
  )

  it.effect("settles a durable final response without spending another step on resume", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("auto"), (agent) => {
          agent.steps = 1
        }),
      )
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Already answered" }), resume: false })
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const promoted = yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      yield* (yield* SessionContext.Service).openActivity({ sessionId: sessionID, triggerInputId: promoted[0]! })
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        agent: "auto",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      requests.length = 0
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(0)
      expect(
        yield* db
          .select({ state: SessionActivityTable.state })
          .from(SessionActivityTable)
          .where(eq(SessionActivityTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ state: "settled" })
      expect(
        yield* db
          .select({ seq: EventTable.seq })
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.durableType(SessionEvent.LoopBudget.Triggered)))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
    }),
  )

  it.effect("does not restart a capped tool loop for a coalesced stale wake", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Loop forever" }), resume: false })

      requests.length = 0
      responses = Array.from({ length: 25 }, (_, index) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: `call-capped-${index}`, name: "echo", input: { text: `${index}` } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* execution.wake(sessionID)
      yield* Deferred.succeed(streamGate, undefined)
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toMatchObject({ _tag: "SessionRunner.StepLimitExceededError" })
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(25)
    }),
  )

  it.effect("accepts a terminal response on the final bounded provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Finish at the limit" }), resume: false })

      requests.length = 0
      responses = [
        ...Array.from({ length: 24 }, (_, index) => [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: `call-terminal-${index}`, name: "echo", input: { text: `${index}` } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(25)
    }),
  )

  it.effect("projects provider errors as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail durably" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("projects provider errors emitted before assistant step start", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail before step" }), resume: false })

      requests.length = 0
      response = [LLMEvent.providerError({ message: "Provider unavailable" })]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail before step" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not recover context overflow after durable assistant output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail after output" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-partial" }),
        LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
        LLMEvent.textEnd({ id: "text-partial" }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail after output" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  it.effect("projects raw provider stream failures as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail raw stream durably" }), resume: false })
      // A sealed mid-stream transport failure propagates after one physical request; the receipt
      // remains indeterminate while the user-facing projection records the observed failure.
      const failure = providerUnavailable()
      const sealThenFail = (wire: string) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const seal = yield* V2ProviderTurn.CurrentRequestSeal
            if (!seal) return yield* Effect.die("Raw-failure request seal is missing")
            yield* seal
              .seal({
                wireHash: Hash.sha256(wire),
                bodyHash: Hash.sha256(`${wire}-body`),
                bodyLength: 4,
                contentType: "application/json",
              })
              .pipe(Effect.orDie)
            return Stream.fail(failure)
          }),
        )
      requests.length = 0
      responseStream = sealThenFail("raw-failure-1")
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      expect(requests).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail raw stream durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not continue automatically after a provider error follows a local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Do not continue failed provider" }),
        resume: false,
      })

      requests.length = 0
      const executionCount = executions.length
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-before-provider-error", name: "echo", input: { text: "settled" } }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(executions.slice(executionCount)).toEqual(["settled"])
    }),
  )

  it.effect("durably fails a hosted tool when its provider errors before returning a result", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail hosted tool durably" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-provider-error",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool durably" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-hosted-provider-error", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved at normal provider EOF", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Fail hosted tool at EOF" }), resume: false })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-eof",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
      ]

      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool at EOF" },
        { type: "assistant", content: [{ type: "tool", id: "call-hosted-eof", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved by a raw provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Fail hosted tool on raw failure" }),
        resume: false,
      })
      const failure = providerUnavailable()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-raw-failure",
            name: "web_search",
            input: { query: "effect" },
            providerExecuted: true,
          }),
        ]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool on raw failure" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          content: [{ type: "tool", id: "call-hosted-raw-failure", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("keeps interleaved assistant text blocks separate", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Two blocks" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-1", text: "First" }),
        LLMEvent.textDelta({ id: "text-2", text: "Second" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Two blocks" },
        {
          type: "assistant",
          content: [
            { type: "text", id: "text-1", text: "First" },
            { type: "text", id: "text-2", text: "Second" },
          ],
        },
      ])
    }),
  )

  for (const kind of fragmentKinds) {
    it.effect(`broadcasts provider ${kind} deltas without storing projection rewrites`, () =>
      verifyEphemeralDeltas(kind),
    )

    it.effect(`durably closes partial ${kind} when the provider stream fails`, () => verifyPartialFlushOnFailure(kind))

    it.effect(`durably closes partial ${kind} when the provider stream is interrupted`, () =>
      verifyPartialFlushOnInterruption(kind),
    )
  }

  it.effect("rejects duplicate streamed text starts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.textStart({ id: "text-1" }), LLMEvent.textStart({ id: "text-1" })]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Reject duplicate text starts" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Duplicate text start: text-1",
      )
    }),
  )

  it.effect("transitions streamed raw tool input to parsed called input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Call provider tool" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolInputDelta({ id: "call-parsed", name: "web_search", text: '{"query":"hello"}' }),
        LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolCall({ id: "call-parsed", name: "web_search", input: { query: "hello" }, providerExecuted: true }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call provider tool" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-parsed", state: { status: "error", input: { query: "hello" } } }],
        },
      ])
    }),
  )

  it.effect("rejects malformed streamed tool input ordering", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" })]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Reject malformed tool input" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Tool input delta before start: call-1",
      )
    }),
  )

  // -------------------------------------------------------------------------------------------------
  // W1.1 — goal_steer drain (design W1 §1): rows admitted with delivery "goal_steer" are delivered to
  // the ACTIVE goal's durable runtime state (never promoted into the transcript), consumed once
  // delivered, and — with no active goal — stay pending with ONE deterministic waiting notice.
  // -------------------------------------------------------------------------------------------------

  const passingPorts = (): GraderPorts => ({
    runTests: () => Effect.succeed({ pass: true }),
    diagnostics: () => Effect.succeed({ maxSeverity: null }),
    reviewerClean: () => Effect.succeed({ pass: true }),
    panelApproves: () => Effect.succeed({ decision: "approve" }),
  })
  const noopExecutor: StepExecutor = () => Effect.succeed({ tokensUsed: 10 })
  const noopRollback: RollbackPort = () => Effect.void
  const goalDeps = (store: DocumentStore, over: Partial<ControllerDeps> = {}): ControllerDeps => ({
    store,
    ports: passingPorts(),
    executor: noopExecutor,
    rollback: noopRollback,
    now: () => Date.now(),
    ...over,
  })
  const pendingStep = (id: string): PlanStep => ({
    step_id: id,
    title: id,
    status: "pending",
    acceptance: null,
    assigned_agent: null,
    evidence: [],
    note: null,
  })
  const readGoalState = (store: DocumentStore, sessionId: string, goalId: string) =>
    store
      .list({ type: "run_context", scope: planScope(sessionId) })
      .map((ref) => store.get(ref.id))
      .find((doc) => doc?.extensions?.goal_id === goalId)

  it.effect("delivers a goal_steer to the active goal and consumes the row without a provider turn", () =>
    Effect.gen(function* () {
      yield* setup
      const root = mkdtempSync(tmpRootShared())
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          // session-state is PROCESS-GLOBAL: drop the active-goal pointer so the next test starts
          // from a no-goal posture (its in-memory session map would otherwise leak it).
          setActiveGoalPointer(sessionID, null)
          rmSync(root, { recursive: true, force: true })
        }),
      )
      configureSessionState(root)
      getOrCreateSessionState(sessionID, "high")
      const store = DocumentStore.shared(planStoreRoot(sessionID))
      const plan = createPlanDoc(sessionID, "Reach the goal", [pendingStep("a")])
      const planDoc = store.upsert({
        type: "plan",
        scope: planScope(sessionID),
        description: `plan ${sessionID}`,
        idSlug: `plan-${sessionID}`,
        body: JSON.stringify(plan),
        provenance: { source: "model", run_ref: planScope(sessionID) },
      })
      const handle = yield* makeGoalLoop(goalDeps(store)).start({
        planDocId: planDoc.id,
        criteria: [{ kind: "plan_complete" }],
        limits: { maxTicks: 100, maxTokens: 100_000, maxWallclockMs: 100_000 },
        stallThreshold: 3,
      })
      setActiveGoalPointer(sessionID, {
        goalId: handle.goalId,
        planDocId: handle.planDocId,
        phase: "running",
        startedAt: new Date().toISOString(),
      })

      requests.length = 0
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Weigh the edge case before finishing" }),
        delivery: "goal_steer",
      })
      yield* (yield* SessionExecution.Service).awaitIdle(sessionID)

      // Drain-only: the steer reaches the goal WITHOUT dispatching a provider turn (the goal's own
      // next tick drives the model).
      expect(requests).toHaveLength(0)
      const state = readGoalState(store, sessionID, handle.goalId)
      expect(state).toBeDefined()
      const runtime = JSON.parse(state!.body) as { pendingSteers: readonly { id: string; text: string }[] }
      expect(runtime.pendingSteers).toEqual([expect.objectContaining({ text: "Weigh the edge case before finishing" })])
      // The session_input row is stamped consumed (idempotent by row id).
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(row).toHaveLength(1)
      expect(row[0]!.delivery).toBe("goal_steer")
      expect(row[0]!.promoted_seq).not.toBeNull()
      // No waiting notice: the steer was delivered.
      expect((yield* session.context(sessionID)).some((message) => message.type === "synthetic")).toBe(false)
    }),
  )

  it.effect("keeps a goal_steer pending and publishes one waiting notice when no goal is active", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Re-prioritise once a goal starts" }),
        delivery: "goal_steer",
      })
      yield* (yield* SessionExecution.Service).awaitIdle(sessionID)

      expect(requests).toHaveLength(0)
      const notices = (yield* session.context(sessionID)).filter((message) => message.type === "synthetic")
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatchObject({ text: SessionInput.GOAL_STEER_PENDING_NOTICE })
      // No loss: the row stays pending so a goal started later can still absorb the guidance.
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(row).toHaveLength(1)
      expect(row[0]!.promoted_seq).toBeNull()
      // Idempotent notice: a repeated drain does not fan out a second waiting notice.
      yield* session.resume(sessionID)
      expect((yield* session.context(sessionID)).filter((message) => message.type === "synthetic")).toHaveLength(1)
    }),
  )

  // -------------------------------------------------------------------------------------------------
  // W1.2 — SessionV2 manual command typing: wait/switchAgent are REAL (SessionExecution.awaitIdle /
  // the AgentSwitched event service); shell/skill/compact stay typed-unavailable but now carry the
  // concrete reason instead of a bare operation code.
  // -------------------------------------------------------------------------------------------------

  it.effect("wait resolves only after the active drain settles (awaitIdle)", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [fragmentFixture("text", "text-wait", ["Settled"]).completeEvents]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)

      const waited = yield* Deferred.make<void>()
      const waiter = yield* session
        .wait(sessionID)
        .pipe(Effect.ensuring(Deferred.succeed(waited, undefined)), Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(waited)).toBe(false)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(run)
      expect(yield* Deferred.isDone(waited)).toBe(true) // wait resolves now that the drain settled
      yield* Fiber.join(waiter)
    }),
  )

  it.effect("switchAgent records the agent switch durably through the session event", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.switchAgent({ sessionID, agent: "research" })
      expect((yield* session.get(sessionID)).agent).toBe(AgentV2.ID.make("research"))
      expect(yield* session.context(sessionID)).toMatchObject([{ type: "agent-switched", agent: "research" }])
    }),
  )

  it.effect("RI-18 native manual compaction settles the durable request chain", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      responses = [
        fragmentFixture("text", "first-reply", ["reply one"]).completeEvents,
        fragmentFixture("text", "second-reply", ["reply two"]).completeEvents,
      ]
      yield* session.prompt({
        id: SessionMessage.ID.create(),
        sessionID,
        prompt: new Prompt({ text: "first exchange about apples" }),
      })
      yield* execution.awaitIdle(sessionID)
      yield* session.prompt({
        id: SessionMessage.ID.create(),
        sessionID,
        prompt: new Prompt({ text: "second exchange" }),
      })
      yield* execution.awaitIdle(sessionID)
      requests.length = 0
      responses = [fragmentFixture("text", "manual-summary", ["Summary of the first exchange"]).completeEvents]
      currentModel = compactModel

      yield* session.compact({
        sessionID,
        model: { providerID: ProviderV2.ID.make(compactModel.provider), modelID: ModelV2.ID.make(compactModel.id) },
      })
      currentModel = model

      const request = yield* db
        .select()
        .from(CompactionRequestTable)
        .where(eq(CompactionRequestTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(request).toMatchObject({ status: "settled", outcome: "compacted" })
      expect(request?.summary_receipt_id).toBeTruthy()
      // The manual summary turn is one tool-less provider request carrying the compacted head.
      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools ?? []).toHaveLength(0)
      expect(JSON.stringify(requests[0]?.messages)).toContain("first exchange about apples")

      // The compacted head is bounded out of the next turn's request.
      requests.length = 0
      responses = [fragmentFixture("text", "post-reply", ["reply three"]).completeEvents]
      yield* session.prompt({
        id: SessionMessage.ID.create(),
        sessionID,
        prompt: new Prompt({ text: "after compaction" }),
      })
      yield* execution.awaitIdle(sessionID)
      const serialized = JSON.stringify(requests.at(-1)?.messages)
      expect(serialized).not.toContain("first exchange about apples")
      expect(serialized).toContain("after compaction")
    }),
  )

  it.effect("manual compaction does not dispatch a summary beyond the physical input budget", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      responses = [
        fragmentFixture("text", "budget-first", ["first settled"]).completeEvents,
        fragmentFixture("text", "budget-second", ["second settled"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "x".repeat(36_000) }) })
      yield* execution.awaitIdle(sessionID)
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "retain this exchange" }) })
      yield* execution.awaitIdle(sessionID)

      const summaryModel = Model.make({
        id: "deepseek-flash",
        provider: "deepseek",
        route: OpenAIChat.route.with({ limits: { context: 10_000, output: 512 } }),
      })
      currentModel = summaryModel
      requests.length = 0
      responses = [fragmentFixture("text", "unsafe-summary", ["summary must not dispatch"]).completeEvents]
      const refusal = yield* session.compact({
        sessionID,
        model: { providerID: ProviderV2.ID.make(summaryModel.provider), modelID: ModelV2.ID.make(summaryModel.id) },
      }).pipe(Effect.flip)
      expect(refusal).toMatchObject({ operation: "compact", reason: "summary_budget_exceeded" })

      const request = yield* db.select().from(CompactionRequestTable)
        .where(eq(CompactionRequestTable.session_id, sessionID)).get().pipe(Effect.orDie)
      expect(request).toMatchObject({ status: "failed", outcome: "summary_budget_exceeded", summary_receipt_id: null })
      expect(requests).toHaveLength(0)
      expect(yield* db.select().from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID)).all().pipe(Effect.orDie))
        .toHaveLength(2)
    }),
  )

  it.effect("manual compaction keeps a genuine single-exchange no-op successful", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const execution = yield* SessionExecution.Service
      const { db } = yield* Database.Service
      responses = [fragmentFixture("text", "one-reply", ["one settled reply"]).completeEvents]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "one exchange" }) })
      yield* execution.awaitIdle(sessionID)

      currentModel = compactModel
      requests.length = 0
      yield* session.compact({
        sessionID,
        model: { providerID: ProviderV2.ID.make(compactModel.provider), modelID: ModelV2.ID.make(compactModel.id) },
      })

      const request = yield* db.select().from(CompactionRequestTable)
        .where(eq(CompactionRequestTable.session_id, sessionID)).get().pipe(Effect.orDie)
      expect(request).toMatchObject({ status: "settled", outcome: "nothing_to_compact", summary_receipt_id: null })
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("manual compaction reports remote uncertainty and never replays the same request", () =>
    Effect.gen(function* () {
      const session = yield* setupManualHistory
      const { db } = yield* Database.Service
      currentModel = responsesRecoveryModel
      remoteCompactionMode = "refused"
      yield* Effect.addFinalizer(() => Effect.sync(() => { remoteCompactionMode = undefined }))
      const input = {
        sessionID,
        model: { providerID: ProviderV2.ID.make(currentModel.provider), modelID: ModelV2.ID.make(currentModel.id) },
      }

      const refusal = yield* session.compact(input).pipe(Effect.flip)
      expect(refusal).toMatchObject({ operation: "compact", reason: "network_unknown" })
      const request = yield* db.select().from(CompactionRequestTable)
        .where(eq(CompactionRequestTable.session_id, sessionID)).get().pipe(Effect.orDie)
      expect(request).toMatchObject({ status: "recovery_required", outcome: "network_unknown" })
      expect(remoteCompactionCalls).toBe(1)
      expect(requests).toHaveLength(0)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)

      expect(yield* session.compact(input).pipe(Effect.flip)).toMatchObject({ reason: "network_unknown" })
      expect(remoteCompactionCalls).toBe(1)
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("manual compaction reports a settled provider error as failure", () =>
    Effect.gen(function* () {
      const session = yield* setupManualHistory
      const { db } = yield* Database.Service
      currentModel = compactModel
      responseStream = sealedResponse([LLMEvent.providerError({ message: "summary rejected" })], "manual-error")

      const refusal = yield* session.compact({
        sessionID,
        model: { providerID: ProviderV2.ID.make(compactModel.provider), modelID: ModelV2.ID.make(compactModel.id) },
      }).pipe(Effect.flip)
      expect(refusal).toMatchObject({ operation: "compact", reason: "summary_provider_error" })
      const request = yield* db.select().from(CompactionRequestTable)
        .where(eq(CompactionRequestTable.session_id, sessionID)).get().pipe(Effect.orDie)
      expect(request).toMatchObject({ status: "failed", outcome: "summary_provider_error" })
      expect(request?.summary_receipt_id).toBeTruthy()
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("manual compaction rejects an empty settled summary", () =>
    Effect.gen(function* () {
      const session = yield* setupManualHistory
      const { db } = yield* Database.Service
      currentModel = compactModel
      responseStream = sealedResponse([], "manual-empty")

      const refusal = yield* session.compact({
        sessionID,
        model: { providerID: ProviderV2.ID.make(compactModel.provider), modelID: ModelV2.ID.make(compactModel.id) },
      }).pipe(Effect.flip)
      expect(refusal).toMatchObject({ operation: "compact", reason: "summary_empty" })
      const request = yield* db.select().from(CompactionRequestTable)
        .where(eq(CompactionRequestTable.session_id, sessionID)).get().pipe(Effect.orDie)
      expect(request).toMatchObject({ status: "failed", outcome: "summary_empty" })
      expect(request?.summary_receipt_id).toBeTruthy()
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("manual compaction reports a terminal summary refusal as failed", () =>
    Effect.gen(function* () {
      const session = yield* setupManualHistory
      const { db } = yield* Database.Service
      currentModel = compactModel
      responseStream = Stream.concat(
        sealedResponse([], "manual-overflow"),
        Stream.fail(new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidRequestReason({ message: "prompt too long", classification: "context-overflow" }),
        })),
      )

      const refusal = yield* session.compact({
        sessionID,
        model: { providerID: ProviderV2.ID.make(compactModel.provider), modelID: ModelV2.ID.make(compactModel.id) },
      }).pipe(Effect.flip)
      expect(refusal).toMatchObject({ operation: "compact", reason: "summary_provider_failed" })
      expect(yield* db.select().from(CompactionRequestTable)
        .where(eq(CompactionRequestTable.session_id, sessionID)).get().pipe(Effect.orDie))
        .toMatchObject({ status: "failed", outcome: "summary_provider_failed" })
      expect(yield* db.select().from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
        .orderBy(desc(V2ProviderTurnReceiptTable.request_ordinal)).get().pipe(Effect.orDie))
        .toMatchObject({ state: "failed" })
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("manual compaction quarantines a sealed summary stream failure without replay", () =>
    Effect.gen(function* () {
      const session = yield* setupManualHistory
      const { db } = yield* Database.Service
      currentModel = compactModel
      responseStream = Stream.concat(sealedResponse([], "manual-unknown"), Stream.fail(providerUnavailable()))
      const input = {
        sessionID,
        model: { providerID: ProviderV2.ID.make(compactModel.provider), modelID: ModelV2.ID.make(compactModel.id) },
      }

      const refusal = yield* session.compact(input).pipe(Effect.flip)
      expect(refusal).toMatchObject({ operation: "compact", reason: "summary_provider_outcome_unknown" })
      const request = yield* db.select().from(CompactionRequestTable)
        .where(eq(CompactionRequestTable.session_id, sessionID)).get().pipe(Effect.orDie)
      expect(request).toMatchObject({ status: "recovery_required", outcome: "summary_provider_outcome_unknown" })
      const receipt = yield* db.select().from(V2ProviderTurnReceiptTable)
        .where(eq(V2ProviderTurnReceiptTable.session_id, sessionID))
        .orderBy(desc(V2ProviderTurnReceiptTable.request_ordinal)).get().pipe(Effect.orDie)
      expect(receipt).toMatchObject({ state: "indeterminate_after_crash" })
      expect(request?.summary_receipt_id).toBe(receipt?.receipt_id)
      expect(requests).toHaveLength(1)

      expect(yield* session.compact(input).pipe(Effect.flip)).toMatchObject({ reason: "summary_provider_outcome_unknown" })
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("refuses compact/shell/skill with a typed reason instead of a silent no-op", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const compactErr = yield* session.compact({ sessionID }).pipe(Effect.flip)
      expect(compactErr).toMatchObject({ operation: "compact" })
      // RI-18 native: compaction is implemented; refusing without an explicit summary model is
      // the remaining typed guard (never a defaulted or fabricated identity).
      expect((compactErr as SessionV2.OperationUnavailableError).reason).toContain(
        "manual compaction requires an explicit summary model identity",
      )
      expect(compactErr).not.toBe(undefined)
      const shellErr = yield* session.shell({ sessionID, command: "ls" }).pipe(Effect.flip)
      expect(shellErr).toMatchObject({ operation: "shell" })
      expect((shellErr as SessionV2.OperationUnavailableError).reason).toContain("manual shell execution is not wired")
      const skillErr = yield* session.skill({ sessionID, skill: "test" }).pipe(Effect.flip)
      expect(skillErr).toMatchObject({ operation: "skill" })
      expect(skillErr).not.toBe(undefined)
    }),
  )

  // -------------------------------------------------------------------------------------------------
  // W1.3 — remote compact differentiation: a producer's TYPED refusal enters compact recovery
  // (no fabricated Compaction.Ended, no local summary success) just like an untyped fault.
  // -------------------------------------------------------------------------------------------------

  it.effect("does not disguise a typed remote compact refusal as a local success (W1.3)", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      remoteCompactionMode = "refused"
      currentModel = responsesRecoveryModel
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          remoteCompactionMode = undefined
        }),
      )
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        fragmentFixture("text", "text-final", ["Recovered after refusal"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      // Exactly one physical request: the refused remote compact never dispatched a fake summary.
      expect(requests).toHaveLength(1)
      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
    }),
  )
})
