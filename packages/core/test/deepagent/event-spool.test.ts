import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EventSpool } from "@deepagent-code/core/deepagent/event-spool"
import { eventSpoolMigration } from "@deepagent-code/core/deepagent/event-spool-sql"
import { EventCoalescing } from "@deepagent-code/core/deepagent/event-coalescing"
import { EventWorkEnvelope } from "@deepagent-code/core/deepagent/event-work-envelope"
import { createEventRegistry } from "@deepagent-code/core/deepagent/event-registry"
import type { EventTypeRegistration } from "@deepagent-code/core/deepagent/event-registry"
import type { WorkBudget, WorkContextQuery, EventRisk } from "@deepagent-code/core/contract/event-envelope"
import { verifiedCommand } from "./event-fixture"

// C5-07 — durable spool. Design §8.6 (high/critical never lost but bounded concurrency; storm drains in
// priority order; crash -> resume drain; backlog metrics).

type Db = Database.Interface["db"]

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [eventSpoolMigration])
      return yield* effect
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}

const budget: WorkBudget = {
  maxTokens: 8000,
  maxToolCalls: 4,
  maxDurationMs: 60000,
  hourTokensMax: 4000,
  hourWindowMinutes: 60,
  workspaceBudgetId: "wb-1",
  agentBudgetId: "ab-1",
  eventRoot: "goal://1",
}

const contextQuery: WorkContextQuery = { intent: "related", query: "advance the goal" }
const resolution = () => ({
  trust: { level: "verified" as const, sourceRef: "ctx://src/1" },
  permission: { scopes: ["goal.read"], required: ["goal.write"], maxAutonomy: "medium" as const },
  egress: { allowedDomains: ["plugins"], allowedSensitivities: ["public"] },
  budget,
  securityNamespaceId: "ns-1",
  projectScopeKey: "psc-1",
  contextQuery,
})

/** A non-noise envelope with an explicit risk and a distinct event identity. */
const mk = (risk: EventRisk, eventId: string) => {
  const registration: EventTypeRegistration = {
    eventType: `spool.${eventId}`,
    kind: "command",
    schemaId: "spool.schema",
    schemaVersion: "1",
    payloadContentType: "application/json",
    payloadVersion: "v1",
    allowedProducerKinds: ["system"],
    allowedSourceKinds: ["system"],
    causation: { allowed: [], requiresCause: false },
    risk,
    objective: "do the work",
    requestedCapability: "deepagent.work",
    autonomyCeiling: risk,
  }
  const reg = createEventRegistry([registration])
  const event = verifiedCommand(reg, {
    eventType: `spool.${eventId}`,
    eventId,
    idempotencyKey: `idem-${eventId}`,
    schema: { schemaId: "spool.schema", schemaVersion: "1" },
    causation: {},
  }) as never
  const result = EventWorkEnvelope.build({ event, registration, resolution: resolution(), verifiedFacts: [] })
  if (!result.ok) throw new Error(result.message)
  return result.envelope
}

const priorityOf = (risk: EventRisk) => EventCoalescing.riskToDrainPriority(risk)

const SESS_A = "ses-A"
const SESS_B = "ses-B"

describe("C5-07 spool enqueue (idempotent, never drop)", () => {
  test("spooling the SAME envelope twice is a no-op (one durable row)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const envelope = mk("critical", "c1")
        const p = priorityOf("critical")
        const first = yield* EventSpool.enqueue(db, { envelope, sessionID: SESS_A, priority: p, now: 10 })
        const again = yield* EventSpool.enqueue(db, { envelope, sessionID: SESS_A, priority: p, now: 20 })
        expect(again.eventRef).toBe(first.eventRef)
        const b = yield* EventSpool.backlog(db)
        expect(b.total).toBe(1)
      }),
    )
  })

  test("the spooled envelope is the BOUNDED envelope (payload ref only), never the raw payload", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const envelope = mk("critical", "c2")
        yield* EventSpool.enqueue(db, { envelope, sessionID: SESS_A, priority: "critical", now: 10 })
        const row = yield* EventSpool.getByRef(db, envelope.eventRef)
        expect(row).toBeDefined()
        expect(Object.keys(row!.envelope.payload).length).toBe(3)
        expect(row!.envelopeDigest).toMatch(/^[0-9a-f]{64}$/)
      }),
    )
  })
})

describe("C5-07 priority drain order (storm)", () => {
  test("a storm drains critical > high > normal > low", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        // Enqueue a storm: critical, low, high, normal (all into the SAME session).
        yield* EventSpool.enqueue(db, { envelope: mk("critical", "s-crit"), sessionID: SESS_A, priority: "critical", now: 100 })
        yield* EventSpool.enqueue(db, { envelope: mk("low", "s-low"), sessionID: SESS_A, priority: "low", now: 101 })
        yield* EventSpool.enqueue(db, { envelope: mk("high", "s-high"), sessionID: SESS_A, priority: "high", now: 102 })
        yield* EventSpool.enqueue(db, { envelope: mk("medium", "s-norm"), sessionID: SESS_A, priority: "normal", now: 103 })
        const claim = yield* EventSpool.claimDue(db, { claimantId: "drain", now: 200, maxConcurrentPerSession: 10, limit: 10 })
        expect(claim.rows.map((r) => r.priority)).toEqual(["critical", "high", "normal", "low"])
      }),
    )
  })
})

describe("C5-07 bounded concurrency (never unbounded)", () => {
  test("a claim never holds more than maxConcurrentPerSession rows for one session", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        // 6 critical events for SESS_A + 1 for SESS_B.
        for (let i = 0; i < 6; i++) {
          yield* EventSpool.enqueue(db, { envelope: mk("critical", `cap-${i}`), sessionID: SESS_A, priority: "critical", now: 100 + i })
        }
        yield* EventSpool.enqueue(db, { envelope: mk("critical", "cap-b"), sessionID: SESS_B, priority: "critical", now: 300 })
        // cap = 2 per session -> SESS_A gets 2, SESS_B gets 1 (3 total), rest stay pending.
        const claim = yield* EventSpool.claimDue(db, { claimantId: "drain", now: 500, maxConcurrentPerSession: 2, limit: 100 })
        const rowsA = claim.rows.filter((r) => r.sessionID === SESS_A)
        const rowsB = claim.rows.filter((r) => r.sessionID === SESS_B)
        expect(rowsA.length).toBe(2)
        expect(rowsB.length).toBe(1)
        expect(claim.rows.length).toBe(3)
        // the rest remain pending (never lost, never unbounded in-flight).
        const b = yield* EventSpool.backlog(db, SESS_A)
        expect(b.pending).toBe(4)
        expect(b.claimed).toBe(2)
      }),
    )
  })
})

describe("C5-07 spool durability (crash -> resume) + fencing", () => {
  test("a claimed row whose lease expires is revived; a stale token cannot commit (fenced)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const envelope = mk("critical", "durable")
        const row = yield* EventSpool.enqueue(db, { envelope, sessionID: SESS_A, priority: "critical", now: 10 })
        const c1 = yield* EventSpool.claimDue(db, { claimantId: "w1", now: 20, leaseMs: 100, maxConcurrentPerSession: 5, limit: 10 })
        expect(c1.rows.length).toBe(1)
        // live lease (expires 120) fences another claimant.
        const fenced = yield* EventSpool.claimDue(db, { claimantId: "w2", now: 30, leaseMs: 100, maxConcurrentPerSession: 5, limit: 10 })
        expect(fenced.rows.length).toBe(0)
        // lease expiry revives (crash recovery — the drain resumes).
        const revive = yield* EventSpool.claimDue(db, { claimantId: "w2", now: 120, leaseMs: 100, maxConcurrentPerSession: 5, limit: 10 })
        expect(revive.rows.length).toBe(1)
        expect(revive.rows[0]!.eventRef).toBe(row.eventRef)
        // the stale w1 token can no longer commit (fenced).
        expect(yield* EventSpool.commitResult(db, { eventRef: row.eventRef, claimToken: c1.claimToken, now: 130 })).toBe(false)
        // w2's token commits.
        expect(yield* EventSpool.commitResult(db, { eventRef: row.eventRef, claimToken: revive.claimToken, now: 130 })).toBe(true)
        const b = yield* EventSpool.backlog(db)
        // a committed (resolved) row is no longer pending/claimed in-flight.
        expect(b.pending).toBe(0)
        expect(b.claimed).toBe(0)
      }),
    )
  })

  test("a claim does not consume an attempt; a crash mid-drain resumes at the SAME attempt count", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const envelope = mk("critical", "crash")
        yield* EventSpool.enqueue(db, { envelope, sessionID: SESS_A, priority: "critical", now: 10 })
        const c1 = yield* EventSpool.claimDue(db, { claimantId: "w1", now: 20, leaseMs: 100, maxConcurrentPerSession: 5, limit: 10 })
        expect(c1.rows[0]!.attempts).toBe(0)
        // crash mid-process: no commit/nack. Lease expiry revives; attempts still 0.
        const revive = yield* EventSpool.claimDue(db, { claimantId: "w2", now: 150, leaseMs: 100, maxConcurrentPerSession: 5, limit: 10 })
        expect(revive.rows[0]!.attempts).toBe(0)
        expect(revive.rows[0]!.status).toBe("claimed")
      }),
    )
  })

  test("nack increments attempts and past the cap dead-letters (terminal, never re-drained)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const envelope = mk("critical", "dlq")
        yield* EventSpool.enqueue(db, { envelope, sessionID: SESS_A, priority: "critical", now: 10 })
        const c1 = yield* EventSpool.claimDue(db, { claimantId: "w", now: 20, leaseMs: 5000, maxConcurrentPerSession: 5, limit: 10 })
        expect(yield* EventSpool.nack(db, { eventRef: envelope.eventRef, claimToken: c1.claimToken, now: 30, reason: "boom", maxAttempts: 1 })).toBe(true)
        const b = yield* EventSpool.backlog(db)
        expect(b.dead).toBe(1)
        // terminal: not re-drained.
        const none = yield* EventSpool.claimDue(db, { claimantId: "w2", now: 200, maxConcurrentPerSession: 5, limit: 10 })
        expect(none.rows.length).toBe(0)
      }),
    )
  })

  test("a stale claim token is a fenced no-op (does not mutate the row)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const envelope = mk("critical", "stale")
        yield* EventSpool.enqueue(db, { envelope, sessionID: SESS_A, priority: "critical", now: 10 })
        const c1 = yield* EventSpool.claimDue(db, { claimantId: "w1", now: 20, leaseMs: 5000, maxConcurrentPerSession: 5, limit: 10 })
        expect(yield* EventSpool.nack(db, { eventRef: envelope.eventRef, claimToken: "stale", now: 30, reason: "nope" })).toBe(false)
        const row = yield* EventSpool.getByRef(db, envelope.eventRef)
        expect(row?.status).toBe("claimed")
        expect(row?.claimToken).toBe(c1.claimToken)
      }),
    )
  })
})
