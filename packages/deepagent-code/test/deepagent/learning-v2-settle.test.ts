import { describe, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@deepagent-code/llm"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import { ApplicationTools } from "@deepagent-code/core/tool/application-tools"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Config } from "@deepagent-code/core/config"
import { ConfigCompaction } from "@deepagent-code/core/config/compaction"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { Location } from "@deepagent-code/core/location"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { QuestionV2 } from "@deepagent-code/core/question"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRunCoordinator } from "@deepagent-code/core/session/run-coordinator"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import * as SessionRunnerLLM from "@deepagent-code/core/session/runner/llm"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
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
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { Effect, Layer, Schema, Stream } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "../lib/effect"
import { onSessionSettled, onSessionSettledSeamLayer } from "@/deepagent/learning-runtime"

// W7 — V2 session settle → durable learning admission (by flag). The runner composition mirrors the
// core SessionRunner harness (real V2 turn pipeline, fake provider) plus the REAL `onSessionSettled`
// hook injected through the same `SessionRunner.CurrentOnSessionSettled` seam the production
// compositions provide. Asserts the full outbox → admitted-job path in both flag postures.

const root = mkdtempSync(path.join(tmpdir(), "deepagent-w7-learning-v2-"))
const database = Database.layerFromPath(path.join(root, "learning.sqlite"))

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
      return Stream.fromIterable(response)
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
            compaction: new ConfigCompaction.Info({ buffer: 3_000, keep: new ConfigCompaction.Keep({ tokens: 1_000 }) }),
          }),
        }),
      ]),
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
  Layer.provide(testOwnerAuthorization),
  // W7: the runner's settle-hook seam — the SAME layer the production compositions provide. The
  // production wiring satisfies the seam's Database at the provide site (Database.defaultLayer); the
  // harness here satisfies it with the isolated test database.
  Layer.provide(onSessionSettledSeamLayer.pipe(Layer.provide(database))),
)
const coordinator = SessionRunCoordinator.layer.pipe(Layer.provide(runner))
const execution = Layer.effect(
  SessionExecution.Service,
  SessionRunCoordinator.Service.pipe(
    Effect.map((coordinatorService) =>
      SessionExecution.Service.of({
        active: coordinatorService.active,
        awaitIdle: coordinatorService.awaitIdle,
        resume: coordinatorService.run,
        wake: coordinatorService.wake,
        interrupt: coordinatorService.interrupt,
      }),
    ),
  ),
).pipe(Layer.provide(coordinator))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(execution),
)

const it = testEffect(
  Layer.mergeAll(database, providerTurns, events, questions, projector, store, runner, coordinator, execution, sessions),
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

const clearLearningTables = Effect.gen(function* () {
  const { db } = yield* Database.Service
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
  yield* SessionRunner.Service.use((svc) => svc.run({ sessionID, force: true }))
  expect(requests.length).toBeGreaterThan(0)
})

describe("W7 V2 session settle → durable learning admission", () => {
  it.effect(
    "admits one session_finalization learning run per settled activity when durableLearning is ON",
    () =>
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
        expect(outbox).toHaveLength(1)
        expect(outbox[0]).toMatchObject({ trigger: "session_finalization", state: "admitted" })
        const job = yield* db
          .select()
          .from(LearningJobTable)
          .where(eq(LearningJobTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)
        expect(job).toMatchObject({
          session_id: sessionID,
          trigger: "session_finalization",
          policy: "manual_review",
          run_id: expect.stringMatching(/^v2_/),
        })
      }),
  )

  it.effect(
    "keeps the legacy-only posture (no V2 admission) when DEEPAGENT_DURABLE_LEARNING is off",
    () =>
      Effect.gen(function* () {
        yield* clearLearningTables
        yield* configureGateway(false)
        yield* settleOnce
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
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      response = []
      yield* SessionRunner.Service.use((svc) => svc.run({ sessionID: emptySessionID, force: true }))
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
