/** @jsxImportSource @opentui/solid */
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup, onMount } from "solid-js"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { TestTuiContexts } from "./tui-environment"
import { createTuiResolvedConfig } from "./tui-runtime"
import { SDKProvider } from "../../src/context/sdk"
import { ProjectProvider } from "../../src/context/project"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TuiI18nProvider, useTuiI18n } from "../../src/context/i18n"
import { TuiConfigProvider } from "../../src/config"
import { ClipboardProvider } from "../../src/context/clipboard"
import { ToastProvider } from "../../src/ui/toast"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { DialogBrowserControl } from "../../src/component/dialog-browser-control"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"

const Descriptor = Schema.Struct({ version: Schema.Literal(1), url: Schema.String,
  directory: Schema.String, sessionID: Schema.String, authorizationFile: Schema.String,
  output: Schema.String, deadlineAt: Schema.Int })

export async function run(file: string, dry = false) {
  const input = Schema.decodeUnknownSync(Descriptor)(await Bun.file(file).json())
  const authorization = await fs.readFile(input.authorizationFile, "utf8")
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(input.url) || !/^Basic [A-Za-z0-9+/]+=*$/.test(authorization) ||
      !input.directory.startsWith("/") || !input.output.startsWith("/")) throw new Error("Private original Root descriptor required")
  if (dry) { console.log(JSON.stringify({ dry: true, renderer: false, HTTP: false })); return }
  const deadline = Math.min(input.deadlineAt, Date.now() + 60_000)
  if (deadline <= Date.now()) throw new Error("Product descriptor expired")
  const stateDirectory = path.join(input.output, "tui-state")
  await fs.mkdir(stateDirectory, { mode: 0o700 })
  await fs.writeFile(path.join(stateDirectory, "kv.json"), JSON.stringify({ tui_locale: "en", animations_enabled: false }), { mode: 0o600 })
  const state = { phase: "original_dialog", requests: 0, responses: 0, exactRetry: false,
    unavailableVisible: false, useOffered: false, handoffs: 0, executionRequests: 0, closed: false }
  const requests: string[] = []
  const responses: { status: number; code: string }[] = []
  const transport: typeof fetch = Object.assign(async (value: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(value, init)
    const pathname = new URL(request.url).pathname
    if (request.method === "POST" && /\/(?:prompt|resume|execute)$/.test(pathname)) state.executionRequests++
    const observed = request.method === "POST" && pathname === "/api/v1/browser/controls"
    if (observed) { requests.push(await request.clone().text()); state.requests++ }
    const response = await fetch(request)
    if (observed) {
      const value: unknown = await response.clone().json()
      const code = value && typeof value === "object" && "code" in value && typeof value.code === "string" ? value.code : ""
      responses.push({ status: response.status, code }); state.responses++
    }
    return response
  }, { preconnect: fetch.preconnect })
  function Open() {
    const dialog = useDialog()
    useTuiI18n().setLocale("en")
    onMount(() => dialog.replace(() => <ProjectProvider>
      <DialogBrowserControl sessionID={input.sessionID} onUse={() => state.handoffs++} />
    </ProjectProvider>))
    return <box />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return <TestTuiContexts directory={input.directory} paths={{ home: stateDirectory, state: stateDirectory, worktree: input.directory }}>
      <OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}><KVProvider><ThemeProvider mode="dark"><ToastProvider>
        <SDKProvider url={input.url} directory={input.directory} headers={{ Authorization: authorization }} fetch={transport}>
          <TuiI18nProvider><ClipboardProvider value={{}}><DialogProvider><Open /></DialogProvider></ClipboardProvider></TuiI18nProvider>
        </SDKProvider>
      </ToastProvider></ThemeProvider></KVProvider></TuiConfigProvider></OpencodeKeymapProvider>
    </TestTuiContexts>
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 40, kittyKeyboard: true })
  async function frame(text: string) {
    const until = Math.min(deadline, Date.now() + 8000)
    while (Date.now() < until) {
      await app.renderOnce()
      if (app.captureCharFrame().replace(/\s+/g, " ").includes(text)) return
      await Bun.sleep(20)
    }
    throw new Error("Original TUI browser stage did not become visible")
  }
  try {
    await frame("Approve and connect")
    app.mockInput.pressEnter()
    await frame("First line")
    app.mockInput.pressEnter()
    await frame("Not currently available; check the current state")
    state.unavailableVisible = true
    state.useOffered = app.captureCharFrame().includes("Add browser reference to draft")
    app.mockInput.pressEnter()
    const responseDeadline = Math.min(deadline, Date.now() + 8000)
    while (responses.length < 2 && Date.now() < responseDeadline) { await app.renderOnce(); await Bun.sleep(20) }
    state.exactRetry = requests.length === 2 && requests[0] === requests[1]
    if (!state.exactRetry || responses.length !== 2 || responses.some((item) => item.status !== 503 || item.code !== "BROWSER_HOST_UNAVAILABLE") || state.handoffs || state.executionRequests)
      throw new Error("Original TUI unavailable/retry boundary failed")
    await fs.writeFile(path.join(input.output, "tui-unavailable.txt"), app.captureCharFrame(), { mode: 0o600 })
    app.mockInput.pressKey("escape")
    await app.renderOnce()
    app.mockInput.pressKey("escape")
    await app.renderOnce()
    state.closed = !app.captureCharFrame().includes("Connect an agent browser")
    if (!state.closed || state.handoffs || state.executionRequests) throw new Error("Original TUI close/handoff boundary failed")
    state.phase = "complete"
  } finally {
    if (!app.renderer.isDestroyed) app.renderer.destroy()
    await fs.writeFile(path.join(input.output, "tui-safe-observation.json"), JSON.stringify({ version: 1, ...state,
      responses, requestHash: requests[0] ? createHash("sha256").update("dac.browser.approval.v1\0").update(requests[0]).digest("hex") : "",
      actualRenderer: true, actualHTTP: true, width: 100, height: 40, rendererClosed: app.renderer.isDestroyed,
      limits: ["Original component, not full CLI/PTY", "No NativeFactory or provider", "Actual credential omitted"] }, null, 2), { mode: 0o600 })
  }
}

if (import.meta.main) await run(process.argv[2], process.argv[3] === "--dry").catch(() => {
  console.error("BROWSER_TUI_PRODUCT_BOUNDARY_FAILED; inspect private observation"); process.exitCode = 1
})
