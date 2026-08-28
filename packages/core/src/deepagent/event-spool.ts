export * as EventSpool from "./event-spool"

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import {
  decodeEventWorkEnvelope,
  encodeEventWorkEnvelope,
  eventWorkEnvelopeDigest,
  type EventWorkEnvelope,
} from "../contract/event-envelope"
import type { DrainPriority } from "./event-coalescing"
import { DeepAgentEventSpoolTable, type EventSpoolStatus } from "./event-spool-sql"

// C5-07 — DURABLE HIGH/CRITICAL + THROTTLED SPOOL. Design authority:
// docs/core-v2.0-beta/design.md §8.6 (high/critical never lost but bounded concurrency; a storm drains in
// priority order; durable → crash resumes) + §8.4 (priority/backpressure -> durable task admission).
//
// Invariants enforced here:
//   1. An envelope is spooled AT MOST ONCE (keyed by event_ref; an exact re-enqueue is a no-op).
//   2. DRAIN ORDER is critical > high > normal > low (`EventCoalescing.DRAIN_RANK`), FIFO within a class.
//   3. BOUNDED CONCURRENCY: a claim never holds more than `maxConcurrentPerSession` rows for one session
//      simultaneously (default 4) — a storm can never run unbounded in-flight work (§8.6).
//   4. CLAIM/LEASE FENCING + at-least-once: `commitResult`/`nack` only win under the claim token they were
//      issued; an expired lease revives a claimed row (crash recovery — a crash mid-drain resumes the
//      drain). A claim does not increment `attempts`; a nack does (bounded retry -> `dead` DLQ).
//   5. NEVER DROP: a spooled event is only ever `resolved` (committed) or `dead` (DLQ, bounded retries);
//      nothing is silently dropped. A `dead` row is terminal (never re-drained).
//   6. Backlog metrics: `backlog` counts rows per status + priority (the observability surface).
//
// LAYERING: `core`. The envelope is the only model-facing value; the drain hands the caller a bounded
// envelope to admit (via EventAdmission), never a raw payload.

type DatabaseClient = Database.Interface["db"]

/** Default per-session concurrent in-flight cap (§8.6: 不能无限并发). */
export const DEFAULT_MAX_CONCURRENT_PER_SESSION = 4
/** Default claim lease (ms) — a crash with a live lease revives the row only after this elapses. */
export const DEFAULT_LEASE_MS = 5 * 60_000
/** Default bounded retry cap before dead-lettering. */
export const DEFAULT_MAX_ATTEMPTS = 5

// Durable priority ordering for the drain scan: critical(3) > high(2) > normal(1) > low(0), FIFO
// within a class. Mirrors the bus `priorityRank` so the two never disagree on the drain order.
const priorityRank = sql<number>`case ${DeepAgentEventSpoolTable.priority} when 'critical' then 3 when 'high' then 2 when 'normal' then 1 else 0 end`

/** A spool row, as read from the DB. */
export type SpoolRow = {
  readonly eventRef: string
  readonly sessionID: string
  readonly envelopeDigest: string
  readonly envelope: EventWorkEnvelope
  readonly priority: DrainPriority
  readonly status: EventSpoolStatus
  readonly attempts: number
  readonly claimToken?: string
  readonly claimantId?: string
  readonly claimedAt?: number
  readonly leaseExpiresAt?: number
  readonly nextAttemptAt?: number
  readonly lastError?: string
  readonly createdAt: number
  readonly updatedAt: number
}

const decodeRow = (row: typeof DeepAgentEventSpoolTable.$inferSelect): SpoolRow => ({
  eventRef: row.event_ref,
  sessionID: row.session_id,
  envelopeDigest: row.envelope_digest,
  envelope: decodeEventWorkEnvelope(JSON.parse(row.envelope_json) as unknown),
  priority: row.priority as DrainPriority,
  status: row.status as EventSpoolStatus,
  attempts: row.attempts,
  ...(row.claim_token != null ? { claimToken: row.claim_token } : {}),
  ...(row.claimant_id != null ? { claimantId: row.claimant_id } : {}),
  ...(row.claimed_at != null ? { claimedAt: row.claimed_at } : {}),
  ...(row.lease_expires_at != null ? { leaseExpiresAt: row.lease_expires_at } : {}),
  ...(row.next_attempt_at != null ? { nextAttemptAt: row.next_attempt_at } : {}),
  ...(row.last_error != null ? { lastError: row.last_error } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export interface EnqueueInput {
  readonly envelope: EventWorkEnvelope
  readonly sessionID: string
  readonly priority: DrainPriority
  readonly now: number
}

/**
 * §8.6 — durably spool a bounded envelope. IDEMPOTENT on `event_ref`: re-spooling the same envelope
 * returns the existing row (an exact retry is a no-op, never a second queue entry). The bounded envelope
 * (never the raw payload) is stored; the digest binds the spooled work.
 */
export function enqueue(db: DatabaseClient, input: EnqueueInput): Effect.Effect<SpoolRow> {
  return Effect.gen(function* () {
    const digest = eventWorkEnvelopeDigest(input.envelope)
    const existing = yield* db
      .select()
      .from(DeepAgentEventSpoolTable)
      .where(eq(DeepAgentEventSpoolTable.event_ref, input.envelope.eventRef))
      .get()
      .pipe(Effect.orDie)
    if (existing) return decodeRow(existing)
    const inserted = yield* db
      .insert(DeepAgentEventSpoolTable)
      .values({
        event_ref: input.envelope.eventRef,
        session_id: input.sessionID,
        envelope_digest: digest,
        envelope_json: JSON.stringify(encodeEventWorkEnvelope(input.envelope)),
        priority: input.priority,
        status: "pending" as const,
        attempts: 0,
        claim_token: null,
        claimant_id: null,
        claimed_at: null,
        lease_expires_at: null,
        next_attempt_at: null,
        last_error: null,
        created_at: input.now,
        updated_at: input.now,
      })
      .onConflictDoNothing({ target: DeepAgentEventSpoolTable.event_ref })
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (!inserted) {
      const winner = yield* db
        .select()
        .from(DeepAgentEventSpoolTable)
        .where(eq(DeepAgentEventSpoolTable.event_ref, input.envelope.eventRef))
        .get()
        .pipe(Effect.orDie)
      if (!winner) throw new Error("event spool enqueue lost the idempotency race with no surviving row")
      return decodeRow(winner)
    }
    return decodeRow(inserted)
  })
}

export interface ClaimDueInput {
  readonly claimantId: string
  readonly now: number
  readonly leaseMs?: number
  readonly limit?: number
  readonly maxConcurrentPerSession?: number
}

export type ClaimDueResult = {
  readonly claimToken: string
  readonly rows: ReadonlyArray<SpoolRow>
}

/**
 * §8.6 — atomically claim a batch of due spool rows under one fresh lease, ordered by PRIORITY
 * (critical > high > normal > low, FIFO within a class) and bounded by the per-session concurrency cap.
 *
 * Due = `pending` whose backoff has elapsed OR `claimed` whose lease EXPIRED (crash recovery — an
 * in-flight row is revived, never lost). LIVE-leased rows are excluded (claim fencing). The per-session
 * cap (default `DEFAULT_MAX_CONCURRENT_PER_SESSION`, 4) means a storm over a session can never run
 * unbounded in-flight work; across sessions the global `limit` bounds the batch.
 */
export function claimDue(db: DatabaseClient, input: ClaimDueInput): Effect.Effect<ClaimDueResult> {
  const cap = input.maxConcurrentPerSession ?? DEFAULT_MAX_CONCURRENT_PER_SESSION
  const limit = input.limit ?? 100
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  const claimToken = `spoolclaim_${input.claimantId}_${input.now}`
  return Effect.gen(function* () {
    return yield* db
      .transaction(
        () =>
          Effect.gen(function* () {
            const eligible = yield* db
              .select()
              .from(DeepAgentEventSpoolTable)
              .where(
                or(
                  and(
                    eq(DeepAgentEventSpoolTable.status, "pending"),
                    or(
                      isNull(DeepAgentEventSpoolTable.next_attempt_at),
                      lte(DeepAgentEventSpoolTable.next_attempt_at, input.now),
                    ),
                  ),
                  and(
                    eq(DeepAgentEventSpoolTable.status, "claimed"),
                    and(
                      isNotNull(DeepAgentEventSpoolTable.lease_expires_at),
                      lte(DeepAgentEventSpoolTable.lease_expires_at, input.now),
                    ),
                  ),
                ),
              )
              // priority desc (critical first), then FIFO within a class.
              .orderBy(desc(priorityRank), asc(DeepAgentEventSpoolTable.created_at))
              .all()
              .pipe(Effect.orDie)

            // Bounded concurrency: take at most `cap` per session, in global priority order.
            const bySession = new Map<string, number>()
            const claimed: typeof eligible = []
            for (const row of eligible) {
              if (claimed.length >= limit) break
              const count = bySession.get(row.session_id) ?? 0
              if (count >= cap) continue
              bySession.set(row.session_id, count + 1)
              claimed.push(row)
            }
            if (claimed.length === 0) return { claimToken, rows: [] as ReadonlyArray<SpoolRow> }

            yield* db
              .update(DeepAgentEventSpoolTable)
              .set({
                status: "claimed" as const,
                claim_token: claimToken,
                claimant_id: input.claimantId,
                claimed_at: input.now,
                lease_expires_at: input.now + leaseMs,
                updated_at: input.now,
              })
              .where(inArray(DeepAgentEventSpoolTable.event_ref, claimed.map((row) => row.event_ref)))
              .run()
              .pipe(Effect.orDie)

            return {
              claimToken,
              rows: claimed.map((row) => ({
                ...decodeRow(row),
                status: "claimed" as const,
                claimToken,
                claimantId: input.claimantId,
                claimedAt: input.now,
                leaseExpiresAt: input.now + leaseMs,
              })),
            }
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  })
}

export interface SettleInput {
  readonly eventRef: string
  readonly claimToken: string
  readonly now: number
}

/** §8.6 — fenced commit: only a `claimed` row still held by the matching claim token flips to `resolved`. */
export function commitResult(db: DatabaseClient, input: SettleInput): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const updated = yield* db
      .update(DeepAgentEventSpoolTable)
      .set({
        status: "resolved" as const,
        claim_token: null,
        claimant_id: null,
        claimed_at: null,
        lease_expires_at: null,
        updated_at: input.now,
      })
      .where(
        and(
          eq(DeepAgentEventSpoolTable.event_ref, input.eventRef),
          eq(DeepAgentEventSpoolTable.claim_token, input.claimToken),
          eq(DeepAgentEventSpoolTable.status, "claimed"),
        ),
      )
      .returning({ event_ref: DeepAgentEventSpoolTable.event_ref })
      .all()
      .pipe(Effect.orDie)
    return updated.length > 0
  })
}

export interface NackInput extends SettleInput {
  readonly reason: string
  readonly maxAttempts?: number
}

/** §8.6 — fenced nack: increments `attempts`; past the cap the row is `dead` (DLQ, terminal). */
export function nack(db: DatabaseClient, input: NackInput): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(DeepAgentEventSpoolTable)
      .where(eq(DeepAgentEventSpoolTable.event_ref, input.eventRef))
      .get()
      .pipe(Effect.orDie)
    if (!row || row.status !== "claimed" || row.claim_token !== input.claimToken) return false
    const attempts = row.attempts + 1
    const dead = attempts >= (input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    yield* db
      .update(DeepAgentEventSpoolTable)
      .set({
        status: dead ? ("dead" as const) : ("pending" as const),
        attempts,
        last_error: input.reason,
        claim_token: null,
        claimant_id: null,
        claimed_at: null,
        lease_expires_at: null,
        next_attempt_at: dead ? null : input.now,
        updated_at: input.now,
      })
      .where(eq(DeepAgentEventSpoolTable.event_ref, input.eventRef))
      .run()
      .pipe(Effect.orDie)
    return true
  })
}

export interface Backlog {
  readonly pending: number
  readonly claimed: number
  readonly dead: number
  readonly byPriority: Record<DrainPriority, number>
  readonly total: number
}

const EMPTY_BY_PRIORITY: Record<DrainPriority, number> = { low: 0, normal: 0, high: 0, critical: 0 }

/** §8.6 — backlog depth, by status + priority. The observability/metrics surface. */
export function backlog(db: DatabaseClient, sessionID?: string): Effect.Effect<Backlog> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(DeepAgentEventSpoolTable)
      .where(
        sessionID != null
          ? eq(DeepAgentEventSpoolTable.session_id, sessionID)
          : isNotNull(DeepAgentEventSpoolTable.session_id),
      )
      .all()
      .pipe(Effect.orDie)
    const byPriority: Record<DrainPriority, number> = { ...EMPTY_BY_PRIORITY }
    let pending = 0
    let claimed = 0
    let dead = 0
    for (const row of rows) {
      byPriority[row.priority as DrainPriority] += 1
      if (row.status === "pending") pending += 1
      else if (row.status === "claimed") claimed += 1
      else if (row.status === "dead") dead += 1
    }
    return { pending, claimed, dead, byPriority, total: rows.length }
  })
}

/** §8.6 — a single spool row by identity (retry/drain tooling + tests). */
export function getByRef(db: DatabaseClient, eventRef: string): Effect.Effect<SpoolRow | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(DeepAgentEventSpoolTable)
      .where(eq(DeepAgentEventSpoolTable.event_ref, eventRef))
      .get()
      .pipe(Effect.orDie)
    return row ? decodeRow(row) : undefined
  })
}
