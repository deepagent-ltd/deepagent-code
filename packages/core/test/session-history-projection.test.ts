import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionHistoryProjection } from "../src/session/runner/session-history-projection"
import { SessionMessage } from "../src/session/message"
import { ToolOutput } from "@deepagent-code/core/tool-output"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"

// G3 history projection — the contracts that make it cache-safe:
//   determinism (same rows ⇒ same bytes), error preservation, resent-tail protection,
//   per-class caps, and the env kill-switch.
//
// Review round 2: projectForModel returns { messages, truncated, savedChars } — the stats are
// per-call (no module-global counters), so every assertion below reads the SAME result object.

// This suite pins the per-result CAP contract (excerpt, error budget, resent tail). The CLEAR
// window is a separate behaviour with its own suite; pinning it off here keeps every assertion
// below about one mechanism.
beforeAll(() => {
  process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_AFTER"] = "0"
})
afterAll(() => {
  delete process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_AFTER"]
})

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

// The default resent-tail window is 4 settled results; a message only qualifies for projection
// when it sits BEYOND that window. Every truncation test pads with newer settled results so the
// target is genuinely historical.
const pad = (count = 4, name = "bash"): SessionMessage.Message[] =>
  Array.from({ length: count }, (_, index) => assistantWithTool(name, String.fromCharCode(97 + index)))

describe("session history projection", () => {
  test("disabled returns the same reference with zero stats", () => {
    const messages = [assistantWithTool("bash", longText(200_000))]
    process.env["DEEPAGENT_CODE_HISTORY_PROJECTION"] = "false"
    try {
      const result = SessionHistoryProjection.projectForModel(messages)
      expect(result.messages).toBe(messages)
      expect(result.truncated).toBe(0)
    } finally {
      delete process.env["DEEPAGENT_CODE_HISTORY_PROJECTION"]
    }
  })

  test("oversized bash output is truncated head+tail with a marker, stats on the result", () => {
    const text = `HEAD${longText(100_000)}TAIL`
    const result = SessionHistoryProjection.projectForModel([assistantWithTool("bash", text), ...pad()])
    const projectedText = toolTextOf(result.messages[0]!)
    expect(projectedText.length).toBeLessThan(text.length)
    expect(projectedText).toContain("HEAD")
    expect(projectedText).toContain("TAIL")
    expect(projectedText).toContain("projected")
    expect(result.truncated).toBe(1)
    expect(result.savedChars).toBeGreaterThan(0)
  })

  test("the cap is a true bound — the excerpt INCLUDING the marker never exceeds it", () => {
    const text = `HEAD${longText(200_000)}TAIL`
    const result = SessionHistoryProjection.projectForModel([assistantWithTool("bash", text), ...pad()])
    // bash default cap is 40_000 codepoints, marker included (review fix).
    expect([...toolTextOf(result.messages[0]!)].length).toBeLessThanOrEqual(40_000)
  })

  test("errors get the 4x budget — large but bounded", () => {
    const result = SessionHistoryProjection.projectForModel([
      assistantWithTool("bash", longText(200_000), "error"),
      ...pad(),
    ])
    const part = (result.messages[0] as SessionMessage.Assistant).content[0] as SessionMessage.AssistantTool
    expect(part.state.status).toBe("error")
    // 200_000 > 4 × 40_000 ⇒ truncated; anything under the 4× budget stays intact.
    expect([...toolTextOf(result.messages[0]!)].length).toBeLessThanOrEqual(160_000)
    expect([...toolTextOf(result.messages[0]!)].length).toBeGreaterThan(40_000)
  })

  test("errors under the 4x budget are never truncated", () => {
    const result = SessionHistoryProjection.projectForModel([
      assistantWithTool("bash", longText(100_000), "error"),
      ...pad(),
    ])
    expect((result.messages[0] as SessionMessage.Assistant).content[0]).toHaveProperty("state.status", "error")
    // 100_000 < 4 × 40_000 ⇒ intact (the model keeps the full repair evidence).
    expect(result.truncated).toBe(0)
  })

  test("the resent tail (latest results) survives verbatim", () => {
    const old = assistantWithTool("bash", longText(100_000))
    const recent = assistantWithTool("bash", longText(100_000))
    const result = SessionHistoryProjection.projectForModel([old, recent, ...pad().slice(0, 3)])
    expect(toolTextOf(result.messages[1]!).length).toBe(100_000)
    // Only the older result was truncated.
    expect(result.truncated).toBe(1)
  })

  test("results inside the resent window are never truncated", () => {
    const big = assistantWithTool("bash", longText(200_000))
    const result = SessionHistoryProjection.projectForModel([big])
    expect(result.messages[0]).toBe(big)
    expect(result.truncated).toBe(0)
  })

  test("deterministic — same rows project to identical bytes across calls", () => {
    const messages = [assistantWithTool("bash", longText(100_000)), ...pad()]
    const first = SessionHistoryProjection.projectForModel(messages)
    const second = SessionHistoryProjection.projectForModel(messages)
    expect(JSON.stringify(first.messages)).toBe(JSON.stringify(second.messages))
    expect(first.truncated).toBe(second.truncated)
  })

  test("concurrent callers cannot settle each other's stats (per-call result)", () => {
    // Review round 2: the old global counter let session A's fold consume session B's
    // truncations. With per-call results the two invocations are fully independent.
    const a = SessionHistoryProjection.projectForModel([assistantWithTool("bash", longText(100_000)), ...pad()])
    const b = SessionHistoryProjection.projectForModel([assistantWithTool("bash", "tiny")])
    expect(a.truncated).toBe(1)
    expect(b.truncated).toBe(0)
  })

  test("a projected row stays byte-stable when newer turns arrive (cache prefix holds)", () => {
    const early = [assistantWithTool("bash", longText(100_000)), ...pad()]
    const earlyProjected = JSON.stringify(SessionHistoryProjection.projectForModel(early).messages)
    const later = [...early, assistantWithTool("bash", "newer")]
    const laterProjected = JSON.stringify(
      SessionHistoryProjection.projectForModel(later).messages.slice(0, early.length),
    )
    expect(laterProjected).toBe(earlyProjected)
  })

  test("unknown tool names and under-cap results pass through untouched", () => {
    const result = SessionHistoryProjection.projectForModel([
      assistantWithTool("mcp__custom__tool", longText(100_000)),
      ...pad(),
    ])
    expect(toolTextOf(result.messages[0]!).length).toBe(100_000)
    expect(result.truncated).toBe(0)
  })

  test("multibyte characters are never split (codepoint-safe excerpt)", () => {
    const result = SessionHistoryProjection.projectForModel([assistantWithTool("bash", "汉".repeat(60_000)), ...pad()])
    const projectedText = toolTextOf(result.messages[0]!)
    expect(projectedText.length).toBeLessThan(60_000)
    // No replacement chars from splitting surrogate pairs mid-unit.
    expect(projectedText).not.toContain("\uFFFD")
    expect(projectedText).toContain("汉")
  })
})

// G-C — the CLEAR window: the cheap, LLM-free half of compaction. Sized from the offline replay of
// the real abs traces, where the per-result caps never fired (largest read 26.5k chars < 40k cap)
// while 79-88% of the tool-result weight sat in results older than the last 5-12 calls. The
// contract that makes it safe: it may only ever REMOVE bytes the model already saw, the durable
// history keeps every byte, and the resent tail is never touched.
describe("session history projection — clear window (G-C)", () => {
  const withWindow = (size: number, run: () => void) => {
    const previous = process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_AFTER"]
    process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_AFTER"] = String(size)
    try {
      run()
    } finally {
      if (previous === undefined) delete process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_AFTER"]
      else process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_AFTER"] = previous
    }
  }

  test("elides results older than the window and keeps the newest verbatim", () => {
    // window 6 over 6 results: the last four are the resent tail, the two oldest are elided.
    withWindow(6, () => {
      const rows = Array.from({ length: 6 }, () => assistantWithTool("read", longText(400)))
      const result = SessionHistoryProjection.projectForModel(rows)
      const texts = result.messages.map((m) => toolTextOf(m))
      expect(texts.slice(2)).toEqual(rows.slice(2).map((m) => toolTextOf(m)))
      expect(texts[0]).toContain("elided")
      expect(texts[0]).toContain("read")
      expect(texts[1]).toContain("elided")
      expect(result.truncated).toBe(2)
      expect(result.savedChars).toBeGreaterThan(500)
    })
  })

  test("never clears an error result: it is the repair evidence", () => {
    withWindow(1, () => {
      const rows = [
        assistantWithTool("bash", longText(4_000), "error"),
        assistantWithTool("read", longText(4_000)),
        assistantWithTool("read", longText(4_000)),
      ]
      const texts = SessionHistoryProjection.projectForModel(rows).messages.map((m) => toolTextOf(m))
      expect(texts[0]).toHaveLength(4_000)
    })
  })

  test("leaves a result alone when the stub would not be smaller", () => {
    withWindow(1, () => {
      const tiny = "ok"
      const rows = [assistantWithTool("read", tiny), assistantWithTool("read", longText(500))]
      const texts = SessionHistoryProjection.projectForModel(rows).messages.map((m) => toolTextOf(m))
      expect(texts[0]).toBe(tiny)
    })
  })

  test("an elided row stays byte-stable as newer turns arrive (cache prefix holds)", () => {
    withWindow(2, () => {
      const early = [assistantWithTool("read", longText(400)), assistantWithTool("read", longText(400))]
      const first = JSON.stringify(SessionHistoryProjection.projectForModel([...early, ...pad(2)]).messages.slice(0, 2))
      const later = JSON.stringify(SessionHistoryProjection.projectForModel([...early, ...pad(4)]).messages.slice(0, 2))
      expect(later).toBe(first)
    })
  })
})
