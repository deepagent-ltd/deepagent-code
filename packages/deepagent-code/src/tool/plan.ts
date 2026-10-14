import { Effect, Option, Schema } from "effect"
import { AgentV2 } from "@deepagent-code/core/agent"
import { Database } from "@deepagent-code/core/database/database"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { QuestionV2 } from "@deepagent-code/core/question"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({})

// V2 has one canonical plan approval leaf. The legacy tool surface is only an
// adapter; it must never fabricate projected user messages to start execution.
export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.succeed({
    description: "Display the current plan version and explicitly approve queued execution in the same Session.",
    parameters: Parameters,
    execute: (_params: {}, context: Tool.Context) =>
      Effect.gen(function* () {
        const { PlanExitTool } = yield* Effect.promise(() => import("@deepagent-code/core/tool/plan-exit"))
        const permission = yield* Effect.serviceOption(PermissionV2.Service)
        const question = yield* Effect.serviceOption(QuestionV2.Service)
        const database = yield* Effect.serviceOption(Database.Service)
        if (!context.callID || Option.isNone(permission) || Option.isNone(question) || Option.isNone(database))
          return {
            title: "Plan execution unavailable",
            output: "Plan approval requires the current V2 runtime; no execution was admitted.",
            metadata: { queued: false },
          }
        return yield* PlanExitTool.approve({
          sessionID: context.sessionID,
          agent: AgentV2.ID.make(context.agent),
          assistantMessageID: SessionMessage.ID.make(context.messageID),
          toolCallID: context.callID,
        }).pipe(
          Effect.provideService(PermissionV2.Service, permission.value),
          Effect.provideService(QuestionV2.Service, question.value),
          Effect.provideService(Database.Service, database.value),
          Effect.map((output) => ({
            title: output.queued ? "Approved plan queued" : "Continue designing",
            output: output.queued
              ? "The approved plan is queued for the next activity in this Session."
              : "No execution was admitted.",
            metadata: output,
          })),
          Effect.catchTag("LLM.ToolFailure", (error) =>
            Effect.succeed({ title: "Plan execution unavailable", output: error.message, metadata: { queued: false } }),
          ),
        )
      }),
  }),
)
