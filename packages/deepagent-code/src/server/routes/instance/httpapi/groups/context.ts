import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SelectionContract } from "@deepagent-code/core/contract/selection"
import { Authorization } from "../middleware/authorization"
import { ApiTypedError } from "../typed-error"
import { described } from "./metadata"

// C6-03 (design §11.1 + §11.2): context readiness + the snapshot-at-watermark
// event-cursor contract.
//
// - `readiness` reports the four-graph status (GraphStatus: ready / empty /
//   degraded_unavailable / denied / timeout) from the C3 resolver for a session.
//   It never leaks an unauthorized body — only per-graph status identity fields.
// - `eventsCursor` returns `{ watermark, cursor, floor }` so a client can
//   hydrate a snapshot at the watermark then drain `after=W`.
// - `events` drains durable events after `W`, returns `{ events, nextCursor,
//   floor }`. Passing a cursor below the retained floor is a typed 410
//   (`cursor_gap_exceeded` — bounded resync required). The durable store is the
//   ONLY authority: there is no volatile fallback, so an unavailable durable
//   cursor is an error, never a silent live stream.
//
// NOTE (routing): the design's `session.eventsCursor/events` are surfaced here
// on the /context group to keep the session-scoped path-table clean; the logical
// operations (`context.eventsCursor` / `context.events`) are equivalent.

const root = "/context"

export const ContextPaths = {
  readiness: `${root}/readiness`,
  eventsCursor: `${root}/eventsCursor`,
  events: `${root}/events`,
} as const

export const ContextSessionQuery = Schema.Struct({
  session_id: Schema.String,
}).annotate({ identifier: "ContextSessionQuery" })

export const ContextEventsQuery = Schema.Struct({
  session_id: Schema.String,
  after: Schema.optional(Schema.NumberFromString),
  limit: Schema.optional(Schema.NumberFromString),
}).annotate({ identifier: "ContextEventsQuery" })

/** Per-graph readiness (the C3 GraphStatus shape). */
export const ContextGraphStatusSchema = SelectionContract.GraphStatus

const ContextReadinessSchema = Schema.Struct({
  session_id: Schema.String,
  ready: Schema.Boolean,
  graphs: Schema.Array(ContextGraphStatusSchema),
  statuses: Schema.Record(Schema.String, ContextGraphStatusSchema),
}).annotate({ identifier: "ContextReadiness" })

const EventsCursorSchema = Schema.Struct({
  watermark: Schema.Int,
  cursor: Schema.Int,
  floor: Schema.Int,
}).annotate({ identifier: "ContextEventsCursor" })

const SessionEventSchema = Schema.Struct({
  id: Schema.String,
  seq: Schema.Int,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "ContextSessionEvent" })

const SessionEventsSchema = Schema.Struct({
  events: Schema.Array(SessionEventSchema),
  nextCursor: Schema.optional(Schema.Int),
  floor: Schema.Int,
}).annotate({ identifier: "ContextSessionEvents" })

export const ContextApi = HttpApi.make("context").add(
  HttpApiGroup.make("context")
    .add(
      HttpApiEndpoint.get("readiness", ContextPaths.readiness, {
        query: ContextSessionQuery,
        success: described(ContextReadinessSchema, "Four-graph context readiness"),
        error: ApiTypedError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "context.readiness",
          summary: "Context readiness for a session",
          description:
            "Reports the four-graph status (code/documents/knowledge/memory) from the C3 resolver for a session. Returns per-graph GraphStatus (ready/empty/degraded_unavailable/denied/timeout) — never a context body; an unauthorized graph is only surfaced as its status.",
        }),
      ),
      HttpApiEndpoint.get("eventsCursor", ContextPaths.eventsCursor, {
        query: ContextSessionQuery,
        success: described(EventsCursorSchema, "Event cursor (snapshot-at-watermark)"),
        error: ApiTypedError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "context.eventsCursor",
          summary: "Read the durable event cursor for a session",
          description:
            "Returns { watermark, cursor, floor } for a session's durable event aggregate. A client hydrates its snapshot at `watermark`, then drains `after=cursor`. The durable store is the only authority.",
        }),
      ),
      HttpApiEndpoint.get("events", ContextPaths.events, {
        query: ContextEventsQuery,
        success: described(SessionEventsSchema, "Durable session events drained after a cursor"),
        error: ApiTypedError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "context.events",
          summary: "Drain durable session events after a cursor",
          description:
            "Drains durable events after `after` up to `limit` (bounded page). Returns { events, nextCursor, floor }. A cursor below the retained floor is a typed 410 (cursor_gap_exceeded); an over-limit request is a typed 400. Never falls back to a volatile stream.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "context",
        description: "Context readiness + event cursor HttpApi surface (C6-03).",
      }),
    )
    .middleware(Authorization),
)
