import { Deferred, Effect, Option, Queue, Ref, Schema, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { IMRepository, IMRepositoryError } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { ClientEvent, type IMWebSocketConnection, type ServerEvent } from "@deepagent-code/core/im/websocket"
import { WebSocketTracker } from "../websocket-tracker"
import { IMWebSocketApi } from "../groups/im-websocket"
import { getWorkspaceContext } from "../utils/workspace-context"
import { boundedPositiveInteger } from "./im-config"
import { CorsConfig, isAllowedRequestOrigin } from "@/server/cors"
import { IMFacade } from "@/im/facade"
import { KernelReaderSchema } from "@deepagent-code/core/im/kernel-reader.schema"

// WebSocket configuration - can be overridden by environment variables
const HEARTBEAT_INTERVAL = boundedPositiveInteger(process.env.IM_WEBSOCKET_HEARTBEAT_INTERVAL, 30_000, 300_000)
const HEARTBEAT_TIMEOUT = boundedPositiveInteger(process.env.IM_WEBSOCKET_HEARTBEAT_TIMEOUT, 35_000, 600_000)
const MAX_CONNECTIONS_PER_USER_PER_GROUP = boundedPositiveInteger(
  process.env.IM_WEBSOCKET_MAX_CONNECTIONS_PER_USER_PER_GROUP,
  5,
  32,
)
export const MAX_OUTGOING_EVENTS = 128
const decodeClientEvent = Schema.decodeUnknownOption(Schema.fromJsonString(ClientEvent))

export const imWebSocketHandlers = () =>
  HttpApiBuilder.group(IMWebSocketApi, "im-websocket", (handlers) =>
    Effect.gen(function* () {
      const repo = yield* IMRepository
      const broadcaster = yield* IMBroadcasterService
      const cors = yield* CorsConfig
      const facade = Option.getOrUndefined(yield* Effect.serviceOption(IMFacade.Service))

      return handlers.handleRaw(
        "connect",
        (ctx: { params: { groupId: string }; request: HttpServerRequest.HttpServerRequest }) =>
          Effect.gen(function* () {
            const context = yield* getWorkspaceContext()
            const workspaceID = context.workspaceID
            const userID = context.userID
            const groupId = ctx.params.groupId

            if (!isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors)) {
              return HttpServerResponse.text("Forbidden origin", { status: 403 })
            }

            // A WebSocket keeps its original owner through every frame. A new
            // credential generation or instance cannot lend it a replacement reader.
            const acquired = facade && Option.isSome(yield* Ref.get(facade.engine))
              ? yield* facade.acquireReader(context).pipe(Effect.catch((error) => Effect.succeed(error)))
              : undefined
            if (acquired instanceof KernelReaderSchema.Error) {
              return HttpServerResponse.text(acquired.code, { status: acquired.code === "reader_capacity" ? 429 : 503 })
            }
            const currentFrame = <A, E, R>(effect: Effect.Effect<A, E, R>) => acquired
              ? acquired.assertCurrent.pipe(Effect.andThen(acquired.reader.withOutput({ workspaceID, userID, groupIDs: [groupId] }, effect)))
              : effect
            const group = yield* currentFrame(repo.getGroup({ groupID: groupId, workspaceID, userID })).pipe(Effect.orElseSucceed(() => undefined))
            if (!group) {
              return HttpServerResponse.text("Group not found or access denied", { status: 404 })
            }

            if (broadcaster.getUserConnectionCount(groupId, userID) >= MAX_CONNECTIONS_PER_USER_PER_GROUP) {
              return HttpServerResponse.text("Too many WebSocket connections", { status: 429 })
            }

            // Upgrade to WebSocket
            const socket = yield* Effect.orDie(ctx.request.upgrade)
            const write = yield* socket.writer
            const outgoing = yield* Queue.dropping<ServerEvent>(MAX_OUTGOING_EVENTS)
            const closeRequested = yield* Deferred.make<Socket.CloseEvent>()

            const writeCloseFrame = Deferred.await(closeRequested).pipe(
              Effect.flatMap((event) => write(event).pipe(Effect.timeout("1 second"))),
              Effect.catch(() => Effect.void),
            )

            // The writer is gated on the socket run loop: its latch opens only once
            // runRaw acquires the upgraded WebSocket, and handleUpgrade (the 101
            // response) runs inside the loop too. A refusal therefore starts the
            // loop before flushing — otherwise the close frame waits on the latch
            // until the 1s budget cuts it and the client hangs on a bare FIN.
            const refuseWithCloseFrame = Effect.gen(function* () {
              yield* socket
                .runRaw(() => Effect.void)
                .pipe(
                  Effect.catch(() => Effect.void),
                  Effect.forkScoped,
                )
              yield* writeCloseFrame
            })

            // Create connection object
            let connection: IMWebSocketConnection | null = null
            let lastPingTime = Date.now()
            let heartbeatTimer: NodeJS.Timeout | null = null
            let closing = false

            const send = (event: ServerEvent) => {
              if (!connection || closing) return
              if (Queue.offerUnsafe(outgoing, event)) return
              closing = true
              Deferred.doneUnsafe(
                closeRequested,
                Effect.succeed(new Socket.CloseEvent(1013, `Slow WebSocket consumer (queue ${MAX_OUTGOING_EVENTS})`)),
              )
            }

            const close = (code?: number, reason?: string) => {
              if (closing) return
              closing = true
              if (heartbeatTimer) {
                clearInterval(heartbeatTimer)
                heartbeatTimer = null
              }
              Deferred.doneUnsafe(closeRequested, Effect.succeed(new Socket.CloseEvent(code, reason)))
            }

            connection = {
              groupID: groupId,
              userID,
              workspaceID,
              send,
              close,
            }

            const registration = yield* WebSocketTracker.register(
              Effect.sync(() => {
                close(1001, "server closing")
              }),
            )
            if (!registration.accepted) {
              close(1001, "server closing")
              yield* refuseWithCloseFrame
              return HttpServerResponse.empty()
            }

            // Register connection only after the listener accepts ownership.
            if (!broadcaster.register(connection, MAX_CONNECTIONS_PER_USER_PER_GROUP)) {
              close(1013, "WebSocket capacity exceeded")
              yield* refuseWithCloseFrame
              return HttpServerResponse.empty()
            }

            if (group.reader && acquired) {
              const release = acquired.reader.watchGroup(groupId)
              yield* Effect.addFinalizer(() => Effect.sync(release))
            }

            yield* Stream.fromQueue(outgoing).pipe(
              Stream.runForEach((event) => {
                if (event.type === "reader_invalidated") return write(JSON.stringify(event)).pipe(
                  Effect.ensuring(Effect.sync(() => close(1008, "Remote conversation is currently unavailable"))),
                )
                return currentFrame(Effect.gen(function* () {
                  const fresh = yield* repo.getGroup({ groupID: groupId, workspaceID, userID })
                  if (!fresh) return yield* KernelReaderSchema.failure("reader_unavailable", "websocket")
                  const protectedEvent = fresh.reader && ["message_created", "agent_progress", "agent_status", "read_receipt"].includes(event.type)
                  const safe = protectedEvent ? { type: "reader_changed" as const, data: { groupID: groupId, displayEpoch: acquired?.reader.runtime.displayEpoch ?? "unavailable" } } : event
                  yield* write(JSON.stringify(safe))
                })).pipe(Effect.catch(() => Effect.gen(function* () {
                  yield* write(JSON.stringify({ type: "reader_invalidated", data: { groupID: groupId, displayEpoch: "unavailable", code: "reader_unavailable" } }))
                  close(1008, "Remote conversation is currently unavailable")
                })))
              }),
              Effect.onError(() =>
                Effect.sync(() => {
                  close(1011, "WebSocket write failed")
                }),
              ),
              Effect.forkScoped,
            )

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
              yield* Queue.shutdown(outgoing)
            })

            // Handle incoming messages
            const messageHandler = socket
              .runString((message) =>
                Effect.gen(function* () {
                  const decoded = decodeClientEvent(message)
                  if (Option.isNone(decoded)) {
                    close(1003, "Invalid WebSocket message")
                    return
                  }
                  const event = decoded.value
                  const current = yield* currentFrame(repo.getGroup({ groupID: groupId, workspaceID, userID })).pipe(Effect.option)
                  if (Option.isNone(current) || current.value === undefined) {
                    close(1008, "Conversation access is no longer available")
                    return
                  }

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
                      broadcaster.broadcast(groupId, {
                        type: "typing",
                        data: { groupID: groupId, memberID: userID, typing: event.data.typing },
                      })
                      break

                    case "read_receipt": {
                      if (current.value.reader) {
                        send({ type: "message_failed", data: { code: "reader_required", message: "Protected conversations require an explicit read action", retryable: false } })
                        break
                      }
                      const readAt = Date.now()
                      yield* repo.markRead({ groupID: groupId, memberID: userID, readAt })
                      broadcaster.broadcast(groupId, {
                        type: "read_receipt",
                        data: { groupID: groupId, memberID: userID, readAt },
                      })
                      break
                    }
                  }
                }),
              )
              .pipe(
                // Ensure cleanup happens even on errors
                Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
                Effect.ensuring(cleanup),
              )

            // Run message handler
            yield* Effect.raceAll([messageHandler, registration.shutdown, writeCloseFrame])

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
