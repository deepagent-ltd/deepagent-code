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
//   3. Budget-triggered clearing — below the clear budget the projection is append-only
//      (every row's bytes fixed from its first send); crossing it stubs everything outside
//      the keep window in ONE batched, latched event. A per-arrival stub retro-changed
//      bytes mid-prefix EVERY turn (measured on GLM as cached-token plateaus lagging the
//      prompt by 2-3 turns). Caps apply UNIFORMLY to every settled result: a
//      verbatim-then-excerpt rotation would tear the prefix the same way.
//   4. Bounded — every non-exempt tool result obeys its class cap; oversized text keeps
//      head+tail excerpts with an explicit truncation marker (code errors usually live at
//      the tail of a long log, so tail-keeping is load-bearing, not cosmetic).
//
// Durable storage is untouched: the projection runs at request assembly time only
// (llm.ts), after entriesForRunner, before toLLMMessages.

const PROJECTION_ENABLED_DEFAULT = true

// Per-tool-class char caps for projected tool results. Chars, not
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

/**
 * CLEAR window (G-C) — the keep window: at a clear event, the newest K settled tool results
 * survive verbatim and everything older is replaced by a stub. This is the cheap, LLM-free
 * half of compaction (Claude Code micro-compact / deepseek-harness tool-result-pruner): it
 * costs one pass and no summarizer call, and the durable history keeps every byte, so an
 * elided result is recoverable by re-reading.
 */
const CLEAR_OLDER_THAN_DEFAULT = 8
export const clearedAfterResults = () =>
  parseNonNegativeInt(process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_AFTER"], CLEAR_OLDER_THAN_DEFAULT)

/**
 * CLEAR budget (opencode-aligned) — the content-estimate threshold that triggers a clear
 * event. Below the budget the projection is pure append-only: every row's bytes are fixed
 * from its first send (caps are position-independent, no stubs), so the provider prefix
 * cache behaves like an unmodified agent's. Crossing the budget fires ONE batched clear —
 * every settled result older than the keep window is stubbed together, the estimate drops,
 * and the walk continues append-only until the next crossing. Tears therefore happen only at
 * compaction-like boundaries (rare, batched, latched) instead of on every arrival; the
 * per-turn age rotation this replaces was measured at ~50% short-gap cache loss on GLM.
 * `0` disables clearing entirely (append-only forever).
 */
const CLEAR_BUDGET_DEFAULT = 200_000
export const clearedBudgetTokens = () =>
  parseNonNegativeInt(process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_CLEAR_BUDGET"], CLEAR_BUDGET_DEFAULT)

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
 *
 * Protocol-aware default: the caller (runner/llm.ts) passes `reasoningKeep: 0` for the
 * OpenAI-family wire formats, where replaying past `reasoning_content` is optional (DeepSeek
 * only requires the FIELD on tool-call turns and an empty string satisfies it; GLM harnesses
 * never replay). Anthropic keeps the current turn's signed thinking for tool-call continuity,
 * so the module default stays 1 there.
 */
const REASONING_KEEP_DEFAULT = 1
// `fallback` is the protocol-aware default from the caller; an explicit env override still wins.
export const reasoningMessagesKept = (fallback: number = REASONING_KEEP_DEFAULT): number => {
  const raw = process.env["DEEPAGENT_CODE_HISTORY_PROJECTION_REASONING"]
  if (raw !== undefined && raw.trim().toLowerCase() === "all") return Number.MAX_SAFE_INTEGER
  return parseNonNegativeInt(raw, fallback)
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
export const projectForModel = (
  messages: readonly SessionMessage.Message[],
  options?: { readonly reasoningKeep?: number },
): ProjectionResult => {
  if (!projectionEnabled()) return { messages, truncated: 0, savedChars: 0 }
  const caps = toolOutputCaps()
  const clearAfter = clearedAfterResults()
  const budget = clearedBudgetTokens()
  const stats = { truncated: 0, savedChars: 0 }
  // All settled tool results, newest first, walked globally over tool results (not per-message).
  const settled: Array<{ message: number; part: number }> = []
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]
    if (message?.type !== "assistant") continue
    for (let p = message.content.length - 1; p >= 0; p--) {
      const part = message.content[p]
      if (part?.type === "tool" && (part.state.status === "completed" || part.state.status === "error"))
        settled.push({ message: m, part: p })
    }
  }
  // Budget-triggered clear with latching (see clearedBudgetTokens): a single oldest-first walk
  // accumulates the capped content estimate; each time it crosses `budget`, one clear event
  // stubs every walked settled result outside the keep window. The walk is a pure function of
  // the message list and the stub set only ever grows, so a row's projected bytes are fixed
  // from its first send until a batched clear event (if any) touches it once.
  const stubbed = new Set<string>()
  if (budget > 0 && clearAfter > 0) {
    const stubEstimate = 50
    const toolEstimate = new Map<string, number>()
    for (const spot of settled) {
      const message = messages[spot.message]
      if (message?.type !== "assistant") continue
      const part = message.content[spot.part] as SessionMessage.AssistantTool
      const state = part.state
      if (state.status !== "completed" && state.status !== "error") continue
      const chars = state.content.reduce(
        (total, item) => (item.type === "text" ? total + [...item.text].length : total),
        0,
      )
      const cap = caps[part.name]
      const bounded = cap === undefined || cap === 0 ? chars : Math.min(chars, state.status === "error" ? cap * 4 : cap)
      toolEstimate.set(`${spot.message}:${spot.part}`, Math.ceil(bounded / 4))
    }
    const oldestFirst = [...settled].reverse()
    let estimate = 0
    let walked = 0
    for (let m = 0; m < messages.length; m++) {
      const message = messages[m]!
      if (message.type === "assistant") {
        for (const part of message.content) {
          if (part.type === "text") estimate += Math.ceil([...part.text].length / 4)
        }
      }
      while (walked < oldestFirst.length && oldestFirst[walked]!.message === m) {
        estimate += toolEstimate.get(`${m}:${oldestFirst[walked]!.part}`)!
        walked++
      }
      if (estimate < budget) continue
      const keepFrom = Math.max(0, walked - clearAfter)
      for (let k = 0; k < keepFrom; k++) {
        const spot = oldestFirst[k]!
        const key = `${spot.message}:${spot.part}`
        if (stubbed.has(key)) continue
        const holder = messages[spot.message]
        if (holder?.type !== "assistant") continue
        const part = holder.content[spot.part] as SessionMessage.AssistantTool
        const est = toolEstimate.get(key)!
        // Mirror clearedToolResult's eligibility exactly: errors are repair evidence and a
        // stub that would not be smaller is a no-op — neither may enter the stub set, or the
        // walk's estimate would drift from what is actually sent.
        if (part.state.status !== "completed" || est * 4 <= 200) continue
        stubbed.add(key)
        estimate -= est - stubEstimate
      }
    }
  }
  // Which assistant messages keep their reasoning. Walk from the newest: the first `keep` messages
  // that CARRY reasoning are protected, everything older loses it.
  const keepReasoning = reasoningMessagesKept(options?.reasoningKeep)
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
      if (stubbed.has(key)) {
        const cleared = clearedToolResult(part, stats)
        if (cleared !== part) changed = true
        content.push(cleared)
        continue
      }
      if (cap === undefined || cap === 0) {
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
