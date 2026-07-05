import { Context, Effect, Layer } from "effect"
import type { AgentContext, AgentContextBuilder } from "./agent-executor"
import { AgentContextBuilderService } from "./agent-executor"
import { IMRepository, type IMRepositoryInterface } from "./repository"
import * as knowledgeSource from "../deepagent/knowledge-source"
import type { DocType } from "../deepagent/document-store"

/**
 * Default implementation of AgentContextBuilder.
 * Queries code/knowledge/memory/documents separately (does NOT use queryUnifiedGraph).
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

      // Build context from separate sources
      // V3.8 spec: query code/knowledge/memory/document separately
      // Run queries in parallel with error isolation (failures don't block execution)

      const [code, knowledge, memory, documents] = yield* Effect.all(
        [
          // Code context: TODO - integrate with code search/LSP
          Effect.succeed(undefined),

          // Knowledge: query from durable knowledge store
          Effect.gen(function* () {
            try {
              if (!knowledgeSource.isConfigured()) {
                return []
              }

              const scored = knowledgeSource.queryKnowledge({
                types: ["knowledge"] as DocType[],
                keywords: extractKeywords(input.task),
                workspacePath: input.workspaceID, // Use workspace ID as path for isolation
                limit: 5,
              })

              return scored.map((s) => ({
                id: s.doc.id,
                type: s.doc.type,
                description: s.doc.description,
                relevance: s.score,
                body: s.doc.body,
              }))
            } catch (error) {
              console.warn("Knowledge query failed:", error)
              return []
            }
          }),

          // Memory: query from memory store
          Effect.gen(function* () {
            try {
              if (!knowledgeSource.isConfigured()) {
                return []
              }

              const scored = knowledgeSource.queryKnowledge({
                types: ["memory"] as DocType[],
                keywords: extractKeywords(input.task),
                workspacePath: input.workspaceID,
                limit: 5,
              })

              return scored.map((s) => ({
                id: s.doc.id,
                type: s.doc.type,
                description: s.doc.description,
                relevance: s.score,
                body: s.doc.body,
              }))
            } catch (error) {
              console.warn("Memory query failed:", error)
              return []
            }
          }),

          // Documents: query from document store
          Effect.gen(function* () {
            try {
              if (!knowledgeSource.isConfigured()) {
                return []
              }

              const scored = knowledgeSource.queryKnowledge({
                types: ["design", "requirements", "bugfix"] as DocType[],
                keywords: extractKeywords(input.task),
                workspacePath: input.workspaceID,
                limit: 5,
              })

              return scored.map((s) => ({
                id: s.doc.id,
                type: s.doc.type,
                description: s.doc.description,
                relevance: s.score,
                body: s.doc.body,
              }))
            } catch (error) {
              console.warn("Document query failed:", error)
              return []
            }
          }),
        ],
        { concurrency: "unbounded" },
      )

      const context: AgentContext = {
        code,
        knowledge,
        memory,
        documents,
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

/**
 * Extract keywords from task string for knowledge retrieval.
 * Simple implementation: split by space and filter short words.
 */
function extractKeywords(task: string): string[] {
  const words = task
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)

  // Return top 5 unique keywords
  return Array.from(new Set(words)).slice(0, 5)
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
