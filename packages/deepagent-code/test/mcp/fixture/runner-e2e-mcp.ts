import { appendFileSync } from "node:fs"
import { Server } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"

const root = process.argv[2]!
const scenario = process.argv[3]!
const resourceURL = process.argv[4]!
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="
serveStdio(() => {
  const server = new Server({ name: "runner-e2e", version: "1" }, { capabilities: { tools: {}, resources: {} } })
  server.setRequestHandler("tools/list", () => ({
    tools: [
      {
        name: "probe",
        description: "Return an integration observation",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: scenario !== "unknown" },
      },
    ],
  }))
  server.setRequestHandler("resources/list", () => ({ resources: [] }))
  server.setRequestHandler("resources/read", () => {
    appendFileSync(`${root}/resource-read.log`, "read\n")
    return { contents: [{ uri: resourceURL, text: "must not auto-fetch" }] }
  })
  server.setRequestHandler("tools/call", async (request) => {
    appendFileSync(
      `${root}/mcp-body.log`,
      `${JSON.stringify({ name: request.params.name, args: request.params.arguments, protocol: server.getNegotiatedProtocolVersion(), pid: process.pid })}\n`,
    )
    if (scenario === "unknown") {
      setImmediate(() => process.exit(0))
      return await new Promise<never>(() => {})
    }
    return {
      content: [
        { type: "text", text: '{"mcp_e2e_answer":42}' },
        { type: "image", data: png, mimeType: "image/png" },
        { type: "resource_link", uri: resourceURL, name: "do-not-fetch", mimeType: "text/plain" },
      ],
      structuredContent: { mcp_e2e_answer: 42 },
      _meta: { effectOutcome: "known", fixtureUntrusted: true },
    }
  })
  return server
})
