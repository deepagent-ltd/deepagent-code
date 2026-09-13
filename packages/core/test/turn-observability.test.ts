import { describe, expect, test } from "bun:test"
import * as turnObservability from "../src/deepagent/turn-observability"

// Pure process-local counters — no Effect services needed, so plain bun:test drives them directly.
const usage = { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

describe("turn observability", () => {
  test("splits a prepared request into history / control / tool-result parts", () => {
    const parts = turnObservability.preparedParts({
      stableSystemParts: ["a".repeat(400)],
      volatileSystemParts: ["b".repeat(100)],
      controlMessage: "c".repeat(200),
      historyMessages: [
        { role: "user", content: "hello world" },
        { role: "assistant", content: [{ type: "text", text: "d".repeat(80) }] },
        { role: "assistant", content: [{ type: "tool-call", id: "1", name: "bash", input: {} }] },
        {
          role: "tool",
          content: [{ type: "tool-result", id: "1", name: "bash", result: { type: "text", value: "e".repeat(4000) } }],
        },
      ],
    })
    // stable 400 chars -> 100 tokens; volatile 100 -> 25; control 200 -> 50.
    expect(parts.stable_system).toBe(100)
    expect(parts.volatile_system).toBe(25)
    expect(parts.control_message).toBe(50)
    // Tool results are separated from history (this is the tool-output projection baseline). The
    // estimate is the FULL serialized part (the wrapper rides with the payload, as on the wire).
    expect(parts.tool_result_parts).toBe(1)
    expect(parts.tool_results).toBeGreaterThan(1000)
    expect(parts.tool_results).toBeLessThan(1100)
    expect(parts.history).toBeGreaterThan(0)
    expect(parts.total_estimated).toBe(
      parts.stable_system + parts.volatile_system + parts.control_message + parts.history + parts.tool_results,
    )
  })

  test("counts empty steps only for non-error turns without tool calls", () => {
    turnObservability.recordTurn({ seq: 1, finish: "stop", toolCalls: 0, usage })
    turnObservability.recordTurn({ seq: 2, finish: "tool-calls", toolCalls: 3, usage })
    turnObservability.recordTurn({ seq: 3, finish: "error", toolCalls: 0, usage })
    const summary = turnObservability.turnSummary()
    expect(summary.turns).toBeGreaterThanOrEqual(3)
    expect(summary.behavior.empty_steps).toBeGreaterThanOrEqual(1)
    expect(summary.finish["tool-calls"]).toBeGreaterThanOrEqual(1)
  })

  test("pairs prepared parts with the matching turn report by seq", () => {
    const parts = turnObservability.preparedParts({
      stableSystemParts: ["x".repeat(40)],
      volatileSystemParts: [],
      controlMessage: undefined,
      historyMessages: [],
    })
    turnObservability.recordPrepared(999, parts)
    turnObservability.recordTurn({ seq: 999, finish: "stop", toolCalls: 0, usage })
    const last = turnObservability.recordedTurns().at(-1)
    expect(last?.parts).toBe(parts)
  })
})
