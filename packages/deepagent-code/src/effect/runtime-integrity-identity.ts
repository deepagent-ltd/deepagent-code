export * as RuntimeIntegrityIdentity from "./runtime-integrity-identity"

import { Context, Effect } from "effect"
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
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
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

/** Adapt the root-context-dependent resolver to Core's context-preserving seam. */
export const resolver: V2ProviderTurn.RuntimeIntegrityIdentityResolver = {
  resolve: (context) =>
    // The resolver is called from a live runner fiber whose context includes the complete root
    // graph. The opaque Core seam intentionally erases that graph's concrete service union; keep
    // the cast at this one adapter boundary rather than leaking DeepAgentCode dependencies into
    // Core's runner types.
    (current.pipe(Effect.provideContext(context as Context.Context<RuntimeIdentityContext>)) as unknown) as Effect.Effect<
      RuntimeIntegrityEvidenceContract.RuntimeIdentity,
      RuntimeIntegrityEvidenceContract.RuntimeIntegrityEvidenceError
    >,
}
