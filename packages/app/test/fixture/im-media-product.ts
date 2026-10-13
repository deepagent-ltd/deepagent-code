export * as IMMediaProduct from "./im-media-product"

import { chromium } from "@playwright/test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { IMMediaProductDescriptor } from "./im-media-product-descriptor"

export const UI = Schema.Struct({
  version: Schema.Literal(1),
  port: Schema.Int.check(Schema.isGreaterThan(1024), Schema.isLessThanOrEqualTo(65535)),
  observationDirectory: Schema.String.check(Schema.makeFilter((value: string) => value.startsWith("/"))),
  caption: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
})
export type UI = typeof UI.Type

export async function preflight(descriptorFile: string, uiFile: string, live = false) {
  const descriptor = IMMediaProductDescriptor.decode(await Bun.file(descriptorFile).json())
  const ui = Schema.decodeUnknownSync(UI)(await Bun.file(uiFile).json())
  const credentials = await IMMediaProductDescriptor.authorization(descriptor.peers.A.authorizationFile)
  await IMMediaProductDescriptor.authorization(descriptor.peers.B.authorizationFile)
  if (live) IMMediaProductDescriptor.requireCurrent(descriptor)
  for (const input of descriptor.files) {
    const file = await fs.open(input.path, "r")
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size !== input.bytes) throw new Error("Fixture media size changed")
      const hash = createHash("sha256")
      for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes)
      if (hash.digest("hex") !== input.sha256) throw new Error("Fixture media bytes changed")
    } finally {
      await file.close()
    }
  }
  const peer = new URL(descriptor.peers.A.url)
  if (peer.pathname !== "/") throw new Error("This product driver requires the original Root endpoint")
  return { descriptor, ui, credentials }
}

/** Launch only the original App Vite entry. Backend/Go/fault resources remain
 * owned by the shared fixture; no route interception or substitute client. */
export async function run(descriptorFile: string, uiFile: string) {
  const input = await preflight(descriptorFile, uiFile, true)
  await fs.mkdir(input.ui.observationDirectory, { mode: 0o700, recursive: true })
  const home = path.join(input.ui.observationDirectory, "app-home")
  await fs.mkdir(home, { mode: 0o700 })
  const log = await fs.open(path.join(input.ui.observationDirectory, "vite-private.log"), "wx", 0o600)
  const peer = new URL(input.descriptor.peers.A.url)
  const vite = Bun.spawn([process.execPath, "run", "dev", "--", "--host", "127.0.0.1", "--port", String(input.ui.port), "--strictPort"], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"),
      VITE_DEEPAGENT_CODE_SERVER_HOST: peer.hostname, VITE_DEEPAGENT_CODE_SERVER_PORT: peer.port,
    },
    stdin: "ignore", stdout: log.fd, stderr: log.fd,
  })
  const state = { stage: "vite_readiness", browser: undefined as Awaited<ReturnType<typeof chromium.launch>> | undefined,
    uploads: 0, sends: 0, authQueryCleared: false, allNamesVisible: false, receiptObserved: false, bodyFiles: 0,
    vetoedExecution: 0, viteNaturalExit: false, vitePortClosed: false,
    uploadedBytes: 0, sendHTTPStatus: 0, sendErrorCode: "", sendRequestIDHash: "",
    sendResponseFinished: false, sendResponseConsumed: false, sendResponseBytes: 0,
    sendTransportState: "", sendTransportReason: "",
    timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const started = Date.now()
  const progress: { elapsedMs: number; phase: string; uploadReceipts: number; receiptBytes: number; sends: number }[] = []
  const interval = setInterval(() => {
    const observation = { elapsedMs: Date.now() - started, phase: state.stage, uploadReceipts: state.uploads,
      receiptBytes: state.uploadedBytes, sends: state.sends }
    if (progress.length < 60) progress.push(observation)
    console.log(JSON.stringify(observation))
  }, 5000)
  const origin = `http://127.0.0.1:${input.ui.port}`
  try {
    const readyUntil = Date.now() + 30_000
    while (Date.now() < readyUntil) {
      if (vite.exitCode !== null) throw new Error("Original Vite exited before readiness")
      if (await fetch(origin, { signal: AbortSignal.timeout(500) }).then((response) => response.ok).catch(() => false)) break
      await Bun.sleep(50)
    }
    if (Date.now() >= readyUntil) throw new Error("Original Vite readiness timed out")
    state.stage = "app_bootstrap"
    state.browser = await chromium.launch({ headless: true })
    state.timer = setTimeout(() => { void state.browser?.close() }, 180_000)
    const context = await state.browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 960 } })
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.origin !== peer.origin || request.method() !== "POST") return
      if (/\/(?:prompt|resume|execute)$/.test(url.pathname)) state.vetoedExecution++
    })
    page.on("response", async (response) => {
      if (response.request().method() !== "POST" || new URL(response.url()).origin !== peer.origin) return
      const pathname = new URL(response.url()).pathname
      if (pathname.endsWith("/attachments") && response.ok()) {
        state.uploads++
        const receipt: unknown = await response.json().catch(() => undefined)
        if (receipt && typeof receipt === "object" && "sizeBytes" in receipt && typeof receipt.sizeBytes === "number")
          state.uploadedBytes += receipt.sizeBytes
      }
      if (pathname.endsWith("/messages")) {
        state.sendHTTPStatus = response.status()
        const bytes = await response.body().catch(() => undefined)
        state.sendResponseConsumed = bytes !== undefined
        state.sendResponseBytes = bytes?.byteLength ?? 0
        const parsed = bytes !== undefined && bytes.byteLength <= 65536
          ? Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(bytes.toString("utf8"))
          : Option.none()
        const value = Option.getOrUndefined(parsed)
        if (response.ok()) state.receiptObserved = !!value && typeof value === "object" &&
          "id" in value && typeof value.id === "string" && value.id.length > 0 &&
          "groupID" in value && value.groupID === input.descriptor.groups.A.id &&
          "type" in value && value.type === "file"
        const transport = value && typeof value === "object" && "transport" in value ? value.transport : undefined
        const transportState = transport && typeof transport === "object" && "state" in transport ? transport.state : undefined
        if (transportState === "prepared" || transportState === "acknowledged" || transportState === "unknown")
          state.sendTransportState = transportState
        const reason = transport && typeof transport === "object" && "reason" in transport ? transport.reason : undefined
        if (typeof reason === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(reason)) state.sendTransportReason = reason
        const data = value && typeof value === "object" && "data" in value ? value.data : undefined
        const code = data && typeof data === "object" && "code" in data ? data.code : undefined
        if (!response.ok() && typeof code === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(code))
          state.sendErrorCode = code
        state.sendResponseFinished = true
      }
    })
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).origin !== peer.origin ||
          !new URL(request.url()).pathname.endsWith("/messages")) return
      state.sends++
      const body: unknown = request.postDataJSON()
      if (body && typeof body === "object" && "attachmentIDs" in body && Array.isArray(body.attachmentIDs))
        state.bodyFiles = body.attachmentIDs.length
      if (body && typeof body === "object" && "clientRequestID" in body &&
          typeof body.clientRequestID === "string" && body.clientRequestID.length <= 512)
        state.sendRequestIDHash = createHash("sha256").update("dac.im.gui.send.request.v1\0")
          .update(body.clientRequestID).digest("hex")
    })
    const directory = Buffer.from(input.descriptor.peers.A.directory).toString("base64url")
    await page.goto(`${origin}/${directory}/session?auth_token=${encodeURIComponent(input.credentials.slice(6))}`)
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("auth_token"))
    state.authQueryCleared = true
    await page.getByRole("tab", { name: "Messages", exact: true }).click()
    const panel = page.locator("#review-panel")
    await panel.getByRole("button").filter({ hasText: input.descriptor.groups.A.name }).click()
    state.stage = "select_four_files"
    await panel.getByRole("button", { name: "Attach file", exact: true }).waitFor({ state: "visible" })
    state.stage = "upload_four_files"
    await panel.locator('input[type="file"]').setInputFiles(input.descriptor.files.map((file) => file.path))
    const draft = panel.getByRole("region", { name: "Attachment draft" })
    await draft.waitFor({ state: "visible", timeout: 120_000 })
    for (const file of input.descriptor.files)
      await draft.getByText(file.filename, { exact: false }).waitFor({ timeout: 120_000 })
    state.allNamesVisible = true
    await panel.getByRole("textbox", { name: "Write a message…", exact: true }).fill(input.ui.caption)
    const send = panel.getByRole("button", { name: "Send", exact: true })
    await send.waitFor({ state: "visible" })
    const uploadUntil = Date.now() + 30_000
    while (state.uploads < 4 && Date.now() < uploadUntil) await Bun.sleep(25)
    if (state.uploads !== 4 || state.sends !== 0) throw new Error("Attachment drafts were not four original upload receipts")
    await page.screenshot({ path: path.join(input.ui.observationDirectory, "app-four-draft.png") })
    state.stage = "one_batch_send"
    await send.click()
    const receiptUntil = Math.min(input.descriptor.deadlineAt, Date.now() + 120_000)
    while (!state.sendResponseFinished && Date.now() < receiptUntil) await Bun.sleep(25)
    if (!state.receiptObserved || Number(state.sends) !== 1 || state.bodyFiles !== 4 || state.vetoedExecution !== 0)
      throw new Error("Original ordered batch receipt was not confirmed")
    await panel.getByText(input.ui.caption, { exact: true }).waitFor()
    await page.screenshot({ path: path.join(input.ui.observationDirectory, "app-one-batch.png") })
    state.stage = "sender_http_complete_remote_receipt_pending"
  } finally {
    clearInterval(interval)
    if (state.timer) clearTimeout(state.timer)
    await state.browser?.close()
    vite.kill("SIGTERM")
    state.viteNaturalExit = await Promise.race([vite.exited.then(() => true), Bun.sleep(3000).then(() => false)])
    if (!state.viteNaturalExit) { vite.kill("SIGKILL"); await vite.exited }
    state.vitePortClosed = await fetch(origin, { signal: AbortSignal.timeout(500) })
      .then(() => false).catch(() => true)
    await log.close()
    await fs.writeFile(path.join(input.ui.observationDirectory, "app-safe-observation.json"), JSON.stringify({
      version: 1, stage: state.stage, actualApp: true, actualHTTP: true, actualGoOwner: "shared-backend",
      uploads: state.uploads, sends: state.sends, orderedBodyFiles: state.bodyFiles,
      allNamesVisible: state.allNamesVisible, receiptObserved: state.receiptObserved,
      authQueryCleared: state.authQueryCleared, executionRequests: state.vetoedExecution,
      ownBrowserClosed: true, ownVitePID: vite.pid, ownViteExited: vite.exitCode !== null,
      viteExitBeforeForce: state.viteNaturalExit, taskFacts: "unavailable",
      ownVitePortClosed: state.vitePortClosed,
      receiptBytes: state.uploadedBytes, progress, actionBudgetMs: 180_000, uploadBudgetMs: 120_000,
      sendHTTPStatus: state.sendHTTPStatus, sendErrorCode: state.sendErrorCode,
      sendRequestIDHash: state.sendRequestIDHash, sendResponseFinished: state.sendResponseFinished,
      sendResponseConsumed: state.sendResponseConsumed, sendResponseBytes: state.sendResponseBytes,
      sendTransportState: state.sendTransportState, sendTransportReason: state.sendTransportReason,
      sendObservationBudgetMs: 120_000, remoteReceiptVerified: false,
    }, null, 2), { mode: 0o600, flag: "wx" })
  }
}

if (import.meta.main) {
  const descriptor = process.argv[2]
  const ui = process.argv[3]
  if (!descriptor || !ui) throw new Error("Original descriptor and UI plan files required")
  if (process.argv[4] === "--dry") {
    const value = await preflight(descriptor, ui)
    console.log(JSON.stringify({ dry: true, files: value.descriptor.files.length,
      task: value.descriptor.task.state, peerFields: Object.keys(value.descriptor.peers.A),
      previewFiles: value.descriptor.files.filter((file) => ["image/png", "image/jpeg"].includes(file.mime) && file.bytes <= 8 * 1024 * 1024).length,
      uiOrigin: `http://127.0.0.1:${value.ui.port}`, backendStarted: false }))
  }
  if (process.argv[4] !== "--dry") await run(descriptor, ui).catch(() => {
    console.error("IM_UI_PRODUCT_STAGE_FAILED; inspect the private safe observation")
    process.exitCode = 1
  })
}
