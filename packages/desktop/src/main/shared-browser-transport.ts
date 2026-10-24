import { Resolver } from "node:dns/promises"
import { getServers } from "node:dns"
import { createConnection, isIP } from "node:net"
import type { Socket } from "node:net"
import { request } from "node:https"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { SharedBrowserSchema } from "@deepagent-code/core/browser/shared-schema"
import { BrowserDNSMessage } from "./managed-browser-dns-message"
import { publicAddress } from "./managed-browser-network"

/** A local adapter for the upstream proxy Transport. DNS is resolved once and the
 * socket connects to that exact vetted IP; Chromium still owns website TLS/cookies. */
export function createSharedBrowserTransport(input: {
  policy: SharedBrowserSchema.Policy
  current: () => { epoch: number; origins: readonly string[]; open: boolean }
}) {
  const sockets = new Map<string, Socket>()
  const servers = getServers()
  const check = (epoch: number, signal: AbortSignal) => {
    if (signal.aborted || !input.current().open || input.current().epoch !== epoch)
      throw new Error("BROWSER_CANCELLED")
  }
  const resolve = async (hostname: string, signal: AbortSignal) => {
    if (isIP(hostname)) return [hostname]
    if (input.policy.resolverPolicy !== "system") {
      const endpoint = input.policy.resolverPolicy === "alidns_doh_v1"
        ? { hostname: "dns.alidns.com", address: "223.5.5.5" }
        : { hostname: "cloudflare-dns.com", address: "1.1.1.1" }
      return (await Promise.all(([1, 28] as const).map(async (type) => {
        const message = BrowserDNSMessage.question(hostname, type)
        const response = await new Promise<import("node:http").IncomingMessage>((accept, reject) => {
          const query = request({ hostname: endpoint.hostname, port: 443, method: "POST", path: "/dns-query",
            // Both trusted DoH bootstraps are exact IPv4 pins. Keep Node's
            // single-address lookup contract instead of auto-family's array form.
            family: 4,
            lookup: (_hostname, _options, callback) => callback(null, endpoint.address, 4),
            rejectUnauthorized: true, minVersion: "TLSv1.2", agent: false, signal,
            timeout: 2_000, maxHeaderSize: 8192,
            headers: { accept: "application/dns-message", "content-type": "application/dns-message",
              "content-length": message.length, "accept-encoding": "identity" } }, accept)
          query.once("error", reject)
          query.once("timeout", () => query.destroy(new Error("BROWSER_NETWORK_DENIED")))
          query.end(message)
        })
        try {
          if (response.statusCode !== 200 || response.headers["content-type"] !== "application/dns-message" ||
            ![undefined, "identity"].includes(response.headers["content-encoding"])) throw new Error("BROWSER_NETWORK_DENIED")
          const chunks: Buffer[] = []
          let bytes = 0
          for await (const chunk of response) {
            const data = Buffer.from(chunk)
            bytes += data.length
            if (bytes > 65535) throw new Error("BROWSER_OUTPUT_LIMIT")
            chunks.push(data)
          }
          const answer = BrowserDNSMessage.response(Buffer.concat(chunks), hostname, type)
          if (answer.allAddresses.some((address) => !publicAddress(address))) throw new Error("BROWSER_NETWORK_DENIED")
          return answer.addresses
        } finally { response.destroy() }
      }))).flat()
    }
    const resolver = new Resolver({ timeout: 2_000, tries: 1 })
    resolver.setServers(servers)
    const abort = () => resolver.cancel()
    signal.addEventListener("abort", abort, { once: true })
    try {
      return (await Promise.all([resolver.resolve4(hostname), resolver.resolve6(hostname)].map((query) =>
        query.catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENODATA" || error.code === "ENOTFOUND") return []
          throw error
        })))).flat()
    } finally { signal.removeEventListener("abort", abort); resolver.cancel() }
  }
  return {
    async open(target: { host: string; port: number }, signal: AbortSignal) {
      const captured = input.current()
      check(captured.epoch, signal)
      if (sockets.size >= 64 || process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("BROWSER_NETWORK_DENIED")
      const origins = captured.origins.filter((origin) => {
        const url = new URL(origin)
        return url.hostname.replace(/^\[|\]$/g, "") === target.host &&
          Number(url.port || (url.protocol === "https:" ? 443 : 80)) === target.port
      })
      if (!origins.length) throw new Error("BROWSER_NETWORK_DENIED")
      const loopback = origins.every((origin) => new URL(origin).protocol === "http:" && ["127.0.0.1", "::1"].includes(target.host))
      const addresses = [...new Set(await resolve(target.host, signal))]
      check(captured.epoch, signal)
      if (!addresses.length || addresses.length > 32 || addresses.some((address) => !isIP(address) ||
        (loopback ? !["127.0.0.1", "::1"].includes(address) : !publicAddress(address)))) throw new Error("BROWSER_NETWORK_DENIED")
      const address = addresses[0]!
      const socket = createConnection({ host: address, port: target.port, allowHalfOpen: true, signal })
      const id = randomUUID()
      sockets.set(id, socket)
      socket.on("error", () => {})
      socket.once("close", () => sockets.delete(id))
      const timer = setTimeout(() => socket.destroy(new Error("BROWSER_NETWORK_DENIED")), 2_000)
      try {
        await once(socket, "connect", { signal })
        check(captured.epoch, signal)
        if (socket.remoteAddress !== address) throw new Error("BROWSER_NETWORK_DENIED")
        socket.setNoDelay(true)
        return id
      } catch (error) { socket.destroy(); throw error }
      finally { clearTimeout(timer) }
    },
    async read(id: string, signal: AbortSignal): Promise<{ data: Uint8Array; eof: boolean }> {
      const socket = sockets.get(id)
      if (!socket) throw new Error("BROWSER_CANCELLED")
      while (!socket.readableLength && !socket.readableEnded && !socket.destroyed) await once(socket, "readable", { signal })
      const data: Buffer | null = socket.read(Math.min(socket.readableLength, 65536))
      return { data: data ?? new Uint8Array(), eof: !data && (socket.readableEnded || socket.destroyed) }
    },
    async write(id: string, data: Uint8Array, end: boolean, signal: AbortSignal) {
      const socket = sockets.get(id)
      if (!socket || signal.aborted || socket.destroyed) throw new Error("BROWSER_CANCELLED")
      await new Promise<void>((accept, reject) => {
        const done = (error?: Error | null) => error ? reject(error) : accept()
        if (end) { socket.end(data, done); return }
        socket.write(data, done)
      })
    },
    async close(id: string) {
      const socket = sockets.get(id)
      if (!socket) return true
      return new Promise<boolean>((accept) => {
        const timer = setTimeout(() => accept(false), 1_500)
        socket.once("close", () => { clearTimeout(timer); accept(true) })
        socket.destroy()
      })
    },
  }
}
