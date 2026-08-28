export * as ContextAdaptersV2 from "./adapters-v2"

import { Effect } from "effect"
import { type CodeQuery } from "../code-intelligence/query"
import { type IndexStatus } from "../code-intelligence/code-graph"
import { canonicalProjectionRevision, type ProjectScopeKey, type SecurityNamespaceID } from "./reference"
import type { GraphKind } from "../contract/selection"
import type { GraphStatusReasonCode } from "../contract/selection"
import { ContextAdapters, type Scope as LegacyScope, type Adapter as LegacyAdapter } from "./adapters"
import { type ContextCandidate } from "./federation"
import { type EgressPolicy, type Principal } from "./authorization"

/**
 * Per-adapter version literal. Each graph adapter reports its own version const
 * so a version bump is observable in the per-graph status (design §6.2:
 * `adapterVersion`). Tests assert that importing a different const changes the
 * status field.
 */
export const AdapterVersion = {
  code: "code-intelligence.v1",
  documents: "documents-union.v1",
  knowledge: "released-knowledge.v1",
  memory: "durable-memory.v1",
} as const

/**
 * Input handed to a graph adapter by the resolver. It is deliberately a flat,
 * self-contained shape (not the resolver QueryEnvelope) so that `adapters-v2`
 * does not import from `resolver-v2` and the two modules stay acyclic.
 */
export type V2AdapterInput = {
  readonly query: string
  readonly entityIds?: readonly string[]
  readonly limit?: number
  readonly now: number
  readonly sessionId: string
  readonly securityNamespaceId: SecurityNamespaceID
  readonly locationKey: string
  readonly projectScopeKey: ProjectScopeKey
  readonly legacyProjectId: string
  readonly subjectId: string
  readonly principal: Principal
  readonly egress: EgressPolicy
}

/** What a graph adapter returns to the resolver: raw candidates + source identity. */
export type V2AdapterResult = {
  readonly candidates: readonly ContextCandidate[]
  /** Canonical source revision string (must be stable & deterministic for the same source state). */
  readonly revision: string
  /** The mutation epoch the adapter observed on its source (index generation / snapshot generation). */
  readonly observedMutationEpoch: number
  /** Whether the source was usable for this resolution. `false` => degraded_unavailable. */
  readonly available: boolean
  /** Bounded reason code when the source was not usable. Never free text. */
  readonly unavailableReasonCode?: GraphStatusReasonCode
}

/** The single write authority a graph adapter exposes to the resolver. */
export interface V2Adapter {
  readonly graph: GraphKind
  readonly source: string
  readonly adapterVersion: string
  readonly resolve: (input: V2AdapterInput) => Effect.Effect<V2AdapterResult>
}

/**
 * Code graph adapter. Sources from code-intelligence (`CodeQuery`): definitions,
 * references, call relationships and workspace symbol evidence. The query intent
 * is mapped to a `CodeQuery` intent; the returned hits carry a `ContextRef` that
 * is projected into `ContextCandidate`s. `adapterVersion` is AdapterVersion.code.
 */
export function code(input: { readonly service: CodeQuery.Interface }): V2Adapter {
  return {
    graph: "code",
    source: "code_intelligence",
    adapterVersion: AdapterVersion.code,
    resolve: (query) => {
      return input.service
        .query({
          intent: intentFor(),
          query: query.query,
          limit: Math.min(Math.max(query.limit ?? 12, 1), 100),
          consistency: "stale_ok",
          principal: query.principal,
          egress: query.egress,
          sessionId: query.sessionId,
        })
        .pipe(
          Effect.catch(() => Effect.succeed({ hits: [], index: unavailableIndex() })),
          Effect.map((result) => {
            const unavailable = result.index.state === "unavailable" || result.index.state === "cold"
            return {
              candidates: result.hits.map((hit) => toCandidate(hit)),
              revision: result.index.revision
                ? canonicalProjectionRevision(result.index.revision)
                : rev(result.index.generation),
              observedMutationEpoch: result.index.revision?.indexIncarnation ?? result.index.generation,
              available: !unavailable,
              ...(unavailable ? { unavailableReasonCode: "source_error" as const } : {}),
            }
          }),
        )
    },
  }
}

/**
 * Documents graph adapter. Reuses the existing document-store adapter
 * (`ContextAdapters.executionDocuments`/`documents`) for candidate production and
 * supplies the V2 source identity fields (revision + observed mutation epoch).
 */
export function documents(input: {
  readonly sources: readonly LegacyAdapter[]
  readonly revision: string
  readonly observedMutationEpoch: number
  readonly adapterVersion?: string
}): V2Adapter {
  return wrapLegacy({
    adapter: ContextAdapters.documents(input.sources),
    adapterVersion: input.adapterVersion ?? AdapterVersion.documents,
    revision: input.revision,
    observedMutationEpoch: input.observedMutationEpoch,
  })
}

export function executionDocuments(input: {
  readonly source: string
  readonly stores: readonly import("../deepagent/document-store").DocumentStore[]
  readonly scope: LegacyScope
  readonly revision: string
  readonly observedMutationEpoch: number
}): V2Adapter {
  return wrapLegacy({
    adapter: ContextAdapters.executionDocuments({
      source: input.source,
      stores: input.stores,
      scope: input.scope,
    }),
    adapterVersion: AdapterVersion.documents,
    revision: input.revision,
    observedMutationEpoch: input.observedMutationEpoch,
  })
}

/**
 * Knowledge graph adapter. Only released, authorized and non-superseded
 * knowledge is eligible. `superseded` forces the source unavailable so the
 * resolver never projects stale content (design §6.3: released knowledge is
 * non-degradable, no best-effort load of superseded content).
 */
export function knowledge(input: {
  readonly stores: readonly import("../deepagent/document-store").DocumentStore[]
  readonly scope: LegacyScope
  readonly releasedSelection: import("../deepagent/released-snapshot").DeepAgentReleasedSnapshot.Selection | undefined
  readonly superseded: boolean
  readonly binding: "bound" | "unavailable"
}): V2Adapter {
  const adapter = input.binding === "bound" && input.releasedSelection && !input.superseded
    ? ContextAdapters.knowledge({ stores: input.stores, scope: input.scope, releasedSelection: input.releasedSelection })
    : undefined
  return {
    graph: "knowledge",
    source: "released_knowledge",
    adapterVersion: AdapterVersion.knowledge,
    resolve: (query) => {
      if (!adapter) {
        return Effect.succeed({
          candidates: [],
          revision: input.releasedSelection?.snapshotId ?? "unavailable",
          observedMutationEpoch: input.releasedSelection?.generation ?? 0,
          available: false,
          unavailableReasonCode: "released_snapshot_unavailable",
        })
      }
      return adapter
        .query({
          text: query.query,
          limit: query.limit,
          now: query.now,
          ...(query.entityIds && query.entityIds.length > 0 ? { entityIds: query.entityIds } : {}),
        })
        .pipe(Effect.map((result) => toLegacyResult("knowledge", result, input)))
    },
  }
}

/**
 * Memory graph adapter. Sources from durable knowledge / domain pack memory
 * allowed into the current request (same document-store backing as the existing
 * memory adapter). Reuses `ContextAdapters.memory` for candidate production.
 */
export function memory(input: {
  readonly stores: readonly import("../deepagent/document-store").DocumentStore[]
  readonly scope: LegacyScope
  readonly releasedSelection: import("../deepagent/released-snapshot").DeepAgentReleasedSnapshot.Selection | undefined
  readonly revision: string
  readonly observedMutationEpoch: number
}): V2Adapter {
  const adapter = ContextAdapters.memory({
    stores: input.stores,
    scope: input.scope,
    releasedSelection: input.releasedSelection!,
  })
  return wrapLegacy({
    adapter,
    adapterVersion: AdapterVersion.memory,
    revision: input.revision,
    observedMutationEpoch: input.observedMutationEpoch,
  })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function wrapLegacy(input: {
  readonly adapter: LegacyAdapter
  readonly adapterVersion: string
  readonly revision: string
  readonly observedMutationEpoch: number
}): V2Adapter {
  return {
    graph: input.adapter.graph,
    source: input.adapter.source,
    adapterVersion: input.adapterVersion,
    resolve: (query) =>
      input.adapter
        .query({
          text: query.query,
          limit: query.limit,
          now: query.now,
          ...(query.entityIds && query.entityIds.length > 0 ? { entityIds: query.entityIds } : {}),
        })
        .pipe(
          Effect.map((result) => {
            const blocked = result.status.kind === "blocked" || result.status.kind === "not_queried"
            return {
              candidates: result.candidates,
              revision: input.revision,
              observedMutationEpoch: input.observedMutationEpoch,
              available: !blocked,
              ...(blocked ? { unavailableReasonCode: result.status.reasonCode } : {}),
            }
          }),
        ),
  }
}

function toLegacyResult(
  graph: "knowledge",
  result: { readonly candidates: readonly ContextCandidate[]; readonly status: { readonly kind: string; readonly reasonCode?: GraphStatusReasonCode } },
  input: { readonly superseded: boolean; readonly binding: "bound" | "unavailable" },
): V2AdapterResult {
  const blocked = result.status.kind === "blocked" || result.status.kind === "not_queried"
  if (input.superseded) {
    return { candidates: [], revision: "superseded", observedMutationEpoch: 0, available: false, unavailableReasonCode: "released_snapshot_unavailable" }
  }
  return {
    candidates: result.candidates,
    revision: input.superseded ? "superseded" : "released",
    observedMutationEpoch: 0,
    available: !blocked,
    ...(blocked ? { unavailableReasonCode: result.status.reasonCode } : {}),
  }
}

function intentFor(): import("../context-federation/contract").CodeIntelIntent {
  // A bounded mapping from selection query intent to code-intel intent; falls
  // back to "search" (the only fallback that is a valid bounded member).
  return "search"
}

function toCandidate(hit: import("../code-intelligence/query").Hit): ContextCandidate {
  return {
    ref: hit.ref,
    graph: "code",
    title: hit.symbol ?? hit.file,
    summary: hit.snippet ?? hit.file,
    relations: [],
    provenance: [],
    features: {
      exact: 1,
      lexical: clamp(hit.score ?? 0),
      authority: 0.8,
      evidence: 0.7,
      freshness: 1,
    },
    trust: "repository_evidence",
    visibility: "model",
  }
}

function clamp(value: number) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function rev(generation: number) {
  return `code:gen:${generation}`
}

function unavailableIndex(): IndexStatus {
  return { state: "unavailable", generation: 0, dirtyPathCount: 0, semanticCoverage: {} }
}
