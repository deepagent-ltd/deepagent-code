import { Workspace } from "@/control-plane/workspace"
import * as InstanceState from "@/effect/instance-state"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventTable } from "@deepagent-code/core/event/sql"
import { SessionRecoveryTransferGuard } from "@/session/recovery-transfer-guard"
import { asc } from "drizzle-orm"
import { and } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { lte } from "drizzle-orm"
import { not } from "drizzle-orm"
import { or } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { Effect, Option, Schema, Scope } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { HistoryPayload, ReplayPayload, SessionPayload } from "../groups/sync"
import { encodeReplayRequestPrefix } from "@/sync/replay-protocol"
import * as Log from "@deepagent-code/core/util/log"
import { ServiceUnavailableError } from "../errors"
import { ConflictError } from "../errors"

const log = Log.create({ service: "server.sync" })
export const SyncHistoryLimits = {
  events: 100,
  bytes: 4 * 1024 * 1024,
} as const
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const projectedEventData = sql<string>`CASE
  WHEN ${EventTable.type} = ${EventV2.versionedType(SessionV1.Event.MessageUpdated.type, 1)}
    AND json_valid(${EventTable.data})
    AND json_type(${EventTable.data}, '$.info.summary.diffs') = 'array'
    AND length(${EventTable.data}) > ${SyncHistoryLimits.bytes}
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
END`
export const syncHandlers = HttpApiBuilder.group(InstanceHttpApi, "sync", (handlers) =>
  Effect.gen(function* () {
    const workspace = yield* Workspace.Service
    const session = yield* Session.Service
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
      const source = payload[0].aggregateID
      log.info("sync replay requested", {
        sessionID: source,
        events: payload.length,
        first: payload[0]?.seq,
        last: payload.at(-1)?.seq,
        directory: ctx.payload.directory,
      })
      const ownerID = yield* InstanceState.workspaceID
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

      const recoveryAuthorityID = yield* SessionRecoveryTransferGuard.authorityID(db, ctx.payload.sessionID)
      if (recoveryAuthorityID)
        return yield* new ConflictError({
          message:
            "Provider recovery projection cannot move between workspaces until canonical snapshot import is available",
          resource: recoveryAuthorityID,
        })

      yield* session.setWorkspace({ sessionID: ctx.payload.sessionID, workspaceID })

      log.info("sync session stolen", {
        sessionID: ctx.payload.sessionID,
        workspaceID,
      })

      return { sessionID: ctx.payload.sessionID }
    })

    const history = Effect.fn("SyncHttpApi.history")(function* (ctx: { payload: typeof HistoryPayload.Type }) {
      const exclude = Object.entries(ctx.payload)
      const where =
        exclude.length > 0
          ? not(or(...exclude.map(([id, seq]) => and(eq(EventTable.aggregate_id, id), lte(EventTable.seq, seq))))!)
          : undefined
      const candidates = yield* db
        .select({
          id: EventTable.id,
          bytes: sql<number>`length(CAST(${EventTable.data} AS BLOB))`,
        })
        .from(EventTable)
        .where(where)
        .orderBy(asc(EventTable.seq), asc(EventTable.aggregate_id))
        .limit(SyncHistoryLimits.events)
        .all()
        .pipe(Effect.orDie)
      const page = candidates.reduce<{
        ids: EventV2.ID[]
        bytes: number
        oversized: string | undefined
        closed: boolean
      }>(
        (result, row) => {
          if (result.closed) return result
          if (row.bytes > SyncHistoryLimits.bytes)
            return {
              ...result,
              oversized: result.ids.length === 0 ? row.id : undefined,
              closed: true,
            }
          if (result.bytes > 0 && result.bytes + row.bytes > SyncHistoryLimits.bytes) return { ...result, closed: true }
          return {
            ids: [...result.ids, row.id],
            bytes: result.bytes + row.bytes,
            oversized: undefined,
            closed: false,
          }
        },
        { ids: [], bytes: 0, oversized: undefined, closed: false },
      )
      if (page.oversized)
        return yield* new ServiceUnavailableError({
          service: "sync.history",
          message: `Legacy sync event ${page.oversized} exceeds the bounded history page and requires artifact migration`,
        })
      if (page.ids.length === 0) return []
      const rows = yield* db
        .select({
          id: EventTable.id,
          aggregate_id: EventTable.aggregate_id,
          seq: EventTable.seq,
          type: EventTable.type,
          data: projectedEventData,
        })
        .from(EventTable)
        .where(inArray(EventTable.id, page.ids))
        .orderBy(asc(EventTable.seq), asc(EventTable.aggregate_id))
        .all()
        .pipe(Effect.orDie)
      const result = rows.map((row) => {
        const data = Option.getOrUndefined(decodeJson(row.data))
        return { ...row, data: record(data) ? data : {} }
      })
      const bounded = result.reduce<{ items: typeof result; bytes: number; closed: boolean }>(
        (page, item) => {
          if (page.closed) return page
          const bytes = Buffer.byteLength(JSON.stringify(item)) + (page.items.length > 0 ? 1 : 0)
          if (page.bytes + bytes + 2 > SyncHistoryLimits.bytes) return { ...page, closed: true }
          return { items: [...page.items, item], bytes: page.bytes + bytes, closed: false }
        },
        { items: [], bytes: 0, closed: false },
      )
      if (bounded.items.length === 0 && result.length > 0)
        return yield* new ServiceUnavailableError({
          service: "sync.history",
          message: `Projected sync event ${result[0]!.id} exceeds the bounded history page`,
        })
      return bounded.items
    })

    return handlers.handle("start", start).handle("replay", replay).handle("steal", steal).handle("history", history)
  }),
)
