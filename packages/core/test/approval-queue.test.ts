import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ApprovalQueue } from "@deepagent-code/core/deepagent/approval-queue"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "./lib/effect"

// V4.0 §D2 — the Approval Queue. Verifies the escalation gate (only needs_human-class events queue),
// idempotent enqueue, and human resolution.

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

const database = Database.layerFromPath(":memory:")
const it = testEffect(ApprovalQueue.layerWith({ now }).pipe(Layer.provideMerge(database)))

const event = (over: Partial<DeepAgentEvent.Event>): DeepAgentEvent.Event => ({
  id: DeepAgentEvent.ID.create(1_000),
  type: LMNEvents.GOAL_NEEDS_HUMAN,
  source: "system",
  workspaceID: "wrk_1",
  idempotencyKey: "k",
  priority: "normal",
  createdAt: 1_000,
  payload: {},
  ...over,
})

describe("ApprovalQueue.offer (§D2 escalation gate)", () => {
  it.effect("queues a goal.needs_human event", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const q = yield* ApprovalQueue.Service
      const item = yield* q.offer(event({ id: DeepAgentEvent.ID.create(1_000), type: LMNEvents.GOAL_NEEDS_HUMAN, payload: { goalId: "g1" } }))
      expect(item).not.toBeNull()
      expect(item?.status).toBe("pending")
      expect(item?.summary).toContain("g1")
    }),
  )

  it.effect("queues goal.rolled_back", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const q = yield* ApprovalQueue.Service
      const item = yield* q.offer(event({ id: DeepAgentEvent.ID.create(1_000), type: LMNEvents.GOAL_ROLLED_BACK }))
      expect(item?.eventType).toBe(LMNEvents.GOAL_ROLLED_BACK)
    }),
  )

  it.effect("§M panel verdict queues ONLY on decision=needs_human", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const q = yield* ApprovalQueue.Service
      const queued = yield* q.offer(event({ id: DeepAgentEvent.ID.create(1_100), type: LMNEvents.PANEL_VERDICT, payload: { decision: "needs_human" } }))
      expect(queued).not.toBeNull()
      const notQueued = yield* q.offer(event({ id: DeepAgentEvent.ID.create(1_200), type: LMNEvents.PANEL_VERDICT, payload: { decision: "approve" } }))
      expect(notQueued).toBeNull()
    }),
  )

  it.effect("a non-escalating event (goal.tick / goal.completed) does NOT queue", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const q = yield* ApprovalQueue.Service
      expect(yield* q.offer(event({ type: LMNEvents.GOAL_TICK }))).toBeNull()
      expect(yield* q.offer(event({ type: LMNEvents.GOAL_COMPLETED }))).toBeNull()
    }),
  )

  it.effect("§D2 去重: offering the same event twice queues only ONE item", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const q = yield* ApprovalQueue.Service
      const e = event({ id: DeepAgentEvent.ID.create(1_500), type: LMNEvents.GOAL_NEEDS_HUMAN })
      const first = yield* q.offer(e)
      const second = yield* q.offer(e)
      expect(first?.id).toBe(second?.id) // same row, not a duplicate
      const pending = yield* q.listPending("wrk_1")
      expect(pending.filter((i) => i.eventID === e.id).length).toBe(1)
    }),
  )
})

describe("ApprovalQueue.listPending + resolve", () => {
  it.effect("lists a workspace's pending items and excludes resolved ones", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const q = yield* ApprovalQueue.Service
      const item = yield* q.offer(event({ id: DeepAgentEvent.ID.create(2_000), type: LMNEvents.GOAL_NEEDS_HUMAN }))
      expect((yield* q.listPending("wrk_1")).some((i) => i.id === item!.id)).toBe(true)
      // resolve it → drops out of pending
      const resolved = yield* q.resolve({ id: item!.id, workspaceID: "wrk_1", decision: "approved", resolvedBy: "human-1" })
      expect(resolved?.status).toBe("resolved")
      expect(resolved?.decision).toBe("approved")
      expect(resolved?.resolvedBy).toBe("human-1")
      expect((yield* q.listPending("wrk_1")).some((i) => i.id === item!.id)).toBe(false)
    }),
  )

  it.effect("workspace isolation: listPending only returns the queried workspace's items", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const q = yield* ApprovalQueue.Service
      yield* q.offer(event({ id: DeepAgentEvent.ID.create(3_000), workspaceID: "wrk_a", type: LMNEvents.GOAL_NEEDS_HUMAN }))
      yield* q.offer(event({ id: DeepAgentEvent.ID.create(3_100), workspaceID: "wrk_b", type: LMNEvents.GOAL_NEEDS_HUMAN }))
      const a = yield* q.listPending("wrk_a")
      expect(a.every((i) => i.workspaceID === "wrk_a")).toBe(true)
      expect(a.length).toBe(1)
    }),
  )

  it.effect("resolve is idempotent: re-resolving does not change the original decision", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const q = yield* ApprovalQueue.Service
      const item = yield* q.offer(event({ id: DeepAgentEvent.ID.create(4_000), type: LMNEvents.GOAL_NEEDS_HUMAN }))
      yield* q.resolve({ id: item!.id, workspaceID: "wrk_1", decision: "approved", resolvedBy: "human-1" })
      const again = yield* q.resolve({ id: item!.id, workspaceID: "wrk_1", decision: "rejected", resolvedBy: "human-2" })
      expect(again?.decision).toBe("approved") // unchanged — first resolution wins
      expect(again?.resolvedBy).toBe("human-1")
    }),
  )

  it.effect("§D2 tenant isolation: workspace A cannot resolve workspace B's item by id", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const q = yield* ApprovalQueue.Service
      // B enqueues an item.
      const bItem = yield* q.offer(event({ id: DeepAgentEvent.ID.create(5_000), workspaceID: "wrk_b", type: LMNEvents.GOAL_NEEDS_HUMAN }))
      expect(bItem).not.toBeNull()
      // A attempts to resolve B's item by id → null (not found in A's scope), and B's item stays pending.
      const cross = yield* q.resolve({ id: bItem!.id, workspaceID: "wrk_a", decision: "approved", resolvedBy: "attacker" })
      expect(cross).toBeNull()
      const bPending = yield* q.listPending("wrk_b")
      expect(bPending.some((i) => i.id === bItem!.id && i.status === "pending")).toBe(true)
    }),
  )
})
