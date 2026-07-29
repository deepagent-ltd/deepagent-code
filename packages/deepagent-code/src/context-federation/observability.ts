export * as ContextFederationObservability from "./observability"

import type { GraphKind } from "@deepagent-code/core/context-federation/contract"
import type { GraphQueryStatus } from "@deepagent-code/core/context-federation/federation"

const graphs = ["code", "knowledge", "memory", "documents"] as const

type MutableGraphMetrics = {
  queries: number
  candidates: number
  selected: number
  rejected: number
  redacted: number
  latencyMs: number
  maxLatencyMs: number
  lastLatencyMs: number
  lastStatus?: GraphQueryStatus
  lastObservedAt?: number
}

export type GraphMetrics = Readonly<MutableGraphMetrics> & {
  readonly averageLatencyMs: number
}

export type Snapshot = {
  readonly graphs: Readonly<Record<GraphKind, GraphMetrics>>
  readonly selections: number
  readonly tokens: number
  readonly shadow: {
    readonly comparisons: number
    readonly legacyKnowledgeRefs: number
    readonly legacyMemoryRefs: number
    readonly federated: Readonly<Record<GraphKind, number>>
    readonly knowledgeMemoryDelta: number
  }
  readonly alerts: readonly {
    readonly graph: GraphKind
    readonly state: GraphQueryStatus["state"]
    readonly reasonCode: string
  }[]
}

const state = {
  graphs: Object.fromEntries(graphs.map((graph) => [graph, empty()])) as Record<GraphKind, MutableGraphMetrics>,
  selections: 0,
  tokens: 0,
  selectionIds: new Set<string>(),
  shadow: {
    comparisons: 0,
    legacyKnowledgeRefs: 0,
    legacyMemoryRefs: 0,
    federated: Object.fromEntries(graphs.map((graph) => [graph, 0])) as Record<GraphKind, number>,
  },
}

export function observeQuery(input: {
  readonly statuses: readonly GraphQueryStatus[]
  readonly candidates: Readonly<Partial<Record<GraphKind, number>>>
  readonly selected: Readonly<Partial<Record<GraphKind, number>>>
  readonly rejected?: Readonly<Partial<Record<GraphKind, number>>>
  readonly redacted?: Readonly<Partial<Record<GraphKind, number>>>
  readonly latencyMs: number
  readonly observedAt?: number
}) {
  const observedAt = input.observedAt ?? Date.now()
  input.statuses.forEach((status) => {
    const metric = state.graphs[status.graph]
    metric.queries += 1
    metric.candidates += input.candidates[status.graph] ?? 0
    metric.selected += input.selected[status.graph] ?? 0
    metric.rejected += input.rejected?.[status.graph] ?? 0
    metric.redacted += input.redacted?.[status.graph] ?? 0
    metric.latencyMs += input.latencyMs
    metric.maxLatencyMs = Math.max(metric.maxLatencyMs, input.latencyMs)
    metric.lastLatencyMs = input.latencyMs
    metric.lastStatus = status
    metric.lastObservedAt = observedAt
  })
}

export function observeSelection(selectionId: string, tokenCount: number) {
  if (state.selectionIds.has(selectionId)) return
  state.selectionIds.add(selectionId)
  state.selections += 1
  state.tokens += tokenCount
}

export function observeShadowComparison(input: {
  readonly legacyKnowledgeRefs: number
  readonly legacyMemoryRefs: number
  readonly federated: Readonly<Record<GraphKind, number>>
}) {
  state.shadow.comparisons += 1
  state.shadow.legacyKnowledgeRefs += input.legacyKnowledgeRefs
  state.shadow.legacyMemoryRefs += input.legacyMemoryRefs
  graphs.forEach((graph) => {
    state.shadow.federated[graph] += input.federated[graph]
  })
}

export function snapshot(): Snapshot {
  const metrics = Object.fromEntries(
    graphs.map((graph) => {
      const metric = state.graphs[graph]
      return [
        graph,
        {
          ...metric,
          averageLatencyMs: metric.queries === 0 ? 0 : metric.latencyMs / metric.queries,
        },
      ]
    }),
  ) as Record<GraphKind, GraphMetrics>
  return {
    graphs: metrics,
    selections: state.selections,
    tokens: state.tokens,
    shadow: {
      ...state.shadow,
      federated: { ...state.shadow.federated },
      knowledgeMemoryDelta:
        state.shadow.federated.knowledge + state.shadow.federated.memory -
        state.shadow.legacyKnowledgeRefs - state.shadow.legacyMemoryRefs,
    },
    alerts: graphs.flatMap((graph) => {
      const status = metrics[graph].lastStatus
      if (!status || (status.kind === "complete" && status.state === "ready")) return []
      return [{ graph, state: status.state, reasonCode: status.reasonCode }]
    }),
  }
}

export function reset() {
  graphs.forEach((graph) => {
    state.graphs[graph] = empty()
  })
  state.selections = 0
  state.tokens = 0
  state.selectionIds.clear()
  state.shadow.comparisons = 0
  state.shadow.legacyKnowledgeRefs = 0
  state.shadow.legacyMemoryRefs = 0
  graphs.forEach((graph) => {
    state.shadow.federated[graph] = 0
  })
}

function empty(): MutableGraphMetrics {
  return {
    queries: 0,
    candidates: 0,
    selected: 0,
    rejected: 0,
    redacted: 0,
    latencyMs: 0,
    maxLatencyMs: 0,
    lastLatencyMs: 0,
  }
}
