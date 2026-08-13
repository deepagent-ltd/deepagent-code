import { NonNegativeInt } from "@deepagent-code/core/schema"
import { EventV2 } from "@deepagent-code/core/event"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ConflictError, ServiceUnavailableError } from "../errors"
import { SyncReplayLimits } from "@/sync/replay-protocol"

const root = "/sync"
export { SyncReplayLimits } from "@/sync/replay-protocol"
export const ReplayEvent = Schema.Struct({
  id: EventV2.ID.check(Schema.isMaxLength(SyncReplayLimits.eventIDCharacters)),
  aggregateID: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SyncReplayLimits.aggregateIDCharacters),
  ),
  seq: NonNegativeInt,
  type: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(SyncReplayLimits.typeCharacters)),
  data: Schema.Record(Schema.String, Schema.Unknown),
})
export const ReplayPayload = Schema.Struct({
  directory: Schema.String.check(Schema.isMaxLength(SyncReplayLimits.directoryCharacters)),
  events: Schema.NonEmptyArray(ReplayEvent).check(Schema.isMaxLength(SyncReplayLimits.events)),
})
export const ReplayResponse = Schema.Struct({
  sessionID: Schema.String,
})
export const SessionPayload = Schema.Struct({
  sessionID: SessionID,
})
export const HistoryKnown = Schema.Record(Schema.String, NonNegativeInt)
export const HistoryPayload = Schema.Union([
  HistoryKnown,
  Schema.Struct({
    version: Schema.Literal(1),
    cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
    known: Schema.optional(HistoryKnown),
  }),
])
export const HistoryEvent = Schema.Struct({
  kind: Schema.Literal("event"),
  id: EventV2.ID,
  aggregate_id: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
})
export const HistoryEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  items: Schema.Array(HistoryEvent),
  nextCursor: Schema.String,
  complete: Schema.Boolean,
})
export const ArtifactMaintenancePayload = Schema.Struct({
  cursor: Schema.optional(EventV2.ID),
  limit: Schema.optional(NonNegativeInt),
})
export const ArtifactMaintenanceResponse = Schema.Struct({
  processed: NonNegativeInt,
  nextCursor: Schema.optional(EventV2.ID),
})

export const SyncPaths = {
  start: `${root}/start`,
  replay: `${root}/replay`,
  steal: `${root}/steal`,
  history: `${root}/history`,
  artifacts: `${root}/maintenance/artifacts`,
} as const

export const SyncApi = HttpApi.make("sync")
  .add(
    HttpApiGroup.make("sync")
      .add(
        HttpApiEndpoint.post("start", SyncPaths.start, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Workspace sync started"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.start",
            summary: "Start workspace sync",
            description: "Start sync loops for workspaces in the current project that have active sessions.",
          }),
        ),
        HttpApiEndpoint.post("replay", SyncPaths.replay, {
          query: WorkspaceRoutingQuery,
          payload: ReplayPayload,
          success: described(ReplayResponse, "Replayed sync events"),
          error: [HttpApiError.BadRequest, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.replay",
            summary: "Replay sync events",
            description: "Validate and replay a complete sync event history.",
          }),
        ),
        HttpApiEndpoint.post("steal", SyncPaths.steal, {
          query: WorkspaceRoutingQuery,
          payload: SessionPayload,
          success: described(Schema.Never, "Disabled until durable ownership transfer is available"),
          error: [HttpApiError.BadRequest, ConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.steal",
            summary: "Reject unsupported session ownership transfer",
            description:
              "This endpoint is disabled until durable transfer admission, source fencing, and canonical owner handoff are available.",
            exclude: true,
          }),
        ),
        HttpApiEndpoint.post("history", SyncPaths.history, {
          query: WorkspaceRoutingQuery,
          payload: HistoryPayload,
          success: described(HistoryEnvelope, "Bounded sync history page"),
          error: [HttpApiError.BadRequest, ConflictError, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.history.list",
            summary: "List sync events",
            description:
              "List a bounded page with an opaque global cursor. A bounded legacy aggregate map is accepted only for the first upgrade request. Retention-floor crossings return resync_required with a canonical snapshot.",
          }),
        ),
        HttpApiEndpoint.post("artifacts", SyncPaths.artifacts, {
          query: WorkspaceRoutingQuery,
          payload: ArtifactMaintenancePayload,
          success: described(ArtifactMaintenanceResponse, "Canonicalized legacy EventV2 artifacts"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.maintenance.artifacts",
            summary: "Canonicalize a bounded legacy EventV2 artifact batch",
            description:
              "Run one authenticated, idempotent maintenance batch and return the durable scan cursor for the next call.",
            exclude: true,
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "sync",
          description: "Experimental HttpApi sync routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "deepagent-code experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
