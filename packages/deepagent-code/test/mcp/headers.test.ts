import { expect } from "bun:test"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { MCP } from "../../src/mcp/index"

const it = testEffect(MCP.defaultLayer)
const cases: { name: string; oauth?: false; headers?: Record<string, string> }[] = [
  {
    name: "OAuth enabled",
    oauth: undefined,
    headers: { Authorization: "Bearer synthetic-header", "X-Custom-Header": "custom-value" },
  },
  { name: "OAuth disabled", oauth: false as const, headers: { Authorization: "Bearer synthetic-header" } },
  { name: "no configured headers", oauth: undefined, headers: undefined },
]
for (const input of cases)
  it.instance(
    `actual SDK preserves headers with ${input.name}`,
    () =>
      Effect.gen(function* () {
        const requests: { method: string; pathname: string; authorization: string | null; custom: string | null }[] = []
        const listener = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            requests.push({
              method: request.method,
              pathname: new URL(request.url).pathname,
              authorization: request.headers.get("authorization"),
              custom: request.headers.get("x-custom-header"),
            })
            if (request.method === "GET") return new Response(null, { status: 405 })
            if (request.method === "DELETE") return new Response(null, { status: 204 })
            const body = (await request.json()) as { id?: number; method: string }
            if (body.id === undefined) return new Response(null, { status: 202 })
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result:
                body.method === "initialize"
                  ? {
                      protocolVersion: "2025-11-25",
                      serverInfo: { name: "headers-fixture", version: "1" },
                      capabilities: { tools: {} },
                    }
                  : { tools: [] },
            })
          },
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => listener.stop(true)))
        const mcp = yield* MCP.Service
        yield* mcp.add("headers", {
          type: "remote",
          url: new URL("/mcp", listener.url).href,
          oauth: input.oauth,
          headers: input.headers,
        })
        expect((yield* mcp.status()).headers.status).toBe("connected")
        expect(requests.length).toBeGreaterThan(0)
        for (const request of requests) {
          expect(request.pathname).toBe("/mcp")
          expect(request.authorization).toBe(input.headers?.Authorization ?? null)
          expect(request.custom).toBe(
            input.headers && "X-Custom-Header" in input.headers ? (input.headers["X-Custom-Header"] ?? null) : null,
          )
        }
      }),
    { config: { mcp: {} } },
  )
