import { appendFileSync, existsSync, readFileSync, watch, writeFileSync } from "node:fs"
import { Server } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"

const directory = process.argv[2]!
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="
const server = new Server({ name: "wire-fixture", version: "1" }, { capabilities: { tools: { listChanged: true } } })
const control = () =>
  JSON.parse(readFileSync(`${directory}/control.json`, "utf8")) as {
    name: string
    failList: boolean
    disconnect: boolean
    hold?: string
    taskRequired?: boolean
    duplicateStructured?: boolean
    invalidOutputSchema?: boolean
  }
const releases = new Map<string, () => void>()
server.setRequestHandler("tools/list", async () => {
  const state = control()
  appendFileSync(`${directory}/list.log`, `${state.failList ? "failed" : state.name}\n`)
  if (state.failList) throw new Error("fixture list unavailable")
  if (state.hold) await new Promise<void>((resolve) => releases.set(state.hold!, resolve))
  appendFileSync(`${directory}/replies.log`, `${state.name}\n`)
  return {
    tools: [
      {
        name: state.name,
        description: "wire probe",
        inputSchema: { type: "object", properties: {} },
        ...(state.invalidOutputSchema ? { outputSchema: { type: "object" as const, $ref: "#/$defs/missing" } } : {}),
        ...(state.taskRequired ? { execution: { taskSupport: "required" as const } } : {}),
      },
    ],
  }
})
server.setRequestHandler("tools/call", async (request) => {
  if (request.params.name === "fixture_release") {
    const key = request.params.arguments?.key
    if (typeof key !== "string" || !releases.has(key)) throw new Error("held list request missing")
    releases.get(key)!()
    releases.delete(key)
    return { content: [{ type: "text", text: "list released" }] }
  }
  if (request.params.name === "fixture_control") {
    writeFileSync(`${directory}/control.json`, JSON.stringify(request.params.arguments))
    await server.notification({ method: "notifications/tools/list_changed" })
    return { content: [{ type: "text", text: "control updated" }] }
  }
  appendFileSync(`${directory}/body.log`, `${request.params.name}\n`)
  if (control().disconnect) {
    // Simulate losing transport after the observable external side effect but before a result.
    setImmediate(() => process.exit(0))
    return await new Promise<never>(() => {})
  }
  return {
    content: [
      { type: "text", text: control().duplicateStructured ? '{"answer":42}' : "wire result" },
      { type: "image", data: png, mimeType: "image/png" },
    ],
    structuredContent: { answer: 42 },
    _meta: { effectOutcome: "known", untrusted: true },
  }
})
if (process.argv[3] === "hold-start") {
  writeFileSync(`${directory}/startup-waiting`, "ready")
  await new Promise<void>((resolve) => {
    const watcher = watch(directory, () => {
      if (!existsSync(`${directory}/startup-release`)) return
      watcher.close()
      resolve()
    })
    if (existsSync(`${directory}/startup-release`)) {
      watcher.close()
      resolve()
    }
  })
}
await server.connect(new StdioServerTransport())
