import { BrowserWindow, MessageChannelMain, session, dialog } from "electron"
import type { MessagePortMain, UtilityProcess, WebContents, Session, WebFrameMain } from "electron"
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
import { createServer, request } from "node:http"
import type { Server, ClientRequest, IncomingMessage } from "node:http"
import { BrowserSchema } from "@deepagent-code/core/browser/schema"
import { BrowserProtocol } from "@deepagent-code/core/browser/protocol"
import { BrowserFileSchema } from "@deepagent-code/core/browser/file-exchange.schema"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Option, Schema } from "effect"
import { createManagedBrowserActions } from "./managed-browser-actions"
import { createManagedBrowserNetwork } from "./managed-browser-network"
import { createManagedBrowserFiles, MAX_FORM_BODY } from "./managed-browser-files"
import { createManagedBrowserClipboard } from "./managed-browser-clipboard"
import { installManagedBrowserClipboardPolicy } from "./managed-browser-clipboard-policy"
import { observeManagedBrowserInput } from "./managed-browser-input-observer"
import type { ManagedBrowserInputAsset } from "./managed-browser-input-observer"
import { builtManagedBrowserInputAsset } from "./managed-browser-input-asset"
import type { ProgramInput } from "./managed-browser-program"

type ManagedTab = {
  tabID: string
  generation: number
  window: BrowserWindow
  contents: WebContents
  inputs?: ReturnType<typeof createManagedBrowserActions>
  inputSource?: ReturnType<typeof observeManagedBrowserInput>
  clipboardPolicy?: () => void
  navigation?: (
    method: string,
    params: { frame?: { id?: string }; frameId?: string; url?: string; reason?: string },
  ) => void
}
type Entry = {
  descriptor: string
  control: BrowserSchema.Control
  stopped: boolean
  confirmed: boolean
  stopPromise?: Promise<boolean>
  onStopped: () => void
  tabs: Map<string, ManagedTab>
  selectedTabID?: string
  activeContentsID?: number
  session?: Session
  proxy?: Server
  streams: Set<ClientRequest>
  incoming: Set<IncomingMessage>
  network?: Awaited<ReturnType<typeof createManagedBrowserNetwork>>
  files?: ReturnType<typeof createManagedBrowserFiles>
  confirming?: { controller: AbortController; commandHash: string }
  confirmations?: Map<
    string,
    { commandHash: string; previewHash: string; value: Promise<BrowserFileSchema.Confirmation> }
  >
  mutated: boolean
  epoch: number
  queue: number
  chain: Promise<void>
  action?: BrowserSchema.Action
  seen: Set<string>
  timer?: ReturnType<typeof setTimeout>
  programLeaf?: {
    action: BrowserSchema.Action
    command: ProgramInput
    navigation?: { url: string; method: string }
    request?: { url: string; method: string; body: Buffer; frame: WebFrameMain; source: string; consumed: boolean }
  }
  publicLeaf?: { action: BrowserSchema.Action; command: ProgramInput; navigation?: { url: string; method: string } }
}
class Failure extends Error {
  constructor(readonly code: BrowserSchema.Error["code"]) {
    super(code)
  }
}
function fail(code: BrowserSchema.Error["code"]): never {
  throw new Failure(code)
}
const hash = (value: unknown) => createHash("sha256").update(CanonicalJson.stringify(value)).digest("hex")
const immutable = (control: BrowserSchema.Control) =>
  hash({
    controlID: control.controlID,
    scope: control.scope,
    hostID: control.hostID,
    hostIncarnation: control.hostIncarnation,
    resourceID: control.resourceID,
    credentialBinding: control.credentialBinding,
    profile: control.profile,
    origin: control.origin,
    expiresAt: control.expiresAt,
    policyRevision: control.policyRevision,
    ...(control.profile === BrowserSchema.INTERACTION_PROFILE
      ? {
          postPaths: control.postPaths,
          ...(control.scriptGrants === undefined ? {} : { scriptGrants: control.scriptGrants }),
          ...(control.programGrants === undefined ? {} : { programGrants: control.programGrants }),
          ...(control.clipboardPolicy === undefined ? {} : { clipboardPolicy: control.clipboardPolicy }),
        }
      : {}),
    ...(control.profile === BrowserSchema.PUBLIC_READONLY_PROFILE
      ? { approvedOrigins: control.approvedOrigins, resolverPolicy: control.resolverPolicy }
      : {}),
    ...(control.profile === BrowserSchema.PUBLIC_INTERACTION_PROFILE ? { approvedOrigins: control.approvedOrigins,
      resolverPolicy: control.resolverPolicy, pageMode: control.pageMode, postTargets: control.postTargets } : {}),
    ...(control.profile === BrowserSchema.API_POST_PROFILE ? { approvedOrigins: control.approvedOrigins,
      resolverPolicy: control.resolverPolicy, pageMode: control.pageMode, apiPostTargets: control.apiPostTargets } : {}),
    ...(control.profile === BrowserSchema.FILE_EXCHANGE_PROFILE
      ? { postPaths: control.postPaths, filePolicy: control.filePolicy }
      : {}),
  })

/** Called with the actual utilityProcess returned by this launch. The transferred port is never
 * exposed to webContents/preload/renderer IPC. Closing it destroys this host's exact resources. */
export function installManagedBrowser(child: UtilityProcess, password: string,
  inputAsset = builtManagedBrowserInputAsset()) {
  const channel = new MessageChannelMain()
  const manager = createManager(channel.port1, inputAsset)
  const credentialKey = randomBytes(32)
  const username = "deepagent-code"
  const credentialBinding = createHmac("sha256", credentialKey)
    .update("dac.browser.credentials.v1\0")
    .update(CanonicalJson.stringify({ username, password }))
    .digest("hex")
  child.postMessage(
    {
      type: "managed-browser-install-v1",
      hostID: manager.hostID,
      hostIncarnation: manager.hostIncarnation,
      username,
      credentialBinding,
      credentialKey: credentialKey.toString("hex"),
    },
    [channel.port2],
  )
  child.once("exit", manager.close)
  return manager.close
}

function createManager(port: MessagePortMain, inputAsset: ManagedBrowserInputAsset | undefined) {
  const runClipboard = createManagedBrowserClipboard(fail)
  const hostID = randomUUID()
  const hostIncarnation = randomUUID()
  const controls = new Map<string, Entry>()
  const checks = new Map<string, (allowed: boolean) => void>()
  const leaves = new Map<string, (response: BrowserProtocol.FileLeafResponse) => void>()
  let alive = true
  let waiting = 0
  const close = () => {
    if (!alive) return
    alive = false
    for (const entry of controls.values()) void stop(entry)
    for (const resolve of checks.values()) resolve(false)
    checks.clear()
    for (const [id, resolve] of leaves) resolve({ type: "file.leaf.response", id, error: "BROWSER_FILE_UNKNOWN" })
    leaves.clear()
    port.close()
  }
  const permit = async (entry: Entry, action: BrowserSchema.Action) => {
    if (
      !alive ||
      entry.stopped ||
      entry.action !== action ||
      action.deadline <= Date.now() ||
      entry.control.expiresAt <= Date.now() ||
      entry.epoch !== action.controlEpoch
    )
      fail("BROWSER_CANCELLED")
    if (checks.size >= 64) fail("BROWSER_CAPACITY")
    const allowed = await new Promise<boolean>((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(
        () => {
          checks.delete(id)
          resolve(false)
        },
        Math.min(2_000, Math.max(1, action.deadline - Date.now())),
      )
      checks.set(id, (result) => {
        clearTimeout(timer)
        checks.delete(id)
        resolve(result)
      })
      port.postMessage({
        type: "check",
        id,
        actionID: action.actionID,
        controlID: action.controlID,
        digest: hash(action),
      })
    })
    if (!allowed || !alive || entry.stopped || entry.action !== action || action.deadline <= Date.now())
      fail("BROWSER_SCOPE_DENIED")
  }
  const fileCheck = async (entry: Entry, request: Extract<BrowserProtocol.Request, { type: "file.confirm" }>) => {
    if (
      !alive ||
      entry.stopped ||
      entry.action ||
      entry.queue ||
      entry.control.expiresAt <= Date.now() ||
      request.command.expiresAt <= Date.now() ||
      request.command.expiresAt > request.control.expiresAt ||
      request.command.expectedControlRevision !== request.control.revision ||
      hash(request.control) !== request.preview.controlHash ||
      hash(request.control.scope) !== request.preview.scopeHash
    )
      fail("BROWSER_STALE_TARGET")
    const allowed = await new Promise<boolean>((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        checks.delete(id)
        resolve(false)
      }, 2000)
      checks.set(id, (value) => {
        clearTimeout(timer)
        checks.delete(id)
        resolve(value)
      })
      port.postMessage({
        type: "file.check",
        id,
        confirmID: request.id,
        controlID: request.control.controlID,
        previewHash: hash(request.preview),
        commandHash: hash(request.command),
      })
    })
    if (!allowed || !alive || entry.stopped || request.command.expiresAt <= Date.now()) fail("BROWSER_SCOPE_DENIED")
  }
  const sameOrigin = (entry: Entry, value: string) => {
    if (entry.control.profile === BrowserSchema.PUBLIC_READONLY_PROFILE || entry.control.profile === BrowserSchema.PUBLIC_INTERACTION_PROFILE || entry.control.profile === BrowserSchema.API_POST_PROFILE) {
      if (Buffer.byteLength(value) > 2048 || !URL.canParse(value)) return false
      const url = new URL(value)
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        entry.control.approvedOrigins.includes(url.origin)
      )
    }
    if (
      value.length > 2048 ||
      !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?(?:[/?#]|$)/.test(value) ||
      !URL.canParse(value)
    )
      return false
    const url = new URL(value)
    return (
      url.protocol === "http:" &&
      !url.username &&
      !url.password &&
      url.origin === entry.control.origin &&
      ["127.0.0.1", "[::1]"].includes(url.hostname)
    )
  }
  const initialize = async (entry: Entry) => {
    const partition = session.fromPartition(`dac-managed-${randomUUID()}`, { cache: false })
    entry.session = partition
    partition.setPermissionCheckHandler(() => false)
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    partition.on("will-download", (event, item) => {
      event.preventDefault()
      item.cancel()
    })
    if (entry.control.profile === BrowserSchema.PUBLIC_READONLY_PROFILE || entry.control.profile === BrowserSchema.PUBLIC_INTERACTION_PROFILE || entry.control.profile === BrowserSchema.API_POST_PROFILE) {
      entry.network = await createManagedBrowserNetwork({
        partition,
        approvedOrigins: entry.control.approvedOrigins,
        resolverPolicy: entry.control.resolverPolicy,
        ...(entry.control.profile === BrowserSchema.PUBLIC_INTERACTION_PROFILE ? {
          interaction: { pageMode: entry.control.pageMode, postTargets: entry.control.postTargets },
          submitting: () => entry.publicLeaf ? { identity: entry.publicLeaf, frameID: entry.publicLeaf.command.frameID,
            ...entry.publicLeaf.navigation } : undefined,
        } : {}),
        ...(entry.control.profile === BrowserSchema.API_POST_PROFILE ? {
          interaction: { pageMode: entry.control.pageMode, postTargets: [] },
          apiPost: { origin: entry.control.origin, targets: entry.control.apiPostTargets,
            command: () => entry.action?.command.type === "api.post" ? entry.action.command : undefined },
        } : {}),
        actionIdentity: () => entry.action,
        actionDeadline: () => entry.action?.deadline,
        activeContentsID: () => entry.activeContentsID,
        currentPermit: async () => {
          const action = entry.action
          if (!action) return false
          await permit(entry, action)
          return true
        },
        onDocumentEvent: (contentsID, method, params) => {
          const tab = [...entry.tabs.values()].find(
            (tab) => !tab.contents.isDestroyed() && tab.contents.id === contentsID,
          )
          if (tab) documentEvent(tab, method, params)
        },
      })
      if (entry.stopped) fail("BROWSER_CANCELLED")
      await createTab(entry)
      entry.activeContentsID = undefined
      entry.timer = setTimeout(() => stop(entry), Math.max(1, entry.control.expiresAt - Date.now()))
      return
    }
    // Chromium may preconnect to this broker. Only this broker connects to a destination,
    // after exact scheme/host/port and the current canonical action permit have been checked.
    const proxy = createServer(async (incoming, outgoing) => {
      const action = entry.action
      const programLeaf = entry.programLeaf
      if (
        !action ||
        action.command.type === "evaluate" ||
        (action.command.type === "program" && programLeaf?.action !== action) ||
        entry.stopped ||
        !sameOrigin(entry, incoming.url ?? "")
      ) {
        outgoing.writeHead(403)
        outgoing.end()
        return
      }
      const target = new URL(incoming.url!)
      const post =
        incoming.method === "POST" &&
        entry.control.profile === BrowserSchema.INTERACTION_PROFILE &&
        ("ref" in action.command || (action.command.type === "program" && programLeaf?.action === action)) &&
        !target.search &&
        entry.control.postPaths.includes(target.pathname) &&
        ["application/x-www-form-urlencoded", "application/json", "text/plain"].includes(
          String(incoming.headers["content-type"] ?? "")
            .split(";", 1)[0]!
            .trim()
            .toLowerCase(),
        )
      const filePost =
        incoming.method === "POST" &&
        entry.control.profile === BrowserSchema.FILE_EXCHANGE_PROFILE &&
        action.command.type === "file.upload" &&
        !!entry.files &&
        !target.search &&
        entry.control.postPaths.includes(target.pathname)
      if (!["GET", "HEAD"].includes(incoming.method ?? "") && !post && !filePost) {
        outgoing.writeHead(403)
        outgoing.end()
        return
      }
      if (entry.streams.size + entry.incoming.size >= 16) {
        outgoing.writeHead(429)
        outgoing.end()
        return
      }
      try {
        await permit(entry, action)
      } catch {
        outgoing.writeHead(403)
        outgoing.end()
        return
      }
      if (
        entry.stopped ||
        entry.action !== action ||
        (action.command.type === "program" && entry.programLeaf !== programLeaf)
      ) {
        outgoing.writeHead(403)
        outgoing.end()
        return
      }
      // Validate the complete bounded body before opening an upstream request.
      const chunks: Buffer[] = []
      let bytes = 0
      entry.incoming.add(incoming)
      const bodyTimer = setTimeout(() => incoming.destroy(), Math.max(1, action.deadline - Date.now()))
      try {
        for await (const chunk of incoming) {
          const value = Buffer.from(chunk)
          if (value.length > (filePost ? MAX_FORM_BODY : post ? BrowserSchema.MAX_POST_BYTES : 0) - bytes) {
            outgoing.writeHead(413)
            outgoing.end()
            return
          }
          chunks.push(value)
          bytes += value.length
        }
        await permit(entry, action)
        if (action.command.type === "program" && entry.programLeaf !== programLeaf) fail("BROWSER_CANCELLED")
        if (filePost) await entry.files!.authorizePost(target, incoming.headers, Buffer.concat(chunks, bytes))
      } catch {
        if (!outgoing.headersSent) outgoing.writeHead(403)
        outgoing.end()
        return
      } finally {
        clearTimeout(bodyTimer)
        entry.incoming.delete(incoming)
      }
      const body = post || filePost ? Buffer.concat(chunks, bytes) : undefined
      if (action.command.type === "program") {
        const observed = programLeaf?.request
        if (
          !observed ||
          observed.consumed ||
          observed.url !== target.href ||
          observed.method !== incoming.method ||
          !observed.body.equals(body ?? Buffer.alloc(0)) ||
          frameSource(observed.frame) !== observed.source ||
          entry.programLeaf !== programLeaf
        ) {
          outgoing.writeHead(403)
          outgoing.end()
          return
        }
        // Only the original earliest document request can consume this witness. The
        // proxy never infers a navigation capability from headers or a late fetch.
        observed.consumed = true
      }
      const headers = { ...incoming.headers }
      delete headers["proxy-authorization"]
      delete headers["proxy-connection"]
      delete headers["connection"]
      delete headers["transfer-encoding"]
      if (post || filePost) headers["content-length"] = String(bytes)
      headers.host = target.host
      // Literal host and agent:false ensure neither DNS nor global proxy settings are involved.
      const upstream = request(
        {
          hostname: target.hostname.replace(/^\[|\]$/g, ""),
          port: Number(target.port || 80),
          path: target.pathname + target.search,
          method: incoming.method,
          headers,
          agent: false,
          timeout: Math.max(1, action.deadline - Date.now()),
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers)
          if (filePost) {
            response.once("end", () => (response.complete ? entry.files?.completePost() : entry.files?.failPost()))
            response.once("error", () => entry.files?.failPost())
            response.once("aborted", () => entry.files?.failPost())
          }
          response.pipe(outgoing)
        },
      )
      entry.streams.add(upstream)
      upstream.on("close", () => entry.streams.delete(upstream))
      upstream.on("timeout", () => upstream.destroy())
      upstream.on("error", () => {
        if (filePost) entry.files?.failPost()
        if (!outgoing.headersSent) outgoing.writeHead(502)
        outgoing.end()
      })
      outgoing.on("close", () => upstream.destroy())
      upstream.end(body)
    })
    entry.proxy = proxy
    proxy.on("connect", (_request, socket) => socket.destroy())
    proxy.on("upgrade", (_request, socket) => socket.destroy())
    proxy.on("clientError", (_error, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject)
      proxy.listen(0, "127.0.0.1", resolve)
    })
    const address = proxy.address()
    if (!address || typeof address === "string") fail("BROWSER_DRIVER_UNAVAILABLE")
    await partition.setProxy({
      mode: "fixed_servers",
      proxyRules: `http=127.0.0.1:${address.port};https=127.0.0.1:${address.port}`,
      proxyBypassRules: "<-loopback>",
    })
    partition.webRequest.onBeforeRequest((details, callback) => {
      if (details.url === "about:blank") {
        callback({ cancel: false })
        return
      }
      const action = entry.action
      const programLeaf = entry.programLeaf
      if (
        !action ||
        action.command.type === "evaluate" ||
        (action.command.type === "program" && programLeaf?.action !== action) ||
        entry.stopped ||
        details.webContentsId !== entry.activeContentsID ||
        !sameOrigin(entry, details.url)
      ) {
        callback({ cancel: true })
        return
      }
      if (action.command.type === "program") {
        const contents = entry.tabs.get(programLeaf!.command.tabID)?.contents
        const source = details.frame && contents && frameSource(details.frame, contents)
        if (
          !programLeaf?.navigation ||
          programLeaf.request ||
          !["mainFrame", "subFrame"].includes(details.resourceType) ||
          !contents ||
          !details.frame ||
          !source ||
          programLeaf.navigation.url !== details.url ||
          programLeaf.navigation.method !== details.method ||
          details.uploadData.length > 64 ||
          details.uploadData.some(
            (value) => value.file !== undefined || value.blobUUID !== undefined || !Buffer.isBuffer(value.bytes),
          )
        ) {
          callback({ cancel: true })
          return
        }
        const size = details.uploadData.reduce((total, value) => total + value.bytes.length, 0)
        if (size > BrowserSchema.MAX_POST_BYTES || (details.method !== "POST" && size !== 0)) {
          callback({ cancel: true })
          return
        }
        programLeaf.request = {
          url: details.url,
          method: details.method,
          body: Buffer.concat(
            details.uploadData.map((value) => value.bytes),
            size,
          ),
          frame: details.frame,
          source,
          consumed: false,
        }
      }
      void permit(entry, action).then(
        () =>
          callback({
            cancel: entry.stopped || (action.command.type === "program" && entry.programLeaf !== programLeaf),
          }),
        () => callback({ cancel: true }),
      )
    })
    if (entry.stopped) fail("BROWSER_CANCELLED")
    await createTab(entry)
    entry.activeContentsID = undefined
    entry.timer = setTimeout(() => stop(entry), Math.max(1, entry.control.expiresAt - Date.now()))
  }
  const renewInputSource = (tab: ManagedTab) => {
    if (tab.inputSource?.status === "available") tab.inputSource.release()
    if (!inputAsset) return
    tab.inputSource = observeManagedBrowserInput({ window: tab.window, asset: inputAsset,
      invalidate: () => { tab.generation++; tab.inputs?.invalidate() } })
    if (tab.inputSource.status !== "available")
      fail(tab.inputSource.reason === "observer_capacity" ? "BROWSER_CAPACITY" : "BROWSER_DRIVER_UNAVAILABLE")
  }
  const createTab = async (entry: Entry) => {
    if (entry.stopped || !entry.session) fail("BROWSER_CANCELLED")
    if (entry.tabs.size >= BrowserSchema.MAX_TABS) fail("BROWSER_CAPACITY")
    const window = entry.network
      ? await entry.network.createReadonlyWindow()
      : new BrowserWindow({
          show:
            entry.control.profile === BrowserSchema.INTERACTION_PROFILE ||
            entry.control.profile === BrowserSchema.FILE_EXCHANGE_PROFILE,
          title: `DeepAgent · ${entry.control.origin}`,
          width: 1280,
          height: 800,
          webPreferences: {
            session: entry.session,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            devTools: false,
            spellcheck: false,
            safeDialogs: true,
            backgroundThrottling: false,
            webviewTag: false,
            navigateOnDragDrop: false,
          },
        })
    const tab: ManagedTab = { tabID: randomUUID(), generation: 0, window, contents: window.webContents }
    entry.tabs.set(tab.tabID, tab)
    entry.selectedTabID = tab.tabID
    entry.activeContentsID = tab.contents.id
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")
    window.webContents.on("will-navigate", (event, url) => {
      if (!sameOrigin(entry, url)) event.preventDefault()
    })
    window.webContents.on("will-redirect", (event, url) => {
      if (!sameOrigin(entry, url)) event.preventDefault()
    })
    window.webContents.on("will-attach-webview", (event) => event.preventDefault())
    window.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame) {
        tab.generation++
        tab.inputs?.invalidate()
      }
    })
    window.webContents.on("render-process-gone", () => stop(entry))
    window.on("closed", () => {
      if (tab.inputSource?.status === "available") tab.inputSource.release()
      if (!entry.tabs.has(tab.tabID)) return
      entry.tabs.delete(tab.tabID)
      if (entry.selectedTabID === tab.tabID) entry.selectedTabID = entry.tabs.keys().next().value
      if (!entry.stopped && entry.tabs.size === 0) void stop(entry)
    })
    if (!entry.network) await window.webContents.loadURL("about:blank")
    if (entry.stopped) fail("BROWSER_CANCELLED")
    // Chromium installs its native text client with the first document. Bind
    // the source to that exact client set before exposing references.
    renewInputSource(tab)
    if (!entry.network) {
      window.webContents.debugger.attach("1.3")
      await window.webContents.debugger.sendCommand("Page.enable")
    }
    tab.clipboardPolicy = await installManagedBrowserClipboardPolicy(window.webContents, () => { void stop(entry) })
    window.once("close", () => tab.clipboardPolicy?.())
    await window.webContents.debugger.sendCommand("DOM.enable")
    await window.webContents.debugger.sendCommand("Accessibility.enable")
    const debuggerOwner = tab.contents.debugger
    tab.inputs = createManagedBrowserActions({
      send: (method, params) => tab.contents.isDestroyed()
        ? Promise.reject(new Failure("BROWSER_CANCELLED")) : debuggerOwner.sendCommand(method, params),
      current: () => (entry.action ? permit(entry, entry.action) : Promise.reject(new Failure("BROWSER_CANCELLED"))),
      generation: () => tab.generation,
      inputSource: () => {
        if (tab.inputSource?.status === "available" && tab.inputSource.healthy()) return
        // A missing source cannot authorize references using a timing-based fallback.
        void stop(entry)
        fail("BROWSER_DRIVER_UNAVAILABLE")
      },
      fail,
      dispatched: () => {
        entry.mutated = true
      },
      origin: entry.control.origin,
      ...(entry.control.profile === BrowserSchema.PUBLIC_READONLY_PROFILE || entry.control.profile === BrowserSchema.PUBLIC_INTERACTION_PROFILE || entry.control.profile === BrowserSchema.API_POST_PROFILE
        ? { approvedOrigins: entry.control.approvedOrigins }
        : {}),
    })
    if (!entry.network)
      window.webContents.debugger.on("message", (_event, method, params, sessionID) => {
        if (!sessionID) documentEvent(tab, method, params)
      })
    return tab
  }
  const run = async (
    entry: Entry,
    action: BrowserSchema.Action,
    executeID: string,
    fileRecords?: readonly { grant: BrowserFileSchema.Grant; artifact: BrowserFileSchema.Artifact }[],
  ): Promise<{ result: BrowserSchema.Result; png?: string }> => {
    entry.action = action
    entry.mutated = false
    let dispatched = false
    const timer = setTimeout(() => stop(entry), Math.max(1, action.deadline - Date.now()))
    try {
      await permit(entry, action)
      const command = action.command
      if (command.type === "tabs.list") return { result: { tabs: tabs(entry) } }
      if (command.type === "files.list") return { result: { tabs: tabs(entry) } }
      if (command.type === "tabs.create") {
        if (command.url && !sameOrigin(entry, command.url)) fail("BROWSER_NETWORK_DENIED")
        if (entry.tabs.size >= BrowserSchema.MAX_TABS) fail("BROWSER_CAPACITY")
        await permit(entry, action)
        dispatched = true
        const created = await createTab(entry)
        await entry.network?.beginAction(action)
        if (command.url) await created.contents.loadURL(command.url)
        await permit(entry, action)
        if (command.url) renewInputSource(created)
        return { result: { tabs: tabs(entry) } }
      }
      const tab = entry.tabs.get(command.tabID)
      if (!tab || tab.contents.isDestroyed() || command.generation !== tab.generation) fail("BROWSER_STALE_TARGET")
      const contents = tab.contents
      entry.activeContentsID = contents.id
      if (command.type !== "tabs.close" && command.type !== "api.post") {
        if (entry.control.profile === BrowserSchema.PUBLIC_INTERACTION_PROFILE && entry.control.pageMode === "dynamic")
          dispatched = true
        await entry.network?.beginAction(action)
      }
      if (command.type === "api.post") {
        if (!entry.network || !tab.inputs || !BrowserSchema.allowsApiPost(entry.control, command)) fail("BROWSER_SCOPE_DENIED")
        await tab.inputs.requireObservation(command)
        await permit(entry, action)
        const currentTabs = tabs(entry)
        // Reserve a durable digest receipt before disclosure, including escaped
        // command bytes and current tabs. Text is optional when both bodies are large.
        const fits = (apiPost: typeof BrowserSchema.ApiPostResult.Type) => Buffer.byteLength(CanonicalJson.stringify({
          ...action, outcome: "completed", result: { tabs: currentTabs, apiPost }, revision: action.revision + 1,
          updatedAt: Number.MAX_SAFE_INTEGER, terminalAt: Number.MAX_SAFE_INTEGER,
        }), "utf8") <= BrowserSchema.MAX_ACTION_BYTES - 256
        if (!fits({ version: 1, status: 599, contentType: "x".repeat(256), bytes: 65536, sha256: "0".repeat(64) }))
          fail("BROWSER_CAPACITY")
        const apiPost = await entry.network.postAPI(command, { identity: action, deadline: action.deadline,
          contentsID: contents.id, frameID: command.frameID }, () => {
          tab.inputs!.assertObservation(command)
          dispatched = true
        })
        await tab.inputs.requireObservation(command)
        await permit(entry, action)
        const result = fits(apiPost) ? apiPost : { version: apiPost.version, status: apiPost.status,
          contentType: apiPost.contentType, bytes: apiPost.bytes, sha256: apiPost.sha256 }
        return { result: { tabs: currentTabs, apiPost: result } }
      }
      if (command.type === "clipboard.read" || command.type === "clipboard.write") {
        if (!tab.inputs) fail("BROWSER_DRIVER_UNAVAILABLE")
        return {
          result: {
            tabs: tabs(entry),
            clipboard: await runClipboard({
              control: entry.control,
              action,
              window: tab.window,
              current: () => permit(entry, action),
              observe: () => tab.inputs!.requireObservation(command),
              dispatched: () => {
                tab.inputs!.assertObservation(command)
                dispatched = true
              },
            }),
          },
        }
      }
      if (command.type === "file.upload" || command.type === "file.download") {
        if (!tab.inputs || !fileRecords || entry.control.profile !== BrowserSchema.FILE_EXCHANGE_PROFILE)
          fail("BROWSER_SCOPE_DENIED")
        entry.files = createManagedBrowserFiles({
          action,
          control: entry.control,
          files: fileRecords,
          actions: tab.inputs,
          current: () => permit(entry, action),
          fail,
          destroyTarget: () => destroyTab(tab),
          ask: (body) =>
            new Promise<BrowserProtocol.FileLeafResponse>((resolve) => {
              if (!alive || entry.stopped || entry.action !== action || leaves.size >= 8) {
                resolve({ type: "file.leaf.response", id: "closed", error: "BROWSER_FILE_UNKNOWN" })
                return
              }
              const id = randomUUID()
              const timer = setTimeout(
                () => {
                  leaves.delete(id)
                  resolve({ type: "file.leaf.response", id, error: "BROWSER_FILE_UNKNOWN" })
                },
                Math.max(1, action.deadline - Date.now()),
              )
              leaves.set(id, (response) => {
                clearTimeout(timer)
                leaves.delete(id)
                resolve(response)
              })
              port.postMessage({
                ...body,
                type: "file.leaf",
                id,
                executeID,
                actionID: action.actionID,
                controlID: action.controlID,
                digest: hash(action),
              })
            }),
        })
        const published = await entry.files.run()
        return {
          result: {
            tabs: tabs(entry),
            files: published.map((file) => ({
              artifactID: file.artifactID,
              grantID: file.grantID,
              direction: file.direction,
              name: fileRecords.find((entry) => entry.artifact.artifactID === file.artifactID)!.grant.preview.name,
              bytes: file.bytes,
              sha256: file.sha256,
              state: file.outcome,
              nativeVerified: true,
            })),
          },
        }
      }
      if (command.type === "tabs.select") {
        await permit(entry, action)
        dispatched = true
        entry.selectedTabID = tab.tabID
        if (entry.control.profile === BrowserSchema.INTERACTION_PROFILE) tab.window.show()
        return { result: { tabs: tabs(entry) } }
      }
      if (command.type === "tabs.close") {
        await permit(entry, action)
        dispatched = true
        // Remove the exact tab before destroying it so this explicit close does not
        // turn the Control into an implicit global cancellation.
        entry.tabs.delete(tab.tabID)
        if (entry.selectedTabID === tab.tabID) entry.selectedTabID = entry.tabs.keys().next().value
        if (!(await destroyTab(tab))) fail("BROWSER_UNKNOWN")
        if (entry.control.profile === BrowserSchema.PUBLIC_INTERACTION_PROFILE) entry.activeContentsID = undefined
        await permit(entry, action)
        return { result: { tabs: tabs(entry) } }
      }
      if (["back", "forward", "reload"].includes(command.type)) {
        const offset = command.type === "back" ? -1 : command.type === "forward" ? 1 : 0
        const destination = offset
          ? contents.navigationHistory.getEntryAtIndex(contents.navigationHistory.getActiveIndex() + offset)
          : undefined
        if (offset && !destination) return { result: { tabs: tabs(entry) } }
        const url = destination?.url ?? contents.getURL()
        if (!sameOrigin(entry, url)) fail("BROWSER_NETWORK_DENIED")
        await permit(entry, action)
        dispatched = true
        await navigateTab(
          contents,
          () => (offset ? contents.navigationHistory.goToOffset(offset) : contents.reload()),
          action.deadline,
        )
        await permit(entry, action)
        if (!sameOrigin(entry, contents.getURL())) fail("BROWSER_UNKNOWN")
        renewInputSource(tab)
        return { result: { tabs: tabs(entry) } }
      }
      if (command.type === "stop") {
        await permit(entry, action)
        dispatched = true
        contents.stop()
        tab.inputs?.invalidate()
        await permit(entry, action)
        return { result: { tabs: tabs(entry) } }
      }
      if (command.type === "navigate") {
        if (!sameOrigin(entry, command.url)) fail("BROWSER_NETWORK_DENIED")
        await permit(entry, action)
        dispatched = true
        await contents.loadURL(command.url)
        await permit(entry, action)
        if (!sameOrigin(entry, contents.getURL())) fail("BROWSER_UNKNOWN")
        renewInputSource(tab)
        return { result: { tabs: tabs(entry) } }
      }
      if (command.type === "frames.list") {
        if (!tab.inputs) fail("BROWSER_DRIVER_UNAVAILABLE")
        return { result: { tabs: tabs(entry), frames: await tab.inputs.frames() } }
      }
      if (command.type === "snapshot") {
        if (!tab.inputs) fail("BROWSER_DRIVER_UNAVAILABLE")
        return { result: { tabs: tabs(entry), ...(await tab.inputs.snapshot(command)) } }
      }
      if (command.type === "evaluate") {
        if (!BrowserSchema.allowsScript(entry.control, command)) fail("BROWSER_SCOPE_DENIED")
        if (!tab.inputs) fail("BROWSER_DRIVER_UNAVAILABLE")
        return { result: { tabs: tabs(entry), scriptResultJSON: await tab.inputs.evaluate(command, action.deadline) } }
      }
      if (command.type === "program") {
        if (!BrowserSchema.allowsProgram(entry.control, command)) fail("BROWSER_SCOPE_DENIED")
        if (!tab.inputs) fail("BROWSER_DRIVER_UNAVAILABLE")
        try {
          const program = await tab.inputs.program(entry.control, command, action.deadline, async (step) => {
            const navigation = (step.type === "click" || step.type === "press") && step.waitForNavigation === true
            if (!navigation) {
              await tab.inputs!.execute(step)
              return
            }
            // The strict planner compiler permits this only as the last click/Enter. It
            // opens no transport during planning, earlier leaves or any later action.
            let finish: (() => void) | undefined
            let reject: ((error: Error) => void) | undefined
            const loaded = new Promise<void>((resolve, failed) => {
              finish = resolve
              reject = failed
            })
            let navigated = false
            const leaf: NonNullable<Entry["programLeaf"]> = { action, command: step }
            const onFrame = (
              method: string,
              params: { frame?: { id?: string }; frameId?: string; url?: string; reason?: string },
            ) => {
              if (
                method === "Page.frameRequestedNavigation" &&
                params.frameId === step.frameID &&
                !leaf.navigation &&
                params.url &&
                sameOrigin(entry, params.url) &&
                ["anchorClick", "formSubmissionGet", "formSubmissionPost"].includes(params.reason ?? "")
              )
                leaf.navigation = { url: params.url, method: params.reason === "formSubmissionPost" ? "POST" : "GET" }
              if (method === "Page.frameNavigated" && params.frame?.id === step.frameID) navigated = true
              if (method === "Page.navigatedWithinDocument" && params.frameId === step.frameID) finish?.()
              if (method === "Page.frameStoppedLoading" && params.frameId === step.frameID && navigated) finish?.()
            }
            const onFailure = (_event: unknown, _code: number, _description: string, _url: string, main: boolean) => {
              if (main) reject?.(new Failure("BROWSER_UNKNOWN"))
            }
            const timeout = setTimeout(
              () => reject?.(new Failure("BROWSER_UNKNOWN")),
              Math.max(1, action.deadline - Date.now()),
            )
            void loaded.catch(() => undefined)
            entry.programLeaf = leaf
            tab.navigation = onFrame
            contents.on("did-fail-load", onFailure)
            try {
              await tab.inputs!.execute(step)
              await loaded
              if (!sameOrigin(entry, contents.getURL())) fail("BROWSER_UNKNOWN")
              await permit(entry, action)
              // An admitted navigation is an explicit document boundary. An
              // arbitrary native view replacement never silently adopts refs.
              renewInputSource(tab)
              if (
                !(await tab.inputs!.frames()).some((frame) => frame.frameID === step.frameID) ||
                !sameOrigin(entry, contents.getURL())
              )
                fail("BROWSER_UNKNOWN")
              await permit(entry, action)
            } finally {
              if (entry.programLeaf === leaf) entry.programLeaf = undefined
              clearTimeout(timeout)
              if (tab.navigation === onFrame) tab.navigation = undefined
              contents.removeListener("did-fail-load", onFailure)
            }
          })
          return { result: { tabs: tabs(entry), program } }
        } finally {
          await tab.inputs.release()
        }
      }
      if ("ref" in command) {
        if (
          entry.control.profile !== BrowserSchema.INTERACTION_PROFILE &&
          entry.control.profile !== BrowserSchema.FILE_EXCHANGE_PROFILE && entry.control.profile !== BrowserSchema.PUBLIC_INTERACTION_PROFILE
        )
          fail("BROWSER_SCOPE_DENIED")
        if (!tab.inputs) fail("BROWSER_DRIVER_UNAVAILABLE")
        const navigation = (command.type === "click" || command.type === "press") && command.waitForNavigation
        let finish: (() => void) | undefined
        let reject: ((error: Error) => void) | undefined
        const loaded = new Promise<void>((resolve, failed) => {
          finish = resolve
          reject = failed
        })
        let navigated = false
        const publicLeaf: NonNullable<Entry["publicLeaf"]> = { action, command }
        const onFrame = (method: string, params: { frame?: { id?: string }; frameId?: string; url?: string; reason?: string }) => {
          if (method === "Page.frameRequestedNavigation" && params.frameId === command.frameID &&
            !publicLeaf.navigation && params.url && sameOrigin(entry, params.url) &&
            ["anchorClick", "formSubmissionGet", "formSubmissionPost"].includes(params.reason ?? ""))
            publicLeaf.navigation = { url: params.url, method: params.reason === "formSubmissionPost" ? "POST" : "GET" }
          if (method === "Page.frameNavigated" && params.frame?.id === command.frameID) navigated = true
          if (method === "Page.navigatedWithinDocument" && params.frameId === command.frameID) finish?.()
          if (method === "Page.frameStoppedLoading" && params.frameId === command.frameID && navigated) finish?.()
        }
        const onFailure = (_event: unknown, _code: number, _description: string, _url: string, main: boolean) => {
          if (main) reject?.(new Failure("BROWSER_UNKNOWN"))
        }
        const timeout = navigation
          ? setTimeout(() => reject?.(new Failure("BROWSER_UNKNOWN")), Math.max(1, action.deadline - Date.now()))
          : undefined
        void loaded.catch(() => undefined)
        if (navigation) {
          if (entry.control.profile === BrowserSchema.PUBLIC_INTERACTION_PROFILE) entry.publicLeaf = publicLeaf
          tab.navigation = onFrame
          contents.on("did-fail-load", onFailure)
        }
        try {
          await tab.inputs.execute(command)
          if (navigation) {
            await loaded
            if (!sameOrigin(entry, contents.getURL())) fail("BROWSER_UNKNOWN")
            await permit(entry, action)
            renewInputSource(tab)
            if (
              !(await tab.inputs.frames()).some((frame) => frame.frameID === command.frameID) ||
              !sameOrigin(entry, contents.getURL())
            )
              fail("BROWSER_UNKNOWN")
          }
          await permit(entry, action)
          return { result: { tabs: tabs(entry) } }
        } finally {
          if (entry.publicLeaf === publicLeaf) entry.publicLeaf = undefined
          clearTimeout(timeout)
          if (tab.navigation === onFrame) tab.navigation = undefined
          contents.removeListener("did-fail-load", onFailure)
          await tab.inputs.release()
        }
      }
      await permit(entry, action)
      dispatched = true
      const layout = (await contents.debugger.sendCommand("Page.getLayoutMetrics")) as {
        cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
      }
      const viewport = layout.cssVisualViewport
      if (
        !viewport ||
        ![viewport.clientWidth, viewport.clientHeight, viewport.pageX, viewport.pageY].every(Number.isFinite) ||
        viewport.clientWidth < 1 ||
        viewport.clientHeight < 1 ||
        viewport.clientWidth * viewport.clientHeight > BrowserSchema.MAX_PIXELS
      )
        fail("BROWSER_OUTPUT_LIMIT")
      await permit(entry, action)
      const captured = (await contents.debugger.sendCommand("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        clip: {
          x: viewport.pageX,
          y: viewport.pageY,
          width: viewport.clientWidth,
          height: viewport.clientHeight,
          scale: 1,
        },
      })) as { data: string }
      await permit(entry, action)
      if (tab.generation !== command.generation) fail("BROWSER_STALE_TARGET")
      if (typeof captured.data !== "string" || captured.data.length > Math.ceil(BrowserSchema.MAX_PNG_BYTES / 3) * 4)
        fail("BROWSER_OUTPUT_LIMIT")
      const png = Buffer.from(captured.data, "base64")
      if (
        png.length < 24 ||
        png.length > BrowserSchema.MAX_PNG_BYTES ||
        !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        fail("BROWSER_OUTPUT_LIMIT")
      const width = png.readUInt32BE(16),
        height = png.readUInt32BE(20)
      if (!width || !height || width * height > BrowserSchema.MAX_PIXELS) fail("BROWSER_OUTPUT_LIMIT")
      return {
        result: {
          tabs: tabs(entry),
          image: {
            mime: "image/png",
            hash: createHash("sha256").update(png).digest("hex"),
            bytes: png.length,
            width,
            height,
          },
        },
        png: captured.data,
      }
    } catch (error) {
      if (dispatched || entry.mutated) fail("BROWSER_UNKNOWN")
      throw error
    } finally {
      clearTimeout(timer)
      const networkStopped = !entry.network || (await entry.network.finishAction(action))
      const filesStopped = !entry.files || (await entry.files.close())
      entry.files = undefined
      entry.action = undefined
      entry.programLeaf = undefined
      entry.publicLeaf = undefined
      entry.activeContentsID = undefined
      for (const stream of entry.streams) stream.destroy()
      entry.streams.clear()
      if (!networkStopped || !filesStopped) {
        await stop(entry)
        fail("BROWSER_UNKNOWN")
      }
    }
  }
  const dispatch = async (message: BrowserProtocol.Request): Promise<BrowserProtocol.Response> => {
    const control = message.control
    if (!alive || control.hostID !== hostID || control.hostIncarnation !== hostIncarnation)
      fail("BROWSER_HOST_UNAVAILABLE")
    if (message.type === "create") {
      if (
        controls.has(control.controlID) ||
        controls.size >= BrowserSchema.MAX_CONTROLS ||
        [...controls.values()].filter((entry) => !entry.confirmed).length >= BrowserSchema.MAX_ACTIVE_CONTROLS ||
        control.state !== "creating" ||
        control.epoch !== 1 ||
        control.expiresAt <= Date.now()
      )
        fail("BROWSER_CAPACITY")
      const entry: Entry = {
        control,
        descriptor: immutable(control),
        stopped: false,
        confirmed: false,
        onStopped: () => {
          if (alive)
            port.postMessage({
              type: "closed",
              controlID: control.controlID,
              resourceID: control.resourceID,
              hostIncarnation,
            })
        },
        tabs: new Map(),
        epoch: 1,
        streams: new Set(),
        incoming: new Set(),
        mutated: false,
        queue: 0,
        chain: Promise.resolve(),
        seen: new Set(),
      }
      controls.set(control.controlID, entry)
      try {
        await initialize(entry)
      } catch (error) {
        await stop(entry)
        throw error
      }
      return { type: "response", id: message.id }
    }
    const entry = controls.get(control.controlID)
    if (!entry || entry.descriptor !== immutable(control)) fail("BROWSER_AUTHORITY_REQUIRED")
    if (message.type === "cancel") {
      // Captured old action cancellation and explicit epoch-advancing Control cancellation both
      // close only this exact private resource, never a replacement with the same public ID.
      if (control.epoch !== entry.epoch && control.epoch !== entry.epoch + 1) fail("BROWSER_STALE_TARGET")
      const stopped = await stop(entry)
      return { type: "response", id: message.id, stopped }
    }
    if (message.type === "file.confirm") {
      if (control.profile !== BrowserSchema.FILE_EXCHANGE_PROFILE || entry.action || entry.queue)
        fail("BROWSER_CONFLICT")
      entry.confirmations ??= new Map()
      const prior = entry.confirmations.get(message.command.requestID)
      if (prior) {
        if (prior.commandHash !== hash(message.command) || prior.previewHash !== hash(message.preview))
          fail("BROWSER_CONFLICT")
        return { type: "response", id: message.id, confirmation: await prior.value }
      }
      if (entry.confirming) fail("BROWSER_CONFLICT")
      if (entry.confirmations.size >= 64) fail("BROWSER_CAPACITY")
      const operation = (async () => {
        await fileCheck(entry, message)
        const tab = entry.tabs.values().next().value
        if (!tab || tab.window.isDestroyed() || control.epoch !== entry.epoch) fail("BROWSER_STALE_TARGET")
        const owned = new AbortController()
        entry.confirming = { controller: owned, commandHash: hash(message.command) }
        const timer = setTimeout(
          () => owned.abort(),
          Math.max(1, Math.min(control.expiresAt, message.command.expiresAt) - Date.now()),
        )
        try {
          tab.window.show()
          const preview = message.preview
          const selection = await dialog.showMessageBox(tab.window, {
            type: "warning",
            buttons: ["Cancel", "Allow once"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            signal: owned.signal,
            title: "DeepAgent · File exchange",
            message:
              preview.direction === "upload"
                ? "Send this project file once?"
                : "Save this download as a new project file?",
            detail: `${control.scope.directory}\n${preview.relative}\n${preview.direction === "upload" ? `${preview.bytes} bytes · SHA-256 ${preview.sha256}\n${control.origin}${preview.targetPath}` : `${preview.targetURL}\nUp to ${preview.maxBytes} bytes · Existing files will not be replaced`}\nApproval expires: ${new Date(message.command.expiresAt).toISOString()}`,
          })
          if (selection.response !== 1 || owned.signal.aborted) fail("BROWSER_SCOPE_DENIED")
          await fileCheck(entry, message)
          const confirmedAt = Date.now()
          return {
            previewHash: hash(preview),
            commandHash: hash(message.command),
            confirmedAt,
            confirmationHash: hash([
              "dac.browser.native-file-confirm.v1",
              hostIncarnation,
              preview,
              message.command,
              confirmedAt,
              randomUUID(),
            ]),
          }
        } finally {
          clearTimeout(timer)
          if (entry.confirming?.controller === owned) entry.confirming = undefined
        }
      })()
      entry.confirmations.set(message.command.requestID, {
        previewHash: hash(message.preview),
        commandHash: hash(message.command),
        value: operation,
      })
      return { type: "response", id: message.id, confirmation: await operation }
    }
    const action = message.action
    if (entry.confirming) fail("BROWSER_CONFLICT")
    if (entry.stopped) fail("BROWSER_CANCELLED")
    if (
      control.state !== "active" ||
      control.cancel ||
      control.epoch !== entry.epoch ||
      action.controlID !== control.controlID ||
      action.resourceID !== control.resourceID ||
      action.hostIncarnation !== hostIncarnation ||
      action.controlEpoch !== entry.epoch ||
      action.policyRevision !== control.policyRevision ||
      action.sessionID !== control.scope.sessionID ||
      action.outcome !== "pending" ||
      action.deadline <= Date.now() ||
      action.deadline > Math.min(action.createdAt + BrowserSchema.MAX_TIMEOUT_MS, control.expiresAt) ||
      action.revision !== 1 ||
      action.commandDigest !== hash(action.command)
    )
      fail("BROWSER_AUTHORITY_REQUIRED")
    if (entry.seen.has(action.actionID) || entry.seen.size >= BrowserSchema.MAX_ACTIONS) fail("BROWSER_UNKNOWN")
    const queued = entry.queue > 0
    if (entry.queue >= BrowserSchema.MAX_WAITING + 1 || (queued && waiting >= BrowserSchema.MAX_WAITING))
      fail("BROWSER_CAPACITY")
    entry.seen.add(action.actionID)
    entry.queue++
    if (queued) waiting++
    const operation = entry.chain.then(() => {
      if (queued) waiting--
      return run(entry, action, message.id, message.files)
    })
    entry.chain = operation.then(
      () => undefined,
      () => undefined,
    )
    try {
      return { type: "response", id: message.id, ...(await operation) }
    } finally {
      entry.queue--
    }
  }
  port.on("message", (event) => {
    const leaf = Schema.decodeUnknownOption(BrowserProtocol.FileLeafResponse, { onExcessProperty: "error" })(event.data)
    if (Option.isSome(leaf)) {
      leaves.get(leaf.value.id)?.(leaf.value)
      return
    }
    const permission = Schema.decodeUnknownOption(BrowserProtocol.Permit, { onExcessProperty: "error" })(event.data)
    if (Option.isSome(permission)) {
      checks.get(permission.value.id)?.(permission.value.allowed)
      return
    }
    const message = Schema.decodeUnknownOption(BrowserProtocol.Request, { onExcessProperty: "error" })(event.data)
    if (Option.isNone(message)) return
    void dispatch(message.value).then(
      (value) => {
        if (alive) port.postMessage(value)
      },
      (error: unknown) => {
        if (!alive) return
        const entry = controls.get(message.value.control.controlID)
        port.postMessage({
          type: "response",
          id: message.value.id,
          error: error instanceof Failure ? error.code : "BROWSER_UNKNOWN",
          stopped: entry?.confirmed === true,
        })
      },
    )
  })
  port.on("close", close)
  port.start()
  return { hostID, hostIncarnation, close }
}

function documentEvent(
  tab: ManagedTab,
  method: string,
  params: { frame?: { id?: string }; frameId?: string; url?: string; reason?: string },
) {
  if (
    ["DOM.documentUpdated", "Page.frameDetached", "Page.frameNavigated", "Page.navigatedWithinDocument"].includes(
      method,
    )
  )
    tab.inputs?.invalidate()
  tab.navigation?.(method, params)
}

function frameSource(frame: WebFrameMain, contents?: WebContents) {
  try {
    if (contents && (contents.isDestroyed() || frame.top !== contents.mainFrame)) return undefined
    const values: Array<{ token: string; process: number; node: number; url: string }> = []
    for (let current: WebFrameMain | null = frame; current; current = current.parent) {
      if (current.detached || values.length >= 16 || Buffer.byteLength(current.url, "utf8") > 2048) return undefined
      values.push({
        token: current.frameToken,
        process: current.processId,
        node: current.frameTreeNodeId,
        url: current.url,
      })
    }
    return CanonicalJson.stringify(values)
  } catch {
    // Native frame getters can disappear between lifecycle notifications.
    return undefined
  }
}

function tabs(entry: Entry): BrowserSchema.Tab[] {
  return [...entry.tabs.values()]
    .filter((tab) => !tab.contents.isDestroyed())
    .map((tab) => ({
      tabID: tab.tabID,
      generation: tab.generation,
      url: (tab.contents.getURL() || "about:blank").slice(0, 2048),
      title: tab.contents.getTitle().slice(0, 256),
      selected: tab.tabID === entry.selectedTabID,
      canGoBack: tab.contents.navigationHistory.canGoBack(),
      canGoForward: tab.contents.navigationHistory.canGoForward(),
    }))
}
function destroyTab(tab: ManagedTab): Promise<boolean> {
  const destroyed = tab.contents.isDestroyed()
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_000)
        tab.contents.once("destroyed", () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
  void tab.inputs?.release()
  if (tab.inputSource?.status === "available") tab.inputSource.release()
  tab.clipboardPolicy?.()
  if (!tab.window.isDestroyed()) tab.window.destroy()
  return destroyed.then((confirmed) => confirmed && tab.contents.isDestroyed())
}
function navigateTab(contents: WebContents, dispatch: () => void, deadline: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      contents.removeListener("did-finish-load", loaded)
      contents.removeListener("did-navigate-in-page", inPage)
      contents.removeListener("did-fail-load", failed)
      contents.removeListener("destroyed", destroyed)
      error ? reject(error) : resolve()
    }
    const loaded = () => finish()
    const inPage = (_event: unknown, _url: string, main: boolean) => {
      if (main) finish()
    }
    const failed = (_event: unknown, _code: number, _description: string, _url: string, main: boolean) => {
      if (main) finish(new Failure("BROWSER_UNKNOWN"))
    }
    const destroyed = () => finish(new Failure("BROWSER_UNKNOWN"))
    const timer = setTimeout(() => finish(new Failure("BROWSER_UNKNOWN")), Math.max(1, deadline - Date.now()))
    contents.once("did-finish-load", loaded)
    contents.on("did-navigate-in-page", inPage)
    contents.on("did-fail-load", failed)
    contents.once("destroyed", destroyed)
    dispatch()
  })
}
function stop(entry: Entry): Promise<boolean> {
  if (entry.stopPromise) return entry.stopPromise
  entry.stopped = true
  entry.confirming?.controller.abort()
  clearTimeout(entry.timer)
  const resources = [...entry.tabs.values()]
  const filesClosed = entry.files ? entry.files.close() : Promise.resolve(true)
  if (entry.network) {
    entry.stopPromise = entry.network.close().then((confirmed) => {
      entry.confirmed = confirmed && resources.every((tab) => tab.contents.isDestroyed())
      if (entry.confirmed) entry.onStopped()
      return entry.confirmed
    })
    return entry.stopPromise
  }
  const destroyed = Promise.all(resources.map(destroyTab)).then((values) => values.every(Boolean))
  const streams = [...entry.streams].map(
    (stream) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_000)
        stream.once("close", () => {
          clearTimeout(timer)
          resolve(true)
        })
        stream.destroy()
      }),
  )
  entry.streams.clear()
  for (const incoming of entry.incoming) incoming.destroy()
  entry.incoming.clear()
  const proxy = entry.proxy
  const proxyClosed = !proxy
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_000)
        proxy.closeAllConnections()
        proxy.close(() => {
          clearTimeout(timer)
          resolve(true)
        })
      })
  const networkClosed = !entry.session
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2_000)
        void entry.session!.closeAllConnections().then(
          () => {
            clearTimeout(timer)
            resolve(true)
          },
          () => {
            clearTimeout(timer)
            resolve(false)
          },
        )
      })
  entry.stopPromise = Promise.all([destroyed, proxyClosed, networkClosed, filesClosed, ...streams]).then((values) => {
    entry.confirmed = values.every(Boolean) && resources.every((tab) => tab.contents.isDestroyed())
    if (entry.confirmed) entry.onStopped()
    return entry.confirmed
  })
  return entry.stopPromise
}
