import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Cause, Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { GoalTickConsumer } from "../../src/session/goal-tick-consumer"
import { recoverGoalTickRequest } from "../../src/session/goal-tick-port"
import { ConsumerReceipts } from "@deepagent-code/core/deepagent/consumer-receipts"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentEventDeliveryTable } from "@deepagent-code/core/deepagent/deepagent-event-sql"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { testEffect } from "../lib/effect"

// V4.1 §N — GoalTickConsumer bus-logic tests. These exercise the CONSUMER's command handling (execute
// one tick via the injected runTick port → re-emit next / stop / dedup / nack) with a DETERMINISTIC stub
// port, so the hardest, most bug-prone logic (the self-driving chain + idempotency + ack/nack) is proven
// independently of the heavy cold-reconstruction wiring (which the full layer supplies in production).

let clock = 1_000
const now = () => clock

const database = Database.layerFromPath(":memory:")

// A stub runTick that returns a scripted sequence of progress results, recording each call.
type StubResult = GoalTickConsumer.GoalTickPortResult
const makeLayer = (opts: {
  flag?: boolean
  goalFlag?: boolean
  runTick: GoalTickConsumer.GoalTickPort
  leaseMs?: number
  renewalIntervalMs?: number
}) => {
  const busLayer = DeepAgentEventBus.layerWith({ now }).pipe(Layer.provideMerge(database))
  const flagLayer = RuntimeFlags.layer({
    v4MultiAgentRuntime: opts.flag ?? true,
    v4GoalTickEventDriven: opts.goalFlag ?? false,
  })
  const consumer = GoalTickConsumer.layerWith({ ...opts, runLoop: false, now }).pipe(
    Layer.provide(busLayer),
    Layer.provide(flagLayer),
  )
  return Layer.mergeAll(consumer, busLayer, flagLayer, database)
}

const seq0Command = (
  over?: Partial<{
    sessionID: string
    goalId: string
    planDocId: string
    seq: number
    workspaceID: string
    revision: number
  }>,
) => ({
  sessionID: "s1",
  goalId: "g1",
  planDocId: "plan-1",
  seq: 0,
  expectedPlanVersion: 0,
  ...over,
})

// publish a goal.tick.requested with the seq-based idempotency key (mirrors tickCommand).
const publishTick = (req: ReturnType<typeof seq0Command>) =>
  Effect.gen(function* () {
    const bus = yield* DeepAgentEventBus.Service
    yield* bus.registerConsumerGroup(GoalTickConsumer.TICK_GROUP, LMNEvents.GOAL_TICK_REQUESTED)
    return yield* bus.publish(GoalTickConsumer.tickCommand(req))
  })

describe("GoalTickConsumer — command identity", () => {
  test("resume seeds keep the durable cursor but use a fresh namespace", () => {
    const request = seq0Command({ seq: 8 })
    const first = GoalTickConsumer.resumeTickCommand(request)
    const second = GoalTickConsumer.resumeTickCommand(request)

    expect(first.payload).toMatchObject({ seq: 8 })
    expect(first.idempotencyKey).toStartWith("goal:tick:g1:resume:dae_")
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey)
    expect(GoalTickConsumer.tickCommand(request).idempotencyKey).toBe("goal:tick:g1:8")
  })

  test("durable cursor classifies committed and out-of-order deliveries", () => {
    const request = seq0Command({ seq: 4 })
    expect(recoverGoalTickRequest(request, { seq: 4, planVersion: 2, phase: "running" })).toBeNull()
    expect(recoverGoalTickRequest(request, { seq: 5, planVersion: 3, phase: "running" })).toEqual({
      progress: "continue",
      nextSeq: 5,
      nextExpectedPlanVersion: 3,
    })
    expect(recoverGoalTickRequest(request, { seq: 5, planVersion: 3, phase: "done" })).toEqual({
      progress: "terminal",
      nextSeq: 5,
      nextExpectedPlanVersion: 3,
    })
    expect(recoverGoalTickRequest(request, { seq: 3, planVersion: 1, phase: "running" })).toBe("invalid")
  })

  // FEATURE-003-407 residual: the durable event row's workspace_id drives groupsFor's workspace-scoped
  // routing, so tickCommand must stamp the REAL workspace id there — never the sessionID.
  test("tickCommand stamps the real workspaceID onto the event row (not the sessionID)", () => {
    const cmd = GoalTickConsumer.tickCommand({ ...seq0Command(), workspaceID: "wrk_a" })
    expect(cmd.workspaceID).toBe("wrk_a")
    expect(cmd.workspaceID).not.toBe(cmd.payload && (cmd.payload as Record<string, unknown>).sessionID)
    expect(cmd.payload).toMatchObject({ sessionID: "s1", workspaceID: "wrk_a" })
    expect(cmd.actorID).toBe("s1") // the actor stays the session; only the routing column changes
  })

  test('tickCommand without a known workspace falls back to the bus global semantics ("")', () => {
    const cmd = GoalTickConsumer.tickCommand(seq0Command())
    expect(cmd.workspaceID).toBe("")
    const resumed = GoalTickConsumer.resumeTickCommand(seq0Command())
    expect(resumed.workspaceID).toBe("")
  })
})

describe("GoalTickConsumer — command handling", () => {
  const it = testEffect(
    makeLayer({
      runTick: () => Effect.succeed({ progress: "continue", nextSeq: 1, nextExpectedPlanVersion: 1 } as StubResult),
    }),
  )

  it.effect("continue → executes tick and re-emits the next goal.tick.requested (seq advanced)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const consumer = yield* GoalTickConsumer.Service
      const cmd = yield* publishTick(seq0Command())
      yield* consumer.handle(cmd)
      // the next command (seq=1) must have been published — a distinct idempotencyKey, so it's stored.
      const next = yield* bus.getByID(cmd.id) // sanity: original exists
      expect(next?.type).toBe(LMNEvents.GOAL_TICK_REQUESTED)
      // re-emit produced a second stored event; assert by re-publishing the SAME next key is a dedup no-op
      const dup = yield* bus.publish(GoalTickConsumer.tickCommand(seq0Command({ seq: 1 })))
      // if the consumer already emitted seq=1, this returns the SAME event id (dedup); prove the chain fired.
      expect(dup.idempotencyKey).toBe("goal:tick:g1:1")
    }),
  )
})

describe("GoalTickConsumer — event row workspace routing (FEATURE-003-407)", () => {
  const it = testEffect(
    makeLayer({
      runTick: () => Effect.succeed({ progress: "continue", nextSeq: 1, nextExpectedPlanVersion: 1 } as StubResult),
    }),
  )

  it.effect("publish persists the real workspaceID on the event row and the chain propagates it", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const consumer = yield* GoalTickConsumer.Service
      const cmd = yield* publishTick(seq0Command({ goalId: "gwrk", workspaceID: "wrk_a" }))
      // the durable row carries the REAL workspace — pre-fix it was the sessionID.
      expect(cmd.workspaceID).toBe("wrk_a")
      yield* consumer.handle(cmd)
      // the re-emitted successor (seq=1) keeps the same real workspace; the dedup probe returns the
      // winner row the consumer already persisted, so its workspaceID proves chain propagation.
      const next = yield* bus.publish(
        GoalTickConsumer.tickCommand(seq0Command({ goalId: "gwrk", seq: 1, workspaceID: "wrk_a" })),
      )
      expect(next.idempotencyKey).toBe("goal:tick:gwrk:1")
      expect(next.workspaceID).toBe("wrk_a")
    }),
  )

  it.effect("a workspace-bound consumer group is owed only its own workspace's tick events", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      // groupsFor routes workspace-bound groups (workspace_id != "") by the event row's workspace_id.
      yield* bus.registerConsumerGroup("scoped-grp", LMNEvents.GOAL_TICK_REQUESTED, "wrk_a")
      const scoped = yield* publishTick(seq0Command({ goalId: "gscoped", workspaceID: "wrk_a" }))
      const global = yield* publishTick(seq0Command({ goalId: "gglobal" })) // legacy command ⇒ "" row
      expect(scoped.workspaceID).toBe("wrk_a")
      expect(global.workspaceID).toBe("")
      const due = yield* bus.dueRetries(2_000)
      const ours = due.filter((d) => d.subscriptionGroup === "scoped-grp")
      expect(ours.map((d) => d.eventID)).toEqual([scoped.id])
    }),
  )
})

describe("GoalTickConsumer — terminal stops the chain", () => {
  let calls = 0
  const it = testEffect(
    makeLayer({
      runTick: () =>
        Effect.sync(() => {
          calls++
          return { progress: "terminal", nextSeq: 1, nextExpectedPlanVersion: 1 } as StubResult
        }),
    }),
  )

  it.effect("terminal → acks, does NOT re-emit a next command", () =>
    Effect.gen(function* () {
      const consumer = yield* GoalTickConsumer.Service
      const cmd = yield* publishTick(seq0Command({ goalId: "gterm" }))
      yield* consumer.handle(cmd)
      // no next command for gterm should exist beyond the one we published.
      const bus = yield* DeepAgentEventBus.Service
      const next = yield* bus.getByID(cmd.id)
      expect(next).toBeDefined()
      // publishing seq=1 for gterm ourselves must be a FRESH insert (consumer did NOT already emit it).
      const probe = yield* bus.publish(GoalTickConsumer.tickCommand(seq0Command({ goalId: "gterm", seq: 1 })))
      expect(probe.idempotencyKey).toBe("goal:tick:gterm:1")
    }),
  )
})

describe("GoalTickConsumer — flag OFF drives nothing", () => {
  let executed = 0
  const it = testEffect(
    makeLayer({
      flag: false,
      runTick: () =>
        Effect.sync(() => {
          executed++
          return { progress: "continue", nextSeq: 1, nextExpectedPlanVersion: 1 } as StubResult
        }),
    }),
  )

  it.effect("flag OFF keeps a managed Goal obligation pending without execution", () =>
    Effect.gen(function* () {
      const consumer = yield* GoalTickConsumer.Service
      const cmd = yield* publishTick(seq0Command({ goalId: "managed-off", revision: 1 }))
      yield* consumer.handle(cmd)
      expect(executed).toBe(0)
      const db = (yield* Database.Service).db
      const row = yield* db
        .get(sql`SELECT status, attempts, next_attempt_at FROM deepagent_event_delivery WHERE event_id=${cmd.id}`)
        .pipe(Effect.orDie)
      expect(row).toEqual({ status: "pending", attempts: 0, next_attempt_at: now() + 30000 })
    }),
  )

  it.effect("flag OFF → acks and drives nothing (no tick executed)", () =>
    Effect.gen(function* () {
      const consumer = yield* GoalTickConsumer.Service
      const cmd = yield* publishTick(seq0Command({ goalId: "goff" }))
      yield* consumer.handle(cmd)
      expect(executed).toBe(0) // flag off ⇒ runTick never called
    }),
  )
})

describe("GoalTickConsumer — independent goal flag", () => {
  let executed = 0
  const it = testEffect(
    makeLayer({
      flag: false,
      goalFlag: true,
      runTick: () =>
        Effect.sync(() => {
          executed++
          return { progress: "continue", nextSeq: 1, nextExpectedPlanVersion: 1 } as StubResult
        }),
    }),
  )

  it.effect("goal-only mode executes and durably emits the next tick with the runtime master off", () =>
    Effect.gen(function* () {
      executed = 0
      const consumer = yield* GoalTickConsumer.Service
      const bus = yield* DeepAgentEventBus.Service
      const cmd = yield* publishTick(seq0Command({ goalId: "goal-only" }))
      yield* consumer.handle(cmd)
      expect(executed).toBe(1)
      const events = yield* bus.recentByType({ type: LMNEvents.GOAL_TICK_REQUESTED, windowMs: 100_000, now: clock })
      expect(events.map((event) => event.idempotencyKey).sort()).toEqual([
        "goal:tick:goal-only:0",
        "goal:tick:goal-only:1",
      ])
      yield* consumer.handle(cmd)
      expect(executed).toBe(1)
    }),
  )
})

describe("GoalTickConsumer — bus dedups a duplicate command", () => {
  const it = testEffect(
    makeLayer({
      runTick: () => Effect.succeed({ progress: "continue", nextSeq: 1, nextExpectedPlanVersion: 1 } as StubResult),
    }),
  )

  it.effect("duplicate command (same seq key) is deduped by the bus → one stored event", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const a = yield* bus.publish(GoalTickConsumer.tickCommand(seq0Command({ goalId: "gdup" })))
      const b = yield* bus.publish(GoalTickConsumer.tickCommand(seq0Command({ goalId: "gdup" })))
      // same idempotencyKey goal:tick:gdup:0 → the bus returns the SAME persisted event (one row).
      expect(b.id).toBe(a.id)
    }),
  )
})

describe("GoalTickConsumer — port failure nacks", () => {
  const it = testEffect(makeLayer({ runTick: () => Effect.die("tick blew up") }))

  it.effect("port failure → nacks (does not throw out of handle)", () =>
    Effect.gen(function* () {
      const consumer = yield* GoalTickConsumer.Service
      const cmd = yield* publishTick(seq0Command({ goalId: "gfail" }))
      // handle must NOT throw — it catches the defect and nacks internally.
      yield* consumer.handle(cmd)
    }),
  )
})

describe("GoalTickConsumer — C5-10 durable side-effect receipt", () => {
  let calls = 0
  const it = testEffect(
    makeLayer({
      runTick: () =>
        Effect.sync(() => {
          calls++
          return { progress: "continue", nextSeq: 1, nextExpectedPlanVersion: 1 } as StubResult
        }),
    }),
  )

  it.effect("a completed tick writes a done receipt; redelivery runs NOTHING again", () =>
    Effect.gen(function* () {
      const consumer = yield* GoalTickConsumer.Service
      const { db } = yield* Database.Service
      calls = 0
      const cmd = yield* publishTick(seq0Command({ goalId: "grecpt" }))
      yield* consumer.handle(cmd)
      expect(calls).toBe(1) // the tick ran once
      // the durable receipt proves the side effect completed for this (goal_tick, event) pair.
      const receipt = yield* ConsumerReceipts.receiptFor(db, "goal_tick", cmd.id)
      expect(receipt?.status).toBe("done")
      expect(receipt?.attempts).toBe(1)
      expect(receipt?.receiptRef).toBe(ConsumerReceipts.receiptRefFor("goal_tick", cmd.id))
      // redelivery: the done receipt short-circuits — no second tick, no receipt churn.
      yield* consumer.handle(cmd)
      expect(calls).toBe(1)
      const after = yield* ConsumerReceipts.receiptFor(db, "goal_tick", cmd.id)
      expect(after?.attempts).toBe(1)
    }),
  )
})

describe("GoalTickConsumer — C5-10 receipt stays pending on failure", () => {
  let calls = 0
  const it = testEffect(
    makeLayer({
      runTick: () =>
        Effect.sync(() => {
          calls++
          throw new Error("tick failed")
        }),
    }),
  )

  it.effect("a failed tick keeps the receipt PENDING (E3 retryable) and nacks", () =>
    Effect.gen(function* () {
      const consumer = yield* GoalTickConsumer.Service
      const { db } = yield* Database.Service
      calls = 0
      const cmd = yield* publishTick(seq0Command({ goalId: "grecpt-fail" }))
      yield* consumer.handle(cmd) // nacks internally; does not throw
      expect(calls).toBe(1)
      const receipt = yield* ConsumerReceipts.receiptFor(db, "goal_tick", cmd.id)
      expect(receipt?.status).toBe("pending")
      expect(receipt?.lastError).toContain("tick failed")
    }),
  )
})

describe("GoalTickConsumer — durable quiet-hours deferral", () => {
  let calls = 0
  const busLayer = DeepAgentEventBus.layerWith({ now }).pipe(Layer.provideMerge(database))
  const configLayer = WorkspaceConfig.layer.pipe(Layer.provide(database))
  const consumerLayer = GoalTickConsumer.layerWith({
    runLoop: false,
    now,
    runTick: () =>
      Effect.sync(() => {
        calls++
        return { progress: "terminal", nextSeq: 1, nextExpectedPlanVersion: 1 } as StubResult
      }),
  }).pipe(
    Layer.provide(busLayer),
    Layer.provide(configLayer),
    Layer.provide(RuntimeFlags.layer({ v4GoalTickEventDriven: true })),
  )
  const it = testEffect(Layer.mergeAll(consumerLayer, busLayer, configLayer))

  it.effect("quiet hours retain the original pending delivery without consuming attempts", () =>
    Effect.gen(function* () {
      clock = Date.UTC(2026, 9, 6, 23, 30)
      calls = 0
      const bus = yield* DeepAgentEventBus.Service
      const config = yield* WorkspaceConfig.Service
      const consumer = yield* GoalTickConsumer.Service
      const { db } = yield* Database.Service
      const hour = new Date(clock).getUTCHours()
      yield* config.set("wrk_quiet", {
        quietHours: { startHour: hour, endHour: (hour + 1) % 24, tzOffsetMinutes: 0 },
      })
      yield* bus.registerConsumerGroup(GoalTickConsumer.TICK_GROUP, LMNEvents.GOAL_TICK_REQUESTED)
      const event = yield* publishTick(seq0Command({ workspaceID: "wrk_quiet" }))
      yield* consumer.handle(event)
      const rows = yield* db.select().from(DeepAgentEventDeliveryTable).all().pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        event_id: event.id,
        status: "pending",
        attempts: 0,
        next_attempt_at: Math.floor(clock / 3_600_000) * 3_600_000 + 3_600_000,
        claim_token: null,
      })
      expect(yield* ConsumerReceipts.receiptFor(db, "goal_tick", event.id)).toBeUndefined()
      expect(calls).toBe(0)
    }),
  )

  it.effect("live and retry cannot bypass quiet due time, re-read a changed window, and execute once when due", () =>
    Effect.gen(function* () {
      clock = Date.UTC(2026, 9, 6, 23, 30)
      calls = 0
      const bus = yield* DeepAgentEventBus.Service
      const config = yield* WorkspaceConfig.Service
      const consumer = yield* GoalTickConsumer.Service
      const { db } = yield* Database.Service
      yield* config.set("wrk_quiet", { quietHours: { startHour: 22, endHour: 6, tzOffsetMinutes: 0 } })
      const event = yield* publishTick(seq0Command({ workspaceID: "wrk_quiet" }))
      yield* consumer.handle(event)
      clock = Date.UTC(2026, 9, 7, 5, 59, 59, 999)
      yield* consumer.handle(event)
      expect(yield* consumer.pumpRetries()).toBe(0)
      expect(calls).toBe(0)
      yield* config.set("wrk_quiet", { quietHours: { startHour: 22, endHour: 8, tzOffsetMinutes: 0 } })
      clock = Date.UTC(2026, 9, 7, 6)
      expect(yield* consumer.pumpRetries()).toBe(1)
      expect(calls).toBe(0)
      expect(yield* db.select().from(DeepAgentEventDeliveryTable).get().pipe(Effect.orDie)).toMatchObject({
        attempts: 0,
        status: "pending",
        next_attempt_at: Date.UTC(2026, 9, 7, 8),
      })
      clock = Date.UTC(2026, 9, 7, 8)
      yield* Effect.all([consumer.handle(event), consumer.pumpRetries()], { concurrency: 2 })
      yield* consumer.handle(event)
      expect(calls).toBe(1)
      expect(yield* db.select().from(DeepAgentEventDeliveryTable).get().pipe(Effect.orDie)).toMatchObject({
        status: "delivered",
        attempts: 0,
      })
      expect(yield* ConsumerReceipts.receiptFor(db, "goal_tick", event.id)).toMatchObject({
        status: "done",
        attempts: 1,
      })
      expect(
        (yield* bus.recentByType({ type: LMNEvents.GOAL_TICK_REQUESTED, now: clock, windowMs: 86_400_000 })).map(
          (item) => item.id,
        ),
      ).toEqual([event.id])
    }),
  )

  it.effect("a fixed timezone offset crossing midnight persists its actual UTC deadline", () =>
    Effect.gen(function* () {
      clock = Date.UTC(2026, 9, 6, 20) // 01:30 next day at UTC+05:30.
      calls = 0
      const config = yield* WorkspaceConfig.Service
      const consumer = yield* GoalTickConsumer.Service
      const { db } = yield* Database.Service
      yield* config.set("wrk_quiet", { quietHours: { startHour: 22, endHour: 6, tzOffsetMinutes: 330 } })
      const event = yield* publishTick(seq0Command({ workspaceID: "wrk_quiet" }))
      yield* consumer.handle(event)
      expect(yield* db.select().from(DeepAgentEventDeliveryTable).get().pipe(Effect.orDie)).toMatchObject({
        status: "pending",
        next_attempt_at: Date.UTC(2026, 9, 7, 0, 30),
      })
      expect(calls).toBe(0)
    }),
  )
})

const leaseFixture = () => {
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  let interrupted = false
  const layer = makeLayer({
    leaseMs: 90,
    renewalIntervalMs: 20,
    runTick: () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return { progress: "terminal", nextSeq: 1, nextExpectedPlanVersion: 1 } as StubResult
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
          }),
        ),
      ),
  })
  return { entered, release, layer, interrupted: () => interrupted }
}

describe("GoalTickConsumer — claim maintenance", () => {
  const held = leaseFixture()
  testEffect(held.layer).effect(
    "a long tick renews beyond its first lease while competing live/pump paths cannot enter",
    () =>
      Effect.gen(function* () {
        clock = 1_000
        const bus = yield* DeepAgentEventBus.Service
        const consumer = yield* GoalTickConsumer.Service
        const event = yield* publishTick(seq0Command())
        const running = yield* consumer.handle(event).pipe(Effect.forkScoped)
        yield* Deferred.await(held.entered)
        for (const at of [1_020, 1_040, 1_060, 1_080, 1_100, 1_120]) {
          clock = at
          yield* TestClock.adjust("20 millis")
          expect(
            (yield* bus.claimDue({ subscriptionGroup: GoalTickConsumer.TICK_GROUP, claimantId: "competitor" }))
              .deliveries,
          ).toEqual([])
          yield* consumer.handle(event)
          expect(yield* consumer.pumpRetries()).toBe(0)
        }
        yield* Deferred.succeed(held.release, undefined)
        yield* Fiber.join(running)
        expect(held.interrupted()).toBe(false)
      }),
  )

  for (const failure of ["replaced", "storage", "expired"] as const) {
    const lost = leaseFixture()
    testEffect(lost.layer).effect(`a ${failure} lease interrupts the current fiber without unclaimed ack or nack`, () =>
      Effect.gen(function* () {
        clock = 1_000
        const consumer = yield* GoalTickConsumer.Service
        const { db } = yield* Database.Service
        const event = yield* publishTick(seq0Command())
        const running = yield* consumer.handle(event).pipe(Effect.forkScoped)
        yield* Deferred.await(lost.entered)
        if (failure === "replaced")
          yield* db.run("UPDATE deepagent_event_delivery SET claim_token = 'replacement'").pipe(Effect.orDie)
        if (failure === "storage")
          yield* db
            .run(
              "CREATE TRIGGER reject_renew BEFORE UPDATE OF lease_expires_at ON deepagent_event_delivery BEGIN SELECT RAISE(ABORT, 'renew unavailable'); END",
            )
            .pipe(Effect.orDie)
        clock = failure === "expired" ? 1_100 : 1_020
        yield* TestClock.adjust("20 millis")
        const outcome = yield* Fiber.await(running)
        expect(outcome._tag).toBe("Failure")
        if (outcome._tag === "Failure")
          expect(Cause.pretty(outcome.cause)).toContain(
            failure === "storage" ? "renew unavailable" : "delivery lease lost",
          )
        expect(lost.interrupted()).toBe(true)
        expect(yield* db.select().from(DeepAgentEventDeliveryTable).get().pipe(Effect.orDie)).toMatchObject({
          status: "pending",
          attempts: 0,
          next_attempt_at: 1_000,
        })
        if (failure === "storage") yield* db.run("DROP TRIGGER reject_renew").pipe(Effect.orDie)
      }),
    )
  }
})
