import { describe, expect, test } from "bun:test"
import { recordHumanTakeover, recordRollback } from "./oversight.api"

// V4.0 §D2 route contract: the Oversight Dashboard's takeover + rollback controls talk to the raw-request
// escape-hatch routes (NOT the generated SDK). These lock the exact method/url/body so a backend rename of
// /oversight/takeover or /oversight/rollback breaks CI here instead of shipping a dead UI. Mirrors the
// backend group schemas in server/routes/instance/httpapi/groups/oversight.ts.
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

// a client whose request always throws — used to exercise the 404-tolerant error paths.
function throwingClient(message: string) {
  return {
    client: {
      request: async <TData>(): Promise<{ data?: TData }> => {
        throw new Error(message)
      },
    },
  }
}

const JSON_HEADERS = { "Content-Type": "application/json" }

describe("Rollback route contract (§D2)", () => {
  test("recordRollback POSTs /oversight/rollback with sessionID + reason", async () => {
    const calls: Recorded[] = []
    const record = {
      id: "rbk_1",
      workspaceID: "wrk_1",
      sessionID: "ses_1",
      actorID: "wrk_1",
      reason: "bad diff",
      outcome: "reverted" as const,
      createdAt: 1,
    }
    const result = await recordRollback(client(calls, record), { sessionID: "ses_1", reason: "bad diff" })
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/oversight/rollback",
        body: { sessionID: "ses_1", reason: "bad diff" },
        headers: JSON_HEADERS,
      },
    ])
    expect(result).toEqual({ ok: true, record })
  })

  test("recordRollback surfaces a 404 as notFound (session not in this workspace)", async () => {
    const result = await recordRollback(throwingClient("Request failed: 404 Not Found"), { sessionID: "ses_x" })
    expect(result).toEqual({ ok: false, unsupported: false, notFound: true, error: "Request failed: 404 Not Found" })
  })

  test("recordRollback surfaces a non-404 error as a plain failure", async () => {
    const result = await recordRollback(throwingClient("Request failed: 500 boom"), { sessionID: "ses_x" })
    expect(result).toEqual({ ok: false, unsupported: false, notFound: false, error: "Request failed: 500 boom" })
  })
})

describe("Takeover route contract (§D2)", () => {
  test("recordHumanTakeover POSTs /oversight/takeover with the reason", async () => {
    const calls: Recorded[] = []
    const record = { id: "tko_1", workspaceID: "wrk_1", reason: "paused", createdAt: 1 }
    const result = await recordHumanTakeover(client(calls, record), { reason: "paused" })
    expect(calls).toEqual([
      { method: "POST", url: "/oversight/takeover", body: { reason: "paused" }, headers: JSON_HEADERS },
    ])
    expect(result).toEqual({ ok: true, record })
  })
})
