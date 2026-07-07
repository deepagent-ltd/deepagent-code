import { Context, Effect, Layer } from "effect"
import { AgentV2 } from "../agent"
import type { AgentDescriptor } from "./mention-parser"

/** Query context shared by every provider read. */
export interface AgentQueryScope {
  workspaceID: string
  userID: string
}

/**
 * Read-only registry matchers (V3.8.1 §C.4). Pure matching only — NO dispatch
 * (dispatch is V4.0's Event Bus/Router). Shared by every provider so both
 * implementations match identically:
 *
 *  - `matchByTrigger(descriptors, event)`  → descriptors declaring a trigger
 *     whose `event` equals `event`. A descriptor with no `triggers` never matches.
 *  - `matchByCapability(descriptors, cap)` → descriptors whose `capabilities`
 *     include `cap`. A descriptor with no `capabilities` never matches.
 */
export function matchByTrigger(descriptors: readonly AgentDescriptor[], event: string): AgentDescriptor[] {
  return descriptors.filter((d) => (d.triggers ?? []).some((t) => t.event === event))
}

export function matchByCapability(descriptors: readonly AgentDescriptor[], cap: string): AgentDescriptor[] {
  return descriptors.filter((d) => (d.capabilities ?? []).includes(cap))
}

/**
 * Agent list provider / registry for IM system.
 *
 * `listAgents` semantics are unchanged from V3.8 (drives @mention resolution).
 * V3.8.1 §C.4 adds the read-only `findByTrigger`/`findByCapability` matchers:
 * pure matching over the same descriptor set `listAgents` returns, no dispatch.
 */
export interface AgentListProvider {
  listAgents(input: AgentQueryScope): Effect.Effect<AgentDescriptor[], Error, never>
  findByTrigger(input: AgentQueryScope & { event: string }): Effect.Effect<AgentDescriptor[], Error, never>
  findByCapability(input: AgentQueryScope & { capability: string }): Effect.Effect<AgentDescriptor[], Error, never>
}

export class AgentListProviderService extends Context.Service<AgentListProviderService, AgentListProvider>()(
  "@deepagent-code/im/AgentListProvider",
) {}

/**
 * Real agent list provider that reads from AgentV2.Service.
 *
 * core `AgentV2.Info` (packages/core/src/agent.ts) is a distinct schema from the
 * production deepagent-code `Agent.Info` and, per V3.8.1 §C.3/§C.4, is NOT being
 * extended with the new metadata fields (decision: empty/default — see the note
 * on the mapping below). This provider therefore emits descriptors WITHOUT the
 * optional metadata (triggers/capabilities/limits absent, so they never match a
 * trigger/capability query); `visible`/@mention behavior is unchanged. The
 * production path is `ServerAgentListProvider`, which reads the extended
 * `Agent.Info` and fully populates the metadata.
 */
class AgentListProviderImpl implements AgentListProvider {
  constructor(private readonly agentService: AgentV2.Interface) {}

  listAgents(_input: AgentQueryScope): Effect.Effect<AgentDescriptor[], Error, never> {
    const agentService = this.agentService
    return Effect.gen(function* () {
      // Get all agents from AgentV2
      const allAgents = yield* agentService.all()

      // Filter and map to AgentDescriptor. AgentV2.Info carries none of the new
      // V3.8.1 metadata, so the optional fields are simply left unset (V3.8
      // behavior preserved exactly).
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

  findByTrigger(input: AgentQueryScope & { event: string }): Effect.Effect<AgentDescriptor[], Error, never> {
    return this.listAgents(input).pipe(Effect.map((descriptors) => matchByTrigger(descriptors, input.event)))
  }

  findByCapability(input: AgentQueryScope & { capability: string }): Effect.Effect<AgentDescriptor[], Error, never> {
    return this.listAgents(input).pipe(Effect.map((descriptors) => matchByCapability(descriptors, input.capability)))
  }
}

export const AgentListProviderLive = Layer.effect(
  AgentListProviderService,
  Effect.gen(function* () {
    const agentService = yield* AgentV2.Service
    return new AgentListProviderImpl(agentService)
  }),
)
