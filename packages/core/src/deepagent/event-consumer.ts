export * as EventConsumer from "./event-consumer"

import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import {
  DeepAgentEventConsumerTable,
  DeepAgentEventConsumerDeliveryTable,
  type EventConsumerDeliveryStatus,
} from "./event-consumer-sql"
import { DeepAgentEventOutboxTable } from "./event-outbox-sql"

// C5-06 — CONSUMER durable registration + claim/lease + retry/DLQ/retention hardening.
// Design authority: docs/core-v2.0-beta/design.md §8.6
//   - consumer group 在 producer 之前 durable register  → consumer registration table + typed refusal.
//   - claim token/lease fencing, stale worker 不能 ack/nack → claimDue + fenced commitResult/nack.
//   - retry 有界，DLQ 不递归 → bounded attempts -> `dead` (terminal), never re-enqueued.
//   - retention 不删除 pending delivery → sweep only deletes `resolved` rows past the window.
//
// This is the CONSUMER side of the C5 cross-aggregate outbox (C5-02). The outbox publisher owns the
// producer claim/lease (enqueue -> claimDue -> dispatch -> markPublished/markFailed); this module owns
// the per-consumer DELIVERY state on top of the same published outbox rows. The two layers never share
// a claim token: the outbox publisher settles a row (publishing -> published), then a registered
// consumer schedules + claims a delivery for that same, now-published event.
//
// INVARIANTS enforced here:
//   1. ONLY a durably registered consumer can receive/claim work (typed `unregistered_consumer`).
//   2. Re-registration is idempotent (same contract version refreshes); a DIFFERENT version is a typed
//      `contract_version_conflict` (fail-closed reject — never a silent supersede).
//   3. Producer-before-consumer: a delivery can only be scheduled/claimed for an outbox row that is
//      already `published` (typed `not_yet_publishable` otherwise).
//   4. Claim fencing: commitResult/nack only win under the claim token they were issued; a stale token
//      (row re-claimed after lease expiry) is a fenced no-op. An expired lease revives the row as
//      pending so an in-flight crash can never lose the message (at-least-once).
//   5. Retry counter persists durably: `attempts` increments on nack ONLY (a claim is not a failure),
//      so a crash mid-process resumes at the SAME attempt count.
//   6. Bounded retry -> `dead` (DLQ) past maxAttempts. A `dead` row is terminal: it can never be
//      nacked or re-scheduled (typed `dlq_terminal` — DLQ 不递归).
//   7. Retention sweep deletes ONLY `resolved` rows older than the keep window; it never touches
//      pending/claimed/dead rows, and is idempotent + bounded.
//
// LAYERING: `core`. No runtime / session / LSP imports.

type DatabaseClient = Database.Interface["db"]

/** Default max consumer delivery attempts before dead-lettering (§8.6 重试有界). */
export const DEFAULT_MAX_ATTEMPTS = 5
/** Default backoff base (ms) for the retry schedule: delay = base * 2^(attempts-1). */
export const DEFAULT_BACKOFF_BASE_MS = 1000
/** Default retention keep window for resolved deliveries (14 days) — the only rows a sweep removes. */
export const DEFAULT_RETENTION_KEEP_MS = 14 * 24 * 60 * 60 * 1000

/** A durable consumer registration row (consumer key + frozen delivery contract version). */
export type ConsumerRow = {
  readonly consumerKey: string
  readonly deliveryContractVersion: string
  readonly registeredAt: number
  readonly updatedAt: number
}

/** A consumer-side delivery tracker row for a single (outbox event, consumer). */
export type DeliveryRow = {
  readonly outboxId: string
  readonly consumerKey: string
  readonly status: EventConsumerDeliveryStatus
  readonly attempts: number
  readonly lastError?: string
  readonly nextAttemptAt?: number
  readonly claimToken?: string
  readonly claimantId?: string
  readonly claimedAt?: number
  readonly leaseExpiresAt?: number
  readonly resolvedAt?: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Why a consumer operation was refused. Fail-closed; each reason is a typed refusal. */
export type ConsumerErrorReason =
  | "unregistered_consumer"
  | "contract_version_conflict"
  | "contract_version_mismatch"
  | "not_yet_publishable"
  | "dlq_terminal"
  | "already_resolved"

/** Typed error thrown via the Effect failure channel for a consumer refusal (never a buried throw). */
export class ConsumerError extends Error {
  readonly _tag = "EventConsumer.ConsumerError"
  readonly reason: ConsumerErrorReason
  readonly consumerKey: string
  constructor(reason: ConsumerErrorReason, consumerKey: string, message: string) {
    super(message)
    this.name = "ConsumerError"
    this.reason = reason
    this.consumerKey = consumerKey
  }
}

const decodeConsumer = (row: typeof DeepAgentEventConsumerTable.$inferSelect): ConsumerRow => ({
  consumerKey: row.consumer_key,
  deliveryContractVersion: row.delivery_contract_version,
  registeredAt: row.registered_at,
  updatedAt: row.updated_at,
})

const decodeDelivery = (row: typeof DeepAgentEventConsumerDeliveryTable.$inferSelect): DeliveryRow => ({
  outboxId: row.outbox_id,
  consumerKey: row.consumer_key,
  status: row.status,
  attempts: row.attempts,
  ...(row.last_error != null ? { lastError: row.last_error } : {}),
  ...(row.next_attempt_at != null ? { nextAttemptAt: row.next_attempt_at } : {}),
  ...(row.claim_token != null ? { claimToken: row.claim_token } : {}),
  ...(row.claimant_id != null ? { claimantId: row.claimant_id } : {}),
  ...(row.claimed_at != null ? { claimedAt: row.claimed_at } : {}),
  ...(row.lease_expires_at != null ? { leaseExpiresAt: row.lease_expires_at } : {}),
  ...(row.resolved_at != null ? { resolvedAt: row.resolved_at } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const refuse = <E>(reason: ConsumerErrorReason, consumerKey: string, message: string) =>
  Effect.fail(new ConsumerError(reason, consumerKey, message))

function requireConsumer(db: DatabaseClient, consumerKey: string): Effect.Effect<ConsumerRow, ConsumerError> {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(DeepAgentEventConsumerTable)
      .where(eq(DeepAgentEventConsumerTable.consumer_key, consumerKey))
      .get()
      .pipe(Effect.orDie)
    if (!row) {
      return yield* refuse(
        "unregistered_consumer",
        consumerKey,
        `consumer "${consumerKey}" is not durably registered; unregistered consumers cannot claim or receive deliveries`,
      )
    }
    return decodeConsumer(row)
  })
}

function getDelivery(db: DatabaseClient, outboxId: string, consumerKey: string): Effect.Effect<DeliveryRow | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(DeepAgentEventConsumerDeliveryTable)
      .where(
        and(
          eq(DeepAgentEventConsumerDeliveryTable.outbox_id, outboxId),
          eq(DeepAgentEventConsumerDeliveryTable.consumer_key, consumerKey),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    return row ? decodeDelivery(row) : undefined
  })
}

function outboxPublishStatus(db: DatabaseClient, outboxId: string): Effect.Effect<string | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select({ status: DeepAgentEventOutboxTable.status })
      .from(DeepAgentEventOutboxTable)
      .where(eq(DeepAgentEventOutboxTable.outbox_id, outboxId))
      .get()
      .pipe(Effect.orDie)
    return row?.status
  })
}

export interface RegisterInput {
  readonly consumerKey: string
  readonly deliveryContractVersion: string
  readonly now: number
}

/**
 * §8.6 — durably register a consumer, BEFORE any producer publishes work it will consume.
 *
 * IDEMPOTENT: re-registering the SAME key with the SAME contract version refreshes `updated_at` and
 * never duplicates a row. A DIFFERENT contract version for an already-registered key is a typed
 * `contract_version_conflict` — we REJECT (fail-closed) rather than silently supersede, because a
 * consumer changing its delivery contract mid-stream is a programming error and any implicit invalidation
 * of in-flight deliveries would be a data-integrity hazard.
 */
export function register(db: DatabaseClient, input: RegisterInput): Effect.Effect<ConsumerRow, ConsumerError> {
  return Effect.gen(function* () {
    const existing = yield* db
      .select()
      .from(DeepAgentEventConsumerTable)
      .where(eq(DeepAgentEventConsumerTable.consumer_key, input.consumerKey))
      .get()
      .pipe(Effect.orDie)
    if (existing) {
      if (existing.delivery_contract_version !== input.deliveryContractVersion) {
        return yield* refuse(
          "contract_version_conflict",
          input.consumerKey,
          `consumer "${input.consumerKey}" is already registered with delivery contract version "${existing.delivery_contract_version}" (attempted "${input.deliveryContractVersion}"); refusing to supersede`,
        )
      }
      // Same (key, version): idempotent refresh. Never a second row.
      yield* db
        .update(DeepAgentEventConsumerTable)
        .set({ updated_at: input.now })
        .where(eq(DeepAgentEventConsumerTable.consumer_key, input.consumerKey))
        .run()
        .pipe(Effect.orDie)
      const refreshed = yield* db
        .select()
        .from(DeepAgentEventConsumerTable)
        .where(eq(DeepAgentEventConsumerTable.consumer_key, input.consumerKey))
        .get()
        .pipe(Effect.orDie)
      if (!refreshed) throw new Error(`consumer "${input.consumerKey}" vanished during a re-registration refresh`)
      return decodeConsumer(refreshed)
    }
    const inserted = yield* db
      .insert(DeepAgentEventConsumerTable)
      .values({
        consumer_key: input.consumerKey,
        delivery_contract_version: input.deliveryContractVersion,
        registered_at: input.now,
        updated_at: input.now,
      })
      .onConflictDoNothing({ target: DeepAgentEventConsumerTable.consumer_key })
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (!inserted) {
      // Racing duplicate landed between the read-check and the insert; preserve the winner.
      const winner = yield* db
        .select()
        .from(DeepAgentEventConsumerTable)
        .where(eq(DeepAgentEventConsumerTable.consumer_key, input.consumerKey))
        .get()
        .pipe(Effect.orDie)
      if (!winner) throw new Error("consumer registration lost the idempotency race with no surviving row")
      if (winner.delivery_contract_version !== input.deliveryContractVersion) {
        return yield* refuse(
          "contract_version_conflict",
          input.consumerKey,
          `consumer "${input.consumerKey}" was concurrently registered with delivery contract version "${winner.delivery_contract_version}"`,
        )
      }
      return decodeConsumer(winner)
    }
    return decodeConsumer(inserted)
  })
}

export function getConsumer(db: DatabaseClient, consumerKey: string): Effect.Effect<ConsumerRow | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(DeepAgentEventConsumerTable)
      .where(eq(DeepAgentEventConsumerTable.consumer_key, consumerKey))
      .get()
      .pipe(Effect.orDie)
    return row ? decodeConsumer(row) : undefined
  })
}

export interface ScheduleInput {
  readonly outboxId: string
  readonly consumerKey: string
  readonly now: number
}

/**
 * §8.6 — durably assign a published outbox event to a registered consumer, recording a `pending`
 * delivery row. This is the CONSUMER'S producer-before-consumer gate: a consumer cannot be handed an
 * event whose producer transaction has NOT committed (the outbox row is not yet `published`).
 *
 * Idempotent: an existing pending/claimed delivery is returned unchanged. A `resolved` delivery is a
 * typed `already_resolved` refuse (the work is done); a `dead` delivery is a typed `dlq_terminal`
 * refuse (DLQ 不递归 — a dead-lettered message can never be re-enqueued).
 */
export function schedule(db: DatabaseClient, input: ScheduleInput): Effect.Effect<DeliveryRow, ConsumerError> {
  return Effect.gen(function* () {
    yield* requireConsumer(db, input.consumerKey)
    const outboxStatus = yield* outboxPublishStatus(db, input.outboxId)
    if (outboxStatus !== "published") {
      return yield* refuse(
        "not_yet_publishable",
        input.consumerKey,
        `outbox row "${input.outboxId}" is "${outboxStatus ?? "missing"}"; a consumer cannot process an event whose producer transaction has not committed (design §8.6 producer-before-consumer)`,
      )
    }
    const existing = yield* getDelivery(db, input.outboxId, input.consumerKey)
    if (existing) {
      if (existing.status === "dead") {
        return yield* refuse(
          "dlq_terminal",
          input.consumerKey,
          `delivery for outbox "${input.outboxId}" on consumer "${input.consumerKey}" is dead-lettered (terminal); a DLQ message can never be re-enqueued (设计 §8.6 DLQ 不递归)`,
        )
      }
      if (existing.status === "resolved") {
        return yield* refuse(
          "already_resolved",
          input.consumerKey,
          `delivery for outbox "${input.outboxId}" on consumer "${input.consumerKey}" is already resolved`,
        )
      }
      return existing
    }
    const inserted = yield* db
      .insert(DeepAgentEventConsumerDeliveryTable)
      .values({
        outbox_id: input.outboxId,
        consumer_key: input.consumerKey,
        status: "pending" as const,
        attempts: 0,
        last_error: null,
        next_attempt_at: null,
        claim_token: null,
        claimant_id: null,
        claimed_at: null,
        lease_expires_at: null,
        resolved_at: null,
        created_at: input.now,
        updated_at: input.now,
      })
      .returning()
      .get()
      .pipe(Effect.orDie)
    return decodeDelivery(inserted)
  })
}

export interface ClaimDueInput {
  readonly consumerKey: string
  /** Optional contract version the caller operates under; a mismatch is a typed refusal. */
  readonly contractVersion?: string
  readonly claimantId: string
  readonly now: number
  readonly leaseMs: number
  readonly limit: number
}

export type ClaimDueResult = {
  readonly claimToken: string
  readonly deliveries: ReadonlyArray<DeliveryRow>
}

/**
 * §8.6 — atomically claim a batch of due deliveries for ONE registered consumer under a fresh lease.
 * Due = a `pending` row whose retry backoff has elapsed (or a fresh delivery), OR a `claimed` row whose
 * lease has EXPIRED (crash recovery revival — the in-flight row is re-claimed, never lost).
 *
 * FENCING: live-leased rows are excluded. PRODUCER-BEFORE-CONSUMER: every candidate's outbox row must
 * be `published` — a consumer can never process an event whose producer transaction has not committed
 * (typed `not_yet_publishable` if the invariant is ever violated).
 */
export function claimDue(db: DatabaseClient, input: ClaimDueInput): Effect.Effect<ClaimDueResult, ConsumerError> {
  return Effect.gen(function* () {
    const consumer = yield* requireConsumer(db, input.consumerKey)
    if (input.contractVersion != null && input.contractVersion !== consumer.deliveryContractVersion) {
      return yield* refuse(
        "contract_version_mismatch",
        input.consumerKey,
        `consumer "${input.consumerKey}" is registered with delivery contract version "${consumer.deliveryContractVersion}" but is claiming as "${input.contractVersion}"`,
      )
    }
    const due = yield* db
      .select()
      .from(DeepAgentEventConsumerDeliveryTable)
      .where(
        and(
          eq(DeepAgentEventConsumerDeliveryTable.consumer_key, input.consumerKey),
          or(
            and(
              eq(DeepAgentEventConsumerDeliveryTable.status, "pending"),
              or(
                isNull(DeepAgentEventConsumerDeliveryTable.next_attempt_at),
                lte(DeepAgentEventConsumerDeliveryTable.next_attempt_at, input.now),
              ),
            ),
            and(
              eq(DeepAgentEventConsumerDeliveryTable.status, "claimed"),
              and(
                isNotNull(DeepAgentEventConsumerDeliveryTable.lease_expires_at),
                lte(DeepAgentEventConsumerDeliveryTable.lease_expires_at, input.now),
              ),
            ),
          ),
        ),
      )
      .orderBy(DeepAgentEventConsumerDeliveryTable.created_at)
      .limit(input.limit)
      .all()
      .pipe(Effect.orDie)
    if (due.length === 0) return { claimToken: "", deliveries: [] }

    // Producer-before-consumer: verify every candidate's producer transaction has committed. A claim
    // is all-or-nothing — failing one candidate fails the batch (the invariant is global).
    for (const row of due) {
      const status = yield* outboxPublishStatus(db, row.outbox_id)
      if (status !== "published") {
        return yield* refuse(
          "not_yet_publishable",
          input.consumerKey,
          `outbox row "${row.outbox_id}" is "${status ?? "missing"}"; a consumer cannot process an event whose producer transaction has not committed`,
        )
      }
    }

    const claimToken = `consumerclaim_${input.consumerKey}_${input.claimantId}_${input.now}`
    for (const row of due) {
      yield* db
        .update(DeepAgentEventConsumerDeliveryTable)
        .set({
          status: "claimed" as const,
          claim_token: claimToken,
          claimant_id: input.claimantId,
          claimed_at: input.now,
          lease_expires_at: input.now + input.leaseMs,
          updated_at: input.now,
        })
        .where(
          and(
            eq(DeepAgentEventConsumerDeliveryTable.outbox_id, row.outbox_id),
            eq(DeepAgentEventConsumerDeliveryTable.consumer_key, row.consumer_key),
            eq(DeepAgentEventConsumerDeliveryTable.status, row.status),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    // Return the POST-claim view so the caller settles with the token it was just issued.
    return {
      claimToken,
      deliveries: due.map((row): DeliveryRow => ({
        ...decodeDelivery(row),
        status: "claimed",
        claimToken,
        claimantId: input.claimantId,
        claimedAt: input.now,
        leaseExpiresAt: input.now + input.leaseMs,
      })),
    }
  })
}

export interface CommitInput {
  readonly outboxId: string
  readonly consumerKey: string
  readonly claimToken: string
  readonly now: number
}

/**
 * §8.6 — a consumer commits a claimed delivery as `resolved` (acked). FENCED: only a row still held by
 * the matching claim token in the `claimed` state flips to `resolved`. A stale token (the row was
 * re-claimed after lease expiry by another claimant) is a no-op → `false` and does NOT touch the row.
 */
export function commitResult(db: DatabaseClient, input: CommitInput): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const updated = yield* db
      .update(DeepAgentEventConsumerDeliveryTable)
      .set({
        status: "resolved" as const,
        resolved_at: input.now,
        claim_token: null,
        claimant_id: null,
        claimed_at: null,
        lease_expires_at: null,
        updated_at: input.now,
      })
      .where(
        and(
          eq(DeepAgentEventConsumerDeliveryTable.outbox_id, input.outboxId),
          eq(DeepAgentEventConsumerDeliveryTable.consumer_key, input.consumerKey),
          eq(DeepAgentEventConsumerDeliveryTable.claim_token, input.claimToken),
          eq(DeepAgentEventConsumerDeliveryTable.status, "claimed"),
        ),
      )
      .returning({ outbox_id: DeepAgentEventConsumerDeliveryTable.outbox_id })
      .all()
      .pipe(Effect.orDie)
    return updated.length > 0
  })
}

export interface NackInput {
  readonly outboxId: string
  readonly consumerKey: string
  readonly claimToken: string
  readonly reason: string
  readonly now: number
  readonly maxAttempts?: number
  readonly backoffBaseMs?: number
}

/**
 * §8.6 — record a consumer delivery failure. FENCED on `claimToken`: a stale claim is a no-op → `false`.
 * A `dead` (DLQ) row can NEVER be nacked — that is a typed `dlq_terminal` refusal (DLQ 不递归). After a
 * valid failure the attempt counter increments; if the budget is exhausted the row flips to `dead`
 * (DLQ, terminal), otherwise it returns to `pending` with an exponential backoff
 * (base * 2^(attempts-1)) so the retry pump re-claims it later. The counter lives in the row, so a
 * crash mid-retry resumes at the SAME attempt count.
 */
export function nack(db: DatabaseClient, input: NackInput): Effect.Effect<boolean, ConsumerError> {
  return Effect.gen(function* () {
    const row = yield* getDelivery(db, input.outboxId, input.consumerKey)
    if (!row) return false
    if (row.status === "dead") {
      return yield* refuse(
        "dlq_terminal",
        input.consumerKey,
        `delivery for outbox "${input.outboxId}" on consumer "${input.consumerKey}" is dead-lettered (terminal); a DLQ message cannot be re-enqueued or retried (设计 §8.6 DLQ 不递归)`,
      )
    }
    if (row.status !== "claimed" || row.claimToken !== input.claimToken) return false
    const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    const attempts = row.attempts + 1
    if (attempts >= maxAttempts) {
      yield* db
        .update(DeepAgentEventConsumerDeliveryTable)
        .set({
          status: "dead" as const,
          attempts,
          last_error: input.reason,
          claim_token: null,
          claimant_id: null,
          claimed_at: null,
          lease_expires_at: null,
          updated_at: input.now,
        })
        .where(
          and(
            eq(DeepAgentEventConsumerDeliveryTable.outbox_id, input.outboxId),
            eq(DeepAgentEventConsumerDeliveryTable.consumer_key, input.consumerKey),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      return true
    }
    const backoffBaseMs = input.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
    const nextAttemptAt = input.now + backoffBaseMs * Math.pow(2, attempts - 1)
    yield* db
      .update(DeepAgentEventConsumerDeliveryTable)
      .set({
        status: "pending" as const,
        attempts,
        last_error: input.reason,
        next_attempt_at: nextAttemptAt,
        claim_token: null,
        claimant_id: null,
        claimed_at: null,
        lease_expires_at: null,
        updated_at: input.now,
      })
      .where(
        and(
          eq(DeepAgentEventConsumerDeliveryTable.outbox_id, input.outboxId),
          eq(DeepAgentEventConsumerDeliveryTable.consumer_key, input.consumerKey),
        ),
      )
      .run()
      .pipe(Effect.orDie)
    return true
  })
}

export interface SweepInput {
  readonly now: number
  /** Keep resolved deliveries for this long (ms); defaults to 14 days. */
  readonly keepMs?: number
  /** Max resolved rows to delete in one sweep (bounded). */
  readonly limit?: number
}

/**
 * §8.6 — the retention sweep. Deletes ONLY `resolved` deliveries whose `resolved_at` is older than the
 * keep window. It NEVER touches `pending`, `claimed`, or `dead` (DLQ) rows — an unacked or dead-lettered
 * delivery is still owed to a human/operator and must survive. Idempotent (deleting an already-deleted
 * row is a no-op) and bounded by `limit`.
 */
export function sweep(db: DatabaseClient, input: SweepInput): Effect.Effect<{ readonly deleted: number }> {
  return Effect.gen(function* () {
    const keepMs = input.keepMs ?? DEFAULT_RETENTION_KEEP_MS
    const limit = input.limit ?? 1000
    const cutoff = input.now - keepMs
    const doomed = yield* db
      .select({ outbox_id: DeepAgentEventConsumerDeliveryTable.outbox_id, consumer_key: DeepAgentEventConsumerDeliveryTable.consumer_key })
      .from(DeepAgentEventConsumerDeliveryTable)
      .where(
        and(
          eq(DeepAgentEventConsumerDeliveryTable.status, "resolved"),
          lte(DeepAgentEventConsumerDeliveryTable.resolved_at, cutoff),
        ),
      )
      .limit(limit)
      .all()
      .pipe(Effect.orDie)
    for (const row of doomed) {
      yield* db
        .delete(DeepAgentEventConsumerDeliveryTable)
        .where(
          and(
            eq(DeepAgentEventConsumerDeliveryTable.outbox_id, row.outbox_id),
            eq(DeepAgentEventConsumerDeliveryTable.consumer_key, row.consumer_key),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    return { deleted: doomed.length }
  })
}

/** §8.6 — DLQ view: all dead-lettered consumer deliveries (terminal, never re-dispatched by default). */
export function deadMessages(db: DatabaseClient, consumerKey?: string): Effect.Effect<ReadonlyArray<DeliveryRow>> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(DeepAgentEventConsumerDeliveryTable)
      .where(
        and(
          eq(DeepAgentEventConsumerDeliveryTable.status, "dead"),
          consumerKey != null
            ? eq(DeepAgentEventConsumerDeliveryTable.consumer_key, consumerKey)
            : isNotNull(DeepAgentEventConsumerDeliveryTable.consumer_key),
        ),
      )
      .orderBy(DeepAgentEventConsumerDeliveryTable.updated_at)
      .all()
      .pipe(Effect.orDie)
    return rows.map(decodeDelivery)
  })
}

/** §8.6 — the durable in-flight/pending backlog depth for a consumer (non-terminal rows). */
export function pendingCount(db: DatabaseClient, consumerKey: string): Effect.Effect<number> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ outbox_id: DeepAgentEventConsumerDeliveryTable.outbox_id })
      .from(DeepAgentEventConsumerDeliveryTable)
      .where(
        and(
          eq(DeepAgentEventConsumerDeliveryTable.consumer_key, consumerKey),
          or(
            eq(DeepAgentEventConsumerDeliveryTable.status, "pending"),
            eq(DeepAgentEventConsumerDeliveryTable.status, "claimed"),
          ),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    return rows.length
  })
}

export function getByDelivery(db: DatabaseClient, outboxId: string, consumerKey: string): Effect.Effect<DeliveryRow | undefined> {
  return getDelivery(db, outboxId, consumerKey)
}
