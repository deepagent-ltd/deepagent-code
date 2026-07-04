import { Effect, Layer } from "effect"
import type { AgentExecutor, AgentExecutionResult, AgentContext } from "@deepagent-code/core/im/agent-executor"
import { AgentExecutorService } from "@deepagent-code/core/im/agent-executor"
import type { AgentListProvider } from "@deepagent-code/core/im/agent-list-provider"
import { AgentListProviderService } from "@deepagent-code/core/im/agent-list-provider"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"

/**
 * Production AgentExecutor for the IM feature.
 *
 * The core `AgentExecutorLive` (packages/core) drives `SessionV2`, whose default
 * layer binds a NO-OP execution stack — so it never actually runs an agent in the
 * deepagent-code server (see docs/deepagent-im-v3.8.md §9 "F-exec"). The real agent
 * loop is `SessionPrompt.Service` (the same service the session HTTP handlers use):
 * `prompt(...)` runs the LLM + tool turns to completion and returns the assistant
 * message, so no separate `wait()` is needed.
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

      // Run the agent to completion. `prompt` returns the assistant message with
      // its parts; extract the concatenated text as the IM reply.
      const reply = yield* prompts.prompt({
        sessionID: session.id,
        agent: input.agentID,
        parts: [{ type: "text", text: input.content }],
      })

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

  listAgents(_input: { workspaceID: string; userID: string }): Effect.Effect<AgentDescriptor[], Error, never> {
    const agents = this.agents
    return Effect.gen(function* () {
      const all = yield* agents.list()
      return all
        .filter((agent) => !agent.hidden && (agent.mode === "all" || agent.mode === "primary"))
        .map(
          (agent): AgentDescriptor => ({
            id: agent.name,
            name: agent.name,
            displayName: agent.description || agent.name,
            description: agent.description,
            visible: true,
          }),
        )
    })
  }
}

export const ServerAgentListProviderLive = Layer.effect(
  AgentListProviderService,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    return new ServerAgentListProvider(agents)
  }),
)
