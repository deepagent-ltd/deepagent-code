import { createSignal, createEffect, onCleanup } from "solid-js"
import type { IMMessage } from "@/components/im/types"
import type { IMClient } from "@/utils/im-client"

// One live snapshot of a part of an in-flight agent turn (reasoning / assistant
// text / tool activity). The client keeps a map keyed by `partID` and REPLACES
// each entry as batches arrive, so a dropped/reordered batch self-heals on the
// next snapshot. `order` gives stable render order.
export interface AgentProgressPart {
  partID: string
  order: number
  kind: "reasoning" | "text" | "tool"
  text?: string
  tool?: string
  status?: string
}

// WebSocket event types
export type IMWebSocketEvent =
  | { type: "message_created"; data: IMMessage }
  | { type: "message_failed"; data: { clientMessageID?: string; code: string; message: string; retryable: boolean } }
  | { type: "agent_status"; data: { messageID: string; agentID: string; status: string; error?: any } }
  | { type: "agent_progress"; data: { messageID: string; agentID: string; parts: AgentProgressPart[] } }
  | { type: "typing"; data: { groupID: string; memberID: string; typing: boolean } }
  | { type: "read_receipt"; data: { groupID: string; memberID: string; readAt: number } }
  | { type: "ping"; data: { ts: number } }
  | { type: "pong"; data: { ts: number } }

// Client -> Server events the UI can send.
export type IMClientEvent =
  | { type: "typing"; data: { groupID: string; memberID: string; typing: boolean } }
  | { type: "read_receipt"; data: { groupID: string; memberID: string; readAt: number } }
  | { type: "ping"; data: { ts: number } }
  | { type: "pong"; data: { ts: number } }

export interface LocalMessage extends IMMessage {}

/**
 * IM WebSocket hook for real-time communication with auto-reconnect.
 * Rewritten for SolidJS reactivity system.
 */
export function useIMWebSocket(client: IMClient, groupID: () => string | null) {
  const [ws, setWs] = createSignal<WebSocket | null>(null)
  const [connected, setConnected] = createSignal(false)
  const [reconnectAttempt, setReconnectAttempt] = createSignal(0)
  const [messages, setMessages] = createSignal<LocalMessage[]>([])
  const [agentStatuses, setAgentStatuses] = createSignal<Map<string, { agentID: string; status: string }>>(new Map())
  // trigger messageID -> ordered live reasoning/tool/text parts for that turn.
  // Parts are keyed by partID within each turn and REPLACED as batches arrive.
  const [agentProgress, setAgentProgress] = createSignal<Map<string, AgentProgressPart[]>>(new Map())
  // memberID -> last read timestamp, populated from read_receipt events.
  const [readReceipts, setReadReceipts] = createSignal<Map<string, number>>(new Map())
  // memberIDs currently typing (excluding self, resolved by the caller).
  const [typingMembers, setTypingMembers] = createSignal<Set<string>>(new Set())
  const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const connect = () => {
    const currentGroupID = groupID()
    if (!currentGroupID) return

    // Construct authenticated WebSocket URL (base URL + directory + auth_token).
    // Browsers can't set headers on WebSocket, so auth travels as a query param
    // just like the PTY connect endpoint. In Server Edition mode the gateway
    // reads an `access_token` cookie instead, which we set here first.
    client.setWebSocketAuthCookie()
    const socket = new WebSocket(client.webSocketURL(currentGroupID))

    socket.onopen = () => {
      console.log("IM WebSocket connected")
      setConnected(true)
      setReconnectAttempt(0)
    }

    socket.onclose = (event) => {
      console.log("IM WebSocket disconnected", event.code, event.reason)
      setConnected(false)
      setWs(null)

      // Auto-reconnect with exponential backoff
      if (!event.wasClean) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempt()), 30000)
        console.log(`Reconnecting in ${delay}ms...`)
        setTimeout(() => {
          setReconnectAttempt((prev) => prev + 1)
          connect()
        }, delay)
      }
    }

    socket.onerror = (error) => {
      console.error("IM WebSocket error:", error)
    }

    socket.onmessage = (event) => {
      try {
        const wsEvent = JSON.parse(event.data) as IMWebSocketEvent

        switch (wsEvent.type) {
          case "message_created":
            setMessages((prev) => [...prev, wsEvent.data])
            break

          case "message_failed":
            console.error("IM message failed:", wsEvent.data.message)
            break

          case "agent_status":
            setAgentStatuses((prev) => {
              const next = new Map(prev)
              next.set(wsEvent.data.messageID, {
                agentID: wsEvent.data.agentID,
                status: wsEvent.data.status,
              })
              return next
            })
            break

          case "agent_progress":
            // Merge the batch into this turn's parts: replace by partID (a part
            // may update many times), then re-sort by `order` so the reasoning
            // card renders in production order regardless of batch arrival.
            setAgentProgress((prev) => {
              const next = new Map(prev)
              const existing = next.get(wsEvent.data.messageID) ?? []
              const byPart = new Map(existing.map((p) => [p.partID, p]))
              for (const part of wsEvent.data.parts) byPart.set(part.partID, part)
              const merged = Array.from(byPart.values()).sort((a, b) => a.order - b.order)
              next.set(wsEvent.data.messageID, merged)
              return next
            })
            break

          case "ping":
            // Respond to ping
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "pong", data: { ts: wsEvent.data.ts } }))
            }
            break

          case "typing":
            setTypingMembers((prev) => {
              const next = new Set(prev)
              if (wsEvent.data.typing) next.add(wsEvent.data.memberID)
              else next.delete(wsEvent.data.memberID)
              return next
            })
            // Auto-expire a "typing" flag if no follow-up stop arrives.
            if (wsEvent.data.typing) {
              const memberID = wsEvent.data.memberID
              const existing = typingTimers.get(memberID)
              if (existing) clearTimeout(existing)
              typingTimers.set(
                memberID,
                setTimeout(() => {
                  setTypingMembers((prev) => {
                    const next = new Set(prev)
                    next.delete(memberID)
                    return next
                  })
                  typingTimers.delete(memberID)
                }, 5000),
              )
            }
            break

          case "read_receipt":
            setReadReceipts((prev) => {
              const next = new Map(prev)
              next.set(wsEvent.data.memberID, wsEvent.data.readAt)
              return next
            })
            break

          case "pong":
            // Heartbeat acknowledged.
            break
        }
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error)
      }
    }

    // Send periodic ping
    const pingInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping", data: { ts: Date.now() } }))
      }
    }, 30000)

    setWs(socket)

    // Cleanup function
    return () => {
      clearInterval(pingInterval)
      socket.close()
    }
  }

  // SolidJS effect to manage connection lifecycle.
  // Tracks groupID() so switching groups tears down the old socket and
  // reconnects to the new one. Realtime buffers are reset per group.
  createEffect(() => {
    const currentGroupID = groupID()
    if (!currentGroupID) return

    setMessages([])
    setAgentStatuses(new Map())
    setAgentProgress(new Map())
    setReadReceipts(new Map())
    setTypingMembers(new Set<string>())
    for (const timer of typingTimers.values()) clearTimeout(timer)
    typingTimers.clear()

    const cleanup = connect()

    onCleanup(() => {
      cleanup?.()
      for (const timer of typingTimers.values()) clearTimeout(timer)
      typingTimers.clear()
    })
  })

  const send = (event: IMClientEvent) => {
    const socket = ws()
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event))
    }
  }

  const reconnect = () => {
    const currentWs = ws()
    if (currentWs) {
      currentWs.close()
    }
    setReconnectAttempt(0)
    connect()
  }

  return {
    connected,
    messages,
    agentStatuses,
    agentProgress,
    readReceipts,
    typingMembers,
    send,
    reconnect,
  }
}
