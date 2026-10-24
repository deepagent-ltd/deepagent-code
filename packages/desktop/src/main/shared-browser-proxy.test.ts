import { expect, test } from "bun:test"
import { createServer, request, type Server } from "node:http"
import { connect, type Socket } from "node:net"
import { BrowserProxy } from "./shared-browser-proxy"

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing owned localhost listener")
  return address.port
}
async function closeSocket(socket: Socket) {
  if (socket.closed) return true
  return new Promise<boolean>((resolve) => {
    socket.once("close", () => resolve(socket.closed))
    socket.destroy()
  })
}
function localTransport(port: number, mode: "confirmed" | "false" | "throw" = "confirmed") {
  const closeMode = { value: mode }
  const records = new Map<string, { socket: Socket; chunks: Buffer[]; eof: boolean; notify?: () => void; error?: Error }>()
  const opens: BrowserProxy.Target[] = []
  const writeSizes: number[] = []
  const transport: BrowserProxy.Transport = {
    async open(target, signal) {
      // Trusted owner policy for these tests admits only this explicitly owned listener.
      if (target.host !== "127.0.0.1" || target.port !== port || signal.aborted) throw new Error("Not an owned target")
      opens.push(target)
      const socket = connect({ host: target.host, port: target.port })
      const id = `owned:${records.size}`
      const record: { socket: Socket; chunks: Buffer[]; eof: boolean; notify?: () => void; error?: Error } = {
        socket, chunks: [], eof: false,
      }
      records.set(id, record)
      socket.on("data", (data) => { record.chunks.push(data); record.notify?.() })
      socket.on("end", () => { record.eof = true; record.notify?.() })
      socket.on("close", () => { record.eof = true; record.notify?.() })
      socket.on("error", (error) => { record.error = error; record.notify?.() })
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { socket.destroy(); reject(new Error("Open cancelled")) }
        signal.addEventListener("abort", cancel, { once: true })
        socket.once("connect", () => { signal.removeEventListener("abort", cancel); resolve() })
        socket.once("error", reject)
      })
      return id
    },
    async read(id, signal) {
      const record = records.get(id)
      if (!record) throw new Error("Unknown tunnel")
      if (signal.aborted) throw new Error("Read cancelled")
      if (record.chunks.length === 0 && !record.eof && !record.error)
        await new Promise<void>((resolve, reject) => {
          const cancel = () => { record.notify = undefined; reject(new Error("Read cancelled")) }
          record.notify = () => { signal.removeEventListener("abort", cancel); record.notify = undefined; resolve() }
          signal.addEventListener("abort", cancel, { once: true })
        })
      if (record.error) throw record.error
      const data = record.chunks.shift()
      if (!data) return { data: new Uint8Array(), eof: true }
      if (data.byteLength > 64 * 1024) record.chunks.unshift(data.subarray(64 * 1024))
      return { data: data.subarray(0, 64 * 1024), eof: false }
    },
    async write(id, data, end, signal) {
      const socket = records.get(id)?.socket
      if (!socket || signal.aborted) throw new Error("Write cancelled")
      writeSizes.push(data.byteLength)
      await new Promise<void>((resolve, reject) => {
        if (end) { socket.end(data, () => resolve()); return }
        socket.write(data, (error) => error ? reject(error) : resolve())
      })
    },
    async close(id) {
      const socket = records.get(id)?.socket
      if (!socket) return false
      const closed = await closeSocket(socket)
      if (closeMode.value === "throw") throw new Error("Owner did not acknowledge close")
      return closeMode.value === "confirmed" && closed
    },
  }
  return { transport, records, opens, writeSizes, setCloseMode(value: typeof mode) { closeMode.value = value } }
}
const authorization = (proxy: BrowserProxy.Proxy) =>
  `Basic ${Buffer.from(`${proxy.credentials.username}:${proxy.credentials.password}`).toString("base64")}`
async function raw(proxy: BrowserProxy.Proxy, wire: string) {
  const socket = connect({ host: proxy.host, port: proxy.port })
  const chunks: Buffer[] = []
  return new Promise<string>((resolve, reject) => {
    socket.on("data", (data) => chunks.push(data))
    socket.once("connect", () => socket.write(wire))
    socket.once("error", reject)
    socket.once("close", () => resolve(Buffer.concat(chunks).toString()))
  }).finally(() => socket.destroy())
}
async function http(proxy: BrowserProxy.Proxy, port: number, body = "") {
  return new Promise<{ status: number; body: string; cookie: string[] | undefined }>((resolve, reject) => {
    const req = request({ host: proxy.host, port: proxy.port, method: "POST",
      path: `http://127.0.0.1:${port}/cookies?q=1`, headers: {
        "proxy-authorization": authorization(proxy), cookie: "local_session=kept",
        "content-length": Buffer.byteLength(body),
      } }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (data) => chunks.push(data))
      response.once("end", () => resolve({ status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString(), cookie: response.headers["set-cookie"] }))
      response.once("error", reject)
    })
    req.once("error", reject)
    req.end(body)
  })
}
async function connected(proxy: BrowserProxy.Proxy, port: number) {
  const socket = connect({ host: proxy.host, port: proxy.port })
  await new Promise<void>((resolve, reject) => {
    const chunks: Buffer[] = []
    const receive = (data: Buffer) => {
      chunks.push(data)
      if (!Buffer.concat(chunks).includes("200 Connection Established")) return
      socket.off("data", receive)
      resolve()
    }
    socket.on("data", receive)
    socket.once("error", reject)
    socket.once("connect", () => socket.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\n`))
  })
  return socket
}
function targetServer() {
  return createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on("data", (data) => chunks.push(data))
    incoming.once("end", () => response.writeHead(200, { "content-type": "application/json",
      "set-cookie": ["proxy_result=kept"], connection: "close" }).end(JSON.stringify({
      cookie: incoming.headers.cookie, proxyAuthorization: incoming.headers["proxy-authorization"] ?? null,
      bytes: Buffer.concat(chunks).byteLength,
    })))
  })
}
async function closeServer(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

test("real HTTP and CONNECT preserve cookies, strip proxy auth and chunk large writes", async () => {
  const server = targetServer()
  const port = await listen(server)
  const owner = localTransport(port)
  const proxy = await BrowserProxy.make(owner.transport)
  try {
    const result = await http(proxy, port, "x".repeat(130 * 1024))
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ cookie: "local_session=kept", proxyAuthorization: null, bytes: 130 * 1024 })
    expect(result.cookie).toEqual(["proxy_result=kept"])
    expect(Math.max(...owner.writeSizes)).toBeLessThanOrEqual(64 * 1024)
    const response = await raw(proxy, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nProxy-Authorization: ${authorization(proxy)}\r\n\r\nGET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: connect_session=kept\r\nConnection: close\r\n\r\n`)
    expect(response).toContain("200 Connection Established")
    expect(response).toContain('"cookie":"connect_session=kept"')
    expect(owner.opens).toHaveLength(2)
  } finally {
    expect((await proxy.close()).closed).toBe(true)
    await closeServer(server)
  }
})

test("proxy auth, credential URLs, unsupported schemes and websocket upgrades never open a target", async () => {
  const server = targetServer()
  const port = await listen(server)
  const owner = localTransport(port)
  const proxy = await BrowserProxy.make(owner.transport)
  try {
    expect(await raw(proxy, `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n`)).toContain("407 Proxy Authentication Required")
    expect(await raw(proxy, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nConnection: close\r\n\r\n`)).toContain("407 Proxy Authentication Required")
    for (const url of [`http://user:pass@127.0.0.1:${port}/`, "http://127.0.0.1:0/", `ftp://127.0.0.1:${port}/`])
      expect(await raw(proxy, `GET ${url} HTTP/1.1\r\nHost: fixture\r\nProxy-Authorization: ${authorization(proxy)}\r\nConnection: close\r\n\r\n`)).toContain("400 Bad Request")
    expect(await raw(proxy, `GET ws://127.0.0.1:${port}/ HTTP/1.1\r\nHost: fixture\r\nProxy-Authorization: ${authorization(proxy)}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)).toContain("400 Bad Request")
    expect(owner.opens).toHaveLength(0)
  } finally { await proxy.close(); await closeServer(server) }
})

test("quiesce closes actual sockets, retains listener and credentials, then resumes only the current epoch", async () => {
  const server = targetServer()
  const port = await listen(server)
  const owner = localTransport(port)
  const proxy = await BrowserProxy.make(owner.transport)
  const url = proxy.url
  const auth = authorization(proxy)
  try {
    const socket = await connected(proxy, port)
    const peerClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    const receipt = await proxy.quiesce(1)
    expect(receipt).toMatchObject({ resetEpoch: 1, closed: true, listenerOpen: true })
    expect(receipt.clients.every((client) => client.closed)).toBe(true)
    expect(receipt.tunnels).toMatchObject([{ localClosed: true, transportClosed: true, closed: true }])
    await peerClosed
    expect(socket.closed).toBe(true)
    expect([...owner.records.values()].every((record) => record.socket.closed)).toBe(true)
    await http(proxy, port).catch(() => undefined)
    expect(owner.opens).toHaveLength(1)
    expect(proxy.resume(0)).toBe(false)
    expect(proxy.resume(1)).toBe(true)
    expect(proxy.url).toBe(url)
    expect(authorization(proxy)).toBe(auth)
    expect((await http(proxy, port)).status).toBe(200)
    const closed = await proxy.close()
    expect(closed).toMatchObject({ closed: true, listenerClosed: true, listenerOpen: false })
    expect(proxy.resume(1)).toBe(false)
  } finally { await proxy.close(); await closeServer(server) }
})

test("a cancelled late open is closed and acknowledged before quiesce settles or resume permits new work", async () => {
  const server = targetServer()
  const port = await listen(server)
  const owner = localTransport(port)
  const started = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<void>()
  const proxy = await BrowserProxy.make({ ...owner.transport, open: async (target, signal) => {
    started.resolve(signal)
    await release.promise
    return owner.transport.open(target, new AbortController().signal)
  } })
  try {
    const client = http(proxy, port).catch(() => undefined)
    const signal = await started.promise
    const quiesce = proxy.quiesce(2)
    expect(signal.aborted).toBe(true)
    expect(proxy.resume(2)).toBe(false)
    release.resolve()
    const receipt = await quiesce
    expect(receipt.closed).toBe(true)
    expect(receipt.pending).toMatchObject([{ settled: true, tunnel: { localClosed: true, transportClosed: true, closed: true } }])
    expect([...owner.records.values()].every((record) => record.socket.closed)).toBe(true)
    expect(proxy.resume(1)).toBe(false)
    expect(proxy.resume(2)).toBe(true)
    await client
  } finally { release.resolve(); await proxy.close(); await closeServer(server) }
})

for (const mode of ["false", "throw"] as const)
  test(`transport close ${mode} never becomes a confirmed proxy reset`, async () => {
    const server = targetServer()
    const port = await listen(server)
    const owner = localTransport(port, mode)
    const proxy = await BrowserProxy.make(owner.transport)
    try {
      await connected(proxy, port)
      const receipt = await proxy.quiesce(3)
      expect(receipt.closed).toBe(false)
      expect(receipt.tunnels).toMatchObject([{ localClosed: true, transportClosed: false, closed: false,
        error: mode === "false" ? "transport_close_unconfirmed" : "transport_close_failed" }])
      expect(proxy.resume(3)).toBe(false)
      owner.setCloseMode("confirmed")
      const retry = proxy.quiesce(3)
      expect(proxy.quiesce(3)).toBe(retry)
      const recovered = await retry
      expect(recovered).toMatchObject({ resetEpoch: 3, closed: true, listenerOpen: true })
      expect(recovered.tunnels).toMatchObject([{ id: receipt.tunnels[0]!.id,
        localClosed: true, transportClosed: true, closed: true }])
      expect(recovered.tunnels[0]?.error).toBeUndefined()
      expect(owner.opens).toHaveLength(1)
      expect(proxy.quiesce(3)).toBe(retry)
      expect(proxy.resume(3)).toBe(true)
      await connected(proxy, port)
      owner.setCloseMode(mode)
      expect(await proxy.close()).toMatchObject({ closed: false, listenerClosed: true })
      expect(proxy.resume(3)).toBe(false)
      owner.setCloseMode("confirmed")
      const closeRetry = proxy.close()
      expect(proxy.close()).toBe(closeRetry)
      expect(await closeRetry).toMatchObject({ closed: true, listenerClosed: true, listenerOpen: false })
      expect(owner.opens).toHaveLength(2)
      expect(proxy.close()).toBe(closeRetry)
    } finally { await proxy.close(); await closeServer(server) }
  })
