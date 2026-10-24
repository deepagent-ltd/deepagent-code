export * as V2RunnerFrame from "./v2-runner-frame"

import path from "node:path"
import { BrowserNativeHost } from "@/browser/native-host"
import { BrowserFiles } from "@/browser/file-exchange"
import { BrowserHost } from "@deepagent-code/core/browser/host"
import { Config } from "@deepagent-code/core/config"
import { LSP } from "@/lsp/lsp"
import { Location } from "@deepagent-code/core/location"
import { Global } from "@deepagent-code/core/global"
import {
  LocationRuntimeHost,
  LocationServiceMap,
  locationServiceMapDependencies,
} from "@deepagent-code/core/location-layer"
import { SessionRuntime } from "@deepagent-code/core/session/runtime"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { SessionCompaction } from "@deepagent-code/core/session/compaction"
import { TaskTool } from "@deepagent-code/core/tool/task"
import { WorkToolPolicy } from "@deepagent-code/core/session/work-tool-policy"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { V2OwnerDevMint } from "@deepagent-code/core/session/runner/v2-owner-dev-mint"
import { V2ToolEffect } from "@deepagent-code/core/session/runner/v2-tool-effect"
import { EventV2 } from "@deepagent-code/core/event"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectV2 } from "@deepagent-code/core/project"
import { V2PlanGate } from "@/session/v2-plan-gate"
import { EventV2Bridge } from "@/event-v2-bridge"
import {
  ProductionV2Sources,
  type ProductionV2AdapterInput,
} from "@deepagent-code/core/context-federation/production-adapters"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { ContextToolRuntime } from "@deepagent-code/core/context-federation/tool-runtime"
import { Effect, Layer, Option } from "effect"
import { CodeQuery } from "@deepagent-code/core/code-intelligence/query"
import { currentIdentity } from "@/context-federation/production-sources"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceLayer } from "@/project/instance-layer"
import { InstanceStore } from "@/project/instance-store"
import { LocationIndexRuntime } from "@/location-index/runtime"
import { CodeIntelFacade } from "@/code-intelligence/facade"
import { ContextQueryFacade } from "@/context-federation/context-query-facade"
import { V2ContextToolRuntime } from "@/context-federation/v2-tool-runtime"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { CompositionDigest } from "@/effect/composition-digest"
import { RuntimeIntegrityIdentity } from "@/effect/runtime-integrity-identity"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { gatewayConfigFromSettings } from "@/deepagent/config"
import { DurableLearningRuntime } from "@/deepagent/learning-runtime"
import { SettingsStore } from "@/settings/store"
import { SlackExternalDelivery } from "@/im/slack-external-delivery"
import { NativeRuntime } from "@/installation/native-runtime"
import { ProductionWorkExecution } from "@/installation/work-execution-profile"
import { EventValidationNative } from "@/installation/event-validation-native"
import { EventInvestigationHost } from "@/deepagent/event-investigation"
import { WorkExecutionProfile } from "@deepagent-code/core/session/work-execution-profile"
import { LLMClient } from "@deepagent-code/llm"

/** Bind automatic graph reads to the actual Location, not the application build fiber. */
export function runnerFrameSeamFor(ref: Location.Ref, base: ProductionV2AdapterInput = {}) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: ref.directory })
      const current = Effect.gen(function* () {
        if ((yield* store.peek(ref.directory)) !== ctx) {
          return yield* Effect.fail(
            new CodeQuery.InvalidQueryError({ reason: "location instance is no longer current" }),
          )
        }
      })
      const scoped = <A, E>(operation: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          yield* current
          const result = yield* operation
          // Disposal can happen while a live source query awaits its index or database.
          yield* current
          return result
        }).pipe(Effect.provideService(InstanceRef, ctx))
      const identity = yield* scoped(currentIdentity(yield* LocationIndexRuntime.Service)).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      const gateway = yield* Effect.serviceOption(AgentGateway.Runtime)
      // The immutable Gateway owns these stores. The application-level seam may have been built
      // before it, or while a different legacy/default knowledge runtime was configured.
      const stores = Option.isSome(gateway)
        ? gateway.value.withStorage(() => AgentGateway.DeepAgentKnowledgeSource.storesForWorkspace(ref.directory))
        : undefined
      return Layer.succeed(ProductionV2Sources, {
        ...(identity === undefined ? {} : { identity }),
        code:
          base.code === undefined
            ? undefined
            : {
                query: (input) => scoped(Effect.suspend(() => base.code!.query(input))),
              },
        documents:
          base.documents === undefined
            ? undefined
            : {
                search: (input) => scoped(Effect.suspend(() => base.documents!.search(input))),
                ...(base.documents.mutationEpoch === undefined
                  ? {}
                  : {
                      mutationEpoch: () => scoped(Effect.suspend(() => base.documents!.mutationEpoch!())),
                    }),
              },
        knowledge:
          stores === undefined
            ? undefined
            : {
                stores,
                ...(base.knowledge?.released === undefined
                  ? {}
                  : {
                      released: {
                        ...base.knowledge.released,
                        current: (scope) => scoped(Effect.suspend(() => base.knowledge!.released!.current(scope))),
                      },
                    }),
              },
      })
    }),
  )
}

/** Captures the same ref-owned Instance context around every explicit context-tool query. */
export function runnerFrameContextToolsFor(ref: Location.Ref) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const ctx = yield* (yield* InstanceStore.Service).load({ directory: ref.directory })
      const handle = yield* (yield* LocationIndexRuntime.Service)
        .current()
        .pipe(Effect.provideService(InstanceRef, ctx))
      if (handle === undefined) return ContextToolRuntime.unavailableLayer
      return V2ContextToolRuntime.layer(ctx)
    }),
  )
}

// The application bridge must be the one EventV2 authority observed by Session admission,
// execution lifecycle, projection, outbox landing, and every keyed Location service.
const eventLayer = Layer.effect(
  EventV2.Service,
  Effect.map(EventV2Bridge.Service, (events) => EventV2.Service.of(events)),
)

/**
 * The host service is captured once by the Location map and supplies a self-contained seam layer
 * for every keyed tree. Unlike an outer `Layer.provide` around an already-closed location layer,
 * this boundary is constructed inside the keyed tree and therefore cannot be shadowed by Core's
 * bare-host defaults.
 */
const runnerFrameHost = Layer.effect(
  LocationRuntimeHost,
  Effect.gen(function* () {
    // The dev authorization row and its root-owned keypair must exist before the references below
    // are captured for the cached Location map. This dependency makes layer construction ordered.
    yield* V2OwnerDevMint.Service
    // Capture the installed implementation before admitting its configuration in cached Locations.
    yield* LSP.Service
    const sources = yield* ProductionV2Sources
    const gateway = yield* AgentGateway.Runtime
    const store = yield* InstanceStore.Service
    const runtime = yield* LocationIndexRuntime.Service
    const codeIntel = yield* CodeIntelFacade.Service
    const contextQuery = yield* ContextQueryFacade.Service
    // The process-local query-authority store. Captured HERE so every keyed Location tree binds
    // session envelopes into the very store the captured facades resolve from (the memoized
    // shared build of ContextQueryAuthorization.defaultLayer in runnerFrameLocationMapLayer).
    // A tree-private store would make every runner bind invisible to the facades and
    // code_intel / context_query would always answer `authorization_unavailable`.
    const queryAuthorizationService = yield* ContextQueryAuthorization.Service
    const queryAuthorizationController = yield* ContextQueryAuthorization.Controller
    const onSessionSettled = yield* SessionRunner.CurrentOnSessionSettled
    const flags = yield* RuntimeFlags.Service
    const parityCampaign = yield* V2ProviderTurn.CurrentCampaign
    const ownerCampaign = yield* V2ProviderTurn.CurrentOwnerCampaign
    const buildIdentity = yield* V2ProviderTurn.CurrentBuildIdentity
    const ownerAuthorizationPublicKey = yield* V2ProviderTurn.CurrentOwnerAuthorizationPublicKey
    const historyEpochLookup = yield* V2ProviderTurn.CurrentHistoryEpochLookup
    const permissionGrantLookup = yield* V2ToolEffect.CurrentPermissionGrantLookup
    const remoteCompaction = yield* SessionCompaction.CurrentRemoteCompaction
    // RI-24: Location-scoped drain fibers cannot see the root owner services, so the identity
    // resolver they receive reads the per-root slot filled from the route graph's context (see
    // RuntimeIntegrityIdentity.captureRootContextLayer); the resolver stays context-independent.
    const identitySlot = yield* RuntimeIntegrityIdentity.RootIdentitySlot
    const dependencies = Layer.mergeAll(
      Layer.succeed(AgentGateway.Runtime, gateway),
      Layer.succeed(InstanceStore.Service, store),
      Layer.succeed(LocationIndexRuntime.Service, runtime),
      Layer.succeed(CodeIntelFacade.Service, codeIntel),
      Layer.succeed(ContextQueryFacade.Service, contextQuery),
      Layer.succeed(ContextQueryAuthorization.Service, queryAuthorizationService),
      Layer.succeed(ContextQueryAuthorization.Controller, queryAuthorizationController),
    )
    return LocationRuntimeHost.of({
      client: yield* LLMClient.Service,
      work: yield* ProductionWorkExecution.Service,
      browser: yield* BrowserHost.Current,
      layer: (ref) =>
        Layer.mergeAll(
          runnerFrameSeamFor(ref, sources),
          Layer.succeed(Config.ApplicationLSP, { consumer: "ApplicationLSP" }),
          runnerFrameContextToolsFor(ref),
          SlackExternalDelivery.layer,
          V2PlanGate.layer.pipe(Layer.provide(Layer.succeed(RuntimeFlags.Service, flags))),
          Layer.succeed(SessionRunner.CurrentOnSessionSettled, onSessionSettled),
          Layer.succeed(V2ProviderTurn.CurrentCampaign, parityCampaign),
          Layer.succeed(V2ProviderTurn.CurrentOwnerCampaign, ownerCampaign),
          Layer.succeed(V2ProviderTurn.CurrentBuildIdentity, buildIdentity),
          Layer.succeed(
            V2ProviderTurn.CurrentRuntimeIntegrityIdentity,
            RuntimeIntegrityIdentity.slotResolver(identitySlot),
          ),
          Layer.succeed(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, ownerAuthorizationPublicKey),
          Layer.succeed(V2ProviderTurn.CurrentHistoryEpochLookup, historyEpochLookup),
          Layer.succeed(V2ToolEffect.CurrentPermissionGrantLookup, permissionGrantLookup),
          Layer.succeed(SessionCompaction.CurrentRemoteCompaction, remoteCompaction),
          Layer.succeed(ContextQueryAuthorization.Service, queryAuthorizationService),
          Layer.succeed(ContextQueryAuthorization.Controller, queryAuthorizationController),
        ).pipe(Layer.provide(dependencies)),
    })
  }),
)

/**
 * RI-36/RI-39/RI-44 — this frame's composition identity, provided into every root that composes
 * `sessionRuntimeLayer` so the composition digest can tell an augmented production frame apart
 * from the core default host (whose roots fall back to the unqualified `FrameIdentity` default).
 * `sessionOwner` mirrors the core graph `SessionRuntime.layer` builds (SessionExecutionLocal over
 * the process-local SessionRunCoordinator); `locationHost.seams` mirrors the per-ref mergeAll in
 * `runnerFrameHost` above — keep both lists in sync with the layers they describe.
 */
export const frameIdentity: CompositionDigest.FrameIdentityShape = {
  sessionOwner: {
    execution: "core/session/execution/local:SessionExecutionLocal",
    placement: "process-local:session-id",
    coordination: "core/session/run-coordinator:SessionRunCoordinator",
  },
  locationHost: {
    host: "deepagent-code/session/v2-runner-frame:runnerFrameHost",
    idleTimeToLive: "60 minutes",
    seams: [
      "core/ContextToolRuntime:instance-scoped",
      "core/ProductionV2Sources:instance-identity",
      "core/IMExternalDelivery:slack-channel",
      "core/ContextQueryAuthorization:process-local-store",
      "core/SessionCompaction.CurrentRemoteCompaction",
      "core/SessionRunner.CurrentOnSessionSettled",
      "core/V2ProviderTurn.CurrentBuildIdentity",
      "core/V2ProviderTurn.CurrentRuntimeIntegrityIdentity",
      "core/V2ProviderTurn.CurrentCampaign",
      "core/V2ProviderTurn.CurrentHistoryEpochLookup",
      "core/V2ProviderTurn.CurrentOwnerAuthorizationPublicKey",
      "core/V2ProviderTurn.CurrentOwnerCampaign",
      "core/V2ToolEffect.CurrentPermissionGrantLookup",
      "deepagent-code/V2PlanGate",
      "deepagent-code/V2McpBridge:enabled",
      "deepagent-code/V2PluginToolsBridge:enabled",
    ],
  },
}

/**
 * RI-123: app-level owner-qualification references for REQUEST fibers. SessionPrompt's call-time
 * `ownerQualified` checks resolve CurrentBuildIdentity / CurrentOwnerAuthorizationPublicKey from
 * the request fiber's context, which never enters the per-location runner subtree — without this
 * layer at the graph root they fall to the Reference defaults (env or the pinned production key),
 * so a dev install that minted its own state-dir keypair still failed `v2_owner_unavailable`.
 * The mint is provided INSIDE this layer, so on a fresh state dir the keypair exists before
 * `ownerReferencesLayer` reads it (layer construction order, not wall-clock).
 */
export const ownerQualificationReferencesLayer = V2ProviderTurn.ownerReferencesLayer.pipe(
  Layer.provide(Global.defaultLayer),
  Layer.provide(V2OwnerDevMint.defaultLayer),
)

/** Capture first-party settings once for the open V2 production root. Per-request app config
 * refreshes can no longer rewrite an already-running Location's gateway policy. */
export const gatewayRuntimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const settings = yield* SettingsStore.readEffect.pipe(Effect.orDie)
    const config = gatewayConfigFromSettings(settings.deepagent)
    // RI-90 transition pin: the goal path (GoalManager, plan bridge, status publisher) and the core
    // `plan` tool still use the module-level plan-store/session-state fallback (RI-71 removes it).
    // Under the V2-only profile nothing else configures that fallback — the captured V2 storage
    // runtime is AsyncLocalStorage-scoped — so a scriptable goal died on "plan-store: no runtime
    // state dir". Pin the fallback to the SAME state dir this runtime captures. One production
    // process builds this layer once with one baseDir, so the pin is idempotent.
    yield* Effect.sync(() =>
      AgentGateway.DeepAgentSessionState.configure(path.join(config.baseDir ?? Global.Path.agent.data, "state")),
    )
    return AgentGateway.runtimeLayer(config, {
      learningAuthority: DurableLearningRuntime.learningAuthority(database),
    })
  }),
).pipe(Layer.provide(Database.defaultLayer))

const nativeClientLayer = NativeRuntime.clientLayer.pipe(Layer.provide(gatewayRuntimeLayer))
const nativeRuntimeLayer = NativeRuntime.layer.pipe(Layer.provide(nativeClientLayer))
// HTTP user-input admission and Location tools must observe this same bootstrapped
// host. Providing it only inside BrowserFiles hides the authority from request fibers.
export const nativeBrowserHostLayer = Layer.effect(BrowserHost.Current, Effect.sync(BrowserNativeHost.current))
// This exact layer object is shared with the API. Construction observes only the
// bootstrap host and database; installed file assets and consent remain lazy.
export const browserFilesLayer = BrowserFiles.layer.pipe(
  Layer.provide(nativeBrowserHostLayer),
  Layer.provide(Database.defaultLayer),
)
const workRuntimeLayer = ProductionWorkExecution.layer.pipe(
  Layer.provide(browserFilesLayer),
  Layer.provide(nativeRuntimeLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(Global.defaultLayer),
)
const workServicesLayer = Layer.unwrap(Effect.map(ProductionWorkExecution.Service, WorkExecutionProfile.servicesLayer)).pipe(Layer.provide(workRuntimeLayer))

export const runnerFrameHostLayer = runnerFrameHost.pipe(
  Layer.provide(nativeBrowserHostLayer),
  Layer.provide(workRuntimeLayer),
  Layer.provide(LSP.defaultLayer),
  Layer.provide(nativeClientLayer),
  Layer.provide(V2OwnerDevMint.defaultLayer),
  // Same memoized slot as sessionRuntimeLayer; the explicit client is also shared with the
  // native factory rather than taken from a later Location acquisition fiber.
  Layer.provide(RuntimeIntegrityIdentity.rootIdentitySlotLayer),
)

/**
 * W3.10 — self-contained wiring layer: the augmented map plus its instance-context dependencies, so
 * a host can provide ONE layer to the open Session runtime. The production sources are an explicit
 * requirement and are captured when this map is built, so later drain fibers cannot lose them.
 */
export const runnerFrameLocationMapLayer = LocationServiceMap.layerNoDeps.pipe(
  Layer.provide([
    ...locationServiceMapDependencies(
      runnerFrameHostLayer,
      Database.defaultLayer,
      eventLayer,
      gatewayRuntimeLayer,
      NativeRuntime.clientLayer,
    ),
  ]),
  // ContextQueryAuthorization.defaultLayer is the ONE process-local authority store for the whole
  // frame: the same layer object feeds the facades' internal requirements and the host capture
  // (one memoized build), so runner binds and facade resolves can never diverge.
  Layer.provide(
    Layer.mergeAll(
      CodeIntelFacade.defaultLayer,
      ContextQueryFacade.defaultLayer,
      ContextQueryAuthorization.defaultLayer,
    ),
  ),
  Layer.provide(LocationIndexRuntime.defaultLayer),
  Layer.provide(InstanceLayer.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

const coreSessionRuntime = SessionRuntime.layer.pipe(
  Layer.provide(workServicesLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(eventLayer),
  Layer.provide(runnerFrameLocationMapLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.provide(TaskTool.delegationSlotLayer),
)

// Bind the existing executor before the investigation adapter captures its Root.
// The same layer objects share one memoized DB, Work service and Session owner.
const captureWorkExecutionLayer = Layer.effectDiscard(Effect.gen(function* () {
  const work = yield* ProductionWorkExecution.Service
  const execution = yield* SessionExecution.Service
  yield* work.captureExecution(execution)
  const locations = yield* LocationServiceMap
  yield* work.captureEventLocations(locations)
  // Reuse this Root's one boot reclamation convention. Collection has no timer/runner and
  // cannot delay startup; its held resources end with this exact original Root scope.
  if (work.eventPlacement && work.leafProof) yield* work.eventPlacement.collectStale.pipe(
    Effect.provideService(WorkToolPolicy.LeafProof, work.leafProof), Effect.catch(() => Effect.void), Effect.forkScoped)
})).pipe(
  Layer.provide(workRuntimeLayer),
  Layer.provide(coreSessionRuntime),
  Layer.provide(runnerFrameLocationMapLayer),
)
const eventInvestigationHostLayer = EventInvestigationHost.layer.pipe(
  Layer.provide([workRuntimeLayer, coreSessionRuntime, EventValidationNative.layer, Database.defaultLayer, EventV2Bridge.defaultLayer]),
  Layer.provide(captureWorkExecutionLayer),
  Layer.provide(Global.defaultLayer),
)

// Goal/checkpoint reads run at the root after a Location drain has settled. They must resolve
// the same captured root identity as the drain, never trust a receipt's self-reported identity.
export const runtimeIntegrityIdentityLayer = Layer.effect(
  V2ProviderTurn.CurrentRuntimeIntegrityIdentity,
  Effect.map(RuntimeIntegrityIdentity.RootIdentitySlot, RuntimeIntegrityIdentity.slotResolver),
).pipe(Layer.provide(RuntimeIntegrityIdentity.rootIdentitySlotLayer))

/** One application V2 runtime: one DB, event bridge, execution owner, restart owner, and Location map. */
export const sessionRuntimeLayer = Layer.mergeAll(
  nativeBrowserHostLayer,
  nativeRuntimeLayer,
  workRuntimeLayer,
  workServicesLayer,
  coreSessionRuntime,
  runnerFrameLocationMapLayer,
  eventInvestigationHostLayer,
  Layer.succeed(CompositionDigest.FrameIdentity, frameIdentity),
  RuntimeIntegrityIdentity.rootIdentitySlotLayer,
  runtimeIntegrityIdentityLayer,
  // Same memoized slot instance the execution layer carries; same memoized SessionV2 build as
  // coreSessionRuntime — the capture wires holder to service once per root.
  TaskTool.captureDelegationServiceLayer.pipe(
    Layer.provide(TaskTool.delegationSlotLayer),
    Layer.provide(coreSessionRuntime),
  ),
  captureWorkExecutionLayer,
).pipe(Layer.provide(EventV2Bridge.defaultLayer))
