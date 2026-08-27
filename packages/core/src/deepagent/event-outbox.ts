export * as EventOutbox from "./event-outbox"

import { and, eq, isNull, lte, or } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import {
  type EventEnvelope,
  decodeEventEnvelope,
  encodeEventEnvelope,
  eventEnvelopeDigest,
} from "../contract/event-envelope"
import {
  EventRegistry,
  type EventRegistry as Registry,
  type RegisteredEventEnvelope,
  validatePublish,
} from "./event-registry"
import { DeepAgentEventOutboxTable, type EventOutboxStatus } from "./event-outbox-sql"

// C5-02 — cross-aggregate TRANSACTIONAL OUTBOX + publisher claim/lease.
// Design authority: docs/core-v2.0-beta/design.md §8.3.
//
// Invariants enforced here:
//   1. A cross-aggregate event may ONLY be created through `enqueue`, which FAILS CLOSED on any
//      envelope the registry has not validated (design §8.8: no arbitrary type may self-authorize).
//   2. The outbox row is written in the SAME transaction as the aggregate state change — the CALLER
//      wraps `enqueue` (or `enqueueIn`) together with its aggregate write in one `db.transaction`.
//      `enqueue` itself is a single idempotent insert that participates in the ambient transaction.
//   3. Only the outbox publisher dispatches events, from rows it has CLAIMED under a lease. This is a
//      normal/publishing row transition (crash-safe): a row still held by a live lease can never be
//      double-dispatched (claim fencing), and an interrupted dispatch is re-claimed after lease expiry
//      and re-dispatched under the SAME idempotency key (at-least-once, exact-republish semantics).
//
// LAYERING: `core`. No runtime / session / LSP imports.

type DatabaseClient = Database.Interface["db"]

/** The outbox ledger row, as read from the DB. */
export type OutboxRow = {
  readonly outboxId: string
  readonly eventId: string
  readonly eventType: string
  readonly eventKind: "command" | "fact" | "observation"
  readonly aggregateType: string
  readonly aggregateId: string
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly envelope: EventEnvelope
  readonly envelopeDigest: string
  readonly status: EventOutboxStatus
  readonly claimToken?: string
  readonly claimantId?: string
  readonly claimedAt?: number
  readonly leaseExpiresAt?: number
  readonly attemptCount: number
  readonly publishedAt?: number
  readonly lastError?: string
  readonly createdAt: number
  readonly updatedAt: number
}

const decodeRow = (row: typeof DeepAgentEventOutboxTable.$inferSelect): OutboxRow => ({
  outboxId: row.outbox_id,
  eventId: row.event_id,
  eventType: row.event_type,
  eventKind: row.event_kind,
  aggregateType: row.aggregate_type,
  aggregateId: row.aggregate_id,
  correlationId: row.correlation_id,
  idempotencyKey: row.idempotency_key,
  envelope: decodeEventEnvelope(JSON.parse(row.envelope_json) as unknown),
  envelopeDigest: row.envelope_digest,
  status: row.status,
  ...(row.claim_token != null ? { claimToken: row.claim_token } : {}),
  ...(row.claimant_id != null ? { claimantId: row.claimant_id } : {}),
  ...(row.claimed_at != null ? { claimedAt: row.claimed_at } : {}),
  ...(row.lease_expires_at != null ? { leaseExpiresAt: row.lease_expires_at } : {}),
  attemptCount: row.attempt_count,
  ...(row.published_at != null ? { publishedAt: row.published_at } : {}),
  ...(row.last_error != null ? { lastError: row.last_error } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export interface EnqueueInput {
  readonly registry: Registry
  /** A registry-validated envelope (see `EventRegistry.assertPublishable`). Re-validated here, fail-closed. */
  readonly event: RegisteredEventEnvelope
  readonly aggregateType: string
  readonly aggregateId: string
  readonly now: number
}

const outboxId = (now: number, eventId: string) => `outbox_${eventId}_${now}`

/**
 * §8.3 — write a durable outbox row for a cross-aggregate event. Fail-closed on any unregistered or
 * disallowed envelope. Idempotent on `idempotency_key`: re-enqueueing the same key returns the
 * existing row (a duplicate is a no-op, never a second dispatch).
 *
 * This is a single INSERT (atomic by itself) used INSIDE a caller's `db.transaction` so aggregate
 * state + event commit together. When called standalone it still returns an idempotent row.
 */
export function enqueue(db: DatabaseClient, input: EnqueueInput): Effect.Effect<OutboxRow, EventRegistry.EventPublishError> {
  return Effect.gen(function* () {
    // Defense in depth: the outbox never accepts an envelope the publisher policy has NOT approved.
    // This is the 拒绝 (rejection) path — a typed failure (never a buried throw or a silent drop).
    const verdict = validatePublish(input.registry, input.event)
    if (!verdict.ok) {
      return yield* Effect.fail(new EventRegistry.EventPublishError(verdict.reason, input.event.eventType, verdict.message))
    }
    const json = JSON.stringify(encodeEventEnvelope(input.event))
    const digest = eventEnvelopeDigest(input.event)
    const existing = yield* db
      .select()
      .from(DeepAgentEventOutboxTable)
      .where(eq(DeepAgentEventOutboxTable.idempotency_key, input.event.idempotencyKey))
      .get()
      .pipe(Effect.orDie)
    if (existing) return decodeRow(existing)

    const inserted = yield* db
      .insert(DeepAgentEventOutboxTable)
      .values({
        outbox_id: outboxId(input.now, input.event.eventId),
        event_id: input.event.eventId,
        event_type: input.event.eventType,
        event_kind: input.event.kind,
        aggregate_type: input.aggregateType,
        aggregate_id: input.aggregateId,
        correlation_id: input.event.correlation.correlationId,
        idempotency_key: input.event.idempotencyKey,
        envelope_json: json,
        envelope_digest: digest,
        status: "pending" as const,
        claim_token: null,
        claimant_id: null,
        claimed_at: null,
        lease_expires_at: null,
        attempt_count: 0,
        published_at: null,
        last_error: null,
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflictDoNothing({ target: DeepAgentEventOutboxTable.idempotency_key })
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (!inserted) {
      // Racing duplicate landed between the read-check and the insert; return the winner.
      const winner = yield* db
        .select()
        .from(DeepAgentEventOutboxTable)
        .where(eq(DeepAgentEventOutboxTable.idempotency_key, input.event.idempotencyKey))
        .get()
        .pipe(Effect.orDie)
      if (!winner) throw new Error("outbox enqueue lost the idempotency race with no surviving row")
      return decodeRow(winner)
    }
    return decodeRow(inserted)
  })
}

export interface ClaimDueInput {
  readonly claimantId: string
  readonly now: number
  readonly leaseMs: number
  readonly limit: number
}

export type ClaimDueResult = {
  readonly claimToken: string
  readonly rows: ReadonlyArray<OutboxRow>
}

/**
 * §8.3 — atomically claim due outbox rows under a fresh lease. Claimed rows transition
 * `pending|publishing (expired lease)` → `publishing` with a claim token, owner and lease expiry.
 * A row under a LIVE lease is never re-claimed (claim fencing). An interrupted dispatch (crash with
 * a live lease) becomes re-claimable only after `leaseExpiresAt` (crash recovery).
 */
export function claimDue(db: DatabaseClient, input: ClaimDueInput): Effect.Effect<ClaimDueResult> {
  const claimToken = `claim_${input.claimantId}_${input.now}`
  return Effect.gen(function* () {
    return yield* db
      .transaction(
        () =>
          Effect.gen(function* () {
            const due = yield* db
              .select()
              .from(DeepAgentEventOutboxTable)
              .where(
                and(
                  or(
                    eq(DeepAgentEventOutboxTable.status, "pending"),
                    eq(DeepAgentEventOutboxTable.status, "publishing"),
                  ),
                  or(
                    isNull(DeepAgentEventOutboxTable.lease_expires_at),
                    lte(DeepAgentEventOutboxTable.lease_expires_at, input.now),
                  ),
                ),
              )
              .limit(input.limit)
              .all()
              .pipe(Effect.orDie)
            for (const row of due) {
              yield* db
                .update(DeepAgentEventOutboxTable)
                .set({
                  status: "publishing" as const,
                  claim_token: claimToken,
                  claimant_id: input.claimantId,
                  claimed_at: input.now,
                  lease_expires_at: input.now + input.leaseMs,
                  attempt_count: row.attempt_count + 1,
                  updated_at: input.now,
                })
                .where(
                  and(
                    eq(DeepAgentEventOutboxTable.outbox_id, row.outbox_id),
                    eq(DeepAgentEventOutboxTable.status, row.status),
                  ),
                )
                .run()
                .pipe(Effect.orDie)
            }
            // Return the POST-claim view so the caller settles with the token it was just issued
            // (the pre-update row still carried the stale token / attempt count).
            return due.map((row): OutboxRow => ({
              ...decodeRow(row),
              status: "publishing",
              claimToken,
              claimantId: input.claimantId,
              claimedAt: input.now,
              leaseExpiresAt: input.now + input.leaseMs,
              attemptCount: row.attempt_count + 1,
            }))
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie, Effect.map((rows) => ({ claimToken, rows })))
  })
}

export interface SettleInput {
  readonly outboxId: string
  readonly claimToken: string
  readonly now: number
}

/**
 * §8.3 — mark a claimed row published and clear its claim. FENCED: a stale claim token (the row was
 * re-claimed after lease expiry by another claimant) returns `false` and does NOT touch the row.
 */
export function markPublished(db: DatabaseClient, input: SettleInput): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const updated = yield* db
      .update(DeepAgentEventOutboxTable)
      .set({
        status: "published" as const,
        claim_token: null,
        claimant_id: null,
        claimed_at: null,
        lease_expires_at: null,
        published_at: input.now,
        updated_at: input.now,
      })
      .where(
        and(
          eq(DeepAgentEventOutboxTable.outbox_id, input.outboxId),
          eq(DeepAgentEventOutboxTable.claim_token, input.claimToken),
          eq(DeepAgentEventOutboxTable.status, "publishing"),
        ),
      )
      .returning({ outbox_id: DeepAgentEventOutboxTable.outbox_id })
      .all()
      .pipe(Effect.orDie)
    return updated.length > 0
  })
}

export interface FailInput extends SettleInput {
  readonly reason: string
  readonly maxAttempts: number
}

/**
 * §8.3 — record a failed dispatch. FENCED on `claimToken`. If the attempt budget is exhausted the row
 * flips to `dead` (it will NOT be re-claimed — a dead-lettered outbox row is terminal). Otherwise it
 * returns to `pending` with its claim cleared so it may be re-claimed on a later pump.
 */
export function markFailed(db: DatabaseClient, input: FailInput): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const result = yield* db
      .select()
      .from(DeepAgentEventOutboxTable)
      .where(
        and(
          eq(DeepAgentEventOutboxTable.outbox_id, input.outboxId),
          eq(DeepAgentEventOutboxTable.claim_token, input.claimToken),
          eq(DeepAgentEventOutboxTable.status, "publishing"),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!result) return false
    const dead = result.attempt_count >= input.maxAttempts
    yield* db
      .update(DeepAgentEventOutboxTable)
      .set({
        status: dead ? ("dead" as const) : ("pending" as const),
        claim_token: null,
        claimant_id: null,
        claimed_at: null,
        lease_expires_at: null,
        last_error: input.reason,
        updated_at: input.now,
      })
      .where(eq(DeepAgentEventOutboxTable.outbox_id, input.outboxId))
      .run()
      .pipe(Effect.orDie)
    return true
  })
}

export function getByID(db: DatabaseClient, outboxId: string): Effect.Effect<OutboxRow | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(DeepAgentEventOutboxTable)
      .where(eq(DeepAgentEventOutboxTable.outbox_id, outboxId))
      .get()
      .pipe(Effect.orDie)
    return row ? decodeRow(row) : undefined
  })
}

export function byIdempotencyKey(db: DatabaseClient, key: string): Effect.Effect<OutboxRow | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(DeepAgentEventOutboxTable)
      .where(eq(DeepAgentEventOutboxTable.idempotency_key, key))
      .get()
      .pipe(Effect.orDie)
    return row ? decodeRow(row) : undefined
  })
}

/** All rows currently in a non-terminal state (pending or publishing). */
export function pendingRows(db: DatabaseClient, now: number): Effect.Effect<ReadonlyArray<OutboxRow>> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(DeepAgentEventOutboxTable)
      .where(or(eq(DeepAgentEventOutboxTable.status, "pending"), eq(DeepAgentEventOutboxTable.status, "publishing")))
      .all()
      .pipe(Effect.orDie)
    return rows.map(decodeRow)
  })
}

export interface PublisherInput {
  /** Injected dispatch sink — the ONLY way an outbox event leaves the database (design §8.3). */
  readonly dispatch: (envelope: EventEnvelope) => Effect.Effect<void, unknown>
  readonly claimantId: string
  readonly now: number
  readonly leaseMs: number
  readonly batchSize: number
  readonly maxAttempts: number
}

export type PublisherResult = {
  readonly claimed: number
  readonly published: number
  readonly failed: number
  readonly dead: number
  readonly remainsPending: number
}

/**
 * §8.3 — the outbox publisher pump. Claims a batch of due rows under one lease, dispatches each
 * envelope to the injected sink, then settles (published / failed). A dispatch failure once the
 * attempt budget is exhausted dead-letters the row; otherwise it returns to pending. NO event is
 * dispatched unless it was read from a committed outbox row (nothing bypasses the outbox).
 */
export function publish(db: DatabaseClient, input: PublisherInput): Effect.Effect<PublisherResult> {
  return Effect.gen(function* () {
    const claimed = yield* claimDue(db, {
      claimantId: input.claimantId,
      now: input.now,
      leaseMs: input.leaseMs,
      limit: input.batchSize,
    })
    let published = 0
    let failed = 0
    let dead = 0
    for (const row of claimed.rows) {
      const outcome = yield* input.dispatch(row.envelope).pipe(
        Effect.match({
          onSuccess: () => "published" as const,
          onFailure: () => "failed" as const,
        }),
      )
      if (outcome === "published") {
        const ok = yield* markPublished(db, { outboxId: row.outboxId, claimToken: claimed.claimToken, now: input.now })
        if (ok) published += 1
      } else {
        const ok = yield* markFailed(db, {
          outboxId: row.outboxId,
          claimToken: claimed.claimToken,
          now: input.now,
          reason: "dispatch failed",
          maxAttempts: input.maxAttempts,
        })
        if (ok) failed += 1
      }
    }
    // Recover any rows a previous crash left in publishing with an expired lease was already handled by
    // claimDue above; count what still awaits a future pump after this pass.
    const remains = yield* pendingRows(db, input.now)
    const deadRows = yield* db
      .select({ outbox_id: DeepAgentEventOutboxTable.outbox_id })
      .from(DeepAgentEventOutboxTable)
      .where(eq(DeepAgentEventOutboxTable.status, "dead"))
      .all()
      .pipe(Effect.orDie)
    dead += deadRows.length
    return { claimed: claimed.rows.length, published, failed, dead, remainsPending: remains.length }
  })
}
