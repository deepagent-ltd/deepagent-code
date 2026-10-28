import { app, BrowserWindow } from "electron"
import fs from "node:fs/promises"
import path from "node:path"
import { inspect } from "node:util"
import { writeFileSync } from "node:fs"

const root = process.env.DAC_BROWSER_INPUT_PROBE_ROOT
if (!root) throw new Error("Private input probe root is required")
const started = performance.now()
const progress = { phase: "module-loaded", elapsedMs: 0, beforeCleanup: undefined as string | undefined }
const stage = (phase: string) => {
  progress.phase = phase
  progress.elapsedMs = Math.round(performance.now() - started)
  writeFileSync(path.join(root, "phase.json"), JSON.stringify(progress), { mode: 0o600 })
}
stage("module-loaded")
app.setPath("userData", path.join(root, "profile"))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})

type Packet = { id: string; method: string; params: Record<string, unknown>; expected: Record<string, unknown> }
type Phase = "setup" | "raw_stack" | "returned_pending" | "settled" | "between_commands"
type Hook = { commandID?: string; hook: string; phase: Phase; rawCalling: boolean; promisePending?: boolean;
  reactionSettled: boolean; inputType?: string; fields: string[]; matches: boolean; missing: string[];
  mismatches: string[]; duplicate: boolean }

async function main() {
  stage("awaiting-app-ready")
  await app.whenReady()
  stage("creating-owned-window")
  const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "input-probe-private" } })
  const contents = window.webContents
  const events: Hook[] = []
  const commands: { id: string; method: string; events: number; returned: boolean; reactionSettled: boolean }[] = []
  const state = { packet: undefined as Packet | undefined, phase: "setup" as Phase, rawCalling: false,
    promise: undefined as Promise<unknown> | undefined, reactionSettled: false, asynchronous: false }
  const result = { version: 1, electron: process.versions.electron, node: process.versions.node,
    runtime: process.execPath, boundary: "raw original Electron Main/WC/CDP timing probe, no authority or production gate",
    events, commands, asyncFirst: undefined as Hook | undefined, stoppedAt: undefined as string | undefined,
    untested: [] as string[], sameWC: contents.id, destroyed: false, networkAttempts: 0,
    permissionRequests: 0, clipboardOperations: 0, utilityProcesses: 0, database: 0, provider: 0,
    continuityProven: false, synchronousTicketEligible: false, page: undefined as unknown }
  contents.session.setPermissionCheckHandler(() => false)
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => { result.permissionRequests++; callback(false) })
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    if (!details.url.startsWith("data:")) result.networkAttempts++
    callback({ cancel: !details.url.startsWith("data:") })
  })
  const record = (hook: string, input: object) => {
    const value: Record<string, unknown> = Object.fromEntries(Object.entries(input))
    const expected = state.packet?.expected ?? {}
    const missing = Object.keys(expected).filter((key) => !Object.hasOwn(value, key))
    const mismatches = Object.keys(expected).filter((key) => Object.hasOwn(value, key) && value[key] !== expected[key])
    const pending = state.promise ? inspect(state.promise, { depth: 0 }).includes("<pending>") : undefined
    const event: Hook = { commandID: state.packet?.id, hook, phase: state.rawCalling ? "raw_stack" :
      state.packet ? pending ? "returned_pending" : "settled" : state.phase, rawCalling: state.rawCalling,
      promisePending: pending, reactionSettled: state.reactionSettled,
      inputType: typeof value.type === "string" ? value.type : undefined, fields: Object.keys(value),
      matches: Object.keys(expected).length > 0 && missing.length === 0 && mismatches.length === 0,
      missing, mismatches, duplicate: events.some((event) => event.commandID === state.packet?.id && event.hook === hook) }
    events.push(event)
    if (state.phase === "setup" || state.rawCalling) return
    state.asynchronous = true
    result.asyncFirst ??= event
  }
  contents.on("before-input-event", (_event, input) => record("before-input-event", input))
  contents.on("before-mouse-event", (_event, input) => record("before-mouse-event", input))
  contents.on("input-event", (_event, input) => record("input-event", input))
  const page = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
    <style>input,button,#scroll{position:absolute;left:20px;width:220px}input{top:20px;height:40px}button{top:100px;height:50px}#scroll{top:200px;height:150px;overflow:auto}</style>
    <input id="field" aria-label="Owned probe field"><button id="button">Owned click</button><div id="scroll"><div style="height:2000px">Owned scroll</div></div>
    <script>window.counts={input:0,key:0,click:0,wheel:0};field.oninput=()=>counts.input++;field.onkeydown=()=>counts.key++;button.onclick=()=>counts.click++;scroll.onwheel=()=>counts.wheel++;field.focus()</script>`
  const packets: Packet[] = [
    { id: "key-down", method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65, modifiers: 0, autoRepeat: false },
      expected: { type: "keyDown", key: "a", code: "KeyA", shift: false, control: false, alt: false, meta: false, isAutoRepeat: false } },
    { id: "key-up", method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0 },
      expected: { type: "keyUp", key: "a", code: "KeyA", shift: false, control: false, alt: false, meta: false, isAutoRepeat: false } },
    { id: "insert-text", method: "Input.insertText", params: { text: "own-probe" }, expected: {} },
    { id: "mouse-move", method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 80, y: 120, button: "none", modifiers: 0 }, expected: { type: "mouseMove", x: 80, y: 120 } },
    { id: "mouse-down", method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 80, y: 120, button: "left", buttons: 1, clickCount: 1, modifiers: 0 },
      expected: { type: "mouseDown", x: 80, y: 120, button: "left", clickCount: 1 } },
    { id: "mouse-up", method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 80, y: 120, button: "left", buttons: 0, clickCount: 1, modifiers: 0 },
      expected: { type: "mouseUp", x: 80, y: 120, button: "left", clickCount: 1 } },
    { id: "wheel", method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 80, y: 250, deltaX: 0, deltaY: 120, modifiers: 0 },
      expected: { type: "mouseWheel", x: 80, y: 250, deltaX: 0, deltaY: 120 } },
  ]
  try {
    stage("loading-owned-data-page")
    await contents.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page))
    stage("attaching-debugger")
    contents.debugger.attach("1.3")
    stage("enabling-page")
    await contents.debugger.sendCommand("Page.enable")
    const raw = contents.debugger.sendCommand.bind(contents.debugger)
    const dispatch = async (packet: Packet) => {
      state.packet = packet; state.reactionSettled = false; state.promise = undefined
      const before = events.length
      const observed = { id: packet.id, method: packet.method, events: 0, returned: false, reactionSettled: false }
      commands.push(observed)
      state.rawCalling = true; state.phase = "raw_stack"
      // The sole possible future exemption ends in this finally, before any
      // Promise reaction, await or native event-loop observation is allowed.
      try { state.promise = raw(packet.method, packet.params) }
      finally { state.rawCalling = false; state.phase = "returned_pending"; observed.returned = true }
      await state.promise.then(() => { state.reactionSettled = true; state.phase = "settled"; observed.reactionSettled = true })
      // Diagnostic observation only, never an admission/ticket lifetime.
      await new Promise((resolve) => setTimeout(resolve, 50))
      observed.events = events.length - before
      state.packet = undefined; state.phase = "between_commands"
    }
    for (const packet of packets) {
      // Keep diagnostic I/O outside dispatch's original raw-call/Promise boundary.
      stage(`dispatch:${packet.id}`)
      await dispatch(packet)
      if (!state.asynchronous) continue
      result.stoppedAt = packet.id
      result.untested = packets.slice(packets.indexOf(packet) + 1).map((packet) => packet.id)
      // Only release the exact input already held; no new click/fill/scroll is
      // issued after the first asynchronous native hook invalidates the design.
      const release = packet.id === "key-down" ? packets[1] : packet.id === "mouse-down" ? packets[5] : undefined
      if (release) { stage(`cleanup:${release.id}`); await dispatch({ ...release, id: "cleanup-" + release.id }) }
      break
    }
    stage("reading-owned-page")
    result.page = await contents.executeJavaScript("({value:field.value,counts:window.counts,scrollTop:document.getElementById('scroll').scrollTop})")
    result.continuityProven = !state.asynchronous && result.untested.length === 0
    result.synchronousTicketEligible = result.continuityProven && events.length > 0 && events.every((event) =>
      event.rawCalling && event.matches && !event.duplicate)
  } finally {
    progress.beforeCleanup = progress.phase
    stage("destroying-owned-window")
    if (contents.debugger.isAttached()) contents.debugger.detach()
    const destroyed = new Promise<void>((resolve) => contents.once("destroyed", resolve))
    window.destroy()
    await destroyed
    result.destroyed = contents.isDestroyed()
    stage("writing-result")
    await fs.writeFile(path.join(root!, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 })
    stage("completed")
  }
}

main().then(() => app.exit(0), async (error: unknown) => {
  const safe = (value: string) => value.replaceAll(root, "<owned-probe>").replace(/data:[^\s]+/g, "<owned-data-url>")
  await fs.writeFile(path.join(root!, "failure.json"), JSON.stringify({ code: error instanceof Error ? error.name : "unknown",
    phase: progress.phase, beforeCleanup: progress.beforeCleanup, elapsedMs: Math.round(performance.now() - started),
    message: error instanceof Error ? safe(error.message).slice(0, 512) : undefined,
    stack: error instanceof Error ? safe(error.stack ?? "").split("\n").slice(0, 9).join("\n").slice(0, 4096) : undefined,
  }), { mode: 0o600 })
  app.exit(1)
})
