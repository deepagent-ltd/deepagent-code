import { expect, test } from "bun:test"
import http from "node:http"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const electron = path.resolve(import.meta.dir, "../../desktop/node_modules/.bin/electron")
const child = (command: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
  const process = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] })
  const output = { stdout: "", stderr: "" }
  const timeout = setTimeout(() => process.kill("SIGKILL"), 25000)
  process.stdout.on("data", (bytes: Buffer) => { output.stdout += bytes.toString(); if (Buffer.byteLength(output.stdout) > 32768) process.kill("SIGKILL") })
  process.stderr.on("data", (bytes: Buffer) => { output.stderr += bytes.toString(); if (Buffer.byteLength(output.stderr) > 32768) process.kill("SIGKILL") })
  process.on("error", () => { clearTimeout(timeout); resolve({ code: -1, ...output }) })
  process.on("close", (code) => { clearTimeout(timeout); resolve({ code, ...output }) })
})

for (const group of ["identity", "mutation", "cleanup"] as const) test(`Node builtin ${group}: real Node and Electron utility HTTP`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dac-node-builtin-"))
  const proxyHits: string[] = []
  const proxy = http.createServer((request, response) => {
    request.resume()
    request.on("end", () => {
      proxyHits.push(new URL(request.url!).pathname)
      if (request.url!.endsWith("/input_tokens")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ object: "response.input_tokens", input_tokens: 41 })); return }
      response.writeHead(200, { "content-type": "text/event-stream" }); response.end('data: {"type":"response.completed","response":{"id":"proxy-fixture"}}\n\n')
    })
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  try {
    const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/executor-builtin-node-process.ts")], outdir: directory, target: "node", format: "esm", naming: "entry.mjs", external: ["electron", "bun"] })
    expect(build.success).toBe(true)
    const certificate = await child("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"], { PATH: process.env.PATH, HOME: directory, TMPDIR: directory })
    expect(certificate.code).toBe(0)
    const address = proxy.address()
    if (!address || typeof address === "string") throw new Error("Proxy fixture unavailable")
    const env = {
      PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
      XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
      ALL_PROXY: `http://127.0.0.1:${address.port}`, NO_PROXY: "127.0.0.1,localhost",
      DAC_NODE_FIXTURE_ROOT: directory, DAC_NODE_FIXTURE_ENTRY: path.join(directory, "entry.mjs"),
      DAC_NODE_FIXTURE_GROUP: group, DAC_NODE_PROXY_ORIGIN: `http://127.0.0.1:${address.port}`,
      DAC_NODE_TLS_KEY: path.join(directory, "key.pem"), DAC_NODE_TLS_CERT: path.join(directory, "cert.pem"),
    }
    const node = await child("node", [path.join(directory, "entry.mjs")], env)
    await fs.writeFile(path.join(directory, "node-result.json"), JSON.stringify(node))
    expect(node.stderr).toBe("")
    expect(node.code).toBe(0)
    const nodeFacts = JSON.parse(node.stdout.trim())
    expect(nodeFacts.group).toBe(group)
    expect(nodeFacts.checks).toBeGreaterThan(10)
    const utility = await child(electron, [path.join(directory, "entry.mjs")], { ...env, DAC_NODE_FIXTURE_ELECTRON_MAIN: "1" })
    expect(utility.code).toBe(0)
    const result = JSON.parse(await fs.readFile(path.join(directory, "electron-result.json"), "utf8"))
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    const facts = result.facts
    expect(facts.runtime).toBe("24.18.0")
    expect(facts.group).toBe(group)
    expect(facts.checks).toBe(nodeFacts.checks)
    expect(facts.forbidden).toBe(0)
    expect(proxyHits).toEqual(group === "identity" ? ["/v1/responses/input_tokens", "/v1/responses", "/v1/responses/input_tokens", "/v1/responses"] : [])
    console.info("NODE_BUILTIN_SAFE", JSON.stringify({ directory, node: nodeFacts, electron: facts, proxyRequests: proxyHits.length }))
  } finally { await new Promise<void>((resolve) => { proxy.closeAllConnections(); proxy.close(() => resolve()) }) }
}, 60000)
