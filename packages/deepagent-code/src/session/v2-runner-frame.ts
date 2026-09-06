export * as V2RunnerFrame from "./v2-runner-frame"

import { Location } from "@deepagent-code/core/location"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { V2PlanGate } from "@/session/v2-plan-gate"
import {
  ProductionV2Sources,
  type ProductionV2AdapterInput,
} from "@deepagent-code/core/context-federation/production-adapters"
import { Context, Effect, Layer, LayerMap, Option } from "effect"
import { currentIdentity } from "@/context-federation/production-sources"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceLayer } from "@/project/instance-layer"
import { InstanceStore } from "@/project/instance-store"
import { LocationIndexRuntime } from "@/location-index/runtime"
import { CodeIntelFacade } from "@/code-intelligence/facade"
import { ContextQueryFacade } from "@/context-federation/context-query-facade"
import { V2ContextToolRuntime } from "@/context-federation/v2-tool-runtime"

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
export function runnerFrameSeamFor(ref: Location.Ref) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: ref.directory })
      const base = yield* Effect.serviceOption(ProductionV2Sources).pipe(
        Effect.map((option) => Option.getOrElse(option, () => ({} as ProductionV2AdapterInput))),
      )
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
      return V2ContextToolRuntime.layer(ctx)
    }),
  )
}

/**
 * W3.10 — the augmented `LocationServiceMap`: the core per-location runner tree plus the host-hook
 * override, so every V2 runner subtree observes a REAL frame identity (per instance ref). The base
 * map is built from the core `LocationServiceMap.layer` (its class dependencies memoize under the
 * same memoMap — no split-brain with the graph's own singletons).
 *
 * Requirements: `LocationIndexRuntime` and `InstanceStore` (the graph roots provide them; wiring
 * sites may self-provide, see `runnerFrameLocationMapLayer` below).
 */
export const runnerFrameLocationMap = Layer.effect(
  LocationServiceMap,
  Effect.gen(function* () {
    // The core map's per-location tree is built INSIDE this layer (its class dependencies are
    // module-const layers that memoize under the shared memoMap, so the graph's singletons — DB,
    // SessionStore, Project — stay the same objects; no split-brain, no graph-level requirement).
    const baseMap = yield* Layer.build(LocationServiceMap.layer).pipe(
      Effect.map((built) => Context.get(built, LocationServiceMap)),
    )
    return yield* LayerMap.make(
      (ref: Location.Ref) =>
        baseMap.get(ref).pipe(
          Layer.provide(runnerFrameSeamFor(ref)),
          Layer.provide(runnerFrameContextToolsFor(ref)),
          // W2-V2: the plan gate must be provided to the LOCATION TREE itself — the core runner
          // layer inside it resolves CurrentToolSettleGate through the seam (an outer provide on
          // the sources layer is silently discarded, a plain tree provide reaches the runner).
          Layer.provide(V2PlanGate.defaultLayer),
        ),
      { idleTimeToLive: "60 minutes" },
    ).pipe(Effect.map((map) => LocationServiceMap.of(map)))
  }),
)

/**
 * W3.10 — self-contained wiring layer: the augmented map plus its instance-context dependencies, so
 * a host can provide ONE layer at the app/route graph boundary (LAST-WINS over the
 * `SessionExecutionLocal.liveLayer` internal `LocationServiceMap.layer`). The memoized singletons are
 * shared with the graph (same memoMap), so the runner's index handle / instance store / DB are the
 * same objects the probe and the HTTP handlers use.
 */
export const runnerFrameLocationMapLayer = runnerFrameLocationMap.pipe(
  Layer.provide(Layer.mergeAll(CodeIntelFacade.defaultLayer, ContextQueryFacade.defaultLayer)),
  Layer.provide(LocationIndexRuntime.defaultLayer),
  Layer.provide(InstanceLayer.layer),
)
