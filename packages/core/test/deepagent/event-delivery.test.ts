import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EventOutbox } from "@deepagent-code/core/deepagent/event-outbox"
import { eventOutboxMigration } from "@deepagent-code/core/deepagent/event-outbox-sql"
import { EventConsumer } from "@deepagent-code/core/deepagent/event-consumer"
import {
  eventConsumerMigrations,
  DeepAgentEventConsumerTable,
  DeepAgentEventConsumerDeliveryTable,
} from "@deepagent-code/core/deepagent/event-consumer-sql"
import { makeRegistry, verifiedCommand } from "./event-fixture"

// C5-06 — consumer durable registration + claim/lease + retry/DLQ/retention hardening.
// Design authority: docs/core-v2.0-beta/design.md §8.6 (producer-before-consumer, stale token,
// DLQ 不递归, pending 不删). Builds on the C5-02 outbox machinery (event-outbox.ts).

type Db = Database.Interface["db"]

function run<A>(effect: Effect.Effect<A, unknown, Database.Service>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [eventOutboxMigration, ...eventConsumerMigrations])
      return yield* effect
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}

const registry = makeRegistry()
const CONSUMER = "consumer-a"
const V1 = "delivery.v1"

const enq = (db: Db, now: number, over?: Record<string, unknown>) =>
  EventOutbox.enqueue(db, {
    registry,
    event: verifiedCommand(registry, over),
    aggregateType: "goal",
    aggregateId: "ag-1",
    now,
  })

/** Publish an outbox row (pending -> publishing -> published) so it is consumable. */
const publishOutbox = (db: Db, now: number, over?: Record<string, unknown>) =>
  Effect.gen(function* () {
    const row = yield* enq(db, now, over)
    const claim = yield* EventOutbox.claimDue(db, { claimantId: "publisher", now: now + 1, leaseMs: 50_000, limit: 100 })
    const target = claim.rows.find((r) => r.outboxId === row.outboxId)
    if (!target) throw new Error("publishOutbox: claimed row missing")
    const ok = yield* EventOutbox.markPublished(db, { outboxId: target.outboxId, claimToken: claim.claimToken, now: now + 2 })
    if (!ok) throw new Error("publishOutbox: markPublished fenced")
    return row
  })

/** Register a consumer + publish + schedule an event for it, returning the outbox row. */
const prepFor = (db: Db, consumerKey: string, eventId: string, now: number) =>
  Effect.gen(function* () {
    yield* EventConsumer.register(db, { consumerKey, deliveryContractVersion: V1, now })
    const row = yield* publishOutbox(db, now, { eventId, idempotencyKey: `idem-${eventId}` })
    yield* EventConsumer.schedule(db, { outboxId: row.outboxId, consumerKey, now: now + 1 })
    return row
  })

const prepped = (db: Db, eventId: string, now: number) => prepFor(db, CONSUMER, eventId, now)

/** Extract the typed `ConsumerError` from a failed effect (undefined if it succeeded). */
const refusalOf = <A>(effect: Effect.Effect<A, EventConsumer.ConsumerError>): Effect.Effect<EventConsumer.ConsumerError | undefined> =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => error,
      onSuccess: () => undefined,
    }),
  )

describe("C5-06 consumer durable registration", () => {
  test("register is idempotent (same version refreshes, never duplicates)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const c1 = yield* EventConsumer.register(db, { consumerKey: CONSUMER, deliveryContractVersion: V1, now: 10 })
        expect(c1.deliveryContractVersion).toBe(V1)
        const c2 = yield* EventConsumer.register(db, { consumerKey: CONSUMER, deliveryContractVersion: V1, now: 20 })
        expect(c2.updatedAt).toBe(20)
        expect(c2.registeredAt).toBe(10)
        const rows = yield* db.select().from(DeepAgentEventConsumerTable).all().pipe(Effect.orDie)
        expect(rows.length).toBe(1)
      }),
    )
  })

  test("a DIFFERENT contract version on re-register is a typed conflict (no silent supersede)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* EventConsumer.register(db, { consumerKey: CONSUMER, deliveryContractVersion: V1, now: 10 })
        const err = yield* refusalOf(
          EventConsumer.register(db, { consumerKey: CONSUMER, deliveryContractVersion: "delivery.v2", now: 20 }),
        )
        expect(err?.reason).toBe("contract_version_conflict")
        const rows = yield* db.select().from(DeepAgentEventConsumerTable).all().pipe(Effect.orDie)
        expect(rows.length).toBe(1)
        expect(rows[0]!.delivery_contract_version).toBe(V1)
      }),
    )
  })

  test("an unregistered consumer cannot claim (typed refusal)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const err = yield* refusalOf(
          EventConsumer.claimDue(db, { consumerKey: "ghost", claimantId: "w", now: 10, leaseMs: 500, limit: 10 }),
        )
        expect(err?.reason).toBe("unregistered_consumer")
      }),
    )
  })

  test("an unregistered consumer cannot be scheduled work (typed refusal)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* publishOutbox(db, 10, { eventId: "e-0" })
        const err = yield* refusalOf(EventConsumer.schedule(db, { outboxId: row.outboxId, consumerKey: "ghost", now: 20 }))
        expect(err?.reason).toBe("unregistered_consumer")
      }),
    )
  })
})

describe("C5-06 producer-before-consumer ordering", () => {
  test("a consumer cannot schedule an event before the producer transaction commits", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* EventConsumer.register(db, { consumerKey: CONSUMER, deliveryContractVersion: V1, now: 10 })
        // enqueue -> the outbox row is `pending`; the producer has NOT published it yet.
        const pending = yield* enq(db, 10, { eventId: "e-unpub", idempotencyKey: "idem-unpub" })
        expect(pending.status).toBe("pending")
        // schedule refuses: the producer transaction has not committed.
        const err = yield* refusalOf(EventConsumer.schedule(db, { outboxId: pending.outboxId, consumerKey: CONSUMER, now: 20 }))
        expect(err?.reason).toBe("not_yet_publishable")
        // and no delivery was created, so claimDue sees nothing.
        const claim = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "w", now: 30, leaseMs: 500, limit: 10 })
        expect(claim.deliveries.length).toBe(0)
      }),
    )
  })

  test("claiming a delivery whose underlying outbox row is not yet published fails typed (invariant held)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* EventConsumer.register(db, { consumerKey: CONSUMER, deliveryContractVersion: V1, now: 10 })
        const pending = yield* enq(db, 10, { eventId: "e-unpub-2", idempotencyKey: "idem-unpub-2" })
        // Inject a delivery row for an UNpublished outbox row (a corrupted state) and assert claim
        // refuses because the producer transaction hasn't committed.
        yield* db
          .insert(DeepAgentEventConsumerDeliveryTable)
          .values({
            outbox_id: pending.outboxId,
            consumer_key: CONSUMER,
            status: "pending",
            attempts: 0,
            last_error: null,
            next_attempt_at: null,
            claim_token: null,
            claimant_id: null,
            claimed_at: null,
            lease_expires_at: null,
            resolved_at: null,
            created_at: 11,
            updated_at: 11,
          })
          .run()
          .pipe(Effect.orDie)
        const err = yield* refusalOf(
          EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "w", now: 30, leaseMs: 500, limit: 10 }),
        )
        expect(err?.reason).toBe("not_yet_publishable")
      }),
    )
  })

  test("a published outbox event IS consumable (happy path)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* prepped(db, "e-ok", 10)
        const claim = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "w", now: 30, leaseMs: 500, limit: 10 })
        expect(claim.deliveries.length).toBe(1)
        expect(claim.deliveries[0]!.outboxId).toBe(row.outboxId)
      }),
    )
  })
})

describe("C5-06 claim/lease + fencing + crash recovery", () => {
  test("an expired lease revives a claimed delivery; a stale token cannot commit (fenced)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* prepped(db, "e-lease", 10)
        const claim1 = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "worker-1", now: 30, leaseMs: 100, limit: 10 })
        expect(claim1.deliveries.length).toBe(1)
        expect(claim1.deliveries[0]!.claimToken).toBe(claim1.claimToken)
        // live lease (expires at 130) fences worker-2.
        const fenced = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "worker-2", now: 40, leaseMs: 100, limit: 10 })
        expect(fenced.deliveries.length).toBe(0)
        // lease expiry (>= 130) revives the row for another claimant (crash recovery).
        const revive = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "worker-2", now: 130, leaseMs: 100, limit: 10 })
        expect(revive.deliveries.length).toBe(1)
        expect(revive.deliveries[0]!.claimToken).toBe(revive.claimToken)
        // the stale worker-1 token can no longer commit the result.
        const committed = yield* EventConsumer.commitResult(db, { outboxId: row.outboxId, consumerKey: CONSUMER, claimToken: claim1.claimToken, now: 140 })
        expect(committed).toBe(false)
        // worker-2's token commits.
        const ok = yield* EventConsumer.commitResult(db, { outboxId: row.outboxId, consumerKey: CONSUMER, claimToken: revive.claimToken, now: 140 })
        expect(ok).toBe(true)
        const d = yield* EventConsumer.getByDelivery(db, row.outboxId, CONSUMER)
        expect(d?.status).toBe("resolved")
      }),
    )
  })

  test("claim does NOT increment the retry counter (crash mid-process resumes at same attempt count)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* prepped(db, "e-crash", 10)
        const claim1 = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "worker-1", now: 30, leaseMs: 100, limit: 10 })
        expect(claim1.deliveries[0]!.attempts).toBe(0)
        // Crash mid-process: no commit/nack. Lease expiry revives; attempts is still 0.
        const revive = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "worker-2", now: 200, leaseMs: 100, limit: 10 })
        expect(revive.deliveries[0]!.attempts).toBe(0)
        expect(revive.deliveries[0]!.claimToken).toBe(revive.claimToken)
        // the revived row is still "claimed" (re-processing the same event — at-least-once).
        const d = yield* EventConsumer.getByDelivery(db, row.outboxId, CONSUMER)
        expect(d?.status).toBe("claimed")
      }),
    )
  })
})

describe("C5-06 retry / DLQ / durability", () => {
  test("nack schedules a bounded retry with backoff; the counter persists across claims", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* prepped(db, "e-retry", 10)
        const c1 = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "w", now: 30, leaseMs: 500, limit: 10 })
        const ok1 = yield* EventConsumer.nack(db, {
          outboxId: row.outboxId,
          consumerKey: CONSUMER,
          claimToken: c1.claimToken,
          reason: "boom",
          now: 40,
          maxAttempts: 5,
          backoffBaseMs: 1000,
        })
        expect(ok1).toBe(true)
        let d = yield* EventConsumer.getByDelivery(db, row.outboxId, CONSUMER)
        expect(d?.status).toBe("pending")
        expect(d?.attempts).toBe(1)
        // backoff not yet elapsed (next_attempt_at = 40 + 1000*2^0 = 1040) -> not claimable.
        const notYet = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "w", now: 500, leaseMs: 500, limit: 10 })
        expect(notYet.deliveries.length).toBe(0)
        // after the backoff elapses, the counter is resumed at 1.
        const c2 = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "w", now: 1040, leaseMs: 500, limit: 10 })
        expect(c2.deliveries.length).toBe(1)
        expect(c2.deliveries[0]!.attempts).toBe(1)
      }),
    )
  })

  test("max attempts dead-letters the delivery (DLQ), which is no longer claimable", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* prepped(db, "e-dlq", 10)
        const c1 = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "w", now: 30, leaseMs: 500, limit: 10 })
        yield* EventConsumer.nack(db, { outboxId: row.outboxId, consumerKey: CONSUMER, claimToken: c1.claimToken, reason: "f1", now: 40, maxAttempts: 2, backoffBaseMs: 1000 })
        const c2 = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "w", now: 1040, leaseMs: 500, limit: 10 })
        expect(c2.deliveries[0]!.attempts).toBe(1)
        const ok2 = yield* EventConsumer.nack(db, { outboxId: row.outboxId, consumerKey: CONSUMER, claimToken: c2.claimToken, reason: "f2", now: 1050, maxAttempts: 2, backoffBaseMs: 1000 })
        expect(ok2).toBe(true)
        const d = yield* EventConsumer.getByDelivery(db, row.outboxId, CONSUMER)
        expect(d?.status).toBe("dead")
        expect(d?.attempts).toBe(2)
        expect(d?.lastError).toBe("f2")
        // dead rows are NOT re-claimed.
        const none = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "w", now: 2000, leaseMs: 500, limit: 10 })
        expect(none.deliveries.length).toBe(0)
        // the DLQ view surfaces it.
        const dead = yield* EventConsumer.deadMessages(db, CONSUMER)
        expect(dead.length).toBe(1)
        expect(dead[0]!.outboxId).toBe(row.outboxId)
      }),
    )
  })

  test("a DLQ message is terminal: cannot be re-enqueued (schedule) or nacked (no recursion)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* prepped(db, "e-norec", 10)
        const c1 = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "w", now: 30, leaseMs: 500, limit: 10 })
        yield* EventConsumer.nack(db, { outboxId: row.outboxId, consumerKey: CONSUMER, claimToken: c1.claimToken, reason: "f", now: 40, maxAttempts: 1, backoffBaseMs: 1000 })
        expect((yield* EventConsumer.getByDelivery(db, row.outboxId, CONSUMER))?.status).toBe("dead")
        // Re-scheduling the dead-lettered event is refused.
        const reenq = yield* refusalOf(EventConsumer.schedule(db, { outboxId: row.outboxId, consumerKey: CONSUMER, now: 50 }))
        expect(reenq?.reason).toBe("dlq_terminal")
        // Nacking the dead-lettered delivery is refused (no recursion into DLQ).
        const renack = yield* refusalOf(EventConsumer.nack(db, { outboxId: row.outboxId, consumerKey: CONSUMER, claimToken: "whatever", reason: "again", now: 60, maxAttempts: 5 }))
        expect(renack?.reason).toBe("dlq_terminal")
        // Still a single terminal dead row.
        expect((yield* EventConsumer.getByDelivery(db, row.outboxId, CONSUMER))?.status).toBe("dead")
        expect((yield* EventConsumer.deadMessages(db, CONSUMER)).length).toBe(1)
      }),
    )
  })

  test("nack with a stale claim token is a fenced no-op", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* prepped(db, "e-stale", 10)
        const c1 = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "w1", now: 30, leaseMs: 100, limit: 10 })
        const ok = yield* EventConsumer.nack(db, { outboxId: row.outboxId, consumerKey: CONSUMER, claimToken: "stale_token", reason: "nope", now: 40, maxAttempts: 5 })
        expect(ok).toBe(false)
        const d = yield* EventConsumer.getByDelivery(db, row.outboxId, CONSUMER)
        expect(d?.status).toBe("claimed")
        expect(d?.claimToken).toBe(c1.claimToken)
      }),
    )
  })

  test("claimDue refuses a consumer presenting the wrong contract version", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* prepped(db, "e-ver", 10)
        const err = yield* refusalOf(
          EventConsumer.claimDue(db, { consumerKey: CONSUMER, contractVersion: "delivery.v9", claimantId: "w", now: 30, leaseMs: 500, limit: 10 }),
        )
        expect(err?.reason).toBe("contract_version_mismatch")
      }),
    )
  })
})

describe("C5-06 retention sweep", () => {
  test("sweep deletes only RESOLVED rows past the window; never pending/claimed/DLQ", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const key = (name: string) => `consumer-${name}`
        // resolved (the only one eligible once old) — must be swept.
        const rowRes = yield* prepFor(db, key("res"), "e-res", 10)
        const cRes = yield* EventConsumer.claimDue(db, { consumerKey: key("res"), claimantId: "w", now: 30, leaseMs: 500, limit: 10 })
        yield* EventConsumer.commitResult(db, { outboxId: rowRes.outboxId, consumerKey: key("res"), claimToken: cRes.claimToken, now: 40 })
        // pending (never claimed) — must survive.
        const rowPend = yield* prepFor(db, key("pend"), "e-pend", 10)
        // claimed (in flight, live lease) — must survive.
        const rowClaim = yield* prepFor(db, key("claim"), "e-claim", 10)
        yield* EventConsumer.claimDue(db, { consumerKey: key("claim"), claimantId: "w", now: 30, leaseMs: 500, limit: 10 })
        // dead (DLQ) — must survive.
        const rowDead = yield* prepFor(db, key("dead"), "e-dead", 10)
        const cDead = yield* EventConsumer.claimDue(db, { consumerKey: key("dead"), claimantId: "w", now: 30, leaseMs: 500, limit: 10 })
        yield* EventConsumer.nack(db, { outboxId: rowDead.outboxId, consumerKey: key("dead"), claimToken: cDead.claimToken, reason: "dead", now: 40, maxAttempts: 1, backoffBaseMs: 1000 })

        // Sweep with keepMs = 1000: resolved_at = 40 is older than now(5000) - 1000 = 4000.
        const result = yield* EventConsumer.sweep(db, { now: 5000, keepMs: 1000 })
        expect(result.deleted).toBe(1)
        expect((yield* EventConsumer.getByDelivery(db, rowRes.outboxId, key("res")))).toBeUndefined()
        expect((yield* EventConsumer.getByDelivery(db, rowPend.outboxId, key("pend") ))?.status).toBe("pending")
        expect((yield* EventConsumer.getByDelivery(db, rowClaim.outboxId, key("claim")))?.status).toBe("claimed")
        expect((yield* EventConsumer.getByDelivery(db, rowDead.outboxId, key("dead")))?.status).toBe("dead")

        // Idempotent: sweeping again deletes nothing new.
        const again = yield* EventConsumer.sweep(db, { now: 6000, keepMs: 1000 })
        expect(again.deleted).toBe(0)
      }),
    )
  })

  test("a fresh resolved delivery inside the keep window is retained (default 14 days)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* prepped(db, "e-keep", 10)
        const c = yield* EventConsumer.claimDue(db, { consumerKey: CONSUMER, claimantId: "w", now: 30, leaseMs: 500, limit: 10 })
        yield* EventConsumer.commitResult(db, { outboxId: row.outboxId, consumerKey: CONSUMER, claimToken: c.claimToken, now: 40 })
        // now ~11h later, well inside the default 14-day keep window.
        const result = yield* EventConsumer.sweep(db, { now: 41_000_000 })
        expect(result.deleted).toBe(0)
        expect((yield* EventConsumer.getByDelivery(db, row.outboxId, CONSUMER))?.status).toBe("resolved")
      }),
    )
  })
})
