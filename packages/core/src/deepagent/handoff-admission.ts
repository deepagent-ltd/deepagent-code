export * as HandoffAdmission from "./handoff-admission"

import { Context, Effect, Layer } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "../database/database"
import type { DeepAgentEvent } from "./deepagent-event"
import { DeepAgentHandoffAdmissionTable } from "./handoff-admission-sql"

// FEAT-008 — durable admission receipts for `agent.handoff.requested` handling (table:
// handoff-admission-sql.ts). Closes the "事件即状态" gap: before this receipt existed, a crash
// between receiving a handoff event and settling it was indistinguishable from "never processed" —
// the only record was the delivery row's ack/nack. Now every admission is durably stamped
// `processing` BEFORE any side-effecting decision and settled to a terminal state exactly once:
//
//   no row      → 未处理 (never admitted)
//   processing  → 处理中 — and after a crash this means "NOT finished": begin() re-admits it
//                  (re-stamps the claimant) instead of treating it as settled. Recovery itself is
//                  driven by the bus delivery claim/lease — an unacked delivery whose lease lapsed
//                  is re-claimed by the retry pump, which re-runs the consumer and thus begin().
//   accepted /  → 已完成: TERMINAL rows are never overwritten, so a redelivery short-circuits
//   rejected      (begin() returns the terminal receipt) without re-running side effects.
export type State = "processing" | "accepted" | "rejected"

export interface Receipt {
  readonly handoffID: string
  readonly eventID: DeepAgentEvent.ID
  readonly workspaceID: string
  readonly state: State
  readonly claimantID: string
  readonly reason?: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly settledAt?: number
}

export interface Interface {
  /**
   * Admit a handoff request for processing. Inserts the `processing` receipt on first admission; a
   * re-admission (crash recovery / redelivery) re-stamps claimant+updated_at ONLY while the row is
   * still `processing`. A TERMINAL receipt is returned untouched — the caller must short-circuit.
   */
  readonly begin: (input: {
    readonly handoffID: string
    readonly eventID: DeepAgentEvent.ID
    readonly workspaceID: string
    readonly claimantID: string
    readonly at?: number
  }) => Effect.Effect<Receipt>
  /**
   * Settle the admission to its terminal state. Conditioned on `state = 'processing'` — settling an
   * already-terminal (or missing) receipt is a no-op → false, so a stale claimant can never flip a
   * terminal receipt its successor already settled.
   */
  readonly settle: (input: {
    readonly handoffID: string
    readonly state: "accepted" | "rejected"
    readonly reason?: string
    readonly at?: number
  }) => Effect.Effect<boolean>
  readonly get: (handoffID: string) => Effect.Effect<Receipt | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/HandoffAdmission") {}

export interface LayerOptions {
  readonly now?: () => number
}

const decode = (row: typeof DeepAgentHandoffAdmissionTable.$inferSelect): Receipt => ({
  handoffID: row.handoff_id,
  eventID: row.event_id,
  workspaceID: row.workspace_id,
  state: row.state,
  claimantID: row.claimant_id,
  ...(row.reason != null ? { reason: row.reason } : {}),
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  ...(row.settled_at != null ? { settledAt: row.settled_at } : {}),
})

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const now = options?.now ?? Date.now

      const get: Interface["get"] = (handoffID) =>
        db
          .select()
          .from(DeepAgentHandoffAdmissionTable)
          .where(eq(DeepAgentHandoffAdmissionTable.handoff_id, handoffID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => (row ? decode(row) : undefined)),
          )

      const begin: Interface["begin"] = (input) =>
        Effect.gen(function* () {
          const at = input.at ?? now()
          const existing = yield* get(input.handoffID)
          // 已完成 is sticky: a terminal receipt survives every re-admission (crash recovery, lease
          // re-claim, duplicate redelivery) — the caller observes the terminal state and acks without
          // re-running accept/reject side effects.
          if (existing && existing.state !== "processing") return existing
          if (existing) {
            // 处理中 after a crash: still "not finished" — take it over (fresh claimant stamp). The
            // `state = 'processing'` guard keeps a racing terminal settle from being overwritten.
            yield* db
              .update(DeepAgentHandoffAdmissionTable)
              .set({ claimant_id: input.claimantID, updated_at: at })
              .where(
                and(
                  eq(DeepAgentHandoffAdmissionTable.handoff_id, input.handoffID),
                  eq(DeepAgentHandoffAdmissionTable.state, "processing"),
                ),
              )
              .run()
              .pipe(Effect.orDie)
            return { ...existing, claimantID: input.claimantID, updatedAt: at }
          }
          // 未处理 → first admission. A racing writer that already settled the row wins the conflict;
          // re-read so the caller always sees the authoritative (possibly terminal) receipt.
          yield* db
            .insert(DeepAgentHandoffAdmissionTable)
            .values({
              handoff_id: input.handoffID,
              event_id: input.eventID,
              workspace_id: input.workspaceID,
              state: "processing",
              claimant_id: input.claimantID,
              reason: null,
              started_at: at,
              updated_at: at,
              settled_at: null,
            })
            .onConflictDoNothing({ target: DeepAgentHandoffAdmissionTable.handoff_id })
            .run()
            .pipe(Effect.orDie)
          const settled = yield* get(input.handoffID)
          return (
            settled ?? {
              handoffID: input.handoffID,
              eventID: input.eventID,
              workspaceID: input.workspaceID,
              state: "processing" as const,
              claimantID: input.claimantID,
              startedAt: at,
              updatedAt: at,
            }
          )
        })

      const settle: Interface["settle"] = (input) =>
        db
          .update(DeepAgentHandoffAdmissionTable)
          .set({
            state: input.state,
            reason: input.reason ?? null,
            updated_at: input.at ?? now(),
            settled_at: input.at ?? now(),
          })
          .where(
            and(
              eq(DeepAgentHandoffAdmissionTable.handoff_id, input.handoffID),
              eq(DeepAgentHandoffAdmissionTable.state, "processing"),
            ),
          )
          .returning({ handoff_id: DeepAgentHandoffAdmissionTable.handoff_id })
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows.length > 0),
          )

      return Service.of({ begin, settle, get })
    }),
  )

export const layer = layerWith()
export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
