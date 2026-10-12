export * as TaskControl from "./task-control"

import { Effect } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { Attention } from "@deepagent-code/core/attention"
import { SessionV2 } from "@deepagent-code/core/session"
import { SessionExecution } from "@deepagent-code/core/session/execution"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { TaskHumanControl } from "@deepagent-code/core/session/task-human-control"
import { TaskHumanControlSchema } from "@deepagent-code/core/session/task-human-control.schema"
import { WorkAuthoritySchema } from "@deepagent-code/core/session/work-authority.schema"
import { GoalChildSchema } from "@deepagent-code/core/deepagent/goal-child.schema"
import { ServerAuth } from "@/server/auth"
import { CorsConfig } from "@/server/cors"
import { GoalPlanRebaseAccess } from "@/session/goal-plan-rebase-access"

/** Only the actual HTTP request enters this adapter. It never accepts an Access, principal,
 * Tool context, localhost assertion or TUI witness from the caller. */
export const control = Effect.fn("TaskControl.control")(function* (
  input: unknown,
  request: HttpServerRequest.HttpServerRequest,
) {
  const config = yield* ServerAuth.Config
  const database = yield* Database.Service
  const sessions = yield* SessionV2.Service
  if (database.mode && (!database.mode.ready || database.mode.mode !== "ready"))
    return yield* new TaskHumanControlSchema.Error({
      code: "unavailable",
      message: "Task control requires writable local storage",
    })
  // Authentication is minted here, never accepted from a public API. authenticate is the
  // strict HTTP branch, so a Goal-bound local/TUI Access cannot enter this control lane.
  const access = yield* GoalPlanRebaseAccess.authenticateOperator(config, request).pipe(
    Effect.mapError(
      () =>
        new TaskHumanControlSchema.Error({
          code: "auth_required",
          message: "Task control requires current Basic operator authentication and an exact request origin",
        }),
    ),
  )
  const actor = {
    current: (parentSessionID: string) =>
      Effect.gen(function* () {
        yield* GoalPlanRebaseAccess.current(access).pipe(
          Effect.mapError(
            () =>
              new TaskHumanControlSchema.Error({
                code: "auth_required",
                message: "Task operator authority is no longer current",
              }),
          ),
        )
        // This existing Session mutation gate uses the same DB/service instance. It neither
        // initializes a Location nor materializes models, tools, plugins or an execution graph.
        yield* sessions.requireWritable(SessionSchema.ID.make(parentSessionID)).pipe(
          Effect.mapError(
            (error) =>
              new TaskHumanControlSchema.Error({
                code:
                  error instanceof WorkAuthoritySchema.Error || error instanceof GoalChildSchema.Error
                    ? "unsupported"
                    : "scope_changed",
                message: "Task control requires the original ordinary parent Session authority",
              }),
          ),
        )
        return { principal: `server:${config.username}` }
      }),
  }
  return yield* TaskHumanControl.control(database.db, input).pipe(Effect.provideService(TaskHumanControl.Actor, actor))
})

/** Captures the listener's real local profile and the process-global execution instance.
 * A shared server port can invoke this closure without building another service graph. */
export const bind = Effect.gen(function* () {
  const database = yield* Database.Service
  const sessions = yield* SessionV2.Service
  const execution = yield* SessionExecution.Service
  const config = yield* ServerAuth.Config
  const cors = yield* CorsConfig
  const capability = yield* Attention.Access
  return (input: unknown, request: HttpServerRequest.HttpServerRequest) =>
    control(input, request).pipe(
      Effect.provideService(Database.Service, database),
      Effect.provideService(SessionV2.Service, sessions),
      Effect.provideService(SessionExecution.Service, execution),
      Effect.provideService(ServerAuth.Config, config),
      Effect.provideService(CorsConfig, cors),
      Effect.provideService(Attention.Access, capability),
    )
})
