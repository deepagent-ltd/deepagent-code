import type { WebSocket } from "ws"
import type { ShareEntry } from "./store.ts"

/**
 * In-process pub/sub for live share updates.
 *
 * Replaces the Durable Object's `getWebSockets()` broadcast. Sockets are
 * grouped by share id; `publish` fans an entry out to every open subscriber.
 * This is single-process only, which matches the local-deployment target.
 */
export class Subscribers {
  private readonly byShare = new Map<string, Set<WebSocket>>()

  add(shareId: string, ws: WebSocket) {
    let set = this.byShare.get(shareId)
    if (!set) {
      set = new Set()
      this.byShare.set(shareId, set)
    }
    set.add(ws)

    const drop = () => {
      const current = this.byShare.get(shareId)
      if (!current) return
      current.delete(ws)
      if (current.size === 0) this.byShare.delete(shareId)
    }
    ws.on("close", drop)
    ws.on("error", drop)
  }

  publish(shareId: string, entry: ShareEntry) {
    const set = this.byShare.get(shareId)
    if (!set) return
    const payload = JSON.stringify(entry)
    for (const ws of set) {
      // ws.OPEN === 1
      if (ws.readyState === 1) ws.send(payload)
    }
  }
}
