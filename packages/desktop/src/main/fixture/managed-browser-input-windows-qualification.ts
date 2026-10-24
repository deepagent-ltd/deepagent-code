import { app, BrowserWindow } from "electron"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { managedBrowserInputRuntime } from "../../../scripts/managed-browser-input-runtime"

// A trusted qualifier explicitly supplies its own compiled candidate and private
// directory. This never selects a production asset or certifies native/IME input.
const directory = process.env.DAC_WINDOWS_INPUT_QA_DIRECTORY
const filename = process.env.DAC_WINDOWS_INPUT_QA_MODULE
const expected = process.env.DAC_WINDOWS_INPUT_QA_SHA256
if (
  !directory ||
  !path.isAbsolute(directory) ||
  !filename ||
  !path.isAbsolute(filename) ||
  !expected ||
  !/^[a-f0-9]{64}$/.test(expected)
)
  throw new Error("WINDOWS_INPUT_QA_OPTIONS")

app.setPath("userData", path.join(directory, "profile"))
app.commandLine.appendSwitch("disable-background-networking")
app.on("window-all-closed", () => {})

type Counts = Readonly<Record<string, number | boolean>>
type Lease = Readonly<{ healthy(): boolean; release(): void }>
type Binding = Readonly<{ version: number; accounting(): Counts; observe(handle: Buffer, callback: () => void): Lease }>
type Page = Readonly<{
  value: string
  scrollTop: number
  composing: boolean
  counts: Readonly<{
    input: number
    keyDown: number
    keyUp: number
    click: number
    wheel: number
    mouseMove: number
    mouseDown: number
    mouseUp: number
    compositionStart: number
    compositionUpdate: number
    compositionEnd: number
  }>
}>
const state = {
  window: undefined as BrowserWindow | undefined,
  binding: undefined as Binding | undefined,
  lease: undefined as Lease | undefined,
  callbacks: 0,
}
const result = {
  schemaVersion: "dac.windows-input.w0-cdp-qa.v1",
  state: "pending",
  moduleSha256: expected,
  runtime: { electron: process.versions.electron, node: process.versions.node, chromium: process.versions.chrome },
  processSessionVerified: false,
  interactiveDesktopVerified: false,
  nativeUserInputVerified: false,
  imeVerified: false,
  candidatePromoted: false,
  pageOracleVerified: false,
  permissions: 0,
  network: 0,
  before: undefined as Counts | undefined,
  observed: undefined as Counts | undefined,
  after: undefined as Counts | undefined,
  callbacks: 0,
  destroyed: false,
  cleanupErrors: [] as string[],
  cases: [] as { id: string; method: string; callbacks: number; healthy: boolean; effect: boolean; page: Page }[],
  page: undefined as unknown,
  error: undefined as { name: string; message: string } | undefined,
}

async function main() {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.versions.electron !== managedBrowserInputRuntime.electronVersion ||
    process.versions.node !== managedBrowserInputRuntime.nodeVersion ||
    process.versions.chrome !== managedBrowserInputRuntime.chromiumVersion
  )
    throw new Error("WINDOWS_INPUT_QA_RUNTIME")
  if ((await fs.realpath(directory!)) !== directory || (await fs.realpath(filename!)) !== filename)
    throw new Error("WINDOWS_INPUT_QA_PATH")
  const body = await fs.readFile(filename!)
  if (body.length < 512 || body.length > 1_048_576 || createHash("sha256").update(body).digest("hex") !== expected)
    throw new Error("WINDOWS_INPUT_QA_MODULE_CHANGED")
  const binding = createRequire(import.meta.url)(filename!) as Binding
  if (
    Object.keys(binding).sort().join(",") !== "accounting,observe,version" ||
    binding.version !== 1 ||
    typeof binding.accounting !== "function" ||
    typeof binding.observe !== "function"
  )
    throw new Error("WINDOWS_INPUT_QA_EXPORTS")
  state.binding = binding
  result.before = binding.accounting()
  await app.whenReady()
  const window = new BrowserWindow({
    show: true,
    width: 800,
    height: 600,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "windows-input-w0-private",
    },
  })
  state.window = window
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    result.permissions++
    callback(false)
  })
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (!details.url.startsWith("data:")) result.network++
    callback({ cancel: !details.url.startsWith("data:") })
  })
  const page = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
    <style>input{position:absolute;left:20px;top:20px;width:220px;height:40px}button{position:absolute;left:20px;top:100px;width:220px;height:50px}#scroll{position:absolute;left:20px;top:200px;width:220px;height:150px;overflow:auto}</style>
    <input id="field"><button id="button">Owned QA</button><div id="scroll"><div style="height:2000px">Owned scroll</div></div>
    <script>window.counts={input:0,keyDown:0,keyUp:0,click:0,wheel:0,mouseMove:0,mouseDown:0,mouseUp:0,compositionStart:0,compositionUpdate:0,compositionEnd:0};window.composing=false;field.oninput=()=>counts.input++;field.onkeydown=()=>counts.keyDown++;field.onkeyup=()=>counts.keyUp++;field.oncompositionstart=()=>{counts.compositionStart++;window.composing=true};field.oncompositionupdate=()=>counts.compositionUpdate++;field.oncompositionend=()=>{counts.compositionEnd++;window.composing=false};button.onmousemove=()=>counts.mouseMove++;button.onmousedown=()=>counts.mouseDown++;button.onmouseup=()=>counts.mouseUp++;button.onclick=()=>counts.click++;document.getElementById('scroll').onwheel=()=>counts.wheel++;field.focus()</script>`
  await window.webContents.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(page))
  window.webContents.debugger.attach("1.3")
  await window.webContents.debugger.sendCommand("Page.enable")
  await window.webContents.executeJavaScript("field.focus(); field.value")
  const lease = binding.observe(window.getNativeWindowHandle(), () => {
    state.callbacks++
  })
  state.lease = lease
  result.observed = binding.accounting()
  if (!Object.isFrozen(lease) || !lease.healthy()) throw new Error("WINDOWS_INPUT_QA_LEASE")
  const packets: { id: string; method: string; params: Record<string, unknown>; effect(page: Page): boolean }[] = [
    {
      id: "key-down",
      method: "Input.dispatchKeyEvent",
      params: { type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 },
      effect: (page) => page.value === "a" && page.counts.input >= 1 && page.counts.keyDown === 1,
    },
    {
      id: "key-up",
      method: "Input.dispatchKeyEvent",
      params: { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 },
      effect: (page) => page.value === "a" && page.counts.keyUp === 1,
    },
    {
      id: "insert-text",
      method: "Input.insertText",
      params: { text: "DAC Windows QA" },
      effect: (page) => page.value === "aDAC Windows QA" && page.counts.input >= 2,
    },
    {
      id: "composition-start",
      method: "Input.imeSetComposition",
      params: { text: "owned", selectionStart: 5, selectionEnd: 5 },
      effect: (page) =>
        page.value === "aDAC Windows QAowned" &&
        page.composing &&
        page.counts.compositionStart === 1 &&
        page.counts.compositionUpdate >= 1,
    },
    {
      id: "composition-cancel",
      method: "Input.imeSetComposition",
      params: { text: "", selectionStart: 0, selectionEnd: 0 },
      effect: (page) => page.value === "aDAC Windows QA" && !page.composing && page.counts.compositionEnd === 1,
    },
    {
      id: "mouse-move",
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 80, y: 120, button: "none" },
      effect: (page) => page.counts.mouseMove >= 1 && page.counts.click === 0,
    },
    {
      id: "mouse-down",
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 80, y: 120, button: "left", buttons: 1, clickCount: 1 },
      effect: (page) => page.counts.mouseDown === 1 && page.counts.click === 0,
    },
    {
      id: "mouse-up",
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x: 80, y: 120, button: "left", buttons: 0, clickCount: 1 },
      effect: (page) => page.counts.mouseUp === 1 && page.counts.click === 1,
    },
    {
      id: "wheel",
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseWheel", x: 80, y: 250, deltaX: 0, deltaY: 120 },
      effect: (page) => page.counts.wheel >= 1 && page.scrollTop > 0 && page.value === "aDAC Windows QA",
    },
  ]
  for (const packet of packets) {
    const before = state.callbacks
    await window.webContents.debugger.sendCommand(packet.method, packet.params)
    // Diagnostic only: this does not suppress a callback or extend authority.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const page = (await window.webContents.executeJavaScript(
      "({value:field.value,counts:window.counts,composing:window.composing,scrollTop:document.getElementById('scroll').scrollTop})",
    )) as Page
    const current = {
      id: packet.id,
      method: packet.method,
      callbacks: state.callbacks - before,
      healthy: lease.healthy(),
      effect: packet.effect(page),
      page,
    }
    result.cases.push(current)
    if (current.callbacks || !current.healthy) throw new Error("WINDOWS_INPUT_QA_CDP_NOT_SEPARATED")
    if (!current.effect) throw new Error(`WINDOWS_INPUT_QA_EFFECT:${packet.id}`)
  }
  result.page = result.cases.at(-1)?.page
  result.pageOracleVerified = result.cases.length === packets.length && result.cases.every((entry) => entry.effect)
  lease.release()
  lease.release()
  if (lease.healthy()) throw new Error("WINDOWS_INPUT_QA_RELEASE")
  result.after = binding.accounting()
  if (
    result.after.leases !== 0 ||
    result.after.hooksOwned !== 0 ||
    result.after.registrationsOwned !== 0 ||
    result.after.cleanupFailures !== 0 ||
    result.after.retainedSinkRefs !== 0
  )
    throw new Error("WINDOWS_INPUT_QA_CLEANUP")
  result.state = "compiled-module-current-cdp-and-release-pass-native-ime-and-installed-trust-pending"
}

async function finish(error?: unknown) {
  if (error) {
    result.state = "failed"
    result.error =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: "unknown", message: "WINDOWS_INPUT_QA_FAILED" }
  }
  // A refused native cleanup must not prevent destruction of this fixture's
  // window or preservation of its failure evidence.
  const cleanup = (name: string, action: () => void) => {
    try {
      action()
    } catch {
      result.cleanupErrors.push(name)
    }
  }
  try {
    cleanup("lease", () => state.lease?.release())
    cleanup("accounting", () => {
      if (state.binding) result.after = state.binding.accounting()
    })
    cleanup("debugger", () => {
      if (state.window && !state.window.isDestroyed() && state.window.webContents.debugger.isAttached())
        state.window.webContents.debugger.detach()
    })
    cleanup("window", () => {
      if (state.window && !state.window.isDestroyed()) state.window.destroy()
    })
    result.destroyed = !state.window || state.window.isDestroyed()
    result.callbacks = state.callbacks
    if (result.cleanupErrors.length || !result.destroyed) result.state = "cleanup-unconfirmed"
    await fs.writeFile(path.join(directory!, "result.json"), JSON.stringify(result, null, 2), {
      mode: 0o600,
      flag: "wx",
    })
  } finally {
    app.exit(error || result.cleanupErrors.length || !result.destroyed ? 1 : 0)
  }
}

main().then(
  () => finish(),
  (error: unknown) => finish(error),
)
