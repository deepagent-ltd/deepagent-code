import { describe, expect, test } from "bun:test"
import { listPending, reviewSummary, setStatus, listEnvFacts, decideEnvFact, modifyEnvFact } from "./dialog-review.api"

// P1-C route contract: the V3.1 self-learning Review dialog talks to the raw-request escape-hatch
// routes (NOT the generated SDK). These assertions lock the exact method/url/body so a backend
// rename of /deepagent/knowledge/{pending,approve,reject-ids} or a payload shape change breaks CI
// here instead of silently shipping a dead Review UI. Review decisions must round-trip the exact
// immutable authority returned by the list endpoint; a bare id can alias project/global revisions.
type Recorded = { method: string; url: string; body?: unknown; headers?: Record<string, string> }

function client(calls: Recorded[], data: unknown) {
  return {
    client: {
      request: async <TData>(options: Recorded): Promise<{ data?: TData }> => {
        calls.push(options)
        return { data: data as TData }
      },
    },
  }
}

describe("DeepAgent review dialog route contract", () => {
  test("listPending GETs /deepagent/knowledge/pending and unwraps items", async () => {
    const calls: Recorded[] = []
    const items = [
      {
        sourceStore: "project" as const,
        id: "memory:1",
        version: 3,
        hash: "hash-3",
        candidateId: "candidate-3",
        fingerprint: "fingerprint-3",
        governanceRevision: "governance-3",
        type: "memory" as const,
        summary: "s",
        evidence_strength: "strong" as const,
        evidence_refs: [],
        approval_status: "pending" as const,
      },
    ]
    const result = await listPending(client(calls, { items }))

    expect(calls).toEqual([{ method: "GET", url: "/deepagent/knowledge/pending" }])
    expect(result).toEqual(items)
  })

  test("listPending tolerates a missing items field", async () => {
    const calls: Recorded[] = []
    expect(await listPending(client(calls, {}))).toEqual([])
  })

  test("reviewSummary GETs the lightweight summary route", async () => {
    const calls: Recorded[] = []
    expect(await reviewSummary(client(calls, { pendingCount: 3 }))).toEqual({ pendingCount: 3 })
    expect(calls).toEqual([{ method: "GET", url: "/deepagent/knowledge/review-summary" }])
  })

  test("approve POSTs the exact listed authority to /deepagent/knowledge/approve", async () => {
    const calls: Recorded[] = []
    const item = {
      sourceStore: "project" as const,
      id: "a",
      version: 2,
      hash: "hash-a-2",
      candidateId: "candidate-a",
      fingerprint: "fingerprint-a",
      governanceRevision: "governance-a-2",
      type: "knowledge" as const,
      summary: "A",
      evidence_strength: "strong" as const,
      evidence_refs: [],
      approval_status: "pending" as const,
    }
    await setStatus(client(calls, { updated: item }), "approve", item)

    expect(calls).toEqual([
      {
        method: "POST",
        url: "/deepagent/knowledge/approve",
        body: {
          sourceStore: "project",
          id: "a",
          version: 2,
          hash: "hash-a-2",
          candidateId: "candidate-a",
          fingerprint: "fingerprint-a",
          expectedGovernanceRevision: "governance-a-2",
        },
        headers: { "Content-Type": "application/json" },
      },
    ])
  })

  test("reject POSTs the exact global authority to /deepagent/knowledge/reject-ids", async () => {
    const calls: Recorded[] = []
    const item = {
      sourceStore: "user_global" as const,
      id: "a",
      version: 4,
      hash: "hash-a-4",
      candidateId: "candidate-a",
      fingerprint: "fingerprint-a",
      governanceRevision: "governance-a-4",
      type: "memory" as const,
      summary: "A",
      evidence_strength: "medium" as const,
      evidence_refs: [],
      approval_status: "pending" as const,
    }
    await setStatus(client(calls, { updated: item }), "reject-ids", item)

    expect(calls).toEqual([
      {
        method: "POST",
        url: "/deepagent/knowledge/reject-ids",
        body: {
          sourceStore: "user_global",
          id: "a",
          version: 4,
          hash: "hash-a-4",
          candidateId: "candidate-a",
          fingerprint: "fingerprint-a",
          expectedGovernanceRevision: "governance-a-4",
        },
        headers: { "Content-Type": "application/json" },
      },
    ])
  })

  // V3.8.1 §G use-gate route contract.
  test("listEnvFacts GETs /deepagent/env-facts and unwraps adopted/pending", async () => {
    const calls: Recorded[] = []
    const data = {
      adopted: [],
      pending: [{ fact_id: "f1", version: 1, description: "milvus", body: null, degraded: false }],
    }
    const result = await listEnvFacts(client(calls, data))
    expect(calls).toEqual([{ method: "GET", url: "/deepagent/env-facts" }])
    expect(result).toEqual(data)
  })

  test("listEnvFacts tolerates missing fields", async () => {
    const calls: Recorded[] = []
    expect(await listEnvFacts(client(calls, {}))).toEqual({ adopted: [], pending: [] })
  })

  test("decideEnvFact POSTs /deepagent/env-facts/decide with { factId, decision }", async () => {
    const calls: Recorded[] = []
    await decideEnvFact(client(calls, { ok: true }), "f1", "adopt")
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/deepagent/env-facts/decide",
        body: { factId: "f1", decision: "adopt" },
        headers: { "Content-Type": "application/json" },
      },
    ])
  })

  test("modifyEnvFact POSTs /deepagent/env-facts/modify with the full edit payload", async () => {
    const calls: Recorded[] = []
    const input = {
      factId: "f1",
      description: "milvus test",
      body: { host: "10.0.0.5", port: 19530, last_confirmed_at: "2026-07-09T00:00:00Z" },
      mode: "global" as const,
    }
    await modifyEnvFact(client(calls, { ok: true, factId: "f1" }), input)
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/deepagent/env-facts/modify",
        body: input,
        headers: { "Content-Type": "application/json" },
      },
    ])
  })
})
