/** @jsxImportSource @opentui/solid */
export * as IMMediaBatchReceiver from "./im-media-batch-receiver"

import { TextareaRenderable, TextAttributes, TextRenderable, type Renderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { IMMediaReceiverTuple } from "../../../app/test/fixture/im-media-receiver-tuple"
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

export function links(node: Renderable): string[] {
  return [...(node instanceof TextRenderable ? [...node.chunks, ...node.textNode.gatherWithInheritedStyle()]
    .flatMap((chunk) => chunk.link ? [chunk.link.url] : []) : []),
    ...node.getChildren().flatMap(links)]
}

export async function selectMenu(app: Awaited<ReturnType<typeof testRender>>, text: string, deadline: number) {
  // DialogSelect renders before its deferred input focus. Observe that focus
  // instead of treating a painted search placeholder as keyboard ownership.
  while (Date.now() < deadline) {
    await app.renderOnce()
    const editor = app.renderer.currentFocusedEditor
    if (!(editor instanceof TextareaRenderable) || editor.isDestroyed || !editor.focused) {
      await Bun.sleep(15)
      continue
    }
    editor.clear()
    await app.mockInput.typeText(text)
    function containsOption(node: Renderable): boolean {
      return (node instanceof TextRenderable && (node.attributes & TextAttributes.BOLD) !== 0 &&
        [text, `@ ${text}`].includes(node.plainText.trim())) ||
        node.getChildren().some(containsOption)
    }
    // Filter before observing a title that may initially be below the viewport.
    // The search editor is excluded from the actual-option oracle.
    while (Date.now() < deadline) {
      await app.renderOnce()
      if (containsOption(app.renderer.root)) {
        app.mockInput.pressEnter()
        // Mock keyboard events are dispatched on the event loop. Yield before
        // the next selection can capture this retiring menu's editor.
        await Bun.sleep(15)
        await app.renderOnce()
        return
      }
      await Bun.sleep(15)
    }
    throw new Error("Original filtered menu option did not become visible")
  }
  throw new Error("Original menu did not acquire keyboard focus")
}

export async function preflight(descriptorFile: string, tupleFile: string, live = false) {
  const descriptor = IMMediaProductDescriptor.decode(await Bun.file(descriptorFile).json())
  const tuple = IMMediaReceiverTuple.decode(await Bun.file(tupleFile).json(), descriptor)
  if (live) {
    IMMediaProductDescriptor.requireCurrent(descriptor)
    if (Date.now() >= tuple.deadlineAt) throw new Error("The original receiver tuple window has ended")
  }
  const authorization = await IMMediaProductDescriptor.authorization(descriptor.peers.B.authorizationFile)
  return { descriptor, tuple, authorization }
}

export async function run(descriptorFile: string, observationDirectory: string, tupleFile: string, finishMedia = false, finishSave = false) {
  const input = await preflight(descriptorFile, tupleFile, true)
  const descriptor = input.descriptor
  const tuple = input.tuple
  const peer = descriptor.peers.B
  const authorization = input.authorization
  const privateState = path.join(observationDirectory, "tui-state")
  await fs.mkdir(privateState, { mode: 0o700 })
  await fs.writeFile(path.join(privateState, "kv.json"), JSON.stringify({ tui_locale: "en", animations_enabled: false }), { mode: 0o600 })
  const state = { stage: "original_dialog", filesObserved: 0, previewCreated: false, previewBytes: 0,
    checksumMatched: false, previewClosed: false, executionRequests: 0, uploads: 0, sends: 0,
    savedBytes: 0, savedChecksumMatched: false, saveElapsedMillis: 0, firstFrameCaptured: false, messageTupleObserved: false,
    metadataPages: 0, observedReaderState: "", observedHTTPStatus: 0, errorCode: "", sourceChanged: false,
    targetMessageMatched: false, metadataMatched: 0, downloadedTupleMatched: false,
    metadataHeaderMaxMillis: 0, metadataBodyMaxMillis: 0, metadataTimingCount: 0,
    proofWindowMillis: 0, metadataHeadersOutsideProof: 0, metadataBodiesOutsideProof: 0,
    metadataRemainingExpiryMinMillis: null as number | null,
    contentResponses: 0, contentHTTPStatus: 0, contentHeaderMaxMillis: 0, contentTransportFailures: 0,
    saveWorkingObserved: false, saveFormObserved: false, saveFailure: "" }
  const pendingObservations = new Set<Promise<void>>()
  const transport: typeof fetch = Object.assign((resource: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(resource instanceof Request ? resource.url : String(resource))
    const method = init?.method ?? (resource instanceof Request ? resource.method : "GET")
    if (method === "POST") {
      if (/\/(?:prompt|resume|execute)$/.test(url.pathname)) state.executionRequests++
      if (url.pathname.endsWith("/attachments")) state.uploads++
      if (url.pathname.endsWith("/messages")) state.sends++
    }
    const prefix = "/api/v1/im/groups/" + encodeURIComponent(tuple.receiver.groupID) + "/messages"
    if (url.origin === tuple.receiver.origin && method === "GET" && url.pathname === prefix) {
      const started = performance.now()
      const response = fetch(resource, init)
      const observation = response.then(async (value) => {
        const headerMillis = performance.now() - started
        state.observedHTTPStatus = value.status
        const body: unknown = await value.clone().json()
        const bodyMillis = performance.now() - started
        state.metadataTimingCount++
        state.metadataHeaderMaxMillis = Math.max(state.metadataHeaderMaxMillis, Math.ceil(headerMillis))
        state.metadataBodyMaxMillis = Math.max(state.metadataBodyMaxMillis, Math.ceil(bodyMillis))
        if (body && typeof body === "object" && "reader" in body && body.reader && typeof body.reader === "object") {
          const reader = body.reader
          if ("proofWindowMs" in reader && typeof reader.proofWindowMs === "number" && Number.isFinite(reader.proofWindowMs)) {
            state.proofWindowMillis = reader.proofWindowMs
            if (headerMillis >= reader.proofWindowMs) state.metadataHeadersOutsideProof++
            if (bodyMillis >= reader.proofWindowMs) state.metadataBodiesOutsideProof++
          }
          if ("validatedServerNow" in reader && typeof reader.validatedServerNow === "number" &&
              "nextExpiryAt" in reader && typeof reader.nextExpiryAt === "number" &&
              Number.isSafeInteger(reader.validatedServerNow) && Number.isSafeInteger(reader.nextExpiryAt)) {
            const remaining = reader.nextExpiryAt - reader.validatedServerNow
            state.metadataRemainingExpiryMinMillis = Math.min(state.metadataRemainingExpiryMinMillis ?? remaining, remaining)
          }
        }
        if (!value.ok) {
          if (body && typeof body === "object" && "data" in body && body.data && typeof body.data === "object" &&
              "code" in body.data && typeof body.data.code === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(body.data.code))
            state.errorCode = body.data.code
          return
        }
        state.metadataPages++
        try {
          const message = IMMediaReceiverTuple.observe(body, tuple, descriptor.state.B.reader.displayEpoch)
          state.observedReaderState = "current"
          if (message) { state.messageTupleObserved = true; state.targetMessageMatched = true; state.metadataMatched = 4 }
        } catch (error) {
          const code = error instanceof IMMediaReceiverTuple.ObservationError ? error.code : "observer_failed"
          state.errorCode = "im_media_observer_" + code
          state.observedReaderState = code === "reader_unavailable" ? "unavailable" : "observer_contract_mismatch"
          state.sourceChanged = code === "reader_unavailable" || code === "message_identity"
        }
      }).catch(() => { state.errorCode = "observation_failed" }).finally(() => { pendingObservations.delete(observation) })
      pendingObservations.add(observation)
      return response
    }
    if (url.origin === tuple.receiver.origin && method === "GET" && url.pathname.startsWith(prefix + "/")) {
      const match = /\/messages\/([^/]+)\/attachments\/([^/]+)(?:\/content)?$/.exec(url.pathname)
      if (match) {
        const valid = decodeURIComponent(match[1]!) === tuple.receiver.messageID &&
          tuple.receiver.attachments.some((attachment) => attachment.attachmentID === decodeURIComponent(match[2]!))
        if (!valid) state.sourceChanged = true
        if (valid && url.pathname.endsWith("/content")) {
          state.downloadedTupleMatched = true
          const started = performance.now()
          // Observe only the original response headers. Never clone or consume
          // the large body, replace its stream or issue a second content GET.
          return fetch(resource, init).then((response) => {
            state.contentResponses++
            state.contentHTTPStatus = response.status
            state.contentHeaderMaxMillis = Math.max(state.contentHeaderMaxMillis, Math.ceil(performance.now() - started))
            return response
          }, (error: unknown) => {
            state.contentTransportFailures++
            throw error
          })
        }
      }
    }
    return fetch(resource, init)
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
      const captured = app.captureCharFrame()
      if (captured.includes(text)) return captured
      if (state.stage === "save_original_large_file" && text === "File saved and verified") {
        const form = captured.includes("Save to a new path")
        state.saveFormObserved ||= form
        state.saveWorkingObserved ||= form && captured.includes("Working")
        if (form && (captured.includes("IM operation failed") || captured.includes("Save verification failed."))) {
          state.saveFailure = captured.includes("Save verification failed.") ? "publication_unknown" : "original_form_failed"
          throw new Error("Original save form reported a failure")
        }
        if (captured.includes("Remote conversation is currently unavailable.")) {
          state.saveFailure = "original_parent_unavailable"
          throw new Error("Original protected parent became unavailable during save")
        }
      }
      await Bun.sleep(15)
    }
    throw new Error("Original TUI media stage did not become visible")
  }
  async function select(text: string) {
    await frame("Search")
    await selectMenu(app, text, Math.min(actualDeadline, Date.now() + 10_000))
  }
  try {
    await app.renderOnce()
    await fs.writeFile(path.join(observationDirectory, "tui-first-frame.txt"), app.captureCharFrame(), { mode: 0o600, flag: "wx" })
    state.firstFrameCaptured = true
    await select(descriptor.groups.B.name)
    state.stage = "actual_message_tuple"
    const until = Math.min(actualDeadline, Date.now() + 10_000)
    while (!state.messageTupleObserved && Date.now() < until) {
      await app.renderOnce()
      if (state.sourceChanged || state.errorCode) throw new Error("Original receiver metadata is unavailable; inspect the first frame")
      await Bun.sleep(15)
    }
    if (!state.messageTupleObserved) throw new Error("Exact original receiver message tuple was not observed")
    await fs.writeFile(path.join(observationDirectory, "tui-received-batch.txt"), app.captureCharFrame(), { mode: 0o600, flag: "wx" })
    app.mockInput.pressKey("u", { ctrl: true })
    await frame("Attachment details")
    for (const file of finishMedia ? [] : descriptor.files) {
      await select(`Attachment details · ${file.filename}`)
      await frame(`${file.bytes} B`)
      state.filesObserved++
    }
    const image = descriptor.files.find((file) => ["image/png", "image/jpeg"].includes(file.mime) && file.bytes <= 8 * 1024 * 1024)
    if (!image) throw new Error("Original fixture has no supported image preview input")
    if (!finishSave) {
      state.stage = "preview_original_image"
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
    }
    state.stage = "save_original_large_file"
    const large = descriptor.files[0]!
    await select(`Attachment details · ${large.filename}`)
    await frame(`${large.bytes} B`)
    await select("Save file")
    await frame("Save to a new path (never replaces an existing file)")
    const editor = app.renderer.currentFocusedEditor
    if (!(editor instanceof TextareaRenderable)) throw new Error("Original download form does not own focus")
    const destination = path.join(privateState, "received-large.bin")
    await app.mockInput.typeText(destination)
    const saveStarted = performance.now()
    app.mockInput.pressEnter()
    try { await frame("File saved and verified", actualDeadline - Date.now()) }
    finally { state.saveElapsedMillis = Math.round(performance.now() - saveStarted) }
    const saved = await fs.open(destination, "r")
    const digest = createHash("sha256")
    try {
      state.savedBytes = (await saved.stat()).size
      for await (const bytes of saved.createReadStream({ autoClose: false })) digest.update(bytes)
    } finally { await saved.close() }
    state.savedChecksumMatched = digest.digest("hex") === large.sha256
    if (!state.savedChecksumMatched || state.savedBytes !== large.bytes || !state.downloadedTupleMatched)
      throw new Error("Original saved large-file bytes or actual source tuple changed")
    if (state.executionRequests || state.uploads || state.sends) throw new Error("Receiver UI unexpectedly created work or sent media")
    await fs.writeFile(path.join(observationDirectory, "tui-preview.txt"), app.captureCharFrame(), { mode: 0o600, flag: "wx" })
    state.stage = "complete"
  } catch (error) {
    await app.renderOnce().catch(() => undefined)
    await fs.writeFile(path.join(observationDirectory, "tui-failure-frame.txt"), app.captureCharFrame(), { mode: 0o600, flag: "wx" })
    await fs.writeFile(path.join(observationDirectory, "tui-driver-error-private.log"),
      error instanceof Error ? error.stack ?? error.message : String(error), { mode: 0o600, flag: "wx" })
    throw error
  } finally {
    if (!app.renderer.isDestroyed) app.renderer.destroy()
    await Promise.race([Promise.allSettled(pendingObservations), Bun.sleep(5000)])
    if (preview.url) state.previewClosed = await fetch(preview.url, { signal: AbortSignal.timeout(500) })
      .then((response) => !response.ok).catch(() => true)
    await fs.writeFile(path.join(observationDirectory, "tui-safe-observation.json"), JSON.stringify({
      version: 1, ...state, finishMediaOnly: finishMedia, finishSaveOnly: finishSave, width: 80, height: 24, actualRenderer: true, actualHTTP: true,
      originalDirectoryUsed: true, privateStateSeparated: true, ownRendererClosed: app.renderer.isDestroyed,
      pendingMetadataObservations: pendingObservations.size,
      actualTaskFacts: "unavailable",
    }, null, 2), { mode: 0o600, flag: "wx" })
  }
}

if (import.meta.main) {
  const descriptor = process.argv[2]
  const observationDirectory = process.argv[3]
  const tupleFile = process.argv[4]
  if (!descriptor || !observationDirectory || !tupleFile) throw new Error("Original descriptor, private observations, and actual receiver tuple required")
  if (process.argv[5] === "--dry") {
    const input = IMMediaProductDescriptor.decode(await Bun.file(descriptor).json())
    await IMMediaProductDescriptor.authorization(input.peers.B.authorizationFile)
    const tuple = IMMediaReceiverTuple.decode(await Bun.file(tupleFile).json(), input)
    console.log(JSON.stringify({ dry: true, fields: Object.keys(input.peers.B), files: input.files.length,
      rendererStarted: false, actualHTTP: false, task: input.task.state, originalAttachments: tuple.receiver.attachments.length }))
  }
  if (process.argv[5] !== "--dry") await run(descriptor, observationDirectory, tupleFile,
    ["--finish-media", "--finish-save"].includes(process.argv[5] ?? ""), process.argv[5] === "--finish-save").catch(() => {
    console.error("IM_TUI_PRODUCT_STAGE_FAILED; inspect the private safe observation")
    process.exitCode = 1
  })
}
