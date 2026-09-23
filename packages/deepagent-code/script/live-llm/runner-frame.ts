import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { ProductionV2Sources } from "@deepagent-code/core/context-federation/production-adapters"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { Global } from "@deepagent-code/core/global"
import {
  LocationRuntimeHost,
  LocationServiceMap,
  locationServiceMapDependencies,
} from "@deepagent-code/core/location-layer"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { Effect, Layer } from "effect"
import { CodeIntelFacade } from "../../src/code-intelligence/facade"
import { ContextQueryFacade } from "../../src/context-federation/context-query-facade"
import { LocationIndexRuntime } from "../../src/location-index/runtime"
import { InstanceStore } from "../../src/project/instance-store"
import { V2RunnerFrame } from "../../src/session/v2-runner-frame"
import { testInstanceStoreLayer } from "../../test/fixture/fixture"

// A1-06: the live harness used Core's `defaultLocationRuntimeHost`, whose ContextToolRuntime seam is
// the honest-unavailable stub — so V2 live runs could never call the canonical code_intel /
// context_query tools (the ApplicationTools bridge only carries MCP and custom plugin tools, never
// built-ins). Mirror the production runner frame (src/session/v2-runner-frame.ts `runnerFrameHost`):
// capture the host graph facades once and hand every keyed Location tree the real
// `runnerFrameSeamFor` + `runnerFrameContextToolsFor` seams; the remaining seams keep Core's
// bare-host defaults.
// A1-07: the process-local query-authority store is captured with the facades and handed to every
// keyed tree the same way — the runner binds session envelopes inside the tree, the facades resolve
// them at the host graph, and both must observe ONE store or code_intel / context_query answer
// `authorization_unavailable` even after a successful selection admission. The identity seam matters
// for the same reason: the runner builds the envelope principal from the seam's frame, and the code
// query authorizes hits against the index handle's identity — a v2:local envelope against a real
// index answers `scope_denied`.
const host = Layer.effect(
  LocationRuntimeHost,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const runtime = yield* LocationIndexRuntime.Service
    const sources = yield* ProductionV2Sources
    const codeIntel = yield* CodeIntelFacade.Service
    const contextQuery = yield* ContextQueryFacade.Service
    const queryAuthorizationService = yield* ContextQueryAuthorization.Service
    const queryAuthorizationController = yield* ContextQueryAuthorization.Controller
    const buildIdentity = yield* V2ProviderTurn.CurrentBuildIdentity
    const ownerAuthorizationPublicKey = yield* V2ProviderTurn.CurrentOwnerAuthorizationPublicKey
    const dependencies = Layer.mergeAll(
      Layer.succeed(InstanceStore.Service, store),
      Layer.succeed(LocationIndexRuntime.Service, runtime),
      Layer.succeed(CodeIntelFacade.Service, codeIntel),
      Layer.succeed(ContextQueryFacade.Service, contextQuery),
      Layer.succeed(ContextQueryAuthorization.Service, queryAuthorizationService),
      Layer.succeed(ContextQueryAuthorization.Controller, queryAuthorizationController),
    )
    return LocationRuntimeHost.of({
      layer: (ref) =>
        Layer.mergeAll(
          V2RunnerFrame.runnerFrameSeamFor(ref, sources),
          V2RunnerFrame.runnerFrameContextToolsFor(ref),
          Layer.succeed(SessionRunner.CurrentToolSettleGate, undefined),
          Layer.succeed(SessionRunner.CurrentOnSessionSettled, undefined),
          Layer.succeed(V2ProviderTurn.CurrentBuildIdentity, buildIdentity),
          Layer.succeed(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, ownerAuthorizationPublicKey),
          Layer.succeed(ContextQueryAuthorization.Service, queryAuthorizationService),
          Layer.succeed(ContextQueryAuthorization.Controller, queryAuthorizationController),
        ).pipe(Layer.provide(dependencies)),
    })
  }),
)

/**
 * The harness LocationServiceMap: Core's per-location tree with the production context-tool seam.
 * Constructed lazily (a function, not a const) so `Global.Path` resolves after the harness isolation
 * environment is in place; call once per runLegacyLiveCases and share the returned layer object so
 * the memoized build yields ONE map instance for the session runtime and the program.
 */
export function liveLocationServiceMap() {
  return LocationServiceMap.layerNoDeps.pipe(
    Layer.provide([
      ...locationServiceMapDependencies(
        host,
        Database.defaultLayer,
        EventV2.layer.pipe(Layer.provide(Database.defaultLayer)),
        // Same env gate as Core's default map: the harness isolation defaults DEEPAGENT_ENABLED to
        // "false", and suites that assert the managed DeepAgent runtime (round/continuation
        // context, validation harvest) opt in through their environment block.
        AgentGateway.runtimeLayer({
          enabled: process.env.DEEPAGENT_ENABLED !== "false" && process.env.DEEPAGENT_ENABLED !== "0",
          runsDir: Global.Path.agent.runs,
          durableLearning: false,
        }),
      ),
    ]),
    Layer.provide(
      // ContextQueryAuthorization.defaultLayer shares the facades' internal store (same layer
      // object, one memoized build), matching runnerFrameLocationMapLayer in production.
      Layer.mergeAll(CodeIntelFacade.defaultLayer, ContextQueryFacade.defaultLayer, ContextQueryAuthorization.defaultLayer),
    ),
    Layer.provide(LocationIndexRuntime.defaultLayer),
    Layer.provide(testInstanceStoreLayer),
    // The outer seam value the production host captures from the app root. The harness drives no
    // production context adapters, so the base stays empty; `runnerFrameSeamFor` still attaches the
    // REAL per-ref instance identity, which is what the authorization envelope is built from.
    Layer.provide(Layer.succeed(ProductionV2Sources, {})),
  )
}
