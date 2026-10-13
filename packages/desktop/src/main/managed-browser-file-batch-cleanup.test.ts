import { expect, test } from "bun:test"
import path from "node:path"

test("file batch QA joins real HTTP socket close events before recording cleanup", async () => {
  // Electron Main uses Node's HTTP lifecycle. Bun's closeAllConnections shim
  // stops its listener and does not expose the same Socket close events.
  const node = Bun.which("node")
  expect(node).not.toBeNull()
  const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/managed-browser-file-batch-cleanup.ts")],
    target: "node", write: false })
  expect(built.success).toBe(true)
  const child = Bun.spawn([node!, "--input-type=module", "-e", (await built.outputs[0]!.text()) + `
import assert from "node:assert/strict"
import { createServer, request } from "node:http"
const sockets = new Set()
const connected = Promise.withResolvers()
const server = createServer((_, response) => {
  response.writeHead(200)
  response.write("held response")
  connected.resolve()
})
server.on("connection", (socket) => {
  sockets.add(socket)
  socket.once("close", () => sockets.delete(socket))
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert(address && typeof address !== "string")
const client = request({ hostname: "127.0.0.1", port: address.port }, (response) => {
  response.on("error", () => {})
  response.resume()
})
client.on("error", () => {})
client.end()
try {
  await connected.promise
  assert.equal(sockets.size, 1)
  await closeBrowserFileBatchServers([server], sockets)
  assert.equal(sockets.size, 0)
  assert.equal(server.listening, false)
  console.log(JSON.stringify({ before: 1, after: sockets.size, listening: server.listening }))
} finally {
  client.destroy()
  server.closeAllConnections()
  server.close()
}
`], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 4_000)
  try {
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ before: 1, after: 0, listening: false })
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}, 5_000)
