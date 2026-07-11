import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Scheduler } from "@deepagent-code/core/deepagent/scheduler"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "./lib/effect"

let clock = 0
const setNow = (t: number) => {
  clock = t
}
const now = () => clock

const database = Database.layerFromPath(":memory:")
const schedLayer = Scheduler.layerWith({ now }).pipe(Layer.provideMerge(database))
const it = testEffect(schedLayer)

const template: Scheduler.EventTemplate = {
  type: "schedule.scan",
  source: "schedule",
  workspaceID: "wrk_1",
  payload: { kind: "maintenance" },
}

describe("Scheduler", () => {
  it.effect("§A4 延迟事件: a delay schedule is due at fireAt and fires once", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const s = yield* Scheduler.Service
      const sched = yield* s.scheduleDelay({ workspaceID: "wrk_1", fireAt: 5_000, eventTemplate: template })
      expect(sched.kind).toBe("delay")
      // not due before fireAt
      expect((yield* s.due(4_999)).length).toBe(0)
      // due at/after fireAt
      const due = yield* s.due(5_000)
      expect(due.map((d) => d.id)).toEqual([sched.id])
      // after firing it leaves the active set
      yield* s.markFired(sched.id, 5_000)
      expect((yield* s.due(10_000)).length).toBe(0)
      const fired = yield* s.list("wrk_1", "fired")
      expect(fired.map((d) => d.id)).toEqual([sched.id])
    }),
  )

  it.effect("§A4 周期扫描: a periodic schedule advances fireAt by intervalMs and stays active", () =>
    Effect.gen(function* () {
      setNow(0)
      const s = yield* Scheduler.Service
      const sched = yield* s.schedulePeriodic({
        workspaceID: "wrk_1",
        intervalMs: 1_000,
        firstFireAt: 1_000,
        eventTemplate: template,
      })
      // fires at 1_000 → next fireAt 2_000, still active
      yield* s.markFired(sched.id, 1_000)
      expect((yield* s.due(1_999)).length).toBe(0)
      const next = yield* s.due(2_000)
      expect(next.map((d) => d.id)).toEqual([sched.id])
      expect(next[0]?.fireAt).toBe(2_000)
      expect(next[0]?.lastFiredAt).toBe(1_000)
    }),
  )

  it.effect("§A4 周期扫描: a backlogged fire catches up to the next future tick (no burst)", () =>
    Effect.gen(function* () {
      setNow(0)
      const s = yield* Scheduler.Service
      const sched = yield* s.schedulePeriodic({
        workspaceID: "wrk_1",
        intervalMs: 1_000,
        firstFireAt: 1_000,
        eventTemplate: template,
      })
      // tick was delayed to 5_500: fire once, next fireAt should skip past to 6_000 (not 2_000)
      yield* s.markFired(sched.id, 5_500)
      const after = yield* s.list("wrk_1")
      expect(after[0]?.fireAt).toBe(6_000)
    }),
  )

  it.effect("§A4 条件触发: conditionMet threshold + recheck reschedules the next check", () =>
    Effect.gen(function* () {
      setNow(0)
      const s = yield* Scheduler.Service
      const condition: Scheduler.ConditionSpec = { eventType: "ci.failure", threshold: 3, windowMs: 60_000 }
      const sched = yield* s.scheduleCondition({
        workspaceID: "wrk_1",
        condition,
        firstCheckAt: 0,
        recheckEveryMs: 10_000,
        eventTemplate: template,
      })
      expect(sched.kind).toBe("condition")
      expect(sched.condition).toEqual(condition)
      // pure threshold check
      expect(Scheduler.conditionMet(condition, 2)).toBe(false)
      expect(Scheduler.conditionMet(condition, 3)).toBe(true)
      // not met → recheck reschedules; still active, not fired
      yield* s.recheckCondition(sched.id, 10_000)
      expect((yield* s.due(9_999)).length).toBe(0)
      expect((yield* s.due(10_000)).map((d) => d.id)).toEqual([sched.id])
      // met → markFired keeps it active AND (having a recheck cadence) advances fire_at past firedAt
      // so it is NOT immediately re-eligible next tick (no burst). fire_at was 10_000 → next 20_000.
      yield* s.markFired(sched.id, 10_000)
      const still = yield* s.list("wrk_1")
      expect(still.map((d) => d.status)).toEqual(["active"])
      expect(still[0]?.lastFiredAt).toBe(10_000)
      expect(still[0]?.fireAt).toBe(20_000)
      expect((yield* s.due(19_999)).length).toBe(0) // not re-eligible until the next recheck
      expect((yield* s.due(20_000)).map((d) => d.id)).toEqual([sched.id])
    }),
  )

  it.effect("§A4 条件触发: a cadence-less condition (recheck every tick) refires until recheck/cancel", () =>
    Effect.gen(function* () {
      setNow(0)
      const s = yield* Scheduler.Service
      const sched = yield* s.scheduleCondition({
        workspaceID: "wrk_1",
        condition: { eventType: "ci.failure", threshold: 1, windowMs: 60_000 },
        firstCheckAt: 0,
        eventTemplate: template, // no recheckEveryMs ⇒ every-tick evaluation
      })
      // firing keeps fire_at in the past → still due next tick (INTENTIONAL every-tick semantics)
      yield* s.markFired(sched.id, 5_000)
      expect((yield* s.due(5_000)).map((d) => d.id)).toEqual([sched.id])
      // caller drains it by rescheduling the recheck (or cancelling)
      yield* s.recheckCondition(sched.id, 10_000)
      expect((yield* s.due(5_000)).length).toBe(0)
    }),
  )

  it.effect("schedulePeriodic rejects a non-positive interval (guards hot-refire)", () =>
    Effect.gen(function* () {
      const s = yield* Scheduler.Service
      const zero = yield* s
        .schedulePeriodic({ workspaceID: "wrk_1", intervalMs: 0, firstFireAt: 1_000, eventTemplate: template })
        .pipe(Effect.exit)
      expect(zero._tag).toBe("Failure")
      const neg = yield* s
        .schedulePeriodic({ workspaceID: "wrk_1", intervalMs: -1_000, firstFireAt: 1_000, eventTemplate: template })
        .pipe(Effect.exit)
      expect(neg._tag).toBe("Failure")
    }),
  )

  it.effect("§A4 null fireAt condition is due every tick", () =>
    Effect.gen(function* () {
      setNow(0)
      const s = yield* Scheduler.Service
      const sched = yield* s.scheduleCondition({
        workspaceID: "wrk_1",
        condition: { eventType: "monitor.alert", threshold: 1, windowMs: 1_000 },
        firstCheckAt: 0,
        eventTemplate: template, // no recheckEveryMs ⇒ interval null; firstCheckAt 0 ⇒ due now
      })
      const due = yield* s.due(0)
      expect(due.map((d) => d.id)).toEqual([sched.id])
    }),
  )

  it.effect("cancel removes a schedule from the due/active set (idempotent)", () =>
    Effect.gen(function* () {
      setNow(0)
      const s = yield* Scheduler.Service
      const sched = yield* s.scheduleDelay({ workspaceID: "wrk_1", fireAt: 1_000, eventTemplate: template })
      yield* s.cancel(sched.id)
      yield* s.cancel(sched.id) // idempotent
      expect((yield* s.due(2_000)).length).toBe(0)
      expect((yield* s.list("wrk_1", "active")).length).toBe(0)
      expect((yield* s.list("wrk_1", "cancelled")).map((d) => d.id)).toEqual([sched.id])
    }),
  )

  it.effect("markFired on a cancelled schedule is a no-op", () =>
    Effect.gen(function* () {
      setNow(0)
      const s = yield* Scheduler.Service
      const sched = yield* s.scheduleDelay({ workspaceID: "wrk_1", fireAt: 1_000, eventTemplate: template })
      yield* s.cancel(sched.id)
      yield* s.markFired(sched.id, 1_000) // must not resurrect
      expect((yield* s.list("wrk_1", "cancelled")).length).toBe(1)
      expect((yield* s.list("wrk_1", "fired")).length).toBe(0)
    }),
  )
})
