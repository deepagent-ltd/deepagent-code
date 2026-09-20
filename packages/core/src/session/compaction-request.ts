export * as CompactionRequest from "./compaction-request"

import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { Hash } from "../util/hash"
import { CompactionRequestTable } from "./compaction-request.sql"

type DatabaseService = Database.Interface["db"]

export const Status = ["pending", "dispatched", "settled", "recovery_required", "failed"] as const
export type Status = (typeof Status)[number]

export type Request = typeof CompactionRequestTable.$inferSelect

/**
 * RI-18 durable manual-compaction request. The id is deterministic over (session, model, fence):
 * an exact retry while a request for the same history fence is still open coalesces onto it
 * instead of queueing a second compaction of the same boundary.
 */
export const admit = Effect.fn("CompactionRequest.admit")(function* (
  db: DatabaseService,
  input: {
    readonly sessionID: string
    readonly providerID: string
    readonly modelID: string
    readonly fenceMessageCount: number
    readonly fenceLastMessageID: string
  },
) {
  const requestID = `v2cr_${Hash.sha256(
    `${input.sessionID}\u0000${input.providerID}\u0000${input.modelID}\u0000${input.fenceMessageCount}\u0000${input.fenceLastMessageID}`,
  ).slice(0, 32)}`
  yield* db
    .insert(CompactionRequestTable)
    .values({
      request_id: requestID,
      session_id: input.sessionID,
      provider_id: input.providerID,
      model_id: input.modelID,
      fence_message_count: input.fenceMessageCount,
      fence_last_message_id: input.fenceLastMessageID,
      status: "pending",
      created_at: Date.now(),
    })
    .onConflictDoNothing()
    .pipe(Effect.orDie)
  const row = yield* db
    .select()
    .from(CompactionRequestTable)
    .where(eq(CompactionRequestTable.request_id, requestID))
    .get()
    .pipe(Effect.orDie)
  if (row === undefined) return yield* Effect.die(`compaction request disappeared after admit: ${requestID}`)
  return row
})

/** The PENDING request a drain should process. Dispatched rows belong to another drain (the
 * coordinator serializes same-session drains), so gating on pending-only keeps a stale
 * dispatched row from busy-spinning the activity loop. */
export const pendingForSession = Effect.fn("CompactionRequest.pendingForSession")(function* (
  db: DatabaseService,
  sessionID: string,
) {
  const rows = yield* db
    .select()
    .from(CompactionRequestTable)
    .where(and(eq(CompactionRequestTable.session_id, sessionID), eq(CompactionRequestTable.status, "pending")))
    .get()
    .pipe(Effect.orDie)
  return rows
})

/** A dispatched request observed by a fresh drain is orphaned (its owner died or restarted) —
 * surface it as recovery_required instead of leaving it blocking future compactions. */
export const settleOrphaned = Effect.fn("CompactionRequest.settleOrphaned")(function* (
  db: DatabaseService,
  sessionID: string,
) {
  yield* db
    .update(CompactionRequestTable)
    .set({ status: "recovery_required", outcome: "orphaned_dispatched_compaction", settled_at: Date.now() })
    .where(
      and(eq(CompactionRequestTable.session_id, sessionID), eq(CompactionRequestTable.status, "dispatched")),
    )
    .pipe(Effect.orDie)
})

export const markDispatched = Effect.fn("CompactionRequest.markDispatched")(function* (
  db: DatabaseService,
  requestID: string,
) {
  yield* db
    .update(CompactionRequestTable)
    .set({ status: "dispatched" })
    .where(and(eq(CompactionRequestTable.request_id, requestID), eq(CompactionRequestTable.status, "pending")))
    .pipe(Effect.orDie)
})

export const settle = Effect.fn("CompactionRequest.settle")(function* (
  db: DatabaseService,
  requestID: string,
  outcome: {
    readonly status: "settled" | "recovery_required" | "failed"
    readonly outcome: string
    readonly summaryReceiptID?: string
  },
) {
  yield* db
    .update(CompactionRequestTable)
    .set({
      status: outcome.status,
      outcome: outcome.outcome,
      ...(outcome.summaryReceiptID === undefined ? {} : { summary_receipt_id: outcome.summaryReceiptID }),
      settled_at: Date.now(),
    })
    .where(and(eq(CompactionRequestTable.request_id, requestID), eq(CompactionRequestTable.status, "dispatched")))
    .pipe(Effect.orDie)
})

/**
 * Await a request's terminal state. Interrupts and defects are left to the caller; the deadline
 * surfaces as `undefined` so SessionV2.compact can translate it into a typed unavailability
 * instead of an unbounded hang.
 */
export const awaitTerminal = Effect.fn("CompactionRequest.awaitTerminal")(function* (
  db: DatabaseService,
  requestID: string,
  deadlineMs: number,
) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const row = yield* db
      .select()
      .from(CompactionRequestTable)
      .where(eq(CompactionRequestTable.request_id, requestID))
      .get()
      .pipe(Effect.orDie)
    if (row === undefined) return yield* Effect.die(`compaction request disappeared: ${requestID}`)
    if (row.status !== "pending" && row.status !== "dispatched") return row
    if (Date.now() >= deadline) return undefined
    yield* Effect.sleep(50)
  }
})
