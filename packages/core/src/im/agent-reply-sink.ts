import { Context, Effect } from "effect"
import type { AgentExecutionResult } from "./agent-executor"
import type { AgentProgressPart } from "./websocket"

export type { AgentProgressPart }

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
/**
 * A throttled batch of changed progress parts for one agent turn. Each
 * {@link AgentProgressPart} is a live snapshot the client applies by REPLACING
 * its per-`partID` entry, so a dropped/reordered batch self-heals on the next
 * snapshot (and the authoritative final reply arrives separately via
 * {@link AgentReplySink.notify}). The part shape is the schema-backed
 * `AgentProgressPart` from ./websocket, shared so the WS event and the sink
 * payload can never drift.
 */
export interface AgentProgressUpdate {
  readonly groupID: string
  readonly messageID: string
  readonly agentID: string
  readonly parts: ReadonlyArray<AgentProgressPart>
}

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

  /**
   * OPTIONAL. Report a throttled batch of in-progress reasoning/tool/text
   * snapshots while the agent runs, so the hub can stream a live "thinking"
   * view. Absent on sinks that don't support streaming (standalone kernel, or
   * the no-op sink); the executor only calls it when defined. Best-effort — a
   * failure here must never affect the agent run or the final {@link notify}.
   */
  progress?(input: AgentProgressUpdate): Effect.Effect<void, never, never>
}

export class AgentReplySinkService extends Context.Service<AgentReplySinkService, AgentReplySink>()(
  "@deepagent-code/im/AgentReplySink",
) {}
