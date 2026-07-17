import { Effect, Scope } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { IMRepository, IMRepositoryError } from "@deepagent-code/core/im/repository"
import { IMBroadcasterService } from "@deepagent-code/core/im/broadcaster"
import { InstanceHttpApi } from "../api"
import {
  IMGroupNotFoundError,
  IMMessageNotFoundError,
  IMMessageTooLargeError,
  IMRateLimitExceededError,
  IMInternalServerError,
} from "../groups/im"
import { MentionParser } from "@deepagent-code/core/im/mention-parser"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import { executeAgentMentions } from "@deepagent-code/core/im/agent-orchestrator"
import { getWorkspaceContext } from "../utils/workspace-context"

const IM_MAX_MESSAGE_LENGTH = 100000 // 增加到 100k，更灵活

// Simple in-memory rate limiter
class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>()

  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now()
    const bucket = this.buckets.get(key)

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }

    if (bucket.count >= limit) {
      return false
    }

    bucket.count++
    return true
  }

  cleanup() {
    const now = Date.now()
    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key)
      }
    }
  }
}

const rateLimiter = new RateLimiter()
// Cleanup every 5 minutes
setInterval(() => rateLimiter.cleanup(), 5 * 60 * 1000)

const mapRepositoryError = <A, E, R>(effect: Effect.Effect<A, E | IMRepositoryError, R>) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is IMRepositoryError => error instanceof IMRepositoryError,
      (error) =>
        Effect.fail(
          new IMInternalServerError({
            name: "INTERNAL_SERVER_ERROR",
            data: { message: error.message },
          }),
        ),
    ),
  )

// 配置：可以通过环境变量调整
const getRateLimit = () => parseInt(process.env.IM_RATE_LIMIT_PER_MINUTE || "200", 10) // 默认 200/分钟，更宽松
const getMaxMessageLength = () => parseInt(process.env.IM_MAX_MESSAGE_LENGTH || "100000", 10) // 默认 100k

export const imHandlers = HttpApiBuilder.group(InstanceHttpApi, "im", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* IMRepository
    const broadcaster = yield* IMBroadcasterService
    const agentListProvider = yield* AgentListProviderService
    // Long-lived scope for detached agent runs. Forking into the SERVER scope (not
    // the request scope) means the agent keeps running after the HTTP response is
    // sent, while still inheriting the request fiber's full context — crucially the
    // InstanceRef/WorkspaceRef that SessionPrompt needs for the worktree/directory.
    const serverScope = yield* Scope.Scope

    return handlers
      .handle("listGroups", ({ query }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { workspaceID, userID } = yield* getWorkspaceContext(query)

            const groups = yield* repo.listGroups({ workspaceID, userID })

            return groups.map((g) => ({
              id: g.id,
              workspaceID: g.workspaceID,
              projectID: g.projectID,
              type: g.type,
              name: g.name,
              createdBy: g.createdBy,
              createdAt: g.createdAt,
              updatedAt: g.updatedAt,
            }))
          }),
        ),
      )
      .handle("createGroup", ({ query, payload }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { workspaceID, userID } = yield* getWorkspaceContext(query)

            const group = yield* repo.createGroup({
              workspaceID,
              projectID: payload.projectID,
              type: payload.type,
              name: payload.name,
              createdBy: userID,
            })

            return {
              id: group.id,
              workspaceID: group.workspaceID,
              projectID: group.projectID,
              type: group.type,
              name: group.name,
              createdBy: group.createdBy,
              createdAt: group.createdAt,
              updatedAt: group.updatedAt,
            }
          }),
        ),
      )
      .handle("listMessages", ({ params, query }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { userID } = yield* getWorkspaceContext(query)
            const groupId = params.groupId

            // Check if group exists and user has access
            const group = yield* repo.getGroup({ groupID: groupId, userID })
            if (!group) {
              return yield* Effect.fail(
                new IMGroupNotFoundError({
                  name: "GROUP_NOT_FOUND",
                  data: { message: `Group ${groupId} not found` },
                }),
              )
            }

            const limit = query.limit ?? 50
            const page = yield* repo.listMessages({
              groupID: groupId,
              cursor: query.cursor,
              limit,
            })

            return {
              messages: page.messages.map((m) => ({
                id: m.id,
                groupID: m.groupID,
                senderID: m.senderID,
                senderType: m.senderType,
                type: m.type,
                content: m.content,
                mentions: m.mentions,
                metadata: m.metadata,
                replyToID: m.replyToID,
                createdAt: m.createdAt,
                updatedAt: m.updatedAt,
              })),
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            }
          }),
        ),
      )
      .handle("createMessage", ({ params, query, payload }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { workspaceID, directory, userID } = yield* getWorkspaceContext(query)
            const groupId = params.groupId

            // Validate message length
            const maxLength = getMaxMessageLength()
            if (payload.content.length > maxLength) {
              return yield* Effect.fail(
                new IMMessageTooLargeError({
                  name: "MESSAGE_TOO_LARGE",
                  data: {
                    message: `Message exceeds maximum length of ${maxLength} characters`,
                    maxLength,
                  },
                }),
              )
            }

            // Check rate limit
            const rateLimit = getRateLimit()
            const rateLimitKey = `${userID}:${groupId}`
            if (!rateLimiter.check(rateLimitKey, rateLimit, 60 * 1000)) {
              return yield* Effect.fail(
                new IMRateLimitExceededError({
                  name: "RATE_LIMIT_EXCEEDED",
                  data: {
                    message: `Rate limit exceeded. Maximum ${rateLimit} messages per minute per group.`,
                    retryAfter: 60,
                  },
                }),
              )
            }

            // Check if group exists
            const group = yield* repo.getGroup({ groupID: groupId, userID })
            if (!group) {
              return yield* Effect.fail(
                new IMGroupNotFoundError({
                  name: "GROUP_NOT_FOUND",
                  data: { message: `Group ${groupId} not found` },
                }),
              )
            }

            // Parse mentions from content
            const mentionedAgentNames = MentionParser.parse(payload.content)

            // Create message.
            // Force senderType to "user" — this endpoint is authenticated as a user,
            // so we must not trust the client-supplied senderType (which would let a
            // user forge "system"/"agent" messages that the UI renders specially).
            const message = yield* repo
              .createMessage({
                groupID: groupId,
                senderID: userID,
                senderType: "user",
                type: payload.type,
                content: payload.content,
                mentions: mentionedAgentNames, // Use parsed mentions
                metadata: payload.metadata,
                replyToID: payload.replyToID,
              })
              .pipe(
                Effect.tap((msg) =>
                  Effect.sync(() => {
                    // Broadcast message_created event via WebSocket
                    broadcaster.broadcast(groupId, {
                      type: "message_created",
                      data: {
                        id: msg.id,
                        groupID: msg.groupID,
                        senderID: msg.senderID,
                        senderType: msg.senderType,
                        messageType: msg.type,
                        content: msg.content,
                        mentions: msg.mentions,
                        metadata: msg.metadata,
                        replyToID: msg.replyToID,
                        createdAt: msg.createdAt,
                        updatedAt: msg.updatedAt,
                      },
                    })
                  }),
                ),
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    // Broadcast message_failed event
                    broadcaster.broadcast(groupId, {
                      type: "message_failed",
                      data: {
                        code: "MESSAGE_CREATE_FAILED",
                        message: String(error),
                        retryable: true,
                      },
                    })
                    return yield* Effect.fail(error)
                  }),
                ),
              )

            // Execute mentioned agents asynchronously (don't block the response).
            // Fork into the SERVER scope so the run outlives the HTTP response but
            // still inherits this request fiber's context — including the
            // InstanceRef/WorkspaceRef that the agent executor (SessionPrompt) needs
            // to locate the worktree/directory. A detached Effect.runFork would drop
            // those references and the agent would never actually run.
            if (mentionedAgentNames.length > 0) {
              yield* executeAgentMentions({
                workspaceID,
                directory,
                groupID: groupId,
                messageID: message.id,
                userID,
                content: payload.content,
                mentionedAgentNames,
              }).pipe(Effect.forkIn(serverScope, { startImmediately: true }))
            }

            return {
              id: message.id,
              groupID: message.groupID,
              senderID: message.senderID,
              senderType: message.senderType,
              type: message.type,
              content: message.content,
              mentions: message.mentions,
              metadata: message.metadata,
              replyToID: message.replyToID,
              createdAt: message.createdAt,
              updatedAt: message.updatedAt,
            }
          }),
        ),
      )
      .handle("markRead", ({ params, query, payload }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { userID } = yield* getWorkspaceContext(query)
            const groupId = params.groupId

            // Check if group exists
            const group = yield* repo.getGroup({ groupID: groupId, userID })
            if (!group) {
              return yield* Effect.fail(
                new IMGroupNotFoundError({
                  name: "GROUP_NOT_FOUND",
                  data: { message: `Group ${groupId} not found` },
                }),
              )
            }

            const readAt = payload.readAt ?? Date.now()
            yield* repo.markRead({
              groupID: groupId,
              memberID: userID,
              readAt,
            })

            return { ok: true }
          }),
        ),
      )
      .handle("listAgents", ({ query }) =>
        Effect.gen(function* () {
          const { workspaceID, userID } = yield* getWorkspaceContext(query)

          const agents = yield* agentListProvider.listAgents({ workspaceID, userID })

          // Descriptors already match the canonical `AgentDescriptor` wire shape
          // (V3.8.1 §C.3), including the optional metadata fields — return as-is.
          return agents
        }).pipe(
          Effect.catch((error) =>
            Effect.fail(
              new IMInternalServerError({
                name: "INTERNAL_SERVER_ERROR",
                data: { message: error instanceof Error ? error.message : String(error) },
              }),
            ),
          ),
        ),
      )
      .handle("getMessage", ({ params, query }) =>
        mapRepositoryError(
          Effect.gen(function* () {
            const { userID } = yield* getWorkspaceContext(query)
            const messageId = params.messageId

            // Use direct getMessage method
            const message = yield* repo.getMessage(messageId)

            if (!message) {
              return yield* Effect.fail(
                new IMMessageNotFoundError({
                  name: "MESSAGE_NOT_FOUND",
                  data: { message: `Message ${messageId} not found` },
                }),
              )
            }

            // Access control: verify the requesting user is a member of the message's
            // group. getGroup enforces membership; without this check any user could
            // read any message by ID (IDOR).
            const group = yield* repo.getGroup({ groupID: message.groupID, userID })
            if (!group) {
              return yield* Effect.fail(
                new IMMessageNotFoundError({
                  name: "MESSAGE_NOT_FOUND",
                  data: { message: `Message ${messageId} not found` },
                }),
              )
            }

            return {
              id: message.id,
              groupID: message.groupID,
              senderID: message.senderID,
              senderType: message.senderType,
              type: message.type,
              content: message.content,
              mentions: message.mentions,
              metadata: message.metadata,
              replyToID: message.replyToID,
              createdAt: message.createdAt,
              updatedAt: message.updatedAt,
            }
          }),
        ),
      )
  }),
)
