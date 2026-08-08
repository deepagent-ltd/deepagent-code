import { Tool } from "./tool"
import { Database } from "@deepagent-code/core/database/database"
import { TaskRunTable } from "@deepagent-code/core/session/sql"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { resolveRecovery } from "@/tool/task-run"
import { and, desc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

const id = "task_recovery"

const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The child session ID reported by task_status or task_read" }),
  resolution: Schema.Literals(["failed", "closed"]).annotate({
    description: "Resolve the ambiguous run as failed or closed; the old run is never resumed",
  }),
  reason: Schema.String.annotate({ description: "The user's reason for accepting this recovery resolution" }),
})

export const TaskRecoveryTool = Tool.define(
  id,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("TaskRecoveryTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const childSessionID = SessionID.make(params.task_id)
      const child = yield* sessions
        .get(childSessionID)
        .pipe(Effect.catchCause(() => Effect.fail(new Error(`task_recovery: session not found: ${params.task_id}`))))
      if (child.parentID !== ctx.sessionID) {
        return yield* Effect.fail(
          new Error(`task_recovery: ${params.task_id} is not a direct subagent of the current session`),
        )
      }

      const latest = yield* database.db
        .select()
        .from(TaskRunTable)
        .where(
          and(eq(TaskRunTable.child_session_id, childSessionID), eq(TaskRunTable.parent_session_id, ctx.sessionID)),
        )
        .orderBy(desc(TaskRunTable.generation))
        .get()
        .pipe(Effect.orDie)
      if (!latest || latest.state !== "recovery_required") {
        return yield* Effect.fail(
          new Error(
            `task_recovery: latest run for ${params.task_id} is ${latest?.state ?? "absent"}, not recovery_required`,
          ),
        )
      }

      yield* ctx.ask({
        permission: id,
        patterns: [`${params.task_id}:${params.resolution}`],
        always: [],
        metadata: {
          task_id: params.task_id,
          run_id: latest.run_id,
          generation: latest.generation,
          resolution: params.resolution,
          reason: params.reason,
        },
      })

      yield* resolveRecovery({
        runID: latest.run_id,
        resolution: params.resolution,
        reason: params.reason,
      }).pipe(Effect.provideService(Database.Service, database))

      return {
        title: "Task recovery resolved",
        metadata: {
          taskId: params.task_id,
          runId: latest.run_id,
          generation: latest.generation,
          resolution: params.resolution,
        },
        output:
          `Task ${params.task_id} generation ${latest.generation} is now ${params.resolution}. ` +
          "The ambiguous run was not replayed and its open descendants were closed in the same transaction. " +
          "Inspect it with task_read; to continue, invoke task with the same task_id to create a new generation.",
      }
    })

    return {
      description:
        "Resolve a recovery_required subagent run after explicit user approval. The old run can only become failed or closed; continuing requires a new task invocation with the same task_id.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
