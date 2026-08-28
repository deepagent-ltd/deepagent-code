export * as ContextFederationReadiness from "./readiness"

import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { SessionContextSelectionTable } from "@deepagent-code/core/context-federation/session-sql"
import { Database } from "@deepagent-code/core/database/database"
import {
  ReleasedKnowledgeSnapshotDocumentTable,
  ReleasedKnowledgeSnapshotHeadTable,
  ReleasedKnowledgeSnapshotTable,
} from "@deepagent-code/core/deepagent/released-snapshot.sql"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { eq } from "drizzle-orm"
import { Context, Effect, Exit, Layer } from "effect"
import { LocationIndexRuntime } from "../location-index/runtime"
import { SessionToolRequestReceiptTable } from "../session/tool-request-receipt.sql"

const SnapshotLifetimeMs = 15_000

export function unavailableSnapshot(observedAt = Date.now()): ContextFederationRollout.DerivedContextDataReadiness {
  return {
    revision: Hash.sha256("context-readiness-unavailable-v1"),
    state: "blocked",
    identityBound: false,
    indexAvailable: false,
    storageHealthy: false,
    reasons: ["identity_unavailable", "storage_unavailable"],
    observedAt,
    expiresAt: observedAt,
  }
}

export interface Interface {
  readonly snapshot: () => Effect.Effect<ContextFederationRollout.DerivedContextDataReadiness>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ContextFederationReadiness") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const runtime = yield* LocationIndexRuntime.Service

    const snapshot: Interface["snapshot"] = Effect.fn("ContextFederationReadiness.snapshot")(function* () {
      const observedAt = Date.now()
      const current = yield* runtime.current()
      if (!current) {
        return {
          revision: Hash.sha256("context-readiness-uninitialized-v1"),
          state: "uninitialized",
          identityBound: false,
          indexAvailable: false,
          storageHealthy: false,
          reasons: ["identity_unavailable"],
          observedAt,
          expiresAt: observedAt + SnapshotLifetimeMs,
        }
      }

      const [index, journal, storage, releasedStorage] = yield* Effect.all([
        current.coordinator.codeStatus().pipe(Effect.exit),
        (current.coordinator.mutationEpoch?.() ?? Effect.fail(new Error("location journal unavailable"))).pipe(
          Effect.exit,
        ),
        database.db
          .select({
            contextSelectionId: SessionToolRequestReceiptTable.context_selection_id,
            contextEligibility: SessionToolRequestReceiptTable.context_eligibility,
            contextReadiness: SessionToolRequestReceiptTable.context_readiness,
            contextActivation: SessionToolRequestReceiptTable.context_activation,
            contextActivationFingerprint: SessionToolRequestReceiptTable.context_activation_fingerprint,
            releasedKnowledgeSecurityNamespaceId:
              SessionToolRequestReceiptTable.released_knowledge_security_namespace_id,
            releasedKnowledgeProjectScopeKey: SessionToolRequestReceiptTable.released_knowledge_project_scope_key,
            releasedKnowledgeBindingState: SessionToolRequestReceiptTable.released_knowledge_binding_state,
            releasedKnowledgeSnapshotId: SessionToolRequestReceiptTable.released_knowledge_snapshot_id,
            releasedKnowledgeGeneration: SessionToolRequestReceiptTable.released_knowledge_generation,
            releasedKnowledgeMembershipHash: SessionToolRequestReceiptTable.released_knowledge_membership_hash,
            releasedKnowledgeManifestHash: SessionToolRequestReceiptTable.released_knowledge_manifest_hash,
            releasedKnowledgeExactRefs: SessionToolRequestReceiptTable.released_knowledge_exact_refs,
            releasedKnowledgeExactRefsFingerprint:
              SessionToolRequestReceiptTable.released_knowledge_exact_refs_fingerprint,
            releasedKnowledgeSelectedRefs: SessionToolRequestReceiptTable.released_knowledge_selected_refs,
            releasedKnowledgeSelectedRefsFingerprint:
              SessionToolRequestReceiptTable.released_knowledge_selected_refs_fingerprint,
            finalOfferedToolIds: SessionToolRequestReceiptTable.final_offered_tool_ids,
            adapterToolCapability: SessionToolRequestReceiptTable.adapter_tool_capability,
            adapterLoweringOutcome: SessionToolRequestReceiptTable.adapter_lowering_outcome,
            authorizationFingerprint: SessionContextSelectionTable.authorization_fingerprint,
            authorizationEpoch: SessionContextSelectionTable.authorization_epoch,
            securityNamespaceId: SessionContextSelectionTable.security_namespace_id,
            projectScopeKey: SessionContextSelectionTable.project_scope_key,
            selectionReleasedKnowledgeBindingState: SessionContextSelectionTable.released_knowledge_binding_state,
            selectionReleasedKnowledgeSnapshotId: SessionContextSelectionTable.released_knowledge_snapshot_id,
            observedLocationMutationEpoch: SessionContextSelectionTable.observed_location_mutation_epoch,
            graphRevisions: SessionContextSelectionTable.graph_revisions,
            graphStatuses: SessionContextSelectionTable.graph_statuses,
            projectionHash: SessionContextSelectionTable.projection_hash,
          })
          .from(SessionToolRequestReceiptTable)
          .leftJoin(
            SessionContextSelectionTable,
            eq(SessionContextSelectionTable.selection_id, SessionToolRequestReceiptTable.context_selection_id),
          )
          .limit(0)
          .all()
          .pipe(Effect.exit),
        database.db
          .select({
            headSnapshotId: ReleasedKnowledgeSnapshotHeadTable.snapshot_id,
            snapshotId: ReleasedKnowledgeSnapshotTable.snapshot_id,
            documentSnapshotId: ReleasedKnowledgeSnapshotDocumentTable.snapshot_id,
          })
          .from(ReleasedKnowledgeSnapshotHeadTable)
          .leftJoin(
            ReleasedKnowledgeSnapshotTable,
            eq(ReleasedKnowledgeSnapshotTable.snapshot_id, ReleasedKnowledgeSnapshotHeadTable.snapshot_id),
          )
          .leftJoin(
            ReleasedKnowledgeSnapshotDocumentTable,
            eq(ReleasedKnowledgeSnapshotDocumentTable.snapshot_id, ReleasedKnowledgeSnapshotTable.snapshot_id),
          )
          .limit(0)
          .all()
          .pipe(Effect.exit),
      ])
      const indexAvailable = Exit.isSuccess(index) && ["ready", "degraded"].includes(index.value.state)
      const storageHealthy = Exit.isSuccess(storage) && Exit.isSuccess(releasedStorage)
      const reasons: ContextFederationRollout.ReadinessReason[] = [
        ...(Exit.isFailure(index) || index.value.state === "unavailable" ? (["index_unavailable"] as const) : []),
        ...(Exit.isSuccess(index) && ["cold", "indexing"].includes(index.value.state)
          ? (["index_building"] as const)
          : []),
        ...(Exit.isSuccess(index) && index.value.state === "degraded" ? (["index_degraded"] as const) : []),
        ...(Exit.isFailure(journal) ? (["journal_unavailable"] as const) : []),
        ...(!storageHealthy ? (["storage_unavailable"] as const) : []),
      ]
      const state = !storageHealthy
        ? ("blocked" as const)
        : Exit.isFailure(index) || index.value.state === "unavailable" || Exit.isFailure(journal)
          ? ("degraded" as const)
          : index.value.state === "cold" || index.value.state === "indexing"
            ? ("building" as const)
            : index.value.state

      return {
        revision: Hash.sha256(
          CanonicalJson.stringify({
            schemaVersion: 1,
            projectScopeKey: current.identity.projectScopeKey,
            locationKey: current.identity.locationKey,
            indexSpaceId: current.identity.indexSpaceId,
            index: Exit.isSuccess(index)
              ? {
                  state: index.value.state,
                  revision: index.value.revision,
                  generation: index.value.generation,
                  indexedAt: index.value.indexedAt,
                  dirtyPathCount: index.value.dirtyPathCount,
                }
              : { state: "unavailable" },
            journalHighWater: Exit.isSuccess(journal) ? journal.value : undefined,
            storageHealthy,
          }),
        ),
        state,
        identityBound: true,
        indexAvailable,
        storageHealthy,
        projectScopeKey: current.identity.projectScopeKey,
        locationKey: current.identity.locationKey,
        ...(Exit.isSuccess(index) && index.value.revision ? { indexRevision: index.value.revision } : {}),
        ...(Exit.isSuccess(index) ? { indexGeneration: index.value.generation } : {}),
        ...(Exit.isSuccess(journal) ? { journalHighWater: journal.value } : {}),
        reasons,
        observedAt,
        expiresAt: observedAt + SnapshotLifetimeMs,
      }
    })

    return Service.of({ snapshot })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(LocationIndexRuntime.defaultLayer),
  Layer.provide(Database.defaultLayer),
)
