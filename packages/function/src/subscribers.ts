import type { WebSocket } from "ws"
import type { ShareEntry } from "./store.ts"

const MaxSubscribers = 1_000
const MaxSubscribersPerShare = 32
const MaxBufferedBytes = 2 * 1024 * 1024

/**
 * In-process pub/sub for live share updates.
 *
 * Replaces the Durable Object's `getWebSockets()` broadcast. Sockets are
 * grouped by share id; `publish` fans an entry out to every open subscriber.
 * This is single-process only, which matches the local-deployment target.
 */
export class Subscribers {
  private readonly byShare = new Map<string, Set<WebSocket>>()
  private count = 0

  constructor(
    private readonly limits: {
      maxSubscribers?: number
      maxSubscribersPerShare?: number
      maxBufferedBytes?: number
    } = {},
  ) {}

  add(shareId: string, ws: WebSocket) {
    const set = this.byShare.get(shareId) ?? new Set<WebSocket>()
    if (set.has(ws)) return true
    if (this.count >= (this.limits.maxSubscribers ?? MaxSubscribers)) return false
    if (set.size >= (this.limits.maxSubscribersPerShare ?? MaxSubscribersPerShare)) return false
    if (!this.byShare.has(shareId)) this.byShare.set(shareId, set)
    set.add(ws)
    this.count++

    const drop = () => {
      const current = this.byShare.get(shareId)
      if (!current) return
      if (current.delete(ws)) this.count--
      if (current.size === 0) this.byShare.delete(shareId)
    }
    ws.on("close", drop)
    ws.on("error", drop)
    return true
  }

  publish(shareId: string, entry: ShareEntry) {
    const set = this.byShare.get(shareId)
    if (!set) return
    for (const ws of set) this.send(ws, entry)
  }

  send(ws: WebSocket, entry: ShareEntry) {
    if (ws.readyState !== 1) return false
    const payload = JSON.stringify(entry)
    if (ws.bufferedAmount + Buffer.byteLength(payload) > (this.limits.maxBufferedBytes ?? MaxBufferedBytes)) {
      ws.terminate()
      return false
    }
    ws.send(payload, (error) => {
      if (error) ws.terminate()
    })
    return true
  }

  stats() {
    return { subscribers: this.count, shares: this.byShare.size }
  }
}
