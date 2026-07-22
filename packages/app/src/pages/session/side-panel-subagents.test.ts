import { describe, expect, test } from "bun:test"
import { isSubagentInterrupted } from "./side-panel-subagents"

describe("isSubagentInterrupted", () => {
  test("recognizes the durable interrupted state", () => {
    expect(
      isSubagentInterrupted({
        metadata: { deepagent: { subagent: { state: "interrupted" } } },
      }),
    ).toBe(true)
  })

  test("retains compatibility with legacy interrupted metadata", () => {
    expect(
      isSubagentInterrupted({
        metadata: { deepagent: { subagent: { interrupted: true } } },
      }),
    ).toBe(true)
  })

  test("does not treat other states as interrupted", () => {
    expect(
      isSubagentInterrupted({
        metadata: { deepagent: { subagent: { state: "completed" } } },
      }),
    ).toBe(false)
  })
})
