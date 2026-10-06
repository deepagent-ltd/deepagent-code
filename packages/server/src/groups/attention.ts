import { AttentionSchema } from "@deepagent-code/core/attention/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, ServiceUnavailableError } from "../errors"

export class AttentionNotFoundError extends Schema.TaggedErrorClass<AttentionNotFoundError>()(
  "AttentionNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

const scopeQuery = { workspace: Schema.optional(Schema.String), directory: Schema.optional(Schema.String) }
const errors = [InvalidRequestError, ServiceUnavailableError]

export const AttentionGroup = HttpApiGroup.make("server.attention").add(
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
