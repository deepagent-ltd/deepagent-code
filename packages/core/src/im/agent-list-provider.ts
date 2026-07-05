import { Context, Effect, Layer } from "effect"
import { AgentV2 } from "../agent"
import type { AgentDescriptor } from "./mention-parser"

/**
 * Agent list provider for IM system.
 * Connects to AgentV2.Service to get actual agent list.
 */
export interface AgentListProvider {
  listAgents(input: { workspaceID: string; userID: string }): Effect.Effect<AgentDescriptor[], Error, never>
}

export class AgentListProviderService extends Context.Service<AgentListProviderService, AgentListProvider>()(
  "@deepagent-code/im/AgentListProvider",
) {}

/**
 * Real agent list provider that reads from AgentV2.Service.
 */
class AgentListProviderImpl implements AgentListProvider {
  constructor(private readonly agentService: AgentV2.Interface) {}

  listAgents(_input: { workspaceID: string; userID: string }): Effect.Effect<AgentDescriptor[], Error, never> {
    const agentService = this.agentService
    return Effect.gen(function* () {
      // Get all agents from AgentV2
      const allAgents = yield* agentService.all()

      // Filter and map to AgentDescriptor
      const descriptors: AgentDescriptor[] = allAgents
        .filter((agent) => {
          // Only include agents that are not hidden and are available for IM
          // mode: "all" or "primary" are available for IM mentions
          return !agent.hidden && (agent.mode === "all" || agent.mode === "primary")
        })
        .map((agent) => ({
          id: agent.id,
          name: agent.id, // Use ID as name for mention matching
          displayName: agent.description || agent.id,
          description: agent.description,
          visible: true,
        }))

      return descriptors
    })
  }
}

export const AgentListProviderLive = Layer.effect(
  AgentListProviderService,
  Effect.gen(function* () {
    const agentService = yield* AgentV2.Service
    return new AgentListProviderImpl(agentService)
  }),
)
