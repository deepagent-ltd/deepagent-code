import { AgentGateway } from "@deepagent-code/core/agent-gateway"
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
// `runnerFrameContextToolsFor` seam; the remaining seams keep Core's bare-host defaults.
const host = Layer.effect(
  LocationRuntimeHost,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const runtime = yield* LocationIndexRuntime.Service
    const codeIntel = yield* CodeIntelFacade.Service
    const contextQuery = yield* ContextQueryFacade.Service
    const buildIdentity = yield* V2ProviderTurn.CurrentBuildIdentity
    const ownerAuthorizationPublicKey = yield* V2ProviderTurn.CurrentOwnerAuthorizationPublicKey
    const dependencies = Layer.mergeAll(
      Layer.succeed(InstanceStore.Service, store),
      Layer.succeed(LocationIndexRuntime.Service, runtime),
      Layer.succeed(CodeIntelFacade.Service, codeIntel),
      Layer.succeed(ContextQueryFacade.Service, contextQuery),
    )
    return LocationRuntimeHost.of({
      layer: (ref) =>
        Layer.mergeAll(
          Layer.succeed(ProductionV2Sources, {}),
          V2RunnerFrame.runnerFrameContextToolsFor(ref),
          Layer.succeed(SessionRunner.CurrentToolSettleGate, undefined),
          Layer.succeed(SessionRunner.CurrentOnSessionSettled, undefined),
          Layer.succeed(V2ProviderTurn.CurrentBuildIdentity, buildIdentity),
          Layer.succeed(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, ownerAuthorizationPublicKey),
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
        AgentGateway.runtimeLayer({ enabled: false, runsDir: Global.Path.agent.runs, durableLearning: false }),
      ),
    ]),
    Layer.provide(Layer.mergeAll(CodeIntelFacade.defaultLayer, ContextQueryFacade.defaultLayer)),
    Layer.provide(LocationIndexRuntime.defaultLayer),
    Layer.provide(testInstanceStoreLayer),
  )
}
