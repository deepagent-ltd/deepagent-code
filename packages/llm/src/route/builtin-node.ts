export * as BuiltinNode from "./builtin-node"

import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import stream from "node:stream"
import events from "node:events"
import diagnostics from "node:diagnostics_channel"
import { createHash, createHmac, randomBytes } from "node:crypto"

// The executable bootstrap imports this module before plugins. Keep both views: syncing a
// modified CommonJS export into ESM and then restoring CommonJS must not hide that change.
const namespaces = await Promise.all([
  import("node:http"), import("node:https"), import("node:net"), import("node:tls"),
  import("node:stream"), import("node:events"), import("node:diagnostics_channel"),
])
const web = { URL, Headers, Response, ReadableStream, TextDecoder, Uint8Array, Buffer }
const objects = [http, https, net, tls, stream, events, diagnostics, ...namespaces,
  http.Agent.prototype, https.Agent.prototype, http.ClientRequest.prototype,
  http.OutgoingMessage.prototype, http.IncomingMessage.prototype, net.Socket.prototype, tls.TLSSocket.prototype,
  stream.Readable.prototype, stream.Writable.prototype, stream.Duplex.prototype,
  events.EventEmitter.prototype,
  ...Object.values(web), ...Object.values(web).map((value) => value.prototype),
]
const descriptors = objects.map((object) => Object.getOwnPropertyDescriptors(object))
const getDescriptors = Object.getOwnPropertyDescriptors
const ownKeys = Reflect.ownKeys
const originalFetch = globalThis.fetch
const originalEnvironment = process.env
const originalRequest = { http: http.request, https: https.request }
const constructors = { http: http.Agent, https: https.Agent }
const end = http.OutgoingMessage.prototype.end
const destroy = http.ClientRequest.prototype.destroy
const responseDestroy = http.IncomingMessage.prototype.destroy
const once = events.EventEmitter.prototype.once
const apply = Reflect.apply
const agentDestroy = http.Agent.prototype.destroy
const keys = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  "SSL_CERT_DIR", "BUN_CA_FILE", "NODE_OPTIONS", "BUN_OPTIONS", "NODE_DEBUG", "NODE_DEBUG_NATIVE"] as const
const environment = () => JSON.stringify({ values: keys.map((key) => [key, process.env[key] ?? null]), execArgv: process.execArgv })
const initialEnvironment = environment()
const proxyEnvironment = Object.freeze({
  http_proxy: process.env.http_proxy || process.env.HTTP_PROXY || process.env.all_proxy || process.env.ALL_PROXY,
  https_proxy: process.env.https_proxy || process.env.HTTPS_PROXY || process.env.all_proxy || process.env.ALL_PROXY,
  no_proxy: process.env.no_proxy ?? process.env.NO_PROXY,
})
const rootSource = !process.versions.bun && typeof tls.getCACertificates === "function"
  ? tls.getCACertificates("default") : undefined
const roots = rootSource && Object.freeze(rootSource.slice())
const immutableRoots = rootSource && Object.isFrozen(rootSource)
const rootHash = (certificates: readonly string[]) => createHash("sha256").update(JSON.stringify(certificates)).digest("hex")
const initialRootHash = roots && rootHash(roots)
const channels = ["http.client.request.created", "http.client.request.start", "http.client.request.error", "http.client.response.finish"]
  .map((name) => diagnostics.channel(name))
const state = { installed: false, active: true }
const configurationHash = createHmac("sha256", randomBytes(32))
  .update("dac.native-node.configuration.v1\0").update(initialEnvironment).update(initialRootHash ?? "unavailable").digest("hex")

/** Construction evidence only. Signed installation and the actual client/model remain Host-owned. */
export function install() {
  state.installed = true
  return current()
}

export function current() {
  if (process.versions.bun || !state.installed || !state.active || !roots ||
    globalThis.fetch !== originalFetch || process.env !== originalEnvironment || environment() !== initialEnvironment ||
    Object.entries(web).some(([name, value]) => Reflect.get(globalThis, name) !== value) ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" || process.env.NODE_OPTIONS || process.env.BUN_OPTIONS ||
    process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE || process.env.SSL_CERT_DIR || process.env.BUN_CA_FILE ||
    process.env.NODE_DEBUG || process.env.NODE_DEBUG_NATIVE ||
    process.execArgv.some((value) => /^(?:--(?:require|import|loader|experimental-loader|trace-tls|tls-keylog)(?:=|$)|-r)/.test(value)) ||
    channels.some((channel) => channel.hasSubscribers)) return false
  const version = process.versions.node.split(".").map(Number)
  if (version[0] < 24 || (version[0] === 24 && version[1] < 5)) return false
  if (!objects.every((object, index) => {
    const expected = descriptors[index]
    const actual = getDescriptors(object)
    const names = ownKeys(expected)
    return names.length === ownKeys(actual).length && names.every((name) => {
      const left = Reflect.get(expected, name) as PropertyDescriptor
      const right = Reflect.get(actual, name) as PropertyDescriptor | undefined
      return !!right && left.value === right.value && left.get === right.get && left.set === right.set &&
        left.writable === right.writable && left.enumerable === right.enumerable && left.configurable === right.configurable
    })
  })) return false
  const actualRoots = tls.getCACertificates("default")
  // Supported Node caches a frozen array. Its identity detects replacement without hashing
  // the entire certificate pool on every streamed chunk; mutable runtimes need a full digest.
  return immutableRoots ? actualRoots === rootSource : rootHash(actualRoots) === initialRootHash
}

export const describe = () => current() ? Object.freeze({
  runtime: `node:${process.versions.node}`, proxyPolicy: "startup-environment" as const, configurationHash,
}) : undefined

/** Own agents and immutable startup proxy projection. No global dispatcher, injected fetch,
 * socket retry, redirect or caller TLS option is accepted. Each resource belongs to this scope. */
export function create() {
  if (!current()) return undefined
  const agents = privateAgents()
  if (!agents) return undefined
  const lifetime = { active: true }
  const pending = new Set<http.ClientRequest>()
  const responses = new Set<http.IncomingMessage>()
  const live = () => lifetime.active && current()
  const fetch: typeof globalThis.fetch = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    if (!live() || typeof input !== "string" || !init || typeof init.body !== "string" || init.redirect !== "manual" ||
      init.keepalive !== false || init.signal?.aborted) throw new Error("Native Node transport is unavailable")
    const url = new URL(input)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error("Native Node endpoint is unavailable")
    const bytes = Buffer.from(init.body, "utf8")
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    // Node-generated Host and byte length are fixed here after the application seal. No
    // transfer encoding, HTTP upgrade or user-supplied transport framing can replace them.
    if (["host", "content-length", "transfer-encoding", "connection", "upgrade", "proxy-authorization", "expect"]
      .some((name) => Object.hasOwn(headers, name))) throw new Error("Native Node transport headers are unavailable")
    return await new Promise<Response>((resolve, reject) => {
      if (!live()) return reject(new Error("Native Node configuration changed"))
      const request = (url.protocol === "https:" ? originalRequest.https : originalRequest.http)(url, {
        method: init.method, headers: { ...headers, "content-length": bytes.byteLength },
        agent: url.protocol === "https:" ? agents.https : agents.http,
      })
      pending.add(request)
      const state = { received: false }
      const cancel = () => {
        reject(new Error("Native Node request cancelled"))
        destroy.call(request, new Error("Native Node request cancelled"))
      }
      init.signal?.addEventListener("abort", cancel, { once: true })
      once.call(request, "close", () => {
        pending.delete(request)
        init.signal?.removeEventListener("abort", cancel)
        if (!state.received) reject(new Error("Native Node response is unavailable"))
      })
      once.call(request, "error", () => reject(new Error("Native Node transport failed")))
      once.call(request, "response", (response: http.IncomingMessage) => {
        state.received = true
        if (!live()) { responseDestroy.call(response); cancel(); return reject(new Error("Native Node configuration changed")) }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode > 599) {
          responseDestroy.call(response); cancel(); return reject(new Error("Native Node status is unavailable"))
        }
        responses.add(response)
        once.call(response, "close", () => responses.delete(response))
        const iterator = response[Symbol.asyncIterator]()
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!live()) { responseDestroy.call(response); controller.error(new Error("Native Node configuration changed")); return }
            const part = await iterator.next().catch(() => undefined)
            if (!part || !live()) { responseDestroy.call(response); controller.error(new Error("Native Node response failed")); return }
            if (part.done) { controller.close(); return }
            controller.enqueue(Uint8Array.from(part.value))
          },
          cancel() { responseDestroy.call(response); cancel() },
        })
        try {
          const noBody = [204, 205, 304].includes(response.statusCode)
          const result = new Response(noBody ? null : body, { status: response.statusCode, headers: Object.entries(response.headers)
            .flatMap(([key, value]) => value === undefined ? [] : typeof value === "string" ? [[key, value]] : value.map((item) => [key, item])) })
          if (noBody) responseDestroy.call(response)
          resolve(result)
        } catch {
          responseDestroy.call(response)
          cancel()
        }
      })
      // request-created diagnostics run synchronously inside request(). Inspect again before
      // the first write, and at socket assignment before headers can be flushed.
      once.call(request, "socket", () => { if (!live()) cancel() })
      if (!live() || init.signal?.aborted) { cancel(); return reject(new Error("Native Node configuration changed")) }
      apply(end, request, [bytes])
    })
  }, { preconnect: originalFetch.preconnect })
  return Object.freeze({
    fetch, current: live, description: describe()!,
    close: async () => {
      lifetime.active = false
      const closing = [...pending, ...responses].map((resource) => new Promise<void>((resolve) => {
        once.call(resource, "close", resolve)
        if (resource instanceof http.ClientRequest) destroy.call(resource)
        if (resource instanceof http.IncomingMessage) responseDestroy.call(resource)
      }))
      agentDestroy.call(agents.http)
      agentDestroy.call(agents.https)
      const timer = { value: undefined as ReturnType<typeof setTimeout> | undefined }
      try {
        await Promise.race([Promise.all(closing), new Promise<never>((_, reject) => {
          timer.value = setTimeout(() => reject(new Error("Native Node close is unconfirmed")), 1000)
        })])
      } finally { if (timer.value !== undefined) clearTimeout(timer.value) }
    },
  })
}

function privateAgents() {
  // Unsupported Agent/proxy configurations must make native construction unavailable,
  // while the ordinary client graph remains usable. No direct-network fallback is allowed.
  try {
    const plain = new constructors.http({ keepAlive: false, proxyEnv: proxyEnvironment })
    try {
      return {
        http: plain,
        https: new constructors.https({ keepAlive: false, maxCachedSessions: 0, rejectUnauthorized: true,
          ca: roots!.slice(), proxyEnv: proxyEnvironment }),
      }
    } catch { agentDestroy.call(plain); return undefined }
  } catch { return undefined }
}
