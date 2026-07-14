import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { DeepAgentEventTable, DeepAgentEventDropTable } from "@deepagent-code/core/deepagent/deepagent-event-sql"
import { Database } from "@deepagent-code/core/database/database"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

// A deterministic mutable clock so retry-backoff / dedupe-window assertions are exact.
let clock = 0
const setNow = (t: number) => {
  clock = t
}
const now = () => clock

const database = Database.layerFromPath(":memory:")
const busLayer = DeepAgentEventBus.layerWith({ maxAttempts: 3, backoffBaseMs: 1000, now }).pipe(
  Layer.provideMerge(database),
)
const it = testEffect(busLayer)

const input = (over?: Partial<DeepAgentEvent.PublishInput>): DeepAgentEvent.PublishInput => ({
  type: "ci.failure",
  source: "ci",
  workspaceID: "wrk_1",
  payload: { failedTests: 2 },
  ...over,
})

describe("DeepAgentEventBus", () => {
  it.effect("§A3 持久化: publish returns a full normalized event and stores it", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const bus = yield* DeepAgentEventBus.Service
      const event = yield* bus.publish(input())
      expect(event.id.startsWith("dae_")).toBe(true)
      expect(event.type).toBe("ci.failure")
      expect(event.source).toBe("ci")
      expect(event.priority).toBe("normal") // default filled by the bus
      expect(event.createdAt).toBe(1_000)
      expect(event.idempotencyKey).toBeString() // defaulted when omitted
      // durable: it comes back from replay history
      const replayed = yield* Stream.runCollect(bus.replay({ from: 0 })).pipe(Effect.map((c) => Array.from(c)))
      expect(replayed.map((e) => e.id)).toEqual([event.id])
    }),
  )

  it.effect("§A3 幂等: a re-publish with the same idempotency key is a no-op returning the original", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const first = yield* bus.publish(input({ idempotencyKey: "k-1" }))
      const second = yield* bus.publish(input({ idempotencyKey: "k-1", payload: { changed: true } }))
      expect(second.id).toBe(first.id) // same row, no second event
      expect(second.payload).toEqual(first.payload) // original payload preserved
      const all = yield* Stream.runCollect(bus.replay({ from: 0 })).pipe(Effect.map((c) => Array.from(c)))
      expect(all.length).toBe(1)
    }),
  )

  it.effect("§A2 subscribe: a live subscriber receives events published after subscription", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const fiber = yield* bus.subscribe({}).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* bus.publish(input({ idempotencyKey: "s-1" }))
      yield* bus.publish(input({ idempotencyKey: "s-2", type: "git.push", source: "git" }))
      const received = Array.from(yield* Fiber.join(fiber))
      expect(received.map((e) => e.type)).toEqual(["ci.failure", "git.push"])
    }),
  )

  it.effect("§A2 subscribe by type: filter delivers only the matching type", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const fiber = yield* bus
        .subscribe({ type: "git.push" })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* bus.publish(input({ idempotencyKey: "f-1", type: "ci.failure", source: "ci" }))
      yield* bus.publish(input({ idempotencyKey: "f-2", type: "git.push", source: "git" }))
      const received = Array.from(yield* Fiber.join(fiber))
      expect(received.map((e) => e.type)).toEqual(["git.push"])
    }),
  )

  it.effect("§A2 replay: durable history is filtered by type and time window", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      setNow(100)
      yield* bus.publish(input({ idempotencyKey: "r-1", type: "ci.failure", source: "ci" }))
      setNow(200)
      yield* bus.publish(input({ idempotencyKey: "r-2", type: "git.push", source: "git" }))
      setNow(300)
      yield* bus.publish(input({ idempotencyKey: "r-3", type: "ci.failure", source: "ci" }))

      const cis = yield* Stream.runCollect(bus.replay({ type: "ci.failure", from: 0 })).pipe(
        Effect.map((c) => Array.from(c)),
      )
      expect(cis.map((e) => e.idempotencyKey)).toEqual(["r-1", "r-3"])

      const windowed = yield* Stream.runCollect(bus.replay({ from: 150, to: 250 })).pipe(
        Effect.map((c) => Array.from(c)),
      )
      expect(windowed.map((e) => e.idempotencyKey)).toEqual(["r-2"])
    }),
  )

  it.effect("§A2 ack: marks a (event, group) delivery delivered (idempotent)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const event = yield* bus.publish(input({ idempotencyKey: "a-1" }))
      yield* bus.ack("router", event.id)
      yield* bus.ack("router", event.id) // idempotent — no throw, no dup
      const dead = yield* bus.deadLetters()
      expect(dead.length).toBe(0)
      const due = yield* bus.dueRetries()
      expect(due.length).toBe(0) // delivered rows are not retry-eligible
    }),
  )

  it.effect("§A3 重试: nack schedules exponential backoff (base × 2^(n-1))", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      setNow(10_000)
      const event = yield* bus.publish(input({ idempotencyKey: "n-1" }))
      yield* bus.nack({ subscriptionGroup: "router", eventID: event.id, reason: "boom" })
      // attempt 1 → next at now + 1000 * 2^0 = 11_000
      let due = yield* bus.dueRetries(11_000)
      expect(due.map((d) => d.eventID)).toEqual([event.id])
      expect(due[0]?.attempts).toBe(1)
      // not yet due just before the backoff elapses
      const early = yield* bus.dueRetries(10_999)
      expect(early.length).toBe(0)

      yield* bus.nack({ subscriptionGroup: "router", eventID: event.id, reason: "boom again" })
      // attempt 2 → next at now + 1000 * 2^1 = 12_000
      due = yield* bus.dueRetries(11_999)
      expect(due.length).toBe(0)
      due = yield* bus.dueRetries(12_000)
      expect(due[0]?.attempts).toBe(2)
    }),
  )

  it.effect("§A Dead Letter: exceeding maxAttempts flips the delivery to the DLQ", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      setNow(0)
      const event = yield* bus.publish(input({ idempotencyKey: "d-1" }))
      // maxAttempts = 3 → attempts 1,2 pending; attempt 3 is dead.
      yield* bus.nack({ subscriptionGroup: "router", eventID: event.id, reason: "1" })
      yield* bus.nack({ subscriptionGroup: "router", eventID: event.id, reason: "2" })
      yield* bus.nack({ subscriptionGroup: "router", eventID: event.id, reason: "3" })
      const dead = yield* bus.deadLetters()
      expect(dead.map((d) => d.eventID)).toEqual([event.id])
      expect(dead[0]?.status).toBe("dead")
      expect(dead[0]?.attempts).toBe(3)
      expect(dead[0]?.lastError).toBe("3")
      // a dead delivery is not retry-eligible
      const due = yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)
      expect(due.length).toBe(0)
    }),
  )

  it.effect("§A3 DLQ alert: a delivery flipping to dead emits ONE dlq.alert (idempotent, no self-cascade)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      setNow(0)
      const event = yield* bus.publish(input({ idempotencyKey: "alert-1" }))
      // no alert before the delivery dies (attempts 1,2 are still pending retries).
      yield* bus.nack({ subscriptionGroup: "router", eventID: event.id, reason: "1" })
      yield* bus.nack({ subscriptionGroup: "router", eventID: event.id, reason: "2" })
      let alerts = yield* bus.recentByType({ type: "dlq.alert", windowMs: Number.MAX_SAFE_INTEGER, now: 0 })
      expect(alerts.length).toBe(0)
      // the third nack flips it to dead → exactly one alert, carrying the dead event's id + reason.
      yield* bus.nack({ subscriptionGroup: "router", eventID: event.id, reason: "3" })
      alerts = yield* bus.recentByType({ type: "dlq.alert", windowMs: Number.MAX_SAFE_INTEGER, now: 0 })
      expect(alerts.length).toBe(1)
      expect(alerts[0]?.priority).toBe("high")
      expect(alerts[0]?.source).toBe("system")
      const payload = alerts[0]?.payload as { deadEventID?: string; subscriptionGroup?: string; reason?: string }
      expect(payload.deadEventID).toBe(event.id)
      expect(payload.subscriptionGroup).toBe("router")
      expect(payload.reason).toBe("3")
      // re-nacking an already-dead delivery must NOT emit a second alert (idempotent on event+group).
      yield* bus.nack({ subscriptionGroup: "router", eventID: event.id, reason: "again" })
      alerts = yield* bus.recentByType({ type: "dlq.alert", windowMs: Number.MAX_SAFE_INTEGER, now: 0 })
      expect(alerts.length).toBe(1)
    }),
  )

  it.effect("§A4 event_dropped: recordDrop persists a queryable drop row (best-effort, never fails)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const { db } = yield* Database.Service
      setNow(1_000)
      const event = yield* bus.publish(input({ idempotencyKey: "drop-1" }))
      // recording a drop is a total effect — it resolves without failing.
      yield* bus.recordDrop({ event, reason: "backpressure" })
      const rows = yield* db.select().from(DeepAgentEventDropTable).all().pipe(Effect.orDie)
      expect(rows.length).toBe(1)
      expect(rows[0]?.event_id).toBe(event.id)
      expect(rows[0]?.reason).toBe("backpressure")
      expect(rows[0]?.workspace_id).toBe("wrk_1")
      expect(rows[0]?.priority).toBe("normal")
    }),
  )

  it.effect(
    "§A4 event_dropped DISTINCT: re-shedding the SAME event ×3 records ONE drop row (counts distinct events, not attempts)",
    () =>
      Effect.gen(function* () {
        const bus = yield* DeepAgentEventBus.Service
        const { db } = yield* Database.Service
        setNow(1_000)
        const event = yield* bus.publish(input({ idempotencyKey: "reshed-1" }))
        // the §A4 backpressure path calls recordDrop on EVERY shed pass: shed → nack → re-shed ×3.
        yield* bus.recordDrop({ event, reason: "backpressure" })
        yield* bus.recordDrop({ event, reason: "backpressure" })
        yield* bus.recordDrop({ event, reason: "backpressure" })
        const rows = yield* db
          .select()
          .from(DeepAgentEventDropTable)
          .where(eq(DeepAgentEventDropTable.event_id, event.id))
          .all()
          .pipe(Effect.orDie)
        // onConflictDoNothing on the UNIQUE event_id index → one distinct event == one row.
        expect(rows.length).toBe(1)
      }),
  )

  it.effect(
    "§A4 event_dropped DISTINCT: two DIFFERENT events shed record TWO rows (event_dropped_total == 2)",
    () =>
      Effect.gen(function* () {
        const bus = yield* DeepAgentEventBus.Service
        const { db } = yield* Database.Service
        setNow(2_000)
        const a = yield* bus.publish(input({ idempotencyKey: "distinct-a" }))
        const b = yield* bus.publish(input({ idempotencyKey: "distinct-b" }))
        yield* bus.recordDrop({ event: a, reason: "backpressure" })
        yield* bus.recordDrop({ event: a, reason: "backpressure" }) // a re-shed of a → no-op
        yield* bus.recordDrop({ event: b, reason: "backpressure" })
        const all = yield* db.select().from(DeepAgentEventDropTable).all().pipe(Effect.orDie)
        expect(all.length).toBe(2)
      }),
  )

  it.effect("§A4 去重窗口: recentByType returns same-type events inside the window only", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      setNow(50_000)
      yield* bus.publish(input({ idempotencyKey: "w-old", type: "monitor.alert", source: "monitor" }))
      setNow(55_000)
      yield* bus.publish(input({ idempotencyKey: "w-new", type: "monitor.alert", source: "monitor" }))
      // window 10s at now=61_000: 50_000 is outside (11s old), 55_000 inside (6s old).
      const recent = yield* bus.recentByType({ type: "monitor.alert", now: 61_000 })
      expect(recent.map((e) => e.idempotencyKey)).toEqual(["w-new"])
    }),
  )

  it.effect(
    "§A3 at-least-once: a grouped subscriber gets a durable pending delivery on publish (recoverable without nack)",
    () =>
      Effect.gen(function* () {
        setNow(0)
        const bus = yield* DeepAgentEventBus.Service
        // a durable consumer group goes live BEFORE the publish
        const fiber = yield* bus
          .subscribe({ group: "router" })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Effect.yieldNow
        const event = yield* bus.publish(input({ idempotencyKey: "alo-1" }))
        yield* Fiber.join(fiber)
        // the subscriber received it but has NOT acked — at-least-once means a pending row exists,
        // so a crash before ack is recoverable via dueRetries (not silently lost).
        const due = yield* bus.dueRetries(0)
        expect(due.map((d) => ({ id: d.eventID, group: d.subscriptionGroup, status: d.status }))).toEqual([
          { id: event.id, group: "router", status: "pending" },
        ])
        expect(due[0]?.attempts).toBe(0) // no failed attempt yet — just owed
        // once acked, it drops out of the retry-eligible set
        yield* bus.ack("router", event.id)
        const afterAck = yield* bus.dueRetries(0)
        expect(afterAck.length).toBe(0)
      }),
  )

  it.effect("§A3 at-least-once: an anonymous (group-less) subscriber creates NO delivery tracking", () =>
    Effect.gen(function* () {
      setNow(0)
      const bus = yield* DeepAgentEventBus.Service
      const fiber = yield* bus.subscribe({}).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* bus.publish(input({ idempotencyKey: "anon-1" }))
      yield* Fiber.join(fiber)
      const due = yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)
      expect(due.length).toBe(0) // observers are best-effort live-only, no durable delivery owed
    }),
  )

  it.effect("getByID returns the durable event (and undefined for an unknown id)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const event = yield* bus.publish(input({ idempotencyKey: "gid-1" }))
      const found = yield* bus.getByID(event.id)
      expect(found?.id).toBe(event.id)
      expect(found?.idempotencyKey).toBe("gid-1")
      const missing = yield* bus.getByID("dae_does_not_exist" as typeof event.id)
      expect(missing).toBeUndefined()
    }),
  )

  it.effect("§A4/多租户: recentByType scoped to a workspace never returns another tenant's events", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      setNow(5_000)
      yield* bus.publish(input({ idempotencyKey: "t-a", type: "monitor.alert", source: "monitor", workspaceID: "wrk_a" }))
      yield* bus.publish(input({ idempotencyKey: "t-b", type: "monitor.alert", source: "monitor", workspaceID: "wrk_b" }))
      const scoped = yield* bus.recentByType({ type: "monitor.alert", workspaceID: "wrk_a", now: 6_000 })
      expect(scoped.map((e) => e.idempotencyKey)).toEqual(["t-a"])
      const unscoped = yield* bus.recentByType({ type: "monitor.alert", now: 6_000 })
      expect(unscoped.length).toBe(2) // cross-tenant scan still sees both
    }),
  )

  it.effect("§A3 correlation: ack for one group leaves another group's delivery independent", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      setNow(0)
      const event = yield* bus.publish(input({ idempotencyKey: "g-1" }))
      yield* bus.ack("group-a", event.id)
      yield* bus.nack({ subscriptionGroup: "group-b", eventID: event.id, reason: "b failed" })
      const due = yield* bus.dueRetries(Number.MAX_SAFE_INTEGER)
      expect(due.map((d) => d.subscriptionGroup)).toEqual(["group-b"]) // only b pending
    }),
  )
})

describe("DeepAgentEventBus.tryPublish (§A4/§E2 rate gate)", () => {
  it.effect("low/normal over the limit is dropped (not persisted); under the limit publishes", () =>
    Effect.gen(function* () {
      setNow(0)
      const bus = yield* DeepAgentEventBus.Service
      // limit=2 for wrk_1: first two admitted, third dropped.
      const r1 = yield* bus.tryPublish(input({ idempotencyKey: "tp-1" }), { limit: 2 })
      const r2 = yield* bus.tryPublish(input({ idempotencyKey: "tp-2" }), { limit: 2 })
      const r3 = yield* bus.tryPublish(input({ idempotencyKey: "tp-3" }), { limit: 2 })
      expect("published" in r1).toBe(true)
      expect("published" in r2).toBe(true)
      expect(r3).toEqual({ dropped: "rate_limited" })
      // the dropped event was NOT persisted — only the two admitted rows are in the log.
      const all = yield* Stream.runCollect(bus.replay({ from: 0 })).pipe(Effect.map((c) => Array.from(c)))
      expect(all.map((e) => e.idempotencyKey).sort()).toEqual(["tp-1", "tp-2"])
    }),
  )

  it.effect("high/critical ALWAYS publish even over the limit (§A4 priority bypass)", () =>
    Effect.gen(function* () {
      setNow(0)
      const bus = yield* DeepAgentEventBus.Service
      // exhaust the limit=1 window with a normal event
      yield* bus.tryPublish(input({ idempotencyKey: "pb-normal" }), { limit: 1 })
      const dropped = yield* bus.tryPublish(input({ idempotencyKey: "pb-normal-2" }), { limit: 1 })
      expect(dropped).toEqual({ dropped: "rate_limited" })
      // high + critical bypass the exhausted ceiling
      const hi = yield* bus.tryPublish(input({ idempotencyKey: "pb-high", priority: "high" }), { limit: 1 })
      const crit = yield* bus.tryPublish(input({ idempotencyKey: "pb-crit", priority: "critical" }), { limit: 1 })
      expect("published" in hi).toBe(true)
      expect("published" in crit).toBe(true)
    }),
  )

  it.effect("the ceiling is per-workspace (one tenant hitting the limit never sheds another's)", () =>
    Effect.gen(function* () {
      setNow(0)
      const bus = yield* DeepAgentEventBus.Service
      // wrk_a exhausts its limit=1
      yield* bus.tryPublish(input({ idempotencyKey: "iso-a1", workspaceID: "wrk_a" }), { limit: 1 })
      const aDrop = yield* bus.tryPublish(input({ idempotencyKey: "iso-a2", workspaceID: "wrk_a" }), { limit: 1 })
      expect(aDrop).toEqual({ dropped: "rate_limited" })
      // wrk_b has its own bucket — still admitted
      const bOk = yield* bus.tryPublish(input({ idempotencyKey: "iso-b1", workspaceID: "wrk_b" }), { limit: 1 })
      expect("published" in bOk).toBe(true)
    }),
  )

  it.effect("the window resets on the injected clock (a fresh window re-admits)", () =>
    Effect.gen(function* () {
      setNow(0)
      const bus = yield* DeepAgentEventBus.Service
      yield* bus.tryPublish(input({ idempotencyKey: "win-1" }), { limit: 1 })
      const dropped = yield* bus.tryPublish(input({ idempotencyKey: "win-2" }), { limit: 1 })
      expect(dropped).toEqual({ dropped: "rate_limited" })
      // cross the 60s fixed window → fresh bucket admits again
      setNow(60_001)
      const after = yield* bus.tryPublish(input({ idempotencyKey: "win-3" }), { limit: 1 })
      expect("published" in after).toBe(true)
    }),
  )

  // §E2 END-TO-END: the ceiling that is enforced for real producer traffic. Proves in ONE test the full
  // contract the production wiring relies on — under the ceiling low/normal publish + persist; over it
  // they are dropped + NOT persisted; high/critical always pass even while the window is exhausted.
  it.effect("enforced ceiling: under it low/normal persist; over it dropped (not persisted); high/critical pass", () =>
    Effect.gen(function* () {
      setNow(0)
      const bus = yield* DeepAgentEventBus.Service
      const wrk = "wrk_enforced"
      // (1) under the ceiling (limit=3): three normal publishes admitted + persisted.
      for (const k of ["e-1", "e-2", "e-3"]) {
        const r = yield* bus.tryPublish(input({ idempotencyKey: k, workspaceID: wrk }), { limit: 3 })
        expect("published" in r).toBe(true)
      }
      // (2) over the ceiling within the window: normal is dropped and NOT persisted.
      const over = yield* bus.tryPublish(input({ idempotencyKey: "e-over", workspaceID: wrk }), { limit: 3 })
      expect(over).toEqual({ dropped: "rate_limited" })
      // (3) high + critical STILL pass while the window is exhausted (priority bypass).
      const hi = yield* bus.tryPublish(input({ idempotencyKey: "e-hi", workspaceID: wrk, priority: "high" }), {
        limit: 3,
      })
      const crit = yield* bus.tryPublish(
        input({ idempotencyKey: "e-crit", workspaceID: wrk, priority: "critical" }),
        { limit: 3 },
      )
      expect("published" in hi).toBe(true)
      expect("published" in crit).toBe(true)
      // durable log holds exactly the admitted five — the dropped "e-over" left NO row.
      const persisted = yield* Stream.runCollect(bus.replay({ workspaceID: wrk, from: 0 })).pipe(
        Effect.map((c) => Array.from(c)),
      )
      expect(persisted.map((e) => e.idempotencyKey).sort()).toEqual(["e-1", "e-2", "e-3", "e-crit", "e-hi"])
    }),
  )
})

describe("DeepAgentEventBus.sweepPublishLimiter (§E2 bucket prune)", () => {
  it.effect("prunes only elapsed-window buckets and re-admits after the prune", () =>
    Effect.gen(function* () {
      setNow(0)
      const bus = yield* DeepAgentEventBus.Service
      // exhaust wrk_a's window (limit=1) — its bucket resetAt = 0 + 60_000.
      yield* bus.tryPublish(input({ idempotencyKey: "sw-a1", workspaceID: "wrk_a" }), { limit: 1 })
      const aDrop = yield* bus.tryPublish(input({ idempotencyKey: "sw-a2", workspaceID: "wrk_a" }), { limit: 1 })
      expect(aDrop).toEqual({ dropped: "rate_limited" })

      // BEFORE the window elapses a sweep prunes nothing (the bucket is still live).
      const early = yield* bus.sweepPublishLimiter(59_999)
      expect(early.prunedBuckets).toBe(0)
      // and the ceiling is still enforced at that instant.
      const stillDrop = yield* bus.tryPublish(input({ idempotencyKey: "sw-a3", workspaceID: "wrk_a" }), { limit: 1 })
      expect(stillDrop).toEqual({ dropped: "rate_limited" })

      // AFTER the window elapses the stale bucket is pruned (bounding memory for the idle workspace).
      const pruned = yield* bus.sweepPublishLimiter(60_001)
      expect(pruned.prunedBuckets).toBe(1)
      // a fresh window re-admits (the pruned bucket is recreated on the next hit).
      setNow(60_002)
      const after = yield* bus.tryPublish(input({ idempotencyKey: "sw-a4", workspaceID: "wrk_a" }), { limit: 1 })
      expect("published" in after).toBe(true)
    }),
  )
})

describe("DeepAgentEventBus.sweep (§A3 retention referential safety)", () => {
  it.effect("spares a dead event still referenced by a LIVE dlq.alert; still sweeps an unreferenced one", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service

      // Two old events (both past the retention cutoff we'll sweep with):
      //   `dead`   — will be dead-lettered and referenced by a dlq.alert.
      //   `orphan` — the control: old, unreferenced, must still be swept.
      setNow(1_000)
      const dead = yield* bus.publish(input({ idempotencyKey: "sweep-dead-1" }))
      const orphan = yield* bus.publish(input({ idempotencyKey: "sweep-orphan-1" }))

      // Drive `dead`'s delivery to the DLQ much later (inside the retention window). The 3rd nack flips
      // it to "dead" and emits ONE real dlq.alert via emitDlqAlert — carrying causationID = dead.id AND
      // payload.deadEventID = dead.id (the two fields the sweep predicate keys on). A "dead" delivery on
      // its own does NOT protect an event; only the live dlq.alert reference does.
      setNow(50_000)
      yield* bus.nack({ subscriptionGroup: "router", eventID: dead.id, reason: "1" })
      yield* bus.nack({ subscriptionGroup: "router", eventID: dead.id, reason: "2" })
      yield* bus.nack({ subscriptionGroup: "router", eventID: dead.id, reason: "3" })
      const alerts = yield* bus.recentByType({ type: "dlq.alert", windowMs: Number.MAX_SAFE_INTEGER, now: 50_000 })
      expect(alerts.length).toBe(1) // the alert is live (createdAt 50_000)
      expect((alerts[0]?.payload as { deadEventID?: string }).deadEventID).toBe(dead.id)
      expect(alerts[0]?.causationID).toBe(dead.id)

      // Sweep with a cutoff PAST both old events but BEFORE the live alert.
      const { deletedEvents } = yield* bus.sweep({ workspaceID: "wrk_1", olderThan: 2_000 })

      // Only the unreferenced `orphan` is swept — the sweep still works. `dead` is SPARED because a live
      // dlq.alert still references it, so no dangling trace reference is left behind.
      expect(deletedEvents).toBe(1)
      expect(yield* bus.getByID(dead.id)).toBeDefined() // protected by the live dlq.alert
      expect(yield* bus.getByID(orphan.id)).toBeUndefined() // no ref → swept
      // the alert itself survives (newer than the cutoff), so the reference stays live rather than dangling.
      const after = yield* bus.recentByType({ type: "dlq.alert", windowMs: Number.MAX_SAFE_INTEGER, now: 50_000 })
      expect(after.length).toBe(1)
    }),
  )
})

describe("DeepAgentEventBus publish latency (§F1)", () => {
  it.effect("publish records publish_latency_ms on the row (the clock delta around persist)", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* DeepAgentEventBus.Service
      // with a frozen clock the before/after reads are equal → latency is 0 (populated, NOT null).
      setNow(1_000)
      const ev = yield* bus.publish(input({ idempotencyKey: "lat-1" }))
      const row = yield* db
        .select({ ms: DeepAgentEventTable.publish_latency_ms })
        .from(DeepAgentEventTable)
        .where(eq(DeepAgentEventTable.id, ev.id))
        .get()
        .pipe(Effect.orDie)
      expect(row?.ms).toBe(0)
    }),
  )
})
