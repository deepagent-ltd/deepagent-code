import { app, BrowserWindow } from "electron"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { appendFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { observeManagedBrowserInput, type ManagedBrowserInputAsset } from "../managed-browser-input-observer"

const root = process.argv[2]!
const stage = (value: string) => appendFileSync(path.join(root, "stages.log"), `${value}\n`)
app.setPath("userData", path.join(root, "profile"))
app.on("window-all-closed", () => {})
process.on("uncaughtException", (error) => {
  writeFileSync(path.join(root, "uncaught.json"), JSON.stringify({ name: error.name, message: error.message }))
  console.error("QA_INPUT_UNCAUGHT", error.name, error.message)
  process.exit(1)
})
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 75))
const windows: BrowserWindow[] = []
const facts = { ownedCDP: [] as { method: string; ticks: number }[], callbacks: [] as number[],
  reentrant: false, thrownCallback: false, capacity: false, churn: 0, closedWindow: false }
const makeWindow = async () => {
  const window = new BrowserWindow({ show: false, width: 400, height: 300,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      partition: `qa-input-observer-${crypto.randomUUID()}` } })
  windows.push(window)
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false))
  window.webContents.session.webRequest.onBeforeRequest((details, reply) => reply({ cancel: !details.url.startsWith("data:") }))
  await window.loadURL("data:text/html," + encodeURIComponent('<input id="field"><div style="height:2000px">Local source</div>'))
  return window
}

async function main() {
  await app.whenReady()
  stage("ready")
  // Load the QA hook first so its cleanup receipt runs after the production hook.
  const qa = createRequire(import.meta.url)(path.join(root, "qa.node")) as {
    postKey(handle: Buffer): void; counts(): { installed: number; removed: number }; cleanup(filename: string): void
    makeWindow(): Buffer; closeWindows(): void; tracking(value: boolean): void }
  qa.cleanup(path.join(root, "cleanup.json"))
  stage("qa-loaded")
  const asset = JSON.parse(await fs.readFile(path.join(root, "asset.json"), "utf8")) as ManagedBrowserInputAsset
  const observe = (window: BrowserWindow, invalidate: () => void) => {
    qa.tracking(true)
    try { return observeManagedBrowserInput({ window, invalidate, asset }) } finally { qa.tracking(false) }
  }
  const window = await makeWindow()
  const other = await makeWindow()
  stage("windows")
  const ticks = { value: 0 }
  const lease = observe(window, (...arguments_: unknown[]) => { facts.callbacks.push(arguments_.length); ticks.value++ })
  assert.equal(lease.status, "available")
  if (lease.status !== "available") throw new Error("QA_OBSERVER_UNAVAILABLE")
  stage("observed")
  assert.equal(lease.healthy(), true)
  assert.equal(observe(window, () => {}).status, "unavailable")
  window.webContents.debugger.attach("1.3")
  await window.webContents.debugger.sendCommand("Page.enable")
  await window.webContents.executeJavaScript('document.querySelector("input").focus()')
  for (const [method, parameters] of [
    ["Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 }],
    ["Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }],
    ["Input.insertText", { text: "owned中文" }],
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 100 }],
    ["Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100, button: "left", clickCount: 1 }],
    ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 100, button: "left", clickCount: 1 }],
    ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: 120 }],
  ] as const) {
    await window.webContents.debugger.sendCommand(method, parameters)
    await delay()
    facts.ownedCDP.push({ method, ticks: ticks.value })
  }
  assert.equal(ticks.value, 0)
  stage("cdp-complete")
  qa.postKey(other.getNativeWindowHandle()); await delay()
  assert.equal(ticks.value, 0)
  qa.postKey(window.getNativeWindowHandle()); await delay()
  assert.ok(ticks.value >= 1)
  const ownedNativeTicks = ticks.value
  lease.release(); lease.release()
  assert.equal(lease.healthy(), false)
  qa.postKey(window.getNativeWindowHandle()); await delay()
  assert.equal(ticks.value, ownedNativeTicks)
  const reentrant = observe(window, () => { if (reentrant.status === "available") reentrant.release(); facts.reentrant = true })
  assert.equal(reentrant.status, "available")
  qa.postKey(window.getNativeWindowHandle()); await delay()
  assert.equal(facts.reentrant, true)
  assert.equal(reentrant.status === "available" && reentrant.healthy(), false)
  const failing = observe(window, () => { facts.thrownCallback = true; throw new Error("QA_SYNTHETIC_PRIVATE_BODY") })
  assert.equal(failing.status, "available")
  qa.postKey(window.getNativeWindowHandle()); await delay()
  assert.equal(facts.thrownCallback, true)
  assert.equal(failing.status === "available" && failing.healthy(), false)
  const closing = observe(other, () => {})
  assert.equal(closing.status, "available")
  other.destroy()
  assert.equal(closing.status === "available" && closing.healthy(), false)
  facts.closedWindow = true
  stage("release-complete")
  const binding = createRequire(import.meta.url)(asset.path) as {
    observe(handle: Buffer, callback: () => void): { healthy(): boolean; release(): void } }
  const observeNative = (handle: Buffer) => {
    qa.tracking(true)
    try { return binding.observe(handle, () => {}) } finally { qa.tracking(false) }
  }
  // A healthy source now requires each real window's current Cocoa text client.
  const capacityWindows = await Promise.all(Array.from({ length: 17 }, makeWindow))
  stage("capacity-windows")
  const leases = capacityWindows.slice(0, 16).map((window, index) => {
    const lease = observeNative(window.getNativeWindowHandle())
    stage(`capacity-lease-${index}`)
    return lease
  })
  assert.equal(leases.every((lease) => lease.healthy()), true)
  assert.throws(() => observeNative(capacityWindows[16]!.getNativeWindowHandle()), /MANAGED_BROWSER_INPUT_CAPACITY/)
  facts.capacity = true
  stage("capacity-complete")
  leases.forEach((lease) => lease.release())
  stage("capacity-released")
  capacityWindows.forEach((window) => window.destroy())
  for (const _ of Array.from({ length: 32 })) {
    const current = observe(window, () => {})
    assert.equal(current.status, "available")
    if (current.status === "available") current.release()
    facts.churn++
  }
  assert.throws(() => observeNative(Buffer.alloc(8)), /MANAGED_BROWSER_INPUT_WINDOW/)
  assert.throws(() => observeNative(Buffer.alloc(7)), /MANAGED_BROWSER_INPUT_WINDOW/)
  const live = observe(window, () => {})
  assert.equal(live.status, "available")
  const counts = qa.counts()
  assert.equal(counts.installed - counts.removed, 1)
  stage("complete")
  writeFileSync(path.join(root, "result.json"), JSON.stringify({ facts, counts,
    runtime: { electron: process.versions.electron, node: process.versions.node, arch: process.arch },
    boundary: { physicalHuman: false, globalMonitor: false, clipboard: 0, provider: 0 } }))
  // Keep one live watch until the actual Node environment cleanup hook runs.
}
main().then(() => { stage("exiting"); process.exit(0) }, (error: unknown) => {
  writeFileSync(path.join(root, "failure.json"), JSON.stringify({ error: error instanceof Error ? error.message : "QA_FAILURE" }))
  console.error(error)
  windows.forEach((window) => { if (!window.isDestroyed()) window.destroy() })
  process.exit(1)
})
