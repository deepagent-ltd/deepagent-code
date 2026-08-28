import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EventOutbox } from "@deepagent-code/core/deepagent/event-outbox"
import { eventOutboxMigration } from "@deepagent-code/core/deepagent/event-outbox-sql"
import { makeRegistry, verifiedCommand, commandEnvelope } from "./event-fixture"

// C5-02 — cross-aggregate transactional outbox + publisher claim/lease.
// Fixture DB is in-memory; the outbox ledger is created via applyOnly (the shared migration-registry
// wiring is the main agent's / database hotspot's job — the event hotspot owns its own schema).

type Db = Database.Interface["db"]

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [eventOutboxMigration])
      return yield* effect
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}

const registry = makeRegistry()

const enq = (db: Db, now: number, over?: Record<string, unknown>, aggregate?: Partial<{ aggregateType: string; aggregateId: string }>) =>
  EventOutbox.enqueue(db, {
    registry,
    event: verifiedCommand(registry, over),
    aggregateType: aggregate?.aggregateType ?? "goal",
    aggregateId: aggregate?.aggregateId ?? "ag-1",
    now,
  })

describe("EventOutbox.enqueue", () => {
  test("writes an idempotent outbox row for a validated event", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const row = yield* enq(db, 10)
        expect(row.status).toBe("pending")
        expect(row.attemptCount).toBe(0)
        expect(row.envelope.eventType).toBe("goal.tick.requested")
        expect(row.envelopeDigest).toMatch(/^[0-9a-f]{64}$/)
        // exact republish: same idempotency key returns the SAME row, never a second row.
        const again = yield* enq(db, 20)
        expect(again.outboxId).toBe(row.outboxId)
        expect((yield* EventOutbox.pendingRows(db, 999)).length).toBe(1)
      }),
    )
  })

  test("rejects an unregistered event fail-closed (no outbox row)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const bad = commandEnvelope({ eventType: "not.registered" })
        const exit = yield* EventOutbox.enqueue(db, { registry, event: bad as never, aggregateType: "goal", aggregateId: "ag-1", now: 10 }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect((yield* EventOutbox.pendingRows(db, 999)).length).toBe(0)
      }),
    )
  })
})

describe("EventOutbox claim/lease + fencing", () => {
  test("claims pending rows with a token + lease; live-leased rows are excluded", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* enq(db, 10, { eventId: "e-a", idempotencyKey: "idem-a" }, { aggregateId: "ag-a" })
        yield* enq(db, 10, { eventId: "e-b", idempotencyKey: "idem-b" }, { aggregateId: "ag-b" })

        const claim = yield* EventOutbox.claimDue(db, { claimantId: "worker-1", now: 100, leaseMs: 500, limit: 10 })
        expect(claim.rows.length).toBe(2)
        expect(claim.rows.every((r) => r.status === "publishing")).toBe(true)
        expect(claim.rows.every((r) => r.claimToken === claim.claimToken)).toBe(true)
        expect(claim.rows.every((r) => r.leaseExpiresAt === 600)).toBe(true)

        // while the lease is live, worker-2 cannot re-claim (fencing).
        const again = yield* EventOutbox.claimDue(db, { claimantId: "worker-2", now: 200, leaseMs: 500, limit: 10 })
        expect(again.rows.length).toBe(0)
      }),
    )
  })

  test("an expired lease (crash) makes the row re-claimable; stale token is fenced", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* enq(db, 10, { eventId: "e-a" })
        const first = yield* EventOutbox.claimDue(db, { claimantId: "worker-1", now: 100, leaseMs: 500, limit: 10 })
        expect(first.rows.length).toBe(1)
        // lease expires at 600; a claim at 600+ re-opens it (another claimant recovers it).
        const recovery = yield* EventOutbox.claimDue(db, { claimantId: "worker-2", now: 600, leaseMs: 500, limit: 10 })
        expect(recovery.rows.length).toBe(1)
        expect(recovery.rows[0]!.claimToken).toBe(recovery.claimToken)
        // stale token from worker-1 can no longer settle the re-claimed row.
        const settled = yield* EventOutbox.markPublished(db, { outboxId: first.rows[0]!.outboxId, claimToken: first.claimToken, now: 700 })
        expect(settled).toBe(false)
      }),
    )
  })

  test("markPublished clears the claim on the winning token only", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* enq(db, 10, { eventId: "e-a" })
        const claim = yield* EventOutbox.claimDue(db, { claimantId: "worker-1", now: 100, leaseMs: 500, limit: 10 })
        const ok = yield* EventOutbox.markPublished(db, { outboxId: claim.rows[0]!.outboxId, claimToken: claim.claimToken, now: 150 })
        expect(ok).toBe(true)
        const row = yield* EventOutbox.getByID(db, claim.rows[0]!.outboxId)
        expect(row?.status).toBe("published")
        expect(row?.publishedAt).toBe(150)
        expect(row?.claimToken).toBeUndefined()
      }),
    )
  })

  test("markFailed returns a row to pending, or dead-letters it past the attempt budget", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* enq(db, 10, { eventId: "e-a" })
        const claim1 = yield* EventOutbox.claimDue(db, { claimantId: "worker-1", now: 100, leaseMs: 500, limit: 10 })
        yield* EventOutbox.markFailed(db, { outboxId: claim1.rows[0]!.outboxId, claimToken: claim1.claimToken, now: 150, reason: "boom", maxAttempts: 3 })
        let row = yield* EventOutbox.getByID(db, claim1.rows[0]!.outboxId)
        expect(row?.status).toBe("pending")
        expect(row?.attemptCount).toBe(1)

        // second failure at attempt 3 (>= maxAttempts) dead-letters.
        const claim2 = yield* EventOutbox.claimDue(db, { claimantId: "worker-2", now: 700, leaseMs: 500, limit: 10 })
        yield* EventOutbox.markFailed(db, { outboxId: claim2.rows[0]!.outboxId, claimToken: claim2.claimToken, now: 800, reason: "boom again", maxAttempts: 2 })
        row = yield* EventOutbox.getByID(db, claim2.rows[0]!.outboxId)
        expect(row?.status).toBe("dead")
        expect(row?.attemptCount).toBe(2)
        // dead rows are not re-claimed.
        const none = yield* EventOutbox.claimDue(db, { claimantId: "worker-3", now: 900, leaseMs: 500, limit: 10 })
        expect(none.rows.length).toBe(0)
      }),
    )
  })
})

describe("EventOutbox transactional invariant + publisher", () => {
  test("state+enqueue commit together: committed aggregate survives; rolled-back tx leaves no row", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run("CREATE TABLE IF NOT EXISTS aggregate_state (id TEXT PRIMARY KEY, version INTEGER NOT NULL)")

        // Committed: aggregate version bump + enqueue in ONE transaction -> row survives.
        yield* db
          .transaction(
            () =>
              Effect.gen(function* () {
                yield* db.run("INSERT INTO aggregate_state (id, version) VALUES ('ag-1', 1)")
                yield* enq(db, 10, { eventId: "e-ag" }, { aggregateId: "ag-1", aggregateType: "goal" })
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        expect((yield* EventOutbox.pendingRows(db, 999)).length).toBe(1)

        // Rolled back: aggregate tx throws -> BOTH the aggregate write and the outbox row vanish.
        const exit = yield* db
          .transaction(
            () =>
              Effect.gen(function* () {
                yield* db.run("INSERT INTO aggregate_state (id, version) VALUES ('ag-2', 1)")
                yield* enq(db, 11, { eventId: "e-ghost" }, { aggregateId: "ag-2", aggregateType: "goal" })
                return yield* Effect.fail(new Error("boom"))
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect((yield* EventOutbox.pendingRows(db, 999)).length).toBe(1)
        const state = yield* db
          .all<{ n: number }>("SELECT count(*) AS n FROM aggregate_state")
          .pipe(Effect.orDie)
        expect(state[0]?.n).toBe(1)
      }),
    )
  })

  test("publisher pump dispatches only claimed rows and settles them (published)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* enq(db, 10, { eventId: "e-1", idempotencyKey: "idem-1" }, { aggregateId: "ag-1" })
        yield* enq(db, 10, { eventId: "e-2", idempotencyKey: "idem-2" }, { aggregateId: "ag-2" })
        const dispatched: string[] = []
        const result = yield* EventOutbox.publish(db, {
          dispatch: (envelope) =>
            Effect.sync(() => {
              dispatched.push(envelope.eventId)
            }),
          claimantId: "pump-1",
          now: 100,
          leaseMs: 500,
          batchSize: 10,
          maxAttempts: 3,
        })
        expect(result.claimed).toBe(2)
        expect(result.published).toBe(2)
        expect(result.failed).toBe(0)
        expect(dispatched.sort()).toEqual(["e-1", "e-2"])
        expect((yield* EventOutbox.pendingRows(db, 200)).length).toBe(0)
      }),
    )
  })

  test("publisher returns a failed dispatch to pending (not dead) before the attempt budget", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* enq(db, 10, { eventId: "e-1" }, { aggregateId: "ag-1" })
        const result = yield* EventOutbox.publish(db, {
          dispatch: () => Effect.fail(new Error("dispatch down")),
          claimantId: "pump-1",
          now: 100,
          leaseMs: 500,
          batchSize: 10,
          maxAttempts: 3,
        })
        expect(result.failed).toBe(1)
        const row = yield* EventOutbox.byIdempotencyKey(db, "idem-1")
        expect(row?.status).toBe("pending")
        expect(row?.attemptCount).toBe(1)
        expect(result.dead).toBe(0)
      }),
    )
  })
})
