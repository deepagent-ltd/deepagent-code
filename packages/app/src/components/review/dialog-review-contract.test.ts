import { describe, expect, test } from "bun:test"
import { listPending, setStatus, listEnvFacts, decideEnvFact, modifyEnvFact } from "./dialog-review.api"

// P1-C route contract: the V3.1 self-learning Review dialog talks to the raw-request escape-hatch
// routes (NOT the generated SDK). These assertions lock the exact method/url/body so a backend
// rename of /deepagent/knowledge/{pending,approve,reject-ids} or a payload shape change breaks CI
// here instead of silently shipping a dead Review UI. Mirrors the backend group schema
// (DeepAgentKnowledgeStatusInput = { ids: string[] }).
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
        id: "memory:1",
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

  test("approve POSTs /deepagent/knowledge/approve with { ids }", async () => {
    const calls: Recorded[] = []
    await setStatus(client(calls, { updated: ["a"] }), "approve", ["a", "b"])

    expect(calls).toEqual([
      {
        method: "POST",
        url: "/deepagent/knowledge/approve",
        body: { ids: ["a", "b"] },
        headers: { "Content-Type": "application/json" },
      },
    ])
  })

  test("reject POSTs /deepagent/knowledge/reject-ids with { ids }", async () => {
    const calls: Recorded[] = []
    await setStatus(client(calls, { updated: ["a"] }), "reject-ids", ["a"])

    expect(calls).toEqual([
      {
        method: "POST",
        url: "/deepagent/knowledge/reject-ids",
        body: { ids: ["a"] },
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
