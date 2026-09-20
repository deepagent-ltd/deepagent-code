import { describe, expect } from "bun:test"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@deepagent-code/llm"
import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, LayerMap, Option, Schema, Stream } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { AgentV2 } from "@deepagent-code/core/agent"
import { AgentPlugin } from "@deepagent-code/core/plugin/agent"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { Catalog } from "@deepagent-code/core/catalog"
import { Config as CoreConfig } from "@deepagent-code/core/config"
import { ConfigCompaction } from "@deepagent-code/core/config/compaction"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { ProductionV2Sources } from "@deepagent-code/core/context-federation/production-adapters"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { Location } from "@deepagent-code/core/location"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { SessionCompaction } from "@deepagent-code/core/session/compaction"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import * as SessionRunnerLLM from "@deepagent-code/core/session/runner/llm"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2ToolEffect } from "@deepagent-code/core/session/runner/v2-tool-effect"
import { V2TaskRunReceiptTable } from "@deepagent-code/core/session/runner/v2-task-run-receipt.sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionInputTable, SessionTable, TaskRunTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionV2 } from "@deepagent-code/core/session"
import { TaskRunDispatcher } from "@deepagent-code/core/session/task-run-dispatcher"
import { TaskTool as CoreTaskTool } from "@deepagent-code/core/tool/task"
import { SkillGuidance } from "@deepagent-code/core/skill/guidance"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SystemContext } from "@deepagent-code/core/system-context"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { ToolRegistry as CoreToolRegistry } from "@deepagent-code/core/tool/registry"
import { ToolOutputStore } from "@deepagent-code/core/tool-output-store"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

// V2-authority E2E for the V1-registry app TaskTool: every fresh launch rides the Core
// TaskRunAuthority (ONE durable ledger row with execution_runtime='v2', ONE first session_input,
// fenced terminal settle + compensation receipt), follow-up turns drive through the same V2
// runtime, and background launches are drained by the process-global Core dispatcher with the
// outbox delivering exactly one queue-mode input to the parent. The runner harness mirrors the
// core task-run-dispatcher test (one fake text turn per drain).

// Every provider turn returns prose embedding a JSON payload: schema-less launches surface the
// prose, structured finalizers extract the payload via the shared extractor (a drain may issue
// auxiliary provider calls, so per-turn classification would overfit the runner's internals).
let payloadJson = '{"answer":42}'

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: (() => Stream.fromIterable(textResponse(`research result body ${payloadJson}`))) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

const textResponse = (text: string, id = "txt_task") => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const directory = AbsolutePath.make("/project")

const database = Database.layerFromPath(":memory:")
const selectionSourcesLayer = Layer.succeed(ProductionV2Sources, {})
const providerTurns = V2ProviderTurn.layer.pipe(
  Layer.provide(SessionProviderOwner.layer.pipe(Layer.provide(database))),
  Layer.provide(database),
)
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const fakeModel = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith(() => Effect.succeed({ model: fakeModel }))
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const applications = ApplicationTools.layer
const coreRegistry = CoreToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(applications),
  Layer.provide(ToolOutputStore.defaultLayer),
)
const agents = AgentV2.layer
const systemContextKey = SystemContext.Key.make("test/context")
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine([
            SystemContext.make({
              key: systemContextKey,
              codec: Schema.toCodecJson(Schema.String),
              load: Effect.succeed("Initial context"),
              baseline: String,
              update: (_previous, current) => current,
              removed: () => "System context source removed: test/context",
            }),
          ]),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(SystemContextRegistry.layer))
const location = Location.layer({ directory }).pipe(Layer.provide(Project.defaultLayer))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
})
const coreConfig = Layer.succeed(
  CoreConfig.Service,
  CoreConfig.Service.of({
    entries: () =>
      Effect.succeed([
        new CoreConfig.Document({
          type: "document",
          info: new CoreConfig.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
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
      get: (providerID, modelID) => Effect.fail(new Catalog.ModelNotFoundError({ providerID, modelID })),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
      default: () => Effect.succeed(Option.none()),
      small: () => Effect.succeed(Option.none()),
    },
  }),
)
const testOwnerAuthorization = Layer.succeed(
  V2ProviderTurn.OwnerAuthorization,
  V2ProviderTurn.OwnerAuthorization.of({ authorize: () => Effect.succeed(true) }),
)
const grantLookupLayer = Layer.succeedContext(
  Context.make(V2ToolEffect.CurrentPermissionGrantLookup, () => Effect.succeed([])),
)
const historyEpochLookupLayer = Layer.succeedContext(
  Context.make(V2ProviderTurn.CurrentHistoryEpochLookup, () => Effect.succeed(undefined)),
)
const remoteCompactionLayer = Layer.succeedContext(
  Context.make(SessionCompaction.CurrentRemoteCompaction, () =>
    Effect.fail(new Error("remote compaction unavailable")),
  ),
)
const settleHookLayer = Layer.succeedContext(Context.make(SessionRunner.CurrentOnSessionSettled, () => Effect.void))
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
const sessionContext = SessionContext.layer.pipe(
  Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
  Layer.provide(database),
)
const runnerStack = SessionRunnerLLM.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(providerTurns),
  Layer.provide(V2ToolEffect.layer.pipe(Layer.provide(database))),
  Layer.provide(grantLookupLayer),
  Layer.provide(historyEpochLookupLayer),
  Layer.provide(remoteCompactionLayer),
  Layer.provide(sessionContext),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(events),
  Layer.provide(client),
  Layer.provide(coreRegistry),
  Layer.provide(models),
  Layer.provide(systemContext),
  Layer.provide(location),
  Layer.provide(agents),
  Layer.provide(skillGuidance),
  Layer.provide(coreConfig),
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
const runner = runnerStack.pipe(Layer.provideMerge(database))
const locations = Layer.effect(
  LocationServiceMap,
  LayerMap.make(() => runnerStack).pipe(
    // This harness supplies its instrumented runner as the complete keyed Location tree.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    Effect.map((service) => service as unknown as LocationServiceMap["Service"]),
  ),
)
const execution = SessionExecutionLocal.layer.pipe(
  Layer.provide(events),
  Layer.provide(store),
  Layer.provide(CoreTaskTool.delegationSlotLayer),
  Layer.provide(locations),
)
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
// The core V2 roster starts empty; PluginBoot populates the builtin set in production (RI-26:
// the Core roster is the single selectable authority mirroring the V1 names). Run the agent
// plugin's registration once for this harness so "researcher" resolves in the child drains.
const agentRoster = Layer.effectDiscard(
  AgentPlugin.Plugin.effect,
).pipe(Layer.provide(agents), Layer.provide(location))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(execution),
)

// The process-global background runtime the production roots mount (app-runtime/httpapi).
const taskRuntime = TaskRunDispatcher.runtimeLayer({ scanIntervalMs: 20 }).pipe(
  Layer.provide(database),
  Layer.provide(sessions),
)
// App-side registry services the V1-facing TaskTool entry still requires (agent roster for the
// policy gates, app config, runtime flags), pinned to the SAME in-memory database as the core
// stack (the .defaultLayer constants would self-provide a second connection).
const appFlags = RuntimeFlags.layer({ experimentalBackgroundSubagents: true })


// Facade task-subkind E2E on the ONE V2 owner: start → TaskRunAuthority background submission →
// process-global dispatcher drain → fenced settle → outbox queue input to the parent → the
// facade row converges to the durable terminal with the run's result receipt.
import { FacadeActivity } from "@/session/facade-activity"
import { Snapshot } from "@/snapshot"

const facadeLayer = Layer.effect(FacadeActivity.Service, FacadeActivity.build).pipe(
  Layer.provide(sessions),
  // The panel branch owns the snapshot surface; the task branch only captures it. A stub keeps
  // this harness free of the instance-context machinery Snapshot's layer builds with.
  Layer.provide(
    Layer.succeed(Snapshot.Service, {
      init: () => Effect.void,
      cleanup: () => Effect.void,
      track: () => Effect.succeed(undefined),
      trackOutcome: () => Effect.die("unused in the task facade test"),
      patch: () => Effect.die("unused in the task facade test"),
      restore: () => Effect.die("unused in the task facade test"),
      revert: () => Effect.die("unused in the task facade test"),
      diff: () => Effect.die("unused in the task facade test"),
      diffManifest: () => Effect.die("unused in the task facade test"),
      diffFullManifest: () => Effect.die("unused in the task facade test"),
    } as unknown as Snapshot.Interface),
  ),
  Layer.provide(Agent.defaultLayer),
  Layer.provide(appFlags),
  Layer.provide(database),
  Layer.provide(events),
)

const it = testEffect(
  Layer.mergeAll(database, events, projector, store, sessions, taskRuntime, appFlags, facadeLayer, agents, agentRoster),
)

const pollUntil = <A>(effect: Effect.Effect<A>, check: (value: A) => boolean, attempts = 200): Effect.Effect<A> =>
  effect.pipe(
    Effect.flatMap((value) =>
      check(value)
        ? Effect.succeed(value)
        : Effect.sleep(20).pipe(
            Effect.andThen(
              attempts > 1 ? pollUntil(effect, check, attempts - 1) : Effect.die(new Error("poll exhausted")),
            ),
          ),
    ),
  )

describe("facade-activity task subkind on the V2 authority", () => {
  it.instance(
    "start drains through the dispatcher, notifies the parent once, and settles the facade row",
    () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const v2 = yield* SessionV2.Service
      const parent = yield* v2.create({ title: "facade parent", location: { directory } })
      const facade = yield* FacadeActivity.Service

      const started = yield* facade.start({
        sessionID: parent.id,
        subkind: "task",
        objective: "research the facade path",
        spawnToolCallID: "call_facade_v2_e2e",
      })
      expect(started.ref.runID).toMatch(/^job/)
      expect(String(started.ref.childSessionID)).toMatch(/^ses_task_/)

      // The dispatcher claims + drains the background run to a fenced terminal settle.
      const settled = yield* pollUntil(
        db.select().from(TaskRunTable).where(eq(TaskRunTable.run_id, started.ref.runID)).get().pipe(Effect.orDie),
        (run) => run?.state === "completed",
      )
      expect(settled!.execution_runtime).toBe("v2")
      expect(settled!.delivery_mode).toBe("background")

      // The outbox delivered exactly ONE queue-mode parent input.
      const delivered = yield* pollUntil(
        db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, parent.id))
          .all()
          .pipe(Effect.orDie),
        (rows) => rows.some((row) => row.delivery === "queue"),
      )
      expect(delivered.filter((row) => row.delivery === "queue")).toHaveLength(1)

      // Lazy convergence settles the facade row from the durable terminal.
      const status = yield* facade.status({ sessionID: parent.id, subkind: "task" })
      expect(status[0]?.state).toBe("settled")
      const result = yield* facade.result({ sessionID: parent.id, subkind: "task" })
      expect(result.terminal).toBe(true)
      expect(result.receipt).toMatchObject({ runID: started.ref.runID, runState: "completed" })
    }),
  )
})
