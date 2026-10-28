import { projectLayer } from "./fixture/project-layer"
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@deepagent-code/llm"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import { count, eq } from "drizzle-orm"
import { Cause, Context, Deferred, Effect, Exit, Layer, LayerMap, Option, Schema, Stream } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { AgentV2 } from "@deepagent-code/core/agent"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { Catalog } from "@deepagent-code/core/catalog"
import { Config } from "@deepagent-code/core/config"
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
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { TaskContinuation } from "@deepagent-code/core/session/task-continuation"
import { SessionActivityTable } from "@deepagent-code/core/context-federation/session-sql"
import { Hash } from "@deepagent-code/core/util/hash"
import { Tool } from "@deepagent-code/core/tool/tool"
import { V2ToolEffectAdmissionTable } from "@deepagent-code/core/session/runner/v2-tool-effect.sql"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import * as SessionRunnerLLM from "@deepagent-code/core/session/runner/llm"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2ToolEffect } from "@deepagent-code/core/session/runner/v2-tool-effect"
import { V2TaskRunReceiptTable } from "@deepagent-code/core/session/runner/v2-task-run-receipt.sql"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { V2ToolEffectTable } from "@deepagent-code/core/session/runner/v2-tool-effect.sql"
import { SessionProviderAttemptTable } from "@deepagent-code/core/context-federation/session-sql"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import {
  SessionInputTable,
  SessionTable,
  TaskNotificationOutboxTable,
  TaskRunEventTable,
  TaskRunTable,
} from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { TaskOutbox } from "@deepagent-code/core/session/task-outbox"
import { TaskRunAuthority } from "@deepagent-code/core/session/task-run"
import { TaskRunDispatcher } from "@deepagent-code/core/session/task-run-dispatcher"
import { TaskTool } from "@deepagent-code/core/tool/task"
import { SkillGuidance } from "@deepagent-code/core/skill/guidance"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SystemContext } from "@deepagent-code/core/system-context"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { ToolOutputStore } from "@deepagent-code/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

// Core-native BACKGROUND task dispatcher + outbox delivery: the dispatcher claims durable v2
// background runs through the TaskRunAuthority (real SessionExecution resume-join + fenced
// settle), and the outbox loop admits exactly one queue-mode session_input into the parent with
// the deterministic notification id. Crash simulation manipulates leases in-place; the reopen
// path runs in a spawned fixture process (task-dispatcher-recovery-process.ts).

type DatabaseService = Database.Interface["db"]

const directory = AbsolutePath.make("/project")

// ── Fake LLM transport (mirrors session-runner.test.ts) ────────────────────────────────────────

let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
let streamRequests = 0
let sealRequests = false
let holdWakes = false
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((_request: LLMRequest) => {
      streamRequests++
      const events = Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
      if (sealRequests) return Stream.unwrap(Effect.gen(function* () {
        const seal = yield* V2ProviderTurn.CurrentRequestSeal
        if (!seal) return yield* Effect.die("Missing actual canonical provider seal")
        yield* seal.seal({ wireHash: Hash.sha256("task-continuation-controlled-wire"),
          bodyHash: Hash.sha256("task-continuation-controlled-body"), bodyLength: 33,
          contentType: "application/json" })
        return events
      }))
      if (streamGate === undefined) return events
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

const textResponse = (text: string, id = "txt_task") => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

// ── Runner composition (trimmed from session-runner.test.ts; one fake text turn per drain) ─────

const database = Database.layerFromPath(process.env.DAC_TASK_UNKNOWN_DB ?? ":memory:")
const selectionSourcesLayer = Layer.succeed(ProductionV2Sources, {})
const providerTurns = V2ProviderTurn.layer.pipe(
  Layer.provide(SessionProviderOwner.layer.pipe(Layer.provide(database))),
  Layer.provide(database),
)
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
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
const registry = ToolRegistry.layer.pipe(
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
const location = Location.layer({ directory }).pipe(Layer.provide(projectLayer(database)))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: () => Effect.succeed(SystemContext.empty),
})
const config = Layer.succeed(
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
      // A missing pricing entry is the reference harness default too: the runner treats the typed
      // ModelNotFoundError as a non-fatal lookup miss (cost accounting only).
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
  Layer.provide(registry),
  Layer.provide(models),
  Layer.provide(systemContext),
  Layer.provide(location),
  Layer.provide(agents),
  Layer.provide(skillGuidance),
  Layer.provide(config),
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
const localExecution = SessionExecutionLocal.layer.pipe(
  Layer.provide(events),
  Layer.provide(store),
  Layer.provide(TaskTool.delegationSlotLayer),
  Layer.provide(locations),
)
const execution = Layer.effect(SessionExecution.Service, Effect.gen(function* () {
  const service = yield* SessionExecution.Service
  return SessionExecution.Service.of({ ...service,
    wake: (sessionID, seq) => holdWakes ? Effect.void : service.wake(sessionID, seq),
  })
})).pipe(Layer.provide(localExecution))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projectLayer(database)),
  Layer.provide(execution),
)
const it = testEffect(
  Layer.mergeAll(
    database,
    providerTurns,
    events,
    projector,
    store,
    client,
    permission,
    applications,
    agents,
    registry,
    models,
    systemContext,
    location,
    skillGuidance,
    config,
    catalog,
    runner,
    locations,
    execution,
    sessions,
    TaskTool.delegationSlotLayer,
    Layer.mergeAll(TaskRunDispatcher.layer({ maxConcurrent: 2 }), TaskOutbox.layer()).pipe(
      Layer.provide(database),
      Layer.provide(sessions),
      Layer.provide(events),
      Layer.provide(execution),
    ),
  ),
)

// Minimal stack for the attempts-exhaustion path: delivery needs only Database + a prompt seam,
// so a stub Session whose admission keeps raising a transient defect isolates the retry policy
// from the real runner composition.
const die = () => Effect.die("unused")
const stubSessions = Layer.succeed(
  SessionV2.Service,
  SessionV2.Service.of({
    list: die,
    create: die,
    get: die,
    requireWritable: die,
    update: die,
    messages: die,
    message: die,
    context: die,
    events: () => Stream.empty,
    switchAgent: die,
    switchModel: die,
    setPermissions: die,
    setArchived: die,
    // A transient admission defect (not the fatal conflict/not-found classes): retries back off.
    prompt: () => Effect.die(new Error("parent admission transiently failing")),
    shell: die,
    skill: die,
    compact: die,
    wait: die,
    resume: die,
    interrupt: die,
  }),
)
const stubOutbox = TaskOutbox.layer({ maxAttempts: 2, backoffBaseMs: 60_000, backoffMaxMs: 60_000 }).pipe(
  Layer.provide(database),
  Layer.provide(stubSessions),
)
const stubIt = testEffect(Layer.mergeAll(database, stubSessions, stubOutbox))
const runtimeIt = testEffect(
  TaskRunDispatcher.runtimeLayer({ scanIntervalMs: 20 }).pipe(Layer.provide(database), Layer.provide(stubSessions)),
)

const stubParentID = SessionSchema.ID.make("ses_stub_parent")

const insertStubFixture = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/tmp"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: stubParentID,
      project_id: Project.ID.global,
      slug: stubParentID,
      directory: "/tmp",
      title: "stub",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(TaskRunTable)
    .values({
      run_id: "job_v2_stub",
      request_hash: "stub",
      execution_runtime: "v2",
      parent_session_id: stubParentID,
      parent_message_id: SessionV1.MessageID.make("msg_stub_parent"),
      tool_call_id: "call-stub",
      child_session_id: SessionSchema.ID.make("ses_stub_child"),
      generation: 1,
      delivery_mode: "background",
      phase: "settled",
      state: "completed",
      control_state: "closed",
      input_state: "ready",
      output: "stub output",
      time_created: 1,
      time_updated: 1,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(TaskNotificationOutboxTable)
    .values({
      id: "job_stub_outbox",
      run_id: "job_v2_stub",
      message_id: SessionV1.MessageID.make("msg_tasknotify_stub"),
      parent_session_id: stubParentID,
      directory: AbsolutePath.make("/tmp"),
      payload: { agent: "general", text: "stub output" },
      status: "pending",
      attempts: 0,
      available_at: 0,
      time_created: 1,
      time_updated: 1,
      event_kind: "terminal",
    })
    .run()
    .pipe(Effect.orDie)
})

const stubOutboxRow = (db: DatabaseService) =>
  db
    .select()
    .from(TaskNotificationOutboxTable)
    .where(eq(TaskNotificationOutboxTable.id, "job_stub_outbox"))
    .get()
    .pipe(Effect.orDie)

// ── Fixtures and helpers ───────────────────────────────────────────────────────────────────────

const setup = Effect.gen(function* () {
  AgentGateway.configure({ enabled: false, agentMode: "high" })
  response = []
  responses = undefined
  streamGate = undefined
  streamStarted = undefined
  streamRequests = 0
  sealRequests = false
  holdWakes = false
  // The task child session is created with the spec's agent id; admission resolves it against the
  // Location roster, so register it as a selectable primary in the shared AgentV2 registry.
  const agentService = yield* AgentV2.Service
  yield* agentService.update((editor) => {
    editor.update(AgentV2.ID.make("general"), (agent) => {
      agent.mode = "primary"
    })
  })
})

const specFor = (parentSessionID: SessionSchema.ID, toolCallID: string) => ({
  parentSessionID,
  parentMessageID: SessionMessage.ID.make(`msg_parent_${toolCallID}`),
  toolCallID,
  deliveryMode: "background" as const,
  prompt: new Prompt({ text: "Research and report the answer." }),
  agent: "general",
  child: {
    title: "task: dispatcher test",
    location: { directory },
    permissions: [{ action: "edit", resource: "*", effect: "deny" as const }],
  },
})

const submitBackground = (parentSessionID: SessionSchema.ID, toolCallID: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const sessions = yield* SessionV2.Service
    return yield* TaskRunAuthority.submit(db, events, sessions, specFor(parentSessionID, toolCallID))
  })

const outboxRowFor = (db: DatabaseService, runID: string) =>
  db
    .select()
    .from(TaskNotificationOutboxTable)
    .where(eq(TaskNotificationOutboxTable.run_id, runID))
    .get()
    .pipe(Effect.orDie)

const parentInputs = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).all().pipe(Effect.orDie)

const receiptCount = (db: DatabaseService) =>
  db.select({ total: count() }).from(V2TaskRunReceiptTable).get().pipe(Effect.orDie)

// Settle a background run directly through the authority so only its outbox row is under test.
const settleCompleted = (db: DatabaseService, runID: string) =>
  Effect.gen(function* () {
    const claimed = yield* TaskRunAuthority.claim(db, { runID, ownerToken: "owner-settle", leaseMs: 60_000 })
    yield* TaskRunAuthority.settle(db, {
      runID,
      ownerToken: "owner-settle",
      claimGeneration: claimed.claimGeneration,
      state: "completed",
      reason: "done",
      output: "settled output text",
    })
  })

// ── Tests ──────────────────────────────────────────────────────────────────────────────────────

describe("TaskRunDispatcher + TaskOutbox (Core V2 background runtime)", () => {
  it.live("a timed-out real mutation retains unknown custody without a terminal receipt, outbox or replay", () =>
    Effect.gen(function* () {
      const started = performance.now()
      const trace = (phase: string) => {
        if (process.env.DAC_TASK_UNKNOWN_ACTUAL !== "1") return
        console.error(JSON.stringify({ test: "task-unknown-custody", phase,
          elapsedMs: Math.round(performance.now() - started) }))
      }
      trace("case-enter")
      yield* Effect.addFinalizer(() => Effect.sync(() => trace("case-resources-finalized")))
      if (process.env.DAC_TASK_UNKNOWN_ACTUAL !== "1") {
        const root = yield* Effect.promise(tmpdir)
        yield* Effect.addFinalizer(() => Effect.promise(() => root[Symbol.asyncDispose]()))
        const child = Bun.spawn({ cmd: [process.execPath, path.join(import.meta.dirname, "fixture/task-run-unknown-effect.ts"), root.path],
          stdout: "pipe", stderr: "pipe" })
        const [status, stdout, stderr] = yield* Effect.promise(() => Promise.all([child.exited,
          new Response(child.stdout).text(), new Response(child.stderr).text()]))
        expect({ status, failure: status === 0 ? "" : stdout + stderr }).toEqual({ status: 0, failure: "" })
        expect(stdout).toContain("UNKNOWN_CUSTODY_ACTUAL_OK")
        return
      }
      yield* setup
      trace("setup-ready")
      sealRequests = true
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const scratch = yield* Effect.promise(tmpdir)
      yield* Effect.addFinalizer(() => Effect.promise(() => scratch[Symbol.asyncDispose]()))
      const filename = path.join(scratch.path, "original-effect.txt")
      yield* (yield* ApplicationTools.Service).register({ mutate_once: Tool.make({
        description: "Make one private fixture mutation then wait for owned interruption",
        input: Schema.Struct({}), output: Schema.String,
        execute: () => Effect.promise(() => Bun.write(filename, "original effect\n")).pipe(Effect.andThen(Effect.never)),
      }) })
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* submitBackground(parent.id, "call-unknown-mutating-effect")
      trace("background-admitted")
      response = [LLMEvent.stepStart({ index: 0 }), LLMEvent.toolCall({ id: "call-mutate-once", name: "mutate_once", input: {} }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" })]
      const result = yield* TaskRunAuthority.execute({ db, run: submitted.run, sessions, timeoutMs: 150 })
      trace("execution-returned")
      expect(result.outcome).toBe("recovery_required")
      expect(yield* Effect.promise(() => Bun.file(filename).text())).toBe("original effect\n")
      const run = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.run_id, submitted.run.runID)).get()
      expect(run?.state).toBe("recovery_required")
      expect(run?.time_settled).toBeNull()
      expect(run?.workspace_preflight_state).toBe("ready")
      expect(run?.execution_owner).toBeNull()
      expect((yield* receiptCount(db))?.total).toBe(0)
      expect(yield* outboxRowFor(db, submitted.run.runID)).toBeUndefined()
      expect((yield* db.select({ total: count() }).from(V2ToolEffectAdmissionTable).where(eq(V2ToolEffectAdmissionTable.session_id, submitted.run.childSessionID)).get())?.total).toBe(1)
      expect((yield* db.select({ total: count() }).from(V2ToolEffectTable).where(eq(V2ToolEffectTable.session_id, submitted.run.childSessionID)).get())?.total).toBe(0)
      expect(streamRequests).toBe(1)
      expect(yield* (yield* TaskRunDispatcher.Service).tick).toBe(0)
      expect(streamRequests).toBe(1)
      const retry = yield* submitBackground(parent.id, "call-unknown-mutating-effect")
      expect(retry.exactRetry).toBe(true)
      expect(retry.run.state).toBe("recovery_required")
      expect(streamRequests).toBe(1)
      expect(yield* Effect.promise(() => Bun.file(filename).text())).toBe("original effect\n")
      const custody = yield* TaskRunAuthority.resolveRecovery(db, { runID: submitted.run.runID,
        resolution: "closed", reason: "Do not discard a real unsettled mutation" }).pipe(Effect.exit)
      expect(Exit.isFailure(custody)).toBe(true)
      if (Exit.isFailure(custody)) expect(Cause.squash(custody.cause)).toBeInstanceOf(TaskRunAuthority.RecoveryCustodyRequired)
      expect(yield* TaskRunAuthority.get(db, submitted.run.runID)).toEqual(retry.run)
      const stranger = yield* sessions.create({ location: { directory } })
      const foreign = yield* TaskRunAuthority.closeTask(db, { childSessionID: submitted.run.childSessionID,
        parentSessionID: stranger.id, reason: "Foreign parent must not close this child" }).pipe(Effect.exit)
      expect(Exit.isFailure(foreign)).toBe(true)
      expect(yield* TaskRunAuthority.get(db, submitted.run.runID)).toEqual(retry.run)
      const requested = yield* TaskRunAuthority.closeTask(db, { childSessionID: submitted.run.childSessionID,
        parentSessionID: parent.id, reason: "Record close intent while retaining unknown custody" })
      expect(requested.closed).toBe(true)
      const retained = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.run_id, submitted.run.runID)).get()
      expect(retained?.state).toBe("recovery_required")
      expect(retained?.control_state).toBe("close_requested")
      expect(retained?.time_settled).toBeNull()
      expect(retained?.workspace_preflight_state).toBe("ready")
      expect((yield* receiptCount(db))?.total).toBe(0)
      expect(yield* outboxRowFor(db, submitted.run.runID)).toBeUndefined()
      expect(yield* (yield* TaskRunDispatcher.Service).tick).toBe(0)
      expect(streamRequests).toBe(1)
      expect(yield* Effect.promise(() => Bun.file(filename).text())).toBe("original effect\n")
      trace("assertions-complete")
    }),
  )
  it.effect("a canonical background wait returns after its launch activity settles, exactly once", () =>
    Effect.gen(function* () {
      yield* setup
      sealRequests = true
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) => editor.update(AgentV2.ID.make("explore"), (agent) => {
        agent.mode = "subagent"
        agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
      }))
      yield* Layer.build(TaskTool.layer)
      ;(yield* TaskTool.DelegationSlot).service = sessions
      const parent = yield* sessions.create({ location: { directory } })
      const call = { description: "Original task", prompt: "Research and report the answer.", subagent_type: "explore", background: true }
      responses = [
        [LLMEvent.stepStart({ index: 0 }), LLMEvent.toolCall({ id: "call-canonical-background", name: "task", input: call }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" })],
        textResponse("The registered task is working."), textResponse("The actual child answer: 42"),
        textResponse("The registered return was consumed."),
      ]
      yield* sessions.prompt({ sessionID: parent.id, prompt: new Prompt({ text: "Delegate and report when it returns." }), resume: false })
      yield* sessions.resume(parent.id)
      const run = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.parent_session_id, parent.id)).get()
      if (!run) return yield* Effect.die(JSON.stringify(yield* sessions.messages({ sessionID: parent.id, order: "asc" })))
      const registered = TaskContinuation.decode(run?.execution_spec?.continuation)
      expect(registered).toBeDefined()
      const launching = yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.activity_id, registered!.activityID)).get()
      expect(launching?.state).toBe("settled")
      expect(streamRequests).toBe(2)
      const dispatcher = yield* TaskRunDispatcher.Service
      expect(yield* dispatcher.tick).toBe(1)
      yield* dispatcher.awaitIdle
      expect((yield* TaskRunAuthority.get(db, run!.run_id))?.state).toBe("completed")
      expect(streamRequests).toBe(3)
      const outbox = yield* TaskOutbox.Service
      expect(yield* outbox.tick).toBe(1)
      yield* sessions.wait(parent.id)
      const delivered = yield* outboxRowFor(db, run!.run_id)
      expect(delivered?.status).toBe("delivered")
      expect(streamRequests).toBe(4)
      expect((yield* parentInputs(db, parent.id)).filter((input) => String(input.id) === delivered?.message_id)).toHaveLength(1)
      expect(yield* outbox.tick).toBe(0)
      expect(streamRequests).toBe(4)
      expect(TaskContinuation.decode((yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.run_id, run!.run_id)).get())?.execution_spec?.continuation)).toEqual(registered)
    }),
  )

  it.effect("a committed late return spends no provider turn and leaves the following user FIFO runnable", () =>
    Effect.gen(function* () {
      yield* setup
      sealRequests = true
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) => editor.update(AgentV2.ID.make("explore"), (agent) => {
        agent.mode = "subagent"
        agent.permissions = [{ action: "*", resource: "*", effect: "deny" }]
      }))
      yield* Layer.build(TaskTool.layer)
      ;(yield* TaskTool.DelegationSlot).service = sessions
      const parent = yield* sessions.create({ location: { directory } })
      responses = [
        [LLMEvent.stepStart({ index: 0 }), LLMEvent.toolCall({ id: "call-late-background", name: "task", input: {
          description: "Late task", prompt: "Research and report the answer.", subagent_type: "explore", background: true,
        } }), LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }), LLMEvent.finish({ reason: "tool-calls" })],
        textResponse("Waiting for the original registered task."), textResponse("Late child answer"),
        textResponse("Independent user work finished."), textResponse("Next user queue finished."),
      ]
      yield* sessions.prompt({ sessionID: parent.id, prompt: new Prompt({ text: "Launch an asynchronous task." }), resume: false })
      yield* sessions.resume(parent.id)
      const run = yield* db.select().from(TaskRunTable).where(eq(TaskRunTable.parent_session_id, parent.id)).get()
      if (!run) return yield* Effect.die(JSON.stringify(yield* sessions.messages({ sessionID: parent.id, order: "asc" })))
      expect(TaskContinuation.decode(run.execution_spec?.continuation)).toBeDefined()
      const dispatcher = yield* TaskRunDispatcher.Service
      expect(yield* dispatcher.tick).toBe(1)
      yield* dispatcher.awaitIdle
      holdWakes = true
      expect(yield* (yield* TaskOutbox.Service).tick).toBe(1)
      const result = yield* outboxRowFor(db, run!.run_id)
      expect(result?.status).toBe("delivered")
      expect(streamRequests).toBe(3)
      yield* sessions.prompt({ sessionID: parent.id, prompt: new Prompt({ text: "Change direction and do my independent work." }), resume: false })
      holdWakes = false
      yield* sessions.resume(parent.id)
      expect(streamRequests).toBe(4)
      const expired = yield* outboxRowFor(db, run!.run_id)
      expect(expired?.status).toBe("dead")
      expect(expired?.last_error).toContain("changed")
      const resultActivity = yield* db.select().from(SessionActivityTable).where(eq(SessionActivityTable.trigger_input_id, result!.message_id)).get()
      expect(resultActivity?.state).toBe("failed")
      expect((yield* TaskRunAuthority.get(db, run!.run_id))?.output).toBe("Late child answer")
      yield* sessions.prompt({ sessionID: parent.id, prompt: new Prompt({ text: "Another independent queued task." }), delivery: "queue", resume: false })
      yield* sessions.resume(parent.id)
      expect(streamRequests).toBe(5)
      expect((yield* parentInputs(db, parent.id)).every((input) => input.promoted_seq !== null)).toBe(true)
    }),
  )
  it.effect(
    "a real unresolved child execution claim stays recovery_required without terminal settlement or replay",
    () =>
      Effect.gen(function* () {
        yield* setup
        const db = (yield* Database.Service).db
        const sessions = yield* SessionV2.Service
        const store = yield* SessionStore.Service
        const dispatcher = yield* TaskRunDispatcher.Service
        const parent = yield* sessions.create({ location: { directory } })
        const submitted = yield* submitBackground(parent.id, "call-unconfirmed-child")
        const inputBefore = yield* parentInputs(db, submitted.run.childSessionID)
        const claim = yield* store.claim(submitted.run.childSessionID)
        expect(claim).toBeDefined()
        yield* TaskRunAuthority.claim(db, {
          runID: submitted.run.runID,
          ownerToken: "expired-task-owner",
          leaseMs: 1000,
          now: Date.now() - 120000,
        })
        expect(yield* dispatcher.tick).toBe(1)
        yield* dispatcher.awaitIdle
        const current = yield* TaskRunAuthority.get(db, submitted.run.runID)
        expect(current?.state).toBe("recovery_required")
        expect(current?.executionOwner).toBeUndefined()
        expect(yield* store.claimToken(submitted.run.childSessionID)).toBe(claim)
        expect(yield* parentInputs(db, submitted.run.childSessionID)).toEqual(inputBefore)
        expect((yield* receiptCount(db))?.total).toBe(0)
        expect(yield* outboxRowFor(db, submitted.run.runID)).toBeUndefined()
        expect(streamRequests).toBe(0)
        expect(
          (yield* db.select({ total: count() }).from(V2ProviderTurnReceiptTable).get().pipe(Effect.orDie))?.total,
        ).toBe(0)
        expect(
          (yield* db.select({ total: count() }).from(SessionProviderAttemptTable).get().pipe(Effect.orDie))?.total,
        ).toBe(0)
        expect((yield* db.select({ total: count() }).from(V2ToolEffectTable).get().pipe(Effect.orDie))?.total).toBe(0)
        expect(yield* dispatcher.tick).toBe(0)
        yield* (yield* AgentV2.Service).update((editor) => {
          editor.update(AgentV2.ID.make("general"), (agent) => {
            agent.mode = "subagent"
          })
        })
        yield* Layer.build(TaskTool.captureDelegationServiceLayer)
        yield* Layer.build(TaskTool.layer)
        const tools = yield* (yield* ToolRegistry.Service).materialize()
        const retry = yield* tools.settle({
          sessionID: parent.id,
          agent: AgentV2.ID.make("general"),
          assistantMessageID: SessionMessage.ID.make("msg_parent_recovery_retry"),
          call: {
            type: "tool-call",
            name: "task",
            id: "call-recovery-retry",
            input: {
              description: "Resume unconfirmed child",
              prompt: "Do not replay unknown work.",
              subagent_type: "general",
              task_id: submitted.run.childSessionID,
            },
          },
        })
        expect(retry.result.type).toBe("error")
        expect(String(retry.result.value)).toContain("the old run requires explicit recovery")
        expect(yield* parentInputs(db, submitted.run.childSessionID)).toEqual(inputBefore)
        expect((yield* receiptCount(db))?.total).toBe(0)
        expect(streamRequests).toBe(0)
        const denied = yield* TaskRunAuthority.resolveRecovery(db, {
          runID: submitted.run.runID,
          resolution: "closed",
          reason: "A live foreign claim cannot be treated as known execution",
        }).pipe(Effect.exit)
        expect(Exit.isFailure(denied)).toBe(true)
        if (Exit.isFailure(denied)) expect(Cause.squash(denied.cause)).toBeInstanceOf(TaskRunAuthority.RecoveryCustodyRequired)
        expect((yield* receiptCount(db))?.total).toBe(0)
        expect(yield* store.claimToken(submitted.run.childSessionID)).toBe(claim)
        expect(yield* store.release(submitted.run.childSessionID, claim!)).toBe(true)
        yield* TaskRunAuthority.resolveRecovery(db, {
          runID: submitted.run.runID,
          resolution: "closed",
          reason: "explicit user resolution",
        })
        expect((yield* TaskRunAuthority.get(db, submitted.run.runID))?.state).toBe("closed")
        const closedRetry = yield* tools.settle({
          sessionID: parent.id,
          agent: AgentV2.ID.make("general"),
          assistantMessageID: SessionMessage.ID.make("msg_parent_recovery_closed_retry"),
          call: {
            type: "tool-call",
            name: "task",
            id: "call-recovery-closed-retry",
            input: {
              description: "Resume disposed child",
              prompt: "Do not replay disposed work.",
              subagent_type: "general",
              task_id: submitted.run.childSessionID,
            },
          },
        })
        expect(closedRetry.result.type).toBe("error")
        expect(String(closedRetry.result.value)).toContain(
          "the old unresolved execution was explicitly disposed as closed",
        )
        expect(yield* parentInputs(db, submitted.run.childSessionID)).toEqual(inputBefore)
        expect(yield* store.claimToken(submitted.run.childSessionID)).toBeUndefined()
        expect(streamRequests).toBe(0)
        expect(yield* dispatcher.tick).toBe(0)
        const unstarted = yield* TaskRunAuthority.admitRun(db, specFor(parent.id, "call-before-child-creation"))
        expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, unstarted.run.childSessionID)).get()).toBeUndefined()
        yield* TaskRunAuthority.requestClose(db, { rootRunID: unstarted.run.runID, reason: "Known pre-dispatch close" })
        expect((yield* TaskRunAuthority.get(db, unstarted.run.runID))?.state).toBe("closed")
        expect((yield* db.select({ total: count() }).from(V2TaskRunReceiptTable).where(eq(V2TaskRunReceiptTable.run_id, unstarted.run.runID)).get())?.total).toBe(1)
        expect(streamRequests).toBe(0)
      }),
  )
  it.effect("UP-03 preserves two provider text blocks while an unregistered result remains read-only", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const dispatcher = yield* TaskRunDispatcher.Service
      const outbox = yield* TaskOutbox.Service
      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* submitBackground(parent.id, "call-up03-blocks")
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "up03_first" }),
        LLMEvent.textDelta({ id: "up03_first", text: "First finding" }),
        LLMEvent.textEnd({ id: "up03_first" }),
        LLMEvent.textStart({ id: "up03_second" }),
        LLMEvent.textDelta({ id: "up03_second", text: "Second finding" }),
        LLMEvent.textEnd({ id: "up03_second" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      expect(yield* dispatcher.tick).toBe(1)
      yield* dispatcher.awaitIdle
      const settled = yield* TaskRunAuthority.get(db, submitted.run.runID)
      expect(settled?.state).toBe("completed")
      expect(settled?.output).toBe("First finding\n\nSecond finding")
      expect((yield* outboxRowFor(db, submitted.run.runID))?.payload.text).toBe("First finding\n\nSecond finding")
      response = textResponse("acknowledged")
      expect(yield* outbox.tick).toBe(1)
      const inputs = yield* parentInputs(db, parent.id)
      expect(inputs).toHaveLength(0)
      expect((yield* outboxRowFor(db, submitted.run.runID))?.status).toBe("dead")
      expect((yield* TaskRunAuthority.get(db, submitted.run.runID))?.output).toBe("First finding\n\nSecond finding")
      expect(yield* outbox.tick).toBe(0)
      expect(yield* parentInputs(db, parent.id)).toHaveLength(0)
    }),
  )

  it.effect("an unregistered background run executes once and retains its result without parent inference", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const dispatcher = yield* TaskRunDispatcher.Service
      const outbox = yield* TaskOutbox.Service

      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* submitBackground(parent.id, "call-e2e-1")

      response = textResponse("The child answer: 42")
      expect(yield* dispatcher.tick).toBe(1)
      yield* dispatcher.awaitIdle

      const settled = yield* TaskRunAuthority.get(db, submitted.run.runID)
      expect(settled?.state).toBe("completed")
      expect(settled?.output).toBe("The child answer: 42")
      expect(settled?.executionOwner).toBeUndefined()
      expect((yield* receiptCount(db))?.total).toBe(1)

      // Programmatic submission has no canonical parent wait. Execution remains real and its
      // result remains readable; the outbox does not turn the result text into a fresh grant.
      response = textResponse("parent acknowledged")
      expect(yield* outbox.tick).toBe(1)

      const row = yield* outboxRowFor(db, submitted.run.runID)
      expect(row?.status).toBe("dead")
      expect(row?.last_error).toContain("unregistered")
      expect(row?.parent_input_message_id).toBeNull()

      const inputs = yield* parentInputs(db, parent.id)
      expect(inputs).toHaveLength(0)
      expect(row?.payload.text).toBe("The child answer: 42")
      expect(streamRequests).toBe(1)
      // A repeated pass neither re-executes the child nor admits any parent inference.
      expect(yield* outbox.tick).toBe(0)
      expect(yield* parentInputs(db, parent.id)).toHaveLength(0)
    }),
  )

  it.effect("reclaiming a crashed unregistered delivery preserves its result without a parent input", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const outbox = yield* TaskOutbox.Service

      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* submitBackground(parent.id, "call-crash-delivery")
      yield* settleCompleted(db, submitted.run.runID)

      // "Process 1" claims the row and dies before delivery: attempts=1, lease held.
      const crashed = yield* TaskOutbox.claim(db, { ownerToken: "owner-crashed", leaseMs: 60_000 })
      expect(crashed?.attempts).toBe(1)
      expect(crashed?.runID).toBe(submitted.run.runID)

      // Simulate the passage of time past the dead owner's lease, then re-deliver.
      yield* db
        .update(TaskNotificationOutboxTable)
        .set({ lease_expires_at: Date.now() - 1 })
        .where(eq(TaskNotificationOutboxTable.id, crashed!.id))
        .run()
        .pipe(Effect.orDie)

      expect(yield* outbox.tick).toBe(1)
      const row = yield* outboxRowFor(db, submitted.run.runID)
      expect(row?.status).toBe("dead")
      expect(row?.attempts).toBe(2)

      // A process boundary cannot mint the parent wait that was absent at original launch.
      const inputs = yield* parentInputs(db, parent.id)
      expect(inputs).toHaveLength(0)
      expect(row?.payload.text).toBe("settled output text")
    }),
  )

  it.effect("expired-lease running run is re-claimed exactly once and settled once", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const dispatcher = yield* TaskRunDispatcher.Service

      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* submitBackground(parent.id, "call-lease-expiry")

      // A crashed owner left the run 'running' with a lease long expired.
      const first = yield* TaskRunAuthority.claim(db, {
        runID: submitted.run.runID,
        ownerToken: "owner-crashed",
        leaseMs: 1_000,
        now: Date.now() - 120_000,
      })
      expect(first.claimGeneration).toBe(1)

      response = textResponse("Recovered answer")
      expect(yield* dispatcher.tick).toBe(1)
      yield* dispatcher.awaitIdle

      const recovered = yield* TaskRunAuthority.get(db, submitted.run.runID)
      expect(recovered?.claimGeneration).toBe(2)
      expect(recovered?.state).toBe("completed")
      expect(recovered?.output).toBe("Recovered answer")
      // Settled exactly once: one receipt and one run_settled ledger event despite two claims.
      expect((yield* receiptCount(db))?.total).toBe(1)
      expect(
        yield* db
          .select({ type: TaskRunEventTable.type })
          .from(TaskRunEventTable)
          .where(eq(TaskRunEventTable.run_id, submitted.run.runID))
          .orderBy(TaskRunEventTable.version)
          .all()
          .pipe(Effect.orDie),
      ).toEqual([
        { type: "run_admitted" },
        { type: "input_ready" },
        { type: "execution_started" },
        { type: "execution_started" },
        { type: "run_settled" },
      ])
    }),
  )

  it.live("bounded concurrency: a pool of 2 never exceeds 2 concurrent drains across queued runs", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const dispatcher = yield* TaskRunDispatcher.Service

      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* Effect.all(
        ["call-pool-a", "call-pool-b", "call-pool-c"].map((toolCallID) => submitBackground(parent.id, toolCallID)),
      )
      expect(submitted).toHaveLength(3)

      // Gate every provider stream so drains hold their concurrency slots open.
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()
      responses = [textResponse("a"), textResponse("b"), textResponse("c")]

      expect(yield* dispatcher.tick).toBe(2)
      expect((yield* dispatcher.active).size).toBe(2)
      // The pool is exhausted: a further tick claims nothing while both drains are in flight.
      expect(yield* dispatcher.tick).toBe(0)
      expect((yield* dispatcher.active).size).toBe(2)

      yield* Deferred.succeed(streamGate, undefined)
      yield* dispatcher.awaitIdle
      // The third run is claimable only after a slot frees.
      expect(yield* dispatcher.tick).toBe(1)
      yield* dispatcher.awaitIdle

      const states = yield* db
        .select({ state: TaskRunTable.state })
        .from(TaskRunTable)
        .where(eq(TaskRunTable.parent_session_id, parent.id))
        .all()
        .pipe(Effect.orDie)
      expect(states).toHaveLength(3)
      expect(states.every((row) => row.state === "completed")).toBeTrue()
      expect((yield* receiptCount(db))?.total).toBe(3)
      expect((yield* dispatcher.active).size).toBe(0)
    }),
  )

  it.effect("fatal deterministic-id conflict dead-letters immediately and is never re-claimed", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const outbox = yield* TaskOutbox.Service

      const parent = yield* sessions.create({ location: { directory } })
      const submitted = yield* submitBackground(parent.id, "call-dead-conflict")
      yield* settleCompleted(db, submitted.run.runID)
      const pending = yield* outboxRowFor(db, submitted.run.runID)
      expect(pending?.status).toBe("pending")

      // Pre-existing input under the deterministic id with DIFFERENT content: the exactly-once
      // guard refuses the re-admission as a permanent conflict.
      yield* db
        .insert(SessionInputTable)
        .values({
          id: SessionMessage.ID.make(pending!.message_id),
          session_id: parent.id,
          admitted_seq: 1,
          prompt: new Prompt({ text: "conflicting content" }),
          delivery: "queue",
          time_created: Date.now(),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      expect(yield* outbox.tick).toBe(1)
      const dead = yield* outboxRowFor(db, submitted.run.runID)
      expect(dead?.status).toBe("dead")
      expect(dead?.last_error).toBeString()
      // Dead rows are never re-claimed, and the row stays visible with its evidence.
      expect(yield* outbox.tick).toBe(0)
      expect((yield* outboxRowFor(db, submitted.run.runID))?.status).toBe("dead")
      // The conflicting pre-existing input is still the only parent input: nothing was overwritten.
      const inputs = yield* parentInputs(db, parent.id)
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.id).toBe(SessionMessage.ID.make(dead!.message_id))
    }),
  )

  it.effect("v1 rows and foreground v2 runs are invisible to both loops", () =>
    Effect.gen(function* () {
      yield* setup
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const dispatcher = yield* TaskRunDispatcher.Service
      const outbox = yield* TaskOutbox.Service

      // Historical V1 run + queued V1 notification: the legacy app layer owns them.
      const v1Parent = yield* sessions.create({ location: { directory } })
      yield* db
        .insert(TaskRunTable)
        .values({
          run_id: "job_v1_history",
          request_hash: "legacy",
          execution_runtime: "v1",
          parent_session_id: v1Parent.id,
          parent_message_id: SessionV1.MessageID.make("msg_v1_history"),
          tool_call_id: "call-v1",
          child_session_id: SessionSchema.ID.make("ses_v1_history"),
          generation: 1,
          delivery_mode: "background",
          phase: "admission",
          state: "admitted",
          input_state: "ready",
          control_state: "open",
          available_at: 0,
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(TaskNotificationOutboxTable)
        .values({
          id: "job_v1_outbox",
          run_id: "job_v1_history",
          message_id: SessionV1.MessageID.make("msg_tasknotify_v1"),
          parent_session_id: v1Parent.id,
          directory: AbsolutePath.make("/tmp"),
          payload: { agent: "general", text: "v1 result" },
          status: "pending",
          attempts: 0,
          available_at: 0,
          time_created: 1,
          time_updated: 1,
          event_kind: "terminal",
        })
        .run()
        .pipe(Effect.orDie)

      // A foreground V2 run stays with the parent turn's inline executor.
      const parent = yield* sessions.create({ location: { directory } })
      yield* TaskRunAuthority.submit(db, events, sessions, {
        ...specFor(parent.id, "call-fg"),
        deliveryMode: "foreground",
      })

      expect(yield* dispatcher.tick).toBe(0)
      expect(yield* outbox.tick).toBe(0)
      expect((yield* TaskRunAuthority.get(db, "job_v1_history"))?.state).toBe("admitted")
      expect(
        (yield* db
          .select({ status: TaskNotificationOutboxTable.status })
          .from(TaskNotificationOutboxTable)
          .where(eq(TaskNotificationOutboxTable.id, "job_v1_outbox"))
          .get()
          .pipe(Effect.orDie))?.status,
      ).toBe("pending")
      expect(
        (yield* db
          .select({ state: TaskRunTable.state })
          .from(TaskRunTable)
          .where(eq(TaskRunTable.parent_session_id, parent.id))
          .get()
          .pipe(Effect.orDie))?.state,
      ).toBe("admitted")
    }),
  )

  stubIt.effect("a missing continuation runtime refuses before an arbitrary Session prompt seam", () =>
    Effect.gen(function* () {
      yield* insertStubFixture
      const db = (yield* Database.Service).db
      const outbox = yield* TaskOutbox.Service

      // An arbitrary prompt seam is not a substitute for the canonical Event/Input/runtime.
      expect(yield* outbox.tick).toBe(1)
      const released = yield* stubOutboxRow(db)
      expect(released?.status).toBe("dead")
      expect(released?.attempts).toBe(1)
      expect(released?.last_error).toContain("authority is unavailable")

      // A later cadence cannot turn an unavailable runtime into a registered parent wait.
      yield* db
        .update(TaskNotificationOutboxTable)
        .set({ available_at: 0 })
        .where(eq(TaskNotificationOutboxTable.id, "job_stub_outbox"))
        .run()
        .pipe(Effect.orDie)
      expect(yield* outbox.tick).toBe(0)
      const dead = yield* stubOutboxRow(db)
      expect(dead?.status).toBe("dead")
      expect(dead?.attempts).toBe(1)
      expect(dead?.last_error).toContain("authority is unavailable")

      // Dead rows are never re-claimed, and the row stays visible.
      yield* db
        .update(TaskNotificationOutboxTable)
        .set({ available_at: 0 })
        .where(eq(TaskNotificationOutboxTable.id, "job_stub_outbox"))
        .run()
        .pipe(Effect.orDie)
      expect(yield* outbox.tick).toBe(0)
      expect((yield* stubOutboxRow(db))?.status).toBe("dead")
      expect((yield* db.select({ total: count() }).from(SessionInputTable).get().pipe(Effect.orDie))?.total).toBe(0)
    }),
  )

  runtimeIt.live("runtimeLayer mounts the auto-started dispatcher and delivery daemons", () =>
    Effect.gen(function* () {
      yield* TaskRunDispatcher.Service
      yield* TaskOutbox.Service
      // A few scan cadences tick against the empty ledger before the scope closes the daemons.
      yield* Effect.sleep(60)
    }),
  )

  test("reopen recovery: an expired-lease claim left by a dead process settles exactly once", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "dispatcher-recovery.db")
    const parentID = SessionSchema.ID.create()
    const fixture = path.join(import.meta.dirname, "task-dispatcher-recovery-process.ts")

    // "Process 1": submits the background run, claims it, and dies holding an expired lease.
    const claimed = Bun.spawnSync([process.execPath, fixture, file, "claim", parentID], {
      cwd: import.meta.dirname + "/..",
    })
    expect(claimed.exitCode).toBe(0)
    const runID = claimed.stdout.toString().match(/RUN_ID=(\S+)/)?.[1]
    expect(runID).toBeDefined()

    // "Process 2" reopens the file: the dispatcher re-claims once, settles once, delivers once.
    const recovered = Bun.spawnSync([process.execPath, fixture, file, "recover", parentID, runID!], {
      cwd: import.meta.dirname + "/..",
    })
    expect(recovered.exitCode).toBe(0)
    expect(recovered.stdout.toString()).toContain("RECOVERED_OK")
  }, 120_000)
})
