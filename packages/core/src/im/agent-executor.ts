import { Context, Effect, Schema } from "effect"

export const AgentContextItem = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  description: Schema.String,
  relevance: Schema.Number,
  body: Schema.optional(Schema.Unknown),
})
export type AgentContextItem = Schema.Schema.Type<typeof AgentContextItem>

export const AgentConversationMessage = Schema.Struct({
  id: Schema.String,
  sender_id: Schema.String,
  sender_type: Schema.String,
  content: Schema.String,
  created_at: Schema.Number,
})
export type AgentConversationMessage = Schema.Schema.Type<typeof AgentConversationMessage>

/**
 * Agent execution context built from multiple sources.
 */
export const AgentContext = Schema.Struct({
  code: Schema.optional(Schema.Unknown),
  knowledge: Schema.Array(AgentContextItem),
  memory: Schema.Array(AgentContextItem),
  documents: Schema.Array(AgentContextItem),
  conversation: Schema.Struct({
    groupID: Schema.String,
    recentMessages: Schema.Array(AgentConversationMessage),
  }),
})

export type AgentContext = Schema.Schema.Type<typeof AgentContext>

/**
 * Agent execution result.
 */
export const AgentExecutionResult = Schema.Struct({
  success: Schema.Boolean,
  messageID: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      retryable: Schema.Boolean,
    }),
  ),
  timeout: Schema.Boolean,
})

export type AgentExecutionResult = Schema.Schema.Type<typeof AgentExecutionResult>

/**
 * Agent context builder interface.
 * Builds context by querying code/knowledge/memory/documents separately.
 * Does NOT use queryUnifiedGraph.
 */
export interface AgentContextBuilder {
  build(input: {
    workspaceID: string
    groupID: string
    messageID: string
    task: string
    files?: string[]
    mentions?: string[]
  }): Effect.Effect<AgentContext, never, never>
}

export class AgentContextBuilderService extends Context.Service<
  AgentContextBuilderService,
  AgentContextBuilder
>()("@deepagent-code/im/AgentContextBuilder") {}

/**
 * Agent executor interface.
 * Executes an agent with context and timeout.
 */
export interface AgentExecutor {
  /**
   * Execute an agent with the given context.
   */
  execute(input: {
    workspaceID: string
    /**
     * Absolute filesystem path the agent session runs in. This is the resolved
     * instance working directory, NOT the workspace id — the two differ, and the
     * agent must be able to read/write the real project files.
     */
    directory: string
    groupID: string
    messageID: string
    agentID: string
    userID: string
    content: string
    context: AgentContext
    timeoutMs: number
  }): Effect.Effect<AgentExecutionResult, Error, never>
}

export class AgentExecutorService extends Context.Service<AgentExecutorService, AgentExecutor>()(
  "@deepagent-code/im/AgentExecutor",
) {}

/**
 * Default agent execution timeout: 60 seconds
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 60000

/**
 * Agent execution timeout, overridable via `IM_AGENT_TIMEOUT_MS`. Single source
 * of truth for both the orchestrator and any executor implementation.
 */
export const getAgentTimeout = (): number => {
  const env = process.env.IM_AGENT_TIMEOUT_MS
  if (!env) return DEFAULT_AGENT_TIMEOUT_MS
  const parsed = parseInt(env, 10)
  return isNaN(parsed) ? DEFAULT_AGENT_TIMEOUT_MS : parsed
}
