import { Server } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { appendFileSync } from "node:fs"

const directory = process.argv[2]!
appendFileSync(`${directory}/spawns.log`, `${process.pid}\n`)
serveStdio(() => {
  const state = { name: "probe" }
  const server = new Server({ name: "modern-stdio", version: "1" }, { capabilities: { tools: { listChanged: true } } })
  server.setRequestHandler("tools/list", () => ({
    tools: [{ name: state.name, inputSchema: { type: "object", properties: {} } }],
  }))
  server.setRequestHandler("tools/call", async (request) => {
    if (request.params.name === "fixture_refresh") {
      state.name = "updated"
      await server.notification({ method: "notifications/tools/list_changed" })
      return { content: [{ type: "text", text: "refreshed" }] }
    }
    appendFileSync(`${directory}/body.log`, `${request.params.name}:${server.getNegotiatedProtocolVersion()}\n`)
    return { content: [{ type: "text", text: "modern-stdio-result" }] }
  })
  return server
})
