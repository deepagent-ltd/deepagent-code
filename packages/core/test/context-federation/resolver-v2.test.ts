import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionContextResolverV2, type QueryEnvelope } from "../../src/context-federation/resolver-v2"
import { type V2Adapter } from "../../src/context-federation/adapters-v2"
import { ContextCandidate, ContextFederation } from "../../src/context-federation/federation"
import {
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
  type ContextRef,
} from "../../src/context-federation/reference"

const ns = SecurityNamespaceID.make("sec_resolver_v2_test")
const nsB = SecurityNamespaceID.make("sec_resolver_v2_test_b")
const proj = ProjectScopeKey.make("prj_resolver_v2_test")
const loc = LocationKey.make("loc_resolver_v2_test")
const locB = LocationKey.make("loc_resolver_v2_test_b")

const principal = {
  securityNamespaceId: ns,
  principalId: "principal-v2",
  authorizationEpoch: 1,
  locationKeys: [loc],
  projectScopeKeys: [proj],
  sessionIds: ["ses_resolver_v2_test"],
  subjectIds: ["subject-v2"],
  allowBuiltin: false,
}

const egress = {
  policyId: "provider-v2",
  epoch: 1,
  graphs: ["code", "documents", "knowledge", "memory"] as const,
  sensitivities: ["public", "source_code"] as const,
}

function envelope(overrides?: Partial<QueryEnvelope>): QueryEnvelope {
  return {
    membership: { sessionId: "ses_resolver_v2_test", activityId: "act_resolver_v2", inputIds: ["in_resolver_v2"] },
    location: { locationKey: loc },
    principal,
    workspace: { workspaceId: "ws_resolver_v2" },
    securityNamespace: { securityNamespaceId: ns },
    projectScope: { projectScopeKey: proj, projectId: "legacy-project" },
    egress,
    agentPolicy: { agentId: "agent-v2", autonomyCeiling: "medium", permitDegraded: false },
    modelCapability: {
      modelId: "model-v2",
      providerId: "provider-v2",
      protocol: "openai.responses",
      contextWindow: 128_000,
      structuredOutput: true,
    },
    releasedKnowledge: { snapshotId: "snapshot-v2", binding: "bound" },
    queryIntent: "search",
    query: "inspect the code seed",
    limit: 12,
    observedLocationMutationEpoch: 0,
    ...overrides,
  }
}

const allGraphs = ["code", "documents", "knowledge", "memory"] as const

describe("SessionContextResolverV2 (C3-01)", () => {
  test("is the single selection writer: every invocation produces all four explicit statuses, never v2-none", async () => {
    const adapters = fourAdapters({ code: readyAdapter("code"), memory: readyAdapter("memory") })
    const result = await run(envelope(), adapters)
    expect(result.results.map((item) => item.graph)).toEqual([...allGraphs])
    for (const graph of allGraphs) {
      const status = result.graphStatuses[graph]
      expect(status).toBeDefined()
      expect(["ready", "empty", "degraded_unavailable", "denied", "timeout"]).toContain(status.status)
      // design §6.2: revision / adapter version / observed mutation epoch / latency / candidate count / bounded reason code
      expect(status.revision).toBeTypeOf("string")
      expect(status.adapterVersion).toBeTypeOf("string")
      expect(status.observedMutationEpoch).toBeGreaterThanOrEqual(0)
      expect(status.latencyMs).toBeGreaterThanOrEqual(0)
      expect(status.candidateCount).toBeGreaterThanOrEqual(0)
      expect(status.reasonCode).toBeTypeOf("string")
    }
    expect(result.graphStatuses).not.toHaveProperty("code.status", "v2-none")
    expect(result.graphStatuses).not.toHaveProperty("documents.status", "v2-none")
    expect(result.graphStatuses).not.toHaveProperty("knowledge.status", "v2-none")
    expect(result.graphStatuses).not.toHaveProperty("memory.status", "v2-none")
    expect(result.queryFingerprint).toBeTypeOf("string")
    expect(result.authorizationFingerprint).toBeTypeOf("string")
  })

  test("is deterministic: identical envelopes produce identical statuses and candidates (latency excluded)", async () => {
    const adapters = fourAdapters({ code: readyAdapter("code") })
    const a = await run(envelope(), adapters)
    const b = await run(envelope(), adapters)
    expect(a.queryFingerprint).toBe(b.queryFingerprint)
    expect(stableStatuses(a)).toEqual(stableStatuses(b))
    expect(a.candidates.map((c) => c.ref.entityId)).toEqual(b.candidates.map((c) => c.ref.entityId))
  })

  test("location-scoped negative: a principal without the target Location is denied for every graph", async () => {
    const adapters = fourAdapters({ code: readyAdapter("code") })
    // Principal owns Location A (loc); resolution is bound to Location B (locB).
    const cross = envelope({ location: { locationKey: locB } })
    const result = await run(cross, adapters)
    for (const graph of allGraphs) {
      expect(result.graphStatuses[graph].status).toBe("denied")
      expect(result.graphStatuses[graph].reasonCode).toBe("scope_denied")
    }
    expect(result.candidates).toHaveLength(0)
  })

  test("consumes limit/ref/token budget placeholders without affecting ordering stability", async () => {
    const adapters = fourAdapters({ code: readyAdapter("code") })
    const result = await run(envelope({ limit: 4, refBudget: 8, tokenBudget: 2_000 }), adapters)
    expect(result.results).toHaveLength(4)
    expect(result.graphStatuses.code.status).toBe("ready")
    expect(result.queryFingerprint).toBeTypeOf("string")
  })
})

describe("SessionContextResolverV2 (C3-02 per-graph status + isolation)", () => {
  test("a graph timeout degrades that graph to timeout while the other three still produce statuses", async () => {
    const timeoutAdapter: V2Adapter = {
      graph: "code",
      source: "code",
      adapterVersion: "code.v1",
      resolve: () => Effect.never,
    }
    const adapters = fourAdapters({ code: timeoutAdapter, knowledge: readyAdapter("knowledge") })
    const result = await run(envelope({ now: 100 }), adapters, 10)
    expect(result.graphStatuses.code.status).toBe("timeout")
    expect(result.graphStatuses.code.reasonCode).toBe("source_timeout")
    // other graphs unaffected
    expect(result.graphStatuses.knowledge.status).toBe("ready")
    expect(result.graphStatuses.documents.status).toBe("ready")
    expect(result.graphStatuses.memory.status).toBe("ready")
    expect(result.graphStatuses.code.candidateCount).toBe(0)
  })

  test("adapter version is observable in the status and a version bump is surfaced", async () => {
    const base = readyAdapter("documents")
    const bumped: V2Adapter = { ...base, adapterVersion: "documents.v2" }
    const result = await run(envelope(), fourAdapters({ documents: bumped }))
    expect(result.graphStatuses.documents.adapterVersion).toBe("documents.v2")
    expect(result.graphStatuses.knowledge.adapterVersion).toBe("knowledge.v1")
  })

  test("an empty graph reports empty (ready source, zero candidates) not v2-none", async () => {
    const empty: V2Adapter = {
      graph: "memory",
      source: "durable_memory",
      adapterVersion: "memory.v1",
      resolve: () => Effect.succeed({ candidates: [], revision: "mem:1", observedMutationEpoch: 0, available: true }),
    }
    const result = await run(envelope(), fourAdapters({ memory: empty }))
    expect(result.graphStatuses.memory.status).toBe("empty")
    expect(result.graphStatuses.memory.candidateCount).toBe(0)
  })

  test("an adapter that is unusable reports degraded_unavailable", async () => {
    const degraded: V2Adapter = {
      graph: "code",
      source: "code",
      adapterVersion: "code.v1",
      resolve: () =>
        Effect.succeed({ candidates: [], revision: "", observedMutationEpoch: 0, available: false, unavailableReasonCode: "source_error" }),
    }
    const result = await run(envelope(), fourAdapters({ code: degraded }))
    expect(result.graphStatuses.code.status).toBe("degraded_unavailable")
    expect(result.graphStatuses.code.reasonCode).toBe("source_error")
  })
})

describe("SessionContextResolverV2 (C3-03 authorization / egress / namespace / snapshot)", () => {
  test("denied is terminal: a denied graph is not degraded even when Agent policy allows degrade", async () => {
    // egress excludes the `code` graph entirely
    const noCodeEgress = { ...egress, graphs: ["documents", "knowledge", "memory"] as const }
    const permit = envelope({
      egress: noCodeEgress,
      agentPolicy: { agentId: "agent-v2", autonomyCeiling: "high", permitDegraded: true },
    })
    const result = await run(permit, fourAdapters({ code: readyAdapter("code") }))
    expect(result.graphStatuses.code.status).toBe("denied")
    expect(result.graphStatuses.code.reasonCode).toBe("provider_egress_denied")
  })

  test("security namespace mismatch denies every graph (cross-tenant, never cross-scope)", async () => {
    const crossTenant = envelope({ securityNamespace: { securityNamespaceId: nsB } })
    const result = await run(crossTenant, fourAdapters({ code: readyAdapter("code") }))
    for (const graph of allGraphs) {
      expect(result.graphStatuses[graph].status).toBe("denied")
      expect(result.graphStatuses[graph].reasonCode).toBe("security_namespace_denied")
    }
  })

  test("project scope mismatch denies every graph", async () => {
    const otherProject = ProjectScopeKey.make("prj_resolver_v2_other")
    const crossProject = envelope({ projectScope: { projectScopeKey: otherProject, projectId: "legacy-project-other" } })
    const result = await run(crossProject, fourAdapters({ code: readyAdapter("code") }))
    for (const graph of allGraphs) {
      expect(result.graphStatuses[graph].status).toBe("denied")
      expect(result.graphStatuses[graph].reasonCode).toBe("project_scope_denied")
    }
  })

  test("cross-scope candidate content is filtered: Location A principal cannot read Location B content", async () => {
    const foreignCandidate = candidate({
      ref: {
        graph: "documents",
        entityId: "doc-loc-b",
        binding: { scope: "location", securityNamespaceId: nsB, locationKey: locB, projectScopeKey: proj },
        revision: "doc:1",
      },
    })
    const foreign: V2Adapter = {
      graph: "documents",
      source: "documents",
      adapterVersion: "documents.v1",
      resolve: () =>
        Effect.succeed({ candidates: [foreignCandidate], revision: "doc:1", observedMutationEpoch: 0, available: true }),
    }
    const result = await run(envelope(), fourAdapters({ documents: foreign }))
    // The foreign candidate was filtered out, so the graph is empty and no B content leaks.
    expect(result.graphStatuses.documents.status).toBe("empty")
    expect(result.candidates.map((c) => c.ref.entityId)).not.toContain("doc-loc-b")
  })

  test("superseded released knowledge is not eligible and surfaces a typed successor rebuild signal", async () => {
    const supersededKnowledge: V2Adapter = {
      graph: "knowledge",
      source: "released_knowledge",
      adapterVersion: "knowledge.v1",
      resolve: () =>
        Effect.succeed({ candidates: [], revision: "superseded", observedMutationEpoch: 0, available: false, unavailableReasonCode: "released_snapshot_unavailable" }),
    }
    const result = await run(envelope(), fourAdapters({ knowledge: supersededKnowledge }))
    expect(result.graphStatuses.knowledge.status).toBe("degraded_unavailable")
    expect(result.graphStatuses.knowledge.reasonCode).toBe("released_snapshot_unavailable")
    expect(result.graphStatuses.knowledge.candidateCount).toBe(0)
    expect(result.successorRebuild?.trigger).toBe("released_snapshot_drift")
    expect(result.successorRebuild?.expected).toBe("snapshot-v2")
  })

  test("location mutation epoch drift surfaces a typed successor rebuild signal", async () => {
    const result = await run(
      envelope({ observedLocationMutationEpoch: 4, expectedLocationMutationEpoch: 2 }),
      fourAdapters({ code: readyAdapter("code") }),
    )
    expect(result.successorRebuild?.trigger).toBe("location_mutation_epoch_drift")
    expect(result.successorRebuild?.expected).toBe("2")
    expect(result.successorRebuild?.observed).toBe("4")
  })

  test("authorization epoch drift surfaces a typed successor rebuild signal", async () => {
    const drifted = { ...principal, authorizationEpoch: 9 }
    const result = await run(
      envelope({ principal: drifted, expectedAuthorizationEpoch: 3 }),
      fourAdapters({ code: readyAdapter("code") }),
    )
    expect(result.successorRebuild?.trigger).toBe("authorization_epoch_drift")
    expect(result.successorRebuild?.expected).toBe("3")
    expect(result.successorRebuild?.observed).toBe("9")
  })
})

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function stableStatuses(result: { readonly graphStatuses: Readonly<Record<string, { readonly status: string; readonly revision: string; readonly adapterVersion: string; readonly observedMutationEpoch: number; readonly candidateCount: number; readonly reasonCode: string }>> }) {
  return Object.fromEntries(
    Object.entries(result.graphStatuses).map(([graph, s]) => [
      graph,
      {
        status: s.status,
        revision: s.revision,
        adapterVersion: s.adapterVersion,
        observedMutationEpoch: s.observedMutationEpoch,
        candidateCount: s.candidateCount,
        reasonCode: s.reasonCode,
      },
    ]),
  )
}

function run(envelope: QueryEnvelope, adapters: Readonly<Record<(typeof allGraphs)[number], V2Adapter>>, timeout = 100) {
  return Effect.runPromise(SessionContextResolverV2.resolveGraphs(envelope, adapters, timeout))
}

function fourAdapters(extra: Partial<Record<"code" | "documents" | "knowledge" | "memory", V2Adapter>>): Record<(typeof allGraphs)[number], V2Adapter> {
  return {
    code: extra.code ?? readyAdapter("code"),
    documents: extra.documents ?? readyAdapter("documents"),
    knowledge: extra.knowledge ?? readyAdapter("knowledge"),
    memory: extra.memory ?? readyAdapter("memory"),
  }
}

function readyAdapter(graph: "code" | "documents" | "knowledge" | "memory"): V2Adapter {
  const item = candidate({
    ref: {
      graph,
      entityId: `${graph}-seed`,
      binding: { scope: "location", securityNamespaceId: ns, locationKey: loc, projectScopeKey: proj },
      revision: `${graph}:1`,
    },
  })
  return {
    graph,
    source: graph,
    adapterVersion: `${graph}.v1`,
    resolve: () =>
      Effect.succeed({
        candidates: [item],
        revision: `${graph}:1`,
        observedMutationEpoch: 1,
        available: true,
      }),
  }
}

function candidate(input: { readonly ref: ContextRef }): ContextCandidate {
  const ref = input.ref as unknown as ContextCandidate["ref"]
  return ContextFederation.candidate({
    ref,
    graph: ref.graph,
    title: `${ref.graph} seed`,
    summary: `${ref.graph} seed`,
    relations: [],
    provenance: [],
    features: { exact: 1, lexical: 1, authority: 1, evidence: 1, freshness: 1 },
    trust: "repository_evidence",
    visibility: "model",
  })
}
