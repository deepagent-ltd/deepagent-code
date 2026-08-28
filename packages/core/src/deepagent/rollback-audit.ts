export * as RollbackAudit from "./rollback-audit"

import { Context, Effect, Layer } from "effect"
import { and, desc, eq, gte, lte, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { RollbackAuditTable } from "./rollback-audit-sql"
import { Identifier } from "../util/identifier"

// V4.0 §D2/§F — the Rollback audit service. Records the FACT that a human rolled back an agent-produced
// change over a session (via SessionRevert) and exposes the count as the §F `rollback_total` metric. This
// is the backend the §D2 Rollback surface (paired with the Takeover surface) calls to record a rollback,
// and the observability metric reads. Append-only: a rollback is a past event, not a mutable request — so
// there is no resolve/update, only record + count/list. Mirrors HumanTakeover exactly, plus `outcome`
// (a rollback can be a no-op when there is nothing to revert, so the recorded fact carries the result).
//
// LAYERING: `core`. Pure durable state; the HTTP/Oversight layer (deepagent-code) calls `record` from the
// Rollback endpoint (after invoking SessionRevert) and `count` feeds the Observability metric snapshot.

export type RollbackOutcome = "reverted" | "noop"

export interface RollbackRecord {
  readonly id: string
  readonly workspaceID: string
  readonly sessionID: string
  readonly actorID?: string
  readonly reason?: string
  readonly outcome: RollbackOutcome
  readonly createdAt: number
}

export interface RecordInput {
  readonly workspaceID: string
  readonly sessionID: string
  readonly actorID?: string
  readonly reason?: string
  readonly outcome: RollbackOutcome
}

export interface Interface {
  /** §D2 — record a rollback (an already-happened fact). Returns the persisted row. */
  readonly record: (input: RecordInput) => Effect.Effect<RollbackRecord>
  /** §D2 — a workspace's rollbacks over [from, to], newest first (the Rollback surface). */
  readonly list: (input: { workspaceID: string; from: number; to: number }) => Effect.Effect<ReadonlyArray<RollbackRecord>>
  /** §F `rollback_total` — the count of rollbacks for a workspace over [from, to]. */
  readonly count: (input: { workspaceID: string; from: number; to: number }) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/RollbackAudit") {}

export interface LayerOptions {
  readonly now?: () => number
}

const decode = (row: {
  id: string
  workspace_id: string
  session_id: string
  actor_id: string | null
  reason: string | null
  outcome: string
  created_at: number
}): RollbackRecord => ({
  id: row.id,
  workspaceID: row.workspace_id,
  sessionID: row.session_id,
  ...(row.actor_id != null ? { actorID: row.actor_id } : {}),
  ...(row.reason != null ? { reason: row.reason } : {}),
  outcome: row.outcome === "reverted" ? "reverted" : "noop",
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
            id: "rbk_" + Identifier.ascending(),
            workspace_id: input.workspaceID,
            session_id: input.sessionID,
            actor_id: input.actorID ?? null,
            reason: input.reason ?? null,
            outcome: input.outcome,
            created_at: now(),
          }
          yield* db.insert(RollbackAuditTable).values([row]).run().pipe(Effect.orDie)
          return decode(row)
        })

      const list: Interface["list"] = (input) =>
        db
          .select()
          .from(RollbackAuditTable)
          .where(
            and(
              eq(RollbackAuditTable.workspace_id, input.workspaceID),
              gte(RollbackAuditTable.created_at, input.from),
              lte(RollbackAuditTable.created_at, input.to),
            ),
          )
          .orderBy(desc(RollbackAuditTable.created_at))
          .all()
          .pipe(Effect.orDie, Effect.map((rows) => rows.map(decode)))

      const count: Interface["count"] = (input) =>
        db
          .select({ n: sql<number>`count(*)` })
          .from(RollbackAuditTable)
          .where(
            and(
              eq(RollbackAuditTable.workspace_id, input.workspaceID),
              gte(RollbackAuditTable.created_at, input.from),
              lte(RollbackAuditTable.created_at, input.to),
            ),
          )
          .get()
          .pipe(Effect.orDie, Effect.map((r) => r?.n ?? 0))

      return Service.of({ record, list, count })
    }),
  )

export const layer = layerWith()

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
