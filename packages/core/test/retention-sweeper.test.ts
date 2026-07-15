import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { RetentionSweeper } from "@deepagent-code/core/deepagent/retention-sweeper"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentEventDeliveryTable } from "@deepagent-code/core/deepagent/deepagent-event-sql"
import { ApprovalQueueTable } from "@deepagent-code/core/deepagent/approval-queue-sql"
import { AgentPushLogTable } from "@deepagent-code/core/im/push-log-sql"
import { testEffect } from "./lib/effect"

// V4.0 §A3 保留期 — the retention sweep + sweeper daemon. Verifies age-based deletion, referential
// safety (a pending delivery / unresolved approval spares its event), per-workspace retentionDays, and
// workspace isolation. `now` is a deterministic clock so the cutoff math is exact.

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

const DAY = 86_400_000

const database = Database.layerFromPath(":memory:")
const bus = DeepAgentEventBus.layerWith({ now }).pipe(Layer.provideMerge(database))
const cfg = WorkspaceConfig.layerWith({ now }).pipe(Layer.provideMerge(database))
// runLoop:false — drive sweepOnce directly for determinism.
const sweeper = RetentionSweeper.layerWith({ now, runLoop: false }).pipe(
  Layer.provide(bus),
  Layer.provide(cfg),
  Layer.provide(database),
)
const it = testEffect(Layer.mergeAll(sweeper, bus, cfg, database))

const publishAt = (bus: DeepAgentEventBus.Interface, at: number, over?: Partial<DeepAgentEvent.PublishInput>) => {
  setNow(at)
  return bus.publish({
    type: "ci.failure",
    source: "ci",
    workspaceID: "wrk_1",
    idempotencyKey: `k-${at}-${Math.random()}`,
    payload: { failedTests: 1 },
    ...over,
  })
}

describe("RetentionSweeper", () => {
  it.effect("§A3 deletes events older than retention, keeps fresh ones", () =>
    Effect.gen(function* () {
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })

      const old = yield* publishAt(b, 1_000) // ancient
      const fresh = yield* publishAt(b, 100 * DAY) // recent

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.deletedEvents).toBe(1)

      const remaining = yield* b.getByID(old.id)
      expect(remaining).toBeUndefined() // swept
      const kept = yield* b.getByID(fresh.id)
      expect(kept?.id).toBe(fresh.id) // spared
    }),
  )

  it.effect("§A3 referential safety: an event with a PENDING delivery survives its retention window", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })

      const owed = yield* publishAt(b, 1_000)
      const plain = yield* publishAt(b, 2_000)
      // an unacked at-least-once delivery still owes `owed` to a consumer group.
      yield* db
        .insert(DeepAgentEventDeliveryTable)
        .values([
          {
            event_id: owed.id,
            subscription_group: "router",
            status: "pending",
            attempts: 0,
            last_error: null,
            next_attempt_at: 1_000,
            created_at: 1_000,
            updated_at: 1_000,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.deletedEvents).toBe(1) // only `plain`

      expect(yield* b.getByID(owed.id)).toBeDefined() // spared — still owed
      expect(yield* b.getByID(plain.id)).toBeUndefined()
    }),
  )

  it.effect("§A3 referential safety: a DELIVERED delivery does NOT protect its event (cascades)", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })

      const done = yield* publishAt(b, 1_000)
      yield* db
        .insert(DeepAgentEventDeliveryTable)
        .values([
          {
            event_id: done.id,
            subscription_group: "router",
            status: "delivered",
            attempts: 0,
            last_error: null,
            next_attempt_at: null,
            created_at: 1_000,
            updated_at: 1_000,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.deletedEvents).toBe(1)
      expect(yield* b.getByID(done.id)).toBeUndefined()
      // the delivery row cascaded away with the event.
      const deliveries = yield* db.select().from(DeepAgentEventDeliveryTable).all().pipe(Effect.orDie)
      expect(deliveries.length).toBe(0)
    }),
  )

  it.effect("§A3 referential safety: an UNRESOLVED approval-queue item spares its event", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })

      const escalated = yield* publishAt(b, 1_000)
      yield* db
        .insert(ApprovalQueueTable)
        .values([
          {
            id: "apq_1",
            workspace_id: "wrk_1",
            event_id: escalated.id,
            event_type: "goal.needs_human",
            correlation_id: null,
            summary: "needs a human",
            status: "pending",
            decision: null,
            resolved_by: null,
            resolved_at: null,
            created_at: 1_000,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      setNow(100 * DAY)
      yield* s.sweepOnce()
      expect(yield* b.getByID(escalated.id)).toBeDefined() // spared — human still owes a decision
    }),
  )

  it.effect("§A3 a RESOLVED approval-queue item does NOT spare its event and is itself pruned", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })

      const settled = yield* publishAt(b, 1_000)
      yield* db
        .insert(ApprovalQueueTable)
        .values([
          {
            id: "apq_2",
            workspace_id: "wrk_1",
            event_id: settled.id,
            event_type: "goal.needs_human",
            correlation_id: null,
            summary: "was resolved",
            status: "resolved",
            decision: "approved",
            resolved_by: "user_1",
            resolved_at: 2_000,
            created_at: 1_000,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(yield* b.getByID(settled.id)).toBeUndefined() // resolved item doesn't protect it
      expect(summary.deletedApprovals).toBe(1) // and the resolved row is pruned
      const approvals = yield* db.select().from(ApprovalQueueTable).all().pipe(Effect.orDie)
      expect(approvals.length).toBe(0)
    }),
  )

  it.effect("§A3 respects PER-WORKSPACE retentionDays", () =>
    Effect.gen(function* () {
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      // wrk_short keeps 1 day; wrk_long keeps 90.
      yield* c.set("wrk_short", { retentionDays: 1 })
      yield* c.set("wrk_long", { retentionDays: 90 })

      const shortEvt = yield* publishAt(b, 100 * DAY, { workspaceID: "wrk_short" })
      const longEvt = yield* publishAt(b, 100 * DAY, { workspaceID: "wrk_long" })

      // 10 days later: past wrk_short's 1-day window, within wrk_long's 90-day window.
      setNow(110 * DAY)
      yield* s.sweepOnce()
      expect(yield* b.getByID(shortEvt.id)).toBeUndefined() // 10d > 1d retention
      expect(yield* b.getByID(longEvt.id)).toBeDefined() // 10d < 90d retention
    }),
  )

  it.effect("§A3 workspace isolation: a sweep never crosses workspace boundaries", () =>
    Effect.gen(function* () {
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_a", { retentionDays: 1 })
      yield* c.set("wrk_b", { retentionDays: 1 })

      const a = yield* publishAt(b, 1_000, { workspaceID: "wrk_a" })
      const b1 = yield* publishAt(b, 100 * DAY, { workspaceID: "wrk_b" }) // fresh in B

      setNow(100 * DAY)
      yield* s.sweepOnce()
      expect(yield* b.getByID(a.id)).toBeUndefined() // A's old event swept
      expect(yield* b.getByID(b1.id)).toBeDefined() // B's fresh event untouched
    }),
  )

  it.effect("§B4 prunes agent push audit rows past retention", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const b = yield* DeepAgentEventBus.Service
      const c = yield* WorkspaceConfig.Service
      const s = yield* RetentionSweeper.Service
      yield* c.set("wrk_1", { retentionDays: 30 })
      // an event so the workspace is enumerated by the sweep.
      yield* publishAt(b, 100 * DAY)

      yield* db
        .insert(AgentPushLogTable)
        .values([
          {
            id: "push_old",
            workspace_id: "wrk_1",
            group_id: "img_1" as any,
            agent_id: "agt_1",
            reason: "old",
            priority: "normal",
            decision: "deliver",
            idempotency_key: "old-1",
            message_id: null,
            content: null,
            created_at: 1_000,
          },
          {
            id: "push_new",
            workspace_id: "wrk_1",
            group_id: "img_1" as any,
            agent_id: "agt_1",
            reason: "new",
            priority: "normal",
            decision: "deliver",
            idempotency_key: "new-1",
            message_id: null,
            content: null,
            created_at: 100 * DAY,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      setNow(100 * DAY)
      const summary = yield* s.sweepOnce()
      expect(summary.deletedPushLogs).toBe(1)
      const logs = yield* db.select().from(AgentPushLogTable).all().pipe(Effect.orDie)
      expect(logs.map((l) => l.id)).toEqual(["push_new"])
    }),
  )
})
