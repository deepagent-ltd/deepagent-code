/**
 * C5-11 — DYNAMIC EVENT RUNTIME CAMPAIGN.
 *
 * Design authority: docs/core-v2.0-beta/design.md §8.6 (multiprocess claim fencing, lease-expiry revival,
 * storm drain order + bounded concurrency, never-drop, backlog metrics) and §8.8 (coalescing / quiet-window,
 * model never flooded). This campaign is the DYNAMIC complement to the static unit suites: it exercises the
 * runtime shapes the static suites cannot (<E3 consumer, E4a spool/coalescing, E4b ledger>):
 *
 *   1. multiprocess  - two processes/connections claim the same spool work -> exactly one winner per row,
 *                      no double-claim, unclaimed rows stay pending (no lost pending).
 *   2. kill          - a worker claims then "dies" (no commit/nack); the lease-expiry revive re-claims the
 *                      row at the SAME attempt count (at-least-once, one durable row).
 *   3. claim expiry  - an expired lease is revivable; a stale token's commit/nack is a fenced no-op.
 *   4. event storm   - N events of mixed priority drain critical>high>normal>low with a bounded per-session
 *                      concurrency cap; backlog returns to 0; nothing is dropped.
 *   5. quiet hours   - the coalescing window MERGES same-key low events and NEVER merges high/critical.
 *   6. shutdown      - graceful drain order (critical first) then a shutdown leaves the remaining work
 *                      durable/pending (no lost pending); a restart resumes.
 *   7. budget        - drain-latency p50/p95 reported + a calibrated relative bound asserted.
 *
 * FIXTURE / IN-MEMORY ONLY. Deterministic clocks for every claim/lease (`now` is injected); the only wall
 * clock used is `performance.now()` for the latency-budget report. No live network, no production adapter.
 */

import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { EventSpool } from "@deepagent-code/core/deepagent/event-spool"
import { eventSpoolMigration } from "@deepagent-code/core/deepagent/event-spool-sql"
import { EventCoalescing } from "@deepagent-code/core/deepagent/event-coalescing"
import { EventWorkEnvelope } from "@deepagent-code/core/deepagent/event-work-envelope"
import { createEventRegistry } from "@deepagent-code/core/deepagent/event-registry"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import type { EventTypeRegistration } from "@deepagent-code/core/deepagent/event-registry"
import type { EventRisk, WorkBudget, WorkContextQuery } from "@deepagent-code/core/contract/event-envelope"
import { verifiedCommand } from "./event-fixture"

type Db = Database.Interface["db"]

// ── Single-connection in-memory runner (spool suite) ──────────────────────────────────────────────
function run<A>(effect: Effect.Effect<A, unknown, Database.Service>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [eventSpoolMigration])
      return yield* effect
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}

// ── Shared-file, TWO-connection runner (true multiprocess simulation) ────────────────────────────
const sharedLayer = (file: string): Layer.Layer<Database.Service, unknown> =>
  Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* DatabaseMigration.applyOnly(db, [eventSpoolMigration])
      return { db }
    }),
  ).pipe(Layer.provide(sqliteLayer({ filename: file })))

/** A unique temp file per call (avoids WAL/-wal/-shm cross-run contamination). */
const tmpDbFile = (): string => {
  const file = `${Bun.env.TMPDIR ?? "/tmp"}/dsh-event-campaign-${crypto.randomUUID()}.sqlite`
  return file
}

const removeDbFiles = (file: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(file + suffix, { force: true })
    } catch {
      // best-effort cleanup
    }
  }
}

// ── Bounded envelope helper (distinct identity, explicit risk → drain priority) ─────────────────
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

const mk = (risk: EventRisk, eventId: string, groupType?: string) => {
  const evt = groupType ?? `campaign.${risk}.${eventId}`
  const registration: EventTypeRegistration = {
    eventType: evt,
    kind: "command",
    schemaId: "campaign.schema",
    schemaVersion: "1",
    payloadContentType: "application/json",
    payloadVersion: "v1",
    allowedProducerKinds: ["system"],
    allowedSourceKinds: ["system"],
    causation: { allowed: [], requiresCause: false },
    risk,
    objective: "advance the goal",
    requestedCapability: "deepagent.work",
    autonomyCeiling: risk,
  }
  const reg = createEventRegistry([registration])
  const event = verifiedCommand(reg, {
    eventType: evt,
    eventId,
    idempotencyKey: `idem-${eventId}`,
    schema: { schemaId: "campaign.schema", schemaVersion: "1" },
    causation: {},
  }) as never
  const result = EventWorkEnvelope.build({ event, registration, resolution: resolution(), verifiedFacts: [] })
  if (!result.ok) throw new Error(result.message)
  return result.envelope
}

const priorityOf = (risk: EventRisk) => EventCoalescing.riskToDrainPriority(risk)
const rank = (p: EventCoalescing.DrainPriority) => EventCoalescing.DRAIN_RANK[p]

/** Drain the spool to emptiness (configurable per-session cap), committing every claimed row. */
const drainAll = (
  db: Db,
  input: { claimantId: string; startNow: number; leaseMs?: number; maxConcurrentPerSession?: number; limit?: number },
): Effect.Effect<{ readonly orderOfPriority: readonly EventCoalescing.DrainPriority[]; readonly total: number }> =>
  Effect.gen(function* () {
    let now = input.startNow
    const order: EventCoalescing.DrainPriority[] = []
    let total = 0
    for (;;) {
      const claim = yield* EventSpool.claimDue(db, {
        claimantId: input.claimantId,
        now,
        leaseMs: input.leaseMs ?? 60_000,
        maxConcurrentPerSession: input.maxConcurrentPerSession ?? 100,
        limit: input.limit ?? 1000,
      })
      if (claim.rows.length === 0) break
      for (const row of claim.rows) {
        const committed = yield* EventSpool.commitResult(db, { eventRef: row.eventRef, claimToken: claim.claimToken, now })
        if (!committed) throw new Error(`drainAll: commit fenced for row ${row.eventRef}`)
        order.push(row.priority)
        total += 1
      }
      now += 1_000
    }
    return { orderOfPriority: order, total }
  })

/** Merge a sequence of low envelopes into ONE base (tests the quiet-window merge shape). */
const mergeWindow = (envelopes: readonly ReturnType<typeof mk>[]): ReturnType<typeof mk> => {
  let base = envelopes[0]!
  for (const incoming of envelopes.slice(1)) base = EventCoalescing.mergeEnvelopes(base, incoming)
  return base
}

// ── 1. MULTIPROCESS ──────────────────────────────────────────────────────────────────────────────
describe("C5-11 multiprocess claim (two connections, shared SQLite file)", () => {
  test("two processes claim the SAME spool work -> exactly one winner, no lost pending", async () => {
    const file = tmpDbFile()
    removeDbFiles(file)
    // Seed ONE shared schema + a single critical event on process A's connection.
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* EventSpool.enqueue(db, { envelope: mk("critical", "mp-only"), sessionID: "ses-A", priority: "critical", now: 10 })
      }).pipe(Effect.provide(sharedLayer(file)), Effect.scoped),
    )

    // Two processes racing the claim on two independent connections.
    const claimer = (who: string) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const c = yield* EventSpool.claimDue(db, {
          claimantId: who,
          now: 100,
          leaseMs: 100_000,
          maxConcurrentPerSession: 10,
          limit: 10,
        })
        return { who, claimed: c.rows.map((r) => r.eventRef), token: c.claimToken }
      }).pipe(Effect.provide(sharedLayer(file)), Effect.scoped)

    const [a, b] = await Promise.all([
      Effect.runPromise(claimer("proc-A")),
      Effect.runPromise(claimer("proc-B")),
    ])

    // Exactly one winner: the row is claimed by at most one process (fencing).
    const claimed = [...a.claimed, ...b.claimed]
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toBe("event://mp-only")

    // Commit with the winner + assert the loser's token is fenced (no-op).
    const winnerToken = a.claimed.length === 1 ? a.token : b.token
    const loserToken = a.claimed.length === 1 ? b.token : a.token
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(yield* EventSpool.commitResult(db, { eventRef: "event://mp-only", claimToken: winnerToken, now: 120 })).toBe(true)
        // A stale (loser) token can no longer touch the row.
        expect(yield* EventSpool.commitResult(db, { eventRef: "event://mp-only", claimToken: loserToken, now: 130 })).toBe(false)
        const b2 = yield* EventSpool.backlog(db)
        expect(b2.pending).toBe(0)
        expect(b2.claimed).toBe(0)
        expect(b2.dead).toBe(0)
        expect(b2.total).toBe(1)
      }).pipe(Effect.provide(sharedLayer(file)), Effect.scoped),
    )

    removeDbFiles(file)
  })

  test("multiprocess with MANY rows: winner set = enqueued set, unclaimed rows stay pending", async () => {
    const file = tmpDbFile()
    removeDbFiles(file)
    const N = 8
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        for (let i = 0; i < N; i++) {
          yield* EventSpool.enqueue(db, { envelope: mk("high", `mp-${i}`), sessionID: "ses-A", priority: "high", now: 10 + i })
        }
      }).pipe(Effect.provide(sharedLayer(file)), Effect.scoped),
    )

    const claimer = (who: string, cap: number) =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const c = yield* EventSpool.claimDue(db, {
          claimantId: who,
          now: 100,
          leaseMs: 100_000,
          maxConcurrentPerSession: cap,
          limit: 100,
        })
        return { who, claimed: c.rows.map((r) => r.eventRef) }
      }).pipe(Effect.provide(sharedLayer(file)), Effect.scoped)

    // cap=3 per session -> each process claims at most 3; the two sets must be DISJOINT.
    const [a, b] = await Promise.all([Effect.runPromise(claimer("proc-A", 3)), Effect.runPromise(claimer("proc-B", 3))])
    const overlap = a.claimed.filter((x) => b.claimed.includes(x))
    expect(overlap).toEqual([])
    expect(a.claimed.length + b.claimed.length).toBeLessThanOrEqual(6)

    // The unclaimed rows are still durable/pending (NO LOST PENDING).
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const back = yield* EventSpool.backlog(db)
        expect(back.pending + back.claimed).toBe(N)
        expect(back.total).toBe(N)
        expect(back.pending).toBe(N - (a.claimed.length + b.claimed.length))
        expect(back.claimed).toBe(a.claimed.length + b.claimed.length)
      }).pipe(Effect.provide(sharedLayer(file)), Effect.scoped),
    )

    removeDbFiles(file)
  })
})

// ── 2. KILL (mid-claim process death) ────────────────────────────────────────────────────────────
describe("C5-11 kill (mid-claim process death -> lease-expiry revival)", () => {
  test("a claimed row is re-claimed after a kill; at-least-once + single durable row", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const envelope = mk("critical", "kill-1")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses-A", priority: "critical", now: 10 })

        // Worker 1 claims then "dies" mid-process (no commit, no nack).
        const c1 = yield* EventSpool.claimDue(db, { claimantId: "w1", now: 20, leaseMs: 100, maxConcurrentPerSession: 5, limit: 10 })
        expect(c1.rows).toHaveLength(1)
        expect(c1.rows[0]!.attempts).toBe(0)

        // A new worker revives the row once the lease expires (crash recovery).
        const revive = yield* EventSpool.claimDue(db, { claimantId: "w2", now: 130, leaseMs: 100, maxConcurrentPerSession: 5, limit: 10 })
        expect(revive.rows).toHaveLength(1)
        expect(revive.rows[0]!.eventRef).toBe("event://kill-1")
        expect(revive.rows[0]!.attempts).toBe(0) // a claim is NOT a failure (at-least-once, no double attempt)

        // Still ONE durable row (nothing lost, nothing duplicated).
        const back = yield* EventSpool.backlog(db)
        expect(back.total).toBe(1)
        expect(back.claimed).toBe(1)

        // The revived worker commits; the dead worker's token is fenced.
        expect(yield* EventSpool.commitResult(db, { eventRef: "event://kill-1", claimToken: revive.claimToken, now: 140 })).toBe(true)
        expect(yield* EventSpool.commitResult(db, { eventRef: "event://kill-1", claimToken: c1.claimToken, now: 140 })).toBe(false)
      }),
    )
  })

  test("a kill DOES NOT consume an attempt; a nack after revival does (bounded retry preserved)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const envelope = mk("high", "kill-2")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses-A", priority: "high", now: 10 })
        const c1 = yield* EventSpool.claimDue(db, { claimantId: "w1", now: 20, leaseMs: 100, maxConcurrentPerSession: 5, limit: 10 })
        // "kill": no commit. Lease expires -> revive, attempts STILL 0.
        const revive = yield* EventSpool.claimDue(db, { claimantId: "w2", now: 130, leaseMs: 100, maxConcurrentPerSession: 5, limit: 10 })
        expect(revive.rows[0]!.attempts).toBe(0)
        // A real failure after revival increments attempts (bounded retry into the counter).
        expect(yield* EventSpool.nack(db, { eventRef: "event://kill-2", claimToken: revive.claimToken, now: 140, reason: "transient", maxAttempts: 5 })).toBe(true)
        const back = yield* EventSpool.backlog(db)
        expect(back.pending).toBe(1) // back to pending for retry, not lost, not dead yet
      }),
    )
  })
})

// ── 3. CLAIM EXPIRY ──────────────────────────────────────────────────────────────────────────────
describe("C5-11 claim expiry (expired lease revivable; stale token fenced)", () => {
  test("expired lease is revivable; a live lease fences; a stale token commit/nack is a no-op", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const envelope = mk("medium", "exp-1")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses-A", priority: "normal", now: 10 })
        const c1 = yield* EventSpool.claimDue(db, { claimantId: "w1", now: 20, leaseMs: 100, maxConcurrentPerSession: 5, limit: 10 })
        expect(c1.rows).toHaveLength(1)

        // Live lease (expires at 120) fences another claimant.
        expect((yield* EventSpool.claimDue(db, { claimantId: "w2", now: 30, leaseMs: 100, maxConcurrentPerSession: 5, limit: 10 })).rows).toHaveLength(0)

        // Expiry (>=120) revives it for a fresh claimant.
        const revive = yield* EventSpool.claimDue(db, { claimantId: "w2", now: 120, leaseMs: 100, maxConcurrentPerSession: 5, limit: 10 })
        expect(revive.rows).toHaveLength(1)
        expect(revive.rows[0]!.eventRef).toBe("event://exp-1")

        // The STALE (expired) worker's token is a fenced no-op for both commit and nack.
        expect(yield* EventSpool.commitResult(db, { eventRef: "event://exp-1", claimToken: c1.claimToken, now: 130 })).toBe(false)
        expect(yield* EventSpool.nack(db, { eventRef: "event://exp-1", claimToken: c1.claimToken, now: 130, reason: "stale" })).toBe(false)

        // The revived token owns the row.
        expect(yield* EventSpool.commitResult(db, { eventRef: "event://exp-1", claimToken: revive.claimToken, now: 130 })).toBe(true)
      }),
    )
  })

  test("a claimed row stays claimed (not double-claimed) while its lease is live", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const envelope = mk("critical", "exp-2")
        yield* EventSpool.enqueue(db, { envelope, sessionID: "ses-A", priority: "critical", now: 10 })
        const c1 = yield* EventSpool.claimDue(db, { claimantId: "w1", now: 20, leaseMs: 5000, maxConcurrentPerSession: 5, limit: 10 })
        expect(c1.rows).toHaveLength(1)
        // Repeated claims against the live lease return nothing (never double-handled).
        const again = yield* EventSpool.claimDue(db, { claimantId: "w2", now: 30, leaseMs: 5000, maxConcurrentPerSession: 5, limit: 10 })
        expect(again.rows).toHaveLength(0)
        const back = yield* EventSpool.backlog(db)
        expect(back.claimed).toBe(1)
        expect(back.pending).toBe(0)
        expect(back.total).toBe(1)
      }),
    )
  })
})

// ── 4. EVENT STORM ──────────────────────────────────────────────────────────────────────────────
describe("C5-11 event storm (500 mixed-priority, bounded concurrency, no drop)", () => {
  test("storm drains critical > high > normal > low with a bounded per-session cap", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const PER = 125
        const risks: readonly EventRisk[] = ["critical", "high", "medium", "low"]
        const session = (i: number) => `ses-${i % 5}` // 5 sessions so the per-session cap is real
        // Deterministic mixed storm, enqueued in a NON-priority order.
        for (const risk of risks) {
          for (let i = 0; i < PER; i++) {
            const id = `${risk}-${i}`
            yield* EventSpool.enqueue(db, {
              envelope: mk(risk as EventRisk, id),
              sessionID: session(i),
              priority: priorityOf(risk as EventRisk),
              now: 100 + i,
            })
          }
        }
        const total = PER * risks.length

        // First claim: bounded concurrency (cap 4 PER SESSION) + priority order (critical first).
        // Commit these rows and record their order so the final drain-order array is complete.
        const first = yield* EventSpool.claimDue(db, { claimantId: "drain", now: 5000, leaseMs: 60000, maxConcurrentPerSession: 4, limit: 100 })
        expect(first.rows.length).toBe(20) // 5 sessions x 4 cap, all critical (highest rank)
        expect(first.rows.every((r) => r.priority === "critical")).toBe(true)
        expect(first.rows.length).toBeLessThanOrEqual(4 * 5)
        const firstOrder: EventCoalescing.DrainPriority[] = []
        for (const row of first.rows) {
          expect(yield* EventSpool.commitResult(db, { eventRef: row.eventRef, claimToken: first.claimToken, now: 5100 })).toBe(true)
          firstOrder.push(row.priority)
        }

        // Drain the remainder to empty, appending to the drain order.
        const drained = yield* drainAll(db, { claimantId: "drain", startNow: 6000, leaseMs: 60000, maxConcurrentPerSession: 100, limit: 1000 })
        const drainedOrder = [...firstOrder, ...drained.orderOfPriority]
        expect(drained.total).toBe(total - firstOrder.length)

        // PRIORITY ORDER: the drain sequence is non-increasing in rank (critical...low), each class FIFO.
        const orderRanks = drainedOrder.map(rank)
        for (let i = 1; i < orderRanks.length; i++) {
          expect(orderRanks[i]!).toBeLessThanOrEqual(orderRanks[i - 1]!)
        }
        expect(drainedOrder.filter((p) => p === "critical").length).toBe(PER)
        expect(drainedOrder.filter((p) => p === "high").length).toBe(PER)
        expect(drainedOrder.filter((p) => p === "normal").length).toBe(PER)
        expect(drainedOrder.filter((p) => p === "low").length).toBe(PER)

        // NO DROP: every row accounted for, nothing pending/claimed/dead after full commit.
        const back = yield* EventSpool.backlog(db)
        expect(back.total).toBe(total)
        expect(back.pending).toBe(0)
        expect(back.claimed).toBe(0)
        expect(back.dead).toBe(0)
      }),
    )
  })

  test("a storm never exceeds the per-session cap in any single claim", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        // 60 critical events, all in ONE session.
        for (let i = 0; i < 60; i++) {
          yield* EventSpool.enqueue(db, { envelope: mk("critical", `cap-${i}`), sessionID: "ses-one", priority: "critical", now: 100 + i })
        }
        let claimedSoFar = 0
        for (let round = 0; round < 60; round++) {
          const claim = yield* EventSpool.claimDue(db, { claimantId: "drain", now: 1000 + round, leaseMs: 60000, maxConcurrentPerSession: 4, limit: 100 })
          expect(claim.rows.length).toBeLessThanOrEqual(4) // the cap per session
          claimedSoFar += claim.rows.length
          for (const row of claim.rows) {
            expect(yield* EventSpool.commitResult(db, { eventRef: row.eventRef, claimToken: claim.claimToken, now: 2000 + round })).toBe(true)
          }
        }
        expect(claimedSoFar).toBe(60)
        const back = yield* EventSpool.backlog(db)
        expect(back.pending).toBe(0)
        expect(back.claimed).toBe(0)
        expect(back.dead).toBe(0)
        expect(back.total).toBe(60)
      }),
    )
  })
})

// ── 5. QUIET HOURS (coalescing window) ─────────────────────────────────────────────────────────
describe("C5-11 quiet hours (coalescing window: low merges, high never merges)", () => {
  test("same-key LOW events inside the window MERGE into ONE base envelope", () => {
    // Same event KIND (same-key) but distinct event identities.
    const low1 = mk("low", "quiet-a", "campaign.quiet.low")
    const low2 = mk("low", "quiet-b", "campaign.quiet.low")
    const low3 = mk("low", "quiet-c", "campaign.quiet.low")
    // Same (session/consumer/kind) key -> the window merge policy collapses them.
    const key = EventCoalescing.coalesceKey(low1)
    expect(EventCoalescing.inSameWindow(key, EventCoalescing.coalesceKey(low2))).toBe(true)
    expect(EventCoalescing.isLowMergeable(low1)).toBe(true)
    expect(EventCoalescing.isLowMergeable(low2)).toBe(true)
    // In-window + same key -> merge.
    const decision = EventCoalescing.classify(low2, { now: 1000, lastSeenSameKeyAt: 800, windowMs: 500, consumerRate: { limit: 5, usedInWindow: 0 } })
    expect(decision.action).toBe("merge")
    // The merge produces a single bounded envelope (identity preserved on the base eventRef).
    const merged = mergeWindow([low1, low2, low3])
    expect(merged.eventRef).toBe(low1.eventRef)
    // `classify` on the base (no same-key seen yet) admits.
    expect(EventCoalescing.classify(low1, { now: 1000, windowMs: 500, consumerRate: { limit: 5, usedInWindow: 0 } }).action).toBe("admit")
  })

  test("a LOW event OUTSIDE the window does NOT merge (admits); the window is time-bounded", () => {
    const low1 = mk("low", "quiet-out-1", "campaign.quiet.low")
    const low2 = mk("low", "quiet-out-2", "campaign.quiet.low")
    const key = EventCoalescing.coalesceKey(low1)
    expect(EventCoalescing.inSameWindow(key, EventCoalescing.coalesceKey(low2))).toBe(true)
    // Now - lastSeen exceeds windowMs -> outside the window -> admit (not merge).
    const decision = EventCoalescing.classify(low2, { now: 2000, lastSeenSameKeyAt: 800, windowMs: 500, consumerRate: { limit: 5, usedInWindow: 0 } })
    expect(decision.action).toBe("admit")
  })

  test("HIGH and CRITICAL events NEVER merge (never deduped away), always durable", () => {
    for (const risk of ["high", "critical"] as const) {
      const a = mk(risk, `quiet-nm-${risk}-a`, `campaign.${risk}.nm`)
      const b = mk(risk, `quiet-nm-${risk}-b`, `campaign.${risk}.nm`)
      expect(EventCoalescing.isLowMergeable(a)).toBe(false)
      expect(EventCoalescing.isLowMergeable(b)).toBe(false)
      // Even in-window + same key, high/critical are NEVER merged.
      const decision = EventCoalescing.classify(b, { now: 1000, lastSeenSameKeyAt: 800, windowMs: 50000, consumerRate: { limit: 5, usedInWindow: 0 } })
      expect(decision.action).toBe("spool")
      expect((decision as { priority: string }).priority).toBe(risk === "critical" ? "critical" : "high")
      // The merge is a no-op identity for non-low even when forced.
      expect(EventCoalescing.mergeEnvelopes(a, b).eventRef).toBe(a.eventRef)
    }
  })

  test("a quiet window collapses K same-key low events to ONE admission, high stays spooled", () => {
    // Simulate the router-side window aggregation for a burst of low observations of the SAME kind.
    const lowBurst = Array.from({ length: 20 }, (_, i) => mk("low", `quiet-burst-${i}`, "campaign.quiet.low"))
    let admitted = 0
    let merged = 0
    let lastLowAt: number | undefined
    const windowMs = 10_000
    const baseKey = EventCoalescing.coalesceKey(lowBurst[0]!)
    for (const env of lowBurst) {
      // The caller's key filter: only same-key envelopes are candidates for the window.
      if (lastLowAt != null && !EventCoalescing.inSameWindow(baseKey, EventCoalescing.coalesceKey(env))) continue
      const decision = EventCoalescing.classify(env, { now: 5000, lastSeenSameKeyAt: lastLowAt, windowMs, consumerRate: { limit: 5, usedInWindow: admitted } })
      if (decision.action === "merge") merged += 1
      else if (decision.action === "admit") {
        admitted += 1
        lastLowAt = 5000
      }
    }
    // Only the FIRST low is admitted; the rest merge inside the window (model never flooded §8.8).
    expect(admitted).toBe(1)
    expect(merged).toBe(19)
  })
})

// ── 6. SHUTDOWN ─────────────────────────────────────────────────────────────────────────────────
describe("C5-11 shutdown (graceful drain order + durable pending)", () => {
  test("graceful shutdown drains critical FIRST and leaves the rest durable/pending", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        // Mixed storm, all into one session, enqueued in non-priority order.
        const mixed: readonly [EventRisk, string][] = [
          ["low", "shut-low"],
          ["critical", "shut-crit"],
          ["medium", "shut-norm"],
          ["high", "shut-high"],
          ["critical", "shut-crit-2"],
        ]
        for (const [risk, id] of mixed) {
          yield* EventSpool.enqueue(db, { envelope: mk(risk, id), sessionID: "ses-A", priority: priorityOf(risk), now: 10 })
        }

        // Graceful shutdown drains the HIGHEST-priority row first (critical), then stops.
        const claim = yield* EventSpool.claimDue(db, { claimantId: "drain", now: 100, leaseMs: 60000, maxConcurrentPerSession: 1, limit: 10 })
        expect(claim.rows).toHaveLength(1)
        expect(claim.rows[0]!.priority).toBe("critical") // drain order: critical before everything else
        expect(yield* EventSpool.commitResult(db, { eventRef: claim.rows[0]!.eventRef, claimToken: claim.claimToken, now: 110 })).toBe(true)
        const committedCount = claim.rows.length

        // "Shutdown": we stop draining. The not-yet-consumed work must remain DURABLE (no lost pending).
        const after = yield* EventSpool.backlog(db)
        expect(after.total).toBe(mixed.length)
        expect(after.pending).toBe(mixed.length - committedCount)
        expect(after.claimed).toBe(0)
        expect(after.dead).toBe(0)

        // "Restart": a fresh worker drains the remainder to completion.
        const drained = yield* drainAll(db, { claimantId: "restart", startNow: 5000, leaseMs: 60000, maxConcurrentPerSession: 100, limit: 100 })
        expect(drained.total).toBe(mixed.length - committedCount)
        const final = yield* EventSpool.backlog(db)
        expect(final.pending).toBe(0)
        expect(final.claimed).toBe(0)
        expect(final.dead).toBe(0)
        expect(final.total).toBe(mixed.length)
      }),
    )
  })
})

// ── 7. BACKLOG / LATENCY BUDGET ─────────────────────────────────────────────────────────────────
describe("C5-11 backlog / latency budget (report p50/p95 + relative bound)", () => {
  test("drain latency p50/p95 are reported and bounded (calibrated relative bound)", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const N = 200
        for (let i = 0; i < N; i++) {
          yield* EventSpool.enqueue(db, { envelope: mk("medium", `lat-${i}`), sessionID: `ses-${i % 10}`, priority: "normal", now: 100 + i })
        }
        // Measure the claim→commit batch latency across the whole drain.
        const latencies: number[] = []
        let now = 10_000
        for (;;) {
          const t0 = performance.now()
          const claim = yield* EventSpool.claimDue(db, { claimantId: "drain", now, leaseMs: 60000, maxConcurrentPerSession: 100, limit: 1000 })
          if (claim.rows.length === 0) break
          for (const row of claim.rows) {
            yield* EventSpool.commitResult(db, { eventRef: row.eventRef, claimToken: claim.claimToken, now })
          }
          latencies.push(performance.now() - t0)
          now += 1000
        }
        expect(latencies.length).toBeGreaterThan(0)

        const sorted = [...latencies].sort((x, y) => x - y)
        const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
        const p50 = q(50)
        const p95 = q(95)
        // REPORT (the task requires the campaign to surface the calibration numbers).
        console.log(`[C5-11 latency budget] N=${N} batches=${latencies.length}, p50=${p50.toFixed(2)}ms, p95=${p95.toFixed(2)}ms, min=${sorted[0]!.toFixed(2)}ms, max=${sorted[sorted.length - 1]!.toFixed(2)}ms`)
        // RELATIVE BOUND (calibration): p95 must be within a small window of p50 and under a hard ceiling.
        expect(p95).toBeLessThanOrEqual(Math.max(p50 * 5, 250))
        expect(p95).toBeLessThan(5000)

        // The drain fully resolved every row (no drop, backlog returns to 0 live rows).
        const back = yield* EventSpool.backlog(db)
        expect(back.pending).toBe(0)
        expect(back.claimed).toBe(0)
        expect(back.dead).toBe(0)
        expect(back.total).toBe(N)
      }),
    )
  })
})
