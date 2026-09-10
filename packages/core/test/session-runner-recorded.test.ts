import { HttpRecorder } from "@deepagent-code/http-recorder"
import { HttpRecorderInternal } from "@deepagent-code/http-recorder/internal"
import * as OpenAIChat from "@deepagent-code/llm/protocols/openai-chat"
import { Auth, LLMClient, RequestExecutor } from "@deepagent-code/llm/route"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventTable } from "@deepagent-code/core/event/sql"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Config } from "@deepagent-code/core/config"
import { Catalog } from "@deepagent-code/core/catalog"
import { ModelV2 } from "@deepagent-code/core/model"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { Delegation } from "../src/tool/delegation"
import { SessionExecutionLocal } from "@deepagent-code/core/session/execution/local"
import * as SessionRunnerLLM from "@deepagent-code/core/session/runner/llm"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2ToolEffect } from "@deepagent-code/core/session/runner/v2-tool-effect"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { ProductionV2Sources } from "@deepagent-code/core/context-federation/production-adapters"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { Location } from "@deepagent-code/core/location"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { SystemContext } from "@deepagent-code/core/system-context"
import { SkillGuidance } from "@deepagent-code/core/skill/guidance"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Git } from "@deepagent-code/core/git"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, LayerMap, Option } from "effect"
import path from "node:path"
import { CONTEXT_FEDERATION_PRODUCTION_ENV } from "../src/context-federation/production-adapters"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
// W3.6/W3.8 — the cassette was recorded under the W3 production default (missing sources degrade
// honestly and the selection evidence tail IS appended — the recorded request literally carries the
// "Context selection (this turn):" system part). The W3.8 M1 single-point gate is ON by default;
// this test pins it explicitly so the replayed request deterministically equals the recording even
// when a caller/process already set the key, and restores the previous value afterwards. The
// `=false` byte-invariance proof (no evidence part) lives in session-runner.test.ts with a captured
// request — a replay test cannot exercise it because the recorded fixture differs.
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const cassette =
  process.env.RECORD === "true"
    ? HttpRecorderInternal.cassetteLayer("session-runner/openai-chat-streams-text", {
        directory: path.resolve(import.meta.dir, "fixtures/recordings"),
        mode: "record",
      })
    : HttpRecorder.http("session-runner/openai-chat-streams-text", {
        directory: path.resolve(import.meta.dir, "fixtures/recordings"),
      })
const executor = RequestExecutor.layer.pipe(Layer.provide(cassette))
const client = LLMClient.layer.pipe(Layer.provide(executor))
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
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const agents = AgentV2.layer
const model = OpenAIChat.route
  .with({
    endpoint: { baseURL: "https://api.openai.com/v1" },
    auth: Auth.bearer(process.env.OPENAI_API_KEY ?? "fixture"),
    generation: { maxTokens: 20, temperature: 0 },
  })
  .model({ id: "gpt-4o-mini" })
const models = SessionRunnerModel.layerWith(() => Effect.succeed({ model }))
const systemContext = SystemContextRegistry.layer
const location = Location.layer({ directory: AbsolutePath.make("/project") }).pipe(Layer.provide(Project.defaultLayer))
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
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
const runner = SessionRunnerLLM.layer.pipe(
  Layer.provide(ContextQueryAuthorization.defaultLayer),
  Layer.provide(Layer.succeed(ProductionV2Sources, {})),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(
    Layer.succeed(
      V2ProviderTurn.OwnerAuthorization,
      V2ProviderTurn.OwnerAuthorization.of({ authorize: () => Effect.succeed(true) }),
    ),
  ),
  Layer.provide(V2ProviderTurn.layer.pipe(Layer.provide(SessionProviderOwner.layer), Layer.provide(database))),
  Layer.provide(V2ToolEffect.layer.pipe(Layer.provide(database))),
  Layer.provide(
    SessionContext.layer.pipe(
      Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
      Layer.provide(database),
    ),
  ),
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
  Layer.provide(Layer.mergeAll(catalog, AgentGateway.runtimeLayer({ enabled: false, agentMode: "high" }))),
)
const locations = Layer.effect(
  LocationServiceMap,
  LayerMap.make(() => runner).pipe(
    // This harness supplies the recorded runner as the complete keyed Location tree.
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
  Layer.mergeAll(
    database,
    events,
    projector,
    store,
    executor,
    client,
    permission,
    agents,
    registry,
    models,
    systemContext,
    location,
    skillGuidance,
    config,
    runner,
    execution,
    sessions,
  ),
)
const sessionID = SessionV2.ID.make("ses_runner_recorded")

describe("SessionRunnerLLM recorded", () => {
  it.effect("executes one recorded V2 prompt through the recorded HTTP transport", () =>
    Effect.gen(function* () {
      // This is a pure V2 HTTP transport-REPLAY test: the cassette was recorded with the DeepAgent
      // runtime OFF, so the request is just the user prompt. AgentGateway is a process-global that a
      // prior test may have left enabled — which would prepend the DeepAgent system message and break the
      // fixture match. Force it disabled so the replayed request matches the recording deterministically.
      AgentGateway.configure({ enabled: false, agentMode: "high" })
      // W3.6/W3.8 pin: the recorded request carries the W3 production selection-evidence tail, so the
      // W3 flag must be ON for the replayed bytes to equal the fixture (see the module comment above).
      const previousFlag = process.env[CONTEXT_FEDERATION_PRODUCTION_ENV]
      process.env[CONTEXT_FEDERATION_PRODUCTION_ENV] = "true"
      const { db } = yield* Database.Service
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousFlag === undefined) delete process.env[CONTEXT_FEDERATION_PRODUCTION_ENV]
          else process.env[CONTEXT_FEDERATION_PRODUCTION_ENV] = previousFlag
        }),
      )
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      const prompt = yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Say hello in one short sentence." }),
        resume: false,
      })

      yield* session.resume(sessionID)

      const messages = yield* session.context(sessionID)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ id: prompt.id, type: "user", text: "Say hello in one short sentence." })
      expect(messages[1]).toMatchObject({ type: "assistant", agent: "auto", finish: "stop" })
      expect(messages[1]?.type === "assistant" ? messages[1].content : []).toMatchObject([
        { type: "text", text: "Hello!" },
      ])
      expect(
        (yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .orderBy(EventTable.seq)
          .all()).map((event) => event.type),
      ).toEqual([
        "session.next.prompt.admitted.1",
        "session.execution.started.1",
        "session.next.prompt.promoted.1",
        // W4-6 wire egress: fold boundaries derive V1 wire rows (merge-preserved with any
        // host-authored fields); the interleaved wire events are the egress output.
        "message.updated.1",
        "message.part.updated.1",
        "session.next.step.started.1",
        "message.updated.1",
        "session.next.text.started.1",
        "message.part.updated.1",
        "session.next.text.ended.1",
        "message.part.updated.1",
        "session.next.step.ended.2",
        "message.updated.1",
        "message.part.updated.1",
        "message.part.updated.1",
        "session.execution.succeeded.1",
      ])
    }),
  )
})
