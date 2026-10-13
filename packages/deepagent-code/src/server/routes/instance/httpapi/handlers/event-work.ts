import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { EventWorkRuleSchema } from "@deepagent-code/core/deepagent/event-work-rule.schema"
import { EventWorkDagSchema } from "@deepagent-code/core/deepagent/event-work-dag.schema"
import { LocalOperatorSchema } from "@deepagent-code/core/im/local-operator.schema"
import { EventWorkManagementHost } from "@/session/event-work-management"
import { LocalAuthority } from "@/installation/local-authority"
import { ServerAuth } from "@/server/auth"
import { CorsConfig } from "@/server/cors"
import { InstanceHttpApi } from "../api"
import { WorkspaceRouteContext } from "../middleware/workspace-routing"
import { EventWorkInvalid, EventWorkForbidden, EventWorkConflict, EventWorkUnavailable } from "../groups/event-work"

type Management = Effect.Success<ReturnType<EventWorkManagementHost.Interface["open"]>>

export const eventWorkHandlers = () =>
  HttpApiBuilder.group(InstanceHttpApi, "eventWork", (handlers) =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const config = yield* ServerAuth.Config
      const cors = yield* CorsConfig
      const host = yield* EventWorkManagementHost.make
      const operate = <A, E, R>(
        sourceSessionID: string,
        operation: (management: Management) => Effect.Effect<A, E, R>,
      ) =>
        map(
          Effect.gen(function* () {
            const identity = yield* LocalAuthority.authenticate(
              database.db,
              config,
              yield* HttpServerRequest.HttpServerRequest,
              cors,
            )
            const route = yield* WorkspaceRouteContext
            const management = yield* host.open({
              sourceSessionID,
              directory: route.directory,
              workspaceID: route.workspaceID,
            })
            return yield* LocalAuthority.provide(identity, operation(management))
          }),
        )
      return handlers
        .handle("candidates", ({ payload }) =>
          operate(payload.sourceSessionID, (management) => management.candidates()),
        )
        .handle("rules", ({ payload }) =>
          operate(payload.sourceSessionID, (management) =>
            management.rules({
              limit: payload.limit,
              after: payload.after,
            }),
          ),
        )
        .handle("roots", ({ payload }) =>
          operate(payload.sourceSessionID, (management) =>
            management.roots({
              ruleID: payload.ruleID,
              limit: payload.limit,
              after: payload.after,
            }),
          ),
        )
        .handle("ruleControl", ({ payload }) =>
          operate(payload.sourceSessionID, (management) =>
            management
              .ruleControl({
                ruleID: payload.ruleID,
                requestID: payload.requestID,
                expectedRevision: payload.expectedRevision,
                action: payload.action,
                originID: payload.originID,
                instruction: payload.instruction,
                expiresAt: payload.expiresAt,
              })
              .pipe(
                Effect.map((result) => ({
                  requestID: result.requestID,
                  expectedRevision: result.expectedRevision,
                  action: result.action,
                  replayed: result.replayed,
                  rule: result.rule,
                })),
              ),
          ),
        )
        .handle("rootControl", ({ payload }) =>
          operate(payload.sourceSessionID, (management) =>
            management
              .rootControl({
                rootID: payload.rootID,
                requestID: payload.requestID,
                expectedRevision: payload.expectedRevision,
                action: payload.action,
              })
              .pipe(
                Effect.map((result) => ({
                  requestID: result.requestID,
                  expectedRevision: result.expectedRevision,
                  action: result.action,
                  replayed: result.replayed,
                  root: result.root,
                })),
              ),
          ),
        )
        .handle("session", ({ payload }) =>
          operate(payload.sourceSessionID, (management) =>
            management.session({
              rootID: payload.rootID,
              nodeID: payload.nodeID,
            }),
          ),
        )
    }),
  )

function map<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.mapError((error) => {
      const code =
        error instanceof EventWorkRuleSchema.Error || error instanceof EventWorkDagSchema.Error
          ? error.code
          : error instanceof LocalOperatorSchema.Error && error.code !== "LOCAL_OPERATOR_UNAVAILABLE"
            ? "EVENT_WORK_AUTH_REQUIRED"
            : "EVENT_WORK_UNAVAILABLE"
      const message = "Event work is unavailable, changed, or needs its original request reconciled"
      if (code === "EVENT_WORK_AUTH_REQUIRED") return new EventWorkForbidden({ status: 403, code, message })
      if (code === "EVENT_WORK_INVALID" || code === "EVENT_DAG_INVALID")
        return new EventWorkInvalid({ status: 400, code, message })
      if (
        [
          "EVENT_WORK_CONFLICT",
          "EVENT_WORK_SOURCE_CHANGED",
          "EVENT_WORK_EXPIRED",
          "EVENT_WORK_QUOTA",
          "EVENT_DAG_CONFLICT",
          "EVENT_DAG_SOURCE_CHANGED",
          "EVENT_DAG_UNKNOWN",
          "EVENT_DAG_NOT_READY",
          "EVENT_DAG_CAPACITY",
        ].includes(code)
      )
        return new EventWorkConflict({ status: 409, code, message })
      return new EventWorkUnavailable({ status: 503, code, message })
    }),
  )
}
