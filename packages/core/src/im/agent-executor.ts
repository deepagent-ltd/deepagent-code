import { Context, Effect, Layer, Schema } from "effect"
import type { AgentProgressPart } from "./agent-reply-sink"

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
  // V3.8 Phase 3 (v3.8.1 §B.4): tightened from Schema.optional(Schema.Unknown) to an optional
  // AgentContextItem[] (same shape as the other three buckets) now that the code bucket is filled by
  // real code_symbol traversal via UnifiedContextGraph. Kept optional for backward-compat.
  code: Schema.optional(Schema.Array(AgentContextItem)),
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
  // V4.1 §S1.2: true when the message was absorbed as a mid-turn STEER into an already-running turn
  // rather than executed as a fresh turn — the reply streams through that running turn's own path, so
  // this result carries no synthesized `content`. Optional/additive: absent ⇒ a normal turn (unchanged).
  steered: Schema.optional(Schema.Boolean),
})

export type AgentExecutionResult = Schema.Schema.Type<typeof AgentExecutionResult>

/**
 * Agent context builder interface.
 * Builds context across code/knowledge/memory/documents. The live implementation routes through
 * UnifiedContextGraph (four-graph unification, V3.8.1 §B) with defect-safe degradation to empty.
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
    /**
     * OPTIONAL live-progress sink. When provided, an executor that supports
     * streaming reports throttled batches of the turn's in-flight
     * reasoning/tool/text parts. The orchestrator wires this to broadcast on the
     * IM WebSocket (and mirror to the reply sink). Best-effort: the callback
     * never fails, and an executor that doesn't stream simply ignores it.
     */
    onProgress?: (parts: ReadonlyArray<AgentProgressPart>) => Effect.Effect<void, never, never>
  }): Effect.Effect<AgentExecutionResult, Error, never>
}

export class AgentExecutorService extends Context.Service<AgentExecutorService, AgentExecutor>()(
  "@deepagent-code/im/AgentExecutor",
) {}

/**
 * Clear error surfaced by {@link AgentExecutorFailFastLive} when the port has no
 * real live implementation wired in.
 */
export const AGENT_EXECUTOR_NOT_IMPLEMENTED =
  "AgentExecutor has no live implementation — inject the SessionPrompt adapter (ServerAgentExecutorLive)"

/**
 * Explicit fail-fast default layer for the {@link AgentExecutorService} port.
 *
 * core declares the `AgentExecutor` port but ships NO real live implementation —
 * the single canonical one is `ServerAgentExecutorLive` (SessionPrompt-driven) in
 * `packages/deepagent-code/src/im/agent-executor-server.ts`. Without this layer, an
 * un-injected service surfaces as an opaque "missing dependency" runtime failure.
 *
 * This layer satisfies the dependency at resolution time but fails fast at
 * execute-time — through the port's existing typed `Error` channel — with a clear,
 * actionable message. It keeps the port contract (interface + execute signature)
 * unchanged and lets the orchestrator's normal error handling report it as a
 * structured failure instead of dying with an obscure dependency error.
 */
export const AgentExecutorFailFastLive = Layer.succeed(
  AgentExecutorService,
  AgentExecutorService.of({
    execute: () => Effect.fail(new Error(AGENT_EXECUTOR_NOT_IMPLEMENTED)),
  }),
)

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
