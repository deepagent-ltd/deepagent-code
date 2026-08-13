export * as ContextQueryFacade from "./context-query-facade"

import { ContextArtifactStore } from "@deepagent-code/core/context-federation/artifact-store"
import { ContextAuthorization } from "@deepagent-code/core/context-federation/authorization"
import { ContextFederationContract } from "@deepagent-code/core/context-federation/contract"
import { ContextLinkStore } from "@deepagent-code/core/context-federation/link-store"
import { FederatedContextQuery } from "@deepagent-code/core/context-federation/query"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { ContextReference } from "@deepagent-code/core/context-federation/reference"
import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import { Hash } from "@deepagent-code/core/util/hash"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { SessionActivityTable, SessionContextSelectionTable } from "@deepagent-code/core/context-federation/session-sql"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import { and, desc, eq } from "drizzle-orm"
import { LiveContextArtifactStore } from "./artifact-service"
import { LiveFederatedContextQuery } from "./federated-query-service"
import { LiveContextQueryAuthorization } from "./query-authorization"
import { LiveContextTokenCodec } from "./token-service"
import { LocationIndexRuntime } from "../location-index/runtime"

const TokenLifetimeMs = 15 * 60_000

export type Result = {
  readonly schemaVersion: 1
  readonly summary: string
  readonly statuses: FederatedContextQuery.Result["statuses"]
  readonly hits: readonly {
    readonly ref: string
    readonly title: string
    readonly graph: FederatedContextQuery.Hit["graph"]
    readonly excerpt?: string
    readonly relationPath?: readonly {
      readonly relation: string
      readonly ref: string
      readonly freshness: "exact" | "rebound" | "broken"
    }[]
    readonly provenance: readonly string[]
    readonly validity?: FederatedContextQuery.Hit["validity"]
  }[]
  readonly truncated: boolean
  readonly nextCursor?: string
  readonly artifactRef?: string
}

export class AuthorizationUnavailableError extends Schema.TaggedErrorClass<AuthorizationUnavailableError>()(
  "ContextQueryFacade.AuthorizationUnavailableError",
  {},
) {}
export class LocationUnavailableError extends Schema.TaggedErrorClass<LocationUnavailableError>()(
  "ContextQueryFacade.LocationUnavailableError",
  {},
) {}
export class TokenError extends Schema.TaggedErrorClass<TokenError>()("ContextQueryFacade.TokenError", {}) {}
export class ArtifactUnavailableError extends Schema.TaggedErrorClass<ArtifactUnavailableError>()(
  "ContextQueryFacade.ArtifactUnavailableError",
  {},
) {}
export class ReleasedKnowledgeUnavailableError extends Schema.TaggedErrorClass<ReleasedKnowledgeUnavailableError>()(
  "ContextQueryFacade.ReleasedKnowledgeUnavailableError",
  {},
) {}

export type Error =
  | AuthorizationUnavailableError
  | LocationUnavailableError
  | TokenError
  | ArtifactUnavailableError
  | ReleasedKnowledgeUnavailableError
  | FederatedContextQuery.InvalidQueryError

export interface Interface {
  readonly execute: (input: {
    readonly request: ContextFederationContract.ContextQueryInput
    readonly sessionId: string
    readonly agent: string
    readonly now?: number
  }) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/ContextQueryFacade") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const query = yield* FederatedContextQuery.Service
    const authorization = yield* ContextQueryAuthorization.Service
    const codec = yield* ContextTokenCodec.Service
    const runtime = yield* LocationIndexRuntime.Service
    const artifacts = yield* ContextArtifactStore.Service
    const database = yield* Database.Service

    const releasedKnowledgeForSession = Effect.fn("ContextQueryFacade.releasedKnowledgeForSession")(function* (
      sessionId: string,
      identity: Identity,
    ) {
      const row = yield* database.db
        .select({
          securityNamespaceId: SessionContextSelectionTable.security_namespace_id,
          projectScopeKey: SessionContextSelectionTable.project_scope_key,
          state: SessionContextSelectionTable.released_knowledge_binding_state,
          snapshotId: SessionContextSelectionTable.released_knowledge_snapshot_id,
          generation: SessionContextSelectionTable.released_knowledge_generation,
          membershipHash: SessionContextSelectionTable.released_knowledge_membership_hash,
          manifestHash: SessionContextSelectionTable.released_knowledge_manifest_hash,
          exactRefs: SessionContextSelectionTable.released_knowledge_exact_refs,
          exactRefsFingerprint: SessionContextSelectionTable.released_knowledge_exact_refs_fingerprint,
        })
        .from(SessionContextSelectionTable)
        .innerJoin(SessionActivityTable, eq(SessionActivityTable.activity_id, SessionContextSelectionTable.activity_id))
        .where(
          and(
            eq(SessionContextSelectionTable.session_id, sessionId),
            eq(SessionActivityTable.state, "active"),
          ),
        )
        .orderBy(desc(SessionContextSelectionTable.revision))
        .get()
        .pipe(Effect.mapError(() => new ReleasedKnowledgeUnavailableError()))
      if (!row) return undefined
      if (
        row.securityNamespaceId !== identity.securityNamespaceId ||
        row.projectScopeKey !== identity.projectScopeKey
      ) return yield* new ReleasedKnowledgeUnavailableError()
      const binding = row.state === "unavailable"
        ? DeepAgentReleasedSnapshot.binding(undefined)
        : row.state === "bound" && row.snapshotId && row.generation && row.membershipHash && row.manifestHash &&
            row.exactRefs && row.exactRefsFingerprint
          ? {
              state: "bound" as const,
              snapshotId: row.snapshotId,
              generation: row.generation,
              membershipHash: row.membershipHash,
              manifestHash: row.manifestHash,
              exactRefs: row.exactRefs,
              exactRefsFingerprint: row.exactRefsFingerprint,
            }
          : undefined
      if (!binding) return yield* new ReleasedKnowledgeUnavailableError()
      if (binding.state === "unavailable") return undefined
      const selection = yield* DeepAgentReleasedSnapshot.get(
        database.db,
        {
          securityNamespaceId: identity.securityNamespaceId,
          projectScopeKey: identity.projectScopeKey,
          legacyProjectId: identity.observedProjectId ?? projectIdForWorkspace(identity.canonicalRoot),
        },
        binding.snapshotId,
      ).pipe(Effect.mapError(() => new ReleasedKnowledgeUnavailableError()))
      if (!DeepAgentReleasedSnapshot.matchesBinding(selection, binding)) {
        return yield* new ReleasedKnowledgeUnavailableError()
      }
      return selection
    })

    const execute: Interface["execute"] = (input) =>
      Effect.gen(function* () {
        const envelope = yield* authorization.resolve({ sessionId: input.sessionId, agent: input.agent })
        if (!envelope) return yield* new AuthorizationUnavailableError()
        const handle = yield* runtime.current()
        if (!handle) return yield* new LocationUnavailableError()
        const now = input.now ?? Date.now()
        const queryFingerprint = fingerprint(input.request)
        const authorizationFingerprint = ContextAuthorization.fingerprint(envelope.principal, envelope.egress)
        const ref = input.request.ref
          ? yield* codec.openContextRef(input.request.ref, now).pipe(Effect.mapError(() => new TokenError()))
          : undefined
        const cursor = input.request.cursor
          ? yield* codec.openCursor(input.request.cursor, now).pipe(Effect.mapError(() => new TokenError()))
          : undefined
        if (
          cursor &&
          (cursor.securityNamespaceId !== handle.identity.securityNamespaceId ||
            cursor.locationKey !== handle.identity.locationKey ||
            !("kind" in cursor.snapshotRevision) ||
            cursor.snapshotRevision.kind !== "federated" ||
            cursor.queryFingerprint !== queryFingerprint ||
            cursor.authorizationFingerprint !== authorizationFingerprint)
        ) return yield* new TokenError()
        const relation = input.request.relation && ContextLinkStore.Relation.literals.includes(input.request.relation as ContextLinkStore.Relation)
          ? input.request.relation as ContextLinkStore.Relation
          : undefined
        if (input.request.relation && !relation) {
          return yield* new FederatedContextQuery.InvalidQueryError({ reason: "relation" })
        }
        const offset = cursor?.page.offset ?? 0
        const limit = Math.min(input.request.limit ?? 20, 100)
        if (offset < 0 || offset > 99) return yield* new TokenError()
        const releasedKnowledgeSelection = yield* releasedKnowledgeForSession(input.sessionId, handle.identity)
        const raw = yield* query.query({
          intent: input.request.intent,
          ...(input.request.query === undefined ? {} : { query: input.request.query }),
          ...(input.request.sources === undefined ? {} : { sources: input.request.sources }),
          ...(ref ? { ref } : {}),
          ...(relation ? { relation } : {}),
          limit: 100,
          consistency: input.request.consistency ?? "stale_ok",
          principal: envelope.principal,
          egress: envelope.egress,
          sessionId: input.sessionId,
          toolCall: true,
          releasedKnowledgeSelection,
        })
        if (
          cursor &&
          (!("kind" in cursor.snapshotRevision) ||
            cursor.snapshotRevision.kind !== "federated" ||
            cursor.snapshotRevision.fingerprint !== raw.snapshotFingerprint)
        ) return yield* new TokenError()
        const hits = raw.hits.slice(offset, offset + limit)
        const truncated = raw.truncated || raw.hits.length > offset + limit
        const lifetime = { issuedAt: now, expiresAt: now + TokenLifetimeMs }
        const selectionId = `context_tool_${Hash.sha256(JSON.stringify({
          sessionId: input.sessionId,
          queryFingerprint,
          snapshotFingerprint: raw.snapshotFingerprint,
          offset,
          refs: hits.map((hit) => ContextReference.canonicalContextRef(hit.ref)),
        }))}`
        const artifact = yield* artifacts.write({
          securityNamespaceId: handle.identity.securityNamespaceId,
          sessionId: input.sessionId,
          selectionId,
          authorizationFingerprint,
          artifact: {
            schemaVersion: 1,
            selectionId,
            queryFingerprint,
            authorizationFingerprint,
            graphStatuses: raw.statuses,
            rankingVersion: "federated-rrf-v1",
            selected: hits.map((hit) => ({
              ref: hit.ref,
              sensitivity: hit.sensitivity,
              score: hit.score,
              reason: hit.relationPath?.map((step) => step.relation).join(" > ") || "federated_rank",
              excerpt: (hit.excerpt ?? hit.title).slice(0, 1_000),
            })),
            rejected: raw.statuses.flatMap((status) =>
              status.kind === "blocked" || status.kind === "partial"
                ? [{ graph: status.graph, reasonCode: status.reasonCode }]
                : [],
            ),
          },
          now,
        }).pipe(Effect.exit)
        if (Exit.isFailure(artifact) && artifacts.policy === "required") {
          return yield* new ArtifactUnavailableError()
        }
        const sealedHits = hits.map((hit) => ({
          ref: codec.sealContextRef(hit.ref, lifetime),
          title: hit.title,
          graph: hit.graph,
          ...(hit.excerpt ? { excerpt: hit.excerpt } : {}),
          ...(hit.relationPath ? {
            relationPath: hit.relationPath.map((step) => ({
              relation: step.relation,
              ref: codec.sealContextRef(step.ref, lifetime),
              freshness: step.freshness,
            })),
          } : {}),
          provenance: hit.provenance.map((provenance) => codec.sealContextRef(provenance, lifetime)),
          ...(hit.validity ? { validity: hit.validity } : {}),
        }))
        const visibleHits = fit(sealedHits, (hit) => ({
          ref: hit.ref,
          title: hit.title,
          graph: hit.graph,
          ...(hit.relationPath?.[0] ? { relationPath: [hit.relationPath[0]] } : {}),
          provenance: hit.provenance.slice(0, 1),
          ...(hit.validity ? { validity: hit.validity } : {}),
        }))
        const visibleSourceHits = hits.slice(0, visibleHits.length)
        const outputTruncated = truncated || visibleHits.length < hits.length
        const nextCursor = outputTruncated && offset + visibleHits.length < 100
          ? codec.sealCursor({
              securityNamespaceId: handle.identity.securityNamespaceId,
              locationKey: handle.identity.locationKey,
              snapshotRevision: { kind: "federated", fingerprint: raw.snapshotFingerprint },
              queryFingerprint,
              authorizationFingerprint,
              page: {
                offset: offset + visibleHits.length,
                ...(visibleSourceHits.at(-1)?.score === undefined ? {} : { lastScore: visibleSourceHits.at(-1)!.score }),
                ...(visibleSourceHits.at(-1) ? { lastEntityId: visibleSourceHits.at(-1)!.ref.entityId } : {}),
              },
            }, lifetime)
          : undefined
        return {
          schemaVersion: 1 as const,
          summary: summary(raw, visibleHits.length),
          statuses: raw.statuses,
          hits: visibleHits,
          truncated: outputTruncated,
          ...(nextCursor ? { nextCursor } : {}),
          ...(Exit.isSuccess(artifact) ? { artifactRef: artifact.value.ref } : {}),
        }
      })

    return Service.of({ execute })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(
    LiveFederatedContextQuery.productionLayer,
    LiveContextQueryAuthorization.defaultLayer,
    LiveContextArtifactStore.defaultLayer.pipe(Layer.provide(Database.defaultLayer)),
    Database.defaultLayer,
  )),
  Layer.provide(LiveContextTokenCodec.defaultLayer),
  Layer.provide(LocationIndexRuntime.defaultLayer),
)

function fingerprint(input: ContextFederationContract.ContextQueryInput) {
  return Hash.sha256(JSON.stringify({
    intent: input.intent,
    query: input.query,
    sources: input.sources?.toSorted(),
    ref: input.ref,
    relation: input.relation,
    limit: input.limit,
    consistency: input.consistency,
  }))
}

function summary(result: FederatedContextQuery.Result, count: number) {
  const abnormal = result.statuses.filter((status) => status.kind === "blocked" || status.kind === "partial").length
  if (count === 0) return abnormal > 0 ? `No visible context results; ${abnormal} source status${abnormal === 1 ? " is" : "es are"} abnormal.` : "No authorized context results."
  return `Found ${count} authorized context result${count === 1 ? "" : "s"}${abnormal > 0 ? ` with ${abnormal} degraded source status${abnormal === 1 ? "" : "es"}` : ""}.`
}

function fit<A>(items: readonly A[], compact: (item: A) => A) {
  const selected = items.reduce<{ readonly items: readonly A[]; readonly stopped: boolean }>((state, item) => {
    if (state.stopped) return state
    const next = [...state.items, item]
    return JSON.stringify(next).length <= 6_000 ? { items: next, stopped: false } : { ...state, stopped: true }
  }, { items: [], stopped: false }).items
  if (selected.length > 0 || items.length === 0) return selected
  return [compact(items[0]!)]
}
