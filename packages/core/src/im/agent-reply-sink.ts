import { Context, Effect } from "effect"
import type { AgentExecutionResult } from "./agent-executor"

/**
 * Optional sink notified after an IM agent finishes a mention turn.
 *
 * In the standalone kernel this is absent — the orchestrator persists the reply
 * to its own IM store and broadcasts over `/ws/im`, and that's the whole story.
 *
 * In the Server Edition (deepagent-code-server), the container's IM is NOT the
 * user-facing source of truth — the gateway hub is. The gateway delivers a
 * mention into the container's `/api/v1/im`, the kernel runs the agent, and the
 * reply must travel BACK to the hub. This sink is that outbound seam: when a
 * layer provides it, the orchestrator reports each agent outcome, and the
 * Server Edition implementation POSTs it to the gateway callback
 * (`/internal/im/agent-reply`). The gateway correlates (groupID, messageID)
 * back to its own conversation/message ids.
 *
 * It is OPTIONAL by construction: the orchestrator reads it via
 * `Effect.serviceOption`, so its absence changes neither the orchestrator's
 * requirements nor its behavior. Notifications are best-effort — a sink failure
 * must never fail the agent run.
 */
export interface AgentReplySink {
  /**
   * Report the outcome of an agent mention turn.
   *
   * @param groupID   kernel IM group the mention ran in
   * @param messageID kernel IM message id that triggered the agent
   * @param agentID   the agent that ran
   * @param result    success (with content) / timeout / failure
   */
  notify(input: {
    groupID: string
    messageID: string
    agentID: string
    result: AgentExecutionResult
  }): Effect.Effect<void, never, never>
}

export class AgentReplySinkService extends Context.Service<AgentReplySinkService, AgentReplySink>()(
  "@deepagent-code/im/AgentReplySink",
) {}
