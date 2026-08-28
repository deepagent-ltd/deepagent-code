import * as OpenAIResponses from "@deepagent-code/llm/protocols/openai-responses"
import { Auth, LLMClient, RequestExecutor } from "@deepagent-code/llm/route"
import { LLMEvent, type LLMClientShape, type LLMRequest } from "@deepagent-code/llm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Config } from "@deepagent-code/core/config"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionV2 } from "@deepagent-code/core/session"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionProjector } from "@deepagent-code/core/session/projector"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRunCoordinator } from "@deepagent-code/core/session/run-coordinator"
import * as SessionRunnerLLM from "@deepagent-code/core/session/runner/llm"
import { SessionRunnerModel } from "@deepagent-code/core/session/runner/model"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { V2ToolEffect } from "@deepagent-code/core/session/runner/v2-tool-effect"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionStore } from "@deepagent-code/core/session/store"
import { Location } from "@deepagent-code/core/location"
import { SystemContextRegistry } from "@deepagent-code/core/system-context/registry"
import { SystemContext } from "@deepagent-code/core/system-context"
import { SkillGuidance } from "@deepagent-code/core/skill/guidance"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { ModelV2 } from "@deepagent-code/core/model"
import { ModelProtocol } from "@deepagent-code/core/model-protocol"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { Hash } from "@deepagent-code/core/util/hash"
import { describe, expect, beforeEach } from "bun:test"
import { DateTime } from "effect"
import { eq } from "drizzle-orm"
import { Effect, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

/**
 * C2-04/B2 residual (P2-01) — live-runner identity binding + dispatch seam.
 *
 * When the model resolver supplies the catalog `ModelV2.Info` (as the production
 * `locationLayer` does), the prepared attempt must carry the protocol attempt
 * identity (route/protocol/origin/capability/lowering) and its hash, and the
 * dispatch seam must refuse to dispatch when the CURRENT config drifts from a
 * previously-bound identity (exact-retry re-seal) — the stale attempt records
 * zero physical requests (design §2.3, §4.1 step 8).
 */

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
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

const requests: LLMRequest[] = []
const executor = Layer.succeed(
  RequestExecutor.Service,
  RequestExecutor.Service.of({ execute: () => Effect.die("unused") }),
)
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      // Invoke the exact-wire seal so the receipt transitions to dispatching and persists the
      // prepared turn carrying the C2-04 identity, exactly as the production RequestExecutor does.
      return Stream.unwrap(
        Effect.gen(function* () {
          const seal = yield* V2ProviderTurn.CurrentRequestSeal
          if (seal) {
            yield* seal
              .seal({
                wireHash: Hash.sha256("runner-identity-wire"),
                bodyHash: Hash.sha256("runner-identity-body"),
                bodyLength: 31,
                contentType: "application/json",
              })
              .pipe(Effect.orDie)
          }
          return Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "msg_1" }),
            LLMEvent.textDelta({ id: "msg_1", text: "Hello" }),
            LLMEvent.textEnd({ id: "msg_1" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ])
        }),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

// Catalog OpenAI model -> resolves to `openai.responses`, route `openai-responses`.
const openAIInfo = new ModelV2.Info({
  id: ModelV2.ID.make("gpt-4.1-mini"),
  providerID: ProviderV2.ID.make("openai"),
  name: "OpenAI",
  api: {
    type: "aisdk",
    package: "@ai-sdk/openai",
    url: "https://api.openai.com/v1",
    id: ModelV2.ID.make("api-gpt-4.1-mini"),
  },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {}, generation: {}, options: {} },
  variants: [],
  time: { released: DateTime.makeUnsafe(0) },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 100, input: 80, output: 20 },
})
const openAIProvider = new ProviderV2.Info({
  id: ProviderV2.ID.make("openai"),
  name: "OpenAI",
  enabled: { via: "env", name: "OPENAI_API_KEY" },
  env: ["OPENAI_API_KEY"],
  api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://api.openai.com/v1" },
  request: { headers: {}, body: {} },
})
const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.com/v1" } })
  .with({ auth: Auth.bearer("test") })
  .with({ limits: { context: 100, input: 80, output: 20 } })
  .model({ id: "api-gpt-4.1-mini" })

const models = SessionRunnerModel.layerWith(() =>
  Effect.succeed({ model, info: openAIInfo, provider: openAIProvider }),
)
const systemContext = SystemContextRegistry.layer
const location = Location.layer({ directory: AbsolutePath.make("/project") }).pipe(Layer.provide(Project.defaultLayer))
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const runner = SessionRunnerLLM.layer.pipe(
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
)
const coordinator = SessionRunCoordinator.layer.pipe(Layer.provide(runner))
const execution = Layer.effect(
  SessionExecution.Service,
  SessionRunCoordinator.Service.pipe(
    Effect.map((coordinator) =>
      SessionExecution.Service.of({
        active: coordinator.active,
        awaitIdle: coordinator.awaitIdle,
        resume: coordinator.run,
        wake: coordinator.wake,
        interrupt: coordinator.interrupt,
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
    coordinator,
    execution,
    sessions,
  ),
)
const sessionID = SessionV2.ID.make("ses_runner_identity")

const seedSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
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
})

describe("SessionRunner identity binding (C2-04/B2 residual)", () => {
  beforeEach(() => {
    requests.length = 0
    AgentGateway.configure({ enabled: false, agentMode: "high" })
  })

  it.effect("binds the protocol attempt identity on the live-runner prepared attempt", () =>
    Effect.gen(function* () {
      // Explicit config action: refresh (derive + cache) the capability evidence. The business turn
      // must consume this cached evidence and never run the probe. The probe-counter is module-global,
      // so assert the DELTA rather than an absolute count (other files may have probed).
      const probeBefore = ModelProtocol.probeHookCalls()
      const evidence = ModelProtocol.refreshConfigEvidence(openAIInfo, openAIProvider)
      expect(ModelProtocol.configEvidenceForTurn(openAIInfo, openAIProvider)).toEqual(evidence)
      expect(ModelProtocol.probeHookCalls()).toBe(probeBefore + 1)

      yield* seedSession
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Say hello." }), resume: false })
      yield* session.resume(sessionID)

      // Exactly one physical request per turn, dispatched through the /responses route adapter.
      expect(requests).toHaveLength(1)

      const { db } = yield* Database.Service
      const receipt = yield* db
        .select()
        .from(V2ProviderTurnReceiptTable)
        .get()
        .pipe(Effect.orDie)
      expect(receipt).toBeDefined()
      if (!receipt) return
      // The prepared attempt record carries the C2-04 identity + hash (bound at dispatch).
      expect(receipt.owner_mode).toBe("v2")
      expect(receipt.prepared_turn).toMatchObject({
        protocol_attempt_identity: {
          protocol: "openai.responses",
          routeId: "openai-responses",
          originId: "openai",
          loweringVersion: 1,
        },
      })
      const boundIdentityHash = (receipt.prepared_turn as { protocol_attempt_identity_hash?: string })
        .protocol_attempt_identity_hash
      expect(boundIdentityHash).toMatch(/^[0-9a-f]{64}$/)
    }),
  )

  it.effect("refuses to dispatch a drifted attempt (bound identity mismatch => zero requests)", () =>
    Effect.gen(function* () {
      // Same canonical OpenAI protocol, but a drifted endpoint binding changes the identity hash.
      const identityA = ModelProtocol.protocolAttemptIdentityFor(openAIInfo, openAIProvider)
      const driftedInfo = new ModelV2.Info({
        ...openAIInfo,
        api: { ...openAIInfo.api, url: "https://drifted.openai.com/v1" },
      })
      const drifted = ModelProtocol.protocolAttemptIdentityFor(driftedInfo, openAIProvider)
      expect(ModelProtocol.configDrift(drifted, ModelProtocol.protocolAttemptIdentityHash(identityA))).toBe(true)

      // Dispatch seam gate: the stale (drifted) attempt never reaches the wire while the rebuilt
      // attempt does; this is the exact seam the runner wires (design §2.3).
      const sent: string[] = []
      const outcome = ModelProtocol.dispatchGuarded({
        current: drifted,
        storedIdentityHash: ModelProtocol.protocolAttemptIdentityHash(identityA),
        storedAttempt: "stale-attempt",
        rebuildAttempt: (identity) => `rebuilt:${identity.routeId}`,
        dispatch: (request) => {
          sent.push(request)
          return 1
        },
      })

      expect(outcome.action).toBe("rebuild")
      expect(sent).toEqual(["rebuilt:openai-responses"])
      expect(sent).not.toContain("stale-attempt")

      // And an exact retry that has NOT drifted re-dispatches the stored attempt as-is.
      const notDrifted = ModelProtocol.dispatchGuarded({
        current: identityA,
        storedIdentityHash: ModelProtocol.protocolAttemptIdentityHash(identityA),
        storedAttempt: "stored-attempt",
        rebuildAttempt: (identity) => `rebuilt:${identity.routeId}`,
        dispatch: (request) => {
          sent.push(request)
          return 1
        },
      })
      expect(notDrifted.action).toBe("dispatch")
      expect(sent).toContain("stored-attempt")
    }),
  )
})
