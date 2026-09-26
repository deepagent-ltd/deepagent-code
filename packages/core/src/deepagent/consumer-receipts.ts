export * as ConsumerReceipts from "./consumer-receipts"

import { and, eq, isNull, ne, or } from "drizzle-orm"
import { Cause, Effect } from "effect"
import { createHash } from "node:crypto"
import type { Database } from "../database/database"
import { ConsumerReceiptTable, type ConsumerReceiptStatus } from "./consumer-receipt-sql"
import { DeepAgentEventSpoolTable } from "./event-spool-sql"

// C5-10 — PER-CONSUMER SIDE-EFFECT RECEIPTS. Design authority: docs/core-v2.0-beta/design.md §8.6
// (consumer delivery ledger + E3 有界 retry semantics) + §8.4 (durable receipt per node/work unit).
//
// Event-driven consumers have an EXTERNAL side effect beyond the delivery ledger: the goal tick driver
// advances a goal, the handoff consumer launches the next agent, and (in the deepagent-code wiring) the
// panel convene, execution-archive and IM-push sinks mutate their own stores. Each side effect must be
// idempotent under redelivery. This module is the durable idempotency seam: one receipt per
// (consumerKind, sourceEventId) that proves the side effect RAN (or is pending).
//
//   - first delivery  → the side effect executes and the receipt flips to `done` (+ receiptRef).
//   - redelivery      → a `done` receipt returns "existing" — the side effect runs EXACTLY ONCE.
//   - sink failure    → the receipt STAYS `pending` (retryable) so the E3 delivery retry resumes it.
//   - cold recovery   → receipts are durable; a simulated restart restores them and a done receipt is
//                       NOT re-executed.
//
// The module is DURABLE-ONLY (every read goes through `db`; no in-memory registry). LAYERING: `core`.
// The consumer sinks are passed as a caller-supplied `sideEffect` (`Effect`), so this module has no
// dependency on the deepagent-code sinks that live behind the frozen package boundary.

type DatabaseClient = Database.Interface["db"]

/** The stable identity of a consumer (e.g. "goal_tick", "handoff", "panel", "archive", "push"). */
export type ConsumerKind = string

/** Why a consumer side-effect receipt operation failed. Fail-closed; each reason is typed. */
export type ConsumerReceiptErrorReason = "sink_failed" | "invalid_input"

/** Typed refusal thrown through the Effect failure channel (never a buried throw). */
export class ConsumerReceiptError extends Error {
  readonly _tag = "ConsumerReceipts.ConsumerReceiptError"
  readonly reason: ConsumerReceiptErrorReason
  readonly consumerKind: ConsumerKind
  readonly sourceEventId: string
  constructor(reason: ConsumerReceiptErrorReason, consumerKind: ConsumerKind, sourceEventId: string, message: string) {
    super(message)
    this.name = "ConsumerReceiptError"
    this.reason = reason
    this.consumerKind = consumerKind
    this.sourceEventId = sourceEventId
  }
}

const fail = (reason: ConsumerReceiptErrorReason, consumerKind: ConsumerKind, sourceEventId: string, message: string) =>
  Effect.fail(new ConsumerReceiptError(reason, consumerKind, sourceEventId, message))

/** The durable side-effect receipt row (as read from the ledger). */
export type ConsumerReceiptRow = {
  readonly consumerKind: ConsumerKind
  readonly sourceEventId: string
  readonly status: ConsumerReceiptStatus
  readonly attempts: number
  readonly lastError?: string
  readonly receiptRef?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly resolvedAt?: number
}

const decodeRow = (row: typeof ConsumerReceiptTable.$inferSelect): ConsumerReceiptRow => ({
  consumerKind: row.consumer_kind,
  sourceEventId: row.source_event_id,
  status: row.status as ConsumerReceiptStatus,
  attempts: row.attempts,
  ...(row.last_error != null ? { lastError: row.last_error } : {}),
  ...(row.receipt_ref != null ? { receiptRef: row.receipt_ref } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.resolved_at != null ? { resolvedAt: row.resolved_at } : {}),
})

/** Read the durable receipt for a (consumerKind, sourceEventId), if any. */
export function receiptFor(db: DatabaseClient, consumerKind: ConsumerKind, sourceEventId: string): Effect.Effect<ConsumerReceiptRow | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(ConsumerReceiptTable)
      .where(and(eq(ConsumerReceiptTable.consumer_kind, consumerKind), eq(ConsumerReceiptTable.source_event_id, sourceEventId)))
      .get()
      .pipe(Effect.orDie)
    return row ? decodeRow(row) : undefined
  })
}

/**
 * Clear a PENDING failure receipt (W5 F4): a consumer that eventually succeeded removes its own pending
 * failure record so the ledger does not show a stale "failure" for work that completed. A `done` receipt
 * is NEVER cleared (the completed side effect stays the idempotency authority). No-op when absent.
 */
export function clearPending(db: DatabaseClient, consumerKind: ConsumerKind, sourceEventId: string): Effect.Effect<void> {
  return db
    .delete(ConsumerReceiptTable)
    .where(
      and(
        eq(ConsumerReceiptTable.consumer_kind, consumerKind),
        eq(ConsumerReceiptTable.source_event_id, sourceEventId),
        eq(ConsumerReceiptTable.status, "pending"),
      ),
    )
    .run()
    .pipe(Effect.asVoid, Effect.orDie)
}

/** The deterministic content reference of a completed side effect (proves WHICH consumer.event ran). */
export const receiptRefFor = (consumerKind: ConsumerKind, sourceEventId: string): string =>
  createHash("sha256").update(`${consumerKind}:${sourceEventId}`).digest("hex")

export interface RunOnceInput {
  readonly consumerKind: ConsumerKind
  readonly sourceEventId: string
  /** The consumer's external side effect. Runs ONCE on first delivery (and again only if still pending). */
  readonly sideEffect: Effect.Effect<unknown, unknown>
  readonly now: number
}

export type RunOnceResult =
  | { readonly kind: "executed"; readonly receipt: ConsumerReceiptRow }
  | { readonly kind: "existing"; readonly receipt: ConsumerReceiptRow }

/**
 * Run a consumer side effect at most once for a (consumerKind, sourceEventId), with durable
 * idempotency + E3 retry semantics:
 *   - no receipt       → insert `pending`, run the side effect, mark `done` on success.
 *   - `done` receipt   → return "existing" WITHOUT re-running (redelivery is a no-op).
 *   - `pending` receipt→ a prior delivery did not complete (sink failure or crash): re-run it, and on
 *                        failure the receipt STAYS `pending` for the E3 delivery retry to resume.
 */
export function runOnce(db: DatabaseClient, input: RunOnceInput): Effect.Effect<RunOnceResult, ConsumerReceiptError> {
  return Effect.gen(function* () {
    if (!input.consumerKind || input.consumerKind.length === 0) {
      return yield* fail("invalid_input", input.consumerKind, input.sourceEventId, "consumerKind must be a non-empty string")
    }
    if (!input.sourceEventId || input.sourceEventId.length === 0) {
      return yield* fail("invalid_input", input.consumerKind, input.sourceEventId, "sourceEventId must be a non-empty string")
    }

    const existing = yield* receiptFor(db, input.consumerKind, input.sourceEventId)
    // Redelivery of an already-completed side effect: return the durable receipt, run NOTHING again.
    if (existing?.status === "done") {
      return { kind: "existing", receipt: existing }
    }
    if (existing?.status === "dead") {
      return yield* fail("invalid_input", input.consumerKind, input.sourceEventId, "terminal dead receipt cannot run a side effect")
    }

    // First delivery → start a fresh pending receipt; retry → keep the existing pending row.
    if (!existing) {
      yield* db
        .insert(ConsumerReceiptTable)
        .values([
          {
            consumer_kind: input.consumerKind,
            source_event_id: input.sourceEventId,
            status: "pending",
            attempts: 1,
            last_error: null,
            receipt_ref: null,
            created_at: input.now,
            updated_at: input.now,
            resolved_at: null,
          },
        ])
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    } else {
      yield* db
        .update(ConsumerReceiptTable)
        .set({ attempts: existing.attempts + 1, updated_at: input.now })
        .where(and(eq(ConsumerReceiptTable.consumer_kind, input.consumerKind), eq(ConsumerReceiptTable.source_event_id, input.sourceEventId)))
        .run()
        .pipe(Effect.orDie)
    }

    // Run the side effect; on success persist `done`, on failure keep the receipt `pending` (E3 retry).
    const outcome = yield* input.sideEffect.pipe(Effect.exit)
    if (outcome._tag === "Failure") {
      const message = (Cause.squash(outcome.cause) as { message?: string } | undefined)?.message ?? "consumer sink failed"
      yield* db
        .update(ConsumerReceiptTable)
        .set({ status: "pending", last_error: message, updated_at: input.now })
        .where(and(eq(ConsumerReceiptTable.consumer_kind, input.consumerKind), eq(ConsumerReceiptTable.source_event_id, input.sourceEventId)))
        .run()
        .pipe(Effect.orDie)
      return yield* fail("sink_failed", input.consumerKind, input.sourceEventId, message)
    }

    yield* db
      .update(ConsumerReceiptTable)
      .set({
        status: "done",
        receipt_ref: receiptRefFor(input.consumerKind, input.sourceEventId),
        resolved_at: input.now,
        last_error: null,
        updated_at: input.now,
      })
      .where(and(eq(ConsumerReceiptTable.consumer_kind, input.consumerKind), eq(ConsumerReceiptTable.source_event_id, input.sourceEventId)))
      .run()
      .pipe(Effect.orDie)

    const receipt = yield* receiptFor(db, input.consumerKind, input.sourceEventId)
    return { kind: "executed", receipt: receipt! }
  })
}

/** Bounded repair scan for crash windows after a spool row dead-letters but before its receipt lands. */
export function deadSpoolWithoutReceipt(db: DatabaseClient, consumerKind: ConsumerKind, limit: number) {
  return db
    .select({ eventRef: DeepAgentEventSpoolTable.event_ref })
    .from(DeepAgentEventSpoolTable)
    .leftJoin(
      ConsumerReceiptTable,
      and(
        eq(ConsumerReceiptTable.consumer_kind, consumerKind),
        eq(ConsumerReceiptTable.source_event_id, DeepAgentEventSpoolTable.event_ref),
      ),
    )
    .where(
      and(
        eq(DeepAgentEventSpoolTable.status, "dead"),
        or(isNull(ConsumerReceiptTable.status), ne(ConsumerReceiptTable.status, "dead")),
      ),
    )
    .orderBy(DeepAgentEventSpoolTable.updated_at)
    .limit(Math.max(1, limit))
    .all()
    .pipe(Effect.orDie)
}

/** Mirror a durable dead spool state as a terminal receipt, preserving its real attempt count. */
export function recordDeadSpool(db: DatabaseClient, consumerKind: ConsumerKind, sourceEventId: string) {
  return db.transaction(
    () => Effect.gen(function* () {
      const spool = yield* db
        .select()
        .from(DeepAgentEventSpoolTable)
        .where(eq(DeepAgentEventSpoolTable.event_ref, sourceEventId))
        .get()
        .pipe(Effect.orDie)
      if (spool?.status !== "dead")
        return yield* fail("invalid_input", consumerKind, sourceEventId, "spool row is not dead")
      yield* db
        .insert(ConsumerReceiptTable)
        .values({
          consumer_kind: consumerKind,
          source_event_id: sourceEventId,
          status: "dead",
          attempts: spool.attempts,
          last_error: spool.last_error,
          receipt_ref: null,
          created_at: spool.updated_at,
          updated_at: spool.updated_at,
          resolved_at: spool.updated_at,
        })
        .onConflictDoUpdate({
          target: [ConsumerReceiptTable.consumer_kind, ConsumerReceiptTable.source_event_id],
          set: {
            status: "dead",
            attempts: spool.attempts,
            last_error: spool.last_error,
            receipt_ref: null,
            updated_at: spool.updated_at,
            resolved_at: spool.updated_at,
          },
          setWhere: ne(ConsumerReceiptTable.status, "done"),
        })
        .run()
        .pipe(Effect.orDie)
      const receipt = yield* receiptFor(db, consumerKind, sourceEventId)
      if (receipt?.status !== "dead")
        return yield* fail("invalid_input", consumerKind, sourceEventId, "receipt conflicts with terminal spool row")
      return receipt
    }),
    { behavior: "immediate" },
  )
}
