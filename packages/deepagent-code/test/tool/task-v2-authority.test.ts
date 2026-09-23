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
import { V2StructuredOutputEvidenceTable } from "@deepagent-code/core/session/runner/v2-structured-output-evidence.sql"
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
import { MessageID, SessionID } from "@/session/schema"
import { TaskTool } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
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

const it = testEffect(
  Layer.mergeAll(
    database,
    events,
    projector,
    store,
    client,
    permission,
    applications,
    agents,
    agentRoster,
    coreRegistry,
    models,
    systemContext,
    location,
    skillGuidance,
    coreConfig,
    catalog,
    runner,
    locations,
    execution,
    sessions,
    taskRuntime,
    appFlags,
    Agent.defaultLayer,
    Config.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const seedParent = Effect.fn("TaskV2Test.seedParent")(function* () {
  const v2 = yield* SessionV2.Service
  const chat = yield* v2.create({ title: "v2 authority parent", location: { directory } })
  return { chat, assistant: MessageID.ascending() }
})

const ensureProject = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

function execCtx(input: { sessionID: SessionID; messageID: MessageID; callID: string }) {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
    callID: input.callID,
    agent: "build",
    abort: new AbortController().signal,
    extra: {},
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const pollUntil = <A>(effect: Effect.Effect<A>, check: (value: A) => boolean, attempts = 200): Effect.Effect<A> =>
  effect.pipe(
    Effect.flatMap((value) =>
      check(value)
        ? Effect.succeed(value)
        : Effect.sleep(20).pipe(
            Effect.andThen(
              attempts > 1
                ? pollUntil(effect, check, attempts - 1)
                : Effect.die(new Error("poll exhausted")),
            ),
          ),
    ),
  )

describe("tool.task V2 authority E2E", () => {
  it.instance("foreground launch: one v2 ledger row, one first input, terminal receipt", () =>
    Effect.gen(function* () {
      yield* ensureProject
      const { chat, assistant } = yield* seedParent()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          description: "probe module",
          prompt: "explain the module",
          subagent_type: "researcher",
          output_schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
        },
        execCtx({ sessionID: chat.id, messageID: assistant, callID: "tool_v2_foreground" }),
      )

      expect(result.output).toContain(`{"answer":42}`)
      const childID = (result.metadata as { sessionId: string }).sessionId

      const { db } = yield* Database.Service
      const runs = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.parent_session_id, chat.id)).all().pipe(Effect.orDie)
      expect(runs).toHaveLength(1)
      expect(runs[0]!.execution_runtime).toBe("v2")
      expect(runs[0]!.state).toBe("completed")
      expect(runs[0]!.delivery_mode).toBe("foreground")
      expect(String(runs[0]!.child_session_id)).toBe(childID)
      const brandedChildID = SessionID.make(childID)

      // The ONE durable first input (deterministic id, admitted exactly once) plus the single
      // finalizer follow-up — never a duplicate admission of the first prompt.
      const childInputs = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, brandedChildID))
        .all()
        .pipe(Effect.orDie)
      expect(childInputs).toHaveLength(2)
      expect(
        childInputs.filter((row) => String(row.id) === String(runs[0]!.child_message_id)),
      ).toHaveLength(1)

      // Terminal compensation receipt.
      const receipt = yield* db
        .select()
        .from(V2TaskRunReceiptTable)
        .where(eq(V2TaskRunReceiptTable.run_id, runs[0]!.run_id))
        .get()
        .pipe(Effect.orDie)
      expect(receipt?.state).toBe("completed")

      // The deterministic child session exists with the parent link.
      const child = yield* db
        .select({ parent: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, brandedChildID))
        .get()
        .pipe(Effect.orDie)
      expect(child?.parent).toBe(chat.id)
    }),
  )

  it.instance("structured output finalizes through the same V2 drive", () =>
    Effect.gen(function* () {
      yield* ensureProject
      const { chat, assistant } = yield* seedParent()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      payloadJson = '{"verdict":"solid"}'
      const result = yield* def.execute(
        {
          description: "review module",
          prompt: "review the module",
          subagent_type: "researcher",
          output_schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
        },
        execCtx({ sessionID: chat.id, messageID: assistant, callID: "tool_v2_structured" }),
      )

      expect(result.output).toContain(`"verdict":"solid"`)
      const { db } = yield* Database.Service
      const run = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.parent_session_id, chat.id)).get().pipe(Effect.orDie)
      expect(run?.state).toBe("completed")
      // The validated success path seals no failure evidence.
      const evidence = yield* db
        .select()
        .from(V2StructuredOutputEvidenceTable)
        .where(eq(V2StructuredOutputEvidenceTable.run_id, run!.run_id))
        .get()
        .pipe(Effect.orDie)
      expect(evidence).toBeUndefined()
    }),
  )

  // bug-V2.0-003: exhausting BOTH bounded finalizer attempts must settle DEGRADED (1.0 port) —
  // a receipt-stamped _degraded payload to the parent plus a durable validation_failed evidence
  // row — never a hard tool failure that strands the parent turn.
  it.instance("finalizer exhaustion degrades to a receipt-stamped payload with durable evidence", () =>
    Effect.gen(function* () {
      yield* ensureProject
      const { chat, assistant } = yield* seedParent()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      // Every turn (research + BOTH finalizer attempts) returns schema-INVALID JSON.
      payloadJson = '{"answer":"not-a-number"}'
      const result = yield* def.execute(
        {
          description: "probe module",
          prompt: "explain the module",
          subagent_type: "researcher",
          output_schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
        },
        execCtx({ sessionID: chat.id, messageID: assistant, callID: "tool_v2_degraded_invalid" }),
      )

      expect(result.output).toContain(`state="completed"`)
      const payload = JSON.parse(result.output.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/)?.[1] ?? "null")
      expect(payload).toMatchObject({ _degraded: true, _reason: "structured_output_invalid", _attempts: 2 })
      expect(typeof payload._raw).toBe("string")

      const { db } = yield* Database.Service
      const run = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.parent_session_id, chat.id)).get().pipe(Effect.orDie)
      expect(run?.state).toBe("completed")

      // Attempt budget unchanged: the durable first input plus exactly two finalizer follow-ups.
      const childInputs = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, SessionID.make(run!.child_session_id)))
        .all()
        .pipe(Effect.orDie)
      expect(childInputs).toHaveLength(3)

      const evidence = yield* db
        .select()
        .from(V2StructuredOutputEvidenceTable)
        .where(eq(V2StructuredOutputEvidenceTable.run_id, run!.run_id))
        .get()
        .pipe(Effect.orDie)
      expect(evidence?.validation_outcome).toBe("validation_failed")
      expect(evidence?.schema_name).toBe("inline")
      expect(evidence?.raw_output).toContain(`"_degraded":true`)
      expect(evidence?.owner_token).toBe(`core-v2-task-finalizer:${run!.run_id}`)
    }),
  )

  it.instance("finalizer turns without any JSON value degrade with structured_output_missing", () =>
    Effect.gen(function* () {
      yield* ensureProject
      const { chat, assistant } = yield* seedParent()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      // Prose-only turns: neither finalizer attempt yields an extractable JSON value.
      payloadJson = ""
      const result = yield* def.execute(
        {
          description: "probe module",
          prompt: "explain the module",
          subagent_type: "researcher",
          output_schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
        },
        execCtx({ sessionID: chat.id, messageID: assistant, callID: "tool_v2_degraded_missing" }),
      )

      expect(result.output).toContain(`state="completed"`)
      const payload = JSON.parse(result.output.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/)?.[1] ?? "null")
      expect(payload).toMatchObject({ _degraded: true, _reason: "structured_output_missing", _attempts: 2 })

      const { db } = yield* Database.Service
      const run = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.parent_session_id, chat.id)).get().pipe(Effect.orDie)
      const evidence = yield* db
        .select({ outcome: V2StructuredOutputEvidenceTable.validation_outcome })
        .from(V2StructuredOutputEvidenceTable)
        .where(eq(V2StructuredOutputEvidenceTable.run_id, run!.run_id))
        .get()
        .pipe(Effect.orDie)
      expect(evidence?.outcome).toBe("validation_failed")
    }),
  )

  it.instance("resume-by-task_id drives a follow-up turn on the same child", () =>
    Effect.gen(function* () {
      yield* ensureProject
      const { chat, assistant } = yield* seedParent()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      payloadJson = '{"answer":42}'
      const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] }
      const first = yield* def.execute(
        { description: "start", prompt: "begin", subagent_type: "researcher", output_schema: schema },
        execCtx({ sessionID: chat.id, messageID: assistant, callID: "tool_v2_resume_1" }),
      )
      const childID = (first.metadata as { sessionId: string }).sessionId

      const second = yield* def.execute(
        {
          description: "continue",
          prompt: "go deeper",
          subagent_type: "researcher",
          task_id: childID,
          output_schema: schema,
        },
        execCtx({ sessionID: chat.id, messageID: assistant, callID: "tool_v2_resume_2" }),
      )
      expect(second.output).toContain(`{"answer":42}`)

      // Resume drives the SAME child — no second durable run.
      const { db } = yield* Database.Service
      const runs = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.parent_session_id, chat.id)).all().pipe(Effect.orDie)
      expect(runs).toHaveLength(1)
      const childInputs = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, SessionID.make(childID)))
        .all()
        .pipe(Effect.orDie)
      // launch: durable first input + finalizer; resume: follow-up + finalizer.
      expect(childInputs).toHaveLength(4)
      expect(
        childInputs.filter((row) => String(row.id) === String(runs[0]!.child_message_id)),
      ).toHaveLength(1)
    }),
  )

  it.instance(
    "background launch: dispatcher drains the run and the outbox delivers one queue input to the parent",
    () =>
      Effect.gen(function* () {
        yield* ensureProject
        const { chat, assistant } = yield* seedParent()
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          { description: "background probe", prompt: "work in background", subagent_type: "researcher", background: true },
          execCtx({ sessionID: chat.id, messageID: assistant, callID: "tool_v2_background" }),
        )
        expect(result.output).toContain("durable control plane")
        const childID = (result.metadata as { sessionId: string }).sessionId

        // The dispatcher claims + drains the background run to a fenced terminal settle.
        const { db } = yield* Database.Service
        const settled = yield* pollUntil(
          db
            .select()
            .from(TaskRunTable)
            .where(eq(TaskRunTable.child_session_id, SessionID.make(childID)))
            .get()
            .pipe(Effect.orDie),
          (run) => run?.state === "completed",
        )
        expect(settled!.execution_runtime).toBe("v2")
        expect(settled!.delivery_mode).toBe("background")
        expect(settled!.output).toContain("research result body")

        // The outbox delivered exactly ONE queue-mode parent input with the deterministic id.
        const delivered = yield* pollUntil(
          db
            .select()
            .from(SessionInputTable)
            .where(and(eq(SessionInputTable.session_id, chat.id)))
            .all()
            .pipe(Effect.orDie),
          (rows) => rows.some((row) => row.delivery === "queue"),
        )
        expect(delivered.filter((row) => row.delivery === "queue")).toHaveLength(1)
      }),
  )
})
