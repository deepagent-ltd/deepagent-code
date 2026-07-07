import { Effect, Layer } from "effect"
import type { AgentContext, AgentContextBuilder } from "./agent-executor"
import { AgentContextBuilderService } from "./agent-executor"
import { IMRepository, type IMRepositoryInterface } from "./repository"
import * as UnifiedContextGraph from "./unified-context-graph"

/**
 * Default implementation of AgentContextBuilder.
 *
 * V3.8 Phase 3 (roadmap C4, v3.8.1 §B.4): the four previously-independent per-bucket
 * `queryKnowledge` calls (code was a dead `Effect.succeed(undefined)` stub; documents was a
 * forever-empty `retrieve()` path since design/requirements/bugfix are not in KNOWLEDGE_DOC_TYPES)
 * are replaced by ONE `UnifiedContextGraph.query` call. UnifiedContextGraph is the thin IM adapter
 * over the shared GraphQuery service — it reaches nodes via the documentStore getter (bypassing the
 * retrieve() whitelist) and walks cross-type edges, so `code`/`documents` finally return real hits.
 *
 * The conversation/recentMessages logic is unchanged, and the `AgentContextBuilder` port contract
 * (build() signature) is unchanged.
 */
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

      // Single unified graph query replaces the four independent per-bucket queries. It returns the
      // {code,knowledge,memory,documents} buckets already mapped per the corrected DocType→bucket
      // rules. Degradation is total inside UnifiedContextGraph: unconfigured/empty graph → empty
      // buckets, and it never throws (§B.4 降级), so this build() likewise never fails.
      const graph = yield* UnifiedContextGraph.query({
        // IM uses the workspace id as the per-project store selector for isolation (matches the
        // pre-Phase-3 behavior, which passed workspaceID as workspacePath to queryKnowledge). When a
        // caller resolves file paths to code_symbol ids they can be threaded through as seeds later;
        // the mention/task-driven keyword recall covers the current IM path.
        ...(input.workspaceID ? { workspacePath: input.workspaceID } : {}),
        task: input.task,
      })

      const context: AgentContext = {
        code: graph.code,
        knowledge: graph.knowledge,
        memory: graph.memory,
        documents: graph.documents,
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
