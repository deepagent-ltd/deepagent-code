export * as RuntimeIntegrityIdentity from "./runtime-integrity-identity"

import { Context, Effect, Layer } from "effect"
import { EventV2 } from "@deepagent-code/core/event"
import { RuntimeIntegrityEvidenceContract } from "@deepagent-code/core/contract/runtime-integrity-evidence"
import { ContractDigest } from "@deepagent-code/core/contract/digest"
import { capabilityCatalogDigestValue } from "@deepagent-code/core/system-context/capability-catalog"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionRestart } from "@deepagent-code/core/session/execution/restart"
import { SessionRuntimeStatus } from "@deepagent-code/core/session/runtime-status"
import { SessionStore } from "@deepagent-code/core/session/store"
import { LocationServiceMap } from "@deepagent-code/core/location-layer"
import { Database } from "@deepagent-code/core/database/database"
import { ToolRegistry } from "@/tool/registry"
import { InstanceStore } from "@/project/instance-store"
import { CompositionDigest } from "./composition-digest"

type RuntimeIdentityContext =
  | Database.Service
  | ToolRegistry.Service
  | InstanceStore.Service
  | SessionV2.Service
  | SessionExecution.Service
  | SessionRestart.Service
  | SessionRuntimeStatus.Service
  | SessionStore.Service
  | LocationServiceMap

/**
 * Derive the runtime identity used by RI-24 from the root that is actually executing the effect.
 * No process-global path or package lookup is consulted: the build identity comes from the
 * root-scoped V2 reference, the composition digest resolves live owner/database/location/tool
 * services, and schema facets are calculated from the registries loaded by this package.
 *
 * This is deliberately an explicit effect rather than a module-level value. A caller that runs it
 * against a maintenance/incident root receives the same missing-service failure as the composition
 * oracle, instead of producing evidence that accidentally belongs to another root.
 */
export const current = Effect.gen(function* () {
  const buildIdentity = yield* V2ProviderTurn.CurrentBuildIdentity
  if (buildIdentity === undefined)
    return yield* new RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError({
      reason: "runtime_build_identity_unavailable",
    })
  const composition = yield* CompositionDigest.current
  const eventSchemaDigest = ContractDigest.contentDigest(
    EventV2.definitions().map((definition) => ({
      type: definition.type,
      sync: definition.sync,
      // Schema AST nodes carry parser functions in annotations. Canonicalize those functions to
      // their source text before hashing so the event registry digest captures schema drift while
      // remaining JSON-addressable (and never attempts to encode a function value directly).
      schema: JSON.stringify(definition.data.ast, (_key, value) =>
        typeof value === "function" ? value.toString() : value,
      ),
    })),
  )
  const capabilityManifestDigest = capabilityCatalogDigestValue.slice("sha256:".length)
  return RuntimeIntegrityEvidenceContract.RuntimeIdentity.make({
    candidateID: `candidate:${buildIdentity.buildID}`,
    commit: buildIdentity.subjectCommit,
    tree: buildIdentity.subjectTree,
    packageDigest: buildIdentity.packageDigest,
    schemaDigest: buildIdentity.schemaDigest,
    rootCompositionDigest: composition.digest,
    databaseSchemaDigest: composition.database.migrationRegistryDigest,
    eventSchemaDigest,
    capabilityManifestDigest,
  })
})

/**
 * Adapt the root-context-dependent derivation to callers whose fiber context IS the full root
 * graph (AppRuntime direct calls, root-context tests). Production drain fibers must NOT use this:
 * Location-scoped fibers structurally cannot see the five V2 owner services (RI-34 keyed-tree
 * rule), so the frame provides the slot-backed resolver below instead.
 */
export const resolver: V2ProviderTurn.RuntimeIntegrityIdentityResolver = {
  resolve: (context) =>
    // The opaque Core seam intentionally erases the graph's concrete service union; keep the cast
    // at this one adapter boundary rather than leaking DeepAgentCode dependencies into Core's
    // runner types.
    (current.pipe(Effect.provideContext(context as Context.Context<RuntimeIdentityContext>)) as unknown) as Effect.Effect<
      RuntimeIntegrityEvidenceContract.RuntimeIdentity,
      RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError
    >,
}

/** Per-root holder: the root context captured at graph build plus the derived identity. */
export interface RootIdentitySlotService {
  identity?: RuntimeIntegrityEvidenceContract.RuntimeIdentity
  context?: Context.Context<never>
  derivation?: Promise<RuntimeIntegrityEvidenceContract.RuntimeIdentity>
}
export class RootIdentitySlot extends Context.Service<RootIdentitySlot, RootIdentitySlotService>()(
  "deepagent-code/RuntimeIntegrityIdentityRootSlot",
) {}

/**
 * One holder per root build: layer memoization scopes the built service instance to the root's
 * memoMap, so two roots never share a slot. The Location map's host captures the slot object when
 * the map builds; the route graph stores the root context in it; drain fibers of any provenance
 * read the derived identity without needing owner services in their own context.
 */
export const rootIdentitySlotLayer = Layer.effect(RootIdentitySlot, Effect.sync(() => ({})))

/**
 * Capture the root's service context at route-graph build. No service builds are forced and no
 * derivation runs here — the context snapshot is side-effect free, and the identity derives on
 * first drain use (detached) so graph construction never waits on instance-scoped work.
 */
export const captureRootContextLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const slot = yield* RootIdentitySlot
    slot.context = yield* Effect.context<never>()
  }),
)

const startDerivation = (slot: RootIdentitySlotService) => {
  if (slot.derivation !== undefined || slot.identity !== undefined || slot.context === undefined) return
  const derived = current.pipe(
    Effect.provideContext(slot.context as Context.Context<RuntimeIdentityContext>),
  ) as unknown as Effect.Effect<
    RuntimeIntegrityEvidenceContract.RuntimeIdentity,
    RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError
  >
  // Detached on purpose: the derivation runs `CompositionDigest.current`, which boots the
  // canonical process-cwd instance; running that on a drain fiber would execute instance-scoped
  // work under the session flow's fiber, so it runs on its own runtime instead.
  slot.derivation = Effect.runPromise(derived)
}

/**
 * Slot-backed resolver for the production runner frame. Root-captured and context-independent:
 * drain fibers await the identity derived (once per root, deterministically) from the captured
 * root context. Before the route graph captured a context the resolver fails typed rather than
 * fabricating an identity.
 */
export const slotResolver = (slot: RootIdentitySlotService): V2ProviderTurn.RuntimeIntegrityIdentityResolver => ({
  resolve: () =>
    Effect.suspend(() => {
      if (slot.identity !== undefined) return Effect.succeed(slot.identity)
      if (slot.context === undefined)
        return Effect.fail(
          new RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError({
            reason: "runtime_identity_not_captured",
          }),
        )
      startDerivation(slot)
      return Effect.promise(() => slot.derivation!).pipe(
        Effect.map((identity) => (slot.identity = identity)),
      )
    }),
})
