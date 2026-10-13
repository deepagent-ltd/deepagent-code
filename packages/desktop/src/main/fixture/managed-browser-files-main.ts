// Mechanical Main entry: original Manager and native confirmation; no Native factory or grant producer.
import { app, utilityProcess, BrowserWindow } from "electron"
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { installManagedBrowser } from "../managed-browser"

const root = process.env.DAC_BROWSER_FILES_ROOT!

async function main() {
  app.setPath("userData", path.join(root, "electron-user")); app.setPath("sessionData", path.join(root, "electron-session"))
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const source = Buffer.alloc(32_768, 0xff)
  source.write("binary\u0000source", 0)
  await fs.mkdir(path.join(root, "project"), { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(root, "project/source.bin"), source, { mode: 0o600 })
  const facts = { uploads: 0, downloads: 0, uploadHash: "", nativeConfirmRequests: [] as string[] }
  const html = '<!doctype html><label>Upload file<input name="asset" type="file" form="upload"></label><form id="upload" method="post" action="/upload" enctype="multipart/form-data"></form><a href="/download">Download file</a>'
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") { res.setHeader("content-type", "text/html"); res.end(html); return }
    if (req.method === "GET" && req.url === "/download") { facts.downloads++; res.setHeader("content-type", "application/octet-stream"); res.end(source); return }
    if (req.method === "POST" && req.url === "/upload") {
      facts.uploads++
      const chunks: Buffer[] = []
      for await (const bytes of req) chunks.push(Buffer.from(bytes))
      const body = Buffer.concat(chunks)
      assert.ok(body.includes(source))
      facts.uploadHash = createHash("sha256").update(source).digest("hex")
      res.setHeader("content-type", "text/html"); res.end(html); return
    }
    res.statusCode = 405; res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address(); assert.ok(address && typeof address !== "string")
  const child = utilityProcess.fork(process.env.DAC_BROWSER_FILES_MODULE!, [], { cwd: path.join(root, "project"),
    env: { ...process.env, DAC_BROWSER_FILES_ORIGIN: `http://127.0.0.1:${address.port}` }, stdio: "pipe" })
  const stop = installManagedBrowser(child, "private-files-module")
  const state = { result: undefined as unknown, stdout: "", stderr: "" }
  const timer = setTimeout(() => { stop(); child.kill(); app.exit(3) }, 180_000)
  child.stdout?.on("data", (bytes: Buffer) => { state.stdout += bytes.toString() })
  child.stderr?.on("data", (bytes: Buffer) => { state.stderr += bytes.toString() })
  child.on("message", (message: { type?: string; name?: string; result?: unknown }) => {
    if (message.type === "files-native-confirm") { facts.nativeConfirmRequests.push(message.name!); console.log("FILES_NATIVE_CONFIRM", message.name) }
    if (message.type === "files-result") state.result = message.result
  })
  child.on("exit", (code) => {
    clearTimeout(timer); stop(); server.closeAllConnections()
    server.close(() => { void fs.writeFile(path.join(root, "result.json"), JSON.stringify({ code, result: state.result, facts,
      windows: BrowserWindow.getAllWindows().length, stdout: state.stdout, stderr: state.stderr }), { mode: 0o600 }).then(() => app.exit(code ?? 1)) })
  })
}


void main().catch(async (error) => {
  await fs.writeFile(path.join(root, "main-failure.json"), JSON.stringify({ error: String(error) }), { mode: 0o600 }); process.exit(1)
})
