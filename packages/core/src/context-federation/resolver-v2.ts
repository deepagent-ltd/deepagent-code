export * as SessionContextResolverV2 from "./resolver-v2"

import { Context, Effect, Layer, Schema } from "effect"
import { Hash } from "../util/hash"
import { CanonicalJson } from "../util/canonical-json"
import {
  GraphStatus as GraphStatusSchema,
  type GraphKind,
  type GraphStatus,
  type GraphStatusReasonCode,
  type SelectionAgentPolicy,
  type SelectionLocation,
  type SelectionMembership,
  type SelectionModelCapability,
  type SelectionProjectScope,
  type SelectionQueryIntent,
  type SelectionReleasedKnowledge,
  type SelectionSecurityNamespace,
  type SelectionWorkspace,
} from "../contract/selection"
import { ContextAuthorization, type EgressPolicy, type Principal } from "./authorization"
import { type ContextCandidate } from "./federation"
import { canonicalContextRef, LocationKey, ProjectScopeKey, SecurityNamespaceID } from "./reference"
import { type V2Adapter, type V2AdapterInput } from "./adapters-v2"

/** Stable graph iteration/authority order for deterministic output (design §6.1). */
export const GraphOrder = ["code", "documents", "knowledge", "memory"] as const

/**
 * Typed successor-rebuild signal produced by a resolution when an authority
 * input drifted (design §6.3: authz / location epoch / source fingerprint /
 * released snapshot drift -> selection successor before dispatch). The ACTUAL
 * successor write is C3-05; here we only surface the typed mismatch result.
 */
export type SuccessorRebuildSignal = {
  readonly trigger:
    | "authorization_epoch_drift"
    | "location_mutation_epoch_drift"
    | "source_fingerprint_drift"
    | "released_snapshot_drift"
  readonly expected: string
  readonly observed: string
}

/**
 * Query envelope (design §6.1 / worklist C3-01). Location-scoped: the resolver is
 * bound to `location.locationKey`. Carries session/activity/input membership,
 * Location, principal, workspace, security namespace, project scope, egress,
 * agent policy, model capability, released knowledge snapshot identity and query
 * intent. `refBudget`/`tokenBudget`/`limit` are typed bounded placeholders for
 * C3-04 deterministic ordering + budget.
 */
export type QueryEnvelope = {
  readonly membership: SelectionMembership
  readonly location: SelectionLocation
  readonly principal: Principal
  readonly workspace: SelectionWorkspace
  readonly securityNamespace: SelectionSecurityNamespace
  readonly projectScope: SelectionProjectScope
  readonly egress: EgressPolicy
  readonly agentPolicy: SelectionAgentPolicy
  readonly modelCapability: SelectionModelCapability
  readonly releasedKnowledge: SelectionReleasedKnowledge
  readonly queryIntent: SelectionQueryIntent
  readonly query: string
  readonly ref?: string
  readonly entityIds?: readonly string[]
  /** Max candidate refs to select (budget placeholder for C3-04). */
  readonly limit?: number
  /** Max encoded token budget placeholder for C3-04. */
  readonly tokenBudget?: number
  /** Max reference count budget placeholder for C3-04. */
  readonly refBudget?: number
  /** The observed Location mutation epoch the resolution runs against. */
  readonly observedLocationMutationEpoch?: number
  /** Optional prior committed location epoch for drift detection. */
  readonly expectedLocationMutationEpoch?: number
  /** Optional prior committed authorization epoch for drift detection. */
  readonly expectedAuthorizationEpoch?: number
  /** Monotonic timestamp for status latency accounting. */
  readonly now?: number
}

/** Per-graph resolution output: the graph's status plus the candidates it produced. */
export type GraphResultV2 = {
  readonly graph: GraphKind
  readonly status: GraphStatus
  readonly candidates: readonly ContextCandidate[]
}

/**
 * Deterministic resolution result. Every invocation produces all four graph
 * statuses explicitly (never a v2-none/absent default). `results` is ordered by
 * GraphOrder; `candidates` is ordered by canonical ContextRef.
 */
export type QueryResultV2 = {
  readonly queryFingerprint: string
  readonly authorizationFingerprint: string
  readonly executionFingerprint: string
  readonly membership: SelectionMembership
  readonly location: SelectionLocation
  readonly results: readonly GraphResultV2[]
  readonly graphStatuses: Readonly<Record<GraphKind, GraphStatus>>
  readonly candidates: readonly ContextCandidate[]
  readonly successorRebuild: SuccessorRebuildSignal | undefined
  readonly truncated: boolean
  readonly truncatedCount: number
}

/**
 * The single production selection writer entry (design §6.1). Location-scoped;
 * no legacy fallback, no dual writer, no UI-derived authority. A V2 attempt is
 * always backed by the four real graph statuses returned by `resolve`.
 */
export interface Interface {
  readonly resolve: (envelope: QueryEnvelope) => Effect.Effect<QueryResultV2>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SessionContextResolverV2") {}

export function layer(config: {
  readonly adapters: Readonly<Record<GraphKind, V2Adapter>>
  readonly perGraphTimeoutMs: number
}) {
  if (!Number.isSafeInteger(config.perGraphTimeoutMs) || config.perGraphTimeoutMs <= 0) throw new Error("invalid timeout")
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({ resolve: (envelope) => resolveGraphs(envelope, config.adapters, config.perGraphTimeoutMs) })
    }),
  )
}

/**
 * Resolve an envelope across all four graphs, in parallel, with per-graph
 * isolation + bounded timeout. Produces four explicit statuses; the single
 * writer entry has no legacy fallback (a graph with no adapter is an explicit
 * degraded_unavailable, never silently absent / v2-none).
 */
export const resolveGraphs = Effect.fn("SessionContextResolverV2.resolveGraphs")(
  function* (
    envelope: QueryEnvelope,
    adapters: Readonly<Record<GraphKind, V2Adapter | undefined>>,
    perGraphTimeoutMs: number,
  ) {
    const startedAt = Date.now()
    const resolved = yield* Effect.forEach(
      GraphOrder,
      (graph) => resolveGraph(envelope, graph, adapters[graph], perGraphTimeoutMs, startedAt),
      { concurrency: "unbounded" },
    )
    const graphStatuses = Object.fromEntries(
      resolved.map((entry) => [entry.graph, entry.status]),
    ) as Record<GraphKind, GraphStatus>
    const successors = resolved.flatMap((entry) => (entry.successor ? [entry.successor] : []))
    const candidates = resolved.flatMap((entry) => entry.candidates).toSorted(compareCandidates)
    return {
      queryFingerprint: queryFingerprint(envelope),
      authorizationFingerprint: ContextAuthorization.fingerprint(envelope.principal, envelope.egress),
      executionFingerprint: executionFingerprint(envelope),
      membership: envelope.membership,
      location: envelope.location,
      results: resolved.map((entry) => ({
        graph: entry.graph,
        status: entry.status,
        candidates: entry.candidates,
      })),
      graphStatuses,
      candidates,
      successorRebuild: pickSuccessor(successors),
      truncated: false,
      truncatedCount: 0,
    }
  },
)

function resolveGraph(
  envelope: QueryEnvelope,
  graph: GraphKind,
  adapter: V2Adapter | undefined,
  perGraphTimeoutMs: number,
  startedAt: number,
): Effect.Effect<{ readonly graph: GraphKind; readonly status: GraphStatus; readonly candidates: readonly ContextCandidate[]; readonly successor?: SuccessorRebuildSignal }> {
  const denial = graphDenial(envelope, graph)
  if (denial) {
    return Effect.succeed({
      graph,
      status: buildStatus({
        graph,
        state: "denied",
        reasonCode: denial.reasonCode,
        observedMutationEpoch: envelope.observedLocationMutationEpoch ?? 0,
        latencyMs: elapsed(startedAt),
        candidateCount: 0,
        adapterVersion: adapter?.adapterVersion ?? "unavailable",
        revision: "",
      }),
      candidates: [],
    })
  }
  if (!adapter) {
    return Effect.succeed({
      graph,
      status: buildStatus({
        graph,
        state: "degraded_unavailable",
        reasonCode: "source_disabled",
        observedMutationEpoch: envelope.observedLocationMutationEpoch ?? 0,
        latencyMs: elapsed(startedAt),
        candidateCount: 0,
        adapterVersion: "unavailable",
        revision: "",
      }),
      candidates: [],
    })
  }
  return adapter
    .resolve(toAdapterInput(envelope))
    .pipe(
      Effect.timeout(perGraphTimeoutMs),
      Effect.catch(() =>
        Effect.succeed({
          candidates: [] as readonly ContextCandidate[],
          revision: "",
          observedMutationEpoch: 0,
          available: false,
          unavailableReasonCode: "source_timeout" as const,
        }),
      ),
      Effect.map((result) => finalizeGraph(envelope, adapter, result, startedAt)),
    )
}

function finalizeGraph(
  envelope: QueryEnvelope,
  adapter: V2Adapter,
  result: { readonly candidates: readonly ContextCandidate[]; readonly revision: string; readonly observedMutationEpoch: number; readonly available: boolean; readonly unavailableReasonCode?: GraphStatusReasonCode },
  startedAt: number,
): { readonly graph: GraphKind; readonly status: GraphStatus; readonly candidates: readonly ContextCandidate[]; readonly successor?: SuccessorRebuildSignal } {
  const candidates = result.candidates.filter((item) =>
    ContextAuthorization.authorizeScope(item.ref, envelope.principal).allowed,
  )
  const state =
    result.unavailableReasonCode === "source_timeout"
      ? "timeout"
      : !result.available
        ? "degraded_unavailable"
        : candidates.length === 0
          ? "empty"
          : "ready"
  const reasonCode =
    state === "timeout"
      ? "source_timeout"
      : state === "degraded_unavailable"
        ? result.unavailableReasonCode ?? "source_error"
        : state === "empty"
          ? "none"
          : "none"
  const successor = SuccessorFor(adapter.graph, envelope, result, state)
  return {
    graph: adapter.graph,
    status: buildStatus({
      graph: adapter.graph,
      state,
      reasonCode,
      observedMutationEpoch: result.observedMutationEpoch,
      latencyMs: elapsed(startedAt),
      candidateCount: candidates.length,
      adapterVersion: adapter.adapterVersion,
      revision: result.revision,
    }),
    candidates,
    ...(successor ? { successor } : {}),
  }
}

function SuccessorFor(
  graph: GraphKind,
  envelope: QueryEnvelope,
  result: { readonly available: boolean; readonly revision: string; readonly unavailableReasonCode?: GraphStatusReasonCode },
  state: "ready" | "empty" | "degraded_unavailable" | "timeout",
): SuccessorRebuildSignal | undefined {
  const signals: SuccessorRebuildSignal[] = []
  if (
    envelope.expectedAuthorizationEpoch !== undefined &&
    envelope.expectedAuthorizationEpoch !== envelope.principal.authorizationEpoch
  ) {
    signals.push({
      trigger: "authorization_epoch_drift",
      expected: String(envelope.expectedAuthorizationEpoch),
      observed: String(envelope.principal.authorizationEpoch),
    })
  }
  if (
    envelope.expectedLocationMutationEpoch !== undefined &&
    envelope.expectedLocationMutationEpoch !== envelope.observedLocationMutationEpoch
  ) {
    signals.push({
      trigger: "location_mutation_epoch_drift",
      expected: String(envelope.expectedLocationMutationEpoch),
      observed: String(envelope.observedLocationMutationEpoch ?? 0),
    })
  }
  if (graph === "knowledge" && state === "degraded_unavailable") {
    signals.push({
      trigger: "released_snapshot_drift",
      expected: envelope.releasedKnowledge.snapshotId,
      observed: result.revision || "unavailable",
    })
  }
  return pickSuccessor(signals)
}

function pickSuccessor(signals: readonly SuccessorRebuildSignal[]): SuccessorRebuildSignal | undefined {
  return signals[0]
}

// ---------------------------------------------------------------------------
// envelope helpers
// ---------------------------------------------------------------------------

function toAdapterInput(envelope: QueryEnvelope): V2AdapterInput {
  return {
    query: envelope.query,
    ...(envelope.entityIds && envelope.entityIds.length > 0 ? { entityIds: envelope.entityIds } : {}),
    limit: envelope.limit,
    now: envelope.now ?? Date.now(),
    sessionId: envelope.membership.sessionId,
    securityNamespaceId: SecurityNamespaceID.make(envelope.securityNamespace.securityNamespaceId),
    locationKey: envelope.location.locationKey,
    projectScopeKey: ProjectScopeKey.make(envelope.projectScope.projectScopeKey),
    legacyProjectId: envelope.projectScope.projectId ?? envelope.projectScope.projectScopeKey,
    subjectId: envelope.principal.principalId,
    principal: envelope.principal,
    egress: envelope.egress,
  }
}

function graphDenial(envelope: QueryEnvelope, graph: GraphKind): { readonly reasonCode: GraphStatusReasonCode } | undefined {
  const p = envelope.principal
  if (p.securityNamespaceId !== envelope.securityNamespace.securityNamespaceId) {
    return { reasonCode: "security_namespace_denied" }
  }
  if (!p.locationKeys.includes(LocationKey.make(envelope.location.locationKey))) return { reasonCode: "scope_denied" }
  if (!p.projectScopeKeys.includes(ProjectScopeKey.make(envelope.projectScope.projectScopeKey))) {
    return { reasonCode: "project_scope_denied" }
  }
  if (!envelope.egress.graphs.includes(graph)) return { reasonCode: "provider_egress_denied" }
  return undefined
}

function buildStatus(input: {
  readonly graph: GraphKind
  readonly state: "ready" | "empty" | "degraded_unavailable" | "denied" | "timeout"
  readonly reasonCode: GraphStatusReasonCode
  readonly revision: string
  readonly adapterVersion: string
  readonly observedMutationEpoch: number
  readonly latencyMs: number
  readonly candidateCount: number
}): GraphStatus {
  return decodeStatus({
    graph: input.graph,
    status: input.state,
    revision: input.revision,
    adapterVersion: input.adapterVersion,
    observedMutationEpoch: input.observedMutationEpoch,
    latencyMs: input.latencyMs,
    candidateCount: input.candidateCount,
    reasonCode: input.reasonCode,
  })
}

const decodeStatus = Schema.decodeUnknownSync(GraphStatusSchema, { onExcessProperty: "error" })

// ---------------------------------------------------------------------------
// fingerprint helpers (deterministic, clock/abs-path independent)
// ---------------------------------------------------------------------------

function queryFingerprint(envelope: QueryEnvelope) {
  return Hash.sha256(
    CanonicalJson.stringify({
      membership: envelope.membership,
      location: envelope.location,
      queryIntent: envelope.queryIntent,
      query: envelope.query,
      ref: envelope.ref ?? null,
      entityIds: (envelope.entityIds ?? []).toSorted(),
      budget: {
        limit: envelope.limit ?? null,
        tokenBudget: envelope.tokenBudget ?? null,
        refBudget: envelope.refBudget ?? null,
      },
    }),
  )
}

function executionFingerprint(envelope: QueryEnvelope) {
  return Hash.sha256(
    CanonicalJson.stringify({
      model: envelope.modelCapability,
      agentPolicy: { agentId: envelope.agentPolicy.agentId, autonomyCeiling: envelope.agentPolicy.autonomyCeiling },
      releasedKnowledge: { snapshotId: envelope.releasedKnowledge.snapshotId, binding: envelope.releasedKnowledge.binding },
    }),
  )
}

function elapsed(startedAt: number) {
  return Math.max(0, Date.now() - startedAt)
}

function compareCandidates(a: ContextCandidate, b: ContextCandidate) {
  return canonicalContextRef(a.ref).localeCompare(canonicalContextRef(b.ref))
}
