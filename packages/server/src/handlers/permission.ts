import { Location } from "@deepagent-code/core/location"
import { PermissionV2 } from "@deepagent-code/core/permission"
import { PermissionSaved } from "@deepagent-code/core/permission/saved"
import { SessionV2 } from "@deepagent-code/core/session"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentActivityAuthority } from "@deepagent-code/core/deepagent/activity-authority"
import { SessionActivityTable } from "@deepagent-code/core/context-federation/session-sql"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { PermissionNotFoundError } from "../errors"
import { response } from "../groups/location"

function missingRequest(id: PermissionV2.ID) {
  return new PermissionNotFoundError({ requestID: id, message: `Permission request not found: ${id}` })
}

export const PermissionHandler = HttpApiBuilder.group(Api, "server.permission", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const session = yield* SessionV2.Service
    return handlers
      .handle(
        "permission.request.list",
        Effect.fn(function* () {
          return yield* response((yield* PermissionV2.Service).list())
        }),
      )
      .handle(
        "session.permission.list",
        Effect.fn(function* (ctx) {
          const permission = yield* PermissionV2.Service
          return { data: yield* permission.forSession(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.permission.reply",
        Effect.fn(function* (ctx) {
          const permission = yield* PermissionV2.Service
          const request = yield* permission.get(ctx.params.requestID)
          if (!request || request.sessionID !== ctx.params.sessionID) return yield* missingRequest(ctx.params.requestID)
          yield* permission
            .reply({ requestID: ctx.params.requestID, reply: ctx.payload.reply, message: ctx.payload.message })
            .pipe(Effect.catchTag("PermissionV2.NotFoundError", () => missingRequest(ctx.params.requestID)))
          if (request.metadata?.["kind"] === "no_progress" && ctx.payload.reply !== "reject") {
            const activityID = request.metadata["activity_id"]
            if (typeof activityID === "string") {
              const current = yield* DeepAgentActivityAuthority.reconstruct({
                activityKind: "v2",
                activityID,
              }).pipe(Effect.provideService(Database.Service, database), Effect.orDie)
              const active = current.objective.state === "active" && (yield* database.db
                .select({ activityID: SessionActivityTable.activity_id })
                .from(SessionActivityTable)
                .where(and(eq(SessionActivityTable.activity_id, activityID),
                  eq(SessionActivityTable.session_id, ctx.params.sessionID), eq(SessionActivityTable.state, "active")))
                .get().pipe(Effect.orDie))
              if (active)
                yield* session.resume(ctx.params.sessionID, { activityID }).pipe(
                  Effect.catchCause((cause) => Effect.logError("V2 no-progress continuation failed", { cause })),
                  Effect.forkDetach,
                )
            }
          }
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "permission.saved.list",
        Effect.fn(function* (ctx) {
          const location = yield* Location.Service
          return {
            data: yield* (yield* PermissionSaved.Service).list({
              projectID: ctx.query.projectID ?? location.project.id,
            }),
          }
        }),
      )
      .handle(
        "permission.saved.remove",
        Effect.fn(function* (ctx) {
          yield* (yield* PermissionSaved.Service).remove(ctx.params.id)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
