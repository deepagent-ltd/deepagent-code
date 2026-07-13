import { Effect, Option } from "effect"
import { IMRepository, type IMRepositoryInterface } from "./repository"
import { IMBroadcasterService } from "./broadcaster"
import {
  AgentExecutorService,
  AgentContextBuilderService,
  getAgentTimeout,
  type AgentContextBuilder,
  type AgentExecutor,
} from "./agent-executor"
import { AgentListProviderService } from "./agent-list-provider"
import { AgentReplySinkService, type AgentReplySink, type AgentProgressPart } from "./agent-reply-sink"
import type { IMBroadcaster } from "./websocket"

interface AgentDescriptorLike {
  id: string
  name: string
  displayName: string
  description?: string
  visible: boolean
}

/**
 * Orchestrate execution of the agents mentioned in a message.
 *
 * Flow:
 * 1. Resolve available agents and keep only the mentioned, visible ones.
 * 2. For each agent (bounded concurrency): broadcast `started`, build context,
 *    execute with timeout, then persist the reply + broadcast the outcome.
 *
 * All required services are read from the Effect context so this can be run in
 * a detached fiber (see the createMessage handler) and exercised in tests with
 * fake service layers.
 */
export function executeAgentMentions(input: {
  workspaceID: string
  directory: string
  groupID: string
  messageID: string
  userID: string
  content: string
  mentionedAgentNames: string[]
}): Effect.Effect<
  void,
  never,
  IMRepository | IMBroadcasterService | AgentListProviderService | AgentExecutorService | AgentContextBuilderService
> {
  return Effect.gen(function* () {
    const agentListProvider = yield* AgentListProviderService
    const agentExecutor = yield* AgentExecutorService
    const contextBuilder = yield* AgentContextBuilderService
    const repo = yield* IMRepository
    const broadcaster = yield* IMBroadcasterService
    // Optional: present only in the Server Edition, where the reply must be
    // reported back to the gateway hub. Absent in the standalone kernel.
    const replySink = Option.getOrUndefined(yield* Effect.serviceOption(AgentReplySinkService))

    const availableAgents = yield* agentListProvider
      .listAgents({ workspaceID: input.workspaceID, userID: input.userID })
      .pipe(Effect.catch(() => Effect.succeed([] as AgentDescriptorLike[])))

    const agentMap = new Map(availableAgents.map((a) => [a.name, a]))
    const agentsToExecute = input.mentionedAgentNames
      .map((name) => agentMap.get(name))
      .filter((a): a is AgentDescriptorLike => a !== undefined && a.visible)

    yield* Effect.all(
      agentsToExecute.map((agent) =>
        executeSingleAgent({
          agent,
          workspaceID: input.workspaceID,
          directory: input.directory,
          groupID: input.groupID,
          messageID: input.messageID,
          userID: input.userID,
          content: input.content,
          executor: agentExecutor,
          contextBuilder,
          repo,
          broadcaster,
          replySink,
        }).pipe(Effect.catch(() => Effect.succeed(undefined))),
      ),
      { concurrency: 3, discard: true },
    )
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))
}

function executeSingleAgent(input: {
  agent: AgentDescriptorLike
  workspaceID: string
  directory: string
  groupID: string
  messageID: string
  userID: string
  content: string
  executor: AgentExecutor
  contextBuilder: AgentContextBuilder
  repo: IMRepositoryInterface
  broadcaster: IMBroadcaster
  replySink?: AgentReplySink
}): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    input.broadcaster.broadcast(input.groupID, {
      type: "agent_status",
      data: { messageID: input.messageID, agentID: input.agent.id, status: "started" },
    })

    const context = yield* input.contextBuilder
      .build({
        workspaceID: input.workspaceID,
        groupID: input.groupID,
        messageID: input.messageID,
        task: input.content,
      })
      .pipe(
        Effect.catch(() =>
          Effect.succeed({
            code: [],
            knowledge: [],
            memory: [],
            documents: [],
            conversation: { groupID: input.groupID, recentMessages: [] },
          }),
        ),
      )

    // Live progress: broadcast each throttled batch on the IM WebSocket (the
    // plane the chat UI listens to — same as agent_status) so users see the
    // agent's reasoning/tool activity as it happens, and mirror it to the
    // optional reply sink (authoritative hub) for parity. Best-effort: a
    // progress failure must never affect the run.
    const onProgress = (parts: ReadonlyArray<AgentProgressPart>): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        input.broadcaster.broadcast(input.groupID, {
          type: "agent_progress",
          data: { messageID: input.messageID, agentID: input.agent.id, parts: [...parts] },
        })
        if (input.replySink?.progress) {
          yield* input.replySink
            .progress({
              groupID: input.groupID,
              messageID: input.messageID,
              agentID: input.agent.id,
              parts,
            })
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
        }
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))

    const result = yield* input.executor
      .execute({
        workspaceID: input.workspaceID,
        directory: input.directory,
        groupID: input.groupID,
        messageID: input.messageID,
        agentID: input.agent.id,
        userID: input.userID,
        content: input.content,
        context,
        timeoutMs: getAgentTimeout(),
        onProgress,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({
            success: false,
            timeout: false,
            error: {
              code: "AGENT_EXECUTION_ERROR",
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
            },
          }),
        ),
      )

    yield* broadcastAgentResult({
      groupID: input.groupID,
      messageID: input.messageID,
      agentID: input.agent.id,
      result,
      broadcaster: input.broadcaster,
      repo: input.repo,
    })

    // Report the outcome to the optional reply sink (Server Edition → gateway
    // hub). Best-effort: never let a sink failure fail the agent run.
    if (input.replySink) {
      yield* input.replySink
        .notify({
          groupID: input.groupID,
          messageID: input.messageID,
          agentID: input.agent.id,
          result,
        })
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
    }
  })
}

function broadcastAgentResult(input: {
  groupID: string
  messageID: string
  agentID: string
  result: {
    success: boolean
    timeout: boolean
    content?: string
    // V4.1 §S1.2: the message was absorbed as a mid-turn STEER into an already-running turn (goal or a
    // live chat turn). There is no reply of our own to post — the running turn replies through its own
    // path — so this is an ACCEPTED outcome, NOT a failure. Broadcast a "steered" status and post nothing.
    steered?: boolean
    error?: { code: string; message: string; retryable: boolean }
  }
  broadcaster: IMBroadcaster
  repo: IMRepositoryInterface
}): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    if (input.result.steered) {
      input.broadcaster.broadcast(input.groupID, {
        type: "agent_status",
        data: { messageID: input.messageID, agentID: input.agentID, status: "steered" },
      })
      return
    }
    if (input.result.success && input.result.content) {
      const agentMessage = yield* input.repo
        .createMessage({
          groupID: input.groupID,
          senderID: input.agentID,
          senderType: "agent",
          type: "text",
          content: input.result.content,
          mentions: [],
          metadata: { type: "agent_run", sessionID: input.messageID, status: "success" },
        })
        .pipe(Effect.catch(() => Effect.succeed(null)))

      if (agentMessage) {
        input.broadcaster.broadcast(input.groupID, {
          type: "message_created",
          data: {
            id: agentMessage.id,
            groupID: agentMessage.groupID,
            senderID: agentMessage.senderID,
            senderType: agentMessage.senderType,
            messageType: agentMessage.type,
            content: agentMessage.content,
            mentions: agentMessage.mentions,
            metadata: agentMessage.metadata,
            replyToID: agentMessage.replyToID,
            createdAt: agentMessage.createdAt,
            updatedAt: agentMessage.updatedAt,
          },
        })
      }

      input.broadcaster.broadcast(input.groupID, {
        type: "agent_status",
        data: { messageID: input.messageID, agentID: input.agentID, status: "success" },
      })
    } else if (input.result.timeout) {
      input.broadcaster.broadcast(input.groupID, {
        type: "agent_status",
        data: { messageID: input.messageID, agentID: input.agentID, status: "timeout", error: input.result.error },
      })
    } else {
      input.broadcaster.broadcast(input.groupID, {
        type: "agent_status",
        data: { messageID: input.messageID, agentID: input.agentID, status: "failed", error: input.result.error },
      })
    }
  })
}
