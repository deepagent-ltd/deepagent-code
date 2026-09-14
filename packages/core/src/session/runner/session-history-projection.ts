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

/**
 * CLEAR window (G-C) — how many of the most recent settled tool results survive the elision pass at
 * all; everything older is replaced by a stub (subject to the RESENT tail, which always stays
 * verbatim and therefore sets the effective floor). This is the cheap, LLM-free half of compaction (Claude Code
 * micro-compact / deepseek-harness tool-result-pruner): it costs one pass and no summarizer call,
 * and the durable history keeps every byte, so an elided result is recoverable by re-reading.
 *
 * Sized from the offline replay of the real abs traces (deep-agent-ab/replay): on this workload the
 * shipped per-result caps NEVER fire (largest single result 26.5k chars vs a 40k cap — the reason
 * `projection_truncated` sat at 0 for whole runs), while clearing everything older than the last
 * 5–12 results removes 79–88% of the tool-result weight that is otherwise re-sent every turn.
 * `0` disables the clear (the previous behaviour).
 */
const CLEAR_OLDER_THAN_DEFAULT = 8
export const clearedAfterResults = () =>
  parseNonNegativeInt(process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_AFTER"], CLEAR_OLDER_THAN_DEFAULT)

/**
 * REASONING replay (measured, round-10). The durable history keeps the model's reasoning blocks
 * verbatim, and that is CORRECT for audit: they are part of what the model produced. Re-sending them
 * on every later turn is not. Measured on the abs C2 run: `history_other` (which is the reasoning
 * text — the transcript carries no reasoning events, and a shape-for-shape reproduction puts
 * `other:assistant_text` at 22.5:1 against the run's 42.7:1) reached **68,079 tokens of a
 * 166,985-token request — 41%**, i.e. ~45% of the billed input was the model re-reading its own
 * earlier thoughts.
 *
 * The reference agents do not replay them: Claude Code strips `thinking`/`redacted_thinking` blocks
 * from the request (`stripSignatureBlocks`, messages.ts:5522) and Codex tracks only encrypted
 * reasoning content. The only reasoning the model cannot re-derive is the CURRENT turn's — it is the
 * chain that produced the tool calls the next request continues — so exactly one assistant message
 * keeps its reasoning and every older one loses it.
 *
 * `DEEPAGENT_CODE_HISTORY_PROJECTION_REASONING=all` restores full replay for A/B measurement.
 */
const REASONING_KEEP_DEFAULT = 1
export const reasoningMessagesKept = (): number => {
  const raw = process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_REASONING"]
  if (raw !== undefined && raw.trim().toLowerCase() === "all") return Number.MAX_SAFE_INTEGER
  return parseNonNegativeInt(raw, REASONING_KEEP_DEFAULT)
}

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
  stats: { truncated: number; savedChars: number },
): SessionMessage.AssistantTool => {
  if (tool.state.status !== "completed" && tool.state.status !== "error") return tool
  // Structured-only results (content []) lower to json — leave untouched. The error state's
  // textual content (if any) goes through the SAME excerpt path with its larger budget.
  if (tool.state.content.length === 0) return tool
  const nextContent = tool.state.content.map((item) => {
    if (item.type !== "text") return item
    const projected = excerpt(item.text, cap)
    if (projected === item.text) return item
    stats.truncated += 1
    stats.savedChars += item.text.length - projected.length
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

/**
 * Replace an aged-out tool result with a stub. Errors are NEVER cleared: they are the repair
 * evidence the next turn may depend on, and they are already bounded by their 4× budget. A result
 * is only replaced when the stub is strictly smaller — a small result costs nothing to keep, and
 * keeping it leaves the cached prefix untouched.
 */
const clearedToolResult = (
  tool: SessionMessage.AssistantTool,
  stats: { truncated: number; savedChars: number },
): SessionMessage.AssistantTool => {
  if (tool.state.status !== "completed") return tool
  if (tool.state.content.length === 0) return tool
  const original = tool.state.content.reduce(
    (total, item) => (item.type === "text" ? total + item.text.length : total),
    0,
  )
  const stub =
    `[earlier ${tool.name} result elided to keep the context small — ${original} chars; ` +
    `re-read the target if you need it again]`
  if (stub.length >= original) return tool
  stats.truncated += 1
  stats.savedChars += original - stub.length
  return SessionMessage.AssistantTool.make({
    ...tool,
    state: SessionMessage.ToolStateCompleted.make({
      ...tool.state,
      content: [ToolOutput.text({ type: "text", text: stub })],
    }),
  })
}

export type ProjectionResult = {
  /** The projected (or unchanged) message list. */
  readonly messages: readonly SessionMessage.Message[]
  /** THIS call's own stats — no module-level mutable state (review fix: a global counter let
   * concurrent sessions settle each other's truncation counts). */
  readonly truncated: number
  readonly savedChars: number
}

/**
 * Project durable V2 session history into the model-facing history. Pure with respect to
 * message content; returns the input reference unchanged when projection is disabled, no
 * assistant message qualifies, or nothing exceeds a cap (the common cheap case — a full
 * content scan of already-small results). The caller owns the returned stats — nothing
 * accumulates across calls or leaks across sessions.
 */
export const projectForModel = (messages: readonly SessionMessage.Message[]): ProjectionResult => {
  if (!projectionEnabled()) return { messages, truncated: 0, savedChars: 0 }
  const caps = toolOutputCaps()
  const tail = resentTailResults()
  const clearAfter = clearedAfterResults()
  const stats = { truncated: 0, savedChars: 0 }
  // Index (from the end) of settled tool results that stay verbatim. The RESENT window is
  // over tool results globally, not per-message, so `tail=4` protects the last 4 results
  // wherever they sit. The CLEAR window is the same walk continued outward: everything past it is
  // elided to a stub (the tool name plus what was there), which is what actually stops a 133-turn
  // run from re-sending every early read on every later turn.
  // The RESENT tail and the CLEAR window are independent budgets: the tail is the minimum number of
  // recent results that stay verbatim, the window is how many recent results survive the elision
  // pass at all. `clearAfter < tail` would make the window a no-op (the tail protects more than the
  // window keeps), so the effective horizon is the larger of the two.
  const horizon = Math.max(tail, clearAfter)
  const settled: Array<{ message: number; part: number }> = []
  for (let m = messages.length - 1; m >= 0 && settled.length < horizon; m--) {
    const message = messages[m]
    if (message?.type !== "assistant") continue
    for (let p = message.content.length - 1; p >= 0 && settled.length < horizon; p--) {
      const part = message.content[p]
      if (part?.type === "tool" && (part.state.status === "completed" || part.state.status === "error"))
        settled.push({ message: m, part: p })
    }
  }
  const resent = new Set(settled.slice(0, tail).map((spot) => `${spot.message}:${spot.part}`))
  // Everything past the tail but inside the window: elided unless the stub would not be smaller.
  const clearable = new Set(clearAfter === 0 ? [] : settled.slice(tail).map((spot) => `${spot.message}:${spot.part}`))
  // Which assistant messages keep their reasoning. Walk from the newest: the first `keep` messages
  // that CARRY reasoning are protected, everything older loses it.
  const keepReasoning = reasoningMessagesKept()
  const reasoningKept = new Set<number>()
  for (let m = messages.length - 1; m >= 0 && reasoningKept.size < keepReasoning; m--) {
    const message = messages[m]
    if (message?.type !== "assistant") continue
    if (message.content.some((part) => part.type === "reasoning")) reasoningKept.add(m)
  }
  const projected = messages.map((message, m) => {
    if (message.type !== "assistant") return message
    let changed = false
    const content: Array<SessionMessage.AssistantContent> = []
    for (const [p, part] of message.content.entries()) {
      // Drop replayed reasoning from older turns. The model cannot re-derive the CURRENT turn's
      // chain (it produced the tool calls this request continues), so that one is kept; an earlier
      // chain is a repetition of thinking the model already acted on, and it was 41% of the request
      // in the measured run. Dropping a part is not truncation: nothing is paraphrased, and the
      // durable history keeps every byte for audit.
      if (part.type === "reasoning") {
        if (reasoningKept.has(m)) content.push(part)
        else {
          stats.truncated += 1
          stats.savedChars += part.text.length
          changed = true
        }
        continue
      }
      if (part.type !== "tool") {
        content.push(part)
        continue
      }
      if (part.state.status !== "completed" && part.state.status !== "error") {
        content.push(part)
        continue
      }
      const key = `${m}:${p}`
      const cap = caps[part.name]
      if (clearable.has(key)) {
        const cleared = clearedToolResult(part, stats)
        if (cleared !== part) changed = true
        content.push(cleared)
        continue
      }
      if (resent.has(key) || cap === undefined || cap === 0) {
        content.push(part)
        continue
      }
      // Errors carry the repair evidence, so they get a GENEROUS 4× budget — but no longer
      // unbounded (review finding): a pathological crash log must not blow the context window.
      const projectedPart = projectedToolResult(part, part.state.status === "error" ? cap * 4 : cap, stats)
      if (projectedPart !== part) changed = true
      content.push(projectedPart)
    }
    if (!changed) return message
    return SessionMessage.Assistant.make({ ...message, content })
  })
  return { messages: projected, truncated: stats.truncated, savedChars: stats.savedChars }
}
