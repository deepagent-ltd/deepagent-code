import { Effect, Layer } from "effect"
import type { AgentExecutor, AgentExecutionResult, AgentContext } from "@deepagent-code/core/im/agent-executor"
import { AgentExecutorService } from "@deepagent-code/core/im/agent-executor"
import type { AgentListProvider, AgentQueryScope } from "@deepagent-code/core/im/agent-list-provider"
import {
  AgentListProviderService,
  matchByTrigger,
  matchByCapability,
} from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { DEFAULT_AUTONOMY_LEVEL } from "@deepagent-code/core/im/mention-parser"
import { BUILTIN_AGENT_DESCRIPTORS } from "@deepagent-code/core/im/builtin-agents"
import { Option } from "effect"
import type { AgentProgressPart } from "@deepagent-code/core/im/agent-reply-sink"
import { ServerCapabilities } from "@deepagent-code/core/server-capabilities"
import { ModelV2 } from "@deepagent-code/core/model"
import { ProviderV2 } from "@deepagent-code/core/provider"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { withAgentProgress } from "./agent-progress-stream"

/**
 * THE canonical live implementation of the core `AgentExecutor` port
 * (`packages/core/src/im/agent-executor.ts`) — the single real IM agent execution
 * path, driven by `SessionPrompt.Service`.
 *
 * core declares the `AgentExecutor` port but ships no real implementation: its only
 * default is `AgentExecutorFailFastLive`, an explicit fail-fast that errors clearly
 * when no adapter is injected (there is NO core `AgentExecutorLive`/SessionV2 path —
 * that was deleted in V3.8; see docs/deepagentcore-v3.8.1.md §A.1). This class is the
 * one place agents actually run: `SessionPrompt.Service.prompt(...)` executes the
 * LLM + tool turns to completion and returns the assistant message, so no separate
 * `wait()` is needed. V4.0's Multi-Agent Runtime layers concurrency, isolation,
 * timeout, and audit on top of this single port-backed path.
 *
 * This implementation must run inside the instance-scoped runtime (it needs
 * `InstanceState.context` for the worktree/directory, resolved from `InstanceRef`).
 * The IM handler forks it via `Effect.forkIn(serverScope)` so the forked fiber
 * inherits the request fiber's `InstanceRef`/`WorkspaceRef` and the full session
 * service graph, and outlives the HTTP response.
 */
class ServerAgentExecutor implements AgentExecutor {
  constructor(
    private readonly sessions: Session.Interface,
    private readonly prompts: SessionPrompt.Interface,
  ) {}

  execute(input: {
    workspaceID: string
    directory: string
    groupID: string
    messageID: string
    agentID: string
    userID: string
    content: string
    context: AgentContext
    timeoutMs: number
    onProgress?: (parts: ReadonlyArray<AgentProgressPart>) => Effect.Effect<void, never, never>
  }): Effect.Effect<AgentExecutionResult, Error, never> {
    const sessions = this.sessions
    const prompts = this.prompts
    return Effect.gen(function* () {
      // A fresh lightweight session per IM agent turn, rooted at the real
      // workspace directory so the agent can read/write project files.
      //
      // IM's `workspaceID` is a grouping key that may be a real "wrk"-prefixed
      // workspace id OR a directory fallback (single-user / directory-routed
      // model). Only forward it to the session when it's a genuine workspace id;
      // otherwise the session is located purely by `directory`.
      const workspaceID = input.workspaceID.startsWith("wrk")
        ? WorkspaceV2.ID.make(input.workspaceID)
        : undefined
      const session = yield* sessions.create({
        agent: input.agentID,
        title: `IM ${input.agentID}`,
        directory: input.directory,
        workspaceID,
      })

      // Server-configured IM model: when the platform sets `imModel` in the
      // injected ServerCapabilities, every IM turn runs with that model instead
      // of the agent's own default — a central lever to pick a fast/cheap chat
      // model. Unset (or malformed) leaves the kernel's normal model precedence
      // (agent model → session model → provider default) untouched.
      const imModelRef = ServerCapabilities.parseModelRef(ServerCapabilities.fromEnv()?.imModel)
      const imModel = imModelRef
        ? { providerID: ProviderV2.ID.make(imModelRef.providerID), modelID: ModelV2.ID.make(imModelRef.modelID) }
        : undefined

      // Run the agent to completion. V4.1 §S1.2: route through promptOrSteer — if the session is already
      // mid-turn (e.g. a goal is running, or a prior IM turn is still executing), this message is absorbed
      // as a STEER into that running turn instead of erroring/blocking; the running turn produces the
      // reply through its own progress bridge / IM output, so THIS call returns a steering-accepted ack
      // (no fabricated reply). If the session is idle, promptOrSteer runs a normal turn exactly as before.
      const runPrompt = prompts.promptOrSteer({
        sessionID: session.id,
        agent: input.agentID,
        ...(imModel ? { model: imModel } : {}),
        parts: [{ type: "text", text: input.content }],
      })

      // Live streaming: when the orchestrator supplied an `onProgress` sink and
      // the session event bridge is present, tap the turn's session events and
      // forward throttled reasoning/tool/text batches. The bridge is resolved at
      // RUNTIME via serviceOption (adds no static requirement, so execute stays
      // R = never); it's part of the instance runtime this executor runs in.
      // `withAgentProgress` is transparent — returns exactly promptOrSteer's result and
      // never fails the run. No sink or no bridge → run bare, unchanged.
      const onProgress = input.onProgress
      const eventBridge = Option.getOrUndefined(yield* Effect.serviceOption(EventV2Bridge.Service))
      const outcome =
        onProgress && eventBridge !== undefined
          ? yield* withAgentProgress({
              sessionID: session.id,
              onBatch: onProgress,
              body: runPrompt,
            }).pipe(Effect.provideService(EventV2Bridge.Service, eventBridge))
          : yield* runPrompt

      // Steer branch: the message was absorbed into the already-running turn (its reply streams through
      // that turn's own IM/progress path). Ack success without a synthesized reply of our own.
      if (outcome.kind === "steer") {
        return {
          success: true,
          timeout: false,
          content: "",
          messageID: outcome.admitted.id,
          steered: true,
        } satisfies AgentExecutionResult
      }
      const reply = outcome.message

      const text = reply.parts
        .filter((part): part is SessionV1.TextPart => part.type === "text")
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join("\n\n")
        .trim()

      if (text.length > 0) {
        return {
          success: true,
          timeout: false,
          content: text,
          messageID: reply.info.id,
        } satisfies AgentExecutionResult
      }

      return {
        success: false,
        timeout: false,
        error: {
          code: "NO_RESPONSE",
          message: "Agent completed but produced no text response",
          retryable: false,
        },
      } satisfies AgentExecutionResult
    }).pipe(
      // Bound the turn. On timeout the source is interrupted (cancelling the
      // in-flight run) and we surface a timeout result to the orchestrator.
      Effect.timeoutOrElse({
        duration: input.timeoutMs,
        orElse: (): Effect.Effect<AgentExecutionResult> =>
          Effect.succeed({
            success: false,
            timeout: true,
            error: {
              code: "AGENT_TIMEOUT",
              message: `Agent execution exceeded ${input.timeoutMs}ms timeout`,
              retryable: true,
            },
          } satisfies AgentExecutionResult),
      }),
      // Any executor failure is reported as a structured, non-fatal result so the
      // orchestrator can broadcast a "failed" status instead of dying.
      Effect.catch((error) =>
        Effect.succeed({
          success: false,
          timeout: false,
          error: {
            code: "AGENT_EXECUTION_ERROR",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        } satisfies AgentExecutionResult),
      ),
    )
  }
}

/**
 * Live layer for the production IM agent executor. Requires the deepagent-code
 * session services; must be provided within the instance runtime.
 */
export const ServerAgentExecutorLive = Layer.effect(
  AgentExecutorService,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    return new ServerAgentExecutor(sessions, prompts)
  }),
)

/**
 * Production AgentListProvider for IM @mention resolution.
 *
 * The core `AgentListProviderLive` reads `AgentV2` (packages/core), whose registry
 * is empty in the deepagent-code server. Real agents live in the deepagent-code
 * `Agent.Service`, so IM must resolve mentions against it — otherwise no mention
 * ever matches and no agent runs. Mentions match on `name` (the agent's name).
 */
class ServerAgentListProvider implements AgentListProvider {
  constructor(private readonly agents: Agent.Interface) {}

  listAgents(input: AgentQueryScope): Effect.Effect<AgentDescriptor[], Error, never> {
    const agents = this.agents
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
      // (globals) are returned; the instance's config agents are withheld. When the instance can't
      // determine its own scope (a bare fiber with no InstanceRef/WorkspaceRef — e.g. a daemon before
      // context load), we DEFER rather than over-filter and include the config agents: this is
      // defense-in-depth layered behind Layer-1 (trusted-source) which already fails closed on untrusted
      // external events, so withholding here would only risk false negatives, never a fail-open.
      const routedWorkspaceID = yield* InstanceState.workspaceID
      const instanceCtx = yield* InstanceRef
      const ownScope = routedWorkspaceID ?? instanceCtx?.directory
      const inScope = ownScope === undefined || ownScope === input.workspaceID

      const all = inScope ? yield* agents.list() : []
      const mapped = all
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
      // server.ts wires into v4EventRuntimeLayer + what multi-agent-runtime resolves).
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
    return new ServerAgentListProvider(agents)
  }),
)
