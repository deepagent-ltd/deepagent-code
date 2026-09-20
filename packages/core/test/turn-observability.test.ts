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

  // The ablation question is "where did the tokens go on THIS run?", and the previous sampling rule
  // (first three prepares only) answered it with a three-point curve for a 179-turn run.
  test("keeps a bounded context trajectory across a long run", () => {
    for (let seq = 1; seq <= 120; seq++) {
      turnObservability.recordPrepared(
        seq,
        turnObservability.preparedParts({
          stableSystemParts: ["s".repeat(40)],
          volatileSystemParts: [],
          controlMessage: undefined,
          historyMessages: [{ role: "user", content: "h".repeat(4 * seq) }],
        }),
      )
      turnObservability.recordTurn({ seq, finish: "tool-calls", toolCalls: 1, usage })
    }
    const summary = turnObservability.turnSummary()
    const trajectory = summary.context_trajectory
    // Head samples + stride samples, bounded well below the turn count.
    expect(trajectory.length).toBeGreaterThan(6)
    expect(trajectory.length).toBeLessThan(120)
    // The curve must actually GROW: that is the fact the old sampling hid.
    expect(trajectory.at(-1)!.total).toBeGreaterThan(trajectory[0]!.total)
    // Replay ratio: billed input over the final context (quadratic blow-up indicator).
    expect(typeof summary.replay_ratio).toBe("number")
  })

  test("breaks the per-turn request into composition buckets, tool schema included", () => {
    const parts = turnObservability.preparedParts({
      stableSystemParts: ["s".repeat(400)],
      volatileSystemParts: ["v".repeat(40)],
      controlMessage: "c".repeat(40),
      historyMessages: [
        { role: "user", content: [{ type: "text", text: "u".repeat(80) }] },
        { role: "assistant", content: [{ type: "text", text: "n".repeat(120) }] },
        { role: "assistant", content: [{ type: "tool-call", id: "1", name: "apply_patch", input: "p".repeat(200) }] },
        {
          role: "tool",
          content: [
            { type: "tool-result", id: "1", name: "apply_patch", result: { type: "text", value: "r".repeat(400) } },
          ],
        },
      ],
      // The schema the provider re-receives on every turn.
      toolDefinitions: [{ name: "read", inputSchema: "t".repeat(800) }],
    })
    const c = parts.composition
    expect(c.stable_system).toBe(parts.stable_system)
    expect(c.volatile_system).toBe(parts.volatile_system)
    expect(c.control_message).toBe(parts.control_message)
    expect(c.tool_definitions).toBeGreaterThan(200)
    // The tool CALL echo (its arguments carry the patch) is separated from narration and results.
    expect(c.history_tool_calls).toBeGreaterThan(c.history_assistant_text)
    expect(c.history_tool_results).toBe(parts.tool_results)
    expect(c.history_user).toBeGreaterThan(0)
    // The buckets account for the whole measured request.
    const summed =
      c.stable_system +
      c.tool_definitions +
      c.volatile_system +
      c.control_message +
      c.history_assistant_text +
      c.history_tool_calls +
      c.history_tool_results +
      c.history_user +
      c.history_other
    expect(summed).toBeGreaterThanOrEqual(parts.total_estimated)
  })

  test("counts identical repeats and re-reads of an already-read path", () => {
    turnObservability.recordToolCall("read", "src/a.ts", "ses_repeat")
    turnObservability.recordToolCall("read", "src/a.ts", "ses_repeat")
    turnObservability.recordToolCall("read", "src/b.ts", "ses_repeat")
    turnObservability.recordToolCall("bash", "go test ./...", "ses_repeat")
    turnObservability.recordToolCall("bash", "go test ./...", "ses_repeat")
    const behavior = turnObservability.turnSummary("ses_repeat").behavior
    expect(behavior.repeated_read_calls).toBe(1)
    expect(behavior.distinct_read_paths).toBe(2)
    expect(behavior.repeat_tool_calls).toBe(2)
  })

  // G-B: the paging loop the traces showed (one file read 7-8 times through different windows) is
  // not an identical repeat, so an identical-call guard alone would never fire for it.
  test("nudges re-reads of the same path and identical repeats, never the first call", () => {
    const id = "ses_nudge"
    expect(turnObservability.recordToolCall("read", "evaluator/evaluator.go", id)).toBeUndefined()
    expect(turnObservability.recordToolCall("read", "evaluator/evaluator.go", id)).toBeUndefined()
    // Identical args hit the identical-call ladder first (3)...
    expect(turnObservability.recordToolCall("read", "evaluator/evaluator.go", id)).toContain("made 3 times")
    // ...and the read ladder (4) catches the paging loop that identical-args never would.
    const readNudge = turnObservability.recordToolCall("read", "evaluator/evaluator.go", id)
    expect(readNudge).toContain("has been read 4 times")
    expect(readNudge).toContain("evaluator/evaluator.go")
    // Identical arguments earn the identical-call ladder (3/5/8), not the read ladder.
    expect(turnObservability.recordToolCall("bash", "go test ./...", id)).toBeUndefined()
    expect(turnObservability.recordToolCall("bash", "go test ./...", id)).toBeUndefined()
    const identical = turnObservability.recordToolCall("bash", "go test ./...", id)
    expect(identical).toContain("made 3 times")
    // The identical ladder keeps escalating on the same call (5, then 8) — a nudge at each
    // threshold, not at every turn.
    expect(turnObservability.recordToolCall("read", "evaluator/evaluator.go", id)).toContain("made 5 times")
    // A different path, and a first read of it, earn nothing: paging forward is not punished.
    expect(turnObservability.recordToolCall("read", "parser/parser.go", id)).toBeUndefined()
  })
})
