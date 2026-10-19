import http from "node:http"
import https from "node:https"
import tls from "node:tls"
import net from "node:net"
import dns from "node:dns"
import events from "node:events"
import zlib from "node:zlib"
import { createHash } from "node:crypto"
import { BrowserWindow, webContents } from "electron"
import type { Session, WebFrameMain } from "electron"
import { BrowserDNSMessage } from "./managed-browser-dns-message"
import { captureManagedBrowserAPIRequest, summarizeManagedBrowserAPIResponse } from "./managed-browser-api"
import type { ManagedBrowserAPIRequest, ManagedBrowserAPITarget } from "./managed-browser-api"
import { capturePublicBrowserPost, allowsPublicBrowserPostContentType, matchesPublicBrowserPost } from "./managed-browser-public-policy"

const originals = [http, https, tls, net, zlib, http.Agent.prototype, https.Agent.prototype,
  http.ClientRequest.prototype, http.OutgoingMessage.prototype, http.IncomingMessage.prototype,
  net.Socket.prototype, tls.TLSSocket.prototype, dns.promises.Resolver.prototype, events.EventEmitter.prototype]
const descriptors = originals.map((value) => Object.getOwnPropertyDescriptors(value))
const request = { http: http.request, https: https.request }
const constructors = { resolver: dns.promises.Resolver, plain: http.Agent, secure: https.Agent }
const connectTLS = tls.connect
const roots = tls.getCACertificates
const setServers = dns.setServers
const proxyKeys = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY",
  "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_OPTIONS", "NODE_DEBUG", "NODE_DEBUG_NATIVE"] as const
const stamp = () => JSON.stringify([proxyKeys.map((key) => [key, process.env[key] ?? null]), process.execArgv, dns.getServers()])
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export class ManagedBrowserNetworkError extends Error {
  constructor(readonly code: "BROWSER_NETWORK_DENIED" | "BROWSER_CANCELLED" | "BROWSER_OUTPUT_LIMIT" | "BROWSER_DRIVER_UNAVAILABLE") { super(code) }
}
function fail(code: ManagedBrowserNetworkError["code"]): never { throw new ManagedBrowserNetworkError(code) }

function frameSource(frame: WebFrameMain) {
  try {
    const values: Array<{ token: string; process: number; node: number; url: string }> = []
    for (let current: WebFrameMain | null = frame; current; current = current.parent) {
      if (current.detached || values.length >= 16 || Buffer.byteLength(current.url, "utf8") > 2048) return undefined
      values.push({ token: current.frameToken, process: current.processId, node: current.frameTreeNodeId, url: current.url })
    }
    return JSON.stringify(values)
  } catch { return undefined }
}

/** Main-only transport. Callbacks consume the original manager's active action,
 * not authority. No caller supplies Resolver, CA, Agent or socket code. */
export async function createManagedBrowserNetwork(input: {
  partition: Session
  approvedOrigins: readonly string[]
  resolverPolicy?: "system" | "cloudflare_doh_v1" | "alidns_doh_v1"
  currentPermit: () => Promise<boolean>
  activeContentsID: () => number | undefined
  actionIdentity: () => object | undefined
  actionDeadline: () => number | undefined
  interaction?: { pageMode: "static" | "dynamic"; postTargets: readonly { origin: string; path: string }[] }
  apiPost?: { origin: string; targets: readonly ManagedBrowserAPITarget[]; command: () => ManagedBrowserAPIRequest | undefined }
  submitting?: () => { identity: object; frameID: string; url?: string; method?: string } | undefined
  onDocumentEvent?: (contentsID: number, method: string, params: { frameId?: string; parentFrameId?: string;
    frame?: { id?: string; parentId?: string; loaderId?: string; url?: string }; url?: string; reason?: string }) => void
}) {
  if (!input.approvedOrigins.length || input.approvedOrigins.length > 8 || new Set(input.approvedOrigins).size !== input.approvedOrigins.length ||
    input.approvedOrigins.reduce((total, value) => total + Buffer.byteLength(value), 0) > 4096 || input.approvedOrigins.some((value) => !publicOrigin(value)))
    fail("BROWSER_NETWORK_DENIED")
  if (typeof roots !== "function" || !originalsCurrent() || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    process.env.NODE_OPTIONS || process.env.NODE_DEBUG || process.env.NODE_DEBUG_NATIVE ||
    process.execArgv.some((value) => /^(?:--(?:require|import|loader|experimental-loader|trace-tls|tls-keylog)(?:=|$)|-r)/.test(value)))
    fail("BROWSER_DRIVER_UNAVAILABLE")
  const dnsSource = dns.getServers
  const defaultServers = dnsSource()
  const configuration = stamp()
  const certificates = roots("default").slice()
  const certificateHash = hash(certificates)
  const approved = new Set(input.approvedOrigins)
  const resolverPolicy = input.resolverPolicy ?? "system"
  if (!["system", "cloudflare_doh_v1", "alidns_doh_v1"].includes(resolverPolicy)) fail("BROWSER_DRIVER_UNAVAILABLE")
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.all_proxy || process.env.ALL_PROXY
  const bypass = process.env.no_proxy ?? process.env.NO_PROXY ?? ""
  const state = { closed: false, retired: false, lastCode: "", fetchPaused: 0, brokerDispatched: 0, fulfilled: 0, frameVerified: 0, directRoutes: 0, proxyRoutes: 0, requests: 0, bytes: 0, gateDenied: 0, handlerDenied: 0, connected: 0,
    dohRequests: 0, dohBytes: 0, maxHTTPInFlight: 0 }
  const sockets = new Set<net.Socket>()
  const requests = new Set<http.ClientRequest>()
  const responses = new Set<http.IncomingMessage>()
  const resolvers = new Set<dns.promises.Resolver>()
  const operations = new Set<Promise<unknown>>()
  const agents = new Set<http.Agent>()
  const budget = new WeakMap<object, { requests: number; bytes: number; redirects: number; dohBytes: number }>()
  const httpLeases = new Set<object>()
  const queries = new Set<AbortController>()
  const resolution: { last?: { a: string[]; aaaa: string[]; selected: string } } = {}
  const actionContents = new WeakMap<object, number>()
  const retiredActions = new WeakSet<object>()
  const apiTargets = input.apiPost?.targets.map((target) => Object.freeze({ ...target, contentTypes: Object.freeze([...target.contentTypes]) }))
  if (input.apiPost && (!approved.has(input.apiPost.origin) || !apiTargets || apiTargets.length > 8 ||
    new Set(apiTargets.map((target) => target.url)).size !== apiTargets.length)) fail("BROWSER_NETWORK_DENIED")
  const apiActions = new WeakMap<object, { digest: string; frameCurrent: () => boolean; result: Promise<ReturnType<typeof summarizeManagedBrowserAPIResponse>> }>()
  const apiWitnesses = new WeakMap<object, { capture: ReturnType<typeof captureManagedBrowserAPIRequest>; frame: WebFrameMain; source: string;
    dispatched: () => void; consumed: boolean }>()
  const apiFrames = new WeakMap<Electron.WebContents, (frameID: string) => { frame: WebFrameMain; source: string; current: () => boolean } | undefined>()
  const postWitnesses = new WeakMap<object, { url: string; body: Buffer; frame: WebFrameMain; source: string;
    submission: object; consumed: boolean }>()
  const ownedWindows = new Set<BrowserWindow>()
  const ownedContents = new WeakSet<Electron.WebContents>()
  const closing: { promise?: Promise<boolean>; details?: { results: string[]; sockets: number; requests: number;
    responses: number; resolvers: number; operations: number; sinkSockets: number; windows: number; listening: boolean;
    socketStates: Array<{ tls: boolean; closed: boolean; destroyed: boolean; connecting: boolean }>;
    requestStates: Array<{ method: string; destroyed: boolean; finished: boolean }> } } = {}
  const configurationCurrent = () => {
    if (dns.setServers !== setServers || dns.getServers !== dnsSource || stamp() !== configuration || !originalsCurrent() || hash(roots("default")) !== certificateHash) state.retired = true
    return !state.closed && !state.retired
  }
  const current = async (identity: object, deadline: number) => {
    if (retiredActions.has(identity)) fail("BROWSER_CANCELLED")
    if (!configurationCurrent()) fail(state.closed ? "BROWSER_CANCELLED" : "BROWSER_DRIVER_UNAVAILABLE")
    const contentsID = input.activeContentsID()
    const contents = contentsID ? webContents.fromId(contentsID) : undefined
    if (!contents || !ownedContents.has(contents) || contents.isDestroyed() || contents.session !== input.partition)
      fail("BROWSER_DRIVER_UNAVAILABLE")
    if (actionContents.has(identity) && actionContents.get(identity) !== contentsID) fail("BROWSER_CANCELLED")
    actionContents.set(identity, contents.id)
    if (identity !== input.actionIdentity() || deadline !== input.actionDeadline() || deadline <= Date.now() || !await input.currentPermit())
      fail("BROWSER_CANCELLED")
    if (!configurationCurrent() || retiredActions.has(identity) || contentsID !== input.activeContentsID() || contents.isDestroyed() ||
      identity !== input.actionIdentity() || deadline !== input.actionDeadline() || deadline <= Date.now())
      fail("BROWSER_CANCELLED")
  }
  const allowed = (value: string) => {
    if (Buffer.byteLength(value) > 2048 || !URL.canParse(value)) return false
    const url = new URL(value)
    return publicOrigin(url.origin) && approved.has(url.origin) && !url.username && !url.password
  }
  const observeSocket = (socket: net.Socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); return socket }
  const resolveSystem = async (hostname: string, identity: object, deadline: number, publicOnly: boolean, signal?: AbortSignal) => {
    await current(identity, deadline)
    if (net.isIP(hostname)) return publicOnly && !publicAddress(hostname) ? fail("BROWSER_NETWORK_DENIED") : hostname
    const resolver = new constructors.resolver({ timeout: Math.min(2000, Math.max(1, deadline - Date.now())), tries: 1 })
    resolver.setServers(defaultServers)
    resolvers.add(resolver)
    const timer = setTimeout(() => resolver.cancel(), Math.max(1, deadline - Date.now()))
    const abort = () => resolver.cancel()
    signal?.addEventListener("abort", abort, { once: true })
    try {
      if (signal?.aborted) fail("BROWSER_CANCELLED")
      const results = await Promise.all([resolver.resolve4(hostname), resolver.resolve6(hostname)].map((promise) => promise.catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENODATA" || error.code === "ENOTFOUND") return []
        throw error
      })))
      const addresses = [...new Set(results.flat())]
      if (!addresses.length || addresses.length > 32 || addresses.some((value) => !net.isIP(value) || (publicOnly && !publicAddress(value))))
        fail("BROWSER_NETWORK_DENIED")
      await current(identity, deadline)
      return addresses[0]!
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolver.cancel(); resolvers.delete(resolver) }
  }
  const leaseHTTP = () => {
    if (httpLeases.size >= 8) fail("BROWSER_OUTPUT_LIMIT")
    const token = {}
    httpLeases.add(token); state.maxHTTPInFlight = Math.max(state.maxHTTPInFlight, httpLeases.size)
    return () => httpLeases.delete(token)
  }
  const makeSocket = async (url: URL, address: string, identity: object, deadline: number, physicalDeadline = deadline, signal?: AbortSignal) => {
    const route = proxy && !noProxy(url.hostname, Number(url.port || 443), bypass) ? proxyURL(proxy) : undefined
    await current(identity, deadline)
    if (signal?.aborted || physicalDeadline <= Date.now()) fail("BROWSER_CANCELLED")
    if (route) state.proxyRoutes++; else state.directRoutes++
    const tunnel = route ? await (async () => {
      const hostname = route.hostname.replace(/^\[|\]$/g, "")
      const proxyAddress = await resolveSystem(hostname, identity, deadline, false, signal)
      await current(identity, deadline)
      if (signal?.aborted || physicalDeadline <= Date.now()) fail("BROWSER_CANCELLED")
      const agent = route.protocol === "https:" ? new constructors.secure({ keepAlive: false, maxCachedSessions: 0,
        ca: certificates, rejectUnauthorized: true }) : new constructors.plain({ keepAlive: false })
      agents.add(agent)
      return new Promise<net.Socket>((accept, reject) => {
        const target = `${net.isIP(address) === 6 ? `[${address}]` : address}:${url.port || 443}`
        const headers: Record<string, string> = { host: target }
        if (route.username || route.password) headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(route.username)}:${decodeURIComponent(route.password)}`).toString("base64")}`
        const upstream = request[route.protocol === "https:" ? "https" : "http"]({ hostname, port: Number(route.port || (route.protocol === "https:" ? 443 : 80)),
          method: "CONNECT", path: target, headers, agent, lookup: (_host, _options, callback) => callback(null, proxyAddress, net.isIP(proxyAddress)),
          ...(route.protocol === "https:" ? { servername: hostname, ca: certificates, rejectUnauthorized: true } : {}),
          maxHeaderSize: 8192, signal, timeout: Math.max(1, physicalDeadline - Date.now()) })
        requests.add(upstream)
        upstream.once("socket", observeSocket)
        upstream.once("close", () => { requests.delete(upstream); agent.destroy(); agents.delete(agent); reject(new ManagedBrowserNetworkError("BROWSER_CANCELLED")) })
        upstream.once("timeout", () => upstream.destroy(new ManagedBrowserNetworkError("BROWSER_CANCELLED")))
        upstream.once("error", reject)
        upstream.once("connect", (response, socket, head) => {
          // CONNECT has completed. Its socket is now explicitly owned by the TLS leaf.
          requests.delete(upstream); agent.destroy(); agents.delete(agent)
          if (response.statusCode !== 200 || head.length || !configurationCurrent()) { socket.destroy(); reject(new ManagedBrowserNetworkError("BROWSER_NETWORK_DENIED")); return }
          observeSocket(socket); accept(socket)
        })
        upstream.end()
      })
    })() : undefined
    try { await current(identity, deadline); if (signal?.aborted || physicalDeadline <= Date.now()) fail("BROWSER_CANCELLED") }
    catch (error) { tunnel?.destroy(); throw error }
    return new Promise<tls.TLSSocket>((accept, reject) => {
      const socket = observeSocket(connectTLS({ ...(tunnel ? { socket: tunnel } : { host: address, port: Number(url.port || 443) }),
        servername: url.hostname, ca: certificates, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"], minVersion: "TLSv1.2" })) as tls.TLSSocket
      const abort = () => socket.destroy(new ManagedBrowserNetworkError("BROWSER_CANCELLED"))
      signal?.addEventListener("abort", abort, { once: true })
      socket.once("close", () => signal?.removeEventListener("abort", abort))
      if (signal?.aborted) abort()
      socket.once("error", (error) => { tunnel?.destroy(); socket.destroy(); reject(error) })
      socket.once("close", () => { tunnel?.destroy(); reject(new ManagedBrowserNetworkError("BROWSER_CANCELLED")) })
      socket.setTimeout(Math.max(1, physicalDeadline - Date.now()), () => socket.destroy(new ManagedBrowserNetworkError("BROWSER_CANCELLED")))
      socket.once("secureConnect", () => {
        if (!socket.authorized || !configurationCurrent() || (!tunnel && socket.remoteAddress !== address)) {
          socket.destroy(); reject(new ManagedBrowserNetworkError("BROWSER_NETWORK_DENIED")); return
        }
        state.connected++; accept(socket)
      })
    })
  }
  const resolveTarget = async (hostname: string, identity: object, deadline: number, frameCurrent: () => boolean) => {
    if (resolverPolicy === "system") return resolveSystem(hostname, identity, deadline, true)
    await current(identity, deadline)
    if (!frameCurrent() || ![...approved].some((value) => new URL(value).hostname === hostname)) fail("BROWSER_NETWORK_DENIED")
    const allocation = budget.get(identity)!
    const cancellation = new AbortController()
    queries.add(cancellation)
    const physicalDeadline = Math.min(deadline, Date.now() + 5000)
    const timer = setTimeout(() => cancellation.abort(), Math.max(1, physicalDeadline - Date.now()))
    const exchanges = ([1, 28] as const).map(async (type) => {
      await current(identity, deadline)
      if (!frameCurrent() || cancellation.signal.aborted) fail("BROWSER_CANCELLED")
      if (++allocation.requests > 128) fail("BROWSER_OUTPUT_LIMIT")
      const release = leaseHTTP()
      const connection: { socket?: tls.TLSSocket; agent?: https.Agent; response?: http.IncomingMessage } = {}
      try {
        // The endpoint, bootstrap IP and headers are fixed Main policy, never page input.
        const url = new URL(resolverPolicy === "alidns_doh_v1"
          ? "https://dns.alidns.com/dns-query" : "https://cloudflare-dns.com/dns-query")
        connection.socket = await makeSocket(url, resolverPolicy === "alidns_doh_v1" ? "223.5.5.5" : "1.1.1.1",
          identity, deadline, physicalDeadline, cancellation.signal)
        await current(identity, deadline)
        if (!frameCurrent() || cancellation.signal.aborted) fail("BROWSER_CANCELLED")
        const message = BrowserDNSMessage.question(hostname, type)
        if (message.length > 512 || message.length > 1_048_576 - allocation.dohBytes || message.length > 33_554_432 - allocation.bytes) fail("BROWSER_OUTPUT_LIMIT")
        connection.agent = new constructors.secure({ keepAlive: false, maxCachedSessions: 0, ca: certificates })
        agents.add(connection.agent)
        connection.agent.createConnection = (_options, callback) => { callback?.(null, connection.socket!); return connection.socket! }
        connection.response = await new Promise<http.IncomingMessage>((accept, reject) => {
          const upstream = request.https({ hostname: url.hostname, port: 443, method: "POST", path: "/dns-query", agent: connection.agent,
            signal: cancellation.signal, maxHeaderSize: 8192, timeout: Math.max(1, physicalDeadline - Date.now()),
            headers: { host: url.hostname, accept: "application/dns-message", "content-type": "application/dns-message",
              "accept-encoding": "identity", "content-length": message.length, "cache-control": "no-store" } }, accept)
          requests.add(upstream)
          upstream.once("close", () => { requests.delete(upstream); reject(new ManagedBrowserNetworkError("BROWSER_CANCELLED")) })
          upstream.once("error", reject)
          upstream.once("timeout", () => upstream.destroy(new ManagedBrowserNetworkError("BROWSER_CANCELLED")))
          allocation.dohBytes += message.length; allocation.bytes += message.length; state.dohBytes += message.length; state.bytes += message.length
          state.requests++; state.dohRequests++; upstream.end(message)
        })
        const response = connection.response
        responses.add(response); response.once("close", () => responses.delete(response))
        if (response.statusCode !== 200 || String(response.headers["content-type"]).trim().toLowerCase() !== "application/dns-message" ||
          !["", "identity"].includes(String(response.headers["content-encoding"] ?? "").trim().toLowerCase())) fail("BROWSER_NETWORK_DENIED")
        const chunks: Buffer[] = []
        const size = { bytes: 0 }
        for await (const chunk of response) {
          await current(identity, deadline)
          if (!frameCurrent() || cancellation.signal.aborted) fail("BROWSER_CANCELLED")
          const value = Buffer.from(chunk)
          if (value.length > 65535 - size.bytes || value.length > 1_048_576 - allocation.dohBytes || value.length > 33_554_432 - allocation.bytes) fail("BROWSER_OUTPUT_LIMIT")
          chunks.push(value); size.bytes += value.length; allocation.dohBytes += value.length; allocation.bytes += value.length
          state.dohBytes += value.length; state.bytes += value.length
        }
        await current(identity, deadline)
        if (!frameCurrent() || cancellation.signal.aborted) fail("BROWSER_CANCELLED")
        return BrowserDNSMessage.response(Buffer.concat(chunks, size.bytes), hostname, type)
      } catch (error) {
        if (error instanceof ManagedBrowserNetworkError) throw error
        fail(cancellation.signal.aborted ? "BROWSER_CANCELLED" : "BROWSER_NETWORK_DENIED")
      } finally {
        connection.response?.destroy(); connection.socket?.destroy(); connection.agent?.destroy()
        if (connection.agent) agents.delete(connection.agent)
        release()
      }
    })
    try {
      const results = await Promise.all(exchanges).catch(async (error: unknown) => {
        cancellation.abort(); await Promise.allSettled(exchanges); throw error
      })
      const addresses = [...new Set(results.flatMap((result) => result.addresses))]
      if (!addresses.length || addresses.length > 32 || new Set(results.flatMap((result) => result.allAddresses)).size > 32 ||
        results.some((result) => result.allAddresses.some((value) => !publicAddress(value)))) fail("BROWSER_NETWORK_DENIED")
      await current(identity, deadline)
      if (!frameCurrent()) fail("BROWSER_CANCELLED")
      resolution.last = { a: results[0]!.addresses, aaaa: results[1]!.addresses, selected: addresses[0]! }
      return addresses[0]!
    } finally { clearTimeout(timer); cancellation.abort(); queries.delete(cancellation) }
  }
  const perform = async (initial: Request, source: { identity: object; deadline: number; contentsID: number; frameID: string; frameCurrent: () => boolean; apiToken?: object }) => {
    const identity = source.identity
    const deadline = source.deadline
    if (source.contentsID !== input.activeContentsID()) fail("BROWSER_NETWORK_DENIED")
    await current(identity, deadline)
    const contents = webContents.fromId(source.contentsID)
    if (!contents || !contents.debugger.isAttached() || !source.frameCurrent()) fail("BROWSER_DRIVER_UNAVAILABLE")
    state.frameVerified++
    await current(identity, deadline)
    const api = source.apiToken ? apiWitnesses.get(source.apiToken) : undefined
    const post = initial.method === "POST" && (input.interaction !== undefined || api !== undefined)
    if (!allowed(initial.url) || !["GET", "HEAD"].includes(initial.method) && !post ||
      !post && initial.body !== null) fail("BROWSER_NETWORK_DENIED")
    const witness = post && !api ? postWitnesses.get(identity) : undefined
    const postBody = post ? Buffer.from(await initial.arrayBuffer()) : undefined
    if (api && (api.consumed || api.capture.url !== initial.url || api.capture.contentType !== initial.headers.get("content-type") ||
      !postBody || !api.capture.body.equals(postBody) || frameSource(api.frame) !== api.source)) fail("BROWSER_NETWORK_DENIED")
    if (post && !api && (!witness || witness.consumed || witness.url !== initial.url ||
      witness.submission !== input.submitting?.()?.identity || frameSource(witness.frame) !== witness.source ||
      !postBody || !witness.body.equals(postBody) || !allowsPublicBrowserPostContentType(initial.headers.get("content-type") ?? "")))
      fail("BROWSER_NETWORK_DENIED")
    if (witness) witness.consumed = true
    if (api) api.consumed = true
    if (operations.size > 8) fail("BROWSER_OUTPUT_LIMIT")
    const allocation = budget.get(identity) ?? { requests: 0, bytes: 0, redirects: 0, dohBytes: 0 }
    budget.set(identity, allocation)
    if (++allocation.requests > 128) fail("BROWSER_OUTPUT_LIMIT")
    const url = new URL(initial.url)
    const address = await resolveTarget(url.hostname, identity, deadline, source.frameCurrent)
    if (!source.frameCurrent()) fail("BROWSER_CANCELLED")
    const release = leaseHTTP()
    try {
    const socket = await makeSocket(url, address, identity, deadline)
    const agent = new constructors.secure({ keepAlive: false, maxCachedSessions: 0, ca: certificates })
    agents.add(agent)
    try {
      await current(identity, deadline)
      if (!source.frameCurrent()) fail("BROWSER_CANCELLED")
      if (postBody) {
        if (postBody.length > 33_554_432 - allocation.bytes) fail("BROWSER_OUTPUT_LIMIT")
        allocation.bytes += postBody.length
        state.bytes += postBody.length
      }
      // This private Agent consumes only the already verified, IP-pinned socket.
      agent.createConnection = (_options, callback) => { callback?.(null, socket); return socket }
      const response = await new Promise<http.IncomingMessage>((accept, reject) => {
        const headers: Record<string, string> = { host: url.host, "accept-encoding": "identity" }
        for (const key of ["accept", "accept-language", "user-agent", "range", "if-none-match", "if-modified-since"]) {
          const value = initial.headers.get(key)
          if (value !== null) headers[key] = value
        }
        if (postBody && (witness || api)) {
          headers["content-type"] = initial.headers.get("content-type")!
          headers["content-length"] = String(postBody.length)
          headers.origin = new URL((api ?? witness)!.frame.url).origin
        }
        const upstream = request.https({ hostname: url.hostname, port: Number(url.port || 443), path: url.pathname + url.search,
          method: initial.method, headers, agent, maxHeaderSize: 16384, timeout: Math.max(1, deadline - Date.now()) }, accept)
        requests.add(upstream)
        upstream.once("close", () => { requests.delete(upstream); reject(new ManagedBrowserNetworkError("BROWSER_CANCELLED")) })
        upstream.once("error", reject)
        upstream.once("timeout", () => upstream.destroy(new ManagedBrowserNetworkError("BROWSER_CANCELLED")))
        // API disclosure is one native dispatch, never a page request or retry.
        api?.dispatched()
        state.requests++; upstream.end(postBody)
      })
      responses.add(response); response.once("close", () => responses.delete(response))
      if (api && (response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.destroy(); fail("BROWSER_NETWORK_DENIED")
      }
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        if (api || post && response.statusCode !== 303) { response.destroy(); fail("BROWSER_NETWORK_DENIED") }
        const location = response.headers.location
        response.destroy()
        if (!location || Buffer.byteLength(location) > 2048 || ++allocation.redirects > 8) fail("BROWSER_NETWORK_DENIED")
        const next = new URL(location, url)
        if (!allowed(next.href)) fail("BROWSER_NETWORK_DENIED")
        await resolveTarget(next.hostname, identity, deadline, source.frameCurrent)
        // Chromium changes the real document URL; its next intercepted hop repeats every gate.
        return new Response(null, { status: response.statusCode, headers: { location: next.href } })
      }
      if (/\battachment\b/i.test(String(response.headers["content-disposition"] ?? ""))) { response.destroy(); fail("BROWSER_NETWORK_DENIED") }
      const responseLimit = api ? 65536 : 8_388_608
      const chunks: Buffer[] = []
      let bytes = 0
      const timer = setTimeout(() => response.destroy(new ManagedBrowserNetworkError("BROWSER_CANCELLED")), Math.max(1, deadline - Date.now()))
      try {
        for await (const chunk of response) {
          await current(identity, deadline)
          if (!source.frameCurrent()) fail("BROWSER_CANCELLED")
          const value = Buffer.from(chunk)
          if (value.length > responseLimit - bytes || value.length > 33_554_432 - allocation.bytes) { response.destroy(); fail("BROWSER_OUTPUT_LIMIT") }
          chunks.push(value); bytes += value.length; allocation.bytes += value.length; state.bytes += value.length
        }
      } finally { clearTimeout(timer); response.destroy() }
      await current(identity, deadline)
      if (!source.frameCurrent()) fail("BROWSER_CANCELLED")
      const body = Buffer.concat(chunks, bytes)
      const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase()
      const decoded = encoding === "identity" || encoding === "" ? body :
        encoding === "gzip" ? zlib.gunzipSync(body, { maxOutputLength: responseLimit }) :
        encoding === "br" ? zlib.brotliDecompressSync(body, { maxOutputLength: responseLimit }) :
        encoding === "deflate" ? zlib.inflateSync(body, { maxOutputLength: responseLimit }) : fail("BROWSER_NETWORK_DENIED")
      if (decoded.length > responseLimit) fail("BROWSER_OUTPUT_LIMIT")
      if (decoded.length > bytes) {
        if (decoded.length - bytes > 33_554_432 - allocation.bytes) fail("BROWSER_OUTPUT_LIMIT")
        allocation.bytes += decoded.length - bytes; state.bytes += decoded.length - bytes
      }
      const headers = new Headers()
      for (const key of ["content-type", "content-language", "cache-control", "etag", "last-modified", "content-security-policy",
        "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "cross-origin-resource-policy",
        "cross-origin-opener-policy", "cross-origin-embedder-policy", "x-content-type-options"]) {
        const value = response.headers[key]
        if (typeof value === "string") headers.set(key, value)
      }
      headers.append("content-security-policy", input.interaction?.pageMode === "dynamic" ?
        "worker-src 'none'; object-src 'none'" : "script-src 'none'; worker-src 'none'; object-src 'none'")
      headers.set("x-dns-prefetch-control", "off")
      const status = response.statusCode ?? 502
      if (status < 200 || status > 599) fail("BROWSER_NETWORK_DENIED")
      return new Response(initial.method === "HEAD" || [204, 205, 304].includes(status) ? null : decoded, { status, headers })
    } finally { socket.destroy(); agent.destroy(); agents.delete(agent) }
    } finally { release() }
  }
  const sink = http.createServer((_request, response) => { response.writeHead(403); response.end() })
  const sinkSockets = new Set<net.Socket>()
  sink.on("connection", (socket) => { sinkSockets.add(socket); socket.once("close", () => sinkSockets.delete(socket)) })
  sink.on("connect", (_request, socket) => socket.destroy())
  sink.on("upgrade", (_request, socket) => socket.destroy())
  sink.on("clientError", (_error, socket) => socket.destroy())
  await new Promise<void>((accept, reject) => { sink.once("error", reject); sink.listen(0, "127.0.0.1", accept) })
  const address = sink.address()
  if (!address || typeof address === "string") fail("BROWSER_DRIVER_UNAVAILABLE")
  try {
    await input.partition.setProxy({ mode: "fixed_servers", proxyRules: `http=127.0.0.1:${address.port};https=127.0.0.1:${address.port}`,
      proxyBypassRules: "<-loopback>" })
    input.partition.webRequest.onBeforeRequest((details, callback) => {
      if (details.url === "about:blank") { callback({ cancel: false }); return }
      // An API action owns only its sealed Main request. Page GET/POST traffic
      // cannot borrow that action, even with the same URL and bytes.
      if (input.apiPost?.command()) { state.gateDenied++; callback({ cancel: true }); return }
      const deadline = input.actionDeadline()
      const identity = input.actionIdentity()
      const post = details.method === "POST" && input.interaction !== undefined
      if (!deadline || !identity || details.webContentsId !== input.activeContentsID() || !allowed(details.url) ||
        !["GET", "HEAD"].includes(details.method) && !post ||
        ["webSocket", "ping", "cspReport", "object"].includes(details.resourceType)) {
        state.gateDenied++; callback({ cancel: true }); return
      }
      if (post) {
        const submission = input.submitting?.()
        const source = details.frame && frameSource(details.frame)
        if (!submission || submission.url !== details.url || submission.method !== "POST" || !details.frame || !source ||
          !["mainFrame", "subFrame"].includes(details.resourceType) || postWitnesses.has(identity) ||
          !matchesPublicBrowserPost(details.url, details.frame.url, input.interaction!.postTargets)) {
          state.gateDenied++; callback({ cancel: true }); return
        }
        try {
          const body = capturePublicBrowserPost(details.uploadData, fail)
          postWitnesses.set(identity, { url: details.url, body, frame: details.frame, source,
            submission: submission.identity, consumed: false })
        } catch { state.gateDenied++; callback({ cancel: true }); return }
      }
      void current(identity, deadline).then(() => callback({ cancel: false }), (error: unknown) => { state.gateDenied++; state.lastCode = error instanceof ManagedBrowserNetworkError ? error.code : "BROWSER_NETWORK_DENIED"; callback({ cancel: true }) })
    })
  } catch (error) { state.closed = true; sink.closeAllConnections(); sink.close(); throw error }
  const createReadonlyWindow = async () => {
    if (state.closed) fail("BROWSER_CANCELLED")
    const window = new BrowserWindow({ show: input.interaction?.pageMode === "static", width: 1280, height: 800,
      title: input.interaction ? "DeepAgent · Public interaction" : "DeepAgent · Public read-only",
      webPreferences: { session: input.partition, javascript: input.interaction?.pageMode === "dynamic", sandbox: true, contextIsolation: true,
        nodeIntegration: false, webviewTag: false, plugins: false, webSecurity: true, allowRunningInsecureContent: false,
        navigateOnDragDrop: false, devTools: false, spellcheck: false,
        backgroundThrottling: input.interaction?.pageMode === "dynamic" } })
    ownedWindows.add(window); ownedContents.add(window.webContents)
    window.once("closed", () => ownedWindows.delete(window))
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")
    await window.webContents.loadURL("about:blank")
    if (state.closed) { window.destroy(); fail("BROWSER_CANCELLED") }
    window.webContents.debugger.attach("1.3")
    const frames = new Map<string, { parentID?: string; epoch: number; loaderID?: string; url?: string }>()
    apiFrames.set(window.webContents, (frameID) => {
      const observed = frames.get(frameID)
      const frame = window.webContents.mainFrame
      const source = frameSource(frame)
      // API v1 targets the fresh top document only. IDs alone cannot adopt an iframe.
      if (!observed || observed.parentID || !source || observed.url !== frame.url) return undefined
      return { frame, source, current: () => !window.isDestroyed() && !frame.detached &&
        window.webContents.mainFrame === frame && frames.get(frameID) === observed && frameSource(frame) === source }
    })
    window.webContents.debugger.on("message", (_event, method, params: {
      requestId?: string; frameId?: string; parentFrameId?: string; frame?: { id?: string; parentId?: string; loaderId?: string; url?: string };
      url?: string; reason?: string; resourceType?: string; request?: { url?: string; method?: string; headers?: Record<string, string>; postData?: string }
    }, sessionID: string) => {
      // Child renderer clipboard sessions do not own this target's frame/Fetch IDs.
      if (window.isDestroyed() || sessionID) return
      if (method.startsWith("Page.") || method === "DOM.documentUpdated") input.onDocumentEvent?.(window.webContents.id, method, params)
      if (method === "Page.frameAttached" && params.frameId && params.parentFrameId && frames.has(params.parentFrameId)) {
        if (frames.size < 64) frames.set(params.frameId, { parentID: params.parentFrameId, epoch: 1 })
        return
      }
      if (method === "Page.frameNavigated" && params.frame?.id && (!params.frame.parentId || frames.has(params.frame.parentId))) {
        if (frames.has(params.frame.id) || frames.size < 64) frames.set(params.frame.id, { parentID: params.frame.parentId,
          epoch: (frames.get(params.frame.id)?.epoch ?? 0) + 1, loaderID: params.frame.loaderId, url: params.frame.url })
        return
      }
      if (method === "Page.navigatedWithinDocument" && params.frameId && frames.has(params.frameId)) {
        const prior = frames.get(params.frameId)!
        frames.set(params.frameId, { ...prior, epoch: prior.epoch + 1, url: params.url }); return
      }
      if (method === "Page.frameDetached" && params.frameId) {
        const gone = new Set([params.frameId])
        for (let pass = 0; pass < 64; pass++) {
          const before = gone.size
          for (const [id, frame] of frames) if (frame.parentID && gone.has(frame.parentID)) gone.add(id)
          if (gone.size === before) break
        }
        for (const id of gone) frames.delete(id)
        return
      }
      if (method !== "Fetch.requestPaused" || !params.requestId) return
      state.fetchPaused++
      const id = params.requestId
      const fulfill = async () => {
        if (input.apiPost?.command()) fail("BROWSER_NETWORK_DENIED")
        const identity = input.actionIdentity()
        const deadline = input.actionDeadline()
        const url = params.request?.url
        const method = params.request?.method
        const submission = input.submitting?.()
        const post = method === "POST" && input.interaction !== undefined &&
          params.resourceType === "Document" && params.frameId === submission?.frameID
        if (!identity || !deadline || window.webContents.id !== input.activeContentsID() || !url || !method ||
          !params.frameId || !frames.has(params.frameId) || !post && params.request?.postData ||
          !allowed(url) || !["GET", "HEAD"].includes(method) && !post ||
          ["WebSocket", "EventSource", "Ping", "CSPViolationReport", "Prefetch"].includes(params.resourceType ?? "")) fail("BROWSER_NETWORK_DENIED")
        if (operations.size >= 8) fail("BROWSER_OUTPUT_LIMIT")
        const frame = frames.get(params.frameId)!
        const ancestors: Array<{ id: string; value: typeof frame }> = []
        for (let next: string | undefined = params.frameId; next; next = frames.get(next)?.parentID) {
          const value = frames.get(next)
          if (!value || ancestors.length >= 16) fail("BROWSER_NETWORK_DENIED")
          ancestors.push({ id: next, value })
        }
        const frameCurrent = () => ancestors.every((value) => frames.get(value.id) === value.value)
        await current(identity, deadline)
        state.brokerDispatched++
        const witness = post ? postWitnesses.get(identity) : undefined
        const response = await perform(new Request(url, { method, headers: params.request?.headers,
          ...(witness ? { body: new Uint8Array(witness.body) } : {}) }),
          { identity, deadline, contentsID: window.webContents.id, frameID: params.frameId, frameCurrent })
        const body = Buffer.from(await response.arrayBuffer())
        if (body.length > 8_388_608) fail("BROWSER_OUTPUT_LIMIT")
        await current(identity, deadline)
        await window.webContents.debugger.sendCommand("Fetch.fulfillRequest", { requestId: id,
          responseCode: response.status, responseHeaders: [...response.headers].map(([name, value]) => ({ name, value })), body: body.toString("base64") })
        state.fulfilled++
      }
      const operation = fulfill().catch(async (error: unknown) => {
        state.gateDenied++; state.lastCode = error instanceof ManagedBrowserNetworkError ? error.code : "BROWSER_NETWORK_DENIED"
        // Closing destroys the debugger owner. There is no paused request left to reject then.
        if (window.isDestroyed() || !window.webContents.debugger.isAttached()) return
        await window.webContents.debugger.sendCommand("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" }).catch(() => {})
      })
      operations.add(operation)
      void operation.finally(() => operations.delete(operation)).catch(() => {})
    })
    await window.webContents.debugger.sendCommand("Page.enable")
    const tree = await window.webContents.debugger.sendCommand("Page.getFrameTree") as { frameTree?: { frame?: { id?: string; parentId?: string }; childFrames?: unknown[] } }
    const pending: unknown[] = tree.frameTree ? [tree.frameTree] : []
    while (pending.length) {
      if (frames.size >= 64) { window.destroy(); fail("BROWSER_OUTPUT_LIMIT") }
      const node = pending.pop() as { frame?: { id?: string; parentId?: string; loaderId?: string; url?: string }; childFrames?: unknown[] }
      if (node.frame?.id) frames.set(node.frame.id, { parentID: node.frame.parentId, epoch: 1,
        loaderID: node.frame.loaderId, url: node.frame.url })
      if (node.childFrames) pending.push(...node.childFrames)
    }
    if (!frames.size) { window.destroy(); fail("BROWSER_DRIVER_UNAVAILABLE") }
    await window.webContents.debugger.sendCommand("Fetch.enable", { patterns: [{ urlPattern: "http://*", requestStage: "Request" }, { urlPattern: "https://*", requestStage: "Request" }] })
    if (input.interaction?.pageMode === "dynamic") await window.webContents.debugger.sendCommand("Page.setWebLifecycleState", { state: "frozen" })
    return window
  }
  const postAPI = (request: ManagedBrowserAPIRequest, source: { identity: object; deadline: number; contentsID: number; frameID: string }, dispatched: () => void) => {
    const command = input.apiPost?.command()
    if (!input.apiPost || !apiTargets || !command || hash(command) !== hash(request)) fail("BROWSER_NETWORK_DENIED")
    const capture = captureManagedBrowserAPIRequest(request, apiTargets, input.apiPost.origin, () => fail("BROWSER_NETWORK_DENIED"))
    const digest = hash([source.contentsID, source.frameID, capture.url, capture.contentType, capture.bytes, capture.sha256])
    const prior = apiActions.get(source.identity)
    if (prior) {
      if (prior.digest !== digest) fail("BROWSER_NETWORK_DENIED")
      return prior.result.then(async (result) => {
        await current(source.identity, source.deadline)
        if (!prior.frameCurrent()) fail("BROWSER_CANCELLED")
        return result
      })
    }
    const contents = webContents.fromId(source.contentsID)
    if (!contents || !ownedContents.has(contents) || source.contentsID !== input.activeContentsID()) fail("BROWSER_NETWORK_DENIED")
    const observed = apiFrames.get(contents)?.(source.frameID)
    if (!observed || !observed.current() || new URL(observed.frame.url).origin !== input.apiPost.origin) fail("BROWSER_NETWORK_DENIED")
    const operation = (async () => {
      await current(source.identity, source.deadline)
      if (!observed.current()) fail("BROWSER_CANCELLED")
      const token = {}
      apiWitnesses.set(token, { capture, frame: observed.frame, source: observed.source, dispatched, consumed: false })
      try {
        const response = await perform(new Request(capture.url, { method: "POST", headers: { "content-type": capture.contentType },
          body: new Uint8Array(capture.body), credentials: "omit", redirect: "manual" }),
          { ...source, frameCurrent: observed.current, apiToken: token })
        await current(source.identity, source.deadline)
        if (!observed.current()) fail("BROWSER_CANCELLED")
        return summarizeManagedBrowserAPIResponse(response.status, response.headers.get("content-type") ?? "application/octet-stream",
          Buffer.from(await response.arrayBuffer()), () => fail("BROWSER_OUTPUT_LIMIT"))
      } finally { apiWitnesses.delete(token) }
    })()
    apiActions.set(source.identity, { digest, frameCurrent: observed.current, result: operation })
    operations.add(operation)
    void operation.finally(() => operations.delete(operation)).catch(() => {})
    return operation
  }
  const beginAction = async (identity: object) => {
    if (!input.interaction || input.interaction.pageMode !== "dynamic") return
    const deadline = input.actionDeadline()
    if (!deadline || identity !== input.actionIdentity()) fail("BROWSER_CANCELLED")
    await current(identity, deadline)
    const contents = webContents.fromId(input.activeContentsID()!)
    if (!contents || !ownedContents.has(contents)) fail("BROWSER_DRIVER_UNAVAILABLE")
    const window = BrowserWindow.fromWebContents(contents)
    if (!window || !ownedWindows.has(window) || window.isDestroyed()) fail("BROWSER_DRIVER_UNAVAILABLE")
    await contents.debugger.sendCommand("Page.setWebLifecycleState", { state: "active" })
    await current(identity, deadline)
    // CDP freezing calls Chromium WasHidden; unfreezing does not call WasShown.
    // Real owned-window visibility must resume the widget before native input.
    window.show()
    contents.focus()
    await current(identity, deadline)
  }
  const finishAction = async (identity: object) => {
    if (input.actionIdentity() !== identity) return false
    if (input.interaction?.pageMode === "dynamic" && input.activeContentsID() !== undefined) {
      const deadline = input.actionDeadline()
      if (!deadline) return false
      let prior = state.fetchPaused
      let quietAt = Date.now()
      try {
        // Settle work initiated inside this action. This never creates a background
        // permission window: the same deadline/current owner gates every request.
        while (operations.size || Date.now() - quietAt < 250) {
          await current(identity, deadline)
          if (operations.size || prior !== state.fetchPaused) { prior = state.fetchPaused; quietAt = Date.now() }
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))))
        }
      } catch { return false }
      const contents = input.activeContentsID() ? webContents.fromId(input.activeContentsID()!) : undefined
      if (!contents || !ownedContents.has(contents) || contents.isDestroyed()) return false
      const window = BrowserWindow.fromWebContents(contents)
      if (!window || !ownedWindows.has(window) || window.isDestroyed()) return false
      window.hide()
      try { await contents.debugger.sendCommand("Page.setWebLifecycleState", { state: "frozen" }) }
      catch { return false }
    }
    retiredActions.add(identity)
    if (state.closed) return closing.promise ?? false
    const socketClosed = [...sockets].map((socket) => new Promise<boolean>((accept) => {
      socket.once("close", () => accept(true))
      setTimeout(() => accept(false), 2000).unref()
    }))
    for (const query of queries) query.abort()
    for (const resolver of resolvers) resolver.cancel()
    for (const response of responses) response.destroy(new ManagedBrowserNetworkError("BROWSER_CANCELLED"))
    for (const request of requests) request.destroy(new ManagedBrowserNetworkError("BROWSER_CANCELLED"))
    for (const socket of sockets) socket.destroy(new ManagedBrowserNetworkError("BROWSER_CANCELLED"))
    for (const agent of agents) agent.destroy()
    const drain = async () => {
      while (operations.size) await Promise.allSettled([...operations])
    }
    const stopped = await Promise.race([Promise.allSettled([drain(), ...socketClosed]),
      new Promise<null>((accept) => setTimeout(() => accept(null), 2100).unref())])
    return stopped !== null && stopped.every((result) => result.status === "fulfilled" && result.value !== false) &&
      sockets.size === 0 && requests.size === 0 && responses.size === 0 && resolvers.size === 0 &&
      operations.size === 0 && httpLeases.size === 0 && queries.size === 0
  }
  const close = () => {
    if (closing.promise) return closing.promise
    closing.promise = (async () => {
      state.closed = true
      for (const query of queries) query.abort()
      const socketClosed = [...new Set([...sockets, ...sinkSockets])].map((socket) => new Promise<boolean>((accept) => {
        // Node marks .closed before its close event. Membership means our close observer
        // has not run yet, so wait for that event rather than accepting the flag.
        socket.once("close", () => accept(true))
        setTimeout(() => accept(false), 2000).unref()
      }))
      for (const resolver of resolvers) resolver.cancel()
      for (const response of responses) response.destroy(new ManagedBrowserNetworkError("BROWSER_CANCELLED"))
      for (const request of requests) request.destroy(new ManagedBrowserNetworkError("BROWSER_CANCELLED"))
      for (const socket of sockets) socket.destroy(new ManagedBrowserNetworkError("BROWSER_CANCELLED"))
      for (const agent of agents) agent.destroy()
      for (const socket of sinkSockets) socket.destroy()
      const closed = new Promise<boolean>((accept) => { sink.close((error) => accept(!error)); setTimeout(() => accept(false), 2000).unref() })
      const windows = [...ownedWindows].map((window) => new Promise<boolean>((accept) => {
        if (window.isDestroyed()) { accept(true); return }
        window.once("closed", () => accept(true))
        setTimeout(() => accept(false), 2000).unref()
        window.destroy()
      }))
      // A dispatched API operation rejects on intentional cancellation. Its result
      // is unknown, but successful custody cleanup is proved by joining settlement
      // and the resource census below, not by converting that rejection to failure.
      const drain = async () => {
        while (operations.size) await Promise.allSettled([...operations])
      }
      const stopped = await Promise.race([Promise.allSettled([drain(), input.partition.closeAllConnections(), closed, ...windows, ...socketClosed]),
        new Promise<null>((accept) => setTimeout(() => accept(null), 2100).unref())])
      closing.details = { results: stopped?.map((result) => result.status === "rejected" ? "rejected" : result.value === false ? "unconfirmed" : "confirmed") ?? ["deadline"],
        sockets: sockets.size, requests: requests.size, responses: responses.size, resolvers: resolvers.size,
        operations: operations.size, sinkSockets: sinkSockets.size, windows: ownedWindows.size, listening: sink.listening,
        socketStates: [...sockets].map((socket) => ({ tls: socket instanceof tls.TLSSocket, closed: socket.closed, destroyed: socket.destroyed, connecting: socket.connecting })),
        requestStates: [...requests].map((request) => ({ method: request.method, destroyed: request.destroyed, finished: request.writableFinished })) }
      return stopped !== null && stopped.every((result) => result.status === "fulfilled" && result.value !== false) &&
        sockets.size === 0 && requests.size === 0 && responses.size === 0 && resolvers.size === 0 && operations.size === 0 &&
        sinkSockets.size === 0 && ownedWindows.size === 0 && httpLeases.size === 0 && queries.size === 0 && !sink.listening
    })()
    return closing.promise
  }
  return { close, beginAction, finishAction, createReadonlyWindow, postAPI, facts: () => ({ ...state, sockets: sockets.size, requestsActive: requests.size,
    responses: responses.size, resolvers: resolvers.size, operations: operations.size, sinkSockets: sinkSockets.size,
    proxy: Boolean(proxy), sinkPort: address.port, resolverPolicy, resolved: resolution.last,
    httpInFlight: httpLeases.size, queries: queries.size, cleanup: closing.details }) }
}

function originalsCurrent() {
  return originals.every((value, index) => {
    const expected = descriptors[index]
    const actual = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(expected).filter((key) => !((value === http || value === https) && key === "globalAgent"))
    return Reflect.ownKeys(expected).length === Reflect.ownKeys(actual).length && keys.every((key) => {
      const left = Reflect.get(expected, key) as PropertyDescriptor
      const right = Reflect.get(actual, key) as PropertyDescriptor | undefined
      return right && left.value === right.value && left.get === right.get && left.set === right.set &&
        left.configurable === right.configurable && left.enumerable === right.enumerable && left.writable === right.writable
    })
  })
}
function publicOrigin(value: string) {
  if (Buffer.byteLength(value) > 512 || !URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === "https:" && value === url.origin && !url.username && !url.password &&
    !net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && !url.hostname.endsWith(".") &&
    !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(url.hostname) &&
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) && url.hostname.includes(".")
}
function proxyURL(value: string) {
  if (!URL.canParse(value)) fail("BROWSER_DRIVER_UNAVAILABLE")
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) fail("BROWSER_DRIVER_UNAVAILABLE")
  return url
}
function noProxy(hostname: string, port: number, source: string) {
  return source.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean).some((value) => {
    if (value === "*") return true
    const match = /^(.*?)(?::([0-9]+))?$/.exec(value)!
    if (match[2] && Number(match[2]) !== port) return false
    const host = match[1]!
    return host.startsWith("*.") ? hostname.endsWith(host.slice(1)) : host.startsWith(".") ? hostname.endsWith(host) : hostname === host
  })
}
// Fixed IANA special-use exclusions, plus multicast/reserved and IPv6 transition ranges.
export function publicAddress(value: string) {
  if (net.isIP(value) === 4) {
    const bytes = value.split(".").map(Number)
    return !(bytes[0] === 0 || bytes[0] === 10 || bytes[0] === 127 || bytes[0]! >= 224 ||
      (bytes[0] === 100 && bytes[1]! >= 64 && bytes[1]! <= 127) || (bytes[0] === 169 && bytes[1] === 254) ||
      (bytes[0] === 172 && bytes[1]! >= 16 && bytes[1]! <= 31) || (bytes[0] === 192 && bytes[1] === 168) ||
      (bytes[0] === 192 && bytes[1] === 0 && [0, 2].includes(bytes[2]!)) ||
      (bytes[0] === 198 && [18, 19].includes(bytes[1]!)) || (bytes[0] === 198 && bytes[1] === 51 && bytes[2] === 100) ||
      (bytes[0] === 203 && bytes[1] === 0 && bytes[2] === 113) || (bytes[0] === 192 && bytes[1] === 88 && bytes[2] === 99))
  }
  if (net.isIP(value) !== 6 || value.includes("%") || value.includes(".")) return false
  const halves = value.toLowerCase().split("::")
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves[1] ? halves[1].split(":") : []
  const bytes = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right].map((part) => parseInt(part, 16))
  return bytes[0]! >= 0x2000 && bytes[0]! <= 0x3fff && !(bytes[0] === 0x2001 && bytes[1]! < 0x200) &&
    !(bytes[0] === 0x2001 && bytes[1] === 0xdb8) && bytes[0] !== 0x2002 && !(bytes[0] === 0x3fff && bytes[1]! < 0x1000)
}
