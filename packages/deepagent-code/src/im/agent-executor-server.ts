import { Effect, Layer } from "effect"
import type { AgentListProvider, AgentQueryScope } from "@deepagent-code/core/im/agent-list-provider"
import {
  AgentListProviderService,
  matchByTrigger,
  matchByCapability,
} from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { DEFAULT_AUTONOMY_LEVEL } from "@deepagent-code/core/im/mention-parser"
import { BUILTIN_AGENT_DESCRIPTORS } from "@deepagent-code/core/im/builtin-agents"
import { Agent } from "@/agent/agent"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { V2AgentRoster } from "@/session/v2-agent-roster"
import { AbsolutePath } from "@deepagent-code/core/schema"

// V2 IM durable-only: the legacy `ServerAgentExecutor` (fresh V1 session per IM turn via
// SessionPrompt.promptOrSteer, wired through core's `executeAgentMentions`) is DELETED — @mentions are
// now admitted by the IM handler as durable SessionV2 work (src/im/im-agent-execution.ts) and the
// terminal reply returns through the im_reply_outbox daemon. This module keeps only the production
// AgentListProvider: mention resolution (and the v4 event runtime's registry lookups) still run
// against the Location-scoped Core V2 roster.

/**
 * Production AgentListProvider for IM @mention resolution.
 *
 * A bare daemon fiber has no InstanceRef. Directory-scoped lookup uses the event's directory;
 * an opaque workspace ID with no directory can only resolve workspace-independent built-ins.
 */
class ServerAgentListProvider implements AgentListProvider {
  constructor(
    private readonly agents: Agent.Interface,
    private readonly instanceStore: InstanceStore.Interface,
  ) {}

  listAgents(input: AgentQueryScope): Effect.Effect<AgentDescriptor[], Error, never> {
    const agents = this.agents
    const instanceStore = this.instanceStore
    return Effect.gen(function* () {
      // Scope gate (V4.x defense-in-depth). deepagent-code is a single-user, one-workspace-per-instance
      // server: `Agent.list()` returns the CONFIG agents of THIS routed instance only, so the correct
      // scope check is "does the requested scope address the instance this provider is bound to?" We
      // resolve the instance's own identity exactly like `getWorkspaceContext`: the routed workspace id,
      // else the working directory (the grouping key IM falls back to). Both reads are R=never and never
      // fail — `InstanceState.workspaceID` swallows a missing context, and `InstanceRef` is a reference
      // whose default is `undefined`.
      //
      // When the requested `workspaceID` does NOT match the instance's own scope, the caller is asking
      // about a workspace this instance was not routed to, so only the workspace-independent BUILT-INS
      // (globals) are returned; the instance's config agents are withheld.
      const routedWorkspaceID = yield* InstanceState.workspaceID
      const instanceCtx = yield* InstanceRef
      const ownScope = routedWorkspaceID ?? instanceCtx?.directory
      const inScope = ownScope === undefined || ownScope === input.workspaceID
      const directory =
        instanceCtx?.directory ??
        (input.workspaceID && !input.workspaceID.startsWith("wrk") ? input.workspaceID : undefined)
      const roster =
        inScope && directory
          ? yield* V2AgentRoster.agentsFor({
              directory: AbsolutePath.make(directory),
              ...(routedWorkspaceID ? { workspaceID: routedWorkspaceID } : {}),
            })
          : []

      // BLOCKER (v4-daemon-instanceref-die, residual): `agents.list()` resolves through InstanceState →
      // `InstanceState.context`, which `Effect.die`s when NO InstanceRef is present (instance-state.ts).
      // On a per-REQUEST fiber the middleware set it, so this is fine. But the AUTONOMOUS path calls this
      // provider from a bare DAEMON fiber (event-dispatcher / multi-agent-runtime), which carries no
      // InstanceRef — so `agents.list()` would die, the dispatcher captures the defect as "registry
      // lookup failed", nacks → 3× retry → DLQ, and EVERY autonomous event silently fails to dispatch
      // while looking handled. The prior InstanceRef-die fix wrapped the turn-runner + panel port but not
      // this earlier call site. Heal it the same way: when there is no InstanceRef, ESTABLISH one by
      // loading an InstanceContext for the event's directory (a non-"wrk" workspaceID doubles as a real
      // directory in the single-user / directory-routed model), then run `agents.list()` inside it. When
      // we cannot derive a directory (a bare "wrk_"-id is not a path), fall back to built-ins only —
      // never die. A genuine load/list ERROR still propagates so the dispatcher nacks+retries (transient).
      const listAgentsSafely = inScope
        ? instanceCtx
          ? agents.list() // per-request fiber already carries the context
          : (() => {
              const directory =
                input.workspaceID && !input.workspaceID.startsWith("wrk") ? input.workspaceID : undefined
              if (!directory) return Effect.succeed<Agent.Info[]>([])
              return instanceStore
                .load({ directory })
                .pipe(Effect.flatMap((ctx) => agents.list().pipe(Effect.provideService(InstanceRef, ctx))))
            })()
        : Effect.succeed<Agent.Info[]>([])
      const all = roster === undefined ? yield* listAgentsSafely : []
      const mapped =
        roster !== undefined
          ? roster
              .filter((agent) => !agent.hidden && agent.mode !== "subagent")
              .map(
                (agent): AgentDescriptor => ({
                  id: String(agent.id),
                  name: String(agent.id),
                  displayName: agent.description || String(agent.id),
                  description: agent.description,
                  visible: true,
                  autonomy: DEFAULT_AUTONOMY_LEVEL,
                  approval_required: true,
                }),
              )
          : all
              .filter((agent) => !agent.hidden && (agent.mode === "all" || agent.mode === "primary"))
              .map((agent): AgentDescriptor => {
                // Resolve autonomy to its conservative default when the agent didn't
                // declare one, so V4.0 autonomy gates always see a concrete level.
                const autonomy = agent.autonomy ?? DEFAULT_AUTONOMY_LEVEL
                // `approval_required` defaults BY autonomy (V3.8.1 §C.3): level_0 is
                // all-manual ⇒ approval required; any higher declared level ⇒ the
                // agent may act up to that level ⇒ not required. An explicit value
                // always wins.
                const approvalRequired = agent.approval_required ?? autonomy === DEFAULT_AUTONOMY_LEVEL
                // Pass declarative metadata through only when present, so an agent
                // that declared none stays free of empty arrays (V3.8 shape). Built
                // immutably — AgentDescriptor fields are readonly.
                return {
                  id: agent.name,
                  name: agent.name,
                  displayName: agent.description || agent.name,
                  description: agent.description,
                  visible: true,
                  autonomy,
                  approval_required: approvalRequired,
                  ...(agent.triggers !== undefined ? { triggers: agent.triggers } : {}),
                  ...(agent.capabilities !== undefined ? { capabilities: agent.capabilities } : {}),
                  ...(agent.context_sources !== undefined ? { context_sources: agent.context_sources } : {}),
                  ...(agent.limits !== undefined ? { limits: agent.limits } : {}),
                } satisfies AgentDescriptor
              })
      // V4.0 §A1 — this is the PRODUCTION provider (ServerAgentListProviderLive is what
      // server.ts wires into imRuntimeLayer + v4EventRuntimeLayer + what multi-agent-runtime resolves).
      // The real deepagent-code agents (auto/general/plan) carry NO trigger/capability
      // metadata, so without this every autonomous event (ci.failure/pr.comment/…) would
      // still block with `no_capable_agent` here. Append the built-ins (each `name`
      // resolves to a real runnable agent) so the autonomous path is live in production.
      // `visible: false` keeps them out of the @mention UI while staying matchable.
      return [...mapped, ...BUILTIN_AGENT_DESCRIPTORS]
    })
  }

  findByTrigger(input: AgentQueryScope & { event: string }): Effect.Effect<AgentDescriptor[], Error, never> {
    return this.listAgents(input).pipe(Effect.map((descriptors) => matchByTrigger(descriptors, input.event)))
  }

  findByCapability(input: AgentQueryScope & { capability: string }): Effect.Effect<AgentDescriptor[], Error, never> {
    return this.listAgents(input).pipe(Effect.map((descriptors) => matchByCapability(descriptors, input.capability)))
  }
}

export const ServerAgentListProviderLive = Layer.effect(
  AgentListProviderService,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const instanceStore = yield* InstanceStore.Service
    return new ServerAgentListProvider(agents, instanceStore)
  }),
)
