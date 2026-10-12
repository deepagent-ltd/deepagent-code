/** @jsxImportSource @opentui/solid */
export * as IMMediaProductTUI from "./im-media-product"

import { TextareaRenderable, TextRenderable, type Renderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { IMMediaProductDescriptor } from "../../../app/test/fixture/im-media-product-descriptor"
import { TestTuiContexts } from "./tui-environment"
import { createTuiResolvedConfig } from "./tui-runtime"
import { SDKProvider } from "../../src/context/sdk"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TuiI18nProvider, useTuiI18n } from "../../src/context/i18n"
import { TuiConfigProvider } from "../../src/config"
import { ClipboardProvider } from "../../src/context/clipboard"
import { ToastProvider } from "../../src/ui/toast"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { DialogIM } from "../../src/component/dialog-im"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"

function links(node: Renderable): string[] {
  return [...(node instanceof TextRenderable ? node.chunks.flatMap((chunk) => chunk.link ? [chunk.link.url] : []) : []),
    ...node.getChildren().flatMap(links)]
}

export async function run(descriptorFile: string, observationDirectory: string, caption: string) {
  const descriptor = IMMediaProductDescriptor.requireCurrent(IMMediaProductDescriptor.decode(await Bun.file(descriptorFile).json()))
  const peer = descriptor.peers.B
  const authorization = await IMMediaProductDescriptor.authorization(peer.authorizationFile)
  const privateState = path.join(observationDirectory, "tui-state")
  await fs.mkdir(privateState, { mode: 0o700 })
  await fs.writeFile(path.join(privateState, "kv.json"), JSON.stringify({ tui_locale: "en", animations_enabled: false }), { mode: 0o600 })
  const state = { stage: "original_dialog", filesObserved: 0, previewCreated: false, previewBytes: 0,
    checksumMatched: false, previewClosed: false, executionRequests: 0, uploads: 0, sends: 0,
    savedBytes: 0, savedChecksumMatched: false }
  const transport: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const pathname = new URL(request.url).pathname
    if (request.method === "POST") {
      if (/\/(?:prompt|resume|execute)$/.test(pathname)) state.executionRequests++
      if (pathname.endsWith("/attachments")) state.uploads++
      if (pathname.endsWith("/messages")) state.sends++
    }
    return fetch(request)
  }, { preconnect: fetch.preconnect })
  function Open() {
    const dialog = useDialog()
    useTuiI18n().setLocale("en")
    onMount(() => dialog.replace(() => <DialogIM />))
    return <box />
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({})
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return <TestTuiContexts directory={peer.directory} paths={{ home: privateState, state: privateState, worktree: peer.directory }}>
      <OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}><KVProvider><ThemeProvider mode="dark"><ToastProvider>
        <SDKProvider url={peer.url} directory={peer.directory} headers={{ Authorization: authorization }} fetch={transport}>
          <TuiI18nProvider><ClipboardProvider value={{}}><DialogProvider><Open /></DialogProvider></ClipboardProvider></TuiI18nProvider>
        </SDKProvider>
      </ToastProvider></ThemeProvider></KVProvider></TuiConfigProvider></OpencodeKeymapProvider>
    </TestTuiContexts>
  }
  const app = await testRender(() => <Harness />, { width: 80, height: 24, kittyKeyboard: true })
  const preview = { url: "" }
  const actualDeadline = Math.min(descriptor.deadlineAt, Date.now() + 75_000)
  async function frame(text: string, timeout = 10_000) {
    const deadline = Math.min(actualDeadline, Date.now() + timeout)
    while (Date.now() < deadline) {
      await app.renderOnce()
      if (app.captureCharFrame().includes(text)) return app.captureCharFrame()
      await Bun.sleep(15)
    }
    throw new Error("Original TUI media stage did not become visible")
  }
  async function select(text: string) {
    await frame(text)
    const editor = app.renderer.currentFocusedEditor
    if (!(editor instanceof TextareaRenderable)) throw new Error("Original menu does not own keyboard focus")
    // Only the menu search filter is reset. This does not prove composer clearing.
    editor.clear()
    await app.mockInput.typeText(text)
    await app.renderOnce()
    app.mockInput.pressEnter()
    await Bun.sleep(25)
  }
  try {
    await select(descriptor.groups.B.name)
    await frame(caption)
    await fs.writeFile(path.join(observationDirectory, "tui-received-batch.txt"), app.captureCharFrame(), { mode: 0o600, flag: "wx" })
    app.mockInput.pressKey("u", { ctrl: true })
    await frame("Attachment details")
    for (const file of descriptor.files) {
      await select(`Attachment details · ${file.filename}`)
      await frame(`${file.bytes} B`)
      state.filesObserved++
    }
    const image = descriptor.files.find((file) => ["image/png", "image/jpeg"].includes(file.mime) && file.bytes <= 8 * 1024 * 1024)
    if (!image) throw new Error("Original fixture has no supported image preview input")
    await select(`Attachment details · ${image.filename}`)
    await select("Create temporary image link")
    await frame("Open image link")
    preview.url = links(app.renderer.root).find((url) => /^http:\/\/127\.0\.0\.1:[0-9]+\/view\//.test(url)) ?? ""
    if (!preview.url) throw new Error("Original preview link is absent")
    state.previewCreated = true
    const document = await fetch(preview.url, { signal: AbortSignal.timeout(Math.max(1, actualDeadline - Date.now())) })
      .then((response) => response.text())
    const imagePath = /<img src="(\/image\/[a-zA-Z0-9_-]+)"/.exec(document)?.[1]
    if (!imagePath) throw new Error("Original preview HTML is unavailable")
    const response = await fetch(new URL(imagePath, preview.url), {
      signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, actualDeadline - Date.now()))),
    })
    if (!response.ok) throw new Error("Original authenticated image preview is unavailable")
    const bytes = new Uint8Array(await response.arrayBuffer())
    state.previewBytes = bytes.length
    state.checksumMatched = createHash("sha256").update(bytes).digest("hex") === image.sha256
    if (!state.checksumMatched || bytes.length !== image.bytes) throw new Error("Original preview bytes changed")
    state.stage = "save_original_image"
    await select("Save file")
    await frame("Save to a new path (never replaces an existing file)")
    const editor = app.renderer.currentFocusedEditor
    if (!(editor instanceof TextareaRenderable)) throw new Error("Original download form does not own focus")
    const destination = path.join(privateState, "received-image.png")
    await app.mockInput.typeText(destination)
    app.mockInput.pressEnter()
    await frame("File saved and verified")
    const saved = await fs.readFile(destination)
    state.savedBytes = saved.length
    state.savedChecksumMatched = createHash("sha256").update(saved).digest("hex") === image.sha256
    if (!state.savedChecksumMatched || saved.length !== image.bytes) throw new Error("Original saved image bytes changed")
    if (state.executionRequests || state.uploads || state.sends) throw new Error("Receiver UI unexpectedly created work or sent media")
    await fs.writeFile(path.join(observationDirectory, "tui-preview.txt"), app.captureCharFrame(), { mode: 0o600, flag: "wx" })
    state.stage = "complete"
  } finally {
    if (!app.renderer.isDestroyed) app.renderer.destroy()
    if (preview.url) state.previewClosed = await fetch(preview.url, { signal: AbortSignal.timeout(500) })
      .then((response) => !response.ok).catch(() => true)
    await fs.writeFile(path.join(observationDirectory, "tui-safe-observation.json"), JSON.stringify({
      version: 1, ...state, width: 80, height: 24, actualRenderer: true, actualHTTP: true,
      originalDirectoryUsed: true, privateStateSeparated: true, ownRendererClosed: app.renderer.isDestroyed,
      actualTaskFacts: "unavailable",
    }, null, 2), { mode: 0o600, flag: "wx" })
  }
}

if (import.meta.main) {
  const descriptor = process.argv[2]
  const observationDirectory = process.argv[3]
  const caption = process.argv[4]
  if (!descriptor || !observationDirectory || !caption) throw new Error("Original descriptor, private observations, and caption required")
  if (process.argv[5] === "--dry") {
    const input = IMMediaProductDescriptor.decode(await Bun.file(descriptor).json())
    await IMMediaProductDescriptor.authorization(input.peers.B.authorizationFile)
    console.log(JSON.stringify({ dry: true, fields: Object.keys(input.peers.B), files: input.files.length,
      rendererStarted: false, actualHTTP: false, task: input.task.state }))
  }
  if (process.argv[5] !== "--dry") await run(descriptor, observationDirectory, caption).catch(() => {
    console.error("IM_TUI_PRODUCT_STAGE_FAILED; inspect the private safe observation")
    process.exitCode = 1
  })
}
