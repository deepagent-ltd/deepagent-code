import { expect, test } from "bun:test"
import { LoopBudget, REPEATED_TOOL_LIMIT } from "../src/session/runner/loop-budget"

test("one activity stops the third identical tool input and a new activity resets it", () => {
  const budget = new LoopBudget(4)
  budget.forActivity("activity-a")
  expect(budget.observeTool("read", { path: "a", offset: 1 })).toBeUndefined()
  expect(budget.observeTool("read", { offset: 1, path: "a" })).toBeUndefined()
  expect(budget.observeTool("read", { path: "a", offset: 1 })).toMatchObject({
    tool: "read",
    count: REPEATED_TOOL_LIMIT,
  })
  budget.forActivity("activity-a")
  expect(budget.repeatedTool()).toBeDefined()
  budget.forActivity("activity-b")
  expect(budget.observeTool("read", { path: "a", offset: 1 })).toBeUndefined()
})

test("a different tool or input breaks the consecutive sequence", () => {
  const budget = new LoopBudget(2)
  budget.forActivity("activity")
  expect(budget.stepLimitReached(1)).toBeFalse()
  expect(budget.stepLimitReached(2)).toBeTrue()
  expect(budget.observeTool("read", { path: "a" })).toBeUndefined()
  expect(budget.observeTool("read", { path: "b" })).toBeUndefined()
  expect(budget.observeTool("edit", { path: "b" })).toBeUndefined()
  expect(budget.observeTool("read", { path: "b" })).toBeUndefined()
  expect(budget.repeatedTool()).toBeUndefined()
})
