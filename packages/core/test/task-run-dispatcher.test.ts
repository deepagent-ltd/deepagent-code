import { projectLayer } from "./fixture/project-layer"
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@deepagent-code/llm"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import { count, eq } from "drizzle-orm"
import { Context, Deferred, Effect, Layer, LayerMap, Option, Schema, Stream } from "effect"
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
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((_request: LLMRequest) => {
      const events = Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
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

const database = Database.layerFromPath(":memory:")
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
const execution = SessionExecutionLocal.layer.pipe(
  Layer.provide(events),
  Layer.provide(store),
  Layer.provide(TaskTool.delegationSlotLayer),
  Layer.provide(locations),
)
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
    Layer.mergeAll(TaskRunDispatcher.layer({ maxConcurrent: 2 }), TaskOutbox.layer()).pipe(
      Layer.provide(database),
      Layer.provide(sessions),
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
const stubOutbox = TaskOutbox.layer({ maxAttempts: 2, backoffBaseMs: 1, backoffMaxMs: 1 }).pipe(
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
  it.effect("background run end-to-end: claim → resume-join → settle → outbox → ONE parent queue input", () =>
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

      // Delivery admits exactly ONE queue-mode session_input with the deterministic id, then the
      // row is delivered. The parent pickup rides the advisory wake scheduled by SessionV2.prompt.
      response = textResponse("parent acknowledged")
      expect(yield* outbox.tick).toBe(1)

      const row = yield* outboxRowFor(db, submitted.run.runID)
      expect(row?.status).toBe("delivered")
      expect(row?.time_delivered).toBeNumber()
      expect(row?.parent_input_message_id).toBe(row?.message_id)

      const inputs = yield* parentInputs(db, parent.id)
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.id).toBe(SessionMessage.ID.make(row!.message_id))
      expect(inputs[0]?.delivery).toBe("queue")
      expect(inputs[0]?.prompt).toEqual(
        new Prompt({
          text: TaskOutbox.notificationText({
            runID: submitted.run.runID,
            runState: "completed",
            text: "The child answer: 42",
          }),
        }),
      )
      // A repeated delivery pass is a no-op: nothing left to claim, still exactly one input.
      expect(yield* outbox.tick).toBe(0)
      expect(yield* parentInputs(db, parent.id)).toHaveLength(1)
    }),
  )

  it.effect("crash between claim and delivered: re-claim admits exactly one session_input", () =>
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
      expect(row?.status).toBe("delivered")
      expect(row?.attempts).toBe(2)

      // Exactly-once: both attempts share the deterministic id, so only ONE session_input exists.
      const inputs = yield* parentInputs(db, parent.id)
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.id).toBe(SessionMessage.ID.make(row!.message_id))
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

  stubIt.effect("a delivery that keeps failing exhausts attempts and dead-letters", () =>
    Effect.gen(function* () {
      yield* insertStubFixture
      const db = (yield* Database.Service).db
      const outbox = yield* TaskOutbox.Service

      // Attempt 1 fails transiently: released with backoff (pending, not yet due).
      expect(yield* outbox.tick).toBe(1)
      const released = yield* stubOutboxRow(db)
      expect(released?.status).toBe("pending")
      expect(released?.attempts).toBe(1)
      expect(released?.available_at).toBeGreaterThan(Date.now() - 1)
      expect(released?.last_error).toContain("transiently failing")

      // Backoff elapsed: attempt 2 fails again and the bounded attempts are exhausted.
      yield* db
        .update(TaskNotificationOutboxTable)
        .set({ available_at: 0 })
        .where(eq(TaskNotificationOutboxTable.id, "job_stub_outbox"))
        .run()
        .pipe(Effect.orDie)
      expect(yield* outbox.tick).toBe(1)
      const dead = yield* stubOutboxRow(db)
      expect(dead?.status).toBe("dead")
      expect(dead?.attempts).toBe(2)
      expect(dead?.last_error).toContain("transiently failing")

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
