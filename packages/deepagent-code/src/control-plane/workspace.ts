import { Context, Effect, FiberMap, Layer, Option, Schema, Stream } from "effect"
import { isDeepStrictEqual } from "node:util"
import { serviceUse } from "@deepagent-code/core/effect/service-use"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { Database } from "@deepagent-code/core/database/database"
import { asc } from "drizzle-orm"
import { and } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { Project } from "@/project/project"
import { GlobalBus } from "@/bus/global"
import { Auth } from "@/auth"
import { EventV2 } from "@deepagent-code/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventSequenceTable, WorkspaceSyncCursorTable } from "@deepagent-code/core/event/sql"
import { FSUtil } from "@deepagent-code/core/fs-util"
import * as Log from "@deepagent-code/core/util/log"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProjectV2 } from "@deepagent-code/core/project"
import { Slug } from "@deepagent-code/core/util/slug"
import { WorkspaceTable } from "@deepagent-code/core/control-plane/workspace.sql"
import { getAdapter, registeredAdapters } from "./adapters"
import { type WorkspaceInfo, WorkspaceInfo as WorkspaceInfoSchema } from "./types"
import { WorkspaceV2 } from "@deepagent-code/core/workspace"
import { Session } from "@/session/session"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { errorData } from "@/util/error"
import { waitEvent } from "./util"
import { WorkspaceRef } from "@/effect/instance-ref"
import { Vcs } from "@/project/vcs"
import { WorkspaceAdapterRuntime } from "./workspace-adapter-runtime"
import { SessionRecoveryTransferGuard } from "@/session/recovery-transfer-guard"
import { Hash } from "@deepagent-code/core/util/hash"
import { FilePartArtifact } from "@deepagent-code/core/file-part-artifact"

export const Info = Schema.Struct({
  ...WorkspaceInfoSchema.fields,
  timeUsed: Schema.Number,
}).annotate({ identifier: "Workspace" })
export type Info = WorkspaceInfo & { timeUsed: number }

export const ConnectionStatus = Schema.Struct({
  workspaceID: WorkspaceV2.ID,
  status: Schema.Literals(["connected", "connecting", "disconnected", "error"]),
})
export type ConnectionStatus = Schema.Schema.Type<typeof ConnectionStatus>

export const Event = {
  Ready: EventV2.define({
    type: "workspace.ready",
    schema: {
      name: Schema.String,
    },
  }),
  Failed: EventV2.define({
    type: "workspace.failed",
    schema: {
      message: Schema.String,
    },
  }),
  Status: EventV2.define({ type: "workspace.status", schema: ConnectionStatus.fields }),
}

function fromRow(row: typeof WorkspaceTable.$inferSelect): Info {
  return {
    id: row.id,
    type: row.type,
    branch: row.branch,
    name: row.name,
    directory: row.directory,
    extra: row.extra,
    projectID: row.project_id,
    timeUsed: row.time_used,
  }
}

const log = Log.create({ service: "workspace-sync" })
const decodeHttpError = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export const CreateInput = Schema.Struct({
  id: Schema.optional(WorkspaceV2.ID),
  type: Info.fields.type,
  branch: Info.fields.branch,
  projectID: ProjectV2.ID,
  extra: Schema.optional(Info.fields.extra),
})
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const SessionWarpInput = Schema.Struct({
  workspaceID: Schema.NullOr(WorkspaceV2.ID),
  sessionID: SessionID,
  copyChanges: Schema.optional(Schema.Boolean),
})
export type SessionWarpInput = Schema.Schema.Type<typeof SessionWarpInput>

export class SyncHttpError extends Schema.TaggedErrorClass<SyncHttpError>()("WorkspaceSyncHttpError", {
  message: Schema.String,
  status: Schema.Number,
  body: Schema.optional(Schema.String),
}) {}

export class WorkspaceNotFoundError extends Schema.TaggedErrorClass<WorkspaceNotFoundError>()(
  "WorkspaceNotFoundError",
  {
    message: Schema.String,
    workspaceID: WorkspaceV2.ID,
  },
) {}

export class SessionEventsNotFoundError extends Schema.TaggedErrorClass<SessionEventsNotFoundError>()(
  "WorkspaceSessionEventsNotFoundError",
  {
    message: Schema.String,
    sessionID: SessionID,
  },
) {}

export class SessionWarpHttpError extends Schema.TaggedErrorClass<SessionWarpHttpError>()(
  "WorkspaceSessionWarpHttpError",
  {
    message: Schema.String,
    workspaceID: WorkspaceV2.ID,
    sessionID: SessionID,
    status: Schema.Number,
    body: Schema.String,
  },
) {}

export class SessionWarpRecoveryProjectionError extends Schema.TaggedErrorClass<SessionWarpRecoveryProjectionError>()(
  "WorkspaceSessionWarpRecoveryProjectionError",
  {
    message: Schema.String,
    sessionID: SessionID,
    recoveryAuthorityID: Schema.String,
  },
) {}

export class SessionWarpHistoryLimitError extends Schema.TaggedErrorClass<SessionWarpHistoryLimitError>()(
  "WorkspaceSessionWarpHistoryLimitError",
  {
    message: Schema.String,
    sessionID: SessionID,
    eventID: EventV2.ID,
    bytes: Schema.Number,
  },
) {}

export class SessionWarpTransferUnsupportedError extends Schema.TaggedErrorClass<SessionWarpTransferUnsupportedError>()(
  "WorkspaceSessionWarpTransferUnsupportedError",
  {
    message: Schema.String,
    sessionID: SessionID,
    reason: Schema.Literals(["placement_change", "copy_changes"]),
  },
) {}

export class SyncTimeoutError extends Schema.TaggedErrorClass<SyncTimeoutError>()("WorkspaceSyncTimeoutError", {
  message: Schema.String,
  state: Schema.Record(Schema.String, Schema.Number),
}) {}

export class SyncAbortedError extends Schema.TaggedErrorClass<SyncAbortedError>()("WorkspaceSyncAbortedError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

type CreateError = Auth.AuthError
type SessionWarpError =
  | WorkspaceNotFoundError
  | SessionEventsNotFoundError
  | SessionWarpHttpError
  | SessionWarpRecoveryProjectionError
  | SessionWarpHistoryLimitError
  | SessionWarpTransferUnsupportedError
  | Vcs.RawDiffError
  | Vcs.PatchApplyError
  | HttpClientError.HttpClientError
type WaitForSyncError = SyncTimeoutError | SyncAbortedError
type SyncLoopError = SyncHttpError | HttpClientError.HttpClientError

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, CreateError>
  readonly sessionWarp: (input: SessionWarpInput) => Effect.Effect<void, SessionWarpError>
  readonly list: (project: Project.Info) => Effect.Effect<Info[]>
  readonly syncList: (project: Project.Info) => Effect.Effect<void>
  readonly get: (id: WorkspaceV2.ID) => Effect.Effect<Info | undefined>
  readonly remove: (id: WorkspaceV2.ID) => Effect.Effect<Info | undefined>
  readonly status: () => Effect.Effect<ConnectionStatus[]>
  readonly isSyncing: (workspaceID: WorkspaceV2.ID) => Effect.Effect<boolean>
  readonly waitForSync: (
    workspaceID: WorkspaceV2.ID,
    state: Record<string, number>,
    signal?: AbortSignal,
    timeout?: number,
  ) => Effect.Effect<void, WaitForSyncError>
  readonly startWorkspaceSyncing: (projectID: ProjectV2.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Workspace") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const session = yield* Session.Service
    const http = yield* HttpClient.HttpClient
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service
    const fs = yield* FSUtil.Service
    const { db } = yield* Database.Service
    const connections = new Map<WorkspaceV2.ID, ConnectionStatus>()
    const syncFibers = yield* FiberMap.make<WorkspaceV2.ID, void, SyncLoopError>()

    const setStatus = (id: WorkspaceV2.ID, status: ConnectionStatus["status"]) => {
      const prev = connections.get(id)
      if (prev?.status === status) return
      const next = { workspaceID: id, status }
      connections.set(id, next)

      GlobalBus.emit("event", {
        directory: "global",
        workspace: id,
        payload: {
          type: Event.Status.type,
          properties: next,
        },
      })
    }

    const connectSSE = Effect.fn("Workspace.connectSSE")(function* (
      url: URL | string,
      headers: HeadersInit | undefined,
    ) {
      const response = yield* http.execute(
        HttpClientRequest.get(route(url, "/global/event"), {
          headers: new Headers(headers),
          accept: "text/event-stream",
        }),
      )
      if (response.status < 200 || response.status >= 300) {
        return yield* new SyncHttpError({
          message: `Workspace sync HTTP failure: ${response.status}`,
          status: response.status,
        })
      }
      return response.stream
    })

    const parseSSE = Effect.fn("Workspace.parseSSE")(function* (
      stream: Stream.Stream<Uint8Array, unknown>,
      onEvent: (event: unknown) => Effect.Effect<void>,
    ) {
      yield* stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapAccum(
          () => ({ data: [] as string[], id: undefined as string | undefined, retry: 1000 }),
          (state, line) => {
            if (line === "") {
              if (!state.data.length) return [state, []]
              return [{ ...state, data: [] }, [{ data: state.data.join("\n"), id: state.id, retry: state.retry }]]
            }

            const index = line.indexOf(":")
            const field = index === -1 ? line : line.slice(0, index)
            const value = index === -1 ? "" : line.slice(index + (line[index + 1] === " " ? 2 : 1))

            if (field === "data") return [{ ...state, data: [...state.data, value] }, []]
            if (field === "id") return [{ ...state, id: value }, []]
            if (field === "retry") {
              const retry = Number.parseInt(value, 10)
              return [Number.isNaN(retry) ? state : { ...state, retry }, []]
            }
            return [state, []]
          },
          {
            onHalt: (state) =>
              state.data.length ? [{ data: state.data.join("\n"), id: state.id, retry: state.retry }] : [],
          },
        ),
        Stream.map((event) => {
          try {
            return JSON.parse(event.data) as unknown
          } catch {
            return {
              type: "sse.message",
              properties: {
                data: event.data,
                id: event.id || undefined,
                retry: event.retry,
              },
            }
          }
        }),
        Stream.runForEach(onEvent),
      )
    })

    const syncHistory = Effect.fn("Workspace.syncHistory")(function* (
      space: Info,
      url: URL | string,
      headers: HeadersInit | undefined,
    ) {
      const normalized = new URL(url)
      normalized.hash = ""
      normalized.search = ""
      normalized.pathname = normalized.pathname.replace(/\/$/, "")
      const remoteFingerprint = Hash.sha256(`${normalized.toString()}:workspace:${space.id}`)
      const receipt = yield* db
        .select({ cursor: WorkspaceSyncCursorTable.cursor })
        .from(WorkspaceSyncCursorTable)
        .where(
          and(
            eq(WorkspaceSyncCursorTable.workspace_id, space.id),
            eq(WorkspaceSyncCursorTable.remote_fingerprint, remoteFingerprint),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      log.info("syncing workspace history", {
        workspaceID: space.id,
        resume: Boolean(receipt),
      })

      let total = 0
      let cursor: string | undefined = receipt?.cursor
      let reset = Boolean(cursor)
      const requestJson = Effect.fn("Workspace.syncArtifactRequest")(function* (
        path: string,
        body: unknown,
        maxBytes: number,
      ) {
        const response = yield* http.execute(
          HttpClientRequest.post(route(url, path), {
            headers: new Headers(headers),
            body: HttpBody.jsonUnsafe(body),
          }),
        )
        const declaredBytes = Number(response.headers["content-length"])
        if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes)
          return yield* new SyncHttpError({
            message: `Workspace artifact response exceeds ${maxBytes} bytes`,
            status: 502,
          })
        const chunks: Uint8Array[] = []
        let bytes = 0
        yield* Stream.runForEach(response.stream, (chunk) => {
          bytes += chunk.byteLength
          if (bytes > maxBytes)
            return Effect.fail(
              new SyncHttpError({ message: `Workspace artifact response exceeds ${maxBytes} bytes`, status: 502 }),
            )
          chunks.push(chunk)
          return Effect.void
        })
        const text = Buffer.concat(chunks, bytes).toString()
        if (response.status < 200 || response.status >= 300) {
          return yield* new SyncHttpError({
            message: `Workspace artifact HTTP failure: ${response.status} ${text}`,
            status: response.status,
            body: text,
          })
        }
        const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text))
        if (parsed === undefined)
          return yield* new SyncHttpError({ message: "Workspace artifact response is not valid JSON", status: 502 })
        return parsed
      })
      const importArtifactMetadata = Effect.fn("Workspace.syncFilePartArtifactMetadata")(function* (
        metadata: FilePartArtifact.Metadata,
        verified = false,
      ) {
        const descriptor = metadata.descriptor
        const remote = verified
          ? metadata
          : Schema.decodeUnknownSync(FilePartArtifact.Metadata)(
              yield* requestJson(
                "/sync/artifact/file/metadata",
                {
                  eventID: metadata.eventID,
                  aggregateID: metadata.aggregateID,
                  seq: metadata.seq,
                  artifactID: descriptor.id,
                },
                64 * 1024,
              ),
            )
        if (JSON.stringify(remote) !== JSON.stringify(metadata))
          return yield* new SyncHttpError({ message: "Workspace artifact metadata diverged from history", status: 409 })
        if (!(yield* FilePartArtifact.has(descriptor).pipe(Effect.provideService(Database.Service, { db }))))
          for (const [index, hash] of remote.chunkHashes.entries()) {
            const chunk = yield* requestJson(
              "/sync/artifact/file/chunk",
              {
                eventID: remote.eventID,
                aggregateID: remote.aggregateID,
                seq: remote.seq,
                artifactID: descriptor.id,
                index,
                hash,
              },
              512 * 1024,
            )
            if (!chunk || typeof chunk !== "object" || Array.isArray(chunk))
              return yield* new SyncHttpError({ message: `Workspace artifact chunk ${index} is invalid`, status: 409 })
            const value = chunk as Record<string, unknown>
            if (
              value.artifactID !== descriptor.id ||
              value.index !== index ||
              value.hash !== hash ||
              typeof value.data !== "string" ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
            )
              return yield* new SyncHttpError({ message: `Workspace artifact chunk ${index} is invalid`, status: 409 })
            yield* FilePartArtifact.importChunk({
              metadata: remote,
              index,
              hash,
              data: Buffer.from(value.data, "base64"),
            }).pipe(Effect.provideService(Database.Service, { db }))
          }
        yield* FilePartArtifact.stageImport(remote).pipe(Effect.provideService(Database.Service, { db }))
      })
      const importArtifact = Effect.fn("Workspace.syncFilePartArtifact")(function* (item: HistoryEvent) {
        const descriptor = FilePartArtifact.descriptor(item.data)
        if (!descriptor) return
        const metadata = Schema.decodeUnknownSync(FilePartArtifact.Metadata)(
          yield* requestJson(
            "/sync/artifact/file/metadata",
            { eventID: item.id, aggregateID: item.aggregate_id, seq: item.seq, artifactID: descriptor.id },
            64 * 1024,
          ),
        )
        if (
          metadata.eventID !== item.id ||
          metadata.aggregateID !== item.aggregate_id ||
          metadata.seq !== item.seq ||
          !FilePartArtifact.matchesDataHash(metadata.canonicalDataHash, metadata.canonicalData) ||
          !isDeepStrictEqual(metadata.canonicalData, item.data) ||
          JSON.stringify(metadata.descriptor) !== JSON.stringify(descriptor)
        )
          return yield* new SyncHttpError({ message: "Workspace artifact metadata diverged from history", status: 409 })
        yield* importArtifactMetadata(metadata, true)
      })
      const importSnapshot = Effect.fn("Workspace.syncSnapshot")(function* (item: HistoryResync) {
        if (!events.snapshotRows || !events.snapshotChunks || !events.stageSnapshotRows || !events.stageSnapshotChunks)
          return yield* new SyncHttpError({ message: "Workspace snapshot transfer is unavailable", status: 503 })
        const stageRows = events.stageSnapshotRows
        const stageChunks = events.stageSnapshotChunks
        let after = -1
        while (true) {
          const page = Schema.decodeUnknownSync(SnapshotRowsPage)(
            yield* requestJson(
              "/sync/snapshot/rows",
              {
                aggregateID: item.snapshot.aggregateID,
                snapshotID: item.snapshot.snapshotID,
                snapshotHash: item.snapshot.snapshotHash,
                after,
                limit: EventV2.SNAPSHOT_TRANSFER_ROWS,
              },
              256 * 1024,
            ),
          )
          yield* stageRows(item.snapshot, page.rows)
          yield* Effect.forEach(
            page.rows,
            (row) =>
              Effect.gen(function* () {
                let chunkAfter = -1
                const body: Buffer[] = []
                while (true) {
                  const chunks = Schema.decodeUnknownSync(SnapshotChunksPage)(
                    yield* requestJson(
                      "/sync/snapshot/chunks",
                      {
                        aggregateID: item.snapshot.aggregateID,
                        snapshotID: item.snapshot.snapshotID,
                        snapshotHash: item.snapshot.snapshotHash,
                        rowHash: row.rowHash,
                        after: chunkAfter,
                        limit: 8,
                      },
                      4 * 1024 * 1024,
                    ),
                  )
                  const decoded = chunks.chunks.map((chunk) => ({ ...chunk, data: Buffer.from(chunk.data, "base64") }))
                  yield* stageChunks(item.snapshot, row, decoded)
                  body.push(...decoded.map((chunk) => chunk.data))
                  if (chunks.complete) break
                  const next = chunks.chunks.at(-1)?.chunkIndex
                  if (next === undefined || next <= chunkAfter)
                    return yield* new SyncHttpError({ message: "Workspace snapshot chunk cursor did not advance", status: 409 })
                  chunkAfter = next
                }
                if (row.tableName !== "file_part_artifact_binding") return
                const value = Option.getOrUndefined(
                  Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.concat(body, row.rowBytes).toString()),
                )
                if (!value || typeof value !== "object" || Array.isArray(value) || !("metadata" in value))
                  return yield* new SyncHttpError({ message: "Workspace snapshot artifact row is invalid", status: 409 })
                yield* importArtifactMetadata(Schema.decodeUnknownSync(FilePartArtifact.Metadata)(value.metadata))
              }),
            { discard: true },
          )
          if (page.complete) break
          const next = page.rows.at(-1)?.rowIndex
          if (next === undefined || next <= after)
            return yield* new SyncHttpError({ message: "Workspace snapshot row cursor did not advance", status: 409 })
          after = next
        }
        yield* events.importSnapshot(item.snapshot)
      })
      while (true) {
        const expectedCursor = cursor
        const response = yield* http.execute(
          HttpClientRequest.post(route(url, "/sync/history"), {
            headers: new Headers(headers),
            body: HttpBody.jsonUnsafe({ version: 1, ...(cursor ? { cursor } : {}) }),
          }),
        )

        if (response.status === 409) {
          const body = yield* response.text
          const error = Option.getOrUndefined(decodeHttpError(body))
          const stale =
            error &&
            typeof error === "object" &&
            "resource" in error &&
            error.resource === `sync-cursor-reset:${space.id}`
          if (stale && reset && expectedCursor) {
            yield* db
              .delete(WorkspaceSyncCursorTable)
              .where(and(eq(WorkspaceSyncCursorTable.workspace_id, space.id), eq(WorkspaceSyncCursorTable.remote_fingerprint, remoteFingerprint), eq(WorkspaceSyncCursorTable.cursor, expectedCursor)))
              .run()
              .pipe(Effect.orDie)
            cursor = undefined
            reset = false
            continue
          }
          return yield* new SyncHttpError({
            message: `Workspace history HTTP failure: ${response.status} ${body}`,
            status: response.status,
            body,
          })
        }
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text
          return yield* new SyncHttpError({
            message: `Workspace history HTTP failure: ${response.status} ${body}`,
            status: response.status,
            body,
          })
        }

        const decoded = (yield* response.json) as HistoryEnvelope | HistoryEvent[]
        const history = Array.isArray(decoded) ? decoded : decoded.items
        const nextCursor = Array.isArray(decoded) ? cursor : decoded.nextCursor
        yield* Effect.forEach(
          history,
          (item) => {
            return Effect.gen(function* () {
              if (item.kind === "resync_required") {
                yield* importSnapshot(item)
                return
              }
              yield* importArtifact(item)
              yield* events
                .replay(
                  {
                    id: EventV2.ID.make(item.id),
                    aggregateID: item.aggregate_id,
                    seq: item.seq,
                    type: item.type,
                    data: item.data,
                  },
                  { publish: true, ownerID: space.id },
                )
                .pipe(Effect.provideService(WorkspaceRef, space.id))
            })
          },
          { discard: true },
        )
        if (!Array.isArray(decoded)) {
          const advanced = expectedCursor
            ? yield* db.update(WorkspaceSyncCursorTable).set({ cursor: decoded.nextCursor, updated_at: Date.now() }).where(and(eq(WorkspaceSyncCursorTable.workspace_id, space.id), eq(WorkspaceSyncCursorTable.remote_fingerprint, remoteFingerprint), eq(WorkspaceSyncCursorTable.cursor, expectedCursor))).returning({ cursor: WorkspaceSyncCursorTable.cursor }).get().pipe(Effect.orDie)
            : yield* db.insert(WorkspaceSyncCursorTable).values({ workspace_id: space.id, remote_fingerprint: remoteFingerprint, cursor: decoded.nextCursor, updated_at: Date.now() }).onConflictDoNothing().returning({ cursor: WorkspaceSyncCursorTable.cursor }).get().pipe(Effect.orDie)
          if (!advanced)
            return yield* new SyncHttpError({ message: "Workspace sync cursor changed concurrently", status: 409 })
        }
        cursor = nextCursor
        reset = false
        total += history.length
        if (history.length === 0) break
        if (!Array.isArray(decoded) && decoded.complete) break
      }

      log.info("workspace history synced", {
        workspaceID: space.id,
        events: total,
      })
    })

    const syncWorkspaceLoop = Effect.fn("Workspace.syncWorkspaceLoop")(function* (space: Info) {
      const target = yield* WorkspaceAdapterRuntime.target(space)

      if (target.type === "local") return

      let attempt = 0

      while (true) {
        log.info("connecting to global sync", { workspace: space.name })
        setStatus(space.id, "connecting")

        const stream = yield* connectSSE(target.url, target.headers).pipe(
          Effect.tap(() => syncHistory(space, target.url, target.headers)),
          Effect.catch((err) =>
            Effect.sync(() => {
              setStatus(space.id, "error")
              log.info("failed to connect to global sync", {
                workspace: space.name,
                err,
              })
              return null
            }),
          ),
        )

        if (stream) {
          attempt = 0

          log.info("global sync connected", { workspace: space.name })
          setStatus(space.id, "connected")

          yield* parseSSE(stream, (evt) =>
            Effect.gen(function* () {
              if (!evt || typeof evt !== "object" || !("payload" in evt)) return
              const payload = evt.payload as { type?: string; syncEvent?: EventV2.SerializedEvent }
              if (payload.type === "server.heartbeat") return

              if (payload.type === "sync" && payload.syncEvent) {
                const failed = yield* events.replay(payload.syncEvent, { publish: true, ownerID: space.id }).pipe(
                  Effect.as(false),
                  Effect.catchCause((error) =>
                    Effect.sync(() => {
                      log.info("failed to replay global event", {
                        workspaceID: space.id,
                        error,
                      })
                      return true
                    }),
                  ),
                )
                if (failed) return
              }

              try {
                const event = evt as { directory?: string; project?: string; payload: unknown }
                GlobalBus.emit("event", {
                  directory: event.directory,
                  project: event.project,
                  workspace: space.id,
                  payload: event.payload,
                })
              } catch (error) {
                log.info("failed to replay global event", {
                  workspaceID: space.id,
                  error,
                })
              }
            }),
          )

          log.info("disconnected from global sync: " + space.id)
          setStatus(space.id, "disconnected")
        }

        // Back off reconnect attempts up to 2 minutes while the workspace
        // stays unavailable.
        yield* Effect.sleep(`${Math.min(120_000, 1_000 * 2 ** attempt)} millis`)
        attempt += 1
      }
    })

    const startSync = Effect.fn("Workspace.startSync")(function* (space: Info) {
      if (!flags.experimentalWorkspaces) return

      const target = yield* WorkspaceAdapterRuntime.target(space).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            setStatus(space.id, "error")
            log.warn("workspace target failed", {
              workspaceID: space.id,
              error: errorData(error),
            })
            return null
          }),
        ),
      )
      if (!target) return

      if (target.type === "local") {
        setStatus(space.id, (yield* fs.existsSafe(target.directory)) ? "connected" : "error")
        return
      }

      const exists = yield* FiberMap.has(syncFibers, space.id)
      if (exists && connections.get(space.id)?.status !== "error") return

      setStatus(space.id, "disconnected")

      yield* FiberMap.run(
        syncFibers,
        space.id,
        // TODO: look into `tapError` to set the status but still
        // allow the fiber to fail and automatically get removed
        syncWorkspaceLoop(space).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              setStatus(space.id, "error")
              log.warn("workspace listener failed", {
                workspaceID: space.id,
                error,
              })
            }),
          ),
        ),
      )
    })

    const stopSync = Effect.fn("Workspace.stopSync")(function* (id: WorkspaceV2.ID) {
      yield* FiberMap.remove(syncFibers, id)
      connections.delete(id)
    })

    const create = Effect.fn("Workspace.create")(function* (input: CreateInput) {
      const id = WorkspaceV2.ID.ascending(input.id)
      const adapter = getAdapter(input.projectID, input.type)
      const config = yield* WorkspaceAdapterRuntime.configure(adapter, {
        ...input,
        id,
        name: Slug.create(),
        directory: null,
        extra: input.extra ?? null,
      })

      const info: Info = {
        id,
        type: config.type,
        branch: config.branch ?? null,
        name: config.name ?? null,
        directory: config.directory ?? null,
        extra: config.extra ?? null,
        projectID: input.projectID,
        timeUsed: Date.now(),
      }

      yield* db
        .insert(WorkspaceTable)
        .values({
          id: info.id,
          type: info.type,
          branch: info.branch,
          name: info.name,
          directory: info.directory,
          extra: info.extra,
          project_id: info.projectID,
          time_used: info.timeUsed,
        })
        .run()
        .pipe(Effect.orDie)

      const env = {
        DEEPAGENT_CODE_AUTH_CONTENT: JSON.stringify(yield* auth.all()),
        DEEPAGENT_CODE_WORKSPACE_ID: config.id,
        DEEPAGENT_CODE_EXPERIMENTAL_WORKSPACES: "true",
        OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
        OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES,
      }

      yield* WorkspaceAdapterRuntime.create(adapter, config, env)
      yield* Effect.all(
        [
          waitEvent({
            timeout: TIMEOUT,
            fn(event) {
              if (event.workspace === info.id && event.payload.type === Event.Status.type) {
                const { status } = event.payload.properties
                return status === "error" || status === "connected"
              }
              return false
            },
          }),
          startSync(info),
        ],
        { concurrency: 2, discard: true },
      )

      return info
    })

    const sessionWarp = Effect.fn("Workspace.sessionWarp")(function* (input: SessionWarpInput) {
      return yield* Effect.gen(function* () {
        log.info("session warp requested", {
          workspaceID: input.workspaceID,
          sessionID: input.sessionID,
        })

        const current = yield* db
          .select({ workspaceID: SessionTable.workspace_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)

        if (!current)
          return yield* new SessionEventsNotFoundError({
            message: `No session found for warp: ${input.sessionID}`,
            sessionID: input.sessionID,
          })
        if ((input.workspaceID ?? undefined) === (current.workspaceID ?? undefined) && !input.copyChanges) return
        if (input.workspaceID !== null && !(yield* get(input.workspaceID)))
          return yield* new WorkspaceNotFoundError({
            message: `Workspace not found: ${input.workspaceID}`,
            workspaceID: input.workspaceID,
          })
        const recoveryAuthorityID = yield* SessionRecoveryTransferGuard.authorityID(db, input.sessionID)
        if (recoveryAuthorityID)
          return yield* new SessionWarpRecoveryProjectionError({
            message:
              "Provider recovery projection cannot move between workspaces until canonical recovery snapshot import is available",
            sessionID: input.sessionID,
            recoveryAuthorityID,
          })
        if (input.copyChanges)
          return yield* new SessionWarpTransferUnsupportedError({
            message: "Copying workspace changes requires an idempotent patch transfer receipt",
            sessionID: input.sessionID,
            reason: "copy_changes",
          })
        return yield* new SessionWarpTransferUnsupportedError({
          message: "Session placement changes require durable transfer admission, source fencing, and target receipts",
          sessionID: input.sessionID,
          reason: "placement_change",
        })
      }).pipe(
        Effect.tapError((err) =>
          Effect.sync(() =>
            log.error("session warp failed", {
              workspaceID: input.workspaceID,
              sessionID: input.sessionID,
              error: errorData(err),
            }),
          ),
        ),
      )
    })

    const list = Effect.fn("Workspace.list")(function* (project: Project.Info) {
      return (yield* db
        .select()
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.project_id, project.id))
        .all()
        .pipe(Effect.orDie))
        .map(fromRow)
        .sort((a, b) => a.id.localeCompare(b.id))
    })

    const syncList = Effect.fn("Workspace.syncList")(function* (project: Project.Info) {
      const names = new Set((yield* list(project)).map((workspace) => workspace.name))
      const discovered = yield* Effect.forEach(
        registeredAdapters(project.id),
        ([type, adapter]) =>
          WorkspaceAdapterRuntime.list(adapter).pipe(
            Effect.catchCause((error) =>
              Effect.sync(() => {
                log.warn("workspace adapter list failed", { type, error })
                return []
              }),
            ),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items) => items.flat()))

      yield* Effect.forEach(
        discovered,
        (item) =>
          Effect.gen(function* () {
            if (names.has(item.name)) return
            names.add(item.name)

            const info: Info = {
              id: WorkspaceV2.ID.ascending(),
              type: item.type,
              branch: item.branch,
              name: item.name,
              directory: item.directory,
              extra: item.extra,
              projectID: item.projectID,
              timeUsed: Date.now(),
            }

            yield* db
              .insert(WorkspaceTable)
              .values({
                id: info.id,
                type: info.type,
                branch: info.branch,
                name: info.name,
                directory: info.directory,
                extra: info.extra,
                project_id: info.projectID,
                time_used: info.timeUsed,
              })
              .run()
              .pipe(Effect.orDie)

            yield* startSync(info)
          }),
        { concurrency: 1 },
      )
    })

    const get = Effect.fn("Workspace.get")(function* (id: WorkspaceV2.ID) {
      const row = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return
      return fromRow(row)
    })

    const remove = Effect.fn("Workspace.remove")(function* (id: WorkspaceV2.ID) {
      const sessions = yield* db
        .select({ id: SessionTable.id, parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.workspace_id, id))
        .all()
        .pipe(Effect.orDie)
      const sessionIDs = new Set(sessions.map((sessionInfo) => sessionInfo.id))
      yield* Effect.forEach(
        sessions.filter((sessionInfo) => !sessionInfo.parentID || !sessionIDs.has(sessionInfo.parentID)),
        (sessionInfo) =>
          session.remove(sessionInfo.id).pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.void)),
        { discard: true },
      )

      const row = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return

      yield* stopSync(id)

      const info = fromRow(row)
      yield* Effect.catchCause(
        Effect.gen(function* () {
          yield* WorkspaceAdapterRuntime.remove(info)
        }),
        () =>
          Effect.sync(() => {
            log.error("adapter not available when removing workspace", { type: row.type })
          }),
      )

      yield* db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, id)).run().pipe(Effect.orDie)
      return info
    })

    const status = Effect.fn("Workspace.status")(function* () {
      return [...connections.values()]
    })

    const isSyncing = Effect.fn("Workspace.isSyncing")(function* (workspaceID: WorkspaceV2.ID) {
      const exists = yield* FiberMap.has(syncFibers, workspaceID)
      return exists && connections.get(workspaceID)?.status !== "error"
    })

    const waitForSync = Effect.fn("Workspace.waitForSync")(function* (
      workspaceID: WorkspaceV2.ID,
      state: Record<string, number>,
      signal?: AbortSignal,
      timeout = TIMEOUT,
    ) {
      if (yield* synced(db, state)) return

      yield* Effect.catch(
        waitUntilSynced({ db, workspaceID, state, signal, timeout }),
        (): Effect.Effect<never, WaitForSyncError> =>
          signal?.aborted
            ? Effect.fail(
                new SyncAbortedError({
                  message: signal.reason instanceof Error ? signal.reason.message : "Request aborted",
                  cause: signal.reason,
                }),
              )
            : Effect.fail(
                new SyncTimeoutError({
                  message: `Timed out waiting for sync fence: ${JSON.stringify(state)}`,
                  state,
                }),
              ),
      )
    })

    const startWorkspaceSyncing = Effect.fn("Workspace.startWorkspaceSyncing")(function* (projectID: ProjectV2.ID) {
      const rows = yield* db
        .selectDistinct({ workspace: WorkspaceTable })
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.project_id, projectID))
        .all()
        .pipe(Effect.orDie)

      for (const { workspace } of rows) {
        yield* startSync(fromRow(workspace)).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              setStatus(workspace.id, "error")
              log.warn("workspace sync failed to start", {
                workspaceID: workspace.id,
                error,
              })
            }),
          ),
          Effect.forkDetach,
        )
      }
    })

    return Service.of({
      create,
      sessionWarp,
      list,
      syncList,
      get,
      remove,
      status,
      isSyncing,
      waitForSync,
      startWorkspaceSyncing,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

const TIMEOUT = 5000

type HistoryEvent = {
  kind: "event"
  id: string
  aggregate_id: string
  seq: number
  type: string
  data: Record<string, unknown>
}

type HistoryResync = {
  kind: "resync_required"
  snapshot: EventV2.SerializedSnapshot
}

type HistoryEnvelope = {
  version: 1
  items: (HistoryEvent | HistoryResync)[]
  nextCursor: string
  complete: boolean
}

const SnapshotRow = Schema.Struct({
  snapshotID: Schema.String,
  rowIndex: Schema.Number,
  tableName: Schema.String,
  rowKey: Schema.String,
  rowHash: Schema.String,
  rowBytes: Schema.Number,
  chunkCount: Schema.Number,
  chainHash: Schema.String,
})
const SnapshotRowsPage = Schema.Struct({ rows: Schema.Array(SnapshotRow), complete: Schema.Boolean })
const SnapshotChunksPage = Schema.Struct({
  chunks: Schema.Array(Schema.Struct({
    rowHash: Schema.String,
    chunkIndex: Schema.Number,
    data: Schema.String,
    chunkHash: Schema.String,
  })),
  complete: Schema.Boolean,
})

function waitUntilSynced(input: {
  db: Database.Interface["db"]
  workspaceID: WorkspaceV2.ID
  state: Record<string, number>
  signal?: AbortSignal
  timeout: number
}): Effect.Effect<void, unknown> {
  return Effect.suspend(() =>
    waitEvent({
      timeout: input.timeout,
      signal: input.signal,
      fn(event) {
        return event.workspace === input.workspaceID || event.payload.type === "sync"
      },
    }).pipe(
      Effect.andThen(synced(input.db, input.state)),
      Effect.flatMap((done): Effect.Effect<void, unknown> => (done ? Effect.void : waitUntilSynced(input))),
    ),
  )
}

function synced(db: Database.Interface["db"], state: Record<string, number>): Effect.Effect<boolean> {
  const ids = Object.keys(state)
  if (ids.length === 0) return Effect.succeed(true)

  return db
    .select({
      id: EventSequenceTable.aggregate_id,
      seq: EventSequenceTable.seq,
    })
    .from(EventSequenceTable)
    .where(inArray(EventSequenceTable.aggregate_id, ids))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => {
        const done = Object.fromEntries(rows.map((row) => [row.id, row.seq])) as Record<string, number>
        return ids.every((id) => (done[id] ?? -1) >= state[id])
      }),
    )
}

function route(url: string | URL, path: string) {
  const next = new URL(url)
  next.pathname = `${next.pathname.replace(/\/$/, "")}${path}`
  next.search = ""
  next.hash = ""
  return next
}

export * as Workspace from "./workspace"
