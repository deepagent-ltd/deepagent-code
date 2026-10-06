// This subprocess uses real file-backed SQL, WorkspaceConfig, EventBus and GoalTickConsumer.
// Only the clock and runTick execution port are deterministic; no Session/provider is started.
import assert from "node:assert/strict"
import path from "node:path"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEventDeliveryTable, DeepAgentEventTable } from "@deepagent-code/core/deepagent/deepagent-event-sql"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { GoalTickConsumer } from "../../src/session/goal-tick-consumer"

const [root, phase, time, ready] = Bun.argv.slice(2)
assert(root && phase && ready)
const now = Number(time)
assert(Number.isSafeInteger(now))
assert(["seed", "claim", "failure", "resume"].includes(phase))
const database = Database.layerFromPath(path.join(root, "goal.sqlite"))
const bus = DeepAgentEventBus.layerWith({ now: () => now }).pipe(Layer.provideMerge(database))
const config = WorkspaceConfig.layerWith({ now: () => now }).pipe(Layer.provide(database))
const prepared = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* DeepAgentEventBus.Service
    const settings = yield* WorkspaceConfig.Service
    yield* db
      .run("CREATE TABLE IF NOT EXISTS goal_defer_probe (goal_id TEXT NOT NULL, seq INTEGER NOT NULL)")
      .pipe(Effect.orDie)
    yield* events.registerConsumerGroup(GoalTickConsumer.TICK_GROUP, "goal.tick.requested")
    if (phase === "resume") {
      yield* db.run("DROP TRIGGER IF EXISTS reject_defer_fixture").pipe(Effect.orDie)
      return
    }
    yield* settings.set("wrk_defer", { quietHours: { startHour: 22, endHour: 6, tzOffsetMinutes: 0 } })
    yield* events.publish(
      GoalTickConsumer.tickCommand({
        sessionID: "session-defer",
        goalId: "goal-defer",
        planDocId: "plan-defer",
        seq: 0,
        expectedPlanVersion: 0,
        workspaceID: "wrk_defer",
      }),
    )
    if (phase === "failure")
      yield* db
        .run(
          "CREATE TRIGGER reject_defer_fixture BEFORE UPDATE OF next_attempt_at ON deepagent_event_delivery BEGIN SELECT RAISE(ABORT, 'fixture defer failed'); END",
        )
        .pipe(Effect.orDie)
  }),
).pipe(Layer.provide(Layer.mergeAll(bus, config)))

// This barrier pauses the real consumer immediately before its SQL defer. It does not fake any
// delivery/claim state, and lets the parent SIGKILL after the actual claim has committed.
const gated = Layer.effect(
  DeepAgentEventBus.Service,
  Effect.gen(function* () {
    const events = yield* DeepAgentEventBus.Service
    if (phase !== "claim") return events
    return DeepAgentEventBus.Service.of({
      ...events,
      deferClaim: () =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(ready, JSON.stringify({ phase: "claimed", pid: process.pid, now })))
          return yield* Effect.never
        }),
    })
  }),
).pipe(Layer.provide(bus))

const consumer = Layer.unwrap(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return GoalTickConsumer.layerWith({
      now: () => now,
      leaseMs: 1_000,
      renewalIntervalMs: 200,
      runLoop: phase === "resume",
      retryPumpIntervalMs: 20,
      runTick: (request) =>
        Effect.gen(function* () {
          yield* db
            .run(sql`INSERT INTO goal_defer_probe (goal_id, seq) VALUES (${request.goalId}, ${request.seq})`)
            .pipe(Effect.orDie)
          return { progress: "terminal" as const, nextSeq: 1, nextExpectedPlanVersion: 1 }
        }),
    })
  }),
).pipe(
  Layer.provide(gated),
  Layer.provide(database),
  Layer.provide(config),
  Layer.provide(RuntimeFlags.layer({ v4GoalTickEventDriven: true })),
  Layer.provide(prepared),
)

await Effect.gen(function* () {
  const ticks = yield* GoalTickConsumer.Service
  const events = yield* DeepAgentEventBus.Service
  const { db } = yield* Database.Service
  const row = yield* db.select().from(DeepAgentEventTable).get().pipe(Effect.orDie)
  assert(row)
  const event = yield* events.getByID(row.id)
  assert(event)
  const result = yield* ticks.handle(event).pipe(Effect.exit)
  if (phase === "failure") assert.equal(result._tag, "Failure")
  if (phase !== "failure") assert.equal(result._tag, "Success")
  if (phase === "resume") {
    // If the startup pump claimed first, wait for that owner; manual/live calls never bypass due.
    yield* ticks.pumpRetries()
    yield* Effect.gen(function* () {
      while (true) {
        const delivery = yield* db.select().from(DeepAgentEventDeliveryTable).get().pipe(Effect.orDie)
        assert(delivery)
        if (delivery.status === "delivered" || delivery.next_attempt_at! > now || delivery.claimed_at! < now) break
        yield* Effect.sleep("10 millis")
      }
    }).pipe(Effect.timeout("5 seconds"), Effect.orDie)
  }
  yield* Effect.promise(() => Bun.write(ready, JSON.stringify({ phase, pid: process.pid, now })))
  yield* Effect.never
}).pipe(Effect.provide(Layer.mergeAll(consumer, bus)), Effect.scoped, Effect.runPromise)
