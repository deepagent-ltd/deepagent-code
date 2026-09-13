import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionHistoryProjection } from "../src/session/runner/session-history-projection"
import { SessionMessage } from "../src/session/message"
import { ToolOutput } from "@deepagent-code/core/tool-output"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"

// G3 history projection — the contracts that make it cache-safe:
//   determinism (same rows ⇒ same bytes), error preservation, resent-tail protection,
//   per-class caps, and the env kill-switch.

const model = { providerID: ProviderV2.ID.make("p"), id: ModelV2.ID.make("m") } as const

const assistantWithTool = (
  name: string,
  text: string,
  status: "completed" | "error" = "completed",
): SessionMessage.Message =>
  SessionMessage.Assistant.make({
    type: "assistant",
    id: `msg_${name}_${status}` as SessionMessage.ID,
    agent: "build",
    model,
    finish: "tool-calls",
    time: { created: DateTime.makeUnsafe(1) },
    content: [
      SessionMessage.AssistantTool.make({
        type: "tool",
        id: `tool_${name}_${status}`,
        name,
        time: { created: DateTime.makeUnsafe(1) },
        state:
          status === "completed"
            ? SessionMessage.ToolStateCompleted.make({
                status: "completed",
                input: {},
                content: [ToolOutput.text({ type: "text", text })],
                outputPaths: [],
                structured: {},
              })
            : SessionMessage.ToolStateError.make({
                status: "error",
                input: {},
                content: [ToolOutput.text({ type: "text", text })],
                structured: {},
                error: { type: "unknown", message: text.slice(0, 200) },
              }),
      }),
    ],
  })

const longText = (chars: number) => "x".repeat(chars)

const toolTextOf = (message: SessionMessage.Message) => {
  const part = (message as SessionMessage.Assistant).content[0] as SessionMessage.AssistantTool
  if (part.state.status !== "completed" && part.state.status !== "error") return ""
  const first = part.state.content[0]
  return first?.type === "text" ? first.text : ""
}

describe("session history projection", () => {
  // The default resent-tail window is 4 settled results; a message only qualifies for
  // projection when it sits BEYOND that window. Every truncation test pads with 4 newer
  // settled results so the target is genuinely historical.
  const pad = (): SessionMessage.Message[] => [
    assistantWithTool("bash", "a"),
    assistantWithTool("bash", "b"),
    assistantWithTool("bash", "c"),
    assistantWithTool("bash", "d"),
  ]

  test("disabled returns the same reference", () => {
    const messages = [assistantWithTool("bash", longText(200_000))]
    process.env["DEEPAGENT_CODE_HISTORY_PROJECTION"] = "false"
    try {
      expect(SessionHistoryProjection.projectForModel(messages)).toBe(messages)
    } finally {
      delete process.env["DEEPAGENT_CODE_HISTORY_PROJECTION"]
    }
  })

  test("oversized bash output is truncated head+tail with a marker", () => {
    SessionHistoryProjection.projectionStats.reset()
    const text = `HEAD${longText(100_000)}TAIL`
    const projected = SessionHistoryProjection.projectForModel([assistantWithTool("bash", text), ...pad()])
    const projectedText = toolTextOf(projected[0]!)
    expect(projectedText.length).toBeLessThan(text.length)
    expect(projectedText).toContain("HEAD")
    expect(projectedText).toContain("TAIL")
    expect(projectedText).toContain("projected")
    expect(SessionHistoryProjection.projectionSummary().truncated).toBe(1)
  })

  test("the cap is a true bound — the excerpt INCLUDING the marker never exceeds it", () => {
    SessionHistoryProjection.projectionStats.reset()
    const text = `HEAD${longText(200_000)}TAIL`
    const projected = SessionHistoryProjection.projectForModel([assistantWithTool("bash", text), ...pad()])
    // bash default cap is 40_000 codepoints, marker included (review fix).
    expect([...toolTextOf(projected[0]!)].length).toBeLessThanOrEqual(40_000)
  })

  test("errors get the 4x budget — large but bounded", () => {
    SessionHistoryProjection.projectionStats.reset()
    const projected = SessionHistoryProjection.projectForModel([
      assistantWithTool("bash", longText(200_000), "error"),
      ...pad(),
    ])
    const part = (projected[0] as SessionMessage.Assistant).content[0] as SessionMessage.AssistantTool
    expect(part.state.status).toBe("error")
    // 200_000 > 4 × 40_000 ⇒ truncated; anything under the 4× budget stays intact.
    expect([...toolTextOf(projected[0]!)].length).toBeLessThanOrEqual(160_000)
    expect([...toolTextOf(projected[0]!)].length).toBeGreaterThan(40_000)
  })

  test("errors under the 4x budget are never truncated", () => {
    SessionHistoryProjection.projectionStats.reset()
    const projected = SessionHistoryProjection.projectForModel([
      assistantWithTool("bash", longText(100_000), "error"),
      ...pad(),
    ])
    expect((projected[0] as SessionMessage.Assistant).content[0]).toHaveProperty("state.status", "error")
    // 100_000 < 4 × 40_000 ⇒ intact (the model keeps the full repair evidence).
    expect(SessionHistoryProjection.projectionSummary().truncated).toBe(0)
  })

  test("the resent tail (latest results) survives verbatim", () => {
    SessionHistoryProjection.projectionStats.reset()
    const old = assistantWithTool("bash", longText(100_000))
    const recent = assistantWithTool("bash", longText(100_000))
    const projected = SessionHistoryProjection.projectForModel([old, recent, ...pad().slice(0, 3)])
    expect(toolTextOf(projected[1]!).length).toBe(100_000)
    // Only the older result was truncated.
    expect(SessionHistoryProjection.projectionSummary().truncated).toBe(1)
  })

  test("results inside the resent window are never truncated", () => {
    SessionHistoryProjection.projectionStats.reset()
    const big = assistantWithTool("bash", longText(200_000))
    expect(SessionHistoryProjection.projectForModel([big])[0]).toBe(big)
    expect(SessionHistoryProjection.projectionSummary().truncated).toBe(0)
  })

  test("deterministic — same rows project to identical bytes across calls", () => {
    const messages = [assistantWithTool("bash", longText(100_000)), ...pad()]
    const first = SessionHistoryProjection.projectForModel(messages)
    const second = SessionHistoryProjection.projectForModel(messages)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  test("a projected row stays byte-stable when newer turns arrive (cache prefix holds)", () => {
    const early = [assistantWithTool("bash", longText(100_000)), ...pad()]
    const earlyProjected = JSON.stringify(SessionHistoryProjection.projectForModel(early))
    const later = [...early, assistantWithTool("bash", "newer")]
    const laterProjected = JSON.stringify(SessionHistoryProjection.projectForModel(later).slice(0, early.length))
    expect(laterProjected).toBe(earlyProjected)
  })

  test("unknown tool names and under-cap results pass through untouched", () => {
    SessionHistoryProjection.projectionStats.reset()
    const projected = SessionHistoryProjection.projectForModel([
      assistantWithTool("mcp__custom__tool", longText(100_000)),
      ...pad(),
    ])
    expect(toolTextOf(projected[0]!).length).toBe(100_000)
    expect(SessionHistoryProjection.projectionSummary().truncated).toBe(0)
  })

  test("multibyte characters are never split (codepoint-safe excerpt)", () => {
    SessionHistoryProjection.projectionStats.reset()
    const projected = SessionHistoryProjection.projectForModel([assistantWithTool("bash", "汉".repeat(60_000)), ...pad()])
    const projectedText = toolTextOf(projected[0]!)
    expect(projectedText.length).toBeLessThan(60_000)
    // No replacement chars from splitting surrogate pairs mid-unit, and no lone halves
    // (String.fromCodePoint round-trip would produce U+FFFD on a broken pair).
    expect(projectedText).not.toContain("\uFFFD")
    expect(projectedText).toContain("汉")
  })
})
