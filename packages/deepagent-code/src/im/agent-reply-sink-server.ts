import { Effect, Layer } from "effect"
import { AgentReplySinkService, type AgentReplySink } from "@deepagent-code/core/im/agent-reply-sink"

/**
 * Server Edition AgentReplySink.
 *
 * The gateway hub — not the container's IM store — is the user-facing source of
 * truth. When the gateway delivers an @mention into this container's
 * `/api/v1/im`, the kernel runs the agent and this sink reports the outcome
 * BACK to the gateway callback so the hub can persist + broadcast it to the
 * user's clients.
 *
 * The gateway correlates the reply to its own conversation/message ids using
 * the kernel-native (groupID, messageID) pair — the same pair it recorded when
 * it delivered the mention — so this payload carries no server ids.
 *
 * Wiring (all via env, injected by workspace-agent):
 *   GATEWAY_CALLBACK_URL            base URL of the gateway internal callback
 *   DEEPAGENT_CODE_SERVER_PASSWORD  internal token (X-Internal-Token), also the
 *                                   container's Basic Auth password
 *
 * When GATEWAY_CALLBACK_URL is unset (standalone / desktop), the layer provides
 * a no-op sink so behavior is unchanged.
 */
class ServerAgentReplySink implements AgentReplySink {
  constructor(
    private readonly callbackUrl: string,
    private readonly internalToken: string,
  ) {}

  notify(input: {
    groupID: string
    messageID: string
    agentID: string
    result: {
      success: boolean
      timeout: boolean
      content?: string
      error?: { code: string; message: string; retryable: boolean }
    }
  }): Effect.Effect<void, never, never> {
    const callbackUrl = this.callbackUrl
    const internalToken = this.internalToken
    return Effect.gen(function* () {
      const status = input.result.success ? "success" : input.result.timeout ? "timeout" : "failed"
      const body = {
        // Kernel-native correlation keys; the gateway maps these back to its own
        // conversationId / triggerMessageId recorded at delivery time.
        groupId: input.groupID,
        triggerMessageId: input.messageID,
        agentName: input.agentID,
        status,
        content: input.result.success ? input.result.content : undefined,
        error: input.result.error,
      }

      yield* Effect.tryPromise(() =>
        fetch(`${callbackUrl}/im/agent-reply`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Internal-Token": internalToken,
          },
          body: JSON.stringify(body),
        }),
      ).pipe(
        Effect.flatMap((res) =>
          res.ok
            ? Effect.void
            : Effect.logWarning(`[im-reply-sink] gateway callback returned ${res.status}`),
        ),
        // Best-effort: swallow network/serialization failures.
        Effect.catch((error) =>
          Effect.logWarning(`[im-reply-sink] gateway callback failed: ${String(error)}`),
        ),
      )
    })
  }
}

/**
 * Live layer for the Server Edition reply sink.
 *
 * If GATEWAY_CALLBACK_URL is set, provides the HTTP sink; otherwise provides a
 * no-op so the orchestrator's optional-service read still resolves cleanly and
 * standalone behavior is unchanged.
 */
export const ServerAgentReplySinkLive = Layer.sync(AgentReplySinkService, () => {
  const callbackUrl = process.env.GATEWAY_CALLBACK_URL
  const internalToken = process.env.DEEPAGENT_CODE_SERVER_PASSWORD ?? ""

  if (!callbackUrl) {
    const noop: AgentReplySink = { notify: () => Effect.void }
    return noop
  }

  return new ServerAgentReplySink(callbackUrl, internalToken)
})
