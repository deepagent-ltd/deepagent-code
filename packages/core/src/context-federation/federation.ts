export * as ContextFederation from "./federation"

import { Schema } from "effect"
import { ContextRef, canonicalContextRef } from "./reference"
import { GraphKind, type GraphKind as Graph } from "./contract"

export const GraphQueryReasonCode = Schema.Literals([
  "cold_start",
  "bootstrap_complete_no_match",
  "bootstrap_budget_exhausted",
  "bootstrap_timeout",
  "fresh_timeout",
  "refresh_failed",
  "parser_unsupported",
  "lsp_unavailable",
  "overlay_unavailable",
  "scope_denied",
  "provider_egress_denied",
  "source_timeout",
  "source_error",
  "partial_sources",
  "source_disabled",
  "link_refresh_pending",
  "released_snapshot_unavailable",
])
export type GraphQueryReasonCode = typeof GraphQueryReasonCode.Type

const ReadySourceRevision = Schema.Struct({
  source: Schema.String,
  revision: Schema.String,
  state: Schema.Literal("ready"),
})
const AbnormalSourceRevision = Schema.Struct({
  source: Schema.String,
  revision: Schema.String.pipe(Schema.optional),
  state: Schema.Literals(["cold", "indexing", "stale", "degraded", "unavailable", "denied"]),
  reasonCode: GraphQueryReasonCode,
})
export const GraphSourceRevision = Schema.Union([ReadySourceRevision, AbnormalSourceRevision])
export type GraphSourceRevision = typeof GraphSourceRevision.Type

const StatusBase = {
  graph: GraphKind,
  revisions: Schema.Array(GraphSourceRevision),
  capabilities: Schema.Array(Schema.String).pipe(Schema.optional),
}
const CompleteMatched = Schema.Struct({
  ...StatusBase,
  kind: Schema.Literal("complete"),
  state: Schema.Literal("ready"),
  outcome: Schema.Literal("matched"),
})
const CompleteEmpty = Schema.Struct({
  ...StatusBase,
  kind: Schema.Literal("complete"),
  state: Schema.Literal("ready"),
  outcome: Schema.Literal("empty"),
  reasonCode: Schema.Literal("bootstrap_complete_no_match").pipe(Schema.optional),
})
const Partial = Schema.Struct({
  ...StatusBase,
  kind: Schema.Literal("partial"),
  state: Schema.Literals(["cold", "indexing", "stale", "degraded"]),
  outcome: Schema.Literal("partial"),
  reasonCode: GraphQueryReasonCode,
})
const Blocked = Schema.Struct({
  ...StatusBase,
  kind: Schema.Literal("blocked"),
  state: Schema.Literals(["unavailable", "denied"]),
  outcome: Schema.Literal("not_queried"),
  reasonCode: GraphQueryReasonCode,
})
const NotQueried = Schema.Struct({
  graph: GraphKind,
  revisions: Schema.Tuple([]),
  capabilities: Schema.Array(Schema.String).pipe(Schema.optional),
  kind: Schema.Literal("not_queried"),
  state: Schema.Literal("not_queried"),
  outcome: Schema.Literal("not_queried"),
  reasonCode: Schema.Literal("source_disabled"),
})
export const GraphQueryStatus = Schema.Union([CompleteMatched, CompleteEmpty, Partial, Blocked, NotQueried])
export type GraphQueryStatus = typeof GraphQueryStatus.Type

const UnitInterval = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
export const ContextCandidate = Schema.Struct({
  ref: ContextRef,
  graph: GraphKind,
  title: Schema.String,
  summary: Schema.String,
  relations: Schema.Array(Schema.Struct({ relation: Schema.String, ref: ContextRef })),
  provenance: Schema.Array(ContextRef),
  features: Schema.Struct({
    exact: UnitInterval,
    lexical: UnitInterval,
    graphDistance: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
    authority: UnitInterval,
    evidence: UnitInterval,
    freshness: UnitInterval,
    recency: UnitInterval.pipe(Schema.optional),
  }),
  trust: Schema.Literals(["governed_guidance", "repository_evidence", "historical_evidence", "runtime_evidence"]),
  visibility: Schema.Literals(["model", "reference_only", "governance_only"]),
})
export type ContextCandidate = typeof ContextCandidate.Type

export type QueryPlan = {
  readonly signals: readonly string[]
  readonly weights: Readonly<Record<Graph, number>>
}

export type RankedCandidate = {
  readonly candidate: ContextCandidate
  readonly score: number
  readonly support: number
}

export class InvalidCandidateError extends Schema.TaggedErrorClass<InvalidCandidateError>()(
  "ContextFederation.InvalidCandidateError",
  { reason: Schema.String },
) {}

const decodeStatus = Schema.decodeUnknownSync(GraphQueryStatus, { onExcessProperty: "error" })
const decodeCandidate = Schema.decodeUnknownSync(ContextCandidate, { onExcessProperty: "error" })

export const status = {
  matched: (graph: Graph, revisions: readonly GraphSourceRevision[], capabilities?: readonly string[]) =>
    decodeStatus({
      graph,
      kind: "complete",
      state: "ready",
      outcome: "matched",
      revisions,
      ...(capabilities ? { capabilities } : {}),
    }),
  empty: (
    graph: Graph,
    revisions: readonly GraphSourceRevision[],
    options?: { readonly bootstrapComplete?: boolean; readonly capabilities?: readonly string[] },
  ) =>
    decodeStatus({
      graph,
      kind: "complete",
      state: "ready",
      outcome: "empty",
      revisions,
      ...(options?.bootstrapComplete ? { reasonCode: "bootstrap_complete_no_match" } : {}),
      ...(options?.capabilities ? { capabilities: options.capabilities } : {}),
    }),
  partial: (input: {
    readonly graph: Graph
    readonly state: "cold" | "indexing" | "stale" | "degraded"
    readonly reasonCode: GraphQueryReasonCode
    readonly revisions: readonly GraphSourceRevision[]
    readonly capabilities?: readonly string[]
  }) => decodeStatus({ ...input, kind: "partial", outcome: "partial" }),
  blocked: (input: {
    readonly graph: Graph
    readonly state: "unavailable" | "denied"
    readonly reasonCode: GraphQueryReasonCode
    readonly revisions: readonly GraphSourceRevision[]
    readonly capabilities?: readonly string[]
  }) => decodeStatus({ ...input, kind: "blocked", outcome: "not_queried" }),
  notQueried: (graph: Graph) =>
    decodeStatus({
      graph,
      kind: "not_queried",
      state: "not_queried",
      outcome: "not_queried",
      revisions: [],
      reasonCode: "source_disabled",
    }),
} as const

export function candidate(input: ContextCandidate) {
  const value = decodeCandidate(input)
  if (value.graph !== value.ref.graph) {
    throw new InvalidCandidateError({ reason: "candidate graph must match ref graph" })
  }
  return value
}

export function queryPlan(input: { readonly text: string; readonly hasExplicitRef?: boolean }): QueryPlan {
  const text = input.text.toLowerCase()
  const signals = [
    ...(input.hasExplicitRef ? ["explicit_ref"] : []),
    ...(/(?:\b(?:src|lib|test)\/|\.[cm]?[jt]sx?\b|\b(?:class|function|method|symbol|stack|call|depend|import)\b)/.test(
      text,
    )
      ? ["code"]
      : []),
    ...(/\b(?:requirement|adr|design|plan|decision|runbook|test evidence)\b/.test(text) ? ["documents"] : []),
    ...(/\b(?:previous|before|last time|remember|preference|handoff|resume)\b/.test(text) ? ["memory"] : []),
    ...(/\b(?:best practice|principle|methodology|guidance|architecture)\b/.test(text) ? ["knowledge"] : []),
    ...(/\b(?:bug|regression|failure|diagnos)\w*\b/.test(text) ? ["failure"] : []),
  ]
  return {
    signals,
    weights: {
      code: 1 + (signals.includes("code") ? 1 : 0) + (signals.includes("failure") ? 0.5 : 0),
      documents: 1 + (signals.includes("documents") ? 1 : 0) + (signals.includes("failure") ? 0.25 : 0),
      knowledge: 1 + (signals.includes("knowledge") ? 1 : 0) + (signals.includes("failure") ? 0.25 : 0),
      memory: 1 + (signals.includes("memory") ? 1 : 0) + (signals.includes("failure") ? 0.25 : 0),
    },
  }
}

export function rank(
  lists: Readonly<Partial<Record<Graph, readonly ContextCandidate[]>>>,
  input: { readonly weights: Readonly<Record<Graph, number>>; readonly toolCall: boolean; readonly limit?: number },
): readonly RankedCandidate[] {
  const fused = new Map<string, { candidate: ContextCandidate; rrf: number; support: number }>()
  for (const graph of GraphKind.literals) {
    for (const [index, item] of (lists[graph] ?? []).entries()) {
      const key = canonicalContextRef(item.ref)
      const existing = fused.get(key)
      const rrf = input.weights[graph] / (60 + index + 1)
      if (!existing) {
        fused.set(key, { candidate: item, rrf, support: 1 })
        continue
      }
      fused.set(key, {
        candidate: authority(item) > authority(existing.candidate) ? item : existing.candidate,
        rrf: existing.rrf + rrf,
        support: existing.support + 1,
      })
    }
  }
  const limit = Math.min(Math.max(input.limit ?? (input.toolCall ? 8 : 14), 1), 100)
  const graphCaps: Readonly<Record<Graph, number>> = input.toolCall && input.limit === undefined
    ? { code: 4, documents: 3, knowledge: 2, memory: 2 }
    : input.limit === undefined
      ? { code: 7, documents: 5, knowledge: 4, memory: 4 }
      : { code: limit, documents: limit, knowledge: limit, memory: limit }
  const counts: Record<Graph, number> = { code: 0, documents: 0, knowledge: 0, memory: 0 }
  return [...fused.values()]
    .map((item) => ({
      candidate: item.candidate,
      support: item.support,
      score:
        item.rrf +
        item.candidate.features.exact * 0.1 +
        item.candidate.features.authority * 0.04 +
        item.candidate.features.evidence * 0.03 +
        item.candidate.features.freshness * 0.02 +
        Math.min(item.support - 1, 2) * 0.015,
    }))
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        b.support - a.support ||
        canonicalContextRef(a.candidate.ref).localeCompare(canonicalContextRef(b.candidate.ref)),
    )
    .filter((item) => {
      if (item.candidate.visibility !== "model" || counts[item.candidate.graph] >= graphCaps[item.candidate.graph]) {
        return false
      }
      counts[item.candidate.graph]++
      return true
    })
    .slice(0, limit)
}

function authority(value: ContextCandidate) {
  return value.features.authority + value.features.evidence + value.features.freshness
}
