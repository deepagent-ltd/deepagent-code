import { describe, expect, test } from "bun:test"
import { isSubagentInterrupted } from "./subagent-state"

describe("isSubagentInterrupted", () => {
  test("recognizes durable state and legacy boolean interruption markers", () => {
    expect(isSubagentInterrupted({ deepagent: { subagent: { state: "interrupted" } } })).toBe(true)
    expect(isSubagentInterrupted({ deepagent: { subagent: { interrupted: true } } })).toBe(true)
    expect(isSubagentInterrupted({ deepagent: { subagent: { state: "finished" } } })).toBe(false)
  })
})
