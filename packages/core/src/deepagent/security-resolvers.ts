export * as SecurityResolvers from "./security-resolvers"

import { Context, Effect, Layer } from "effect"
import { DeepAgentEvent } from "./deepagent-event"
import { WorkspaceConfig } from "./workspace-config"
import { AgentListProviderService } from "../im/agent-list-provider"
import { IMRepository } from "../im/repository"
import type { AgentDescriptor } from "../im/mention-parser"

// V4.0 §E1 — the RESOLVERS that turn the pure SecurityGate policy (security-gate.ts) into a production
// decision. SecurityGate.check is deliberately fact-free: it takes booleans and returns a fail-closed
// verdict. Something has to RESOLVE those facts from real state (workspace config, IM membership, the
// agent registry, the agent's declared limits). That is this module. The MultiAgentRuntime today wires
// LENIENT allow-defaults (trustedSources = all, actorHasPermission = () => true, runtimeAllowed =
// () => true); these resolvers are the PRODUCTION replacements it can inject instead.
//
// LAYERING: lives in `core`. It DOES do IO (config read, membership lookup, registry lookup) — that is
// the whole point; the pure policy stays in security-gate.ts. Deps: WorkspaceConfig + AgentListProvider
// + IMRepository. Every method FAILS CLOSED: a lookup error resolves to "not trusted / not permitted /
// not allowed", never open.
//
// §E1 layers this module resolves (layer 3 — agent_capability — is already pure in security-gate.ts):
//   layer 1 event_source     → resolveTrustedSources(workspaceID)          reads WorkspaceConfig.trustedSources
//   layer 2 actor_permission → actorHasWorkspacePermission({...})          IM membership OR agent registry
//   layer 4 runtime_operation→ runtimeAllowsOperation({...})               coarse agent-limit pre-gate

// ─── PURE helper units (no IO — directly unit-testable) ──────────────────────────────────────────────

/**
 * §E1 layer-4 pure core — does the agent's declared `toolWhitelist` permit `capability`?
 *
 * An agent with NO declared whitelist (`limits.toolWhitelist` unset) imposes NO extra restriction here
 * (returns true) — the child session's own permission path remains the fine-grained enforcement; this
 * gate is defense-in-depth only. When a whitelist IS declared, a capability outside it is denied. A
 * missing/omitted `capability` is a no-op (nothing specific is being gated) → allowed.
 */
export const capabilityWithinDeclaredTools = (
  agent: Pick<AgentDescriptor, "limits">,
  capability?: string,
): boolean => {
  const whitelist = agent.limits?.toolWhitelist
  if (whitelist == null) return true // no declared restriction — kernel/session permissions apply
  if (capability == null) return true // nothing specific to gate
  return whitelist.includes(capability)
}

// ─── The service ─────────────────────────────────────────────────────────────────────────────────────

export interface ActorPermissionInput {
  readonly workspaceID: string
  // absent ⇒ a system / no-actor event (see the no-actor policy on `actorHasWorkspacePermission`).
  readonly actorID?: string
  // the acting agent, if the event is bound to one. Used for the "agent is registered for the
  // workspace" arm of the OR rule.
  readonly agentID?: string
}

export interface RuntimeOperationInput {
  readonly workspaceID: string
  readonly agent: Pick<AgentDescriptor, "limits">
  // the capability/tool the operation requires; omitted ⇒ nothing specific to gate (allowed).
  readonly capability?: string
}

export interface Interface {
  /**
   * §E1 layer 1 — the workspace's trusted event sources (defaults applied by WorkspaceConfig). Feed the
   * result to SecurityGate.isTrustedSource(event.source, …). Never fails (config.get never fails).
   */
  readonly resolveTrustedSources: (
    workspaceID: string,
  ) => Effect.Effect<ReadonlyArray<DeepAgentEvent.EventSource>>

  /**
   * §E1 layer 2 — is the actor permitted in this workspace? PRODUCTION rule (fail-closed):
   *   permitted ⇔  the actor is a MEMBER of at least one of the workspace's IM groups
   *            OR  the acting agent (`agentID`) is REGISTERED/visible for the workspace.
   * NO-ACTOR POLICY: when `actorID` is absent the event is a system/no-actor event; those are NOT gated
   * by workspace membership (there is no member to check) — their trust is established at LAYER 1
   * (event_source), which runs BEFORE this layer and must already have passed for a system event to
   * reach here. So a no-actor event resolves to `true` here, deferring its gating to layer 1. Any
   * lookup ERROR resolves to `false` (fail closed), never open.
   */
  readonly actorHasWorkspacePermission: (input: ActorPermissionInput) => Effect.Effect<boolean>

  /**
   * §E1 layer 4 — coarse pre-gate: does the agent's declared limits allow this operation? Denies when a
   * `toolWhitelist` is declared and `capability` is outside it (see `capabilityWithinDeclaredTools`).
   * The child session's own permission path is the fine-grained enforcement; this is defense-in-depth.
   * Never fails; pure over the passed agent.
   */
  readonly runtimeAllowsOperation: (input: RuntimeOperationInput) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/SecurityResolvers") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* WorkspaceConfig.Service
    const agentList = yield* AgentListProviderService
    const im = yield* IMRepository

    const resolveTrustedSources: Interface["resolveTrustedSources"] = (workspaceID) =>
      config.get(workspaceID).pipe(Effect.map((r) => r.trustedSources))

    const actorHasWorkspacePermission: Interface["actorHasWorkspacePermission"] = (input) =>
      Effect.gen(function* () {
        // no-actor (system) event: not membership-gated — its trust is layer 1's job. Deferring to
        // layer 1 (which already passed for this event to reach layer 2) rather than opening blindly.
        if (input.actorID == null) return true

        // arm 1: the actor is a member of some IM group in this workspace. listGroups already filters to
        // groups where the given member_id is a member, so a non-empty result == "is a workspace member".
        const isMember = yield* im
          .listGroups({ workspaceID: input.workspaceID, userID: input.actorID })
          .pipe(
            Effect.map((groups) => groups.length > 0),
            Effect.catch(() => Effect.succeed(false)), // lookup error ⇒ fail closed
          )
        if (isMember) return true

        // arm 2: the acting agent is registered/visible for this workspace.
        if (input.agentID == null) return false
        const agentID = input.agentID
        return yield* agentList
          .listAgents({ workspaceID: input.workspaceID, userID: input.actorID })
          .pipe(
            Effect.map((agents) => agents.some((a) => a.id === agentID || a.name === agentID)),
            Effect.catch(() => Effect.succeed(false)), // lookup error ⇒ fail closed
          )
      })

    const runtimeAllowsOperation: Interface["runtimeAllowsOperation"] = (input) =>
      Effect.succeed(capabilityWithinDeclaredTools(input.agent, input.capability))

    return Service.of({ resolveTrustedSources, actorHasWorkspacePermission, runtimeAllowsOperation })
  }),
)

// ─── INJECTION NOTE (how MultiAgentRuntime should consume this — NOT wired here) ─────────────────────
//
// MultiAgentRuntime.layerWith takes LENIENT defaults today (multi-agent-runtime.ts):
//   trustedSources?: ReadonlyArray<EventSource>                                    // default: all trusted
//   actorHasPermission?: (event, agent: AgentDescriptor) => Effect<boolean>        // default: () => true
//   runtimeAllowed?:     (event, agent: AgentDescriptor) => Effect<boolean>        // default: () => true
//
// The integration wiring (which OWNS multi-agent-runtime.ts) provides a SecurityResolvers.Service and
// passes adapters that close over it. Because the runtime resolves trustedSources per-workspace, the
// cleanest wiring resolves it inside the actor/runtime adapters (or the wiring precomputes it):
//
//   const sec = yield* SecurityResolvers.Service
//   MultiAgentRuntime.layerWith({
//     runner,
//     // layer 1 — omit the static option and resolve per-event instead, OR precompute for a known ws.
//     actorHasPermission: (event, agent) =>
//       sec.actorHasWorkspacePermission({ workspaceID: event.workspaceID, actorID: event.actorID, agentID: agent.id }),
//     runtimeAllowed: (event, agent) =>
//       sec.runtimeAllowsOperation({ workspaceID: event.workspaceID, agent /*, capability: subtask.capability */ }),
//   })
//
// For layer 1, since layerWith's `trustedSources` is a static array (not per-event), the wiring either
// (a) resolves sec.resolveTrustedSources(workspaceID) once for a single-workspace runtime and passes the
// array, or (b) the runtime is extended (integration's call, not this track's) to resolve it per-event.
// Note `capability` for layer 4: the runtime's `runtimeAllowed` signature is (event, agent) with no
// capability; the coarse pre-gate here still functions on the agent's declared whitelist, and the
// wiring may close over the subtask capability when it has it. Fine-grained per-tool enforcement remains
// the child session's permission path — this resolver is defense-in-depth.
