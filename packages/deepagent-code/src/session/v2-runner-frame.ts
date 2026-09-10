export * as V2RunnerFrame from "./v2-runner-frame"

import path from "node:path"
import { Location } from "@deepagent-code/core/location"
import { Global } from "@deepagent-code/core/global"
import {
  LocationRuntimeHost,
  LocationServiceMap,
  locationServiceMapDependencies,
} from "@deepagent-code/core/location-layer"
import { SessionRuntime } from "@deepagent-code/core/session/runtime"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { SessionCompaction } from "@deepagent-code/core/session/compaction"
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
import { ContextToolRuntime } from "@deepagent-code/core/context-federation/tool-runtime"
import { Effect, Layer } from "effect"
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

// W3.10 — the V2 runner frame host hook (closes B-review P0 / O-W3-10).
//
// The problem: `ProductionV2Sources` (the W3.7 value seam) is built at the APP level where no
// `InstanceRef` exists, so the seam value carries NO identity (W3.8.1 claimed a real runner frame;
// W3.9 proved the identity was never attached — the layer-build `LocationIndexRuntime` attach died
// on "InstanceRef not provided" and the seam lost the field). The C6 readiness probe resolves the
// identity ON DEMAND per request (it runs in an instance-context request fiber), so probe and
// runner disagreed: probe = real frame, runner = `v2:local` → code graph `source_error`.
//
// The fix: a host hook INSIDE the runner's per-location subtree. The V2 runner subtree is composed
// by the core `LocationServiceMap.lookup` per location ref (60-min TTL, `Layer.fresh` per drain
// provide — see `packages/core/src/location-layer.ts` and `session/execution/local.ts` drain
// `Effect.provide(locations.get(session.location))`). deepagent-code replaces the `LocationServiceMap`
// service (LAST-WINS provide at the app/route graph, the same context-flow mechanism as the W3.7
// seam) with an AUGMENTED map whose per-ref layer:
//
//   1. loads the instance context for the ref's directory (`InstanceStore.load` — the same
//      derivation the httpapi instance-context middleware uses) and provides `InstanceRef` into the
//      ref tree, so `LocationIndexRuntime.current()` is VALID inside the subtree;
//   2. overrides `ProductionV2Sources` with `{ ...outerSeamValue, identity }` where identity is
//      `currentIdentity(runtime)` — the SAME derivation the probe uses (`identityFromHandle` of the
//      CURRENT instance handle), so runner frame and probe frame can never diverge again.
//
// Honesty contract: a missing/erroneous instance (store load failure, no handle, index flag off)
// yields `identity: undefined` — the documented `v2:local` degradation frame, never a fake. The
// outer seam value (code/documents/knowledge/memory) is passed through unchanged.
//
// Composition-point verdict: the runner layer is NOT a per-turn rebuild and NOT deepagent-code
// composed — it is the core per-location-ref tree (memoized 60 min). Hooking the per-ref build is
// therefore INSTANCE-LEVEL: the identity binds the same instance the index handle binds (the
// `LocationIndexRuntime` instance `ScopedCache` is keyed by instance directory), and a per-turn
// re-resolution adds nothing — the handle is already per-instance. This is the verdict the review
// accepted ("instance-level real frame, per-turn unnecessary, report the ruling").

/**
 * W3.10 — host hook layer factory for one location ref. Returns a `ProductionV2Sources` override:
 * the outer seam value (forwarded by the core `productionV2SourcesLayer`) plus the REAL identity of
 * the CURRENT instance handle for the ref's directory. `undefined` identity (no handle / store
 * failure) keeps the seam as-is (honest `v2:local` degradation).
 */
export function runnerFrameSeamFor(ref: Location.Ref, base: ProductionV2AdapterInput = {}) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: ref.directory })
      // The instance context is local to this probe: provide it around the identity resolution so
      // `LocationIndexRuntime.current()` observes the SAME instance the ref tree is built for
      // (and never depends on an ambient InstanceRef the drain fiber cannot carry).
      const identity = yield* currentIdentity(yield* LocationIndexRuntime.Service).pipe(
        Effect.provideService(InstanceRef, ctx),
      )
      return Layer.succeed(ProductionV2Sources, identity === undefined ? base : { ...base, identity })
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
    const sources = yield* ProductionV2Sources
    const store = yield* InstanceStore.Service
    const runtime = yield* LocationIndexRuntime.Service
    const codeIntel = yield* CodeIntelFacade.Service
    const contextQuery = yield* ContextQueryFacade.Service
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
      Layer.succeed(InstanceStore.Service, store),
      Layer.succeed(LocationIndexRuntime.Service, runtime),
      Layer.succeed(CodeIntelFacade.Service, codeIntel),
      Layer.succeed(ContextQueryFacade.Service, contextQuery),
    )
    return LocationRuntimeHost.of({
      layer: (ref) =>
        Layer.mergeAll(
          runnerFrameSeamFor(ref, sources),
          runnerFrameContextToolsFor(ref),
          V2PlanGate.layer.pipe(Layer.provide(Layer.succeed(RuntimeFlags.Service, flags))),
          Layer.succeed(SessionRunner.CurrentOnSessionSettled, onSessionSettled),
          Layer.succeed(V2ProviderTurn.CurrentCampaign, parityCampaign),
          Layer.succeed(V2ProviderTurn.CurrentOwnerCampaign, ownerCampaign),
          Layer.succeed(V2ProviderTurn.CurrentBuildIdentity, buildIdentity),
          Layer.succeed(V2ProviderTurn.CurrentRuntimeIntegrityIdentity, RuntimeIntegrityIdentity.slotResolver(identitySlot)),
          Layer.succeed(V2ProviderTurn.CurrentOwnerAuthorizationPublicKey, ownerAuthorizationPublicKey),
          Layer.succeed(V2ProviderTurn.CurrentHistoryEpochLookup, historyEpochLookup),
          Layer.succeed(V2ToolEffect.CurrentPermissionGrantLookup, permissionGrantLookup),
          Layer.succeed(SessionCompaction.CurrentRemoteCompaction, remoteCompaction),
        ).pipe(Layer.provide(dependencies)),
    })
  }),
)

export const runnerFrameHostLayer = runnerFrameHost.pipe(
  Layer.provide(V2OwnerDevMint.defaultLayer),
  // Same layer object as sessionRuntimeLayer's mergeAll entry: one memoMap = one shared slot
  // instance per root, so the host hands drain fibers the very slot the route graph fills.
  Layer.provide(RuntimeIntegrityIdentity.rootIdentitySlotLayer),
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
    const settings = yield* Effect.promise(SettingsStore.read)
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

/**
 * W3.10 — self-contained wiring layer: the augmented map plus its instance-context dependencies, so
 * a host can provide ONE layer to the open Session runtime. The production sources are an explicit
 * requirement and are captured when this map is built, so later drain fibers cannot lose them.
 */
export const runnerFrameLocationMapLayer = LocationServiceMap.layerNoDeps.pipe(
  Layer.provide([
    ...locationServiceMapDependencies(runnerFrameHostLayer, Database.defaultLayer, eventLayer, gatewayRuntimeLayer),
  ]),
  Layer.provide(Layer.mergeAll(CodeIntelFacade.defaultLayer, ContextQueryFacade.defaultLayer)),
  Layer.provide(LocationIndexRuntime.defaultLayer),
  Layer.provide(InstanceLayer.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

const coreSessionRuntime = SessionRuntime.layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(eventLayer),
  Layer.provide(runnerFrameLocationMapLayer),
  Layer.provide(ProjectV2.defaultLayer),
)

/** One application V2 runtime: one DB, event bridge, execution owner, restart owner, and Location map. */
export const sessionRuntimeLayer = Layer.mergeAll(
  coreSessionRuntime,
  runnerFrameLocationMapLayer,
  Layer.succeed(CompositionDigest.FrameIdentity, frameIdentity),
  RuntimeIntegrityIdentity.rootIdentitySlotLayer,
).pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
)
