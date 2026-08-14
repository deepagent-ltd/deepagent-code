export * as LiveFederatedContextQuery from "./federated-query-service"

import { CodeQuery } from "@deepagent-code/core/code-intelligence/query"
import { ContextAdapters } from "@deepagent-code/core/context-federation/adapters"
import { ContextAuthorization, type EgressPolicy, type Principal } from "@deepagent-code/core/context-federation/authorization"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import { FederatedContextQuery } from "@deepagent-code/core/context-federation/query"
import { ContextFederation } from "@deepagent-code/core/context-federation/federation"
import { ContextLinkStore } from "@deepagent-code/core/context-federation/link-store"
import { FederatedContextResolver } from "@deepagent-code/core/context-federation/resolver"
import { ContextReference } from "@deepagent-code/core/context-federation/reference"
import { isConfigured, storesForWorkspace } from "@deepagent-code/core/deepagent/knowledge-source"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { Hash } from "@deepagent-code/core/util/hash"
import { Database } from "@deepagent-code/core/database/database"
import { Context, Effect, Exit, Layer } from "effect"
import { LSP } from "../lsp/lsp"
import { LiveEditorBufferSnapshot } from "../code-intelligence/editor-buffer-snapshot"
import { LiveCodeQuery } from "../code-intelligence/query-service"
import { isSensitivePath } from "../location-index/manifest"
import { LocationIndexRuntime } from "../location-index/runtime"
import { LocationIndexCoordinator } from "../location-index/coordinator"
import { LiveContextLinkRevisionAuthority } from "./revision-authority"
import { ContextFederationObservability } from "./observability"

type LegacyDocumentStore = ReturnType<typeof storesForWorkspace>[number]["documentStore"]

export interface LegacyContextStoresInterface {
  readonly forWorkspace: (workspacePath: string) => readonly LegacyDocumentStore[]
}

export class LegacyContextStores extends Context.Service<LegacyContextStores, LegacyContextStoresInterface>()(
  "@deepagent-code/LegacyContextStores",
) {}

export const legacyContextStoresLayer = Layer.succeed(
  LegacyContextStores,
  LegacyContextStores.of({
    forWorkspace: (workspacePath) =>
      isConfigured() ? storesForWorkspace(workspacePath).map((store) => store.documentStore) : [],
  }),
)

export function layer(config: { readonly perGraphTimeoutMs: number; readonly freshTimeoutMs: number }) {
  if (!Number.isSafeInteger(config.freshTimeoutMs) || config.freshTimeoutMs <= 0) throw new Error("invalid fresh timeout")
  return Layer.effect(
    FederatedContextQuery.Service,
    Effect.gen(function* () {
      const runtime = yield* LocationIndexRuntime.Service
      const code = yield* CodeQuery.Service
      const links = yield* ContextLinkStore.Service
      const legacyStores = yield* LegacyContextStores

      const query: FederatedContextQuery.Interface["query"] = (request) =>
        Effect.gen(function* () {
          const startedAt = performance.now()
          const invalid = validate(request)
          if (invalid) return yield* new FederatedContextQuery.InvalidQueryError({ reason: invalid })
          const handle = yield* runtime.current()
          if (!handle) {
            const result = unavailable(request)
            ContextFederationObservability.observeQuery({
              statuses: result.statuses,
              candidates: {},
              selected: {},
              latencyMs: performance.now() - startedAt,
            })
            return result
          }
          if (request.ref && !allowsRef(request.ref, handle.identity, request)) {
            return yield* new FederatedContextQuery.InvalidQueryError({ reason: "ref" })
          }
          const sources = selectedSources(request)
          const repoFresh = request.consistency === "stale_ok" || !sources.includes("documents")
            ? true
            : Exit.isSuccess(yield* handle.coordinator
                .requestReconciliation({ reason: "reconcile", source: "fresh_query" })
                .pipe(
                  Effect.andThen(handle.coordinator.drain("repo_documents")),
                  Effect.timeout(config.freshTimeoutMs),
                  Effect.exit,
                ))
          const scope: ContextAdapters.Scope = {
            securityNamespaceId: handle.identity.securityNamespaceId,
            projectScopeKey: handle.identity.projectScopeKey,
            legacyProjectId: projectIdForWorkspace(handle.identity.canonicalRoot),
            subjectId: request.principal.subjectIds[0] ?? "__unbound_subject__",
            sessionId: request.sessionId,
            principal: request.principal,
            egress: request.egress,
          }
          const stores = legacyStores.forWorkspace(handle.identity.canonicalRoot)
          const releasedSelection = request.releasedKnowledgeSelection
          const adapters = sources.map((source) => {
            if (source === "code") return codeAdapter({ code, request })
            if (source === "knowledge") {
              return stores.length > 0 && releasedSelection
                ? ContextAdapters.knowledge({ stores, scope, releasedSelection })
                : unavailableAdapter("knowledge", "released_snapshot", "released_snapshot_unavailable")
            }
            if (source === "memory") {
              return stores.length > 0 && releasedSelection
                ? ContextAdapters.memory({ stores, scope, releasedSelection })
                : unavailableAdapter("memory", "released_snapshot", "released_snapshot_unavailable")
            }
            return ContextAdapters.documents([
              repoDocumentsAdapter({
                coordinator: handle.coordinator,
                identity: handle.identity,
                principal: request.principal,
                egress: request.egress,
                fresh: repoFresh,
              }),
              ...(stores.length > 0
                ? [ContextAdapters.executionDocuments({ source: "execution_documents", stores, scope })]
                : [unavailableAdapter("documents", "execution_documents")]),
            ])
          })
          const built = yield* Layer.build(
            FederatedContextResolver.layer({ adapters, perGraphTimeoutMs: config.perGraphTimeoutMs }).pipe(
              Layer.provide(Layer.succeed(ContextLinkStore.Service, links)),
            ),
          )
          const resolved = yield* Context.get(built, FederatedContextResolver.Service).query({
            securityNamespaceId: handle.identity.securityNamespaceId,
            projectScopeKey: handle.identity.projectScopeKey,
            principal: request.principal,
            egress: request.egress,
            text: request.query ?? request.ref?.locator?.symbolPath ?? request.ref?.locator?.heading ?? request.ref?.locator?.path ?? "",
            ...(request.ref ? { entityIds: [request.ref.entityId] } : {}),
            ...(request.relation ? { relations: [request.relation] } : {}),
            limit: Math.min(request.limit + 1, 100),
            toolCall: request.toolCall ?? true,
          })
          const hits = resolved.ranked.slice(0, request.limit).map((ranked) => ({
            ref: ranked.candidate.ref,
            title: ranked.candidate.title,
            graph: ranked.candidate.graph,
            ...(ranked.candidate.summary ? { excerpt: ranked.candidate.summary } : {}),
            ...(resolved.relationPaths.get(candidateKey(ranked.candidate))
              ? { relationPath: resolved.relationPaths.get(candidateKey(ranked.candidate)) }
              : {}),
            provenance: ranked.candidate.provenance,
            validity: {
              state: ranked.candidate.features.freshness === 1 ? "current" as const : "historical" as const,
            },
            score: ranked.score,
            sensitivity: sensitivity(ranked.candidate.graph),
          }))
          const result = {
            statuses: resolved.statuses,
            hits,
            truncated: resolved.ranked.length > request.limit,
            snapshotFingerprint: Hash.sha256(JSON.stringify({
              statuses: resolved.statuses,
              refs: resolved.ranked.map((ranked) => ContextReference.canonicalContextRef(ranked.candidate.ref)),
            })),
          }
          ContextFederationObservability.observeQuery({
            statuses: result.statuses,
            candidates: counts(resolved.ranked.map((ranked) => ranked.candidate.graph)),
            selected: counts(hits.map((hit) => hit.graph)),
            rejected: counts(resolved.ranked.slice(request.limit).map((ranked) => ranked.candidate.graph)),
            latencyMs: performance.now() - startedAt,
          })
          return result
        }).pipe(
          Effect.scoped,
          Effect.withSpan("ContextFederation.query", {
            attributes: {
              intent: request.intent,
              consistency: request.consistency,
              sources: (request.sources ?? []).join(","),
            },
          }),
        )

      return FederatedContextQuery.Service.of({ query })
    }),
  )
}

const codeLayer = LiveCodeQuery.layer({ freshTimeoutMs: 750, lspTimeoutMs: 500 }).pipe(
  Layer.provide(LSP.defaultLayer),
  Layer.provide(LiveEditorBufferSnapshot.layer()),
)
const linkLayer = ContextLinkStore.layer.pipe(
  Layer.provide(LiveContextLinkRevisionAuthority.layer),
  Layer.provide(Database.defaultLayer),
)

export const productionLayer = layer({ perGraphTimeoutMs: 750, freshTimeoutMs: 750 }).pipe(
  Layer.provide(Layer.mergeAll(codeLayer, linkLayer, legacyContextStoresLayer)),
)

export const defaultLayer = productionLayer.pipe(Layer.provide(LocationIndexRuntime.defaultLayer))

function codeAdapter(input: {
  readonly code: CodeQuery.Interface
  readonly request: FederatedContextQuery.Request
}): ContextAdapters.Adapter {
  return {
    graph: "code",
    source: "code_query",
    query: (query) => input.code.query({
      intent: input.request.ref?.graph === "code" ? "definition" : "search",
      query: query.text,
      ...(input.request.ref?.graph === "code" && input.request.ref.locator?.symbolPath
        ? { symbol: input.request.ref.locator.symbolPath }
        : {}),
      ...(input.request.ref?.graph === "code" && input.request.ref.locator?.path
        ? { file: input.request.ref.locator.path }
        : {}),
      limit: Math.min(query.limit ?? 12, 100),
      consistency: input.request.consistency,
      principal: input.request.principal,
      egress: input.request.egress,
      sessionId: input.request.sessionId,
    }).pipe(
      Effect.map((result) => ({
        candidates: result.hits.map((hit) => ContextFederation.candidate({
          ref: hit.ref,
          graph: "code",
          title: hit.symbol ?? hit.file,
          summary: [
            hit.snippet?.slice(0, 360) ?? hit.file,
            hit.degree
              ? `call_graph: callers=${hit.degree.callsIn}, callees=${hit.degree.callsOut}, in_degree=${hit.degree.inDegree}, out_degree=${hit.degree.outDegree}`
              : undefined,
          ].filter((value): value is string => Boolean(value)).join("\n"),
          relations: [],
          provenance: [],
          features: {
            exact: input.request.ref?.entityId === hit.ref.entityId ? 1 : 0,
            lexical: Math.min(Math.max(hit.score ?? 0.5, 0), 1),
            authority: 0.6,
            evidence: hit.sources.includes("lsp") ? 0.9 : 0.7,
            freshness: result.index.stale ? 0 : 1,
          },
          trust: "repository_evidence",
          visibility: "model",
        })),
        status: result.freshnessSatisfied || input.request.consistency === "stale_ok"
          ? result.status
          : ContextFederation.status.partial({
              graph: "code",
              state: "stale",
              reasonCode: "fresh_timeout",
              revisions: result.status.revisions,
            }),
      })),
      Effect.catch(() => Effect.succeed({
        candidates: [],
        status: ContextFederation.status.blocked({
          graph: "code",
          state: "unavailable",
          reasonCode: "source_error",
          revisions: [{ source: "code_query", state: "unavailable", reasonCode: "source_error" }],
        }),
      })),
    ),
  }
}

function repoDocumentsAdapter(input: {
  readonly coordinator: LocationIndexCoordinator.Interface
  readonly identity: Identity
  readonly principal: Principal
  readonly egress: EgressPolicy
  readonly fresh: boolean
}): ContextAdapters.Adapter {
  return {
    graph: "documents",
    source: "repo_documents",
    query: (query) => (query.entityIds?.length
      ? input.coordinator.lookupDocuments({ documentIds: query.entityIds, limit: Math.min(query.limit ?? 12, 100) })
      : input.coordinator.searchDocuments({ query: query.text, limit: Math.min(query.limit ?? 12, 100) })).pipe(
      Effect.match({
        onFailure: () => ({
          candidates: [],
          status: ContextFederation.status.blocked({
            graph: "documents",
            state: "unavailable",
            reasonCode: "source_error",
            revisions: [{ source: "repo_documents", state: "unavailable", reasonCode: "source_error" }],
          }),
        }),
        onSuccess: (result) => {
          if (!result.revision) {
            return {
              candidates: [],
              status: ContextFederation.status.partial({
                graph: "documents",
                state: "cold",
                reasonCode: "cold_start",
                revisions: [{ source: "repo_documents", state: "cold", reasonCode: "cold_start" }],
              }),
            }
          }
          const revision = ContextReference.canonicalProjectionRevision(result.revision)
          const candidates = result.hits.flatMap((hit) => {
            if (isSensitivePath(hit.document.path)) return []
            const ref = {
              graph: "documents" as const,
              entityId: hit.document.documentId,
              binding: {
                scope: "location" as const,
                securityNamespaceId: input.identity.securityNamespaceId,
                locationKey: input.identity.locationKey,
                projectScopeKey: input.identity.projectScopeKey,
              },
              locator: {
                path: hit.document.path,
                heading: hit.document.headingPath,
                startLine: hit.document.startLine,
                endLine: hit.document.endLine,
              },
              revision,
            }
            if (!ContextAuthorization.authorize({ ref, principal: input.principal, egress: input.egress, sensitivity: "source_code" }).allowed) {
              return []
            }
            return [ContextFederation.candidate({
              ref,
              graph: "documents",
              title: hit.document.headingPath || hit.document.path,
              summary: hit.document.searchableText.slice(0, 400),
              relations: [],
              provenance: [],
              features: {
                exact: query.entityIds?.includes(hit.document.documentId) ? 1 : 0,
                lexical: Math.min(Math.max(hit.score, 0), 1),
                authority: 0.8,
                evidence: 0.8,
                freshness: input.fresh ? 1 : 0,
              },
              trust: "repository_evidence",
              visibility: "model",
            })]
          })
          return {
            candidates,
            status: input.fresh
              ? candidates.length > 0
                ? ContextFederation.status.matched("documents", [{ source: "repo_documents", revision, state: "ready" }])
                : ContextFederation.status.empty("documents", [{ source: "repo_documents", revision, state: "ready" }])
              : ContextFederation.status.partial({
                  graph: "documents",
                  state: "stale",
                  reasonCode: "fresh_timeout",
                  revisions: [{ source: "repo_documents", revision, state: "stale", reasonCode: "fresh_timeout" }],
                }),
          }
        },
      }),
    ),
  }
}

function unavailableAdapter(
  graph: "knowledge" | "memory" | "documents",
  source: string,
  reasonCode: ContextFederation.GraphQueryReasonCode = "source_error",
): ContextAdapters.Adapter {
  return {
    graph,
    source,
    query: () => Effect.succeed({
      candidates: [],
      status: ContextFederation.status.blocked({
        graph,
        state: "unavailable",
        reasonCode,
        revisions: [{ source, state: "unavailable", reasonCode }],
      }),
    }),
  }
}

function selectedSources(request: FederatedContextQuery.Request) {
  if (request.sources) return [...new Set(request.sources)]
  if (request.intent === "recall") return ["memory" as const]
  if (["related", "trace_evidence"].includes(request.intent)) {
    return ["code", "documents", "knowledge", "memory"] as const
  }
  return ["documents", "knowledge", "memory"] as const
}

function validate(request: FederatedContextQuery.Request) {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) return "limit"
  if (request.sources?.length === 0) return "sources"
  if (request.relation && !ContextLinkStore.Relation.literals.includes(request.relation as ContextLinkStore.Relation)) return "relation"
  if (["search", "recall", "find_conflicts"].includes(request.intent) && !request.query?.trim()) return "query"
  if (["related", "trace_evidence"].includes(request.intent) && !request.ref) return "ref"
  if (request.intent === "explain_decision" && !request.query?.trim() && !request.ref) return "query_or_ref"
}

function allowsRef(
  ref: ContextReference.ContextRef,
  identity: Identity,
  request: FederatedContextQuery.Request,
) {
  if (!ContextAuthorization.authorizeScope(ref, request.principal).allowed || !request.egress.graphs.includes(ref.graph)) return false
  const binding = ref.binding
  if (binding.scope === "location") {
    return binding.locationKey === identity.locationKey && binding.projectScopeKey === identity.projectScopeKey
  }
  if (binding.scope === "project" || binding.scope === "session") return binding.projectScopeKey === identity.projectScopeKey
  return true
}

function unavailable(request: FederatedContextQuery.Request): FederatedContextQuery.Result {
  const sources = selectedSources(request)
  const statuses = (["code", "documents", "knowledge", "memory"] as const).map((graph) =>
    sources.includes(graph as never)
      ? ContextFederation.status.blocked({ graph, state: "unavailable", reasonCode: "source_error", revisions: [] })
      : ContextFederation.status.notQueried(graph),
  )
  return { statuses, hits: [], truncated: false, snapshotFingerprint: Hash.sha256(JSON.stringify(statuses)) }
}

function candidateKey(candidate: ContextFederation.ContextCandidate) {
  return `${candidate.graph}:${candidate.ref.entityId}:${candidate.ref.revision}`
}

function counts(values: readonly ContextFederation.ContextCandidate["graph"][]) {
  return values.reduce<Partial<Record<ContextFederation.ContextCandidate["graph"], number>>>((result, graph) => {
    result[graph] = (result[graph] ?? 0) + 1
    return result
  }, {})
}

function sensitivity(graph: ContextFederation.ContextCandidate["graph"]) {
  if (graph === "code" || graph === "documents") return "source_code" as const
  return "secret_adjacent" as const
}
