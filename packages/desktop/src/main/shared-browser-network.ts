import { net } from "electron"
import type { Session, WebContents, ClientRequest } from "electron"
import type { createManagedBrowserFiles, ManagedBrowserFileDownload } from "./managed-browser-files"
import { createHash, randomUUID } from "node:crypto"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserProxy } from "./shared-browser-proxy"
import { createSharedBrowserTransport } from "./shared-browser-transport"

type Mode = { epoch: number; state: SharedBrowserSchema.Resource["state"]; action?: SharedBrowserSchema.Action; policy?: SharedBrowserSchema.Policy }
type Request = { epoch: number; mode: Mode["state"]; url: string; method: string; hop: number;
  action?: SharedBrowserSchema.Action; fileDownload?: string; fileUpload?: boolean; uploadData?: Electron.UploadData[]; grant?: SharedBrowserSchema.Policy["postGrants"][number]; allowed: boolean }
export type SharedBrowserNetwork = {
  attach(contents: WebContents): () => void
  quiesce(epoch: number): Promise<{ closed: boolean; unknownEffects: boolean }>
  resume(epoch: number): boolean
  close(): Promise<boolean>
  download(action: SharedBrowserSchema.Action, url: URL, signal: AbortSignal, current: () => Promise<void>): Promise<ManagedBrowserFileDownload>
}

/** Resource-owned Chromium networking; old action-owned v1 brokers are unchanged. */
export async function createSharedBrowserNetwork(input: {
  partition: Session
  policy: SharedBrowserSchema.Policy
  current: () => Mode
  owns: (contents: WebContents | undefined) => boolean
  onAllocated: (network: SharedBrowserNetwork) => void
  file?: () => { action: SharedBrowserSchema.Action; transfer: ReturnType<typeof createManagedBrowserFiles> } | undefined
}) {
  let initialized = false
  let quiescing = false
  let closed = false
  const requests = new Map<number, Request>()
  const fileHeader = "x-dac-private-file-admission"
  const downloads = new Map<string, { action: SharedBrowserSchema.Action; url: string; epoch: number; request: ClientRequest;
    terminal: Promise<void>; current: () => Promise<void> }>()
  const closeDownloads = async () => {
    const values = [...downloads.values()]
    values.forEach((value) => { value.request.abort() })
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([Promise.all(values.map(async (value) => {
      await value.terminal
    })).then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000) })]) }
    finally { clearTimeout(timer) }
  }
  const consumed = new WeakSet<SharedBrowserSchema.Action>()
  const fileUploads = new WeakSet<SharedBrowserSchema.Action>()
  const actionRequests = new WeakMap<SharedBrowserSchema.Action, number>()
  const origins = () => {
    const current = input.current()
    const policy = current.policy ?? input.policy
    return current.state === "human_owned" ? policy.manualApprovedOrigins : policy.approvedOrigins
  }
  const open = () => initialized && !closed && !quiescing && ["agent_owned", "human_owned"].includes(input.current().state)
  const current = (record: Request) => open() && input.current().epoch === record.epoch &&
    input.current().state === record.mode && (!record.action || input.current().action === record.action && record.action.deadline > Date.now())
  const transport = createSharedBrowserTransport({ policy: input.policy,
    current: () => ({ epoch: input.current().epoch, origins: origins(), open: open() }) })
  const proxy = await BrowserProxy.make(transport)
  const allowedURL = (value: string) => {
    if (!URL.canParse(value) || Buffer.byteLength(value) > 2048) return false
    const url = new URL(value)
    return !url.username && !url.password && origins().includes(url.origin)
  }
  input.partition.webRequest.onBeforeRequest((details, callback) => {
    if (details.url === "about:blank") { callback({ cancel: false }); return }
    const download = !details.webContents && details.method === "GET" ? [...downloads].find(([, value]) =>
      value.url === details.url && value.epoch === input.current().epoch && value.action === input.current().action) : undefined
    if (!open() || !allowedURL(details.url) || !input.owns(details.webContents) && !download ||
      ["webSocket", "object", "ping", "cspReport"].includes(details.resourceType) || requests.size >= 128) {
      callback({ cancel: true }); return
    }
    const mode = input.current()
    const prior = requests.get(details.id)
    if (prior && (!current(prior) || prior.hop >= 8 || prior.method !== "GET" && prior.method !== "HEAD")) {
      callback({ cancel: true }); return
    }
    const record: Request = { epoch: prior?.epoch ?? mode.epoch, mode: prior?.mode ?? mode.state,
      method: details.method, url: details.url, hop: prior ? prior.hop + 1 : 0, allowed: false,
      ...(download ? { fileDownload: download[0], action: download[1].action } : {}) }
    if (mode.state === "agent_owned" && !["GET", "HEAD"].includes(details.method)) {
      const action = mode.action
      // Worker/unknown-frame writes cannot borrow the root page's action. File/blob
      // upload paths need their original exact-byte grant chain, never a path hash.
      const frameOwned = (() => {
        try { return !!details.frame && !details.frame.detached && !!details.webContents &&
          details.frame.top === details.webContents.mainFrame }
        catch { return false }
      })()
      const file = input.file?.()
      if (action && action.command.type === "file.upload" && file?.action === action && frameOwned && details.method === "POST") {
        if (prior || details.uploadData.some((part) => part.blobUUID)) { callback({ cancel: true }); return }
        record.action = action; record.fileUpload = true; record.uploadData = details.uploadData
        requests.set(details.id, record)
        callback({ cancel: !current(record) }); return
      }
      if (!action || !["fill", "select", "click", "press", "scroll", "drag", "program"].includes(action.command.type) ||
        !frameOwned || details.method !== "POST" ||
        consumed.has(action) || (actionRequests.get(action) ?? 0) >= 128 ||
        details.uploadData.some((part) => part.file || part.blobUUID || !Buffer.isBuffer(part.bytes))) {
        callback({ cancel: true }); return
      }
      const bytes = details.uploadData.reduce((size, part) => size + part.bytes.length, 0)
      if (bytes > BrowserSchema.MAX_POST_BYTES) { callback({ cancel: true }); return }
      const digest = createHash("sha256")
      details.uploadData.forEach((part) => digest.update(part.bytes))
      const bodySha256 = digest.digest("hex")
      const grant = input.policy.postGrants.find((value) => value.method === details.method && value.url === details.url &&
        value.bytes === bytes && value.bodySha256 === bodySha256)
      if (!grant) { callback({ cancel: true }); return }
      record.action = action
      record.grant = grant
      actionRequests.set(action, (actionRequests.get(action) ?? 0) + 1)
    }
    requests.set(details.id, record)
    // No async permission window here: admission was validated by the current
    // action, and the headers gate below is the final one-use dispatch boundary.
    callback({ cancel: !current(record) })
  })
  input.partition.webRequest.onBeforeSendHeaders((details, callback) => {
    const record = requests.get(details.id)
    if (!record || !current(record) || record.url !== details.url || record.method !== details.method) {
      callback({ cancel: true }); return
    }
    if (record.fileDownload) {
      const file = downloads.get(record.fileDownload)
      const header = Object.entries(details.requestHeaders).find(([name]) => name.toLowerCase() === fileHeader)
      if (!file || file.action !== record.action || header?.[1] !== record.fileDownload) { callback({ cancel: true }); return }
      void file.current().then(() => {
        if (!current(record) || downloads.get(record.fileDownload!) !== file) { callback({ cancel: true }); return }
        const headers = { ...details.requestHeaders }
        if (header) delete headers[header[0]]
        record.allowed = true
        callback({ cancel: false, requestHeaders: headers })
      }, () => callback({ cancel: true }))
      return
    }
    if (record.fileUpload) {
      const file = input.file?.()
      if (!file || file.action !== record.action || fileUploads.has(file.action)) { callback({ cancel: true }); return }
      // Reserve before reconstructing multipart bytes. Concurrent page requests
      // cannot allocate a second bounded body or reuse a refused file action.
      fileUploads.add(file.action)
      void (async () => {
        const body = await file.transfer.uploadData(record.uploadData ?? [])
        await file.transfer.authorizePost(new URL(record.url),
          Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value])), body)
        if (!current(record) || input.file?.()?.transfer !== file.transfer) { callback({ cancel: true }); return }
        record.allowed = true
        callback({ cancel: false })
      })().catch(() => callback({ cancel: true }))
      return
    }
    if (record.grant && record.action) {
      const header = Object.entries(details.requestHeaders).find(([name]) => name.toLowerCase() === "content-type")?.[1]
      if (consumed.has(record.action) || header !== record.grant.contentType) { callback({ cancel: true }); return }
      consumed.add(record.action)
    }
    record.allowed = true
    callback({ cancel: false })
  })
  input.partition.webRequest.onCompleted((details) => {
    const record = requests.get(details.id)
    const file = input.file?.()
    if (record?.fileUpload && record.allowed && file && record.action === file.action) file.transfer.completePost()
    requests.delete(details.id)
  })
  input.partition.webRequest.onErrorOccurred((details) => {
    const record = requests.get(details.id)
    const file = input.file?.()
    if (record?.fileUpload && file && record.action === file.action) file.transfer.failPost()
    requests.delete(details.id)
  })
  const network: SharedBrowserNetwork = {
    async download(action, url, signal, currentCheck) {
      if (!open() || action !== input.current().action || action.command.type !== "file.download" || !allowedURL(url.href) || downloads.size >= 1)
        throw new Error("BROWSER_SCOPE_DENIED")
      await currentCheck()
      if (!open() || action !== input.current().action || signal.aborted) throw new Error("BROWSER_CANCELLED")
      const nonce = randomUUID()
      const request = net.request({ url: url.href, method: "GET", session: input.partition, useSessionCookies: true, redirect: "manual" })
      const terminal = Promise.withResolvers<void>()
      const value: (typeof downloads extends Map<string, infer T> ? T : never) = { action, url: url.href, epoch: input.current().epoch,
        request, terminal: terminal.promise, current: currentCheck }
      downloads.set(nonce, value)
      const abort = () => request.abort()
      const settle = () => { terminal.resolve(); signal.removeEventListener("abort", abort); downloads.delete(nonce) }
      signal.addEventListener("abort", abort, { once: true })
      // Electron's ClientRequest is an auto-destroy Writable: its close event
      // follows request.end(), before the network response. Keep admission until
      // response/error/abort; cancellation also requires the proxy + partition
      // close acknowledgements in quiesce/close, never this local event alone.
      request.on("login", (auth, callback) => {
        if (auth.isProxy && auth.scheme === "basic" && auth.host === proxy.host && auth.port === proxy.port && auth.realm === "DAC Browser Proxy")
          callback(proxy.credentials.username, proxy.credentials.password)
        else callback()
      })
      request.on("redirect", abort)
      request.setHeader(fileHeader, nonce)
      request.setHeader("accept-encoding", "identity")
      return new Promise<ManagedBrowserFileDownload>((resolve, reject) => {
        request.on("error", (error) => { settle(); reject(error) })
        request.once("abort", () => { settle(); reject(new Error("BROWSER_CANCELLED")) })
        request.once("response", (response) => {
          const state: { complete: boolean; ended: boolean; error?: Error; bytes: number } = { complete: false, ended: false, bytes: 0 }
          const queue: Buffer[] = []
          let wake = Promise.withResolvers<void>()
          const fail = (error: Error) => { state.error = error; state.ended = true; wake.resolve(); request.abort() }
          response.once("end", () => { state.complete = true; state.ended = true; wake.resolve(); settle() })
          response.once("error", fail)
          response.once("aborted", () => fail(new Error("BROWSER_CANCELLED")))
          // Pinned Electron's IncomingMessage extends Node Readable, although
          // its generated event overloads omit Readable's reducing close event.
          ;(response as NodeJS.EventEmitter).once("close", () => { if (!state.complete) fail(new Error("BROWSER_UNKNOWN")) })
          response.on("data", (chunk) => {
            state.bytes += chunk.length
            if (state.bytes > 52_428_800) { fail(new Error("BROWSER_OUTPUT_LIMIT")); return }
            queue.push(Buffer.from(chunk)); wake.resolve()
          })
          const body = (async function* () {
            while (!state.ended || queue.length) {
              if (state.error) throw state.error
              const chunk = queue.shift()
              if (chunk) { yield chunk; continue }
              await wake.promise
              wake = Promise.withResolvers<void>()
            }
            if (state.error) throw state.error
          })()
          resolve({ statusCode: response.statusCode, headers: response.headers, body,
            get complete() { return state.complete }, destroy: () => { request.abort(); fail(new Error("BROWSER_CANCELLED")) } })
        })
        if (signal.aborted) abort()
        else request.end()
      })
    },
    attach(contents: WebContents) {
      const login = (event: Electron.Event, _details: Electron.LoginAuthenticationResponseDetails,
        auth: Electron.AuthInfo, callback: (username?: string, password?: string) => void) => {
        if (!auth.isProxy || auth.scheme !== "basic" || auth.host !== proxy.host || auth.port !== proxy.port ||
          auth.realm !== "DAC Browser Proxy") return
        event.preventDefault()
        callback(proxy.credentials.username, proxy.credentials.password)
      }
      contents.on("login", login)
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")
      return () => contents.off("login", login)
    },
    async quiesce(epoch: number) {
      quiescing = true
      const unknownEffects = [...requests.values()].some((record) => record.allowed && !["GET", "HEAD"].includes(record.method))
      const [broker, chromium, files] = await Promise.all([
        proxy.quiesce(epoch), input.partition.closeAllConnections().then(() => true, () => false), closeDownloads(),
      ])
      requests.clear()
      return { closed: broker.closed && chromium && files, unknownEffects }
    },
    resume(epoch: number) {
      if (!initialized || closed || input.current().epoch !== epoch || !proxy.resume(epoch)) return false
      quiescing = false
      return true
    },
    async close() {
      closed = true
      quiescing = true
      const [broker, chromium, files] = await Promise.all([
        proxy.close(), input.partition.closeAllConnections().then(() => true, () => false), closeDownloads(),
      ])
      requests.clear()
      return broker.closed && chromium && files
    },
  }
  // Transfer cleanup custody before either initialization await can fail. No
  // tab is created, and the gate stays closed until initialization completes.
  input.onAllocated(network)
  await input.partition.setProxy({ mode: "fixed_servers", proxyRules: proxy.url, proxyBypassRules: "<-loopback>" })
  await input.partition.closeAllConnections()
  initialized = true
  return network
}
