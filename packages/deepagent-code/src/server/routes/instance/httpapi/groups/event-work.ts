import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { EventWorkManagementSchema } from "@deepagent-code/core/deepagent/event-work-management.schema"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const source = { sourceSessionID: Text }
export const CandidateInput = Schema.Struct(source)
export const RulesInput = Schema.Struct({ ...source, ...EventWorkManagementSchema.Page.fields })
export const RootsInput = Schema.Struct({ ...RulesInput.fields, ruleID: Schema.optional(Text) })
export const RuleControlInput = Schema.Struct({ ...source, ...EventWorkManagementSchema.RuleCommand.fields })
export const RootControlInput = Schema.Struct({ ...source, ...EventWorkManagementSchema.RootCommand.fields })
export const SessionInput = Schema.Struct({ ...source, rootID: Text, nodeID: Text })
export const RulesPage = Schema.Struct({
  items: Schema.Array(EventWorkManagementSchema.Rule).check(Schema.isMaxLength(32)),
  nextCursor: Schema.NullOr(Text),
}).annotate({ identifier: "EventWorkRulesPage" })
export const RootsPage = Schema.Struct({
  items: Schema.Array(EventWorkManagementSchema.Root).check(Schema.isMaxLength(32)),
  nextCursor: Schema.NullOr(Text),
}).annotate({ identifier: "EventWorkRootsPage" })

const fields = { code: Schema.String, message: Schema.String }
export class EventWorkInvalid extends Schema.ErrorClass<EventWorkInvalid>("EventWorkInvalid")(
  { ...fields, status: Schema.Literal(400) },
  { httpApiStatus: 400 },
) {}
export class EventWorkForbidden extends Schema.ErrorClass<EventWorkForbidden>("EventWorkForbidden")(
  { ...fields, status: Schema.Literal(403) },
  { httpApiStatus: 403 },
) {}
export class EventWorkConflict extends Schema.ErrorClass<EventWorkConflict>("EventWorkConflict")(
  { ...fields, status: Schema.Literal(409) },
  { httpApiStatus: 409 },
) {}
export class EventWorkUnavailable extends Schema.ErrorClass<EventWorkUnavailable>("EventWorkUnavailable")(
  { ...fields, status: Schema.Literal(503) },
  { httpApiStatus: 503 },
) {}
const errors = [EventWorkInvalid, EventWorkForbidden, EventWorkConflict, EventWorkUnavailable] as const

// Every lookup is scoped to an ordinary source Session and the original enrolled operator.
// POST keeps Session hints out of URLs; read endpoints never mint an execution grant.
export const EventWorkApi = HttpApi.make("event-work").add(
  HttpApiGroup.make("eventWork")
    .add(
      HttpApiEndpoint.post("candidates", "/api/v1/event-work/candidates", {
        query: WorkspaceRoutingQuery,
        payload: CandidateInput,
        success: Schema.Array(EventWorkManagementSchema.Candidate).check(Schema.isMaxLength(32)),
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("rules", "/api/v1/event-work/rules", {
        query: WorkspaceRoutingQuery,
        payload: RulesInput,
        success: RulesPage,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("roots", "/api/v1/event-work/roots", {
        query: WorkspaceRoutingQuery,
        payload: RootsInput,
        success: RootsPage,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("ruleControl", "/api/v1/event-work/rules/control", {
        query: WorkspaceRoutingQuery,
        payload: RuleControlInput,
        success: EventWorkManagementSchema.RuleCommandResult,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("rootControl", "/api/v1/event-work/roots/control", {
        query: WorkspaceRoutingQuery,
        payload: RootControlInput,
        success: EventWorkManagementSchema.RootCommandResult,
        error: errors,
      }),
    )
    .add(
      HttpApiEndpoint.post("session", "/api/v1/event-work/session", {
        query: WorkspaceRoutingQuery,
        payload: SessionInput,
        success: EventWorkManagementSchema.SessionPointer,
        error: errors,
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
