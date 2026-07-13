import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Observability } from "@deepagent-code/core/deepagent/observability"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { DeepAgentEventTable } from "@deepagent-code/core/deepagent/deepagent-event-sql"
import { Database } from "@deepagent-code/core/database/database"
import { AgentPushLogTable } from "@deepagent-code/core/im/push-log-sql"
import { HumanTakeover } from "@deepagent-code/core/deepagent/human-takeover"
import { RollbackAudit } from "@deepagent-code/core/deepagent/rollback-audit"
import { SessionTable, MessageTable } from "@deepagent-code/core/session/sql"
import { ProjectTable } from "@deepagent-code/core/project/sql"
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
// §D2/§F — the takeover recorder shares the ONE in-memory DB so recording a takeover is visible to the
// Observability human_takeover_total query (both read the same deepagent_human_takeover table).
const takeoverLayer = HumanTakeover.layerWith({ now }).pipe(Layer.provideMerge(busLayer))
// §D2/§F — the rollback recorder shares the ONE in-memory DB so a recorded rollback is visible to the
// Observability rollback_total query (both read the same deepagent_rollback table).
const rollbackLayer = RollbackAudit.layerWith({ now }).pipe(Layer.provideMerge(takeoverLayer))
const obsLayer = Observability.layerWith({ now }).pipe(Layer.provideMerge(rollbackLayer))
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

  // §F2 BACK-HALF regression lock. This is the assertion the reviewer required: given a coordinated event
  // whose runner produced a CHILD SESSION stamped with the event's correlationID (metadata.correlationID),
  // Observability.trace(correlationID) must INCLUDE that child session — not just the coordination events.
  // BEFORE the trace-query fix (trace read only DeepAgentEventTable) this failed: the child session's
  // metadata stamp was inert and the trace stopped at the events. AFTER (trace also reads the session's
  // metadata.correlationID via json_extract) the child session appears as a kind:"session" node, proving
  // the stamp is actually read and the trace follows correlationID down into the child session.
  it.effect("§F2 back-half: trace INCLUDES a child session stamped with the correlationID (not just events)", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const obs = yield* Observability.Service
      const { db } = yield* Database.Service
      const CORR = "corr-backhalf"
      const WS = "wrk_bh"

      // the coordination event chain for this correlationID (front-half).
      setNow(1_000)
      const root = yield* bus.publish(pub({ idempotencyKey: "bh-root", workspaceID: WS, type: "ci.failure", correlationID: CORR }))
      setNow(1_100)
      yield* bus.publish(pub({ idempotencyKey: "bh-started", workspaceID: WS, type: "agent.task.started", source: "system", correlationID: CORR, causationID: root.id }))

      // a project + the CHILD SESSION the runner created, stamped with metadata.correlationID = CORR — the
      // exact row makeEventTurnRunner/makeTaskSubagentRunner produce when handed the event's correlationID.
      yield* db.insert(ProjectTable).values([{ id: "prj_bh" as never, worktree: "/tmp/bh" as never, sandboxes: [] as never }]).run()
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: "ses_child_bh" as never,
            project_id: "prj_bh" as never,
            workspace_id: WS as never,
            directory: "/tmp/bh",
            slug: "child-bh",
            title: "reviewer (event)",
            version: "0",
            metadata: { correlationID: CORR } as never,
            time_created: 1_150,
            time_updated: 1_150,
          } as never,
        ])
        .run()
      // one persisted message in the child session → messageCount surfaces as a light activity summary.
      yield* db
        .insert(MessageTable)
        .values([{ id: "msg_bh_1" as never, session_id: "ses_child_bh" as never, time_created: 1_160, time_updated: 1_160, data: {} as never }])
        .run()

      const chain = yield* obs.trace({ workspaceID: WS, correlationID: CORR })
      // the trace now spans BOTH halves: the two events AND the child session node.
      const sessionNodes = chain.filter((n) => n.kind === "session")
      expect(sessionNodes.length).toBe(1)
      expect(sessionNodes[0].sessionID).toBe("ses_child_bh")
      expect(sessionNodes[0].title).toBe("reviewer (event)")
      expect(sessionNodes[0].messageCount).toBe(1) // read the child's activity
      // the event front-half is still present, and the child session interleaves at its creation time.
      expect(chain.map((n) => n.kind)).toEqual(["event", "event", "session"])
      expect(chain.filter((n) => n.kind === "event").map((n) => n.type)).toEqual(["ci.failure", "agent.task.started"])
    }),
  )

  it.effect("§F2 back-half is workspace-scoped: a same-correlationID child session in another tenant does NOT leak", () =>
    Effect.gen(function* () {
      const obs = yield* Observability.Service
      const { db } = yield* Database.Service
      const CORR = "corr-bh-tenant"
      // a child session carrying the correlationID, but in ANOTHER workspace/directory.
      yield* db.insert(ProjectTable).values([{ id: "prj_bh2" as never, worktree: "/tmp/bh2" as never, sandboxes: [] as never }]).run()
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: "ses_child_bh2" as never,
            project_id: "prj_bh2" as never,
            workspace_id: "wrk_other_bh" as never,
            directory: "/tmp/bh2",
            slug: "child-bh2",
            title: "reviewer (event)",
            version: "0",
            metadata: { correlationID: CORR } as never,
            time_created: 1_150,
            time_updated: 1_150,
          } as never,
        ])
        .run()
      // querying a DIFFERENT workspace for the same correlationID must not surface the other tenant's child.
      const chain = yield* obs.trace({ workspaceID: "wrk_bh_query", correlationID: CORR })
      expect(chain.filter((n) => n.kind === "session").length).toBe(0)
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

  it.effect("§A4 event_dropped_total counts persisted drops in the window, by reason", () =>
    Effect.gen(function* () {
      const bus = yield* DeepAgentEventBus.Service
      const obs = yield* Observability.Service
      setNow(4_000)
      const e1 = yield* bus.publish(pub({ idempotencyKey: "drop-a", workspaceID: "wrk_drop" }))
      const e2 = yield* bus.publish(pub({ idempotencyKey: "drop-b", workspaceID: "wrk_drop" }))
      // two backpressure drops in the window, plus one out-of-window drop that must NOT count.
      yield* bus.recordDrop({ event: e1, reason: "backpressure" })
      yield* bus.recordDrop({ event: e2, reason: "backpressure" })
      setNow(50_000)
      const e3 = yield* bus.publish(pub({ idempotencyKey: "drop-c", workspaceID: "wrk_drop" }))
      yield* bus.recordDrop({ event: e3, reason: "backpressure" })
      const m = yield* obs.metrics({ workspaceID: "wrk_drop", from: 0, to: 10_000 })
      expect(m.eventDroppedTotal).toBe(2)
      expect(m.eventDroppedByReason).toEqual({ backpressure: 2 })
      // a different workspace's drop is not visible here (workspace-scoped).
      const other = yield* obs.metrics({ workspaceID: "wrk_1", from: 0, to: 10_000 })
      expect(other.eventDroppedTotal).toBe(0)
    }),
  )

  it.effect(
    "§A4 event_dropped_total counts DISTINCT events — one event re-shed ×3 counts as 1, not 3",
    () =>
      Effect.gen(function* () {
        const bus = yield* DeepAgentEventBus.Service
        const obs = yield* Observability.Service
        setNow(4_000)
        const e1 = yield* bus.publish(pub({ idempotencyKey: "rs-a", workspaceID: "wrk_reshed" }))
        const e2 = yield* bus.publish(pub({ idempotencyKey: "rs-b", workspaceID: "wrk_reshed" }))
        // e1 shed→nacked→re-shed ×3 on the backpressure path; e2 shed once. Idempotent per event.
        yield* bus.recordDrop({ event: e1, reason: "backpressure" })
        yield* bus.recordDrop({ event: e1, reason: "backpressure" })
        yield* bus.recordDrop({ event: e1, reason: "backpressure" })
        yield* bus.recordDrop({ event: e2, reason: "backpressure" })
        const m = yield* obs.metrics({ workspaceID: "wrk_reshed", from: 0, to: 10_000 })
        // 2 DISTINCT events shed (not 4 shed-attempts).
        expect(m.eventDroppedTotal).toBe(2)
        expect(m.eventDroppedByReason).toEqual({ backpressure: 2 })
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

  it.effect("human_takeover_total counts recorded takeovers in the window (workspace-scoped)", () =>
    Effect.gen(function* () {
      const takeovers = yield* HumanTakeover.Service
      const obs = yield* Observability.Service
      setNow(8_000)
      // no takeovers yet ⇒ 0 (a plain count, never null).
      let m = yield* obs.metrics({ workspaceID: "wrk_tko", from: 0, to: 10_000 })
      expect(m.humanTakeoverTotal).toBe(0)
      // record two takeovers in this workspace + one in another (must not leak across tenants).
      yield* takeovers.record({ workspaceID: "wrk_tko", sessionID: "ses_1", agentID: "agt_1", actorID: "human_1", reason: "paused" })
      yield* takeovers.record({ workspaceID: "wrk_tko", actorID: "human_1", reason: "claimed_branch" })
      yield* takeovers.record({ workspaceID: "wrk_other", actorID: "human_2", reason: "paused" })
      m = yield* obs.metrics({ workspaceID: "wrk_tko", from: 0, to: 10_000 })
      expect(m.humanTakeoverTotal).toBe(2) // only this workspace's takeovers
      // out-of-window takeovers are excluded.
      const narrow = yield* obs.metrics({ workspaceID: "wrk_tko", from: 9_000, to: 10_000 })
      expect(narrow.humanTakeoverTotal).toBe(0)
    }),
  )

  it.effect("rollback_total counts recorded rollbacks in the window (workspace-scoped)", () =>
    Effect.gen(function* () {
      const rollbacks = yield* RollbackAudit.Service
      const obs = yield* Observability.Service
      setNow(8_000)
      // no rollbacks yet ⇒ 0 (a plain count, never null).
      let m = yield* obs.metrics({ workspaceID: "wrk_rbk", from: 0, to: 10_000 })
      expect(m.rollbackTotal).toBe(0)
      // record two rollbacks in this workspace + one in another (must not leak across tenants).
      yield* rollbacks.record({ workspaceID: "wrk_rbk", sessionID: "ses_1", actorID: "human_1", outcome: "reverted", reason: "bad diff" })
      yield* rollbacks.record({ workspaceID: "wrk_rbk", sessionID: "ses_2", actorID: "human_1", outcome: "noop" })
      yield* rollbacks.record({ workspaceID: "wrk_rbk_other", sessionID: "ses_3", actorID: "human_2", outcome: "reverted" })
      m = yield* obs.metrics({ workspaceID: "wrk_rbk", from: 0, to: 10_000 })
      expect(m.rollbackTotal).toBe(2) // only this workspace's rollbacks
      // out-of-window rollbacks are excluded.
      const narrow = yield* obs.metrics({ workspaceID: "wrk_rbk", from: 9_000, to: 10_000 })
      expect(narrow.rollbackTotal).toBe(0)
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
