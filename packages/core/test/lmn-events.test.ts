import { describe, expect, test } from "bun:test"
import { LMNEvents } from "@deepagent-code/core/deepagent/lmn-events"

// LMNEvents is a constants/predicate module — plain unit tests lock the vocabulary + membership.

describe("LMNEvents", () => {
  test("event type strings are stable", () => {
    expect(LMNEvents.SESSION_COMPLETED).toBe("session.completed")
    expect(LMNEvents.GOAL_TICK).toBe("goal.tick")
    expect(LMNEvents.GOAL_COMPLETED).toBe("goal.completed")
    expect(LMNEvents.PANEL_VERDICT).toBe("panel.verdict")
  })

  test("§D2 Approval Queue candidate membership (coarse)", () => {
    expect(LMNEvents.isApprovalQueueCandidate(LMNEvents.GOAL_NEEDS_HUMAN)).toBe(true)
    expect(LMNEvents.isApprovalQueueCandidate(LMNEvents.GOAL_ROLLED_BACK)).toBe(true)
    expect(LMNEvents.isApprovalQueueCandidate(LMNEvents.PANEL_VERDICT)).toBe(true)
    expect(LMNEvents.isApprovalQueueCandidate(LMNEvents.GOAL_TICK)).toBe(false)
  })

  test("§D2 shouldQueueForApproval folds the PANEL_VERDICT payload gate", () => {
    // goal terminal states always queue
    expect(LMNEvents.shouldQueueForApproval({ type: LMNEvents.GOAL_NEEDS_HUMAN, payload: {} })).toBe(true)
    expect(LMNEvents.shouldQueueForApproval({ type: LMNEvents.GOAL_ROLLED_BACK, payload: null })).toBe(true)
    // a panel verdict queues ONLY on needs_human — not approve/revise/block
    expect(LMNEvents.shouldQueueForApproval({ type: LMNEvents.PANEL_VERDICT, payload: { decision: "needs_human" } })).toBe(true)
    expect(LMNEvents.shouldQueueForApproval({ type: LMNEvents.PANEL_VERDICT, payload: { decision: "approve" } })).toBe(false)
    expect(LMNEvents.shouldQueueForApproval({ type: LMNEvents.PANEL_VERDICT, payload: {} })).toBe(false)
    expect(LMNEvents.shouldQueueForApproval({ type: LMNEvents.GOAL_TICK, payload: {} })).toBe(false)
  })

  test("§N goalPhaseToEventType bridges the goal.updated phase → discrete lifecycle type", () => {
    expect(LMNEvents.goalPhaseToEventType("done")).toBe(LMNEvents.GOAL_COMPLETED)
    expect(LMNEvents.goalPhaseToEventType("needs_human")).toBe(LMNEvents.GOAL_NEEDS_HUMAN)
    expect(LMNEvents.goalPhaseToEventType("rolled_back")).toBe(LMNEvents.GOAL_ROLLED_BACK)
    // transient phases have no discrete lifecycle event
    expect(LMNEvents.goalPhaseToEventType("running")).toBeUndefined()
    expect(LMNEvents.goalPhaseToEventType("paused")).toBeUndefined()
    expect(LMNEvents.goalPhaseToEventType("stopped")).toBeUndefined()
  })

  test("§L archive-trigger membership", () => {
    expect(LMNEvents.isArchiveTrigger(LMNEvents.SESSION_COMPLETED)).toBe(true)
    expect(LMNEvents.isArchiveTrigger(LMNEvents.GOAL_COMPLETED)).toBe(true)
    expect(LMNEvents.isArchiveTrigger(LMNEvents.GOAL_TICK)).toBe(false)
    expect(LMNEvents.isArchiveTrigger(LMNEvents.PANEL_VERDICT)).toBe(false)
  })
})
