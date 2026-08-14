import { expect } from "bun:test"
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { LLMEvent } from "@deepagent-code/llm"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentLearningAdmissionOutbox } from "@deepagent-code/core/deepagent/learning-admission-outbox"
import { LearningAdmissionOutboxTable } from "@deepagent-code/core/deepagent/learning-admission-outbox.sql"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { Global } from "@deepagent-code/core/global"
import { DurableLearningRuntime } from "@/deepagent/learning-runtime"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

it.effect("DurableLearningRuntime installs record and reconcile methods for AgentGateway", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const database = Context.get(
      yield* Layer.build(Database.layerFromPath(`${root}/learning.sqlite`)),
      Database.Service,
    )
    yield* database.db.insert(ProjectTable).values({
      id: Project.ID.make("project-learning-runtime"),
      worktree: AbsolutePath.make(root),
      sandboxes: [],
      time_created: 1,
      time_updated: 1,
    })
    yield* database.db.insert(SessionTable).values({
      id: SessionSchema.ID.make("ses_learning_runtime"),
      project_id: Project.ID.make("project-learning-runtime"),
      slug: "ses_learning_runtime",
      directory: root,
      title: "Learning runtime",
      version: "1",
      time_created: 1,
      time_updated: 1,
    })
    const runtimeScope = yield* Scope.make()
    yield* Layer.build(
      Layer.fresh(DurableLearningRuntime.layer.pipe(Layer.provide(Layer.succeed(Database.Service, database)))),
    ).pipe(Effect.provideService(Scope.Scope, runtimeScope))

    AgentGateway.configure({
      enabled: true,
      agentMode: "high",
      baseDir: Global.Path.agent.data,
      runsDir: Global.Path.agent.runs,
      durableLearning: true,
      selfLearning: "manual",
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => AgentGateway.configure({ enabled: false, durableLearning: false, runsDir: undefined })),
    )
    yield* AgentGateway.manageStream(
      {
        callKind: "session_turn",
        feature: "session_chat",
        providerID: "test",
        modelID: "test-model",
        sessionID: "ses_learning_runtime",
        messageID: "msg_learning_runtime",
        workspaceID: root,
      },
      Stream.make(LLMEvent.finish({ reason: "stop" })),
    ).pipe(Stream.runCollect)

    const intents = yield* DeepAgentLearningAdmissionOutbox.pending(database.db)
    expect(intents).toHaveLength(0)
    const row = yield* database.db.select().from(LearningAdmissionOutboxTable).get()
    expect(row).toMatchObject({
      state: "admitted",
      job_id: expect.any(String),
      candidate_input_ref: expect.any(String),
    })

    yield* Scope.close(runtimeScope, Exit.void)
  }),
)
