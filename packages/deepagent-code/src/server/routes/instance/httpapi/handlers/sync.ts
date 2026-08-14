import { Workspace } from "@/control-plane/workspace"
import * as InstanceState from "@/effect/instance-state"
import { MessageV2 } from "@/session/message-v2"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import {
  EventArtifactTable,
  EventSequenceTable,
  EventSnapshotAttemptTable,
  EventSnapshotRowTable,
  EventSnapshotTable,
  EventSyncIndexTable,
  EventSyncSequenceTable,
  EventTable,
} from "@deepagent-code/core/event/sql"
import { asc } from "drizzle-orm"
import { and } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lte } from "drizzle-orm"
import { gt } from "drizzle-orm"
import { not } from "drizzle-orm"
import { or } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { Effect, Option, Schema, Scope } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  ArtifactMaintenancePayload,
  CheckpointCompactPayload,
  CheckpointDiscardPayload,
  CheckpointFinalizePayload,
  CheckpointPreparePayload,
  CheckpointStagePayload,
  EventIndexMaintenancePayload,
  FileArtifactChunkPayload,
  FileArtifactMetadataPayload,
  HistoryPayload,
  ReplayPayload,
  SessionPayload,
  SnapshotChunksPayload,
  SnapshotRowsPayload,
} from "../groups/sync"
import { encodeReplayRequestPrefix } from "@/sync/replay-protocol"
import * as Log from "@deepagent-code/core/util/log"
import { ServiceUnavailableError } from "../errors"
import { ConflictError } from "../errors"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ProjectV2 } from "@deepagent-code/core/project"
import { SessionID } from "@/session/schema"
import { Flag } from "@deepagent-code/core/flag/flag"
import { WorkspaceAdapterRuntime } from "@/control-plane/workspace-adapter-runtime"
import { createHmac, timingSafeEqual } from "node:crypto"
import { FilePartArtifact } from "@deepagent-code/core/file-part-artifact"
import { FilePartArtifactBindingTable } from "@deepagent-code/core/file-part-artifact.sql"

const log = Log.create({ service: "server.sync" })
export const SyncHistoryLimits = {
  events: 100,
  dataBytes: 4 * 1024 * 1024,
  wireBytes: 5 * 1024 * 1024 + 64 * 1024,
  legacyKnownAggregates: 256,
} as const
const HistoryCursor = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String,
  generation: Schema.String,
  syncSeq: Schema.Number,
})
const decodeHistoryCursor = Schema.decodeUnknownOption(Schema.fromJsonString(HistoryCursor))
const encodeHistoryCursor = (scope: string, generation: string, secret: string, syncSeq: number) => {
  const payload = Buffer.from(JSON.stringify({ version: 1, scope, generation, syncSeq })).toString("base64url")
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`
}
const historyCursor = (scope: string, generation: string, secret: string, highWater: number, value: string | undefined) => {
  if (!value) return -1
  const [payload, signature, extra] = value.split(".")
  if (!payload || !signature || extra) return
  const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url"))
  const supplied = Buffer.from(signature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return
  const decoded = Option.getOrUndefined(decodeHistoryCursor(Buffer.from(payload, "base64url").toString()))
  if (!decoded || decoded.scope !== scope || decoded.generation !== generation) return
  if (!Number.isSafeInteger(decoded.syncSeq) || decoded.syncSeq < -1 || decoded.syncSeq > highWater) return
  return decoded.syncSeq
}
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const projectedEventData = sql<string>`COALESCE(${FilePartArtifactBindingTable.canonical_data}, ${EventArtifactTable.canonical_data}, CASE
  WHEN ${EventTable.type} = ${EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1)}
    AND json_valid(${EventTable.data})
    AND json_type(${EventTable.data}, '$.info.summary.diffs') = 'array'
    AND length(${EventTable.data}) > ${SyncHistoryLimits.dataBytes}
  THEN json_set(${EventTable.data}, '$.info.summary.diffs', json('[]'))
  WHEN ${EventTable.type} = ${EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1)}
    AND json_valid(${EventTable.data})
    AND json_type(${EventTable.data}, '$.info.summary.diffs') = 'array'
  THEN json_set(
    ${EventTable.data},
    '$.info.summary.diffs',
    json(COALESCE((
      SELECT json_group_array(json_remove(value, '$.patch'))
      FROM (
        SELECT value
        FROM json_each(json_extract(${EventTable.data}, '$.info.summary.diffs'))
        LIMIT ${MessageV2.ClientDiffLimits.files}
      )
    ), '[]'))
  )
  ELSE ${EventTable.data}
END)`
export const syncHandlers = HttpApiBuilder.group(InstanceHttpApi, "sync", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const scope = yield* Scope.Scope
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const start = Effect.fn("SyncHttpApi.start")(function* () {
      yield* workspace
        .startWorkspaceSyncing((yield* InstanceState.context).project.id)
        .pipe(Effect.ignore, Effect.forkIn(scope))
      return true
    })

    const replay = Effect.fn("SyncHttpApi.replay")(function* (ctx: { payload: typeof ReplayPayload.Type }) {
      const payload: EventV2.SerializedEvent[] = [...ctx.payload.events]
      const encoded = encodeReplayRequestPrefix(ctx.payload.directory, payload)
      if (!encoded.complete || encoded.events.length !== payload.length) return yield* new HttpApiError.BadRequest({})
      const instance = yield* InstanceState.context
      const source = payload[0].aggregateID
      const ownerID = yield* InstanceState.workspaceID
      if (!ownerID) return yield* new HttpApiError.BadRequest({})
      const selected = ownerID ? yield* workspace.get(ownerID) : undefined
      if (selected && Flag.DEEPAGENT_CODE_WORKSPACE_ID !== ownerID) {
        const target = yield* WorkspaceAdapterRuntime.target(selected)
        if (target.type === "remote")
          return yield* new ConflictError({
            message: "Remote replay requires a durable transfer operation receipt and a compatible target",
            resource: `workspace:${ownerID}`,
          })
      }
      const current = yield* db
        .select({
          projectID: SessionTable.project_id,
          directory: SessionTable.directory,
          workspaceID: SessionTable.workspace_id,
        })
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(source)))
        .get()
        .pipe(Effect.orDie)
      if (!current && ownerID) {
        const first = payload[0]
        const info = record(first.data.info) ? first.data.info : undefined
        const project = info && typeof info.projectID === "string"
          ? yield* db.select({ id: ProjectTable.id }).from(ProjectTable).where(eq(ProjectTable.id, ProjectV2.ID.make(info.projectID))).get().pipe(Effect.orDie)
          : undefined
        if (
          first.seq !== 0 ||
          first.type !== EventV2.versionedType(SessionV1.Event.Created.type, 1) ||
          first.aggregateID !== source ||
          first.data.sessionID !== source ||
          info?.id !== source ||
          info.workspaceID !== ownerID ||
          ctx.payload.directory !== instance.directory ||
          info.directory !== instance.directory ||
          info.projectID !== instance.project.id ||
          !project
        )
          return yield* new ConflictError({
            message: "Owned Session creation replay does not match workspace, project, or routed directory authority",
            resource: `session:${source}`,
          })
      }
      if (current && ownerID && current.workspaceID !== ownerID)
        return yield* new ConflictError({
          message: "Session replay owner does not match the current workspace authority",
          resource: `session:${source}`,
        })
      if (
        current &&
        (ctx.payload.directory !== instance.directory ||
          current.directory !== instance.directory ||
          current.projectID !== instance.project.id)
      )
        return yield* new ConflictError({
          message: "Session replay projection does not match the routed project and directory authority",
          resource: `session:${source}`,
        })
      if (!current && payload[0].type !== EventV2.versionedType(SessionV1.Event.Created.type, 1))
        return yield* new ConflictError({
          message: "Session replay requires an existing projection or its canonical creation event",
          resource: `session:${source}`,
        })
      const placementConflict = payload.reduce<
        { projectID: string; directory: string; workspaceID?: string } | "conflict" | undefined
      >((placement, event) => {
        if (placement === "conflict") return placement
        if (event.type === EventV2.versionedType("session.next.moved", 1)) return "conflict"
        if (
          event.type !== EventV2.versionedType(SessionV1.Event.Created.type, 1) &&
          event.type !== EventV2.versionedType(SessionV1.Event.Updated.type, 1)
        )
          return placement
        const info = record(event.data.info) ? event.data.info : undefined
        if (
          !info ||
          info.id !== source ||
          typeof info.projectID !== "string" ||
          typeof info.directory !== "string"
        )
          return "conflict"
        const next = {
          projectID: info.projectID,
          directory: info.directory,
          ...(typeof info.workspaceID === "string" ? { workspaceID: info.workspaceID } : {}),
        }
        if (
          placement &&
          (placement.projectID !== next.projectID ||
            placement.directory !== next.directory ||
            placement.workspaceID !== next.workspaceID)
        )
          return "conflict"
        return placement ?? next
      }, current
        ? {
            projectID: current.projectID,
            directory: current.directory,
            ...(current.workspaceID ? { workspaceID: current.workspaceID } : {}),
          }
        : undefined)
      if (placementConflict === "conflict")
        return yield* new ConflictError({
          message: "Session placement replay requires a durable transfer operation receipt",
          resource: `session:${source}`,
        })
      log.info("sync replay requested", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
        directory: ctx.payload.directory,
      })
      yield* events.replayAll(payload, { ownerID, strictOwner: true })
      log.info("sync replay complete", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
      })
      return { sessionID: source }
    })

    const steal = Effect.fn("SyncHttpApi.steal")(function* (ctx: { payload: typeof SessionPayload.Type }) {
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})
      return yield* new ConflictError({
        message: "Session steal requires a durable transfer operation receipt and is disabled in this release",
        resource: `${workspaceID}:${ctx.payload.sessionID}`,
      })
    })

    const history = Effect.fn("SyncHttpApi.history")(function* (ctx: { payload: typeof HistoryPayload.Type }) {
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})
      const authority = yield* db
        .select({
          generation: EventSyncSequenceTable.generation,
          secret: EventSyncSequenceTable.cursor_secret,
          seq: EventSyncSequenceTable.seq,
          complete: EventSyncSequenceTable.backfill_complete,
        })
        .from(EventSyncSequenceTable)
        .where(eq(EventSyncSequenceTable.id, 1))
        .get()
        .pipe(Effect.orDie)
      if (!authority)
        return yield* new ServiceUnavailableError({
          service: "sync.history",
          message: "Sync cursor authority is unavailable",
        })
      if (!authority.complete)
        return yield* new ServiceUnavailableError({
          service: "event_sync_backfill_required",
          message: "Event sync index backfill is incomplete; run bounded maintenance before reading history",
        })
      const versioned = "version" in ctx.payload
      const known = versioned ? ctx.payload.known ?? {} : ctx.payload
      if (Object.keys(known).length > SyncHistoryLimits.legacyKnownAggregates)
        return yield* new HttpApiError.BadRequest({})
      const after = historyCursor(
        workspaceID,
        authority.generation,
        authority.secret,
        authority.seq,
        versioned && typeof ctx.payload.cursor === "string" ? ctx.payload.cursor : undefined,
      )
      if (after === undefined)
        return yield* new ConflictError({
          message: "Sync history cursor is invalid, stale, or belongs to another workspace",
          resource: `sync-cursor-reset:${workspaceID}`,
        })
      const knownJson = JSON.stringify(known)
      const resync = yield* db
        .select({
          snapshotID: EventSnapshotTable.snapshot_id,
          aggregateID: EventSnapshotTable.aggregate_id,
          throughSeq: EventSnapshotTable.through_seq,
          syncSeq: EventSnapshotTable.sync_seq,
          codec: EventSnapshotTable.codec,
          schemaVersion: EventSnapshotTable.schema_version,
          snapshotHash: EventSnapshotTable.snapshot_hash,
          body: EventSnapshotTable.body,
          ownerID: EventSnapshotTable.owner_id,
          createdAt: EventSnapshotTable.created_at,
        })
        .from(EventSnapshotTable)
        .innerJoin(EventSequenceTable, eq(EventSequenceTable.snapshot_id, EventSnapshotTable.snapshot_id))
        .innerJoin(SessionTable, eq(SessionTable.id, EventSnapshotTable.aggregate_id))
        .where(
          and(
            eq(SessionTable.workspace_id, workspaceID),
            gt(EventSnapshotTable.sync_seq, after),
            !versioned
              ? sql`COALESCE((
                  SELECT CAST(value AS INTEGER)
                  FROM json_each(${knownJson})
                  WHERE key = ${EventSnapshotTable.aggregate_id}
                ), -1) < ${EventSnapshotTable.through_seq}`
              : undefined,
          ),
        )
        .orderBy(asc(EventSnapshotTable.sync_seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const candidates = yield* db
        .all<{ kind: "event"; id: string; syncSeq: number; bytes: number }>(sql`
            SELECT
              'event' AS kind,
              ${EventTable.id} AS id,
              ${EventSyncIndexTable.sync_seq} AS syncSeq,
              length(CAST(COALESCE(${FilePartArtifactBindingTable.canonical_data}, ${EventArtifactTable.canonical_data}, ${EventTable.data}) AS BLOB)) AS bytes
            FROM ${EventSyncIndexTable}
            INNER JOIN ${EventTable}
              ON ${EventTable.id} = ${EventSyncIndexTable.event_id}
            INNER JOIN ${EventSequenceTable}
              ON ${EventSequenceTable.aggregate_id} = ${EventTable.aggregate_id}
            INNER JOIN ${SessionTable}
              ON ${SessionTable.id} = ${EventTable.aggregate_id}
            LEFT JOIN ${EventArtifactTable}
              ON ${EventArtifactTable.event_id} = ${EventTable.id}
            LEFT JOIN ${FilePartArtifactBindingTable}
              ON ${FilePartArtifactBindingTable.event_id} = ${EventTable.id}
            WHERE ${EventSyncIndexTable.sync_seq} > ${after}
              AND ${EventSyncIndexTable.sync_seq} <= ${authority.seq}
              ${resync ? sql`AND ${EventSyncIndexTable.sync_seq} < ${resync.syncSeq}` : sql``}
              AND ${SessionTable.workspace_id} = ${workspaceID}
              AND ${EventTable.seq} > COALESCE(${EventSequenceTable.retention_floor_seq}, -1)
              AND ${EventTable.seq} > COALESCE((
                SELECT CAST(value AS INTEGER)
                FROM json_each(${knownJson})
                WHERE key = ${EventTable.aggregate_id}
              ), -1)
          ORDER BY ${EventSyncIndexTable.sync_seq} ASC
          LIMIT ${SyncHistoryLimits.events + 1}
        `)
        .pipe(Effect.orDie)
      const page = candidates.reduce<{
        rows: typeof candidates
        bytes: number
        oversized: string | undefined
        closed: boolean
      }>(
        (result, row) => {
          if (result.closed) return result
          if (row.bytes > SyncHistoryLimits.dataBytes)
            return {
              ...result,
              oversized: result.rows.length === 0 ? row.id : undefined,
              closed: true,
            }
          if (result.bytes > 0 && result.bytes + row.bytes > SyncHistoryLimits.dataBytes) return { ...result, closed: true }
          return {
            rows: [...result.rows, row],
            bytes: result.bytes + row.bytes,
            oversized: undefined,
            closed: false,
          }
        },
        { rows: [], bytes: 0, oversized: undefined, closed: false },
      )
      if (page.oversized)
        return yield* new ServiceUnavailableError({
          service: "sync.history",
          message: `Legacy sync event ${page.oversized} exceeds the bounded history page and requires artifact migration`,
        })
      if (page.rows.length === 0 && resync)
        return {
          version: 1 as const,
          items: [{
            kind: "resync_required" as const,
            snapshot: {
              snapshotID: resync.snapshotID,
              aggregateID: resync.aggregateID,
              throughSeq: resync.throughSeq,
              syncSeq: resync.syncSeq,
              codec: resync.codec,
              schemaVersion: resync.schemaVersion,
              snapshotHash: resync.snapshotHash,
              body: resync.body,
              ...(resync.ownerID ? { ownerID: resync.ownerID } : {}),
              createdAt: resync.createdAt,
            },
          }],
          nextCursor: encodeHistoryCursor(workspaceID, authority.generation, authority.secret, resync.syncSeq),
          complete: false,
        }
      if (page.rows.length === 0)
        return { version: 1 as const, items: [], nextCursor: encodeHistoryCursor(workspaceID, authority.generation, authority.secret, authority.seq), complete: true }
      const selectedRows = page.rows.slice(0, SyncHistoryLimits.events)
      const eventIDs = selectedRows.filter((row) => row.kind === "event").map((row) => EventV2.ID.make(row.id))
      const rows = yield* db
        .select({
          id: EventTable.id,
          aggregate_id: EventTable.aggregate_id,
          seq: EventTable.seq,
          type: EventTable.type,
          data: projectedEventData,
        })
        .from(EventTable)
        .leftJoin(EventArtifactTable, eq(EventArtifactTable.event_id, EventTable.id))
        .leftJoin(FilePartArtifactBindingTable, eq(FilePartArtifactBindingTable.event_id, EventTable.id))
        .where(inArray(EventTable.id, eventIDs))
        .all()
        .pipe(Effect.orDie)
      const eventByID = new Map(rows.map((row) => {
        const data = Option.getOrUndefined(decodeJson(row.data))
        return [row.id, { kind: "event" as const, ...row, data: record(data) ? data : {} }]
      }))
      const result = selectedRows.flatMap((row) => {
        const item = eventByID.get(EventV2.ID.make(row.id))
        return item ? [item] : []
      })
      if (result.length !== selectedRows.length)
        return yield* new ServiceUnavailableError({
          service: "sync.history",
          message: "Sync history changed while hydrating the selected page",
        })
      const bounded = result.reduce<{ items: typeof result; bytes: number; closed: boolean }>(
        (page, item) => {
          if (page.closed) return page
          const bytes = Buffer.byteLength(JSON.stringify(item)) + (page.items.length > 0 ? 1 : 0)
          if (page.bytes + bytes + 2 > SyncHistoryLimits.wireBytes) return { ...page, closed: true }
          return { items: [...page.items, item], bytes: page.bytes + bytes, closed: false }
        },
        { items: [], bytes: 0, closed: false },
      )
      if (bounded.items.length === 0 && result.length > 0)
        return yield* new ServiceUnavailableError({
          service: "sync.history",
          message: `Projected sync item ${page.rows[0]!.id} exceeds the bounded history page`,
        })
      const complete = !resync && candidates.length <= selectedRows.length && bounded.items.length === selectedRows.length
      const next = complete ? authority.seq : selectedRows[bounded.items.length - 1]?.syncSeq ?? after
      return {
        version: 1 as const,
        items: bounded.items,
        nextCursor: encodeHistoryCursor(workspaceID, authority.generation, authority.secret, next),
        complete,
      }
    })

    const artifacts = Effect.fn("SyncHttpApi.artifacts")(function* (ctx: {
      payload: typeof ArtifactMaintenancePayload.Type
    }) {
      if (ctx.payload.limit !== undefined && ctx.payload.limit > EventV2.LEGACY_ARTIFACT_BATCH_EVENTS)
        return yield* new HttpApiError.BadRequest({})
      const result = yield* events.canonicalizeLegacyArtifacts({
        ...(ctx.payload.cursor ? { afterID: ctx.payload.cursor } : {}),
        ...(ctx.payload.limit ? { limit: ctx.payload.limit } : {}),
      })
      return { processed: result.processed, ...(result.next ? { nextCursor: result.next } : {}) }
    })

    const eventIndex = Effect.fn("SyncHttpApi.eventIndex")(function* (ctx: {
      payload: typeof EventIndexMaintenancePayload.Type
    }) {
      if (ctx.payload.limit !== undefined && (ctx.payload.limit < 1 || ctx.payload.limit > 1000))
        return yield* new HttpApiError.BadRequest({})
      if (!events.backfillSyncIndex) return yield* new ServiceUnavailableError({
        service: "event_sync_backfill_required",
        message: "Event sync-index maintenance is unavailable in this runtime",
      })
      return yield* events.backfillSyncIndex({ ...(ctx.payload.limit ? { limit: ctx.payload.limit } : {}) })
    })

    const fileArtifacts = Effect.fn("SyncHttpApi.fileArtifacts")(function* (ctx: {
      payload: typeof ArtifactMaintenancePayload.Type
    }) {
      if (ctx.payload.limit !== undefined && ctx.payload.limit !== EventV2.LEGACY_ARTIFACT_BATCH_EVENTS)
        return yield* new HttpApiError.BadRequest({})
      const result = yield* FilePartArtifact.canonicalizeLegacy(db, {
        ...(ctx.payload.cursor ? { afterID: ctx.payload.cursor } : {}),
        ...(ctx.payload.limit ? { limit: ctx.payload.limit } : {}),
      })
      return { processed: result.processed, ...(result.next ? { nextCursor: result.next } : {}) }
    })

    const fileArtifactMetadata = Effect.fn("SyncHttpApi.fileArtifactMetadata")(function* (ctx: {
      payload: typeof FileArtifactMetadataPayload.Type
    }) {
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})
      const scoped = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(and(eq(SessionTable.id, SessionID.make(ctx.payload.aggregateID)), eq(SessionTable.workspace_id, workspaceID)))
        .get()
        .pipe(Effect.orDie)
      if (!scoped) return yield* new HttpApiError.NotFound()
      return yield* FilePartArtifact.metadata(db, ctx.payload).pipe(
        Effect.catchDefect((defect) =>
          Schema.is(FilePartArtifact.IntegrityError)(defect)
            ? Effect.fail(new HttpApiError.NotFound())
            : Effect.die(defect),
        ),
      )
    })

    const fileArtifactChunk = Effect.fn("SyncHttpApi.fileArtifactChunk")(function* (ctx: {
      payload: typeof FileArtifactChunkPayload.Type
    }) {
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID) return yield* new HttpApiError.BadRequest({})
      const scoped = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.workspace_id, workspaceID),
            eq(SessionTable.id, SessionID.make(ctx.payload.aggregateID)),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!scoped) return yield* new HttpApiError.NotFound()
      const metadata = yield* FilePartArtifact.metadata(db, ctx.payload).pipe(
        Effect.catchDefect((defect) =>
          Schema.is(FilePartArtifact.IntegrityError)(defect)
            ? Effect.fail(new HttpApiError.NotFound())
            : Effect.die(defect),
        ),
      )
      if (metadata.chunkHashes[ctx.payload.index] !== ctx.payload.hash)
        return yield* new HttpApiError.NotFound()
      const data = yield* FilePartArtifact.chunk(db, {
        artifactID: ctx.payload.artifactID,
        index: ctx.payload.index,
        expectedHash: ctx.payload.hash,
      }).pipe(
        Effect.catchDefect((defect) =>
          Schema.is(FilePartArtifact.IntegrityError)(defect)
            ? Effect.fail(new HttpApiError.NotFound())
            : Effect.die(defect),
        ),
      )
      return {
        artifactID: ctx.payload.artifactID,
        index: ctx.payload.index,
        hash: ctx.payload.hash,
        data: data.toString("base64"),
      }
    })

    const snapshotRows = Effect.fn("SyncHttpApi.snapshotRows")(function* (ctx: {
      payload: typeof SnapshotRowsPayload.Type
    }) {
      if (ctx.payload.limit !== undefined && (ctx.payload.limit < 1 || ctx.payload.limit > EventV2.SNAPSHOT_TRANSFER_ROWS))
        return yield* new HttpApiError.BadRequest({})
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID || !events.snapshotRows) return yield* new ServiceUnavailableError({ service: "sync.snapshot", message: "Snapshot row transfer is unavailable" })
      const scoped = yield* db
        .select({ id: EventSnapshotTable.snapshot_id })
        .from(EventSnapshotTable)
        .innerJoin(EventSequenceTable, eq(EventSequenceTable.snapshot_id, EventSnapshotTable.snapshot_id))
        .innerJoin(SessionTable, eq(SessionTable.id, EventSnapshotTable.aggregate_id))
        .where(and(
          eq(SessionTable.workspace_id, workspaceID),
          eq(EventSnapshotTable.aggregate_id, ctx.payload.aggregateID),
          eq(EventSnapshotTable.snapshot_id, ctx.payload.snapshotID),
          eq(EventSnapshotTable.snapshot_hash, ctx.payload.snapshotHash),
        ))
        .get()
        .pipe(Effect.orDie)
      if (!scoped) return yield* new HttpApiError.NotFound()
      const rows = yield* events.snapshotRows({
        snapshotID: ctx.payload.snapshotID,
        ...(ctx.payload.after !== undefined ? { after: ctx.payload.after } : {}),
        ...(ctx.payload.limit !== undefined ? { limit: ctx.payload.limit } : {}),
      })
      return { rows, complete: rows.length < (ctx.payload.limit ?? EventV2.SNAPSHOT_TRANSFER_ROWS) }
    })

    const snapshotChunks = Effect.fn("SyncHttpApi.snapshotChunks")(function* (ctx: {
      payload: typeof SnapshotChunksPayload.Type
    }) {
      const max = 8
      if (ctx.payload.limit !== undefined && (ctx.payload.limit < 1 || ctx.payload.limit > max))
        return yield* new HttpApiError.BadRequest({})
      const workspaceID = yield* InstanceState.workspaceID
      if (!workspaceID || !events.snapshotChunks) return yield* new ServiceUnavailableError({ service: "sync.snapshot", message: "Snapshot chunk transfer is unavailable" })
      const scoped = yield* db
        .select({ id: EventSnapshotRowTable.row_hash })
        .from(EventSnapshotRowTable)
        .innerJoin(EventSnapshotTable, eq(EventSnapshotTable.snapshot_id, EventSnapshotRowTable.snapshot_id))
        .innerJoin(EventSequenceTable, eq(EventSequenceTable.snapshot_id, EventSnapshotTable.snapshot_id))
        .innerJoin(SessionTable, eq(SessionTable.id, EventSnapshotTable.aggregate_id))
        .where(and(
          eq(SessionTable.workspace_id, workspaceID),
          eq(EventSnapshotTable.aggregate_id, ctx.payload.aggregateID),
          eq(EventSnapshotTable.snapshot_id, ctx.payload.snapshotID),
          eq(EventSnapshotTable.snapshot_hash, ctx.payload.snapshotHash),
          eq(EventSnapshotRowTable.row_hash, ctx.payload.rowHash),
        ))
        .get()
        .pipe(Effect.orDie)
      if (!scoped) return yield* new HttpApiError.NotFound()
      const chunks = yield* events.snapshotChunks({
        rowHash: ctx.payload.rowHash,
        ...(ctx.payload.after !== undefined ? { after: ctx.payload.after } : {}),
        limit: ctx.payload.limit ?? max,
      })
      return {
        chunks: chunks.map((chunk) => ({ ...chunk, data: chunk.data.toString("base64") })),
        complete: chunks.length < (ctx.payload.limit ?? max),
      }
    })

    const maintenanceFailure = (
      aggregateID: string,
      defect: unknown,
    ): Effect.Effect<never, ConflictError | ServiceUnavailableError> => {
      if (Schema.is(EventV2.MaintenanceRequiredError)(defect))
        return Effect.fail(new ServiceUnavailableError({ service: defect.reason, message: defect.message }))
      if (Schema.is(EventV2.InvalidSyncEventError)(defect))
        return Effect.fail(new ConflictError({ resource: `session:${aggregateID}`, message: defect.message }))
      return Effect.die(defect)
    }
    const maintenanceSession = Effect.fn("SyncHttpApi.maintenanceSession")(function* (aggregateID: SessionID) {
      const instance = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      const row = yield* db
        .select({
          id: SessionTable.id,
          projectID: SessionTable.project_id,
          directory: SessionTable.directory,
          workspaceID: SessionTable.workspace_id,
          seq: EventSequenceTable.seq,
          ownerID: EventSequenceTable.owner_id,
          floor: EventSequenceTable.retention_floor_seq,
        })
        .from(SessionTable)
        .innerJoin(EventSequenceTable, eq(EventSequenceTable.aggregate_id, SessionTable.id))
        .where(eq(SessionTable.id, aggregateID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new HttpApiError.NotFound()
      if (
        row.projectID !== instance.project.id ||
        row.directory !== instance.directory ||
        (row.workspaceID ?? undefined) !== workspaceID
      )
        return yield* new ConflictError({
          resource: `session:${aggregateID}`,
          message: "Checkpoint maintenance must match the routed project, directory, and workspace authority",
        })
      return row
    })
    const checkpointAttemptSession = Effect.fn("SyncHttpApi.checkpointAttemptSession")(function* (snapshotID: string) {
      const attempt = yield* db
        .select({ aggregateID: EventSnapshotAttemptTable.aggregate_id })
        .from(EventSnapshotAttemptTable)
        .where(eq(EventSnapshotAttemptTable.snapshot_id, snapshotID))
        .get()
        .pipe(Effect.orDie)
      if (!attempt) return yield* new HttpApiError.NotFound()
      return yield* maintenanceSession(SessionID.make(attempt.aggregateID))
    })
    const checkpointPrepare = Effect.fn("SyncHttpApi.checkpointPrepare")(function* (ctx: {
      payload: typeof CheckpointPreparePayload.Type
    }) {
      if (!events.prepareCheckpoint) return yield* new ServiceUnavailableError({ service: "sync.checkpoint", message: "Checkpoint preparation is unavailable" })
      const row = yield* maintenanceSession(ctx.payload.aggregateID)
      return yield* events.prepareCheckpoint({
        aggregateID: row.id,
        throughSeq: EventV2.Cursor.make(row.seq),
        expectedLatest: EventV2.Cursor.make(row.seq),
        codec: "session-projection",
        schemaVersion: 1,
        ...(row.ownerID ? { ownerID: row.ownerID } : {}),
      }).pipe(Effect.catchDefect((defect) => maintenanceFailure(row.id, defect)))
    })
    const checkpointStage = Effect.fn("SyncHttpApi.checkpointStage")(function* (ctx: {
      payload: typeof CheckpointStagePayload.Type
    }) {
      if (!events.stageCheckpoint) return yield* new ServiceUnavailableError({ service: "sync.checkpoint", message: "Checkpoint staging is unavailable" })
      const row = yield* checkpointAttemptSession(ctx.payload.snapshotID)
      if (ctx.payload.limit !== undefined && (ctx.payload.limit < 1 || ctx.payload.limit > EventV2.SNAPSHOT_TRANSFER_ROWS))
        return yield* new HttpApiError.BadRequest({})
      return yield* events.stageCheckpoint({
        snapshotID: ctx.payload.snapshotID,
        ...(ctx.payload.limit ? { limit: ctx.payload.limit } : {}),
      }).pipe(Effect.catchDefect((defect) => maintenanceFailure(row.id, defect)))
    })
    const checkpointFinalize = Effect.fn("SyncHttpApi.checkpointFinalize")(function* (ctx: {
      payload: typeof CheckpointFinalizePayload.Type
    }) {
      if (!events.finalizeCheckpoint) return yield* new ServiceUnavailableError({ service: "sync.checkpoint", message: "Checkpoint finalization is unavailable" })
      const row = yield* checkpointAttemptSession(ctx.payload.snapshotID)
      return yield* events.finalizeCheckpoint({ snapshotID: ctx.payload.snapshotID }).pipe(
        Effect.catchDefect((defect) => maintenanceFailure(row.id, defect)),
      )
    })
    const checkpointDiscard = Effect.fn("SyncHttpApi.checkpointDiscard")(function* (ctx: {
      payload: typeof CheckpointDiscardPayload.Type
    }) {
      if (!events.discardCheckpoint) return yield* new ServiceUnavailableError({ service: "sync.checkpoint", message: "Checkpoint discard is unavailable" })
      const row = yield* checkpointAttemptSession(ctx.payload.snapshotID)
      if (ctx.payload.limit !== undefined && (ctx.payload.limit < 1 || ctx.payload.limit > EventV2.SNAPSHOT_TRANSFER_ROWS))
        return yield* new HttpApiError.BadRequest({})
      return yield* events.discardCheckpoint({
        snapshotID: ctx.payload.snapshotID,
        ...(ctx.payload.limit ? { limit: ctx.payload.limit } : {}),
      }).pipe(Effect.catchDefect((defect) => maintenanceFailure(row.id, defect)))
    })
    const checkpointCompact = Effect.fn("SyncHttpApi.checkpointCompact")(function* (ctx: {
      payload: typeof CheckpointCompactPayload.Type
    }) {
      const row = yield* maintenanceSession(ctx.payload.aggregateID)
      if (row.floor === null) return yield* new ConflictError({ resource: `session:${row.id}`, message: "Compaction requires an active canonical checkpoint" })
      if (ctx.payload.limit !== undefined && (ctx.payload.limit < 1 || ctx.payload.limit > 100))
        return yield* new HttpApiError.BadRequest({})
      return yield* events.compact({
        aggregateID: row.id,
        throughSeq: EventV2.Cursor.make(row.floor),
        ...(ctx.payload.limit ? { limit: ctx.payload.limit } : {}),
      }).pipe(Effect.catchDefect((defect) => maintenanceFailure(row.id, defect)))
    })

    return handlers
      .handle("start", start)
      .handle("replay", replay)
      .handle("steal", steal)
      .handle("history", history)
      .handle("artifacts", artifacts)
      .handle("eventIndex", eventIndex)
      .handle("fileArtifacts", fileArtifacts)
      .handle("fileArtifactMetadata", fileArtifactMetadata)
      .handle("fileArtifactChunk", fileArtifactChunk)
      .handle("snapshotRows", snapshotRows)
      .handle("snapshotChunks", snapshotChunks)
      .handle("checkpointPrepare", checkpointPrepare)
      .handle("checkpointStage", checkpointStage)
      .handle("checkpointFinalize", checkpointFinalize)
      .handle("checkpointDiscard", checkpointDiscard)
      .handle("checkpointCompact", checkpointCompact)
  }),
)
