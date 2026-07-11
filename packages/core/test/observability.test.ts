import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Observability } from "@deepagent-code/core/deepagent/observability"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { DeepAgentEventTable } from "@deepagent-code/core/deepagent/deepagent-event-sql"
import { Database } from "@deepagent-code/core/database/database"
import { AgentPushLogTable } from "@deepagent-code/core/im/push-log-sql"
import { testEffect } from "./lib/effect"

// V4.0 §F — Observability. Verifies §F2 trace assembly + §F1 metric aggregation over the durable
// event / delivery / push-log tables, driven through the real Event Bus.

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

const database = Database.layerFromPath(":memory:")
const busLayer = DeepAgentEventBus.layerWith({ maxAttempts: 2, backoffBaseMs: 1000, now }).pipe(
  Layer.provideMerge(database),
)
const obsLayer = Observability.layerWith({ now }).pipe(Layer.provideMerge(busLayer))
const it = testEffect(obsLayer)

const pub = (over: Partial<DeepAgentEvent.PublishInput>): DeepAgentEvent.PublishInput => ({
  type: "ci.failure",
  source: "ci",
  workspaceID: "wrk_1",
  payload: {},
  ...over,
})

describe("Observability.trace (§F2)", () => {
  it.effect("assembles the causal event chain for a correlationID in order", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const obs = yield* Observability.Service
      setNow(100)
      const root = yield* bus.publish(pub({ idempotencyKey: "t-root", type: "ci.failure", correlationID: "corr-1" }))
      setNow(200)
      yield* bus.publish(pub({ idempotencyKey: "t-started", type: "agent.task.started", source: "system", correlationID: "corr-1", causationID: root.id }))
      setNow(300)
      yield* bus.publish(pub({ idempotencyKey: "t-done", type: "agent.task.completed", source: "system", correlationID: "corr-1", causationID: root.id }))
      // an unrelated correlation must not appear
      setNow(250)
      yield* bus.publish(pub({ idempotencyKey: "t-other", type: "git.push", source: "git", correlationID: "corr-2" }))

      const chain = yield* obs.trace({ workspaceID: "wrk_1", correlationID: "corr-1" })
      expect(chain.map((n) => n.type)).toEqual(["ci.failure", "agent.task.started", "agent.task.completed"])
      expect(chain[1].causationID).toBe(root.id) // causal parent recorded
    }),
  )

  it.effect("returns empty for an unknown correlationID", () =>
    Effect.gen(function* () {
      const obs = yield* Observability.Service
      expect((yield* obs.trace({ workspaceID: "wrk_1", correlationID: "nope" })).length).toBe(0)
    }),
  )

  it.effect("§多租户: a correlationID collision across workspaces does NOT leak the other tenant's events", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const obs = yield* Observability.Service
      setNow(400)
      yield* bus.publish(pub({ idempotencyKey: "x-a", workspaceID: "wrk_a", correlationID: "shared" }))
      yield* bus.publish(pub({ idempotencyKey: "x-b", workspaceID: "wrk_b", correlationID: "shared" }))
      const a = yield* obs.trace({ workspaceID: "wrk_a", correlationID: "shared" })
      expect(a.length).toBe(1) // only wrk_a's event, not wrk_b's
      expect(a[0].type).toBe("ci.failure")
    }),
  )
})

describe("Observability.metrics (§F1)", () => {
  it.effect("agent_task_success_rate counts ONLY genuine failures (runner_failed), not policy blocks", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const obs = yield* Observability.Service
      setNow(1_000)
      yield* bus.publish(pub({ idempotencyKey: "m-c1", type: "agent.task.completed", source: "system", payload: { taskID: "t1" } }))
      yield* bus.publish(pub({ idempotencyKey: "m-c2", type: "agent.task.completed", source: "system", payload: { taskID: "t2" } }))
      // a genuine failure
      yield* bus.publish(pub({ idempotencyKey: "m-f1", type: "agent.task.blocked", source: "system", payload: { taskID: "t3", reason: "runner_failed" } }))
      // policy blocks — must NOT count as failures
      yield* bus.publish(pub({ idempotencyKey: "m-p1", type: "agent.task.blocked", source: "system", payload: { taskID: "t4", reason: "no_capable_agent" } }))
      yield* bus.publish(pub({ idempotencyKey: "m-p2", type: "agent.task.blocked", source: "system", payload: { taskID: "t5", reason: "suggestion_only" } }))
      const m = yield* obs.metrics({ workspaceID: "wrk_1", from: 0, to: 2_000 })
      expect(m.agentTaskCompleted).toBe(2)
      expect(m.agentTaskFailed).toBe(1) // only runner_failed
      expect(m.agentTaskBlockedTotal).toBe(3)
      expect(m.agentTaskSuccessRate).toBeCloseTo(2 / 3, 5) // 2 completed / (2 + 1 failed)
    }),
  )

  it.effect("no task activity → success rate is null (distinct from 100%)", () =>
    Effect.gen(function* () {
      const obs = yield* Observability.Service
      const m = yield* obs.metrics({ workspaceID: "wrk_1", from: 0, to: 1_000 })
      expect(m.agentTaskSuccessRate).toBeNull()
      expect(m.agentTaskCompleted).toBe(0)
    }),
  )

  it.effect("agent_conflict_rate = conflict blocks / all blocks", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const obs = yield* Observability.Service
      setNow(1_000)
      yield* bus.publish(pub({ idempotencyKey: "cr-1", type: "agent.task.blocked", source: "system", payload: { reason: "conflict_deferred" } }))
      yield* bus.publish(pub({ idempotencyKey: "cr-2", type: "agent.task.blocked", source: "system", payload: { reason: "conflict_needs_human" } }))
      yield* bus.publish(pub({ idempotencyKey: "cr-3", type: "agent.task.blocked", source: "system", payload: { reason: "runner_failed" } }))
      const m = yield* obs.metrics({ workspaceID: "wrk_1", from: 0, to: 2_000 })
      expect(m.agentTaskBlockedTotal).toBe(3)
      expect(m.agentConflictRate).toBeCloseTo(2 / 3, 5)
    }),
  )

  it.effect("agent_push_rejected_total decomposes by reason", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const obs = yield* Observability.Service
      const row = (id: string, decision: string) => ({
        id,
        workspace_id: "wrk_1",
        group_id: "grp_1" as never,
        agent_id: "agt_1",
        reason: "x",
        priority: "normal",
        decision,
        idempotency_key: id,
        message_id: null,
        content: null,
        created_at: 1_500,
      })
      yield* db
        .insert(AgentPushLogTable)
        .values([
          row("p1", "deliver"),
          row("p2", "blocked:rate_limited"),
          row("p3", "blocked:rate_limited"),
          row("p4", "blocked:not_authorized"),
        ])
        .run()
      const m = yield* obs.metrics({ workspaceID: "wrk_1", from: 0, to: 2_000 })
      expect(m.agentPushTotal).toBe(4)
      expect(m.agentPushRejectedTotal).toBe(3)
      expect(m.agentPushRejectedByReason).toEqual({ rate_limited: 2, not_authorized: 1 })
    }),
  )

  it.effect("dlq_events_total counts dead deliveries in the window", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const obs = yield* Observability.Service
      setNow(5_000)
      const ev = yield* bus.publish(pub({ idempotencyKey: "m-dlq" }))
      // maxAttempts=2 → two nacks flips the delivery to dead (DLQ).
      yield* bus.nack({ subscriptionGroup: "router", eventID: ev.id, reason: "1" })
      yield* bus.nack({ subscriptionGroup: "router", eventID: ev.id, reason: "2" })
      const dead = yield* bus.deadLetters()
      expect(dead.length).toBe(1) // sanity
      const m = yield* obs.metrics({ workspaceID: "wrk_1", from: 0, to: 10_000 })
      expect(m.dlqEventsTotal).toBe(1)
    }),
  )

  it.effect("event_publish_latency_ms P50/P95 aggregates the per-row publish_latency_ms samples", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const obs = yield* Observability.Service
      // seed events directly with known publish_latency_ms so percentiles are exact (10..100 by 10s).
      const rows = Array.from({ length: 10 }, (_, i) => ({
        id: DeepAgentEvent.ID.create(6_000 + i),
        type: "ci.failure",
        source: "ci" as const,
        workspace_id: "wrk_lat",
        project_id: null,
        actor_id: null,
        correlation_id: null,
        causation_id: null,
        idempotency_key: `lat-${i}`,
        priority: "normal" as const,
        payload: null,
        created_at: 6_000 + i,
        publish_latency_ms: (i + 1) * 10, // 10,20,...,100
      }))
      yield* db.insert(DeepAgentEventTable).values(rows).run()
      const m = yield* obs.metrics({ workspaceID: "wrk_lat", from: 0, to: 10_000 })
      // nearest-rank: P50 rank = ceil(.5*10)=5 → 50ms; P95 rank = ceil(.95*10)=10 → 100ms.
      expect(m.eventPublishLatencyMsP50).toBe(50)
      expect(m.eventPublishLatencyMsP95).toBe(100)
    }),
  )

  it.effect("latency percentiles are null when no samples exist in the window", () =>
    Effect.gen(function* () {
      const obs = yield* Observability.Service
      const m = yield* obs.metrics({ workspaceID: "wrk_empty", from: 0, to: 1_000 })
      expect(m.eventPublishLatencyMsP50).toBeNull()
      expect(m.eventPublishLatencyMsP95).toBeNull()
      expect(m.eventToAgentStartMsP50).toBeNull()
      expect(m.eventToAgentStartMsP95).toBeNull()
    }),
  )

  it.effect("event_to_agent_start_ms = started.createdAt − trigger.createdAt (joined by causationID)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const obs = yield* Observability.Service
      // a trigger event, then an agent.task.started whose causationID points at it 150ms later.
      setNow(7_000)
      const trigger = yield* bus.publish(pub({ idempotencyKey: "eas-trig", workspaceID: "wrk_eas", type: "ci.failure" }))
      setNow(7_150)
      yield* bus.publish(
        pub({
          idempotencyKey: "eas-start",
          workspaceID: "wrk_eas",
          type: "agent.task.started",
          source: "system",
          causationID: trigger.id,
        }),
      )
      // a started event with a dangling causationID contributes no sample (trigger not in workspace).
      setNow(7_200)
      yield* bus.publish(
        pub({
          idempotencyKey: "eas-dangling",
          workspaceID: "wrk_eas",
          type: "agent.task.started",
          source: "system",
          causationID: "dae_nonexistent",
        }),
      )
      const m = yield* obs.metrics({ workspaceID: "wrk_eas", from: 0, to: 10_000 })
      expect(m.eventToAgentStartMsP50).toBe(150)
      expect(m.eventToAgentStartMsP95).toBe(150)
    }),
  )
})
