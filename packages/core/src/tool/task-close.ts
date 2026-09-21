export * as TaskCloseTool from "./task-close"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { SessionSchema } from "../session/schema"
import { TaskRunAuthority } from "../session/task-run"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "task_close"

const DESCRIPTION =
  "Cancel an active subagent task. Uses durable BFS close to atomically cancel the task and all its sub-tasks. " +
  "For active runs the close is best-effort: the executor settles as closed after its current provider boundary. " +
  "For queued/admitted runs the close is immediate. Only available for tasks dispatched by this session."

const Input = Schema.Struct({
  task_id: Schema.String.annotate({
    description: "The task ID (child session ID) returned by the task tool when the task was dispatched.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Optional reason for closing the task. Shown in the task audit log.",
  }),
})

const Output = Schema.Struct({
  closed: Schema.Boolean,
  output: Schema.String,
})

/**
 * WS4b-S1 port of the legacy task_close: a thin shell over the Core TaskRunAuthority closeTask —
 * parent-ownership validation, then the durable BFS close (admitted/queued/recovery_required go
 * terminal immediately; provisioning/running/researching/finalizing get control_state
 * 'close_requested' and settle at the next provider boundary).
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [toolText({ type: "text", text: output.output })],
          execute: (input, context) =>
            Effect.gen(function* () {
              const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
              if (!database)
                return yield* new ToolFailure({
                  message: "task_close is unavailable: the database service is missing from the runner context",
                })

              const result = yield* TaskRunAuthority.closeTask(database.db, {
                childSessionID: SessionSchema.ID.make(input.task_id),
                parentSessionID: context.sessionID,
                reason: input.reason ?? "user_requested_close",
              }).pipe(
                Effect.mapError(
                  (error) =>
                    new ToolFailure({
                      message:
                        error._tag === "TaskRunAuthority.AdmissionConflict"
                          ? `task_close: ${input.task_id} is not a task dispatched by this session.`
                          : `task_close failed: ${error._tag}`,
                    }),
                ),
              )

              if (!result.closed)
                return {
                  closed: false,
                  output: `Task ${input.task_id} has no open run — it may have already completed or been closed.`,
                }
              return {
                closed: true,
                output:
                  `Task ${input.task_id} close requested. ` +
                  "Active runs will settle after their current provider boundary. " +
                  "Call task_status to monitor progress.",
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
