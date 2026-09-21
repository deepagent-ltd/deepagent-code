export * as TaskRecoveryTool from "./task-recovery"

import { ToolFailure, toolText } from "@deepagent-code/llm"
import { and, desc, eq } from "drizzle-orm"
import { Effect, Layer, Option, Schema } from "effect"
import { Database } from "../database/database"
import { PermissionV2 } from "../permission"
import type { SessionV2 } from "../session"
import { SessionSchema } from "../session/schema"
import { TaskRunTable } from "../session/sql"
import { TaskRunAuthority } from "../session/task-run"
import { Delegation } from "./delegation"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "task_recovery"

const DESCRIPTION =
  "Resolve a recovery_required subagent run after explicit user approval. The old run can only become failed or closed; " +
  "continuing requires a new task invocation with the same task_id."

const Input = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The child session ID reported by task_status or task_read" }),
  resolution: Schema.Literals(["failed", "closed"]).annotate({
    description: "Resolve the ambiguous run as failed or closed; the old run is never resumed",
  }),
  reason: Schema.String.annotate({ description: "The user's reason for accepting this recovery resolution" }),
})

const Output = Schema.Struct({
  task_id: Schema.String,
  run_id: Schema.String,
  generation: Schema.Number,
  resolution: Schema.String,
  output: Schema.String,
})

/**
 * WS4b-S1 port of the legacy task_recovery: recovery_required precondition, explicit user
 * approval through the V2 permission assert (action `task_recovery`, default ask), then the
 * authority's resolveRecovery CAS — the run settles failed/closed and its open descendants close
 * in the same IMMEDIATE transaction.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [toolText({ type: "text", text: output.output })],
          execute: (input, context) =>
            Effect.gen(function* () {
              const slot = Option.getOrUndefined(yield* Effect.serviceOption(Delegation.DelegationSlot))
              const sessions: SessionV2.Interface | undefined = slot?.service
              if (!sessions)
                return yield* new ToolFailure({
                  message:
                    "task_recovery is unavailable: the root composition did not capture the V2 session service for delegation",
                })
              const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
              if (!database)
                return yield* new ToolFailure({
                  message: "task_recovery is unavailable: the database service is missing from the runner context",
                })
              const db = database.db
              const childSessionID = SessionSchema.ID.make(input.task_id)

              const child = yield* sessions.get(childSessionID).pipe(
                Effect.mapError(
                  () => new ToolFailure({ message: `task_recovery: session not found: ${input.task_id}` }),
                ),
              )
              if (String(child.parentID ?? "") !== String(context.sessionID))
                return yield* new ToolFailure({
                  message: `task_recovery: ${input.task_id} is not a direct subagent of the current session`,
                })

              const latest = yield* db
                .select()
                .from(TaskRunTable)
                .where(
                  and(
                    eq(TaskRunTable.child_session_id, childSessionID),
                    eq(TaskRunTable.parent_session_id, context.sessionID),
                  ),
                )
                .orderBy(desc(TaskRunTable.generation))
                .get()
                .pipe(Effect.orDie)
              if (!latest || latest.state !== "recovery_required")
                return yield* new ToolFailure({
                  message: `task_recovery: latest run for ${input.task_id} is ${latest?.state ?? "absent"}, not recovery_required`,
                })

              // Legacy ctx.ask equivalent: the V2 assert (action task_recovery) asks by default.
              yield* permission
                .assert({
                  action: name,
                  resources: [`${input.task_id}:${input.resolution}`],
                  metadata: {
                    task_id: input.task_id,
                    run_id: latest.run_id,
                    generation: latest.generation,
                    resolution: input.resolution,
                    reason: input.reason,
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(
                  Effect.mapError((error) => {
                    const refusal = PermissionV2.permissionFailureMessage(error)
                    if (refusal !== null) return new ToolFailure({ message: refusal, error })
                    return new ToolFailure({ message: `task_recovery: permission check failed (${String(error)})` })
                  }),
                )

              yield* TaskRunAuthority.resolveRecovery(db, {
                runID: latest.run_id,
                resolution: input.resolution,
                reason: input.reason,
              }).pipe(
                Effect.mapError(
                  (error) =>
                    new ToolFailure({
                      message:
                        error._tag === "TaskRunAuthority.RecoveryNotRequired"
                          ? `task_recovery: latest run for ${input.task_id} is ${error.actualState}, not recovery_required`
                          : `task_recovery failed (${error._tag}); the run is unchanged — retry the call.`,
                    }),
                ),
              )

              return {
                task_id: input.task_id,
                run_id: latest.run_id,
                generation: latest.generation,
                resolution: input.resolution,
                output:
                  `Task ${input.task_id} generation ${latest.generation} is now ${input.resolution}. ` +
                  "The ambiguous run was not replayed and its open descendants were closed in the same transaction. " +
                  "Inspect it with task_read; to continue, invoke task with the same task_id to create a new generation.",
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
