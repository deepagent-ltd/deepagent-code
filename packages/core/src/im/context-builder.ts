import { Effect, Layer } from "effect"
import type { AgentContext, AgentContextBuilder } from "./agent-executor"
import { AgentContextBuilderService } from "./agent-executor"
import { IMRepository, type IMRepositoryInterface } from "./repository"

/** Reads IM conversation metadata without performing graph retrieval. */
class AgentContextBuilderImpl implements AgentContextBuilder {
  constructor(private readonly repo: IMRepositoryInterface) {}

  build(input: {
    workspaceID: string
    groupID: string
    messageID: string
    task: string
    files?: string[]
    mentions?: string[]
  }): Effect.Effect<AgentContext, never, never> {
    const repo = this.repo
    return Effect.gen(function* () {
      // Query recent messages from the group for conversation context
      const messagesPage = yield* repo
        .listMessages({
          groupID: input.groupID,
          limit: 20,
        })
        .pipe(Effect.catch(() => Effect.succeed({ messages: [], nextCursor: null, hasMore: false })))

      const recentMessages = [...messagesPage.messages].sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      )

      const context: AgentContext = {
        conversation: {
          groupID: input.groupID,
          recentMessages: recentMessages.map((msg) => ({
            id: msg.id,
            sender_id: msg.senderID,
            sender_type: msg.senderType,
            content: msg.content,
            created_at: msg.createdAt,
          })),
        },
      }

      return context
    })
  }
}

export const AgentContextBuilderLive = Layer.effect(
  AgentContextBuilderService,
  Effect.gen(function* () {
    const repo = yield* IMRepository
    return new AgentContextBuilderImpl(repo)
  }),
)

// Re-export the service for convenience
export { AgentContextBuilderService }
