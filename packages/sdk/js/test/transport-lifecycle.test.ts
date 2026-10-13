import { expect, test } from "bun:test"
import { createDeepAgentCodeClient } from "../src/client.js"

test("real SSE abort releases the stream and exits without an unhandled cancel rejection", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n'))
    } }), { headers: { "Content-Type": "text/event-stream" } },
  ) })
  const child = Bun.spawn([process.execPath, new URL("./fixture/sse-abort.ts", import.meta.url).pathname,
    server.url.toString()], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 4_000)
  try {
    const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect({ exit: result[0], stderr: result[2] }).toEqual({ exit: 0, stderr: "" })
    expect(JSON.parse(result[1])).toEqual({ received: 1, closed: true })
  } finally {
    clearTimeout(timer)
    child.kill()
    await server.stop(true)
  }
}, 6_000)

test("empty V2 session creation sends the required object and read requests keep an absent body", async () => {
  const observed: Array<{ method: string; pathname: string; body: string; location: string | null }> = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url)
    observed.push({ method: request.method, pathname: url.pathname, body: await request.text(),
      location: url.searchParams.get("location[directory]") })
    return Response.json({})
  } })
  try {
    const client = createDeepAgentCodeClient({ baseUrl: server.url.toString(), throwOnError: true })
    await client.v2.session.create()
    await client.v2.session.create({ location: { directory: "/qa/owned" } })
    await client.v2.session.create({ metadata: { title: "body retained" } })
    await client.v2.session.get({ sessionID: "qa-session" })
    expect(observed.map((request) => [request.method, request.pathname, request.body])).toEqual([
      ["POST", "/api/session", "{}"],
      ["POST", "/api/session", "{}"],
      ["POST", "/api/session", '{"metadata":{"title":"body retained"}}'],
      ["GET", "/api/session/qa-session", ""],
    ])
    expect(observed[1]!.location).toBe("/qa/owned")
  } finally { await server.stop(true) }
})
