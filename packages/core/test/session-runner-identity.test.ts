import { projectLayer } from "./fixture/project-layer"
import * as OpenAIResponses from "@deepagent-code/llm/protocols/openai-responses"
import { Auth, LLMClient, RequestExecutor } from "@deepagent-code/llm/route"
import { LLMEvent, type LLMClientShape, type LLMRequest } from "@deepagent-code/llm"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Config } from "@deepagent-code/core/config"
import { Catalog } from "@deepagent-code/core/catalog"
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
import { V2ProviderTurnReceiptTable } from "@deepagent-code/core/session/runner/v2-provider-turn.sql"
import { PreparedProviderTurn } from "@deepagent-code/core/session/runner/prepared-provider-turn"
import { V2ToolEffect } from "@deepagent-code/core/session/runner/v2-tool-effect"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { ProductionV2Sources } from "@deepagent-code/core/context-federation/production-adapters"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import { SessionProviderAttemptTable } from "@deepagent-code/core/context-federation/session-sql"
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
import { ModelV2 } from "@deepagent-code/core/model"
import { ModelProtocol } from "@deepagent-code/core/model-protocol"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { Hash } from "@deepagent-code/core/util/hash"
import { describe, expect, beforeEach, test } from "bun:test"
import { DateTime, Option } from "effect"
import { eq } from "drizzle-orm"
import { Effect, Layer, LayerMap, Stream } from "effect"
import { testEffect } from "./lib/effect"

/**
 * C2-04/B2 residual (P2-01) — live-runner identity binding + dispatch seam.
 *
 * When the model resolver supplies catalog `ModelV2.Info`, admission binds the
 * protocol identity hash on the durable attempt before the wire seal. A route
 * change before dispatch terminalizes that attempt and admits a fresh successor;
 * the stale attempt records zero physical requests (design §2.3, §4.1 step 8).
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
const driftedInfo = new ModelV2.Info({
  ...openAIInfo,
  api: { ...openAIInfo.api, url: "https://drifted.openai.com/v1" },
})
const catalog = Layer.succeed(
  Catalog.Service,
  Catalog.Service.of({
    transform: () => Effect.die("unexpected catalog.transform"),
    provider: {
      get: () => Effect.succeed(openAIProvider),
      all: () => Effect.succeed([openAIProvider]),
      available: () => Effect.succeed([openAIProvider]),
    },
    model: {
      get: () => Effect.succeed(openAIInfo),
      all: () => Effect.succeed([openAIInfo]),
      available: () => Effect.succeed([openAIInfo]),
      default: () => Effect.succeed(Option.some(openAIInfo)),
      small: () => Effect.succeed(Option.some(openAIInfo)),
    },
  }),
)
const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.com/v1" } })
  .with({ auth: Auth.bearer("test") })
  .with({ limits: { context: 100, input: 80, output: 20 } })
  .model({ id: "api-gpt-4.1-mini" })
const driftedModel = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://drifted.openai.com/v1" } })
  .with({ auth: Auth.bearer("test") })
  .with({ limits: { context: 100, input: 80, output: 20 } })
  .model({ id: "api-gpt-4.1-mini" })

const routeState = { driftAfterFirst: false, resolves: 0 }
const models = SessionRunnerModel.layerWith(() => Effect.sync(() => {
  routeState.resolves++
  return routeState.driftAfterFirst && routeState.resolves > 1
    ? { model: driftedModel, info: driftedInfo, provider: openAIProvider }
    : { model, info: openAIInfo, provider: openAIProvider }
}))
const systemContext = SystemContextRegistry.layer
const location = Location.layer({ directory: AbsolutePath.make("/project") }).pipe(Layer.provide(projectLayer(database)))
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
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
    // This harness supplies the identity-test runner as the complete keyed Location tree.
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
  Layer.provide(projectLayer(database)),
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
      v2_authority: true,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("SessionRunner identity binding (C2-04/B2 residual)", () => {
  beforeEach(() => {
    requests.length = 0
    routeState.driftAfterFirst = false
    routeState.resolves = 0
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
      // The wire-sealed prepared turn carries the C2-04 identity + hash; the attempt
      // was already bound at admission.
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
      const attempts = yield* db.select().from(SessionProviderAttemptTable).all().pipe(Effect.orDie)
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.protocol_attempt_identity_hash).toBe(boundIdentityHash ?? null)
      // W8 — the seal persisted the identity-folded canonical hash: the durable column equals the
      // record's canonical value and differs from the raw request hash once an identity is bound.
      // (The transition trigger pins json_extract(prepared_turn, '$.prepared_turn_hash') to the
      // column, so these two MUST agree or the seal would have been aborted.)
      const preparedTurn = receipt.prepared_turn
      expect(preparedTurn).not.toBeNull()
      if (!preparedTurn) return
      expect(receipt.prepared_turn_hash).toBe(preparedTurn.prepared_turn_hash)
      expect(receipt.prepared_turn_hash).toBe(PreparedProviderTurn.preparedTurnHash(preparedTurn))
      expect(receipt.prepared_turn_hash).not.toBe(preparedTurn.request_hash)
    }),
  )

  it.effect("rebuilds a route changed after admission before any stale dispatch", () =>
    Effect.gen(function* () {
      routeState.driftAfterFirst = true
      yield* seedSession
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Say hello." }), resume: false })
      yield* session.resume(sessionID)

      const { db } = yield* Database.Service
      const attempts = yield* db.select().from(SessionProviderAttemptTable)
        .orderBy(SessionProviderAttemptTable.provider_turn_seq).all().pipe(Effect.orDie)
      expect(attempts).toHaveLength(2)
      expect(attempts[0]).toMatchObject({
        state: "failed",
        error_code: "config_drift_rebuild_required",
        first_event_at: null,
      })
      expect(attempts[0]?.protocol_attempt_identity_hash).toBe(
        ModelProtocol.protocolAttemptIdentityHash(ModelProtocol.protocolAttemptIdentityFor(openAIInfo, openAIProvider)),
      )
      expect(attempts[1]?.protocol_attempt_identity_hash).toBe(
        ModelProtocol.protocolAttemptIdentityHash(ModelProtocol.protocolAttemptIdentityFor(driftedInfo, openAIProvider)),
      )
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("refuses to dispatch a drifted attempt (bound identity mismatch => zero requests)", () =>
    Effect.gen(function* () {
      // Same canonical OpenAI protocol, but a drifted endpoint binding changes the identity hash.
      const identityA = ModelProtocol.protocolAttemptIdentityFor(openAIInfo, openAIProvider)
      const drifted = ModelProtocol.protocolAttemptIdentityFor(driftedInfo, openAIProvider)
      expect(ModelProtocol.configDrift(drifted, ModelProtocol.protocolAttemptIdentityHash(identityA))).toBe(true)

      // W8 audit oracle: an identical payload on a drifted route produces a DIFFERENT canonical
      // prepared_turn_hash (the durable exact-retry/drift identity now carries route/origin).
      const payload = "same-payload-on-drifted-route"
      expect(
        PreparedProviderTurn.preparedTurnHash({
          request_hash: payload,
          protocol_attempt_identity_hash: ModelProtocol.protocolAttemptIdentityHash(drifted),
        }),
      ).not.toBe(
        PreparedProviderTurn.preparedTurnHash({
          request_hash: payload,
          protocol_attempt_identity_hash: ModelProtocol.protocolAttemptIdentityHash(identityA),
        }),
      )

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

// A fenced attempt and a provider rejection bound DIFFERENT things — how many times the host may
// stall the event loop past the owner lease, vs. how many times the provider may reject — so they
// must not share one counter. Measured on Docker Desktop: a single long turn rotated the owner
// generation six times, spent a shared budget of 3, and ended the session; the agent exited 1 and
// the task scored nothing. Raising the lease only bounds ONE stall; this budget bounds how many
// stalls a turn may survive.
test("a fenced attempt spends the fence budget, never the provider-rejection budget", () => {
  const fenced = SessionRunnerLLM.nextAttemptBudgets({
    cause: "owner_fenced",
    retry: 2,
    providerRetry: 0,
    ownerFencedRetries: 0,
  })
  expect(fenced.providerRetry).toBe(0)
  expect(fenced.ownerFencedRetries).toBe(1)

  const rejected = SessionRunnerLLM.nextAttemptBudgets({
    cause: "provider_rejection",
    retry: 2,
    providerRetry: 2,
    ownerFencedRetries: 4,
  })
  expect(rejected.providerRetry).toBe(3)
  expect(rejected.ownerFencedRetries).toBe(4)

  // The fence budget advances monotonically across repeated stalls in one turn, so a host that
  // never recovers still terminates instead of retrying forever.
  const fence = Array.from({ length: 8 }).reduce<number>(
    (spent) =>
      SessionRunnerLLM.nextAttemptBudgets({
        cause: "owner_fenced",
        retry: 0,
        providerRetry: 0,
        ownerFencedRetries: spent,
      }).ownerFencedRetries,
    0,
  )
  expect(fence).toBe(8)
})
