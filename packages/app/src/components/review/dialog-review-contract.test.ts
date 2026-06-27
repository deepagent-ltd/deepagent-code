import { describe, expect, test } from "bun:test"
import { listPending, setStatus } from "./dialog-review"

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
})
