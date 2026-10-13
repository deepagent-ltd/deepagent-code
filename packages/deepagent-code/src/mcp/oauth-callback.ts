import { createConnection } from "net"
import { lookup } from "node:dns/promises"
import { McpOAuthState } from "./oauth-state"
import { createServer } from "http"
import * as Log from "@deepagent-code/core/util/log"
import { OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH } from "./oauth-provider"

const log = Log.create({ service: "mcp.oauth-callback" })

let operation = Promise.resolve()

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>DeepAgent Code - Authorization Response Received</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Response Received</h1>
    <p>Return to DeepAgent Code to check the final authentication status.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`

const HTML_ERROR = (error: string) => `<!DOCTYPE html>
<html>
<head>
  <title>DeepAgent Code - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${escapeHtml(error)}</div>
  </div>
</body>
</html>`

interface PendingAuth {
  state: string
  promise: Promise<URLSearchParams>
  resolve: (params: URLSearchParams) => void
  reject: (error: Error) => void
  validate?: (params: URLSearchParams) => Promise<void>
}
interface Listener {
  key: string
  server: ReturnType<typeof createServer>
  owners: Set<Owned>
}
interface Owned {
  uri: string
  automatic: boolean
  closed: boolean
  expiresAt: number
  timer?: ReturnType<typeof setTimeout>
  servers: Listener[]
  pending?: PendingAuth
  closing?: Promise<void>
}
export interface Lease {
  readonly redirectUri: string
  readonly automatic: boolean
  readonly waitForResponse: (
    state: string,
    validate?: (params: URLSearchParams) => Promise<void>,
  ) => Promise<URLSearchParams>
  readonly cancel: () => void
  readonly close: () => Promise<void>
}
const listeners = new Map<string, Listener>()
const owners = new Set<Owned>()
const pending = new Map<string, Owned>()
const CALLBACK_TIMEOUT_MS = 300000
const MAX_PENDING_AUTHS = 64
const compatibility = { lease: undefined as Lease | undefined, names: new Map<string, string>() }

/** A lease owns only its sockets and exact waiter. It never reconfigures another flow's listener. */
export function acquire(redirectUri?: string): Promise<Lease> {
  return serialize(async () => {
    if (owners.size >= MAX_PENDING_AUTHS) throw new Error("Too many pending OAuth callbacks")
    const parsed = redirectUri ? McpOAuthState.callbackUri(redirectUri) : undefined
    if (parsed?.port === "0") throw new Error("An explicit OAuth callback port must be positive")
    const automatic =
      !parsed || (parsed.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname))
    const addresses = !automatic
      ? []
      : !parsed || parsed.hostname === "127.0.0.1"
        ? ["127.0.0.1"]
        : parsed.hostname === "[::1]"
          ? ["::1"]
          : [...new Set((await lookup("localhost", { all: true, verbatim: true })).map((value) => value.address))]
    if (automatic && (!addresses.length || addresses.some((address) => address !== "127.0.0.1" && address !== "::1")))
      throw new Error("OAuth localhost resolution is not exclusively loopback")
    const owned: Owned = {
      uri: redirectUri ?? "",
      automatic,
      closed: false,
      expiresAt: Date.now() + CALLBACK_TIMEOUT_MS,
      servers: [],
    }
    owners.add(owned)
    try {
      for (const address of addresses) {
        const port = parsed ? Number(parsed.port || 80) : 0
        const key = `${address}:${port}`
        const existing = port ? listeners.get(key) : undefined
        if (existing) {
          existing.owners.add(owned)
          owned.servers.push(existing)
          continue
        }
        if (listeners.size >= 128) throw new Error("Too many OAuth callback sockets")
        const server = createServer({ maxHeaderSize: 16384 }, (request, response) => {
          void handleRequest(request, response).catch(() => {
            if (!response.headersSent) response.writeHead(400, { "Cache-Control": "no-store" })
            if (!response.writableEnded) response.end("Invalid authorization response")
          })
        })
        server.headersTimeout = 5000
        server.requestTimeout = 5000
        server.keepAliveTimeout = 1000
        server.maxConnections = 64
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject)
          server.listen(port, address, () => {
            server.removeListener("error", reject)
            resolve()
          })
        }).catch((error) => {
          server.close()
          throw error
        })
        server.on("error", () => log.warn("OAuth callback listener failed"))
        const actual = server.address()
        if (!actual || typeof actual === "string") {
          server.close()
          throw new Error("OAuth callback socket is unavailable")
        }
        const listener = { key: `${address}:${actual.port}`, server, owners: new Set([owned]) }
        listeners.set(listener.key, listener)
        owned.servers.push(listener)
        if (!redirectUri) owned.uri = `http://127.0.0.1:${actual.port}${OAUTH_CALLBACK_PATH}`
      }
      owned.timer = setTimeout(() => {
        void closeOwned(owned)
      }, CALLBACK_TIMEOUT_MS)
      owned.timer.unref?.()
      return Object.freeze({
        redirectUri: owned.uri,
        automatic: owned.automatic,
        waitForResponse: (state: string, validate?: PendingAuth["validate"]) => waitOwned(owned, state, validate),
        cancel: () => cancelOwned(owned),
        close: () => serialize(() => closeOwned(owned)),
      })
    } catch (error) {
      await closeOwned(owned)
      throw error
    }
  })
}

function waitOwned(owned: Owned, state: string, validate?: PendingAuth["validate"]): Promise<URLSearchParams> {
  if (owned.closed || Date.now() >= owned.expiresAt) return Promise.reject(new Error("OAuth callback lease expired"))
  if (!state || Buffer.byteLength(state, "utf8") > 256) return Promise.reject(new Error("Invalid OAuth state"))
  if (owned.pending)
    return owned.pending.state === state
      ? owned.pending.promise
      : Promise.reject(new Error("OAuth state is already pending"))
  if (pending.has(state)) return Promise.reject(new Error("OAuth state is already pending"))
  const result = Promise.withResolvers<URLSearchParams>()
  void result.promise.catch(() => {})
  owned.pending = { state, ...result, validate }
  pending.set(state, owned)
  return result.promise
}

async function handleRequest(req: import("http").IncomingMessage, res: import("http").ServerResponse) {
  const reject = (message: string) => {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(HTML_ERROR(message))
  }
  if (req.method !== "GET" || Buffer.byteLength(req.url ?? "", "utf8") > 16384)
    return reject("Invalid authorization response")
  const url = new URL(req.url ?? "/", "http://localhost")
  if (["code", "state", "iss", "error", "error_description"].some((key) => url.searchParams.getAll(key).length > 1))
    return reject("Duplicate authorization response parameter")
  if (
    [...url.searchParams].some(
      ([key, value]) =>
        Buffer.byteLength(value, "utf8") >
          (key === "state" ? 256 : key === "error" ? 128 : key === "error_description" ? 1024 : 8192) ||
        /[\u0000-\u001f\u007f]/.test(value),
    )
  )
    return reject("Invalid authorization response parameter")
  const state = url.searchParams.get("state")
  const owned = state ? pending.get(state) : undefined
  const waiter = owned?.pending
  if (!owned || !waiter || owned.closed || Date.now() >= owned.expiresAt)
    return reject("Invalid or expired state parameter")
  const expected = new URL(owned.uri)
  if (
    !owned.automatic ||
    req.headers.host !== expected.host ||
    url.pathname !== expected.pathname ||
    !owned.servers.some(
      (listener) =>
        listener.server.address() &&
        req.socket.localPort === (listener.server.address() as import("net").AddressInfo).port,
    ) ||
    [...new Set(expected.searchParams.keys())].some(
      (key) =>
        JSON.stringify(expected.searchParams.getAll(key).sort()) !==
        JSON.stringify(url.searchParams.getAll(key).sort()),
    )
  )
    return reject("Authorization callback address does not match the current flow")
  const code = url.searchParams.get("code")
  const error = url.searchParams.get("error")
  if ((!code && !error) || (code && error) || url.searchParams.get("iss") === "")
    return reject("Invalid authorization response")
  const params = new URLSearchParams(url.searchParams)
  try {
    await waiter.validate?.(params)
  } catch {
    return reject("Authorization response does not match the current flow")
  }
  if (pending.get(waiter.state) !== owned || owned.pending !== waiter || owned.closed || Date.now() >= owned.expiresAt)
    return reject("Invalid or expired state parameter")
  pending.delete(waiter.state)
  if (error) waiter.reject(new Error("Authorization was declined by the authorization server"))
  else waiter.resolve(params)
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
  res.end(error ? HTML_ERROR("Authorization was declined. Return to DeepAgent Code.") : HTML_SUCCESS)
}

function cancelOwned(owned: Owned) {
  const waiter = owned.pending
  owned.pending = undefined
  if (!waiter) return
  if (pending.get(waiter.state) === owned) pending.delete(waiter.state)
  waiter.reject(new Error("Authorization cancelled"))
}
function closeOwned(owned: Owned): Promise<void> {
  if (owned.closing) return owned.closing
  owned.closed = true
  clearTimeout(owned.timer)
  cancelOwned(owned)
  owners.delete(owned)
  owned.closing = Promise.all(
    owned.servers.map(async (listener) => {
      listener.owners.delete(owned)
      if (listener.owners.size) return
      if (listeners.get(listener.key) === listener) listeners.delete(listener.key)
      listener.server.closeAllConnections()
      await new Promise<void>((resolve) => listener.server.close(() => resolve()))
    }),
  ).then(() => {})
  return owned.closing
}

// Compatibility helpers for old callers/tests. Production uses the exact lease returned by acquire.
export async function ensureRunning(uri?: string) {
  const value = uri ?? `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`
  if (compatibility.lease?.redirectUri === value) return
  const next = await acquire(value)
  await compatibility.lease?.close()
  compatibility.lease = next
}
export function waitForResponse(state: string, name?: string, validate?: PendingAuth["validate"]) {
  if (pending.has(state)) return Promise.reject(new Error("OAuth state is already pending"))
  if (name && compatibility.names.has(name)) return Promise.reject(new Error("MCP OAuth is already pending"))
  if (name) compatibility.names.set(name, state)
  return (
    compatibility.lease
      ? compatibility.lease.waitForResponse(state, validate)
      : Promise.reject(new Error("OAuth callback listener is unavailable"))
  ).finally(() => {
    if (name && compatibility.names.get(name) === state) compatibility.names.delete(name)
  })
}
export function waitForCallback(state: string, name?: string) {
  return waitForResponse(state, name).then((params) => params.get("code")!)
}
export function cancelPending(name: string) {
  const state = compatibility.names.get(name) ?? name
  const owned = pending.get(state)
  if (owned) cancelOwned(owned)
  compatibility.names.delete(name)
}
export async function isPortInUse(port = OAUTH_CALLBACK_PORT) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(port, "127.0.0.1")
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => resolve(false))
  })
}
export function stop() {
  return serialize(async () => {
    await Promise.all([...owners].map(closeOwned))
    compatibility.lease = undefined
    compatibility.names.clear()
  })
}
export function isRunning() {
  return listeners.size > 0
}
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = operation.then(task, task)
  operation = result.then(
    () => {},
    () => {},
  )
  return result
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) =>
    character === "&"
      ? "&amp;"
      : character === "<"
        ? "&lt;"
        : character === ">"
          ? "&gt;"
          : character === '"'
            ? "&quot;"
            : "&#39;",
  )
}
export * as McpOAuthCallback from "./oauth-callback"
