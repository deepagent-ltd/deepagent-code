import { describe, expect, test } from "bun:test"
import { isInterruptedSubagent } from "./subagent-state"

describe("isInterruptedSubagent", () => {
  test("recognizes durable state and legacy boolean interruption markers", () => {
    expect(isInterruptedSubagent({ deepagent: { subagent: { state: "interrupted" } } })).toBe(true)
    expect(isInterruptedSubagent({ deepagent: { subagent: { interrupted: true } } })).toBe(true)
    expect(isInterruptedSubagent({ deepagent: { subagent: { state: "finished" } } })).toBe(false)
  })
})
