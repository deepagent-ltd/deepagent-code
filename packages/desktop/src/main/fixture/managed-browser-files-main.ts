// Mechanical Main entry: original Manager and native confirmation; no Native factory or grant producer.
import { app, utilityProcess, BrowserWindow, dialog } from "electron"
import fs from "node:fs/promises"
import path from "node:path"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { installManagedBrowser } from "../managed-browser"
import { sharedBrowserManager } from "../shared-browser"
import { fileStages } from "./shared-browser-file-observer"

const root = process.env.DAC_BROWSER_FILES_ROOT!
const sharedUploadOnly = process.env.DAC_BROWSER_FILES_SHARED_UPLOAD_ONLY === "1"
const driverStages: Array<{
  id: number
  method: string
  event: string
  at: number
  error?: string
  sessionID?: string
  contextID?: number
}> = []
const contextEvents: Array<{ method: string; at: number; contextID?: number; sessionID?: string }> = []
if (sharedUploadOnly)
  app.on("web-contents-created", (_event, contents) => {
    contents.debugger.on("message", (_event, method, params: Record<string, unknown>, sessionID: string) => {
      if (
        contextEvents.length < 256 &&
        ["Runtime.executionContextDestroyed", "Runtime.executionContextsCleared"].includes(method)
      )
        contextEvents.push({
          method,
          at: Date.now(),
          sessionID,
          ...(typeof params.executionContextId === "number" ? { contextID: params.executionContextId } : {}),
        })
    })
    const send = contents.debugger.sendCommand.bind(contents.debugger)
    contents.debugger.sendCommand = async (...args: Parameters<typeof send>) => {
      const id = driverStages.length
      if (driverStages.length < 1024)
        driverStages.push({ id, method: args[0], event: "enter", at: Date.now(), sessionID: args[2] })
      try {
        const result = await send(...args)
        if (driverStages.length < 1024)
          driverStages.push({
            id,
            method: args[0],
            event: "return",
            at: Date.now(),
            sessionID: args[2],
            ...(args[0] === "Page.createIsolatedWorld" &&
            result &&
            typeof result === "object" &&
            "executionContextId" in result &&
            typeof result.executionContextId === "number"
              ? { contextID: result.executionContextId }
              : {}),
          })
        return result
      } catch (error) {
        if (driverStages.length < 1024)
          driverStages.push({ id, method: args[0], event: "throw", at: Date.now(), error: String(error) })
        throw error
      }
    }
  })
if (process.env.DAC_BROWSER_FILES_FRESH_SHARED_ONLY === "1" || sharedUploadOnly)
  app.commandLine.appendSwitch("disable-quic")

async function main() {
  app.setPath("userData", path.join(root, "electron-user"))
  app.setPath("sessionData", path.join(root, "electron-session"))
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const source = sharedUploadOnly ? Buffer.from("DAC native owned file fixture\n") : Buffer.alloc(32_768, 0xff)
  if (!sharedUploadOnly) source.write("binary\u0000source", 0)
  await fs.mkdir(path.join(root, "project"), { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(root, "project/source.bin"), source, { mode: 0o600 })
  const facts = {
    uploads: 0,
    downloads: 0,
    uploadBytes: 0,
    uploadHash: "",
    nativeConfirmRequests: [] as string[],
    controlledNativeDecisions: 0,
    permissionRevokedBeforeDecision: false,
    filePermitPassed: 0,
    filePermitDenied: 0,
  }
  const revoked = Promise.withResolvers<boolean>()
  const owner = sharedUploadOnly ? new BrowserWindow({ show: false, focusable: true }) : undefined
  if (owner) {
    await owner.loadURL("about:blank")
    owner.showInactive()
    sharedBrowserManager().registerFileConfirmationOwner(() => ({ window: owner, current: () => !owner.isDestroyed() }))
    const manager = sharedBrowserManager()
    const confirm = manager.confirmFile.bind(manager)
    manager.confirmFile = (resource, lease, preview, command, check) =>
      confirm(resource, lease, preview, command, async () => {
        try {
          await check()
          facts.filePermitPassed++
        } catch (error) {
          facts.filePermitDenied++
          throw error
        }
      })
    // This fixture isolates real Host/helper transport, not physical Native approval.
    dialog.showMessageBox = (async () => {
      facts.controlledNativeDecisions++
      if (facts.controlledNativeDecisions === 3) {
        child.postMessage({ type: "files-revoke-before-decision" })
        facts.permissionRevokedBeforeDecision = await revoked.promise
        assert.ok(facts.permissionRevokedBeforeDecision)
      }
      return { response: 1, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }
  const html =
    '<!doctype html><label>Upload file<input name="asset" type="file" form="upload"></label><form id="upload" method="post" action="/upload" enctype="multipart/form-data"></form><a href="/download">Download file</a>'
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("content-type", "text/html")
      res.end(html)
      return
    }
    if (req.method === "GET" && req.url === "/download") {
      facts.downloads++
      res.setHeader("content-type", "application/octet-stream")
      res.end(source)
      return
    }
    if (req.method === "POST" && req.url === "/upload") {
      facts.uploads++
      const chunks: Buffer[] = []
      for await (const bytes of req) chunks.push(Buffer.from(bytes))
      const body = Buffer.concat(chunks)
      const start = body.indexOf(Buffer.from("\r\n\r\n")) + 4
      const end = body.lastIndexOf(Buffer.from("\r\n--"))
      assert.ok(start >= 4 && end >= start)
      const received = body.subarray(start, end)
      assert.deepEqual(received, source)
      facts.uploadBytes = received.length
      facts.uploadHash = createHash("sha256").update(received).digest("hex")
      res.setHeader("content-type", "text/html")
      res.end(html)
      return
    }
    res.statusCode = 405
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const child = utilityProcess.fork(process.env.DAC_BROWSER_FILES_MODULE!, [], {
    cwd: path.join(root, "project"),
    env: { ...process.env, DAC_BROWSER_FILES_ORIGIN: `http://127.0.0.1:${address.port}` },
    stdio: "pipe",
  })
  const stop = installManagedBrowser(child, "private-files-module")
  const state = { result: undefined as unknown, stdout: "", stderr: "" }
  const timer = setTimeout(() => {
    stop()
    child.kill()
    app.exit(3)
  }, 180_000)
  child.stdout?.on("data", (bytes: Buffer) => {
    state.stdout += bytes.toString()
  })
  child.stderr?.on("data", (bytes: Buffer) => {
    state.stderr += bytes.toString()
  })
  child.on("message", (message: { type?: string; name?: string; result?: unknown; revoked?: boolean }) => {
    if (message.type === "files-native-confirm") {
      facts.nativeConfirmRequests.push(message.name!)
      console.log("FILES_NATIVE_CONFIRM", message.name)
    }
    if (message.type === "files-result") state.result = message.result
    if (message.type === "files-permission-revoked") revoked.resolve(message.revoked === true)
  })
  child.on("exit", (code) => {
    clearTimeout(timer)
    stop()
    server.closeAllConnections()
    if (owner && !owner.isDestroyed()) owner.destroy()
    server.close(() => {
      void fs
        .writeFile(
          path.join(root, "result.json"),
          JSON.stringify({
            code,
            result: state.result,
            facts,
            windows: BrowserWindow.getAllWindows().length,
            stdout: state.stdout,
            stderr: state.stderr,
            fileStages,
            driverStages,
            contextEvents,
          }),
          { mode: 0o600 },
        )
        .then(() => app.exit(code ?? 1))
    })
  })
}

void main().catch(async (error) => {
  await fs.writeFile(path.join(root, "main-failure.json"), JSON.stringify({ error: String(error) }), { mode: 0o600 })
  process.exit(1)
})
