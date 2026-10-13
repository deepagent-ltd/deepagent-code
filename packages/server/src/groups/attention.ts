import { AttentionSchema } from "@deepagent-code/core/attention/schema"
import { TaskHumanControlSchema } from "@deepagent-code/core/session/task-human-control.schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "../errors"

export class AttentionNotFoundError extends Schema.TaggedErrorClass<AttentionNotFoundError>()(
  "AttentionNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

const controlError = { code: TaskHumanControlSchema.Error.fields.code, message: Schema.String }
export class TaskControlInvalidError extends Schema.TaggedErrorClass<TaskControlInvalidError>()(
  "TaskControlInvalidError",
  controlError,
  { httpApiStatus: 400 },
) {}
export class TaskControlAuthenticationError extends Schema.TaggedErrorClass<TaskControlAuthenticationError>()(
  "TaskControlAuthenticationError",
  controlError,
  { httpApiStatus: 401 },
) {}
export class TaskControlForbiddenError extends Schema.TaggedErrorClass<TaskControlForbiddenError>()(
  "TaskControlForbiddenError",
  controlError,
  { httpApiStatus: 403 },
) {}
export class TaskControlConflictError extends Schema.TaggedErrorClass<TaskControlConflictError>()(
  "TaskControlConflictError",
  controlError,
  { httpApiStatus: 409 },
) {}
export class TaskControlLimitError extends Schema.TaggedErrorClass<TaskControlLimitError>()(
  "TaskControlLimitError",
  controlError,
  { httpApiStatus: 429 },
) {}
export class TaskControlUnavailableError extends Schema.TaggedErrorClass<TaskControlUnavailableError>()(
  "TaskControlUnavailableError",
  controlError,
  { httpApiStatus: 503 },
) {}

const scopeQuery = { workspace: Schema.optional(Schema.String), directory: Schema.optional(Schema.String) }
const errors = [InvalidRequestError, ServiceUnavailableError]

export const AttentionGroup = HttpApiGroup.make("server.attention").add(
  HttpApiEndpoint.post("attention.taskControl", "/api/attention/task/control", {
    query: Schema.Struct(scopeQuery),
    payload: TaskHumanControlSchema.Input,
    success: TaskHumanControlSchema.Result,
    error: [
      InvalidRequestError,
      TaskControlInvalidError,
      TaskControlAuthenticationError,
      TaskControlForbiddenError,
      TaskControlConflictError,
      TaskControlLimitError,
      TaskControlUnavailableError,
    ],
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.attention.taskControl",
      summary: "Control an original ordinary Task through authenticated human authority",
    }),
  ),
  HttpApiEndpoint.get("attention.capability", "/api/attention/capability", {
    query: Schema.Struct(scopeQuery),
    success: AttentionSchema.Capability,
    error: InvalidRequestError,
  }).annotateMerge(
    OpenApi.annotations({ identifier: "v2.attention.capability", summary: "Read local attention capability" }),
  ),
  HttpApiEndpoint.get("attention.list", "/api/attention", {
    query: Schema.Struct({
      ...scopeQuery,
      project: Schema.optional(Schema.String),
      kind: Schema.optional(AttentionSchema.Kind),
      view: Schema.optional(Schema.Literals(["all", "unseen"])),
      cursor: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.NumberFromString),
    }),
    success: AttentionSchema.List,
    error: errors,
  }).annotateMerge(
    OpenApi.annotations({ identifier: "v2.attention.list", summary: "List durable local attention items" }),
  ),
  HttpApiEndpoint.get("attention.get", "/api/attention/:itemID", {
    params: { itemID: Schema.String },
    query: Schema.Struct(scopeQuery),
    success: Schema.Struct({ data: AttentionSchema.Item }),
    error: [...errors, AttentionNotFoundError],
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.attention.get",
      summary: "Read an attention item without resuming execution",
    }),
  ),
  HttpApiEndpoint.put("attention.seen", "/api/attention/:itemID/seen", {
    params: { itemID: Schema.String },
    query: Schema.Struct(scopeQuery),
    payload: Schema.Struct({ revision: Schema.String }),
    success: Schema.Struct({ data: AttentionSchema.Item }),
    error: [...errors, AttentionNotFoundError, ConflictError],
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.attention.seen",
      summary: "Mark only an observed attention revision as viewed",
    }),
  ),
)
