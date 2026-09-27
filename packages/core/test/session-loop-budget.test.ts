import { expect, test } from "bun:test"
import {
  LoopBudget,
  REPEATED_TOOL_LIMIT,
  repeatedIdenticalTool,
  toolInputIdentity,
} from "../src/session/runner/loop-budget"

test("one activity stops the third identical tool input and a new activity resets it", () => {
  const budget = new LoopBudget(4)
  budget.forActivity("activity-a")
  expect(budget.observeTool("1", "read", { path: "a", offset: 1 })).toBeUndefined()
  budget.markToolDone("1")
  expect(budget.observeTool("2", "read", { offset: 1, path: "a" })).toBeUndefined()
  budget.markToolDone("2")
  expect(budget.observeTool("3", "read", { path: "a", offset: 1 })).toMatchObject({
    tool: "read",
    count: REPEATED_TOOL_LIMIT,
  })
  budget.forActivity("activity-a")
  expect(budget.repeatedTool()).toBeDefined()
  budget.forActivity("activity-b")
  expect(budget.observeTool("4", "read", { path: "a", offset: 1 })).toBeUndefined()
})

test("a different tool or input breaks the consecutive sequence", () => {
  const budget = new LoopBudget(2)
  budget.forActivity("activity")
  expect(budget.stepLimitReached(1)).toBeFalse()
  expect(budget.stepLimitReached(2)).toBeTrue()
  expect(budget.observeTool("1", "read", { path: "a" })).toBeUndefined()
  budget.markToolDone("1")
  expect(budget.observeTool("2", "read", { path: "b" })).toBeUndefined()
  budget.markToolDone("2")
  expect(budget.observeTool("3", "edit", { path: "b" })).toBeUndefined()
  budget.markToolDone("3")
  expect(budget.observeTool("4", "read", { path: "b" })).toBeUndefined()
  expect(budget.repeatedTool()).toBeUndefined()
})

test("period-1 decision waits for prior settlements and uses canonical name/input hashes", () => {
  const call = toolInputIdentity("read", { b: 2, a: undefined })
  expect(call).toEqual(toolInputIdentity("read", { a: null, b: 2 }))
  expect(call.fingerprint).not.toBe(toolInputIdentity("edit", { b: 2, a: null }).fingerprint)
  expect(
    repeatedIdenticalTool([
      { fingerprint: call.fingerprint, done: true },
      { fingerprint: call.fingerprint, done: false },
      { fingerprint: call.fingerprint, done: false },
    ]),
  ).toBeUndefined()
  expect(
    repeatedIdenticalTool([
      { fingerprint: call.fingerprint, done: true },
      { fingerprint: call.fingerprint, done: true },
      { fingerprint: call.fingerprint, done: false },
    ]),
  ).toBe(call.fingerprint)
})
