import { Context, Effect, Layer } from "effect"
import type { IMBroadcaster, IMWebSocketConnection, ServerEvent } from "./websocket"

export const MAX_CONNECTIONS = 1024
export const MAX_CONNECTIONS_PER_GROUP = 128

// Broadcaster 实现
class IMBroadcasterImpl implements IMBroadcaster {
  // groupID -> Set<IMWebSocketConnection>
  private connections = new Map<string, Set<IMWebSocketConnection>>()
  private total = 0

  broadcast(groupID: string, event: ServerEvent): void {
    const connections = this.connections.get(groupID)
    if (!connections) return

    for (const conn of connections) {
      try {
        conn.send(event)
      } catch (error) {
        console.error(`Failed to send to connection in group ${groupID}:`, error, (error as Error).stack)
      }
    }
  }

  sendToUser(groupID: string, userID: string, event: ServerEvent): void {
    const connections = this.connections.get(groupID)
    if (!connections) return

    for (const conn of connections) {
      if (conn.userID === userID) {
        try {
          conn.send(event)
        } catch (error) {
          console.error(`Failed to send to user ${userID} in group ${groupID}:`, error, (error as Error).stack)
        }
      }
    }
  }

  register(conn: IMWebSocketConnection, maxConnectionsPerUser?: number): boolean {
    const current = this.connections.get(conn.groupID)
    if (current?.has(conn)) return true
    if (this.total >= MAX_CONNECTIONS || (current?.size ?? 0) >= MAX_CONNECTIONS_PER_GROUP) return false
    if (
      maxConnectionsPerUser !== undefined &&
      current !== undefined &&
      Array.from(current).filter((candidate) => candidate.userID === conn.userID).length >= maxConnectionsPerUser
    )
      return false
    let groupConnections = current
    if (!groupConnections) {
      groupConnections = new Set()
      this.connections.set(conn.groupID, groupConnections)
    }
    groupConnections.add(conn)
    this.total++
    return true
  }

  unregister(conn: IMWebSocketConnection): void {
    const groupConnections = this.connections.get(conn.groupID)
    if (!groupConnections) return

    if (groupConnections.delete(conn)) this.total--
    if (groupConnections.size === 0) {
      this.connections.delete(conn.groupID)
    }
  }

  getConnectionCount(groupID: string): number {
    return this.connections.get(groupID)?.size ?? 0
  }

  getUserConnectionCount(groupID: string, userID: string): number {
    const connections = this.connections.get(groupID)
    if (!connections) return 0
    let count = 0
    for (const conn of connections) {
      if (conn.userID === userID) count++
    }
    return count
  }
}

// Effect Service
export class IMBroadcasterService extends Context.Service<IMBroadcasterService, IMBroadcaster>()(
  "@deepagent-code/im/Broadcaster",
) {}

export const IMBroadcasterLive = Layer.sync(IMBroadcasterService, () => new IMBroadcasterImpl())
