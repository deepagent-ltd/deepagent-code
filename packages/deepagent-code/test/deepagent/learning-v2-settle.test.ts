import { describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import path from "node:path"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@deepagent-code/llm"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Config } from "@deepagent-code/core/config"
import { Catalog } from "@deepagent-code/core/catalog"
import { ModelV2 } from "@deepagent-code/core/model"
import { ConfigCompaction } from "@deepagent-code/core/config/compaction"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { Location } from "@deepagent-code/core/location"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { QuestionV2 } from "@deepagent-code/core/question"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { ProductionV2Sources } from "@deepagent-code/core/context-federation/production-adapters"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import { Delegation } from "@deepagent-code/core/tool/delegation"
import * as SessionRunnerLLM from "@deepagent-code/core/session/runner/llm"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { PreparedProviderTurn } from "@deepagent-code/core/session/runner/prepared-provider-turn"
import { SessionProviderOwnerLeaseTable } from "@deepagent-code/core/context-federation/session-sql"
import { V2ToolEffect } from "@deepagent-code/core/session/runner/v2-tool-effect"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionStore } from "@deepagent-code/core/session/store"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SkillGuidance } from "@deepagent-code/core/skill/guidance"
import { SystemContext } from "@deepagent-code/core/system-context"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { ToolOutputStore } from "@deepagent-code/core/tool-output-store"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import { LearningAdmissionOutboxTable } from "@deepagent-code/core/deepagent/learning-admission-outbox.sql"
import { LearningJobTable } from "@deepagent-code/core/deepagent/learning-job.sql"
import { LearningGenerationTable } from "@deepagent-code/core/deepagent/learning-generation.sql"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Hash } from "@deepagent-code/core/util/hash"
import { Effect, Layer, LayerMap, Option, Schema, Stream } from "effect"
import { eq, sql } from "drizzle-orm"
import { testEffect } from "../lib/effect"
import { onSessionSettled, onSessionSettledSeamLayer } from "@/deepagent/learning-runtime"
import { tmpRootShared } from "../fixture/fixture"

// W7 — V2 session settle → durable learning admission (by flag). The runner composition mirrors the
// core SessionRunner harness (real V2 turn pipeline, fake provider) plus the REAL `onSessionSettled`
// hook injected through the same `SessionRunner.CurrentOnSessionSettled` seam the production
// compositions provide. Asserts the full outbox → admitted-job path in both flag postures.

const root = mkdtempSync(tmpRootShared())
// Every test gets a fresh runtime build. Keep its deliberately-faulted provider receipts isolated
// so an indeterminate-state assertion cannot poison the next test's startup inventory.
const database = Database.layerFromPath(":memory:")

const providerTurns = V2ProviderTurn.layer.pipe(
  Layer.provide(SessionProviderOwner.layer.pipe(Layer.provide(database))),
  Layer.provide(database),
)
const events = EventV2.layer.pipe(Layer.provide(database))
const questions = QuestionV2.layer.pipe(Layer.provide(events))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))

let response: LLMEvent[] = []
const requests: LLMRequest[] = []
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      // W15 (P2): the fake provider seals the request like the real transport — the wire seal is
      // the receipt state-machine authority. Without it the wire never leaves `preparing`, the
      // receipt terminalizes as `failed`/wire_seal_failed_before_dispatch, and the settle hook
      // (correctly) refuses to admit a failed activity — which is exactly the W15 posture, so the
      // success fixture must produce a genuinely SETTLED receipt.
      return Stream.unwrap(
        Effect.gen(function* () {
          const seal = yield* V2ProviderTurn.CurrentRequestSeal
          if (seal !== undefined) {
            yield* seal
              .seal({
                wireHash: Hash.sha256("w15-settle-wire"),
                bodyHash: Hash.sha256("w15-settle-body"),
                bodyLength: 40,
                contentType: "application/json",
              })
              .pipe(Effect.orDie)
          }
          return Stream.fromIterable(response)
        }),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
)
const agents = AgentV2.layer
const models = SessionRunnerModel.layerWith(() => Effect.succeed({ model }))
const systemContextKey = SystemContext.Key.make("test/context")
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registryService) =>
      registryService.register({
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
const location = Location.layer({ directory: AbsolutePath.make(root) }).pipe(Layer.provide(Project.defaultLayer))
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
      get: (providerID, modelID) => Effect.fail(new Catalog.ModelNotFoundError({ providerID, modelID })),
      all: () => Effect.succeed([]),
      available: () => Effect.succeed([]),
      default: () => Effect.succeed(Option.none<ModelV2.Info>()),
      small: () => Effect.succeed(Option.none<ModelV2.Info>()),
    },
  }),
)
const testOwnerAuthorization = Layer.succeed(
  V2ProviderTurn.OwnerAuthorization,
  V2ProviderTurn.OwnerAuthorization.of({ authorize: () => Effect.succeed(true) }),
)
const sessionContext = SessionContext.layer.pipe(
  Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
  Layer.provide(database),
)
const runner = SessionRunnerLLM.layer.pipe(
  Layer.provide(
    AgentGateway.runtimeLayer({
      enabled: true,
      agentMode: "high",
      baseDir: root,
      runsDir: path.join(root, "runs"),
    }),
  ),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(providerTurns),
  Layer.provide(V2ToolEffect.layer.pipe(Layer.provide(database))),
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
  // W7: the runner's settle-hook seam — the SAME layer the production compositions provide. The
  // production wiring satisfies the seam's Database at the provide site (Database.defaultLayer); the
  // harness here satisfies it with the isolated test database.
  Layer.provide(
    Layer.mergeAll(
      catalog,
      ContextQueryAuthorization.defaultLayer,
      Layer.succeed(ProductionV2Sources, {}),
      testOwnerAuthorization,
      onSessionSettledSeamLayer.pipe(Layer.provide(database)),
    ),
  ),
)
const locations = Layer.effect(
  LocationServiceMap,
  LayerMap.make(() => runner).pipe(
    // This harness supplies the learning runner as the complete keyed Location tree.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    Effect.map((service) => service as unknown as LocationServiceMap["Service"]),
  ),
)
const execution = SessionExecutionLocal.layer.pipe(
  Layer.provide(events),
  Layer.provide(store),
  Layer.provide(locations),
  Layer.provide(Delegation.delegationSlotLayer),
)
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(execution),
)

const it = testEffect(
  Layer.mergeAll(database, providerTurns, events, questions, projector, store, runner, execution, sessions),
)

const sessionID = SessionSchema.ID.make("ses_w7_learning_settle")

const seedSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: root,
      title: "W7 settle",
      version: "test",
      v2_authority: true,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const configureGateway = (durableLearning: boolean) =>
  Effect.gen(function* () {
    AgentGateway.configure({
      enabled: true,
      agentMode: "high",
      selfLearning: "manual",
      baseDir: root,
      runsDir: path.join(root, "runs"),
      durableLearning,
      allowProviderExecutedTools: false,
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() =>
        AgentGateway.configure({ enabled: false, agentMode: "high", runsDir: undefined, durableLearning: false }),
      ),
    )
  })

const seedAuthoritativeCompletion = Effect.sync(() => {
  const plan = {
    plan_id: "plan-w7-authoritative-completion",
    session_id: sessionID,
    goal: "finish and verify the W7 task",
    assumptions: [],
    steps: [
      {
        step_id: "step-w7-complete",
        title: "finish and verify",
        status: "done" as const,
        acceptance: "the focused test passes",
        evidence: ["bun test test/deepagent/learning-v2-settle.test.ts: passed"],
      },
    ],
    active_step_id: null,
    created_at: "2026-09-18T00:00:00.000Z",
  }
  AgentGateway.DeepAgentSessionState.getOrCreate(sessionID, "high")
  const planRef = AgentGateway.DeepAgentPlanStore.setPlanDoc(sessionID, plan)
  const goalId = "goal-w7-authoritative-completion"
  AgentGateway.DeepAgentSessionState.setActiveGoal(sessionID, {
    goalId,
    planDocId: planRef.id,
    phase: "done",
    startedAt: "2026-09-18T00:00:00.000Z",
  })
  AgentGateway.DeepAgentDocumentStore.DocumentStore.shared(
    AgentGateway.DeepAgentPlanStore.planStoreRoot(sessionID),
  ).upsert({
    type: "decision",
    scope: AgentGateway.DeepAgentPlanStore.planScope(sessionID),
    description: `goal ${goalId} completion report`,
    idSlug: `goal-completion-${goalId}`,
    body: JSON.stringify({
      goalId,
      planDocId: planRef.id,
      criteriaMet: true,
      plan: AgentGateway.DeepAgentPlanController.buildCompletionReport(plan),
    }),
    provenance: { source: "runner", run_ref: AgentGateway.DeepAgentPlanStore.planScope(sessionID) },
    extensions: { goal_id: goalId, outcome: "done", report_kind: "completion" },
  })
})

const clearLearningTables = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.delete(LearningGenerationTable).run().pipe(Effect.orDie)
  yield* db.delete(LearningAdmissionOutboxTable).run().pipe(Effect.orDie)
  yield* db.delete(LearningJobTable).run().pipe(Effect.orDie)
})

const settleOnce = Effect.gen(function* () {
  yield* seedSession
  const session = yield* SessionV2.Service
  response = [
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text-0" }),
    LLMEvent.textDelta({ id: "text-0", text: "answer" }),
    LLMEvent.textEnd({ id: "text-0" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ]
  requests.length = 0
  yield* session.prompt({ sessionID, prompt: new Prompt({ text: "W7 settle prompt" }), resume: false })
  yield* session.resume(sessionID)
  expect(requests.length).toBeGreaterThan(0)
})

describe("W7 V2 session settle → durable learning admission", () => {
  it.effect("seals an unfinished settled activity without treating it as completed learning", () =>
    Effect.gen(function* () {
      yield* clearLearningTables
      yield* configureGateway(true)
      yield* settleOnce
      const { db } = yield* Database.Service
      const outbox = yield* db
        .select()
        .from(LearningAdmissionOutboxTable)
        .where(eq(LearningAdmissionOutboxTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(outbox).toHaveLength(0)
      expect(yield* db.select().from(LearningJobTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(LearningGenerationTable).all().pipe(Effect.orDie)).toEqual([
        expect.objectContaining({ session_id: sessionID, trigger: null, admitted_at: null }),
      ])
    }),
  )

  it.effect("an explicit V2 runtime with durable learning off admits nothing", () =>
    Effect.gen(function* () {
      yield* clearLearningTables
      yield* seedSession
      const runtime = yield* AgentGateway.Runtime.pipe(
        Effect.provide(
          AgentGateway.runtimeLayer({
            enabled: true,
            agentMode: "high",
            baseDir: root,
            runsDir: path.join(root, "disabled-runs"),
            durableLearning: false,
          }),
        ),
      )
      yield* onSessionSettled(yield* Database.Service)(
        { sessionID, workspacePath: root, activityId: "activity_learning_disabled" },
        runtime,
      )
      const { db } = yield* Database.Service
      const outbox = yield* db.select().from(LearningAdmissionOutboxTable).all().pipe(Effect.orDie)
      expect(outbox).toHaveLength(0)
    }),
  )

  it.effect("a forced drain without a dispatched activity admits nothing", () =>
    Effect.gen(function* () {
      yield* clearLearningTables
      yield* configureGateway(true)
      yield* seedSession
      const emptySessionID = SessionSchema.ID.make("ses_w7_learning_empty")
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: emptySessionID,
          project_id: Project.ID.global,
          slug: emptySessionID,
          directory: root,
          title: "W7 empty",
          version: "test",
          v2_authority: true,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      response = []
      yield* SessionExecution.Service.use((service) => service.resume(emptySessionID))
      const outbox = yield* db.select().from(LearningAdmissionOutboxTable).all().pipe(Effect.orDie)
      expect(outbox).toHaveLength(0)
    }),
  )
})

describe("W7 onSessionSettled hook unit semantics", () => {
  it.effect("skips cleanly when the session row is missing", () =>
    Effect.gen(function* () {
      yield* clearLearningTables
      yield* configureGateway(true)
      const { db } = yield* Database.Service
      yield* onSessionSettled(yield* Database.Service)({
        sessionID: SessionSchema.ID.make("ses_w7_missing"),
        workspacePath: root,
        activityId: "activity_missing",
      })
      const outbox = yield* db.select().from(LearningAdmissionOutboxTable).all().pipe(Effect.orDie)
      expect(outbox).toHaveLength(0)
    }),
  )
})

describe("W15 onSessionSettled reads the V2 receipt terminal state (P2)", () => {
  // Direct-unit postures: seed the owner lease + activity receipt rows the hook reads, then
  // invoke the REAL settle hook. Receipt rows are the durable facts the production runner writes
  // (state semantics per v2-provider-turn.ts: settled / failed / indeterminate_after_crash). The
  // DB trigger authority only admits `preparing` inserts and the legal state walk
  // (preparing → dispatching → streaming → settled/failed/indeterminate), so the seed replays
  // that walk with the minimal fields the guard inspects.
  const seedReceipt = Effect.fn("seedReceipt")(function* (input: {
    readonly activityId: string
    readonly state: "settled" | "failed" | "indeterminate_after_crash"
    readonly providerTurnSeq?: number
    readonly requestOrdinal?: number
    readonly errorCode?: string
    readonly ownerMode?: "v2" | "shadow_v2"
  }) {
    const { db } = yield* Database.Service
    yield* seedSession
    // The lease clock guard requires observed time (registered_at = heartbeat_at = DB now).
    const dbNowMs = sql`CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`
    const receiptId = `receipt_w15_${input.activityId}_${input.providerTurnSeq ?? 1}`
    yield* db
      .insert(SessionProviderOwnerLeaseTable)
      .values({
        owner_token: `owner_w15_${input.activityId}`,
        registered_at: dbNowMs,
        heartbeat_at: dbNowMs,
        lease_expires_at: sql`${dbNowMs} + 3600000`,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(V2ProviderTurnReceiptTable)
      .values({
        receipt_id: receiptId,
        session_id: sessionID,
        request_ordinal: input.requestOrdinal ?? 1,
        activity_id: input.activityId,
        provider_turn_seq: input.providerTurnSeq ?? 1,
        user_message_id: `msg_w15_${input.activityId}`,
        history_prompt_epoch: 1,
        request_input_hash: `req_${input.activityId}`,
        provider_id: "fake",
        model_id: "fake-model",
        protocol: "openai-chat",
        owner_mode: input.ownerMode ?? "v2",
        owner_token: `owner_w15_${input.activityId}`,
        state: "preparing",
        created_at: dbNowMs,
      })
      .run()
      .pipe(Effect.orDie)
    if (input.state === "failed") {
      // preparing → failed (the abandon/pre-dispatch terminal, also the terminal-provider-failure path).
      yield* db
        .update(V2ProviderTurnReceiptTable)
        .set({ state: "failed", error_code: input.errorCode ?? "provider_stream_failed:test", terminal_at: dbNowMs })
        .where(eq(V2ProviderTurnReceiptTable.receipt_id, receiptId))
        .run()
        .pipe(Effect.orDie)
      return
    }
    // preparing → dispatching → streaming, then the terminal. The transition trigger inspects the
    // canonical prepared-turn hash off the prepared-turn JSON (W8 pin), so compute it properly —
    // the full PreparedProviderTurn shape is irrelevant to the hook, only the pinned fields matter.
    const preparedTurnHash = PreparedProviderTurn.preparedTurnHash({ request_hash: "req_hash" })
    const preparedTurn = {
      request_hash: "req_hash",
      prepared_turn_hash: preparedTurnHash,
      wire_request_hash: "wh",
    } as PreparedProviderTurn.PreparedProviderTurn
    yield* db
      .update(V2ProviderTurnReceiptTable)
      .set({
        state: "dispatching",
        prepared_turn_hash: preparedTurnHash,
        wire_request_hash: preparedTurn.wire_request_hash,
        prepared_turn: preparedTurn,
        dispatching_at: dbNowMs,
      })
      .where(eq(V2ProviderTurnReceiptTable.receipt_id, receiptId))
      .run()
      .pipe(Effect.orDie)
    yield* db
      .update(V2ProviderTurnReceiptTable)
      .set({ state: "streaming", first_event_at: dbNowMs })
      .where(eq(V2ProviderTurnReceiptTable.receipt_id, receiptId))
      .run()
      .pipe(Effect.orDie)
    if (input.state === "settled") {
      yield* db
        .update(V2ProviderTurnReceiptTable)
        .set({ state: "settled", outcome_hash: "a".repeat(64), outcome_artifact: [], terminal_at: dbNowMs })
        .where(eq(V2ProviderTurnReceiptTable.receipt_id, receiptId))
        .run()
        .pipe(Effect.orDie)
      return
    }
    yield* db
      .update(V2ProviderTurnReceiptTable)
      .set({
        state: "indeterminate_after_crash",
        error_code: input.errorCode ?? "consumer_cancelled_after_dispatch",
        terminal_at: dbNowMs,
      })
      .where(eq(V2ProviderTurnReceiptTable.receipt_id, receiptId))
      .run()
      .pipe(Effect.orDie)
  })

  it.effect("a failed terminal activity is NOT admitted (no learning admission)", () =>
    Effect.gen(function* () {
      yield* clearLearningTables
      yield* configureGateway(true)
      yield* seedReceipt({
        activityId: "activity_w15_failed",
        state: "failed",
        requestOrdinal: 101,
        errorCode: "provider_stream_failed:abc",
      })
      yield* onSessionSettled(yield* Database.Service)({
        sessionID,
        workspacePath: root,
        activityId: "activity_w15_failed",
      })
      const { db } = yield* Database.Service
      const outbox = yield* db.select().from(LearningAdmissionOutboxTable).all().pipe(Effect.orDie)
      expect(outbox).toHaveLength(0)
    }),
  )

  it.effect("an indeterminate terminal activity is NOT admitted either", () =>
    Effect.gen(function* () {
      yield* clearLearningTables
      yield* configureGateway(true)
      yield* seedReceipt({
        activityId: "activity_w15_indeterminate",
        state: "indeterminate_after_crash",
        requestOrdinal: 102,
      })
      yield* onSessionSettled(yield* Database.Service)({
        sessionID,
        workspacePath: root,
        activityId: "activity_w15_indeterminate",
      })
      const { db } = yield* Database.Service
      const outbox = yield* db.select().from(LearningAdmissionOutboxTable).all().pipe(Effect.orDie)
      expect(outbox).toHaveLength(0)
    }),
  )

  it.effect("a learning reviewer session cannot recursively admit another learning job", () =>
    Effect.gen(function* () {
      yield* clearLearningTables
      yield* configureGateway(true)
      yield* seedReceipt({
        activityId: "activity_w15_learning_reviewer",
        state: "settled",
        requestOrdinal: 150,
      })
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({
          agent: "reviewer",
          metadata: { deepagent: { learning_reviewer_attempt_id: "review:source-job" } },
        })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)

      yield* onSessionSettled(yield* Database.Service)({
        sessionID,
        workspacePath: root,
        activityId: "activity_w15_learning_reviewer",
      })

      expect(yield* db.select().from(LearningAdmissionOutboxTable).all().pipe(Effect.orDie)).toHaveLength(0)
      expect(yield* db.select().from(LearningJobTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )

  it.effect("admits one learning source per authoritative Goal completion", () =>
    Effect.gen(function* () {
      yield* clearLearningTables
      yield* configureGateway(true)
      yield* seedAuthoritativeCompletion
      // One real settled round + one pre-dispatch rebuild artifact (same chain, later ordinal)
      // + one shadow-parity probe row: totalRounds must count exactly 1.
      yield* seedReceipt({ activityId: "activity_w15_settled", state: "settled", requestOrdinal: 201 })
      yield* seedReceipt({
        activityId: "activity_w15_settled",
        state: "failed",
        providerTurnSeq: 2,
        requestOrdinal: 202,
        errorCode: "epoch_mismatch_rebuild",
      })
      yield* seedReceipt({
        activityId: "activity_w15_settled",
        state: "settled",
        providerTurnSeq: 3,
        requestOrdinal: 203,
        ownerMode: "shadow_v2",
      })
      yield* onSessionSettled(yield* Database.Service)({
        sessionID,
        workspacePath: root,
        activityId: "activity_w15_settled",
      })
      const { db } = yield* Database.Service
      const outbox = yield* db
        .select()
        .from(LearningAdmissionOutboxTable)
        .where(eq(LearningAdmissionOutboxTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(outbox).toHaveLength(1)
      expect(outbox[0]!.trigger).toBe("session_finalization")
      expect(yield* db.select().from(LearningGenerationTable).all().pipe(Effect.orDie)).toHaveLength(0)
      const intent = JSON.parse(outbox[0]!.payload_json) as { final_status: string; total_rounds: number }
      expect(intent.final_status).toBe("completed")
      expect(intent.total_rounds).toBe(1)

      // The completed Goal pointer/report remain visible after admission. A later ordinary settled
      // activity must not turn that stale completion authority into a second learning source.
      yield* seedReceipt({ activityId: "activity_w15_after_goal", state: "settled", requestOrdinal: 204 })
      yield* onSessionSettled(yield* Database.Service)({
        sessionID,
        workspacePath: root,
        activityId: "activity_w15_after_goal",
      })
      expect(
        yield* db
          .select()
          .from(LearningAdmissionOutboxTable)
          .where(eq(LearningAdmissionOutboxTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      expect(yield* db.select().from(LearningGenerationTable).all().pipe(Effect.orDie)).toHaveLength(0)
    }),
  )
})
