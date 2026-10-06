export * as Attention from "./attention"

import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, notLike, or, sql, type SQL } from "drizzle-orm"
import { Array, Context, Effect, Layer, Option, Schema } from "effect"
import { AttentionSchema } from "./attention/schema"
import { AttentionSeenTable } from "./attention/sql"
import { SessionActivityTable } from "./context-federation/session-sql"
import { Database } from "./database/database"
import { SessionRestart } from "./session/execution/restart"
import { SessionSchema } from "./session/schema"
import { SessionTable } from "./session/sql"
import { Hash } from "./util/hash"

export const scope = "implicit-local" as const
const actor = "server" as const

/** Only the embedding host may enable this profile, never a request parameter. */
export const Access = Context.Reference<AttentionSchema.Capability>("@deepagent-code/AttentionAccess", {
  defaultValue: () => ({ enabled: false, scope, actor, reason: "profile_disabled" }),
})

export function localCapability(input: {
  profile?: string
  gateway: boolean
  workspaceID?: string
}): AttentionSchema.Capability {
  if (input.gateway || input.workspaceID) return { enabled: false, scope, actor, reason: "unsupported_host" }
  if (input.profile !== scope) return { enabled: false, scope, actor, reason: "profile_disabled" }
  return { enabled: true, scope, actor, reason: "enabled" }
}

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("Attention.Unavailable", {
  reason: Schema.String,
}) {}
export class NotFound extends Schema.TaggedErrorClass<NotFound>()("Attention.NotFound", {}) {}
export class Stale extends Schema.TaggedErrorClass<Stale>()("Attention.Stale", {}) {}
export class Invalid extends Schema.TaggedErrorClass<Invalid>()("Attention.Invalid", { field: Schema.String }) {}

type Query = {
  project?: string
  kind?: typeof AttentionSchema.Kind.Type
  view?: "all" | "unseen"
  cursor?: string
  limit?: number
}
const Cursor = Schema.Struct({
  scope: Schema.Literal(scope),
  project: Schema.String,
  kind: Schema.String,
  view: Schema.Literals(["all", "unseen"]),
  rank: Schema.Literals([0, 1]),
  time: Schema.Finite,
  id: Schema.String,
})
const CursorJson = Schema.fromJsonString(Cursor)
const sessionColumns = {
  id: SessionTable.id,
  title: SessionTable.title,
  project_id: SessionTable.project_id,
  directory: SessionTable.directory,
  parent_id: SessionTable.parent_id,
  execution_claim_token: SessionTable.execution_claim_token,
}

export interface Interface {
  readonly capability: AttentionSchema.Capability
  readonly list: (query?: Query) => Effect.Effect<AttentionSchema.List, Unavailable | Invalid>
  readonly get: (id: string) => Effect.Effect<AttentionSchema.Item, Unavailable | NotFound>
  readonly seen: (id: string, revision: string) => Effect.Effect<AttentionSchema.Item, Unavailable | NotFound | Stale>
}
export class Service extends Context.Service<Service, Interface>()("@deepagent-code/Attention") {}

export const layer = () =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const restart = yield* SessionRestart.Service
      const access = yield* Access
      const db = database.db
      const enabled = access.enabled ? Effect.void : Effect.fail(new Unavailable({ reason: access.reason }))

      const sessionWhere = (project?: string) =>
        and(
          isNull(SessionTable.workspace_id),
          eq(SessionTable.v2_authority, true),
          notLike(SessionTable.id, `${SessionSchema.LEARNING_REVIEWER_SESSION_PREFIX}%`),
          project ? sql`${SessionTable.project_id} = ${project}` : undefined,
        )
      // These strings are also the SQL join keys. A terminal activity never becomes
      // succeeded when a later drain succeeds; each activity keeps its own receipt.
      const failureID = sql<string>`'activity:' || ${SessionActivityTable.activity_id}`
      const failureTime = sql<number>`coalesce(${SessionActivityTable.settled_at}, ${SessionActivityTable.created_at})`
      const failureRevision = sql<string>`'failed:' || ${failureTime}`
      const seenJoin = and(
        eq(AttentionSeenTable.scope_key, scope),
        eq(AttentionSeenTable.actor_id, actor),
        eq(AttentionSeenTable.item_id, failureID),
        eq(AttentionSeenTable.source_revision, failureRevision),
      )
      const failureWhere = (query: Query) =>
        and(
          sessionWhere(query.project),
          eq(SessionActivityTable.state, "failed"),
          query.view === "unseen" ? isNull(AttentionSeenTable.seen_at) : undefined,
        )
      const failures = (query: Query, options: { after?: typeof Cursor.Type; id?: string; limit?: number } = {}) => {
        const after = options.after
        const conditions: (SQL | undefined)[] = [failureWhere(query)]
        if (options.id) conditions.push(eq(SessionActivityTable.activity_id, options.id))
        if (after?.rank === 1)
          conditions.push(or(lt(failureTime, after.time), and(eq(failureTime, after.time), gt(failureID, after.id))))
        return db
          .select({
            id: failureID,
            revision: failureRevision,
            activityID: SessionActivityTable.activity_id,
            occurredAt: failureTime,
            session: sessionColumns,
            seenAt: AttentionSeenTable.seen_at,
          })
          .from(SessionActivityTable)
          .innerJoin(SessionTable, eq(SessionTable.id, SessionActivityTable.session_id))
          .leftJoin(AttentionSeenTable, seenJoin)
          .where(and(...conditions))
          .orderBy(desc(failureTime), failureID)
          .limit(options.limit ?? 1)
          .all()
          .pipe(Effect.orDie)
      }

      const recoveries = Effect.fn("Attention.recoveries")(function* (project?: string, itemID?: string) {
        const rows = yield* db
          .select(sessionColumns)
          .from(SessionTable)
          .where(and(sessionWhere(project), isNotNull(SessionTable.execution_claim_token)))
          .all()
          .pipe(Effect.orDie)
        const sessions = itemID ? rows.filter((row) => recoveryID(row) === itemID) : rows
        if (sessions.length === 0) return []
        // Keep SQLite parameter counts bounded even for a long-lived multi-project
        // host. All batches are included; the unseen count never truncates inventory.
        const inventory = (yield* Effect.forEach(
          Array.chunksOf(
            sessions.map((session) => session.id),
            256,
          ),
          (sessionIDs) => restart.pendingRecoveryFor(sessionIDs),
        )).flat()
        const bySession = new Map(sessions.map((session) => [session.id, session]))
        const items = inventory.flatMap((recovery) => {
          const session = bySession.get(recovery.sessionID)
          if (!session || session.execution_claim_token !== recovery.claimToken) return []
          const id = recoveryID(session)
          const revision = Hash.sha256(
            JSON.stringify({
              ...recovery,
              turns: [...recovery.turns].sort((a, b) => a.receipt.receiptId.localeCompare(b.receipt.receiptId)),
              tools: [...recovery.tools].sort((a, b) => a.receiptId.localeCompare(b.receiptId)),
              tasks: [...recovery.tasks].sort((a, b) => a.runId.localeCompare(b.runId)),
              effects: [...recovery.effects].sort((a, b) => a.effectId.localeCompare(b.effectId)),
            }),
          )
          return [
            {
              id,
              revision,
              kind: "execution_recovery" as const,
              state:
                recovery.disposition === "recovery_required" ||
                recovery.disposition === "authority_conflict" ||
                recovery.disposition === "owned_elsewhere"
                  ? recovery.disposition
                  : ("execution_claim_pending" as const),
              reasonCode: recovery.disposition,
              occurredAt: null,
              observedAt: Date.now(),
              session: sessionInfo(session),
              source: {},
              seen: false,
              seenAt: null as number | null,
            },
          ]
        })
        if (items.length === 0) return items
        const receipts = new Map(
          (yield* Effect.forEach(
            Array.chunksOf(
              items.map((item) => item.id),
              256,
            ),
            (ids) =>
              db
                .select()
                .from(AttentionSeenTable)
                .where(
                  and(
                    eq(AttentionSeenTable.scope_key, scope),
                    eq(AttentionSeenTable.actor_id, actor),
                    inArray(AttentionSeenTable.item_id, ids),
                  ),
                )
                .all()
                .pipe(Effect.orDie),
          ))
            .flat()
            .map((row) => [`${row.item_id}:${row.source_revision}`, row]),
        )
        return items
          .map((item) => {
            const receipt = receipts.get(`${item.id}:${item.revision}`)
            return { ...item, seen: !!receipt, seenAt: receipt?.seen_at ?? null }
          })
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      })

      const get = Effect.fn("Attention.get")(function* (id: string) {
        yield* enabled
        if (id.startsWith("activity:")) {
          const rows = yield* failures({}, { id: id.slice("activity:".length) })
          if (rows[0]) return failureItem(rows[0], Date.now())
        }
        if (/^recovery:[a-f0-9]{64}$/.test(id)) {
          const item = (yield* recoveries(undefined, id))[0]
          if (item) return item
        }
        return yield* new NotFound({})
      })

      return Service.of({
        capability: access,
        get,
        list: Effect.fn("Attention.list")(function* (query = {}) {
          yield* enabled
          const limit = query.limit ?? 50
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) return yield* new Invalid({ field: "limit" })
          const filters = { scope, project: query.project ?? "", kind: query.kind ?? "", view: query.view ?? "all" }
          const parsed =
            query.cursor && query.cursor.length <= 4096
              ? Schema.decodeUnknownOption(CursorJson)(Buffer.from(query.cursor, "base64url").toString("utf8"))
              : Option.none()
          if (
            query.cursor &&
            (Option.isNone(parsed) ||
              Object.entries(filters).some(([key, value]) => parsed.value[key as keyof typeof filters] !== value))
          )
            return yield* new Invalid({ field: "cursor" })
          const after = Option.getOrUndefined(parsed)
          const asOf = Date.now()
          const recovery = query.kind === "activity_failed" ? [] : yield* recoveries(query.project)
          const [total] =
            query.kind === "execution_recovery"
              ? [{ value: 0 }]
              : yield* db
                  .select({ value: count() })
                  .from(SessionActivityTable)
                  .innerJoin(SessionTable, eq(SessionTable.id, SessionActivityTable.session_id))
                  .leftJoin(AttentionSeenTable, seenJoin)
                  .where(failureWhere({ ...query, view: "unseen" }))
                  .all()
                  .pipe(Effect.orDie)
          const selected = recovery.filter(
            (item) => (query.view !== "unseen" || !item.seen) && (!after || (after.rank === 0 && item.id > after.id)),
          )
          const rows =
            query.kind === "execution_recovery" || selected.length > limit
              ? []
              : yield* failures(query, { after, limit: limit + 1 - selected.length })
          const items = [...selected.slice(0, limit + 1), ...rows.map((row) => failureItem(row, asOf))]
          const data = items.slice(0, limit).map((item) => ({ ...item, observedAt: asOf }))
          const last = data.at(-1)
          return {
            data,
            asOf,
            scope,
            unseenCount: recovery.filter((item) => !item.seen).length + total.value,
            ...(items.length > limit && last
              ? {
                  nextCursor: Buffer.from(
                    JSON.stringify({
                      ...filters,
                      rank: last.kind === "execution_recovery" ? 0 : 1,
                      time: last.occurredAt ?? 0,
                      id: last.id,
                    }),
                  ).toString("base64url"),
                }
              : {}),
          }
        }),
        seen: Effect.fn("Attention.seen")(function* (id, revision) {
          yield* enabled
          if (database.mode && (!database.mode.ready || database.mode.mode !== "ready"))
            return yield* new Unavailable({ reason: "read_only" })
          return yield* db
            .transaction(
              () =>
                Effect.gen(function* () {
                  // The shared SQL transaction context also covers recovery inventory.
                  // Scope/revision validation and the receipt commit share one writer lock.
                  const item = yield* get(id)
                  if (item.revision !== revision) return yield* new Stale({})
                  yield* db
                    .insert(AttentionSeenTable)
                    .values({
                      scope_key: scope,
                      actor_id: actor,
                      item_id: id,
                      source_revision: revision,
                      session_id: item.session.id,
                      seen_at: Date.now(),
                    })
                    .onConflictDoNothing()
                    .run()
                    .pipe(Effect.orDie)
                  return yield* get(id)
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.catchTag("SqlError", Effect.die))
        }),
      })
    }),
  )

type SessionRow = Pick<typeof SessionTable.$inferSelect, keyof typeof sessionColumns>

function sessionInfo(row: SessionRow): AttentionSchema.Item["session"] {
  return {
    id: row.id,
    title: row.title,
    projectID: row.project_id,
    directory: row.directory,
    workspaceID: null,
    ...(row.parent_id ? { parentID: row.parent_id } : {}),
  }
}

function recoveryID(row: SessionRow) {
  // Keep the opaque ID under the HTTP router's 100-character parameter limit,
  // regardless of Session ID length. Raw execution claim tokens never leave core.
  return `recovery:${Hash.sha256(`${row.id}:${row.execution_claim_token}`)}`
}

function failureItem(
  row: {
    id: string
    revision: string
    activityID: string
    occurredAt: number
    session: SessionRow
    seenAt: number | null
  },
  observedAt: number,
): AttentionSchema.Item {
  return {
    id: row.id,
    revision: row.revision,
    kind: "activity_failed",
    state: "failed",
    reasonCode: "activity_failed",
    occurredAt: row.occurredAt,
    observedAt,
    session: sessionInfo(row.session),
    source: { activityID: row.activityID },
    seen: row.seenAt !== null,
    seenAt: row.seenAt,
  }
}
