export * as IMMediaFixedPhaseProduct from "./im-media-product-fixedphase"

import { chromium, type Page } from "@playwright/test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { IMMediaProduct } from "./im-media-product"

/** Launch only the original App Vite entry. Backend/Go/fault resources remain
 * owned by the shared fixture; no route interception or substitute client. */
export async function run(descriptorFile: string, uiFile: string) {
  const input = await IMMediaProduct.preflight(descriptorFile, uiFile, true)
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
    page: undefined as Page | undefined,
    uploads: 0, sends: 0, authQueryCleared: false, allNamesVisible: false, receiptObserved: false, bodyFiles: 0,
    vetoedExecution: 0, viteNaturalExit: false, vitePortClosed: false,
    uploadedBytes: 0, sendHTTPStatus: 0, sendErrorCode: "", sendRequestIDHash: "",
    sendResponseFinished: false, sendResponseConsumed: false,
    sendTransportState: "", sendTransportReason: "",
    originalFetchDispatched: false, originalJSONCalled: false, originalJSONSettled: false, originalJSONRejected: false,
    originalSignalAborted: false, originalResponseBodyUsed: false, targetDOMGeneration: 0, targetDOMChanged: false,
    timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const qualifications: object[] = []
  const panels: object[] = []
  const fixed: { phase: string; elapsedMs: number; status?: number; aborted?: boolean; targetGeneration?: number; code?: string }[] = []
  const producer = { clientRequestID: "", groupID: "", attachmentIDs: [] as string[], messageID: "" }
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
    state.page = page
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
        {
        producer.clientRequestID = body.clientRequestID
        producer.groupID = input.descriptor.groups.A.id
        producer.attachmentIDs = "attachmentIDs" in body && Array.isArray(body.attachmentIDs)
          ? body.attachmentIDs.filter((id): id is string => typeof id === "string" && id.length <= 512) : []
        state.sendRequestIDHash = createHash("sha256").update("dac.im.gui.send.request.v1\0")
          .update(body.clientRequestID).digest("hex")
      }
    })
    await page.exposeFunction("dacIMSendPhase", (event: unknown) => {
      if (!event || typeof event !== "object" || !("phase" in event) || typeof event.phase !== "string" ||
          !["fetch_dispatch", "fetch_response", "fetch_rejected", "signal_aborted", "json_called", "json_settled", "json_rejected"].includes(event.phase)) return
      if (fixed.length >= 256) return
      const status = "status" in event && Number.isInteger(event.status) && typeof event.status === "number" ? event.status : undefined
      const aborted = "aborted" in event && typeof event.aborted === "boolean" ? event.aborted : undefined
      const generation = "targetGeneration" in event && Number.isInteger(event.targetGeneration) && typeof event.targetGeneration === "number"
        ? event.targetGeneration : undefined
      const code = "code" in event && typeof event.code === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(event.code) ? event.code : undefined
      fixed.push({ phase: event.phase, elapsedMs: Date.now() - started, status, aborted, targetGeneration: generation, code })
      if (generation) {
        if (state.targetDOMGeneration && generation !== state.targetDOMGeneration) state.targetDOMChanged = true
        state.targetDOMGeneration = generation
      }
      if (event.phase === "fetch_dispatch") state.originalFetchDispatched = true
      if (event.phase === "fetch_response") state.sendHTTPStatus = status ?? 0
      if (event.phase === "signal_aborted") state.originalSignalAborted = true
      if (event.phase === "json_called") state.originalJSONCalled = true
      if (event.phase === "json_rejected") { state.originalJSONRejected = true; state.sendResponseFinished = true }
      if (event.phase === "fetch_rejected") { state.sendErrorCode = code ?? "fetch_rejected"; state.sendResponseFinished = true }
      if (event.phase === "json_settled") {
        state.originalJSONSettled = true
        state.originalResponseBodyUsed = "bodyUsed" in event && event.bodyUsed === true
        state.sendResponseConsumed = state.originalResponseBodyUsed
        state.sendResponseFinished = true
        state.receiptObserved = "validMessage" in event && event.validMessage === true && status === 200
        state.sendErrorCode = code ?? ""
        const transport = "transport" in event && typeof event.transport === "string" ? event.transport : ""
        if (["prepared", "acknowledged", "unknown"].includes(transport)) state.sendTransportState = transport
      }
    })
    await page.exposeFunction("dacIMProducedIdentity", (value: unknown) => {
      if (!value || typeof value !== "object" || !("messageID" in value) || typeof value.messageID !== "string" ||
          !value.messageID || value.messageID.length > 512 || !("groupID" in value) ||
          value.groupID !== input.descriptor.groups.A.id) return
      producer.messageID = value.messageID
    })
    await page.exposeFunction("dacIMPreUploadPhase", (value: unknown) => {
      if (!value || typeof value !== "object" || !("kind" in value) || !("phase" in value) ||
          !["capabilities", "status", "group"].includes(String(value.kind)) ||
          !["dispatch", "response", "rejected"].includes(String(value.phase)) || qualifications.length >= 96) return
      const facts: Record<string, string | number | boolean> = { kind: String(value.kind), phase: String(value.phase), elapsedMs: Date.now() - started }
      for (const key of ["enabled", "viewerPresent", "kernelConnected", "readerReady", "currentEpoch", "groupMatched", "workspaceMatched", "pendingOrReady"])
        if (key in value && typeof Reflect.get(value, key) === "boolean") facts[key] = Reflect.get(value, key)
      if ("status" in value && typeof value.status === "number" && Number.isInteger(value.status)) facts.status = value.status
      if ("code" in value && typeof value.code === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value.code)) facts.code = value.code
      qualifications.push(facts)
    })
    await page.addInitScript(({ rootOrigin, groupID, workspaceID, epoch }) => {
      const original = window.fetch.bind(window)
      const selected = { node: null as Element | null, generation: 0 }
      const generation = () => {
        const node = document.querySelector('#review-panel textarea[placeholder="Write a message…"]')
        if (node !== selected.node) { selected.node = node; selected.generation++ }
        return selected.generation
      }
      const emit = (event: object) => queueMicrotask(() => {
        // QA observer failures must not replace the original fetch/JSON result.
        try {
          const observer = Reflect.get(window, "dacIMSendPhase")
          if (typeof observer === "function") void Promise.resolve(observer({ ...event, targetGeneration: generation() })).catch(() => undefined)
        } catch {}
      })
      window.fetch = Object.assign((resource: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(resource instanceof Request ? resource.url : String(resource), location.href)
        const method = init?.method ?? (resource instanceof Request ? resource.method : "GET")
        const kind = url.origin === rootOrigin && method === "GET"
          ? url.pathname === "/global/capabilities" ? "capabilities"
          : url.pathname === "/api/v1/im/status" ? "status"
          : url.pathname === "/api/v1/im/groups/" + encodeURIComponent(groupID) ? "group" : undefined
          : undefined
        if (kind) {
          const observe = (facts: object) => queueMicrotask(() => {
            try {
              const observer = Reflect.get(window, "dacIMPreUploadPhase")
              if (typeof observer === "function") void Promise.resolve(observer({ kind, ...facts })).catch(() => undefined)
            } catch {}
          })
          observe({ phase: "dispatch" })
          const pending = original(resource, init)
          void pending.then(async (response) => {
            const value: unknown = await response.clone().json().catch(() => undefined)
            const object = value && typeof value === "object" ? value : undefined
            const data = object && "data" in object && object.data && typeof object.data === "object" ? object.data : undefined
            const code = data && "code" in data && typeof data.code === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(data.code) ? data.code : undefined
            const reader = object && "reader" in object && object.reader && typeof object.reader === "object" ? object.reader : undefined
            const group = object && "group" in object && object.group && typeof object.group === "object" ? object.group : undefined
            const groupReader = group && "reader" in group && group.reader && typeof group.reader === "object" ? group.reader : undefined
            const features = object && "features" in object && object.features && typeof object.features === "object" ? object.features : undefined
            const viewer = object && "viewer" in object && object.viewer && typeof object.viewer === "object" ? object.viewer : undefined
            observe({ phase: "response", status: response.status, code,
              ...(kind === "capabilities" ? { enabled: !!features && "v4FileUploadEnabled" in features && features.v4FileUploadEnabled === true } : {}),
              ...(kind === "status" ? { viewerPresent: !!viewer && "memberID" in viewer && typeof viewer.memberID === "string" && !!viewer.memberID,
                kernelConnected: !!object && "kernel" in object && object.kernel === "connected",
                readerReady: !!reader && "state" in reader && reader.state === "ready" } : {}),
              ...(kind === "group" ? { groupMatched: !!group && "id" in group && group.id === groupID,
                workspaceMatched: !!group && "workspaceID" in group && group.workspaceID === workspaceID,
                pendingOrReady: !!groupReader && "state" in groupReader && ["pending", "ready"].includes(String(groupReader.state)) } : {}),
              ...(kind !== "capabilities" ? { currentEpoch: !!reader && "displayEpoch" in reader && reader.displayEpoch === epoch } : {}),
            })
          }, (error: unknown) => observe({ phase: "rejected", code: error instanceof Error ? error.name : "Unknown" })).catch(() => undefined)
          return pending
        }
        if (url.origin !== rootOrigin || url.pathname !== "/api/v1/im/groups/" + encodeURIComponent(groupID) + "/messages" || method !== "POST")
          return original(resource, init)
        const signal = init?.signal ?? (resource instanceof Request ? resource.signal : undefined)
        emit({ phase: "fetch_dispatch", aborted: signal?.aborted === true })
        const abort = () => emit({ phase: "signal_aborted", aborted: true })
        signal?.addEventListener("abort", abort, { once: true })
        const pending = original(resource, init)
        void pending.then((response) => {
          emit({ phase: "fetch_response", status: response.status, aborted: signal?.aborted === true })
          const json = response.json.bind(response)
          response.json = () => {
            emit({ phase: "json_called", status: response.status, aborted: signal?.aborted === true })
            const result = json()
            void result.then((value: unknown) => {
              const object = value && typeof value === "object" ? value : undefined
              const data = object && "data" in object && object.data && typeof object.data === "object" ? object.data : undefined
              const code = data && "code" in data && typeof data.code === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(data.code) ? data.code : undefined
              const transport = object && "transport" in object && object.transport && typeof object.transport === "object" && "state" in object.transport
                ? object.transport.state : undefined
              emit({ phase: "json_settled", status: response.status, code, bodyUsed: response.bodyUsed,
                transport: typeof transport === "string" ? transport : undefined,
                validMessage: !!object && "id" in object && typeof object.id === "string" && object.id.length > 0 &&
                  "groupID" in object && object.groupID === groupID && "type" in object && object.type === "file" })
              if (response.ok && object && "id" in object && typeof object.id === "string" && object.id.length <= 512 &&
                  "groupID" in object && object.groupID === groupID && "type" in object && object.type === "file") {
                queueMicrotask(() => {
                  try {
                    const observer = Reflect.get(window, "dacIMProducedIdentity")
                    if (typeof observer === "function") void Promise.resolve(observer({ messageID: object.id, groupID })).catch(() => undefined)
                  } catch {}
                })
              }
              signal?.removeEventListener("abort", abort)
            }, (error: unknown) => {
              emit({ phase: "json_rejected", status: response.status, code: error instanceof Error ? error.name : "Unknown", aborted: signal?.aborted === true })
              signal?.removeEventListener("abort", abort)
            }).catch(() => undefined)
            return result
          }
        }, (error: unknown) => {
          emit({ phase: "fetch_rejected", code: error instanceof Error ? error.name : "Unknown", aborted: signal?.aborted === true })
          signal?.removeEventListener("abort", abort)
        }).catch(() => undefined)
        return pending
      }, original)
    }, { rootOrigin: peer.origin, groupID: input.descriptor.groups.A.id,
      workspaceID: input.descriptor.groups.A.workspaceID, epoch: input.descriptor.state.A.reader.displayEpoch })
    const directory = Buffer.from(input.descriptor.peers.A.directory).toString("base64url")
    await page.goto(`${origin}/${directory}/session?auth_token=${encodeURIComponent(input.credentials.slice(6))}`)
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("auth_token"))
    state.authQueryCleared = true
    await page.getByRole("tab", { name: "Messages", exact: true }).click()
    const panel = page.locator("#review-panel")
    await panel.getByRole("button").filter({ hasText: input.descriptor.groups.A.name }).click()
    state.stage = "conversation_loaded"
    await panel.getByRole("textbox", { name: "Write a message…", exact: true }).waitFor({ state: "visible" })
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
  } catch (error) {
    if (state.page && !state.page.isClosed()) {
      const panel = state.page.locator("#review-panel")
      const text = (await panel.textContent().catch(() => ""))?.slice(0, 16_384) ?? ""
      await fs.writeFile(path.join(input.ui.observationDirectory, "app-preupload-panel-private.txt"), text, { mode: 0o600, flag: "wx" })
      await state.page.screenshot({ path: path.join(input.ui.observationDirectory, "app-failure-private.png") }).catch(() => undefined)
      const composer = panel.getByRole("textbox", { name: "Write a message…", exact: true })
      const attach = panel.getByRole("button", { name: "Attach file", exact: true })
      panels.push({ elapsedMs: Date.now() - started, stage: state.stage,
        composerVisible: await composer.isVisible().catch(() => false),
        attachVisible: await attach.isVisible().catch(() => false),
        fileInputs: await panel.locator('input[type="file"]').count().catch(() => 0),
        pendingText: text.includes("Waiting for the conversation to become readable"),
        currentAccessText: text.includes("Current access verified"),
        unknownText: text.includes("result is unknown"),
        unavailableText: text.includes("unavailable"),
        qualificationMeaning: "Original visible DOM and observed GET output only; not a permission or private owner probe" })
    }
    await fs.writeFile(path.join(input.ui.observationDirectory, "app-driver-error-private.log"),
      error instanceof Error ? error.stack ?? error.message : String(error), { mode: 0o600, flag: "wx" })
    throw error
  } finally {
    clearInterval(interval)
    if (state.timer) clearTimeout(state.timer)
    await state.browser?.close()
    if (vite.exitCode === null) vite.kill("SIGTERM")
    state.viteNaturalExit = await Promise.race([vite.exited.then(() => true), Bun.sleep(3000).then(() => false)])
    if (!state.viteNaturalExit) { vite.kill("SIGKILL"); await vite.exited }
    state.vitePortClosed = await fetch(origin, { signal: AbortSignal.timeout(500) })
      .then(() => false).catch(() => true)
    await fs.writeFile(path.join(input.ui.observationDirectory, "producer-call-private.json"), JSON.stringify(producer, null, 2), { mode: 0o600, flag: "wx" })
    await log.close()
    await fs.writeFile(path.join(input.ui.observationDirectory, "app-safe-observation.json"), JSON.stringify({
      version: 1, stage: state.stage, actualApp: true, actualHTTP: true, actualGoOwner: "shared-backend",
      uploads: state.uploads, sends: state.sends, orderedBodyFiles: state.bodyFiles,
      allNamesVisible: state.allNamesVisible, receiptObserved: state.receiptObserved,
      authQueryCleared: state.authQueryCleared, executionRequests: state.vetoedExecution,
      ownBrowserClosed: true, ownVitePID: vite.pid, ownViteExited: vite.exitCode !== null,
      viteExitBeforeForce: state.viteNaturalExit, taskFacts: "unavailable",
      ownVitePortClosed: state.vitePortClosed,
      receiptReportedAttachmentBytes: state.uploadedBytes, progress, actionBudgetMs: 180_000, uploadBudgetMs: 120_000,
      sendHTTPStatus: state.sendHTTPStatus, sendErrorCode: state.sendErrorCode,
      sendRequestIDHash: state.sendRequestIDHash, sendResponseFinished: state.sendResponseFinished,
      sendResponseConsumed: state.sendResponseConsumed,
      sendResponseBytes: null, sendBodyBytesObservation: "Unavailable; original JSON completion observed without independent body consumption",
      sendTransportState: state.sendTransportState, sendTransportReason: state.sendTransportReason,
      sendObservationBudgetMs: 120_000, remoteReceiptVerified: false, fixedPhases: fixed,
      originalFetchDispatched: state.originalFetchDispatched, originalJSONCalled: state.originalJSONCalled,
      originalJSONSettled: state.originalJSONSettled, originalJSONRejected: state.originalJSONRejected,
      originalSignalAborted: state.originalSignalAborted, originalResponseBodyUsed: state.originalResponseBodyUsed,
      targetDOMGeneration: state.targetDOMGeneration, targetDOMChanged: state.targetDOMChanged,
      targetObservation: "Actual composer DOM instance generation, not access to private reactive owner fields",
      preUploadQualifications: qualifications, preUploadPanelFacts: panels,
    }, null, 2), { mode: 0o600, flag: "wx" })
  }
}

if (import.meta.main) {
  const descriptor = process.argv[2]
  const ui = process.argv[3]
  if (!descriptor || !ui) throw new Error("Original descriptor and UI plan files required")
  if (process.argv[4] === "--dry") {
    const value = await IMMediaProduct.preflight(descriptor, ui)
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
