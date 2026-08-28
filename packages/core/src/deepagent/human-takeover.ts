export * as HumanTakeover from "./human-takeover"

import { Context, Effect, Layer } from "effect"
import { and, desc, eq, gte, lte, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { HumanTakeoverTable } from "./human-takeover-sql"
import { Identifier } from "../util/identifier"

// V4.0 §D2/§F — the Human Takeover service. Records the FACT that a human stepped in over an agent
// (paused/reverted its session, or claimed a branch/session it was driving) and exposes the count as the
// §F `human_takeover_total` metric. This is the backend the §D2 Takeover surface (P3.12 frontend) calls
// to record a takeover, and the observability metric reads. Append-only: a takeover is a past event, not
// a mutable request — so there is no resolve/update, only record + count/list.
//
// LAYERING: `core`. Pure durable state; the HTTP/Oversight layer (deepagent-code) calls `record` from the
// Takeover endpoint and `count` feeds the Observability metric snapshot.

export interface TakeoverRecord {
  readonly id: string
  readonly workspaceID: string
  readonly sessionID?: string
  readonly agentID?: string
  readonly actorID?: string
  readonly reason?: string
  readonly createdAt: number
}

export interface RecordInput {
  readonly workspaceID: string
  readonly sessionID?: string
  readonly agentID?: string
  readonly actorID?: string
  readonly reason?: string
}

export interface Interface {
  /** §D2 — record a human takeover (an already-happened fact). Returns the persisted row. */
  readonly record: (input: RecordInput) => Effect.Effect<TakeoverRecord>
  /** §D2 — a workspace's takeovers over [from, to], newest first (the Takeover surface). */
  readonly list: (input: { workspaceID: string; from: number; to: number }) => Effect.Effect<ReadonlyArray<TakeoverRecord>>
  /** §F `human_takeover_total` — the count of takeovers for a workspace over [from, to]. */
  readonly count: (input: { workspaceID: string; from: number; to: number }) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/HumanTakeover") {}

export interface LayerOptions {
  readonly now?: () => number
}

const decode = (row: {
  id: string
  workspace_id: string
  session_id: string | null
  agent_id: string | null
  actor_id: string | null
  reason: string | null
  created_at: number
}): TakeoverRecord => ({
  id: row.id,
  workspaceID: row.workspace_id,
  ...(row.session_id != null ? { sessionID: row.session_id } : {}),
  ...(row.agent_id != null ? { agentID: row.agent_id } : {}),
  ...(row.actor_id != null ? { actorID: row.actor_id } : {}),
  ...(row.reason != null ? { reason: row.reason } : {}),
  createdAt: row.created_at,
})

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = options?.now ?? Date.now

      const record: Interface["record"] = (input) =>
        Effect.gen(function* () {
          const row = {
            id: "tko_" + Identifier.ascending(),
            workspace_id: input.workspaceID,
            session_id: input.sessionID ?? null,
            agent_id: input.agentID ?? null,
            actor_id: input.actorID ?? null,
            reason: input.reason ?? null,
            created_at: now(),
          }
          yield* db.insert(HumanTakeoverTable).values([row]).run().pipe(Effect.orDie)
          return decode(row)
        })

      const list: Interface["list"] = (input) =>
        db
          .select()
          .from(HumanTakeoverTable)
          .where(
            and(
              eq(HumanTakeoverTable.workspace_id, input.workspaceID),
              gte(HumanTakeoverTable.created_at, input.from),
              lte(HumanTakeoverTable.created_at, input.to),
            ),
          )
          .orderBy(desc(HumanTakeoverTable.created_at))
          .all()
          .pipe(Effect.orDie, Effect.map((rows) => rows.map(decode)))

      const count: Interface["count"] = (input) =>
        db
          .select({ n: sql<number>`count(*)` })
          .from(HumanTakeoverTable)
          .where(
            and(
              eq(HumanTakeoverTable.workspace_id, input.workspaceID),
              gte(HumanTakeoverTable.created_at, input.from),
              lte(HumanTakeoverTable.created_at, input.to),
            ),
          )
          .get()
          .pipe(Effect.orDie, Effect.map((r) => r?.n ?? 0))

      return Service.of({ record, list, count })
    }),
  )

export const layer = layerWith()

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
