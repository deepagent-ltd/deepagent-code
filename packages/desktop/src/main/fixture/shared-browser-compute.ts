import { app, BrowserWindow } from "electron"
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { createSharedBrowserComputation, sharedBrowserComputationState } from "../shared-browser-compute"
import type { BrowserSchema } from "@deepagent-code/core/browser/schema"

// A finite computation leaf qualification only. This intentionally imports no
// rolling Main manager, file transport, durable Session or Native proof fixture.
const root = process.env.DAC_SHARED_COMPUTE_ROOT!
app.setPath("userData", path.join(root, "electron-user"))
app.setPath("sessionData", path.join(root, "electron-session"))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})
class Failure extends Error { constructor(readonly code: BrowserSchema.Error["code"]) { super(code) } }
const fail = (code: BrowserSchema.Error["code"]): never => { throw new Failure(code) }
const code = (error: unknown) => error instanceof Failure ? error.code : "unclassified"
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const phase = async (stage: string) => writeFile(path.join(root, "stage.json"), JSON.stringify({ stage }), { mode: 0o600 })

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, focusable: false, webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true } })
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent("<!doctype html><body><input id='keep' value='original-owned'><script>window.ownedNonce=" + JSON.stringify(randomUUID()) + "</script>"))
  const before = await window.webContents.executeJavaScript("({id:window.ownedNonce,value:document.querySelector('#keep').value})")
  const page = { text: "public observation", refs: [], truncated: false, frameID: "owned-frame", observationRevision: 1, generation: 1 }
  const execute = (source: string, key = randomUUID()) => createSharedBrowserComputation({ resourceKey: key,
    command: { type: "evaluate", tabID: "owned-tab", frameID: page.frameID, observationRevision: 1, generation: 1,
      source, scriptHash: digest(source), argsJSON: '{"value":"中文🙂"}' }, page, deadline: Date.now() + 8000,
    current: async () => {}, currentNow: () => {}, fail })
  await phase("portable-worker-json-and-no-host-capabilities")
  const output = await execute('return {echo:args.value,text:page.text,absent:[typeof document,typeof process,typeof require,typeof fetch,typeof RTCPeerConnection,typeof WebSocket,typeof globalThis.__DAC_SHARED_COMPUTE_RUNTIME_URL__]};').result
  const result = JSON.parse(output.json)
  assert.equal(result.echo, "中文🙂")
  assert.equal(result.text, page.text)
  assert.deepEqual(result.absent, Array(7).fill("undefined"))
  assert.equal(output.evidence.context, "snapshot-json-v1")
  await phase("strict-json-memory-and-absolute-deadline")
  const denied = []
  for (const source of ['return {get blocked(){throw Error("must not run")}};', 'return {toJSON(){return 1}};', 'return Promise.resolve(1);', 'const a={};a.a=a;return a;', 'const a=[];while(true)a.push(new Uint8Array(1024*1024));']) {
    const rejected = await execute(source).result.then(() => "unexpected-success", code)
    assert.equal(rejected, "BROWSER_INVALID_RECORD")
    denied.push(rejected)
  }
  const deadlineStartedAt = performance.now()
  assert.equal(await execute("while(true){}").result.then(() => "unexpected-success", code), "BROWSER_CANCELLED")
  const deadlineElapsedMs = performance.now() - deadlineStartedAt
  await phase("actual-worker-cancel-exit-and-capacity")
  const keys = Array.from({ length: 4 }, () => randomUUID())
  const workers = keys.map((key) => execute("while(true){}", key))
  const outcomes = workers.map((worker) => worker.result.then(() => "unexpected-success", code))
  assert.throws(() => execute("return 1", keys[0]), (error: unknown) => code(error) === "BROWSER_CAPACITY")
  assert.throws(() => execute("return 1"), (error: unknown) => code(error) === "BROWSER_CAPACITY")
  const startedUntil = Date.now() + 1500
  while (!keys.every((key) => sharedBrowserComputationState(key)?.started) && Date.now() < startedUntil)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(keys.every((key) => sharedBrowserComputationState(key)?.started), true)
  workers.forEach((worker) => worker.cancel())
  assert.deepEqual(await Promise.all(outcomes), Array(4).fill("BROWSER_CANCELLED"))
  assert.equal(keys.every((key) => sharedBrowserComputationState(key) === undefined), true)
  const after = await window.webContents.executeJavaScript("({id:window.ownedNonce,value:document.querySelector('#keep').value})")
  assert.deepEqual(after, before)
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  await writeFile(path.join(root, "result.json"), JSON.stringify({ mode: "portable-quickjs-compute-leaf", electron: process.versions.electron,
    node: process.versions.node, platform: process.platform, arch: process.arch, pureJson: true, noHostCapabilities: result.absent,
    strictAndMemoryRejected: denied, deadlineCancelled: true, deadlineElapsedMs, perResourceAndGlobalCapacity: true,
    actualFourWorkersStarted: true, actualExitBeforeSlotsReleased: true, sameOriginalPage: true, providerCalls: 0,
    fullMainManagerAcceptance: false, nativePackageAcceptance: false, physicalInputAcceptance: false }, null, 2), { mode: 0o600 })
  window.destroy()
  app.exit(0)
}).catch(async (error: unknown) => {
  await writeFile(path.join(root, "failure.json"), JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }), { mode: 0o600 })
  app.exit(1)
})
