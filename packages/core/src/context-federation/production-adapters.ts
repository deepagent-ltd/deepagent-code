export * as ProductionV2Adapters from "./production-adapters"

import { Context, Effect, Layer, Option } from "effect"
import { type CodeQuery } from "../code-intelligence/query"
import { ContextAuthorization } from "./authorization"
import { ContextFederation } from "./federation"
import { LocationKey, canonicalProjectionRevision, type ContextRef } from "./reference"
import { type ProjectionSnapshotRevision } from "./reference"
import { AdapterVersion, code as codeFactory, knowledge as knowledgeFactory, memory as memoryFactory } from "./adapters-v2"
import { type V2Adapter, type V2AdapterInput, type V2AdapterResult } from "./adapters-v2"
import { type Scope as LegacyScope } from "./adapters"
import { type DocumentStore } from "../deepagent/document-store"
import { DurableKnowledgeStore } from "../deepagent/durable-knowledge-store"
import { DeepAgentReleasedSnapshot } from "../deepagent/released-snapshot"
import { RepoDocument } from "../document-intelligence/repo-document"
import type { GraphKind } from "../contract/selection"
import { flipFlagValueOn } from "../deepagent/flip-flag"

// W3.1 — production V2 adapter assembly. Wraps the four `adapters-v2` factories with REAL source
// inputs (live code query, repo-document index, durable knowledge stores, released snapshot) so the
// default turn path yields {ready, empty} graph statuses instead of the staged `source_disabled`
// degradation. The sources arrive as plain values/effects (the value seam a deepagent-code
// composition satisfies by wiring `LiveCodeQuery` / `LocationIndexCoordinator` / knowledge stores);
// when a source is absent the corresponding graph degrades honestly (never a v2-none).

/** The W0.1-reserved env key. The literal lives here (core cannot import deepagent-code
 * runtime-defaults); both sides use the single `flipFlagValueOn` table — absent key default ON. */
export const CONTEXT_FEDERATION_PRODUCTION_ENV = "DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION"

/** W3.1 flag gate: production adapters are ON by default; `=false`/`=0`/`""` (trim+lower) falls
 * back to the staged adapter set (existing behavior). Read at call time so tests can flip it. */
export const productionAdaptersEnabled = (): boolean =>
  flipFlagValueOn(process.env[CONTEXT_FEDERATION_PRODUCTION_ENV], true)

/**
 * Repo-document search surface (mirrors the `LocationIndexCoordinator.searchDocuments` core type
 * `RepoDocument.Store` search results). `mutationEpoch` is the observed location mutation epoch
 * captured at resolution time; it feeds the documents adapter's `observedMutationEpoch`.
 */
export type ProductionDocumentsSource = {
  readonly search: (input: {
    readonly query: string
    readonly limit: number
  }) => Effect.Effect<{ readonly revision?: ProjectionSnapshotRevision; readonly hits: readonly RepoDocument.SearchHit[] }, unknown>
  readonly mutationEpoch?: () => Effect.Effect<number, unknown>
}

/**
 * Released-knowledge binding observed at envelope build time plus the resolve-time refresh picker.
 * The picker is re-evaluated at adapter resolve; a mismatch against the bound snapshotId makes the
 * knowledge adapter unavailable with `released_snapshot_unavailable`, which the resolver surfaces
 * as a `released_snapshot_drift` successor signal (W3.3 consumption).
 */
export type ProductionReleasedBinding = {
  readonly snapshotId: string
  readonly binding: "bound" | "unavailable"
  readonly current: (scope: DeepAgentReleasedSnapshot.Scope) => Effect.Effect<DeepAgentReleasedSnapshot.Selection | undefined, unknown>
}

/**
 * Value seam for the four production sources. Every field is optional: a missing source degrades
 * its graph honestly instead of failing the turn (staged behavior is only the `=false` fallback).
 */
export type ProductionV2AdapterInput = {
  /** Live code query (deepagent-code `LiveCodeQuery` provides `CodeQuery.Service`). */
  readonly code?: CodeQuery.Interface
  /** Repo-document index search (deepagent-code `LocationIndexCoordinator`). */
  readonly documents?: ProductionDocumentsSource
  /** Durable knowledge stores (project-shared + user-global) + released snapshot binding. */
  readonly knowledge?: {
    readonly stores: readonly DurableKnowledgeStore[]
    readonly released?: ProductionReleasedBinding
  }
}

/** The composition seam: a `ProductionV2Sources` service so the location layer can declare the
 * production sources for the V2 runner. Empty by default; a deepagent-code composition replaces it
 * with the live services. */
export class ProductionV2Sources extends Context.Service<ProductionV2Sources, ProductionV2AdapterInput>()(
  "@deepagent-code/ProductionV2Sources",
) {}

/**
 * W3.7 host-injectable seam. The location-layer runner graph provides this layer, so a plain
 * `Layer.succeed` default would shadow any host-provided value for the whole runner subtree. Instead
 * the layer reads the build context: when a deepagent-code composition placed a real
 * `ProductionV2Sources` value there (via `Layer.provide(seam)` at the app root — the same
 * context-flow mechanism as `PromptEpoch.v2RunnerSeamLayer`), it forwards that value into the runner
 * subtree; otherwise it stays the documented empty default (`{}` = all four graphs degrade honestly,
 * the pre-W3.7 behavior — the `=false` staged fallback is unaffected).
 */
export const productionV2SourcesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const provided = yield* Effect.serviceOption(ProductionV2Sources)
    return Option.isSome(provided)
      ? Layer.succeed(ProductionV2Sources, provided.value)
      : Layer.succeed(ProductionV2Sources, {} as ProductionV2AdapterInput)
  }),
)

/**
 * Assemble the four production adapters. The adapters capture the inputs and read state at resolve
 * time (revision/epoch/current snapshot), so one assembled set stays honest across the resolutions
 * of a turn.
 */
export function productionV2Adapters(input: ProductionV2AdapterInput): Readonly<Record<GraphKind, V2Adapter>> {
  return {
    code: codeAdapter(input.code),
    documents: documentsAdapter(input.documents),
    knowledge: knowledgeAdapter(input.knowledge),
    memory: memoryAdapter(input.knowledge),
  }
}

// ---------------------------------------------------------------------------
// code
// ---------------------------------------------------------------------------

function codeAdapter(code: CodeQuery.Interface | undefined): V2Adapter {
  if (code === undefined) {
    return sourceDisabledAdapter("code", "code_intelligence", "code:unavailable")
  }
  return codeFactory({ service: code })
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

function documentsAdapter(documents: ProductionDocumentsSource | undefined): V2Adapter {
  if (documents === undefined) {
    return sourceDisabledAdapter("documents", "documents_union", "documents:unavailable")
  }
  return {
    graph: "documents",
    source: "documents_union",
    adapterVersion: AdapterVersion.documents,
    resolve: (query) => resolveDocuments(documents, query),
  }
}

function resolveDocuments(
  documents: ProductionDocumentsSource,
  query: V2AdapterInput,
): Effect.Effect<V2AdapterResult> {
  return Effect.gen(function* () {
    const epoch = documents.mutationEpoch
      ? yield* documents.mutationEpoch().pipe(Effect.catch(() => Effect.succeed(0)))
      : 0
    const searched = yield* documents
      .search({ query: query.query, limit: Math.min(Math.max(query.limit ?? 12, 1), 100) })
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (searched === undefined) {
      return yield* Effect.succeed({
        candidates: [],
        revision: "documents:unavailable",
        observedMutationEpoch: epoch,
        available: false,
        unavailableReasonCode: "source_error" as const,
      })
    }
    const revision = searched.revision
      ? canonicalProjectionRevision(searched.revision)
      : `documents:index:${epoch}`
    const candidates = searched.hits.flatMap((hit) => toDocumentsCandidate(hit, query, revision))
    return {
      candidates,
      revision,
      observedMutationEpoch: epoch,
      available: true,
    }
  })
}

function toDocumentsCandidate(
  hit: RepoDocument.SearchHit,
  query: V2AdapterInput,
  revision: string,
): ContextFederation.ContextCandidate[] {
  if (isSensitiveDocumentPath(hit.document.path)) return []
  const ref: ContextRef = {
    graph: "documents",
    entityId: hit.document.documentId,
    binding: {
      scope: "location",
      securityNamespaceId: query.securityNamespaceId,
      locationKey: LocationKey.make(query.locationKey),
      projectScopeKey: query.projectScopeKey,
    },
    locator: {
      path: hit.document.path,
      heading: hit.document.headingPath,
      startLine: hit.document.startLine,
      endLine: hit.document.endLine,
    },
    revision,
  }
  if (
    !ContextAuthorization.authorize({
      ref,
      principal: query.principal,
      egress: query.egress,
      sensitivity: "source_code",
    }).allowed
  ) {
    return []
  }
  return [
    ContextFederation.candidate({
      ref,
      graph: "documents",
      title: hit.document.headingPath || hit.document.path,
      summary: hit.document.searchableText.slice(0, 400),
      relations: [],
      provenance: [],
      features: {
        exact: 0,
        lexical: clamp(hit.score),
        authority: 0.8,
        evidence: 0.8,
        freshness: 1,
      },
      trust: "repository_evidence",
      visibility: "model",
    }),
  ]
}

// ---------------------------------------------------------------------------
// knowledge / memory
// ---------------------------------------------------------------------------

function knowledgeAdapter(knowledge: ProductionV2AdapterInput["knowledge"]): V2Adapter {
  if (knowledge === undefined || knowledge.stores.length === 0) {
    return emptyGraphAdapter("knowledge", "released_knowledge", "released:no-store")
  }
  return {
    graph: "knowledge",
    source: "released_knowledge",
    adapterVersion: AdapterVersion.knowledge,
    resolve: (query) =>
      resolveKnowledgeBinding(knowledge, query).pipe(
        Effect.catch(() => Effect.succeed({ state: "failed" as const })),
        Effect.flatMap((binding) => {
          if (binding.state === "unavailable" || binding.state === "superseded" || binding.state === "failed") {
            // The bound snapshot drifted (vanished or superseded mid-turn) or the current snapshot
            // could not be read: the released-knowledge adapter reports unavailable — the resolver
            // surfaces released_snapshot_drift (W3.3).
            return knowledgeFactory({
              stores: storesOf(knowledge.stores),
              scope: legacyScope(query),
              releasedSelection: binding.state === "failed" ? undefined : binding.selection,
              superseded: binding.state === "superseded",
              binding: "bound",
            }).resolve(query)
          }
          if (binding.selection === undefined) {
            // No released snapshot exists (nothing was released for this scope): a legitimate
            // empty domain — ready/empty, never degraded and never a drift signal.
            return Effect.succeed({
              candidates: [],
              revision: "released:none",
              observedMutationEpoch: 0,
              available: true,
            })
          }
          return knowledgeFactory({
            stores: storesOf(knowledge.stores),
            scope: legacyScope(query),
            releasedSelection: binding.selection,
            superseded: false,
            binding: "bound",
          }).resolve(query)
        }),
      ),
  }
}

/**
 * Resolve-time released binding: refresh the current snapshot against the binding captured at
 * envelope build time. `superseded`/`unavailable` make the knowledge adapter unavailable, which the
 * resolver turns into `released_snapshot_drift` (W3.3). No released snapshot at all is a legitimate
 * empty domain (ready/empty), never a degradation; `binding: "unavailable"` with a snapshot that
 * appeared mid-resolve is served as the current authority (no expectation was violated).
 */
function resolveKnowledgeBinding(
  knowledge: NonNullable<ProductionV2AdapterInput["knowledge"]>,
  query: V2AdapterInput,
): Effect.Effect<
  | { readonly state: "current"; readonly selection: DeepAgentReleasedSnapshot.Selection | undefined }
  | { readonly state: "superseded" | "unavailable"; readonly selection?: DeepAgentReleasedSnapshot.Selection },
  unknown
> {
  return Effect.gen(function* () {
    const binding = knowledge.released
    if (binding === undefined) {
      return { state: "current" as const, selection: undefined }
    }
    const current = yield* binding.current(releasedScope(query))
    if (binding.binding !== "bound") return { state: "current" as const, selection: current }
    if (current === undefined) return { state: "unavailable" as const }
    if (current.snapshotId !== binding.snapshotId) return { state: "superseded" as const, selection: current }
    return { state: "current" as const, selection: current }
  })
}

function memoryAdapter(knowledge: ProductionV2AdapterInput["knowledge"]): V2Adapter {
  if (knowledge === undefined || knowledge.stores.length === 0) {
    return emptyGraphAdapter("memory", "durable_memory", "memory:no-store")
  }
  return {
    graph: "memory",
    source: "durable_memory",
    // W3.2 memory revision/observedMutationEpoch: kept at the documented `memory:0`/`0` — the
    // durable store has no single generation counter; per-doc revisions ride the candidate refs. A
    // store-level generation can be exposed here once one exists.
    adapterVersion: AdapterVersion.memory,
    resolve: (query) =>
      Effect.gen(function* () {
        const selection = knowledge.released
          ? yield* knowledge.released.current(releasedScope(query)).pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined
        return yield* memoryFactory({
          stores: storesOf(knowledge.stores),
          scope: legacyScope(query),
          releasedSelection: selection,
          revision: "memory:0",
          observedMutationEpoch: 0,
        }).resolve(query)
      }),
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sourceDisabledAdapter(graph: GraphKind, source: string, revision: string): V2Adapter {
  return {
    graph,
    source,
    adapterVersion: AdapterVersion[graph],
    resolve: () =>
      Effect.succeed({
        candidates: [],
        revision,
        observedMutationEpoch: 0,
        available: false,
        unavailableReasonCode: "source_disabled",
      }),
  }
}

function emptyGraphAdapter(graph: GraphKind, source: string, revision: string): V2Adapter {
  return {
    graph,
    source,
    adapterVersion: AdapterVersion[graph],
    resolve: () =>
      Effect.succeed({
        candidates: [],
        revision,
        observedMutationEpoch: 0,
        available: true,
      }),
  }
}

function storesOf(stores: readonly DurableKnowledgeStore[]): readonly DocumentStore[] {
  return stores.map((store) => store.documentStore)
}

function legacyScope(query: V2AdapterInput): LegacyScope {
  return {
    securityNamespaceId: query.securityNamespaceId,
    projectScopeKey: query.projectScopeKey,
    legacyProjectId: query.legacyProjectId,
    subjectId: query.subjectId,
    sessionId: query.sessionId,
    principal: query.principal,
    egress: query.egress,
  }
}

function releasedScope(query: V2AdapterInput): DeepAgentReleasedSnapshot.Scope {
  return {
    securityNamespaceId: query.securityNamespaceId,
    projectScopeKey: query.projectScopeKey,
    legacyProjectId: query.legacyProjectId,
  }
}

/** Bounded copy of the sensitive-path guard (mirror of the deepagent-code location-index guard). */
function isSensitiveDocumentPath(filePath: string) {
  return [
    /(^|\/)\.env(?:\.|$)/i,
    /(^|\/)(?:credentials?|secrets?|tokens?)(?:\.|$)/i,
    /\.(?:pem|key|p12|pfx|jks)$/i,
    /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  ].some((pattern) => pattern.test(filePath))
}

function clamp(value: number) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}
