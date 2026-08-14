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
import { FilePartArtifact } from "@deepagent-code/core/file-part-artifact"

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
export const SnapshotDescriptor = Schema.Struct({
  snapshotID: Schema.String,
  aggregateID: Schema.String,
  throughSeq: NonNegativeInt,
  syncSeq: NonNegativeInt,
  codec: Schema.String,
  schemaVersion: NonNegativeInt,
  snapshotHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  body: Schema.Record(Schema.String, Schema.Unknown),
  ownerID: Schema.optional(Schema.String),
  createdAt: NonNegativeInt,
})
export const HistoryResync = Schema.Struct({
  kind: Schema.Literal("resync_required"),
  snapshot: SnapshotDescriptor,
})
export const HistoryEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  items: Schema.Array(Schema.Union([HistoryEvent, HistoryResync])),
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
export const EventIndexMaintenancePayload = Schema.Struct({
  limit: Schema.optional(NonNegativeInt),
})
export const EventIndexMaintenanceResponse = Schema.Struct({
  processed: NonNegativeInt,
  complete: Schema.Boolean,
})
export const FileArtifactMetadataPayload = Schema.Struct({
  eventID: EventV2.ID,
  aggregateID: Schema.String,
  seq: NonNegativeInt,
  artifactID: FilePartArtifact.ID,
})
export const FileArtifactChunkPayload = Schema.Struct({
  eventID: EventV2.ID,
  aggregateID: Schema.String,
  seq: NonNegativeInt,
  artifactID: FilePartArtifact.ID,
  index: NonNegativeInt,
  hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
export const FileArtifactChunkResponse = Schema.Struct({
  artifactID: FilePartArtifact.ID,
  index: NonNegativeInt,
  hash: Schema.String,
  data: Schema.String,
})
export const SnapshotRowsPayload = Schema.Struct({
  aggregateID: Schema.String,
  snapshotID: Schema.String,
  snapshotHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  after: Schema.optional(Schema.Number),
  limit: Schema.optional(NonNegativeInt),
})
export const SnapshotRow = Schema.Struct({
  snapshotID: Schema.String,
  rowIndex: NonNegativeInt,
  tableName: Schema.String,
  rowKey: Schema.String,
  rowHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  rowBytes: NonNegativeInt,
  chunkCount: NonNegativeInt,
  chainHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
export const SnapshotRowsResponse = Schema.Struct({ rows: Schema.Array(SnapshotRow), complete: Schema.Boolean })
export const SnapshotChunksPayload = Schema.Struct({
  aggregateID: Schema.String,
  snapshotID: Schema.String,
  snapshotHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  rowHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  after: Schema.optional(Schema.Number),
  limit: Schema.optional(NonNegativeInt),
})
export const SnapshotChunk = Schema.Struct({
  rowHash: Schema.String,
  chunkIndex: NonNegativeInt,
  data: Schema.String,
  chunkHash: Schema.String,
})
export const SnapshotChunksResponse = Schema.Struct({ chunks: Schema.Array(SnapshotChunk), complete: Schema.Boolean })
export const CheckpointPreparePayload = Schema.Struct({ aggregateID: SessionID })
export const CheckpointStagePayload = Schema.Struct({
  snapshotID: Schema.String,
  limit: Schema.optional(NonNegativeInt),
})
export const CheckpointFinalizePayload = Schema.Struct({ snapshotID: Schema.String })
export const CheckpointDiscardPayload = Schema.Struct({
  snapshotID: Schema.String,
  limit: Schema.optional(NonNegativeInt),
})
export const CheckpointCompactPayload = Schema.Struct({
  aggregateID: SessionID,
  limit: Schema.optional(NonNegativeInt),
})
export const CheckpointAttempt = Schema.Struct({
  snapshotID: Schema.String,
  aggregateID: Schema.String,
  throughSeq: NonNegativeInt,
  expectedLatest: NonNegativeInt,
  ownerID: Schema.optional(Schema.String),
  codec: Schema.String,
  schemaVersion: NonNegativeInt,
  cursor: Schema.optional(Schema.String),
  rowCount: NonNegativeInt,
  encodedBytes: NonNegativeInt,
  state: Schema.Literals(["prepared", "staged", "complete"]),
  hasMore: Schema.Boolean,
})
export const CheckpointDiscardResponse = Schema.Struct({ deletedRows: NonNegativeInt, complete: Schema.Boolean })
export const CheckpointCompactResponse = Schema.Struct({ deleted: NonNegativeInt, complete: Schema.Boolean })

export const SyncPaths = {
  start: `${root}/start`,
  replay: `${root}/replay`,
  steal: `${root}/steal`,
  history: `${root}/history`,
  artifacts: `${root}/maintenance/artifacts`,
  fileArtifacts: `${root}/maintenance/file-artifacts`,
  eventIndex: `${root}/maintenance/event-index`,
  fileArtifactMetadata: `${root}/artifact/file/metadata`,
  fileArtifactChunk: `${root}/artifact/file/chunk`,
  snapshotRows: `${root}/snapshot/rows`,
  snapshotChunks: `${root}/snapshot/chunks`,
  checkpointPrepare: `${root}/maintenance/checkpoint/prepare`,
  checkpointStage: `${root}/maintenance/checkpoint/stage`,
  checkpointFinalize: `${root}/maintenance/checkpoint/finalize`,
  checkpointDiscard: `${root}/maintenance/checkpoint/discard`,
  checkpointCompact: `${root}/maintenance/checkpoint/compact`,
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
        HttpApiEndpoint.post("eventIndex", SyncPaths.eventIndex, {
          query: WorkspaceRoutingQuery,
          payload: EventIndexMaintenancePayload,
          success: described(EventIndexMaintenanceResponse, "Advanced one bounded EventV2 sync-index backfill batch"),
          error: [HttpApiError.BadRequest, ServiceUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.maintenance.event-index",
            summary: "Backfill a bounded EventV2 sync-index batch",
            description: "Run one authenticated, idempotent maintenance batch without starting an automatic table scan.",
            exclude: true,
          }),
        ),
        HttpApiEndpoint.post("fileArtifacts", SyncPaths.fileArtifacts, {
          query: WorkspaceRoutingQuery,
          payload: ArtifactMaintenancePayload,
          success: described(ArtifactMaintenanceResponse, "Externalized legacy oversized file-part artifacts"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.maintenance.file-artifacts",
            summary: "Externalize a bounded legacy file-part batch",
            description: "Run one authenticated, idempotent file-part artifact maintenance batch.",
            exclude: true,
          }),
        ),
        HttpApiEndpoint.post("fileArtifactMetadata", SyncPaths.fileArtifactMetadata, {
          query: WorkspaceRoutingQuery,
          payload: FileArtifactMetadataPayload,
          success: described(FilePartArtifact.Metadata, "Scoped file-part artifact metadata"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.artifact.file.metadata",
            summary: "Read scoped file-part artifact metadata",
            description: "Resolve a content-addressed file-part descriptor only through its exact workspace event binding.",
          }),
        ),
        HttpApiEndpoint.post("fileArtifactChunk", SyncPaths.fileArtifactChunk, {
          query: WorkspaceRoutingQuery,
          payload: FileArtifactChunkPayload,
          success: described(FileArtifactChunkResponse, "One verified file-part artifact chunk"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "sync.artifact.file.chunk",
            summary: "Read one verified file-part artifact chunk",
            description: "Return one bounded base64 chunk after workspace scope and expected hash validation.",
          }),
        ),
        HttpApiEndpoint.post("snapshotRows", SyncPaths.snapshotRows, {
          query: WorkspaceRoutingQuery,
          payload: SnapshotRowsPayload,
          success: described(SnapshotRowsResponse, "One bounded scoped snapshot row page"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound, ServiceUnavailableError],
        }),
        HttpApiEndpoint.post("snapshotChunks", SyncPaths.snapshotChunks, {
          query: WorkspaceRoutingQuery,
          payload: SnapshotChunksPayload,
          success: described(SnapshotChunksResponse, "One bounded scoped snapshot chunk page"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound, ServiceUnavailableError],
        }),
        HttpApiEndpoint.post("checkpointPrepare", SyncPaths.checkpointPrepare, {
          query: WorkspaceRoutingQuery,
          payload: CheckpointPreparePayload,
          success: described(CheckpointAttempt, "Prepared bounded canonical checkpoint"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound, ConflictError, ServiceUnavailableError],
        }).annotateMerge(OpenApi.annotations({ identifier: "sync.maintenance.checkpoint.prepare", summary: "Prepare a canonical checkpoint", exclude: true })),
        HttpApiEndpoint.post("checkpointStage", SyncPaths.checkpointStage, {
          query: WorkspaceRoutingQuery,
          payload: CheckpointStagePayload,
          success: described(CheckpointAttempt, "Staged one bounded canonical checkpoint batch"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound, ConflictError, ServiceUnavailableError],
        }).annotateMerge(OpenApi.annotations({ identifier: "sync.maintenance.checkpoint.stage", summary: "Stage one bounded checkpoint batch", exclude: true })),
        HttpApiEndpoint.post("checkpointFinalize", SyncPaths.checkpointFinalize, {
          query: WorkspaceRoutingQuery,
          payload: CheckpointFinalizePayload,
          success: described(SnapshotDescriptor, "Finalized active canonical checkpoint"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound, ConflictError, ServiceUnavailableError],
        }).annotateMerge(OpenApi.annotations({ identifier: "sync.maintenance.checkpoint.finalize", summary: "Finalize a canonical checkpoint", exclude: true })),
        HttpApiEndpoint.post("checkpointDiscard", SyncPaths.checkpointDiscard, {
          query: WorkspaceRoutingQuery,
          payload: CheckpointDiscardPayload,
          success: described(CheckpointDiscardResponse, "Discarded one bounded prepared checkpoint batch"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound, ConflictError, ServiceUnavailableError],
        }).annotateMerge(OpenApi.annotations({ identifier: "sync.maintenance.checkpoint.discard", summary: "Discard one prepared checkpoint batch", exclude: true })),
        HttpApiEndpoint.post("checkpointCompact", SyncPaths.checkpointCompact, {
          query: WorkspaceRoutingQuery,
          payload: CheckpointCompactPayload,
          success: described(CheckpointCompactResponse, "Compacted one bounded retained EventV2 batch"),
          error: [HttpApiError.BadRequest, HttpApiError.NotFound, ConflictError, ServiceUnavailableError],
        }).annotateMerge(OpenApi.annotations({ identifier: "sync.maintenance.checkpoint.compact", summary: "Compact one active checkpoint event batch", exclude: true })),
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
