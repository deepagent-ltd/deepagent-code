export * as SessionHistoryProjection from "./session-history-projection"

import { SessionMessage } from "../message"
import { ToolOutput } from "../../tool-output"
import { flipFlagValueOn } from "../../deepagent/flip-flag"

// G3 (gamma plan 阶段五) — durable→model-facing history projection.
//
// The durable session history keeps every tool result verbatim forever (audit truth). The
// provider request does NOT have to: this module projects a durable message list into the
// model-facing list with graded tool-output budgets, so a 100KB `bash` output from 30 turns
// ago stops being re-sent verbatim on every subsequent provider turn.
//
// CONTRACTS the projection must hold:
//   1. Determinism — same durable rows ⇒ same projected bytes. The projection is a PURE
//      function of message content (no clocks, no counters). This keeps the prompt-cache
//      prefix byte-stable: a row projected once stays byte-identical on every later turn,
//      because truncation depends only on the row's own content.
//   2. Errors keep a GENEROUS 4× budget — tool errors, permission failures and test failures are
//      the evidence the model needs to repair, so they are near-intact; only a pathological
//      crash log (way past 4× the class cap) is excerpted (review fix: the first version had NO
//      bound on errors at all).
//   3. The RESENT tail is never projected — the most recent K settled tool results (default
//      4) stay verbatim: the model is actively reasoning about them and the provider may not
//      have seen their content cross-turn otherwise (only completed results are durable).
//   4. Bounded — every non-exempt tool result obeys its class cap; oversized text keeps
//      head+tail excerpts with an explicit truncation marker (code errors usually live at
//      the tail of a long log, so tail-keeping is load-bearing, not cosmetic).
//
// Durable storage is untouched: the projection runs at request assembly time only
// (llm.ts), after entriesForRunner, before toLLMMessages.

const PROJECTION_ENABLED_DEFAULT = true
const RESENT_TAIL_RESULTS_DEFAULT = 4

// Per-tool-class char caps for projected (non-exempt, non-tail) tool results. Chars, not
// tokens, for determinism and zero-cost measurement; ~4 chars/token makes the bash cap
// ≈10K tokens — generous against compaction's 2_000-char serializer, because these results
// must remain actionable for repair, not just summarizable.
const TOOL_OUTPUT_CAPS_DEFAULT: Readonly<Record<string, number>> = {
  bash: 40_000,
  read: 40_000,
  glob: 20_000,
  grep: 20_000,
  ls: 20_000,
  edit: 20_000,
  write: 20_000,
  task: 20_000,
}

const flipFlagOn = flipFlagValueOn

export const projectionEnabled = () =>
  flipFlagOn(process.env["DEEPAGENT_CODE_HISTORY_PROJECTION"], PROJECTION_ENABLED_DEFAULT)

const parseNonNegativeInt = (raw: string | undefined, fallback: number) => {
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

export const resentTailResults = () =>
  parseNonNegativeInt(process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_TAIL"], RESENT_TAIL_RESULTS_DEFAULT)

const toolOutputCaps = (): Record<string, number> => {
  const raw = process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CAPS"]
  if (raw === undefined || raw.trim() === "") return { ...TOOL_OUTPUT_CAPS_DEFAULT }
  // Format: "bash=40000,read=40000" — merges over the defaults; `name=0` disables a cap
  // (0 ⇒ unbounded, mirroring the ablation flag grammar where 0 never means "drop").
  const caps: Record<string, number> = { ...TOOL_OUTPUT_CAPS_DEFAULT }
  for (const pair of raw.split(",")) {
    const [name, value] = pair.split("=")
    if (name === undefined || name.trim() === "" || value === undefined) continue
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 0) continue
    caps[name.trim()] = parsed
  }
  return caps
}

const toolResultTextOf = (result: unknown): string | null => {
  if (typeof result === "string") return result
  // ToolResultValue json shape {type:"json"|"text"|"error", value} — text projections only
  // truncate flat text; structured json keeps full fidelity (its size is tool-authored and
  // already bounded by the tool itself).
  if (result !== null && typeof result === "object" && "value" in result) {
    const value = (result as { type: string; value: unknown }).value
    if (typeof value === "string") return value
  }
  return null
}

const TRUNCATION_MARKER = "…[projected: head+tail excerpt, full output in durable history]"

// Deterministic head+tail excerpt, marker INCLUSIVE — the result never exceeds cap (review fix:
// the first version sliced cap chars and then appended the marker on top). Codepoint-safe (never
// splits a surrogate pair); the marker always survives.
const excerpt = (text: string, cap: number) => {
  const markerChars = [...TRUNCATION_MARKER].length
  const cps = Array.from(text)
  if (cps.length <= cap) return text
  const budget = Math.max(0, cap - markerChars - 2)
  const head = Math.floor(budget * 0.6)
  const tail = budget - head
  return `${cps.slice(0, head).join("")}\n${TRUNCATION_MARKER}\n${cps.slice(cps.length - tail).join("")}`
}

const projectedToolResult = (
  tool: SessionMessage.AssistantTool,
  cap: number,
): SessionMessage.AssistantTool => {
  if (tool.state.status !== "completed" && tool.state.status !== "error") return tool
  // Structured-only results (content []) lower to json — leave untouched. The error state's
  // textual content (if any) goes through the SAME excerpt path with its larger budget.
  if (tool.state.content.length === 0) return tool
  const nextContent = tool.state.content.map((item) => {
    if (item.type !== "text") return item
    const projected = excerpt(item.text, cap)
    if (projected === item.text) return item
    projectionStats.truncated += 1
    projectionStats.savedChars += item.text.length - projected.length
    // Rebuild through the schema constructor: the tagged-union class instance must stay a
    // real ToolTextContent (spread would downgrade it to a plain object and break downstream
    // Schema guards in to-llm-message).
    return ToolOutput.text({ type: "text", text: projected })
  })
  if (tool.state.status === "completed") {
    return SessionMessage.AssistantTool.make({
      ...tool,
      state: SessionMessage.ToolStateCompleted.make({ ...tool.state, content: nextContent }),
    })
  }
  return SessionMessage.AssistantTool.make({
    ...tool,
    state: SessionMessage.ToolStateError.make({ ...tool.state, content: nextContent }),
  })
}

// Process-local observation counters (G0 parity: read by turn-observability rollups).
export const projectionStats = {
  truncated: 0,
  savedChars: 0,
  reset() {
    this.truncated = 0
    this.savedChars = 0
  },
}

const settledToolParts = (message: SessionMessage.Message): SessionMessage.AssistantTool[] =>
  message.type === "assistant"
    ? message.content.filter(
        (part): part is SessionMessage.AssistantTool =>
          part.type === "tool" && (part.state.status === "completed" || part.state.status === "error"),
      )
    : []

/**
 * Project durable V2 session history into the model-facing history. Pure with respect to
 * message content; returns the input reference unchanged when projection is disabled, no
 * assistant message qualifies, or nothing exceeds a cap (the common cheap case — a full
 * content scan of already-small results).
 */
export const projectForModel = (messages: readonly SessionMessage.Message[]): readonly SessionMessage.Message[] => {
  if (!projectionEnabled()) return messages
  const caps = toolOutputCaps()
  const tail = resentTailResults()
  // Index (from the end) of settled tool results that stay verbatim. The RESENT window is
  // over tool results globally, not per-message, so `tail=4` protects the last 4 results
  // wherever they sit.
  const settled: Array<{ message: number; part: number }> = []
  for (let m = messages.length - 1; m >= 0 && settled.length < tail; m--) {
    const message = messages[m]
    if (message?.type !== "assistant") continue
    for (let p = message.content.length - 1; p >= 0 && settled.length < tail; p--) {
      const part = message.content[p]
      if (part?.type === "tool" && (part.state.status === "completed" || part.state.status === "error"))
        settled.push({ message: m, part: p })
    }
  }
  const resent = new Set(settled.map((spot) => `${spot.message}:${spot.part}`))
  return messages.map((message, m) => {
    if (message.type !== "assistant") return message
    let changed = false
    const content = message.content.map((part, p) => {
      if (part.type !== "tool") return part
      if (part.state.status !== "completed" && part.state.status !== "error") return part
      if (resent.has(`${m}:${p}`)) return part
      const cap = caps[part.name]
      if (cap === undefined || cap === 0) return part
      // Errors carry the repair evidence, so they get a GENEROUS 4× budget — but no longer
      // unbounded (review finding): a pathological crash log must not blow the context window.
      const projected = projectedToolResult(part, part.state.status === "error" ? cap * 4 : cap)
      if (projected !== part) changed = true
      return projected
    })
    if (!changed) return message
    return SessionMessage.Assistant.make({ ...message, content })
  })
}

// Re-exported for llm.ts assembly-time stats; zero overhead when nothing truncated.
export const projectionSummary = () => ({ truncated: projectionStats.truncated, savedChars: projectionStats.savedChars })
