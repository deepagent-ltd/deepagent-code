import type { Config } from "@/config/config"
import { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import { SessionV1 } from "@deepagent-code/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"
import { Schema } from "effect"

const COMPACTION_BUFFER = 20_000

// V4.0.1 P0 — three-layer SOFT-LANDING compaction thresholds.
//
// The single hard `usable()` line is split into three defensive lines so the model gets a warning
// (reminder) and then a one-shot "临终笔记" fallback to flush un-persisted state into the durable plan
// doc BEFORE a lossy LLM-summary compaction (hard).
//
//   softLine     = usable() × REMINDER_FRACTION       (nudge: write decisions/findings to the plan)
//   fallbackLine = usable() − AUTO_COMPACT_FALLBACK_BUFFER (last chance: flush now, keep all tools)
//   hardLine     = usable()                            (existing behavior: real LLM-summary compaction)
//
// Both are env-overridable so operators can retune per model window without a rebuild (see §2.5). The
// exported consts are the defaults; `reminderFraction()`/`fallbackBuffer()` read the env at call time.
export const REMINDER_FRACTION = 0.8
export const AUTO_COMPACT_FALLBACK_BUFFER = 12_000 // 硬线内侧预留，够模型写一轮落盘笔记

function reminderFraction(): number {
  const raw = Number(process.env["DEEPAGENT_CODE_REMINDER_FRACTION"])
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : REMINDER_FRACTION
}

function fallbackBuffer(): number {
  const raw = Number(process.env["DEEPAGENT_CODE_AUTO_COMPACT_FALLBACK_BUFFER"])
  return Number.isFinite(raw) && raw >= 0 ? raw : AUTO_COMPACT_FALLBACK_BUFFER
}

export type CompactionPhase = "ok" | "reminder" | "fallback" | "hard"

export interface OverflowStatus {
  readonly phase: CompactionPhase
  readonly used: number // body-after-prefix token 估算
  readonly softLine: number // usable × REMINDER_FRACTION
  readonly fallbackLine: number // hardLine - AUTO_COMPACT_FALLBACK_BUFFER
  readonly hardLine: number // 现有 usable()
}

// V4.0.1 P0 — the durable soft-landing state, carried on session metadata so it survives cold recovery.
// One "generation" of the three-layer defense lives per windowEpoch; a hard compaction bumps the epoch
// and resets the reminder/fallback flags so the next generation can warn + flush again.
export const CompactionSoftLandingState = Schema.Struct({
  windowEpoch: Schema.Int, // 每次硬压缩 +1，用于世代隔离
  reminderDeliveredAtTurn: Schema.optional(Schema.Int),
  autoCompactFallbackDelivered: Schema.Boolean, // 本 epoch 是否已注入 fallback
  // V4.0.1 P0 §2.3 BodyAfterPrefix — the per-window input-token BASELINE (Codex's `prefill_input_tokens`,
  // core/src/state/auto_compact_window.rs). Captured (latched) from the provider-reported input side of
  // the FIRST response after a window opens; `overflowStatus` subtracts it so the soft/fallback/hard lines
  // fire on BODY growth, not on the fixed static prefix. Cleared (undefined) when windowEpoch bumps — the
  // next generation re-latches. server-observed only: we take the real billed input, never a tokenizer.
  prefillInputTokens: Schema.optional(Schema.Int),
  // V4.0.1 P0b OUTPUT soft-landing — how many times we have auto-continued the CURRENT run of length-capped
  // responses. Reset to 0 on any non-"length" finish (a natural stop breaks the run). A hard cap on this
  // (OUTPUT_CONTINUATION_MAX) prevents an infinite continue loop — the knob Codex lacks (it only has the
  // transport-retry cap, the wrong lever for output truncation).
  outputContinuationCount: Schema.optional(Schema.Int),
}).annotate({ identifier: "CompactionSoftLandingState" })
export type CompactionSoftLandingState = Schema.Schema.Type<typeof CompactionSoftLandingState>

export const initialSoftLandingState: CompactionSoftLandingState = {
  windowEpoch: 0,
  autoCompactFallbackDelivered: false,
}

// V4.0.1 P0b — the hard ceiling on consecutive output-length auto-continuations, independent of the
// transport-retry cap. After this many "continue from where you were cut off" injections in a row without
// a natural stop, we give up and end the turn (avoids a model that keeps hitting the output cap forever).
// Env-overridable for tuning per model.
export const OUTPUT_CONTINUATION_MAX = 3

export function outputContinuationMax(): number {
  const raw = Number(process.env["DEEPAGENT_CODE_OUTPUT_CONTINUATION_MAX"])
  return Number.isInteger(raw) && raw >= 0 ? raw : OUTPUT_CONTINUATION_MAX
}

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

// Collapse an assistant token record to a single "used" count, matching the historical isOverflow math
// (prefer the provider-reported total, else sum the components).
export function tokensUsed(tokens: SessionV1.Assistant["tokens"]): number {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

// V4.0.1 P0 — three-value overflow layering. `softLanding` (default true) gates the reminder/fallback
// layers: with it false this collapses to the pre-V4.0.1 single-threshold ok/hard behavior (逐字节
// equivalent), so callers can wire it straight to the softLandingCompaction flag.
//
// BodyAfterPrefix (§2.3): `prefixTokens` is subtracted from the raw count so a large byte-stable static
// prefix (system prompt + skills + tool defs) does not eat the soft-landing budget. Per the §9.1 risk
// note, callers that cannot cheaply obtain an accurate prefix estimate pass 0 (equivalent to whole-body
// accounting) — the deduction is wired but a no-op until a real estimate is available.
export function overflowStatus(input: {
  cfg: ConfigV1.Info
  model: Provider.Model
  outputTokenMax?: number
  tokens: number
  prefixTokens?: number
  softLanding?: boolean
}): OverflowStatus {
  const hardLine = usable(input)
  const softLandingEnabled = input.softLanding ?? true
  const prefix = Math.max(0, input.prefixTokens ?? 0)
  // Body-after-prefix (§2.3, Codex core/src/session/context_window.rs): subtract the per-window prefix
  // BASELINE so the soft/fallback/hard lines fire on BODY growth, not on the fixed static prefix. Never
  // let the baseline drive `used` negative.
  const used = Math.max(0, input.tokens - prefix)

  // Reminder line first, then clamp the fallback line into [softLine, hardLine] so the three lines stay
  // monotonic even on small windows where hardLine - buffer would otherwise fall below the soft line.
  const softLine = hardLine * reminderFraction()
  const fallbackLine = Math.min(hardLine, Math.max(softLine, hardLine - fallbackBuffer()))

  // No compaction ⇒ no soft-landing (autocompact disabled, or the model reports no context window).
  if (input.cfg.compaction?.auto === false || input.model.limit.context === 0) {
    return { phase: "ok", used, softLine, fallbackLine, hardLine }
  }

  // Full-window SAFETY CAP (Codex's second, independent check — core/src/session/context_window.rs: body
  // >= 0.9*window OR total >= full window). body-after-prefix is the PRIMARY trigger, but a huge prefix
  // must never let the RAW un-deducted total silently blow past the real input window. So a hard
  // compaction ALSO fires when the raw total reaches the model's actual input limit (the true window,
  // ABOVE the reserved-output `hardLine`), whichever crosses first. When we have no input limit, fall
  // back to context. Only meaningful once a prefix is deducted (prefix>0); with prefix=0, used==raw so
  // this is redundant and byte-for-byte the pre-BodyAfterPrefix behavior.
  const fullWindow = input.model.limit.input || input.model.limit.context
  const rawOverFullWindow = prefix > 0 && input.tokens >= fullWindow

  const phase: CompactionPhase =
    used >= hardLine || rawOverFullWindow
      ? "hard"
      : !softLandingEnabled
        ? "ok"
        : used >= fallbackLine
          ? "fallback"
          : used >= softLine
            ? "reminder"
            : "ok"

  return { phase, used, softLine, fallbackLine, hardLine }
}

// How many turns must pass before the soft REMINDER is re-injected while the used tokens linger in the
// [soft, fallback) band — a debounce so a long stretch near the soft line does not spam the tail.
export const REMINDER_DEBOUNCE_TURNS = 5

export type SoftLandingAction = "none" | "reminder" | "fallback" | "hard"

// V4.0.1 P0 — the PURE soft-landing state machine. Given the current overflow `status`, the persisted
// `state`, and the current turn `step`, decide what side effect the turn loop should run and the next
// durable state. Keeping this pure (no Effect, no IO) makes the four-band + generation-reset + fallback
// idempotency directly unit-testable; prompt.ts only executes the returned action.
export function softLandingDecision(input: {
  status: OverflowStatus
  state: CompactionSoftLandingState
  step: number
  debounceTurns?: number
}): { action: SoftLandingAction; nextState: CompactionSoftLandingState } {
  const { status, state, step } = input
  const debounce = input.debounceTurns ?? REMINDER_DEBOUNCE_TURNS

  switch (status.phase) {
    case "hard":
      // Real LLM-summary compaction happens. Bump the generation and clear the soft-landing flags so the
      // NEXT window can warn + flush again from scratch. Note the fresh object also DROPS
      // prefillInputTokens (§2.3 clear_prefill: the new window re-latches its own baseline from the first
      // post-compaction response) and outputContinuationCount (a fresh window resets the output run).
      return {
        action: "hard",
        nextState: { windowEpoch: state.windowEpoch + 1, autoCompactFallbackDelivered: false },
      }
    case "fallback":
      // One forced "临终笔记" per generation. Already delivered ⇒ no-op (idempotent within the epoch).
      if (state.autoCompactFallbackDelivered) return { action: "none", nextState: state }
      return {
        action: "fallback",
        nextState: { ...state, autoCompactFallbackDelivered: true, reminderDeliveredAtTurn: step },
      }
    case "reminder": {
      const last = state.reminderDeliveredAtTurn
      if (last !== undefined && step - last < debounce) return { action: "none", nextState: state }
      return { action: "reminder", nextState: { ...state, reminderDeliveredAtTurn: step } }
    }
    default:
      return { action: "none", nextState: state }
  }
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  // Thin backward-compatible wrapper: overflow == the hard line is crossed. The softLanding layers never
  // change where the hard line sits, so every existing caller keeps its exact semantics.
  return (
    overflowStatus({
      cfg: input.cfg,
      model: input.model,
      outputTokenMax: input.outputTokenMax,
      tokens: tokensUsed(input.tokens),
    }).phase === "hard"
  )
}
