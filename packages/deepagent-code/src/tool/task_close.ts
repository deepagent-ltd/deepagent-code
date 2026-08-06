/**
 * task_close — cancel an active subagent task.
 *
 * Uses the durable `requestClose` BFS to atomically close the task and all its descendants.
 * For active runs the close is best-effort: the executor will settle as "closed" after its
 * current provider boundary. For queued/admitted runs the close is immediate.
 *
 * Design: subagent-control-plane-design.zh-CN.md §6.9
 */
import * as Tool from "./tool"
import { Database } from "@deepagent-code/core/database/database"
import { closeTask } from "@/tool/task-run"
import { SessionID } from "@/session/schema"
import { Effect, Schema } from "effect"

const id = "task_close"

const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({
    description:
      "The task ID (child session ID) returned by the task tool when the task was dispatched.",
  }),
  reason: Schema.optional(Schema.String).annotate({
    description: "Optional reason for closing the task. Shown in the task audit log.",
  }),
})

export const TaskCloseTool = Tool.define(
  id,
  Effect.gen(function* () {
    const database = yield* Database.Service

    const run = Effect.fn("TaskCloseTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const result = yield* closeTask({
        childSessionID: SessionID.make(params.task_id),
        parentSessionID: ctx.sessionID as unknown as SessionID,
        reason: params.reason ?? "user_requested_close",
      }).pipe(Effect.provideService(Database.Service, database))

      if (!result.closed) {
        return {
          title: "Task close",
          metadata: {},
          output: `Task ${params.task_id} has no open run — it may have already completed or been closed.`,
        }
      }

      return {
        title: "Task close",
        metadata: {},
        output:
          `Task ${params.task_id} close requested. ` +
          `Active runs will settle after their current provider boundary. ` +
          `Call task_status to monitor progress.`,
      }
    })

    return {
      description:
        "Cancel an active subagent task. Uses durable BFS close to atomically cancel the task and all its sub-tasks. Only available for tasks dispatched by this session.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
