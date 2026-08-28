import { describe, expect, test } from "bun:test"
import { batchDigest, budgetSelection, type SelectionCandidateBatch } from "../../src/context-federation/selection-budget"
import { type QueryEnvelope } from "../../src/context-federation/resolver-v2"
import { type QueryResultV2 } from "../../src/context-federation/resolver-v2"
import { ContextCandidate, ContextFederation } from "../../src/context-federation/federation"
import {
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
  type ContextRef,
} from "../../src/context-federation/reference"
import { type GraphKind, type GraphStatus } from "../../src/contract/selection"

const ns = SecurityNamespaceID.make("sec_budget_test")
const proj = ProjectScopeKey.make("prj_budget_test")
const loc = LocationKey.make("loc_budget_test")

const principal = {
  securityNamespaceId: ns,
  principalId: "principal-budget",
  authorizationEpoch: 1,
  locationKeys: [loc],
  projectScopeKeys: [proj],
  sessionIds: ["ses_budget"],
  subjectIds: ["subject-budget"],
  allowBuiltin: false,
}

const egress = {
  policyId: "provider-budget",
  epoch: 1,
  graphs: ["code", "documents", "knowledge", "memory"] as const,
  sensitivities: ["public", "source_code"] as const,
}

function envelope(overrides?: Partial<QueryEnvelope>): QueryEnvelope {
  return {
    membership: { sessionId: "ses_budget", activityId: "act_budget", inputIds: ["in_budget"] },
    location: { locationKey: loc },
    principal,
    workspace: { workspaceId: "ws_budget" },
    securityNamespace: { securityNamespaceId: ns },
    projectScope: { projectScopeKey: proj, projectId: "legacy-project" },
    egress,
    agentPolicy: { agentId: "agent-budget", autonomyCeiling: "medium", permitDegraded: false },
    modelCapability: { modelId: "model-budget", providerId: "provider-budget", protocol: "openai.responses", contextWindow: 128_000, structuredOutput: true },
    releasedKnowledge: { snapshotId: "snapshot-budget", binding: "bound" },
    queryIntent: "search",
    query: "budget the selection",
    limit: 12,
    observedLocationMutationEpoch: 0,
    ...overrides,
  }
}

function status(graph: GraphKind, state: GraphStatus["status"], revision: string, candidateCount: number): GraphStatus {
  return {
    graph,
    status: state,
    revision,
    adapterVersion: `${graph}.v1`,
    observedMutationEpoch: candidateCount,
    latencyMs: 1,
    candidateCount,
    reasonCode: state === "ready" ? "none" : state === "denied" ? "scope_denied" : "none",
  }
}

/** Build a valid QueryResultV2 from a candidate list (statuses derived from the candidates). */
function result(candidates: readonly ContextCandidate[]): QueryResultV2 {
  const byGraph = new Map<GraphKind, ContextCandidate[]>()
  for (const candidate of candidates) {
    const list = byGraph.get(candidate.ref.graph) ?? []
    list.push(candidate)
    byGraph.set(candidate.ref.graph, list)
  }
  const graphs: GraphKind[] = ["code", "documents", "knowledge", "memory"]
  const results = graphs.map((graph) => ({
    graph,
    status: status(graph, byGraph.get(graph)?.length ? "ready" : "empty", `${graph}:1`, byGraph.get(graph)?.length ?? 0),
    candidates: byGraph.get(graph) ?? [],
  }))
  const graphStatuses = Object.fromEntries(results.map((entry) => [entry.graph, entry.status])) as Record<GraphKind, GraphStatus>
  return {
    queryFingerprint: "qf-budget",
    authorizationFingerprint: "af-budget",
    executionFingerprint: "ef-budget",
    membership: { sessionId: "ses_budget", activityId: "act_budget", inputIds: ["in_budget"] },
    location: { locationKey: loc },
    results,
    graphStatuses,
    candidates,
    successorRebuild: undefined,
    truncated: false,
    truncatedCount: 0,
  }
}

function candidate(input: {
  readonly graph: GraphKind
  readonly entityId: string
  readonly revision?: string
  readonly exact?: number
  readonly authority?: number
  readonly evidence?: number
  readonly trust?: ContextCandidate["trust"]
}): ContextCandidate {
  const ref: ContextRef = {
    graph: input.graph,
    entityId: input.entityId,
    binding: { scope: "location", securityNamespaceId: ns, locationKey: loc, projectScopeKey: proj },
    revision: input.revision ?? `${input.graph}:1`,
  }
  return ContextFederation.candidate({
    ref,
    graph: input.graph,
    title: `${input.entityId} title`,
    summary: `${input.entityId} summary`,
    relations: [],
    provenance: [],
    features: {
      exact: input.exact ?? 0,
      lexical: 1,
      authority: input.authority ?? 0,
      evidence: input.evidence ?? 0,
      freshness: 1,
    },
    trust: input.trust ?? "repository_evidence",
    visibility: "model",
  })
}

function asSortable(batch: SelectionCandidateBatch) {
  return JSON.stringify(batch.selected.map((item) => item.orderingKey))
}

describe("SelectionBudget (C3-04 deterministic ordering + budgets)", () => {
  test("is byte-stable: identical input produces an identical serialized batch", () => {
    const candidates = [
      candidate({ graph: "code", entityId: "a", exact: 1 }),
      candidate({ graph: "documents", entityId: "b", exact: 0.2 }),
      candidate({ graph: "knowledge", entityId: "c", authority: 0.7 }),
    ]
    const a = budgetSelection(result(candidates), envelope())
    const b = budgetSelection(result(candidates), envelope())
    expect(batchDigest(a)).toBe(batchDigest(b))
    expect(asSortable(a)).toBe(asSortable(b))
    expect(a.selected.map((item) => item.orderingKey)).toEqual(b.selected.map((item) => item.orderingKey))
  })

  test("drift: a ref content/order change changes the batch digest (bytes differ)", () => {
    const base = budgetSelection(
      result([candidate({ graph: "code", entityId: "a", exact: 1 }), candidate({ graph: "documents", entityId: "b", exact: 0.2 })]),
      envelope(),
    )
    // Same refs, but one ref's revision changed -> the ordering/budget bytes must differ.
    const drifted = budgetSelection(
      result([candidate({ graph: "code", entityId: "a", exact: 1 }), candidate({ graph: "documents", entityId: "b", exact: 0.2, revision: "documents:2" })]),
      envelope(),
    )
    expect(batchDigest(base)).not.toBe(batchDigest(drifted))
  })

  test("primary ordering is value tier: a few high-value refs beat a large low-value run (non-starvation)", () => {
    const exact = candidate({ graph: "code", entityId: "exact-high", exact: 1, authority: 1, evidence: 1, trust: "governed_guidance" })
    const manyLow = Array.from({ length: 40 }, (_, i) => candidate({ graph: "documents", entityId: `low-${i}`, exact: 0, authority: 0, evidence: 0 }))
    const batch = budgetSelection(result([exact, ...manyLow]), envelope({ limit: 5 }))
    // The single high-value ref must survive any small cap.
    expect(batch.selected.some((item) => item.candidate.ref.entityId === "exact-high")).toBe(true)
    expect(batch.selected[0]!.candidate.ref.entityId).toBe("exact-high")
    expect(batch.refCount).toBe(5)
    expect(batch.truncated).toBe(true)
    expect(batch.truncatedCount).toBe(manyLow.length + 1 - 5)
  })

  test("deterministic secondary key: graph order → revision → id byte-order within a tier", () => {
    const candidates = [
      candidate({ graph: "memory", entityId: "zzz", revision: "mem:1" }),
      candidate({ graph: "documents", entityId: "aaa", revision: "doc:1" }),
      candidate({ graph: "code", entityId: "q", revision: "code:2" }),
      candidate({ graph: "code", entityId: "q", revision: "code:1" }),
    ]
    const batch = budgetSelection(result(candidates), envelope())
    const order = batch.ordered.map((item) => `${item.candidate.ref.graph}-${item.candidate.ref.revision}-${item.candidate.ref.entityId}`)
    expect(order).toEqual(["code-code:1-q", "code-code:2-q", "documents-doc:1-aaa", "memory-mem:1-zzz"])
  })

  test("hard ref budget: limit/refBudget cap the selected ref count", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate({ graph: "code", entityId: `c-${i}`, exact: 0.2 }))
    const batch = budgetSelection(result(candidates), envelope({ limit: 3, refBudget: 3 }))
    expect(batch.refCount).toBe(3)
    expect(batch.selected).toHaveLength(3)
    expect(batch.truncatedCount).toBe(7)
  })

  test("hard token budget: tokenBudget caps the selected encoded token estimate", () => {
    // Each candidate's canonical ref is long enough that 12 refs exceed a small tokenBudget.
    const candidates = Array.from({ length: 20 }, (_, i) => candidate({ graph: "code", entityId: `candidate-with-a-long-entity-id-${i}`, exact: 0.1 }))
    const batch = budgetSelection(result(candidates), envelope({ tokenBudget: 30, limit: 20 }))
    expect(batch.tokenCount).toBeLessThanOrEqual(30)
    expect(batch.selected.length).toBeLessThan(20)
    expect(batch.truncated).toBe(true)
  })

  test("hard artifact budget: per-item and total byte caps drop oversized/low value items", () => {
    const small = candidate({ graph: "code", entityId: "s", exact: 0.5 })
    const big = candidate({ graph: "documents", entityId: "x".repeat(200), exact: 0.2 })
    const batch = budgetSelection(result([small, big]), envelope(), { artifactMaxItemBytes: 100, artifactMaxTotalBytes: 60 })
    // Big item removed by per-item cap; total cap trims further.
    expect(batch.selected.some((item) => item.candidate.ref.entityId === "x".repeat(200))).toBe(false)
    expect(batch.artifactBytes).toBeLessThanOrEqual(60)
    expect(batch.truncated).toBe(true)
  })

  test("ordering rule is the documented value-tier + canonical-key", () => {
    const candidates = [candidate({ graph: "code", entityId: "a", exact: 1 })]
    const batch = budgetSelection(result(candidates), envelope({ limit: 2 }))
    expect(batch.ordering).toEqual({ primary: "value_tier", secondary: "graph_revision_refid_byte_order" })
    expect(batch.refCount).toBe(1)
  })
})
