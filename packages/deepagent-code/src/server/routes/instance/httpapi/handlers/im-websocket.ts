import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { IMRepository, IMRepositoryError } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import type { IMWebSocketConnection, ClientEvent, ServerEvent } from "@deepagent-code/core/im/websocket"
import { WebSocketTracker } from "../websocket-tracker"
import { IMWebSocketApi } from "../groups/im-websocket"
import { getWorkspaceContext } from "../utils/workspace-context"

// WebSocket configuration - can be overridden by environment variables
const HEARTBEAT_INTERVAL = parseInt(process.env.IM_WEBSOCKET_HEARTBEAT_INTERVAL || "30000", 10) // 30 seconds
const HEARTBEAT_TIMEOUT = parseInt(process.env.IM_WEBSOCKET_HEARTBEAT_TIMEOUT || "35000", 10) // 35 seconds
const MAX_CONNECTIONS_PER_USER_PER_GROUP = parseInt(
  process.env.IM_WEBSOCKET_MAX_CONNECTIONS_PER_USER_PER_GROUP || "5",
  10,
)

function isAllowedOrigin(request: HttpServerRequest.HttpServerRequest): boolean {
  const origin = request.headers.origin
  if (!origin) return true // Non-browser clients may omit Origin

  const host = request.headers.host
  if (!host) return false

  try {
    const originURL = new URL(origin)
    return originURL.host === host
  } catch {
    return false
  }
}

export const imWebSocketHandlers = HttpApiBuilder.group(IMWebSocketApi, "im-websocket", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* IMRepository
    const broadcaster = yield* IMBroadcasterService

    return handlers.handleRaw(
      "connect",
      (ctx: { params: { groupId: string }; request: HttpServerRequest.HttpServerRequest }) =>
        Effect.gen(function* () {
          const { workspaceID, userID } = yield* getWorkspaceContext()
          const groupId = ctx.params.groupId

          if (!isAllowedOrigin(ctx.request)) {
            return HttpServerResponse.text("Forbidden origin", { status: 403 })
          }

          // Check if user has access to the group
          const group = yield* repo.getGroup({ groupID: groupId, userID })
          if (!group) {
            return HttpServerResponse.text("Group not found or access denied", { status: 404 })
          }

          if (broadcaster.getUserConnectionCount(groupId, userID) >= MAX_CONNECTIONS_PER_USER_PER_GROUP) {
            return HttpServerResponse.text("Too many WebSocket connections", { status: 429 })
          }

          // Upgrade to WebSocket
          const socket = yield* Effect.orDie(ctx.request.upgrade)
          const write = yield* socket.writer

          // Create connection object
          let connection: IMWebSocketConnection | null = null
          let lastPingTime = Date.now()
          let heartbeatTimer: NodeJS.Timeout | null = null

          const send = (event: ServerEvent) => {
            if (!connection) return
            Effect.runFork(write(JSON.stringify(event)).pipe(Effect.catch(() => Effect.void)))
          }

          const close = (code?: number, reason?: string) => {
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer)
              heartbeatTimer = null
            }
            Effect.runFork(write(new Socket.CloseEvent(code, reason)).pipe(Effect.catch(() => Effect.void)))
          }

          connection = {
            groupID: groupId,
            userID,
            workspaceID,
            send,
            close,
          }

          // Register connection
          broadcaster.register(connection)

          const registered = yield* WebSocketTracker.register(
            Effect.sync(() => {
              close(1001, "server closing")
            }),
          )
          if (!registered) {
            close(1001, "server closing")
            return HttpServerResponse.empty()
          }

          // Setup heartbeat check
          heartbeatTimer = setInterval(() => {
            const now = Date.now()
            if (now - lastPingTime > HEARTBEAT_TIMEOUT) {
              // Client hasn't sent ping in time, close connection
              close(1000, "Heartbeat timeout")
            } else {
              // Send ping to client
              send({
                type: "ping",
                data: { ts: now },
              })
            }
          }, HEARTBEAT_INTERVAL)

          // Cleanup function to ensure resources are freed
          const cleanup = Effect.gen(function* () {
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer)
              heartbeatTimer = null
            }
            if (connection) {
              broadcaster.unregister(connection)
              connection = null
            }
          })

          // Handle incoming messages
          const messageHandler = socket
            .runString((message) =>
              Effect.gen(function* () {
                try {
                  const event = JSON.parse(message) as ClientEvent

                  // Update last ping time on any client message
                  lastPingTime = Date.now()

                  // Handle different event types
                  switch (event.type) {
                    case "ping":
                      send({
                        type: "pong",
                        data: { ts: event.data.ts },
                      })
                      break

                    case "pong":
                      // Client acknowledged our ping
                      break

                    case "typing":
                      // Broadcast typing status to other users in the group
                      broadcaster.broadcast(groupId, event)
                      break

                    case "read_receipt":
                      // Update read status
                      yield* repo.markRead({
                        groupID: groupId,
                        memberID: userID,
                        readAt: event.data.readAt,
                      })
                      // Broadcast read receipt
                      broadcaster.broadcast(groupId, event)
                      break
                  }
                } catch (error) {
                  console.error("Failed to parse WebSocket message:", error)
                }
              }),
            )
            .pipe(
              // Ensure cleanup happens even on errors
              Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
              Effect.ensuring(cleanup),
            )

          // Run message handler
          yield* messageHandler

          return HttpServerResponse.empty()
        }).pipe(
          Effect.catchIf(
            (error): error is IMRepositoryError => error instanceof IMRepositoryError,
            (error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 500 })),
          ),
        ),
    )
  }),
)
