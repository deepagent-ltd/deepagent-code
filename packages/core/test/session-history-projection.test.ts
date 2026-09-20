import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionHistoryProjection } from "../src/session/runner/session-history-projection"
import { SessionMessage } from "../src/session/message"
import { ToolOutput } from "@deepagent-code/core/tool-output"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"

// G3 history projection — the contracts that make it cache-safe:
//   determinism (same rows ⇒ same bytes), error preservation, uniform caps with no
//   position-dependent verbatim rotation, and the env kill-switch.
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

// The default resent-tail window is 4 settled results. Caps apply UNIFORMLY to every settled
// result, so the padding below no longer gates truncation — it is kept for parity with the
// clear-window suite, where it does control which results the CLEAR pass may elide.
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

  test("caps apply uniformly — the newest result is also excerpted", () => {
    const recent = assistantWithTool("bash", longText(100_000))
    const result = SessionHistoryProjection.projectForModel([recent])
    expect(toolTextOf(result.messages[0]!).length).toBeLessThan(100_000)
    expect(result.truncated).toBe(1)
  })

  test("a result projected in the tail stays byte-identical after it ages out (no rotation tear)", () => {
    // The cache contract the old verbatim tail broke: a result was verbatim while recent and
    // excerpted once it aged past the window, retro-changing bytes mid-prefix.
    const big = assistantWithTool("bash", longText(100_000))
    const asNewest = JSON.stringify(SessionHistoryProjection.projectForModel([big]).messages[0])
    const asAged = JSON.stringify(
      SessionHistoryProjection.projectForModel([big, ...pad(4)]).messages[0],
    )
    expect(asAged).toBe(asNewest)
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
// history keeps every byte, and stubs fire in cohort bursts (see the quantization suite below).
// Reasoning replay. The durable history keeps the model's reasoning blocks (audit truth), but
// re-sending them on every later turn was measured at 41% of a 167k-token request on the abs C2 run
// (68,079 tokens of `other`, which is the reasoning text). The reference agents do not replay them
// (Claude Code strips thinking blocks from the request; Codex tracks encrypted content only). The
// current turn's chain is the one thing the model cannot re-derive, so it alone is kept.
describe("session history projection — reasoning replay", () => {
  const withReasoning = (keep: string | undefined, run: () => void) => {
    const previous = process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_REASONING"]
    if (keep === undefined) delete process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_REASONING"]
    else process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_REASONING"] = keep
    try {
      run()
    } finally {
      if (previous === undefined) delete process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_REASONING"]
      else process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_REASONING"] = previous
    }
  }

  const withReasoningText = (text: string, index: number): SessionMessage.Message =>
    SessionMessage.Assistant.make({
      type: "assistant",
      id: `msg_reasoning_${index}` as SessionMessage.ID,
      agent: "build",
      model,
      finish: "tool-calls",
      time: { created: DateTime.makeUnsafe(1) },
      content: [
        SessionMessage.AssistantReasoning.make({
          type: "reasoning",
          id: `rsn_${index}`,
          text,
        }),
        SessionMessage.AssistantText.make({
          type: "text",
          id: `txt_${index}`,
          text: `note ${index}`,
        }),
      ],
    })

  const reasoningCount = (messages: readonly SessionMessage.Message[]) =>
    messages
      .filter((m) => m.type === "assistant")
      .reduce((n, m) => n + (m as SessionMessage.Assistant).content.filter((p) => p.type === "reasoning").length, 0)

  test("older turns lose their reasoning, the newest keeps it", () => {
    withReasoning(undefined, () => {
      const rows = [
        withReasoningText("R".repeat(2000), 1),
        withReasoningText("R".repeat(2000), 2),
        withReasoningText("R".repeat(2000), 3),
      ]
      const result = SessionHistoryProjection.projectForModel(rows)
      expect(reasoningCount(result.messages)).toBe(1)
      expect(result.truncated).toBe(2)
      expect(result.savedChars).toBe(4000)
    })
  })

  test("the durable input is untouched (audit keeps every byte)", () => {
    withReasoning(undefined, () => {
      const rows = [withReasoningText("R".repeat(2000), 1), withReasoningText("R".repeat(2000), 2)]
      SessionHistoryProjection.projectForModel(rows)
      expect(reasoningCount(rows)).toBe(2)
    })
  })

  test("=all restores full replay for A/B measurement", () => {
    withReasoning("all", () => {
      const rows = [withReasoningText("R".repeat(2000), 1), withReasoningText("R".repeat(2000), 2)]
      const result = SessionHistoryProjection.projectForModel(rows)
      expect(reasoningCount(result.messages)).toBe(2)
      expect(result.savedChars).toBe(0)
    })
  })

  test("caller can lower the default (openai-family keep=0) without touching env", () => {
    withReasoning(undefined, () => {
      const rows = [withReasoningText("R".repeat(2000), 1), withReasoningText("R".repeat(2000), 2)]
      const result = SessionHistoryProjection.projectForModel(rows, { reasoningKeep: 0 })
      expect(reasoningCount(result.messages)).toBe(0)
      expect(result.truncated).toBe(2)
    })
  })

  test("an explicit env override still wins over the caller default", () => {
    withReasoning("all", () => {
      const rows = [withReasoningText("R".repeat(2000), 1)]
      const result = SessionHistoryProjection.projectForModel(rows, { reasoningKeep: 0 })
      expect(reasoningCount(result.messages)).toBe(1)
    })
  })
})

describe("session history projection — budget-triggered clear (G-C)", () => {
  // The opencode-aligned model: below the budget the projection is append-only; crossing it
  // stubs everything outside the keep window in ONE batched, latched event.
  const withClear = (budget: number, keep: number, run: () => void) => {
    const prevBudget = process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_BUDGET"]
    const prevAfter = process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_AFTER"]
    process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_BUDGET"] = String(budget)
    process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_AFTER"] = String(keep)
    try {
      run()
    } finally {
      if (prevBudget === undefined) delete process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_BUDGET"]
      else process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_BUDGET"] = prevBudget
      if (prevAfter === undefined) delete process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_AFTER"]
      else process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_AFTER"] = prevAfter
    }
  }
  const elidedCount = (messages: readonly SessionMessage.Message[]) =>
    messages.filter((m) => toolTextOf(m).includes("elided")).length

  test("below budget: append-only — nothing stubs and bytes stay identical as history grows", () => {
    withClear(10_000, 8, () => {
      const rows = Array.from({ length: 12 }, () => assistantWithTool("read", longText(400)))
      const first = SessionHistoryProjection.projectForModel(rows)
      expect(elidedCount(first.messages)).toBe(0)
      const grown = SessionHistoryProjection.projectForModel([
        ...rows,
        assistantWithTool("read", longText(400)),
      ])
      expect(elidedCount(grown.messages)).toBe(0)
      expect(JSON.stringify(grown.messages.slice(0, 12))).toBe(JSON.stringify(first.messages))
    })
  })

  test("crossing the budget stubs everything outside the keep window in one batch", () => {
    withClear(1_000, 4, () => {
      // 10 results x (400 chars / 4) = 1000 est tokens: the 10th message crosses exactly;
      // keep the newest 4, stub the 6 oldest.
      const rows = Array.from({ length: 10 }, () => assistantWithTool("read", longText(400)))
      const result = SessionHistoryProjection.projectForModel(rows)
      expect(elidedCount(result.messages)).toBe(6)
      const texts = result.messages.map((m) => toolTextOf(m))
      expect(texts.slice(6)).toEqual(rows.slice(6).map((m) => toolTextOf(m)))
      expect(result.truncated).toBe(6)
    })
  })

  test("latched: stubs persist and nothing new stubs until the estimate re-crosses", () => {
    withClear(1_000, 4, () => {
      const rows = Array.from({ length: 10 }, () => assistantWithTool("read", longText(400)))
      const first = SessionHistoryProjection.projectForModel(rows)
      expect(elidedCount(first.messages)).toBe(6)
      // The batch dropped the estimate to ~700; two more results (200 est) stay under budget.
      const grown = SessionHistoryProjection.projectForModel([
        ...rows,
        ...Array.from({ length: 2 }, () => assistantWithTool("read", longText(400))),
      ])
      expect(elidedCount(grown.messages)).toBe(6)
      expect(JSON.stringify(grown.messages.slice(0, 10))).toBe(JSON.stringify(first.messages))
    })
  })

  test("budget 0 disables clearing entirely (append-only forever)", () => {
    withClear(0, 8, () => {
      const rows = Array.from({ length: 20 }, () => assistantWithTool("read", longText(400)))
      expect(elidedCount(SessionHistoryProjection.projectForModel(rows).messages)).toBe(0)
    })
  })

  test("never clears an error result: it is the repair evidence", () => {
    withClear(200, 1, () => {
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
    withClear(1, 1, () => {
      const tiny = "ok"
      const rows = [assistantWithTool("read", tiny), assistantWithTool("read", longText(500))]
      const texts = SessionHistoryProjection.projectForModel(rows).messages.map((m) => toolTextOf(m))
      expect(texts[0]).toBe(tiny)
    })
  })
})
