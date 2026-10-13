import { describe, expect, test } from "bun:test"
import { createDeepAgentCodeClient } from "@deepagent-code/sdk/client"
import { createServer } from "node:http"
import { toggleMcp, McpRecoveryRequiredError } from "./mcp"

describe("toggleMcp", () => {
  test("runs the status action before refreshing the owning query", async () => {
    const calls: string[] = []
    const input = (status: "connected" | "needs_auth" | "disabled") => ({
      status: { status },
      connect: async () => {
        calls.push("connect")
      },
      disconnect: async () => {
        calls.push("disconnect")
      },
      authenticate: async () => {
        calls.push("authenticate")
      },
      refresh: async () => {
        calls.push("refresh")
      },
    })

    await toggleMcp(input("connected"))
    expect(calls).toEqual(["disconnect", "refresh"])

    calls.length = 0
    await toggleMcp(input("needs_auth"))
    expect(calls).toEqual(["authenticate", "refresh"])

    calls.length = 0
    await toggleMcp(input("disabled"))
    expect(calls).toEqual(["connect", "refresh"])
  })
})

test("actual generated SDK connects a cold verified server once and only refreshes its owning scope", async () => {
  const requests: { method: string; path: string; directory: string | null }[] = []
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "*")
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    const url = new URL(request.url!, "http://127.0.0.1")
    requests.push({ method: request.method!, path: url.pathname, directory: url.searchParams.get("directory") })
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify(request.method === "POST" ? true : { fixture: { status: "connected" } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Private listener missing")
  try {
    const client = createDeepAgentCodeClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      directory: "/owned/项目",
      throwOnError: true,
    })
    await toggleMcp({
      status: { status: "disconnected", authStatus: "authenticated", reason: "explicit_connect_required" },
      connect: async () => {
        await client.mcp.connect({ name: "fixture" })
      },
      disconnect: async () => {
        await client.mcp.disconnect({ name: "fixture" })
      },
      authenticate: async () => {
        await client.mcp.auth.authenticate({ name: "fixture" })
      },
      refresh: async () => {
        await client.mcp.status()
      },
    })
    expect(requests.map((row) => `${row.method} ${row.path}`)).toEqual(["POST /mcp/fixture/connect", "GET /mcp"])
    expect(requests[1].directory).toBe("/owned/项目")
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    server.closeAllConnections()
    await closed
  }
})

test("unknown and incomplete cold metadata from a real HTTP response cannot issue any mutation", async () => {
  const requests: string[] = []
  const statuses = [
    { status: "disconnected", authStatus: "unknown", reason: "unknown_outcome" },
    { status: "disconnected", authStatus: "authenticated", reason: "unknown_outcome" },
    { status: "disconnected" },
    { status: "disconnected", authStatus: "unexpected", reason: "explicit_connect_required" },
  ]
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "*")
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    requests.push(request.method!)
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ fixture: statuses[requests.length - 1] }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Private listener missing")
  try {
    const client = createDeepAgentCodeClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true })
    for (const _ of statuses) {
      const status = (await client.mcp.status()).data?.fixture
      await expect(
        toggleMcp({
          status,
          connect: async () => {
            await client.mcp.connect({ name: "fixture" })
          },
          disconnect: async () => {
            await client.mcp.disconnect({ name: "fixture" })
          },
          authenticate: async () => {
            await client.mcp.auth.authenticate({ name: "fixture" })
          },
          refresh: async () => {
            await client.mcp.status()
          },
        }),
      ).rejects.toBeInstanceOf(McpRecoveryRequiredError)
    }
    expect(requests).toEqual(["GET", "GET", "GET", "GET"])
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    server.closeAllConnections()
    await closed
  }
})
