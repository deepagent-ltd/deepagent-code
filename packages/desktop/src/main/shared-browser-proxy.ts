/*
 * Adapted from opencode packages/plugin-browser/src/proxy.ts at
 * d099d2cb2a0869d07d2f533c66348e4868325a78. Transport, listener, HTTP forwarding,
 * CONNECT and Duplex framing remain one leaf; DAC adds explicit reset fencing/receipts.
 *
 * MIT License
 *
 * Copyright (c) 2025 opencode
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export * as BrowserProxy from "./shared-browser-proxy"

import { randomBytes, timingSafeEqual } from "node:crypto"
import { Agent, createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { Duplex } from "node:stream"

const TUNNEL_CHUNK_BYTES = 64 * 1024
export type Target = { host: string; port: number }
/** The owner authorizes targets and confirms actual underlying socket closure. */
export type Transport = {
  open(target: Target, signal: AbortSignal): Promise<string>
  read(id: string, signal: AbortSignal): Promise<{ data: Uint8Array; eof: boolean }>
  write(id: string, data: Uint8Array, end: boolean, signal: AbortSignal): Promise<void>
  close(id: string): Promise<boolean>
}
export type TunnelReceipt = {
  id: string
  localClosed: boolean
  transportClosed: boolean
  closed: boolean
  error?: "transport_close_failed" | "transport_close_unconfirmed"
}
export type PendingReceipt = { id: string; settled: boolean; tunnel?: TunnelReceipt }
export type ResetReceipt = {
  resetEpoch: number
  closed: boolean
  listenerOpen: boolean
  pending: PendingReceipt[]
  clients: { id: string; closed: boolean }[]
  tunnels: TunnelReceipt[]
}
export type CloseReceipt = ResetReceipt & { listenerClosed: boolean }
export type Proxy = Awaited<ReturnType<typeof make>>

// Desktop-only leaf. No remote RPC, renderer or Electron dependency.
export async function make(transport: Transport) {
  const username = randomBytes(16).toString("hex")
  const password = randomBytes(32).toString("hex")
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`)
  const clients = new Map<Duplex, string>()
  // Failed/unconfirmed transport closes remain visible to later reset receipts.
  const tunnels = new Set<TunnelSocket>()
  const pending = new Set<{
    id: string
    abort: AbortController
    completion: ReturnType<typeof Promise.withResolvers<PendingReceipt>>
    tunnel?: TunnelSocket
  }>()
  let closed = false
  let accepting = true
  let sequence = 0
  let epoch = 0
  let reset: { epoch: number; promise: Promise<ResetReceipt>; receipt?: ResetReceipt } | undefined
  const authorized = (value: string | undefined) => {
    if (!value) return false
    const actual = Buffer.from(value)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  const connect = async (target: Target, signal: AbortSignal) => {
    if (closed || !accepting) throw new Error("Browser proxy is unavailable")
    const admittedEpoch = epoch
    const abort = new AbortController()
    const cancel = () => abort.abort()
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()
    const entry: { id: string; abort: AbortController; completion: ReturnType<typeof Promise.withResolvers<PendingReceipt>>; tunnel?: TunnelSocket } = {
      id: `open:${++sequence}`, abort, completion: Promise.withResolvers<PendingReceipt>(),
    }
    pending.add(entry)
    try {
      const id = await transport.open(target, abort.signal)
      const socket = new TunnelSocket(transport, id)
      entry.tunnel = socket
      tunnels.add(socket)
      void socket.settlement.then((receipt) => {
        if (receipt.closed) tunnels.delete(socket)
      })
      if (closed || !accepting || epoch !== admittedEpoch || abort.signal.aborted) {
        await socket.closeTunnel()
        throw new Error("Browser proxy connection was cancelled")
      }
      return socket
    } finally {
      pending.delete(entry)
      signal.removeEventListener("abort", cancel)
      entry.completion.resolve({ id: entry.id, settled: true,
        ...(entry.tunnel?.destroyed ? { tunnel: await entry.tunnel.settlement } : {}) })
    }
  }
  const server = createServer({ maxHeaderSize: 64 * 1024 }, (incoming, response) => {
    if (closed || !accepting) {
      response.writeHead(503, { connection: "close" })
      response.end()
      return
    }
    void forward(incoming, response, connect, authorized).catch(() => {
      if (!response.headersSent) {
        response.writeHead(502, { connection: "close" })
        response.end()
        return
      }
      response.destroy()
    })
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.on("connection", (socket) => {
    clients.set(socket, `client:${++sequence}`)
    socket.on("error", () => socket.destroy())
    socket.once("close", () => clients.delete(socket))
    if (closed || !accepting) socket.destroy()
  })
  server.on("connect", (incoming, socket, head) => {
    void (async () => {
      if (closed || !accepting) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        return
      }
      if (!authorized(incoming.headers["proxy-authorization"])) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="DAC Browser Proxy"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        return
      }
      const url = parseURL(`https://${incoming.url ?? ""}`)
      if (!url || url.pathname !== "/" || url.search || url.hash) {
        socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        return
      }
      const abort = new AbortController()
      const cancel = () => abort.abort()
      socket.once("close", cancel)
      socket.pause()
      try {
        const tunnel = await connect(target(url), abort.signal)
        if (socket.destroyed) {
          tunnel.destroy()
          return
        }
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        if (head.byteLength) tunnel.write(head)
        socket.once("close", () => tunnel.destroy())
        tunnel.once("close", () => socket.destroy())
        socket.pipe(tunnel)
        tunnel.pipe(socket)
        socket.resume()
      } finally {
        socket.off("close", cancel)
      }
    })().catch(() => {
      if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    })
  })
  // CONNECT is retained; websocket upgrades are deliberately outside this release contract.
  server.on("upgrade", (incoming, socket) => socket.end(authorized(incoming.headers["proxy-authorization"])
    ? "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    : 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="DAC Browser Proxy"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'))
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  })
  let listenerClosed = false
  server.once("close", () => { listenerClosed = true })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Browser proxy did not bind a TCP address")
  const settle = async (resetEpoch: number): Promise<ResetReceipt> => {
    const opening = [...pending]
    const connected = [...tunnels]
    const sockets = [...clients]
    opening.forEach((entry) => entry.abort.abort())
    const [pendingReceipts, tunnelReceipts, clientReceipts] = await Promise.all([
      Promise.all(opening.map((entry) => entry.completion.promise)),
      Promise.all(connected.map((socket) => socket.closeTunnel())),
      Promise.all(sockets.map(([socket, id]) => new Promise<{ id: string; closed: boolean }>((resolve) => {
        if (socket.closed) { resolve({ id, closed: true }); return }
        socket.once("close", () => resolve({ id, closed: socket.closed }))
        socket.destroy()
      }))),
    ])
    connected.forEach((socket, index) => { if (tunnelReceipts[index]?.closed) tunnels.delete(socket) })
    return { resetEpoch,
      closed: pendingReceipts.every((entry) => entry.settled && entry.tunnel?.closed !== false) &&
        tunnelReceipts.every((entry) => entry.closed) && clientReceipts.every((entry) => entry.closed),
      listenerOpen: server.listening,
      pending: pendingReceipts, clients: clientReceipts, tunnels: tunnelReceipts }
  }
  let closing: { promise: Promise<CloseReceipt>; receipt?: CloseReceipt } | undefined
  return {
    url: `http://127.0.0.1:${address.port}`, host: "127.0.0.1", port: address.port,
    credentials: { username, password },
    quiesce(resetEpoch: number) {
      if (!Number.isSafeInteger(resetEpoch) || resetEpoch < 0 || resetEpoch < epoch)
        return Promise.reject(new Error("Browser proxy reset epoch is stale or invalid"))
      if (closed) return Promise.reject(new Error("Browser proxy is closed"))
      if (reset?.epoch === resetEpoch && (!reset.receipt || reset.receipt.closed)) return reset.promise
      accepting = false
      epoch = resetEpoch
      const operation = { epoch: resetEpoch, promise: settle(resetEpoch), receipt: undefined as ResetReceipt | undefined }
      reset = operation
      void operation.promise.then((receipt) => { operation.receipt = receipt })
      return operation.promise
    },
    resume(resetEpoch: number) {
      if (closed || epoch !== resetEpoch || reset?.epoch !== resetEpoch || reset.receipt?.closed !== true) return false
      accepting = true
      return true
    },
    close() {
      if (closing && (!closing.receipt || closing.receipt.closed)) return closing.promise
      closed = true
      accepting = false
      const cleanup = settle(epoch)
      const listener = listenerClosed ? Promise.resolve(true) : new Promise<boolean>((resolve) => {
        const confirmed = () => resolve(true)
        server.once("close", confirmed)
        server.close((error) => {
          if (!error) return
          server.off("close", confirmed)
          resolve(false)
        })
      })
      const operation = { promise: Promise.all([cleanup, listener]).then(([receipt, confirmed]) => ({
        ...receipt, listenerOpen: server.listening, listenerClosed: confirmed, closed: receipt.closed && confirmed,
      })), receipt: undefined as CloseReceipt | undefined }
      closing = operation
      void operation.promise.then((receipt) => { operation.receipt = receipt })
      return operation.promise
    },
  }
}

async function forward(incoming: IncomingMessage, response: ServerResponse,
  connect: (target: Target, signal: AbortSignal) => Promise<Duplex>, authorized: (value: string | undefined) => boolean) {
  if (!authorized(incoming.headers["proxy-authorization"])) {
    response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="DAC Browser Proxy"', connection: "close" })
    response.end()
    return
  }
  const url = parseURL(incoming.url)
  if (!url || url.protocol !== "http:") { response.writeHead(400); response.end(); return }
  const abort = new AbortController()
  const cancel = () => abort.abort()
  incoming.once("aborted", cancel)
  response.once("close", cancel)
  const agent = new Agent({ keepAlive: false, maxSockets: 1 })
  try {
    const tunnel = await connect(target(url), abort.signal)
    agent.createConnection = () => tunnel
    const headers = forwardedHeaders(incoming.headers)
    headers.host = url.host
    headers.connection = "close"
    await new Promise<void>((resolve, reject) => {
      const upstream = request({ agent, hostname: url.hostname, port: url.port || 80,
        path: `${url.pathname}${url.search}`, method: incoming.method, headers, signal: abort.signal }, (result) => {
        response.writeHead(result.statusCode ?? 502, result.statusMessage,
          { ...forwardedHeaders(result.headers), connection: "close" })
        result.once("error", reject)
        response.once("finish", resolve)
        result.pipe(response)
      })
      upstream.once("error", reject)
      incoming.pipe(upstream)
    })
  } finally {
    incoming.off("aborted", cancel)
    response.off("close", cancel)
    agent.destroy()
  }
}

function forwardedHeaders(input: IncomingHttpHeaders) {
  const headers = { ...input }
  headers.connection?.split(",").forEach((name) => delete headers[name.trim().toLowerCase()])
  ;["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]
    .forEach((name) => delete headers[name])
  return headers
}
function parseURL(value: string | undefined) {
  if (!value || !URL.canParse(value)) return undefined
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return undefined
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
  if (host.length < 1 || host.length > 253 || !/^[a-zA-Z0-9._:%-]+$/.test(host) ||
    !Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return url
}
function target(url: URL): Target {
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80 }
}

class TunnelSocket extends Duplex {
  readonly connecting = false
  private readonly abort = new AbortController()
  private readonly completion = Promise.withResolvers<TunnelReceipt>()
  readonly settlement = this.completion.promise
  private pending = false
  private transportClosed = false
  private closeError: TunnelReceipt["error"]
  private retry: Promise<TunnelReceipt> | undefined
  constructor(private readonly transport: Transport, private readonly id: string) {
    super({ highWaterMark: TUNNEL_CHUNK_BYTES, allowHalfOpen: true })
    this.on("error", () => this.destroy())
    this.once("close", () => this.completion.resolve(this.receipt()))
  }
  closeTunnel() {
    if (!this.closed) { this.destroy(); return this.settlement }
    if (this.transportClosed) return Promise.resolve(this.receipt())
    if (this.retry) return this.retry
    // Retry only the close acknowledgement for this already-closed local
    // socket; no new target connection or request may be dispatched.
    this.retry = Promise.resolve().then(() => this.transport.close(this.id)).then((confirmed) => {
      this.transportClosed = confirmed === true
      this.closeError = this.transportClosed ? undefined : "transport_close_unconfirmed"
      return this.receipt()
    }, () => {
      this.closeError = "transport_close_failed"
      return this.receipt()
    }).finally(() => { this.retry = undefined })
    return this.retry
  }
  private receipt(): TunnelReceipt {
    return { id: this.id, localClosed: this.closed, transportClosed: this.transportClosed,
      closed: this.closed && this.transportClosed, ...(this.closeError ? { error: this.closeError } : {}) }
  }
  override _read() {
    if (this.pending || this.destroyed) return
    this.pending = true
    void this.transport.read(this.id, this.abort.signal).then((result) => {
      this.pending = false
      if (this.destroyed) return
      if (!(result.data instanceof Uint8Array) || result.data.byteLength > TUNNEL_CHUNK_BYTES ||
        (!result.eof && result.data.byteLength === 0)) { this.destroy(new Error("Invalid browser tunnel read")); return }
      const more = result.data.byteLength > 0 ? this.push(result.data) : true
      if (result.eof) { this.push(null); return }
      if (more) this._read()
    }, (error: unknown) => this.destroy(asError(error)))
  }
  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const data = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk
    void (async () => {
      for (let offset = 0; offset < data.byteLength; offset += TUNNEL_CHUNK_BYTES)
        await this.transport.write(this.id, data.subarray(offset, offset + TUNNEL_CHUNK_BYTES), false, this.abort.signal)
    })().then(() => callback(), (error: unknown) => callback(asError(error)))
  }
  override _final(callback: (error?: Error | null) => void) {
    void this.transport.write(this.id, new Uint8Array(), true, this.abort.signal)
      .then(() => callback(), (error: unknown) => callback(asError(error)))
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.abort.abort()
    void Promise.resolve().then(() => this.transport.close(this.id)).then((confirmed) => {
      this.transportClosed = confirmed === true
      if (!this.transportClosed) this.closeError = "transport_close_unconfirmed"
      callback(error ?? (this.transportClosed ? null : new Error("Browser tunnel close is unconfirmed")))
    }, (failure: unknown) => {
      this.closeError = "transport_close_failed"
      callback(error ?? asError(failure))
    })
  }
  setKeepAlive() { return this }
  setNoDelay() { return this }
  setTimeout(_timeout: number, callback?: () => void) { if (callback) this.once("timeout", callback); return this }
  ref() { return this }
  unref() { return this }
}
function asError(error: unknown) { return error instanceof Error ? error : new Error(String(error)) }
