import { app, BrowserWindow } from "electron"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { appendFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = process.argv[2]!
const scenario = process.argv[3] ?? "source"
const stage = (value: string) => appendFileSync(path.join(root, "stages.log"), value + "\n")
app.setPath("userData", path.join(root, `profile-${scenario}`))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 75))
type Lease = { healthy(): boolean; release(): void }
const windows: BrowserWindow[] = []
const makeWindow = async () => {
  const window = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    partition: `ime-production-${crypto.randomUUID()}` } })
  windows.push(window)
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false))
  window.webContents.session.webRequest.onBeforeRequest((details, reply) => reply({ cancel: !details.url.startsWith("data:") && details.url !== "about:blank" }))
  return window
}

async function main() {
  stage("app-ready:waiting")
  await app.whenReady()
  stage("app-ready")
  const runtimeGate = scenario === "pin"
  if (runtimeGate) {
    const require = createRequire(import.meta.url)
    const version = Object.getOwnPropertyDescriptor(process.versions, "electron")!
    const kind = Object.getOwnPropertyDescriptor(process, "type")!
    try {
      Object.defineProperty(process.versions, "electron", { ...version, value: "41.10.4" })
      assert.throws(() => require(path.join(root, "managed-browser-input-darwin.node")), /MANAGED_BROWSER_INPUT_RUNTIME_ABI/)
      Object.defineProperty(process.versions, "electron", version)
      Object.defineProperty(process, "type", { ...kind, value: "utility" })
      assert.throws(() => require(path.join(root, "managed-browser-input-darwin.node")), /MANAGED_BROWSER_INPUT_RUNTIME_ABI/)
    } finally {
      Object.defineProperty(process.versions, "electron", version)
      Object.defineProperty(process, "type", kind)
    }
    stage("runtime-gate-rejected")
  }
  stage("native:loading")
  const qa = createRequire(import.meta.url)(path.join(root, "ime-qa.node")) as {
    invoke(handle: Buffer, kind: number): void; foreign(enabled: boolean): void
    subclass(handle: Buffer): void; restoreClass(handle: Buffer): void
    state(): { restored: boolean; foreignOwned: boolean; delegated: number }
    cleanup(filename: string): void; abi(): string[]; late(handle: Buffer): void }
  qa.cleanup(path.join(root, `${scenario}-cleanup.json`))
  const native = createRequire(import.meta.url)(path.join(root, "managed-browser-input-darwin.node")) as {
    observe(handle: Buffer, callback: () => void): Lease }
  stage("window:creating")
  const window = await makeWindow()
  stage("window:empty-source-rejection")
  assert.throws(() => native.observe(window.getNativeWindowHandle(), () => {}), /MANAGED_BROWSER_INPUT_CLIENT_ABI/)
  stage("blank:loading")
  await window.loadURL("about:blank")
  stage("blank:observing")
  const blank = native.observe(window.getNativeWindowHandle(), () => {})
  assert.equal(blank.healthy(), true)
  stage("document:loading")
  await window.loadURL("data:text/html,<input><div style='height:2000px'>Private source</div>")
  stage("document:prior-source-retired")
  assert.equal(blank.healthy(), false)
  blank.release()
  stage("initial-boundary")
  await window.webContents.executeJavaScript("document.querySelector('input').focus()")
  const callbacks: number[] = []
  const sourceCallbacks: { ordinal: number; at: number; wallAt: number }[] = []
  stage("document:observing")
  const lease = native.observe(window.getNativeWindowHandle(), (...args: unknown[]) => {
    const count = callbacks.push(args.length)
    if (process.env.DAC_MANAGED_BROWSER_INPUT_DIAGNOSTICS === "1" && sourceCallbacks.length < 32)
      sourceCallbacks.push({ ordinal: count, at: performance.now(), wallAt: Date.now() })
    return count
  })
  assert.equal(lease.healthy(), true)
  if (scenario.startsWith("foreign")) {
    window.webContents.debugger.attach("1.3")
    await window.webContents.debugger.sendCommand("Input.insertText", { text: "owned" })
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: 12, y: 12, button: "left", clickCount: 1 })
    await window.webContents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: 12, y: 12, button: "left", clickCount: 1 })
    await delay()
    assert.equal(callbacks.length, 0)
    qa.foreign(true)
    if (scenario === "foreign-env") {
      qa.late(window.getNativeWindowHandle())
      writeFileSync(path.join(root, `${scenario}-result.json`), JSON.stringify({ liveForeignAtCleanup: true, callbacks }))
      process.exit(0)
      return
    }
    assert.equal(lease.healthy(), false)
    lease.release()
    assert.equal(qa.state().foreignOwned, true)
    qa.invoke(window.getNativeWindowHandle(), 0)
    await delay()
    assert.equal(qa.state().delegated, 1)
    assert.equal(callbacks.length, 0)
    writeFileSync(path.join(root, `${scenario}-state.json`), JSON.stringify({ native: qa.state(),
      dom: await window.webContents.executeJavaScript("({length:document.querySelector('input').value.length,owned:document.querySelector('input').value.includes('owned'),committed:document.querySelector('input').value.includes('候选'),focused:document.activeElement===document.querySelector('input')})") }))
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('input').value.includes('候选')"), true)
    qa.foreign(false)
    assert.equal(qa.state().restored, true)
    assert.throws(() => native.observe(window.getNativeWindowHandle(), () => {}), /CLIENT_ABI/)
    writeFileSync(path.join(root, `${scenario}-result.json`), JSON.stringify({ ownershipLost: true,
      foreignPreserved: true, tombstoneDelegated: true, taintedRefused: true, callbacks, abi: qa.abi() }))
    process.exit(0)
    return
  }
  stage("cdp:starting")
  window.webContents.debugger.attach("1.3")
  const cdp: { method: string; callbacks: number; at: number; wallAt: number }[] = []
  for (const [method, parameters] of [
    ["Input.insertText", { text: "owned中文" }],
    ["Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 }],
    ["Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }],
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 100, y: 100 }],
    ["Input.dispatchMouseEvent", { type: "mousePressed", x: 100, y: 100, button: "left", clickCount: 1 }],
    ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 100, y: 100, button: "left", clickCount: 1 }],
    ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 100, deltaX: 0, deltaY: 120 }],
  ] as const) {
    await window.webContents.debugger.sendCommand(method, parameters); await delay()
    cdp.push({ method, callbacks: callbacks.length, at: performance.now(), wallAt: Date.now() })
    if (process.env.DAC_MANAGED_BROWSER_INPUT_DIAGNOSTICS === "1") {
      try {
        writeFileSync(path.join(root, `${scenario}-source.json`), JSON.stringify({ cdp, callbacks: sourceCallbacks }), { mode: 0o600 })
      } catch {}
    }
  }
  stage("cdp:complete")
  assert.equal(callbacks.length, 0)
  await window.webContents.executeJavaScript("document.querySelector('input').focus()")
  stage("second-window:creating")
  const other = await makeWindow()
  await other.loadURL("data:text/html,<input>")
  const otherCalls: number[] = []
  stage("second-window:observing")
  const second = native.observe(other.getNativeWindowHandle(), (...args: unknown[]) => otherCalls.push(args.length))
  qa.invoke(other.getNativeWindowHandle(), 0); await delay()
  assert.equal(callbacks.length, 0); assert.deepEqual(otherCalls, [0])
  for (const kind of [0, 1, 2]) { qa.invoke(window.getNativeWindowHandle(), kind); await delay() }
  assert.deepEqual(callbacks, [0, 0, 0])
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('input').value.includes('候选')"), true)
  lease.release(); lease.release(); assert.equal(lease.healthy(), false)
  assert.equal(second.healthy(), true); assert.equal(qa.state().restored, false)
  qa.invoke(other.getNativeWindowHandle(), 0); await delay(); assert.equal(otherCalls.length, 2)
  second.release(); assert.equal(qa.state().restored, true)
  qa.invoke(window.getNativeWindowHandle(), 0); await delay(); assert.equal(callbacks.length, 3)
  stage("source-and-refcount")
  if (runtimeGate) {
    const live = native.observe(window.getNativeWindowHandle(), () => {})
    assert.equal(live.healthy(), true)
    writeFileSync(path.join(root, `${scenario}-result.json`), JSON.stringify({ cdp, callbacks, otherCalls,
      abi: qa.abi(), runtimeGate: true, initialEmptyRejected: true, documentBoundaryRequired: true,
      sameVersionSource: true, liveAtCleanup: true, physicalHuman: false,
      runtime: { electron: process.versions.electron, node: process.versions.node, arch: process.arch } }))
    process.exit(0)
    return
  }
  const reentrant = native.observe(window.getNativeWindowHandle(), () => reentrant.release())
  qa.invoke(window.getNativeWindowHandle(), 0); await delay(); assert.equal(reentrant.healthy(), false)
  assert.equal(qa.state().restored, true)
  const throwing = native.observe(window.getNativeWindowHandle(), () => { throw new Error("QA_PRIVATE_CALLBACK") })
  qa.invoke(window.getNativeWindowHandle(), 0); await delay(); assert.equal(throwing.healthy(), false)
  const promise = native.observe(window.getNativeWindowHandle(), async () => {})
  qa.invoke(window.getNativeWindowHandle(), 0); await delay(); assert.equal(promise.healthy(), false)
  const moved = native.observe(window.getNativeWindowHandle(), () => {})
  qa.invoke(window.getNativeWindowHandle(), 3)
  assert.equal(moved.healthy(), false); assert.equal(qa.state().restored, true)
  const replaced = native.observe(window.getNativeWindowHandle(), () => {})
  qa.invoke(window.getNativeWindowHandle(), 4)
  assert.equal(replaced.healthy(), false)
  const changed = native.observe(window.getNativeWindowHandle(), () => {})
  qa.subclass(window.getNativeWindowHandle()); assert.equal(changed.healthy(), false)
  qa.restoreClass(window.getNativeWindowHandle()); assert.equal(changed.healthy(), false)
  stage("retired-lifecycle")
  const extraCalls: number[] = []
  const extra = native.observe(window.getNativeWindowHandle(), (...args: unknown[]) => extraCalls.push(args.length))
  const extraSources: number[] = []
  for (const kind of [5, 6, 7]) { const before = extraCalls.length; qa.invoke(window.getNativeWindowHandle(), kind); await delay(); extraSources.push(extraCalls.length - before) }
  assert.deepEqual(extraSources, [1, 1, 1]); assert.equal(extraCalls.every((count) => count === 0), true)
  extra.release()
  const closed = native.observe(other.getNativeWindowHandle(), () => {})
  other.destroy(); assert.equal(closed.healthy(), false)
  const live = native.observe(window.getNativeWindowHandle(), () => {})
  assert.equal(live.healthy(), true)
  writeFileSync(path.join(root, `${scenario}-result.json`), JSON.stringify({ cdp, callbacks, otherCalls,
    extraSources, abi: qa.abi(), initialEmptyRejected: true, documentBoundaryRequired: true,
    multiWatch: true, reentrant: true, throwing: true, promiseRejected: true,
    persistentSubviewRetired: true, weakRootRetired: true, classChangeRetired: true,
    closed: true, liveAtCleanup: true, runtimeGate, physicalHuman: false,
    runtime: { electron: process.versions.electron, node: process.versions.node, arch: process.arch } }))
  stage("complete")
  process.exit(0)
}
void main().catch((error: unknown) => {
  writeFileSync(path.join(root, `${scenario}-failure.json`), JSON.stringify({
    name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : "QA_FAILED",
    stack: error instanceof Error ? error.stack : undefined }))
  windows.forEach((window) => { if (!window.isDestroyed()) window.destroy() })
  process.exit(1)
})
