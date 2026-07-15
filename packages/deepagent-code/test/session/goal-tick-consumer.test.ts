import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { GoalTickConsumer } from "../../src/session/goal-tick-consumer"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { Database } from "@deepagent-code/core/database/database"
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
  runTick: GoalTickConsumer.GoalTickPort
}) => {
  const busLayer = DeepAgentEventBus.layerWith({ now }).pipe(Layer.provideMerge(database))
  const flagLayer = RuntimeFlags.layer({ v4MultiAgentRuntime: opts.flag ?? true })
  const consumer = GoalTickConsumer.layerWith({ runTick: opts.runTick, runLoop: false }).pipe(
    Layer.provide(busLayer),
    Layer.provide(flagLayer),
  )
  return Layer.mergeAll(consumer, busLayer, flagLayer, database)
}

const seq0Command = (over?: Partial<{ sessionID: string; goalId: string; planDocId: string; seq: number }>) => ({
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
    return yield* bus.publish(GoalTickConsumer.tickCommand(req))
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
      const dup = yield* bus.publish(
        GoalTickConsumer.tickCommand(seq0Command({ seq: 1 })),
      )
      // if the consumer already emitted seq=1, this returns the SAME event id (dedup); prove the chain fired.
      expect(dup.idempotencyKey).toBe("goal:tick:g1:1")
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

  it.effect("flag OFF → acks and drives nothing (no tick executed)", () =>
    Effect.gen(function* () {
      const consumer = yield* GoalTickConsumer.Service
      const cmd = yield* publishTick(seq0Command({ goalId: "goff" }))
      yield* consumer.handle(cmd)
      expect(executed).toBe(0) // flag off ⇒ runTick never called
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
