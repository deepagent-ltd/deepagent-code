import { InvalidRequestReason, LLMError } from "@deepagent-code/llm"
import { Effect } from "effect"
import { SessionMessage } from "../message"
import type { ToolRegistry } from "../../tool/registry"
import { SessionSchema } from "../schema"

/** Resolve settled artifact refs after durable history selection, before protocol lowering. */
export const rehydrateToolArtifacts = Effect.fn("SessionRunner.rehydrateToolArtifacts")(function* (
  messages: readonly SessionMessage.Message[],
  sessionID: SessionSchema.ID,
  read: ToolRegistry.Materialization["rehydrateArtifact"],
) {
  return yield* Effect.forEach(messages, (message): Effect.Effect<SessionMessage.Message, LLMError> => {
    if (message.type !== "assistant") return Effect.succeed(message)
    return Effect.map(
      Effect.forEach(message.content, (part): Effect.Effect<SessionMessage.AssistantContent, LLMError> => {
        if (part.type !== "tool" || part.state.status !== "completed") return Effect.succeed(part)
        const state = part.state
        return Effect.map(
          Effect.forEach(state.content, (item) =>
            item.type !== "file"
              ? Effect.succeed(item)
              : read({ sessionID, file: item }).pipe(
                  Effect.mapError(
                    (error) =>
                      new LLMError({
                        module: "SessionRunner",
                        method: "rehydrateToolArtifacts",
                        reason: new InvalidRequestReason({
                          message: `Cannot replay tool artifact: ${error._tag === "ToolArtifact.Error" ? error.reason : "storage_unavailable"}`,
                        }),
                      }),
                  ),
                ),
          ),
          (content) =>
            SessionMessage.AssistantTool.make({
              ...part,
              state: SessionMessage.ToolStateCompleted.make({ ...state, content }),
            }),
        )
      }),
      (content) => SessionMessage.Assistant.make({ ...message, content }),
    )
  })
})
