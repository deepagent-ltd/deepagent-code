import { describe, expect, test } from "bun:test"
import type { ConfigV1 } from "@deepagent-code/core/v1/config/config"
import type { Provider } from "@/provider/provider"
import { Option, Schema } from "effect"
import {
  overflowStatus,
  requestBudget,
  softLandingDecision,
  isOverflow,
  decide,
  usable,
  outputContinuationMax,
  initialSoftLandingState,
  CompactionSoftLandingState,
  OUTPUT_CONTINUATION_MAX,
  REMINDER_FRACTION,
  AUTO_COMPACT_FALLBACK_BUFFER,
  REMINDER_DEBOUNCE_TURNS,
} from "@/session/overflow"

// A model whose `input` limit is the direct usable budget knob. reserved defaults to
// min(COMPACTION_BUFFER=20_000, maxOutputTokens); with output=10_000 → reserved=10_000, so
// usable() = input - 10_000. We choose input=110_000 → usable=100_000 for round numbers.
function model(opts?: { context?: number; input?: number; output?: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts?.context ?? 200_000,
      input: opts?.input ?? 110_000,
      output: opts?.output ?? 10_000,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const cfg = (over?: Partial<ConfigV1.Info["compaction"]>): ConfigV1.Info =>
  (over ? { compaction: over } : {}) as ConfigV1.Info

const tokensFor = (total: number) => ({
  total,
  input: total,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
})

describe("overflowStatus lines", () => {
  const m = model()
  const c = cfg()
  const hard = usable({ cfg: c, model: m }) // 100_000
  const soft = hard * REMINDER_FRACTION // 80_000
  const fallback = hard - AUTO_COMPACT_FALLBACK_BUFFER // 88_000

  test("computes the three monotonic lines", () => {
    const st = overflowStatus({ cfg: c, model: m, tokens: 0 })
    expect(st.hardLine).toBe(hard)
    expect(st.softLine).toBe(soft)
    expect(st.fallbackLine).toBe(fallback)
    expect(st.softLine).toBeLessThan(st.fallbackLine)
    expect(st.fallbackLine).toBeLessThan(st.hardLine)
  })

  test("phase across the four bands [0,soft)/[soft,fallback)/[fallback,hard)/[hard,∞)", () => {
    expect(overflowStatus({ cfg: c, model: m, tokens: soft - 1 }).phase).toBe("ok")
    expect(overflowStatus({ cfg: c, model: m, tokens: soft }).phase).toBe("reminder")
    expect(overflowStatus({ cfg: c, model: m, tokens: fallback - 1 }).phase).toBe("reminder")
    expect(overflowStatus({ cfg: c, model: m, tokens: fallback }).phase).toBe("fallback")
    expect(overflowStatus({ cfg: c, model: m, tokens: hard - 1 }).phase).toBe("fallback")
    expect(overflowStatus({ cfg: c, model: m, tokens: hard }).phase).toBe("hard")
    expect(overflowStatus({ cfg: c, model: m, tokens: hard + 50_000 }).phase).toBe("hard")
  })

  test("softLanding=false collapses to only ok/hard (V4.1 equivalence)", () => {
    const off = (tokens: number) => overflowStatus({ cfg: c, model: m, tokens, softLanding: false }).phase
    expect(off(soft)).toBe("ok")
    expect(off(fallback)).toBe("ok")
    expect(off(hard - 1)).toBe("ok")
    expect(off(hard)).toBe("hard")
    // The hard line is byte-identical to isOverflow regardless of the softLanding layers.
    expect(isOverflow({ cfg: c, model: m, tokens: tokensFor(hard - 1) })).toBe(false)
    expect(isOverflow({ cfg: c, model: m, tokens: tokensFor(hard) })).toBe(true)
  })

  test("compaction.reserved moves the hard trigger", () => {
    const reserved = cfg({ reserved: 40_000 })
    const hardWithReserved = usable({ cfg: reserved, model: m })
    expect(hardWithReserved).toBe(70_000)
    expect(isOverflow({ cfg: reserved, model: m, tokens: tokensFor(hardWithReserved - 1) })).toBe(false)
    expect(isOverflow({ cfg: reserved, model: m, tokens: tokensFor(hardWithReserved) })).toBe(true)
  })

  test("isOverflow == overflowStatus(...).phase === 'hard'", () => {
    for (const t of [0, soft, fallback, hard - 1, hard, hard + 1]) {
      const viaStatus = overflowStatus({ cfg: c, model: m, tokens: t }).phase === "hard"
      const viaWrapper = isOverflow({ cfg: c, model: m, tokens: tokensFor(t) })
      expect(viaWrapper).toBe(viaStatus)
    }
  })

  test("autocompact disabled ⇒ always ok (no soft-landing without compaction)", () => {
    const disabled = cfg({ auto: false })
    for (const t of [0, soft, fallback, hard, hard + 100_000]) {
      expect(overflowStatus({ cfg: disabled, model: m, tokens: t }).phase).toBe("ok")
    }
  })

  test("context===0 (unknown limit) returns unavailable, not ok", () => {
    // BUG-007 RC-3: context=0 is the fallback for an *unknown* limit — it must return a typed
    // "unavailable" phase with reason "context_limit_unknown", NOT the same "ok" as auto=false.
    const zero = model({ context: 0 })
    const st = overflowStatus({ cfg: c, model: zero, tokens: 1_000_000 })
    expect(st.phase).toBe("unavailable")
    expect(st.reason).toBe("context_limit_unknown")
    // isOverflow is still false (unavailable ≠ hard), but for the right reason.
    expect(isOverflow({ cfg: c, model: zero, tokens: tokensFor(1_000_000) })).toBe(false)
  })

  test("prefixTokens do NOT reduce phase: raw >= hardLine must always be 'hard'", () => {
    // BUG-007 RC-5: prefixTokens are for cache/cost diagnostics only; they must NOT lower the
    // phase decision. raw=hard means the complete provider-visible request has already hit the
    // hard line — a large static prefix does not make it safe to continue.
    const raw = hard // 100_000 = hardLine
    const noPrefix = overflowStatus({ cfg: c, model: m, tokens: raw, prefixTokens: 0 })
    const withPrefix = overflowStatus({ cfg: c, model: m, tokens: raw, prefixTokens: 15_000 })
    // Both cases: raw request has reached hardLine → must be "hard".
    expect(noPrefix.phase).toBe("hard")
    expect(withPrefix.phase).toBe("hard") // previously "reminder" — that was the bug
    // `used` (body-after-prefix) is preserved in the receipt for cache/cost analysis.
    expect(withPrefix.used).toBe(raw - 15_000) // 85_000 — diagnostic, not threshold input
    // The LINES are prefix-independent.
    expect(withPrefix.softLine).toBe(noPrefix.softLine)
    expect(withPrefix.fallbackLine).toBe(noPrefix.fallbackLine)
    expect(withPrefix.hardLine).toBe(noPrefix.hardLine)
  })

  test("prefixTokens never drives used negative", () => {
    const st = overflowStatus({ cfg: c, model: m, tokens: 100, prefixTokens: 5_000 })
    expect(st.used).toBe(0)
    expect(st.phase).toBe("ok")
  })
})

describe("requestBudget complete-request preflight (BUG-007)", () => {
  test("uses the smaller input/context physical budget and never deducts prefix", () => {
    const status = requestBudget({ model: model(), estimatedFullRequestTokens: 110_000 })
    expect(status.physicalInputBudget).toBe(110_000)
    expect(status.decision).toBe("unavailable")
    expect(status.provenance).toBe("model_limit")
  })

  test("allows a short unknown-limit request but fails closed past the host guard", () => {
    const previous = process.env["DEEPAGENT_CODE_UNKNOWN_CONTEXT_GUARD"]
    process.env["DEEPAGENT_CODE_UNKNOWN_CONTEXT_GUARD"] = "1000"
    try {
      const short = requestBudget({ model: model({ context: 0 }), estimatedFullRequestTokens: 999 })
      const long = requestBudget({ model: model({ context: 0 }), estimatedFullRequestTokens: 1000 })
      expect(short.decision).toBe("ok")
      expect(short.provenance).toBe("host_guard")
      expect(long.decision).toBe("unavailable")
      expect(long.reason).toBe("context_limit_unknown")
    } finally {
      if (previous === undefined) delete process.env["DEEPAGENT_CODE_UNKNOWN_CONTEXT_GUARD"]
      else process.env["DEEPAGENT_CODE_UNKNOWN_CONTEXT_GUARD"] = previous
    }
  })

  test("fails closed for an invalid negative context limit", () => {
    const status = requestBudget({ model: model({ context: -1 }), estimatedFullRequestTokens: 1 })
    expect(status.decision).toBe("unavailable")
    expect(status.reason).toBe("context_limit_invalid")
    expect(status.provenance).toBe("model_limit")
  })
})

describe("softLandingDecision state machine", () => {
  const m = model()
  const c = cfg()
  const hard = usable({ cfg: c, model: m })
  const soft = hard * REMINDER_FRACTION
  const fallback = hard - AUTO_COMPACT_FALLBACK_BUFFER
  const status = (tokens: number) => overflowStatus({ cfg: c, model: m, tokens })

  test("ok band ⇒ no action, state untouched", () => {
    const state = initialSoftLandingState
    const { action, nextState } = softLandingDecision({ status: status(soft - 1), state, step: 3 })
    expect(action).toBe("none")
    expect(nextState).toEqual(state)
  })

  test("unknown limit emits an explicit guard action", () => {
    const unknown = overflowStatus({ cfg: c, model: model({ context: 0 }), tokens: 1 })
    const state = initialSoftLandingState
    const decision = softLandingDecision({ status: unknown, state, step: 3 })
    expect(decision.action).toBe("guard")
    expect(decision.nextState).toEqual(state)
  })

  test("reminder injects once then debounces for N turns", () => {
    let state = initialSoftLandingState
    const first = softLandingDecision({ status: status(soft), state, step: 5 })
    expect(first.action).toBe("reminder")
    expect(first.nextState.reminderDeliveredAtTurn).toBe(5)
    state = first.nextState

    // Within debounce window ⇒ suppressed.
    const soon = softLandingDecision({ status: status(soft + 100), state, step: 5 + REMINDER_DEBOUNCE_TURNS - 1 })
    expect(soon.action).toBe("none")

    // After the debounce window ⇒ re-injects.
    const later = softLandingDecision({ status: status(soft + 100), state, step: 5 + REMINDER_DEBOUNCE_TURNS })
    expect(later.action).toBe("reminder")
    expect(later.nextState.reminderDeliveredAtTurn).toBe(5 + REMINDER_DEBOUNCE_TURNS)
  })

  test("fallback injects exactly once per epoch (idempotent)", () => {
    let state = initialSoftLandingState
    const first = softLandingDecision({ status: status(fallback), state, step: 10 })
    expect(first.action).toBe("fallback")
    expect(first.nextState.autoCompactFallbackDelivered).toBe(true)
    state = first.nextState

    // Re-entering the fallback band in the SAME epoch ⇒ no second injection.
    const again = softLandingDecision({ status: status(fallback + 500), state, step: 11 })
    expect(again.action).toBe("none")
    expect(again.nextState.autoCompactFallbackDelivered).toBe(true)

    const yetAgain = softLandingDecision({ status: status(fallback + 1_000), state, step: 12 })
    expect(yetAgain.action).toBe("none")
  })

  test("hard compaction bumps epoch and resets flags ⇒ next epoch can fallback again", () => {
    // Start in an epoch that already delivered a fallback.
    let state: CompactionSoftLandingState = {
      windowEpoch: 0,
      autoCompactFallbackDelivered: true,
      reminderDeliveredAtTurn: 4,
    }
    const hardDecision = softLandingDecision({ status: status(hard), state, step: 20 })
    expect(hardDecision.action).toBe("hard")
    expect(hardDecision.nextState.windowEpoch).toBe(1)
    expect(hardDecision.nextState.autoCompactFallbackDelivered).toBe(false)
    expect(hardDecision.nextState.reminderDeliveredAtTurn).toBeUndefined()
    state = hardDecision.nextState

    // New generation ⇒ fallback fires again.
    const nextFallback = softLandingDecision({ status: status(fallback), state, step: 21 })
    expect(nextFallback.action).toBe("fallback")
    expect(nextFallback.nextState.windowEpoch).toBe(1)
    expect(nextFallback.nextState.autoCompactFallbackDelivered).toBe(true)
  })
})

describe("CompactionSoftLandingState durability (cold recovery)", () => {
  // The state is stored on session metadata (Record<string, any>), which round-trips through JSON in
  // the DB. prompt.ts reads it back with Schema.decodeUnknownOption — this asserts the schema tolerates
  // the plain-object form that survives serialization, so a cold consumer rebuilds the exact generation.
  const decode = Schema.decodeUnknownOption(CompactionSoftLandingState)

  test("round-trips a fully-populated state through a JSON-like plain object", () => {
    const state: CompactionSoftLandingState = {
      windowEpoch: 3,
      autoCompactFallbackDelivered: true,
      reminderDeliveredAtTurn: 7,
    }
    const roundTripped = JSON.parse(JSON.stringify(state))
    const decoded = decode(roundTripped)
    expect(Option.isSome(decoded)).toBe(true)
    expect(Option.getOrThrow(decoded)).toEqual(state)
  })

  test("round-trips the initial state (optional field absent)", () => {
    const roundTripped = JSON.parse(JSON.stringify(initialSoftLandingState))
    const decoded = decode(roundTripped)
    expect(Option.isSome(decoded)).toBe(true)
    expect(Option.getOrThrow(decoded).windowEpoch).toBe(0)
    expect(Option.getOrThrow(decoded).autoCompactFallbackDelivered).toBe(false)
  })

  test("garbage / missing metadata decodes to None (caller falls back to initial)", () => {
    expect(Option.isNone(decode(undefined))).toBe(true)
    expect(Option.isNone(decode({ windowEpoch: "nope" }))).toBe(true)
    expect(Option.isNone(decode({}))).toBe(true) // autoCompactFallbackDelivered required
  })

  test("round-trips the new optional fields (prefillInputTokens + outputContinuationCount)", () => {
    const state = {
      windowEpoch: 2,
      autoCompactFallbackDelivered: true,
      prefillInputTokens: 45_000,
      outputContinuationCount: 1,
    }
    const decoded = decode(JSON.parse(JSON.stringify(state)))
    expect(Option.isSome(decoded)).toBe(true)
    const v = Option.getOrThrow(decoded)
    expect(v.prefillInputTokens).toBe(45_000)
    expect(v.outputContinuationCount).toBe(1)
  })
})

// BUG-007 RC-5: raw-token phase decisions.
// prefixTokens are diagnostics only; they never de-escalate a phase.  The old "BodyAfterPrefix"
// design (subtract prefix, then compare body against hardLine) was the root cause.
describe("overflowStatus: raw tokens drive all phase thresholds (BUG-007 RC-5)", () => {
  const m = model() // input=110_000, usable/hardLine=100_000
  const c = cfg()

  test("raw total at/over hardLine forces 'hard' even with a large prefix", () => {
    // A 90k prefix makes body tiny (used=20k), but raw=110k >= hardLine=100k ⇒ hard.
    const st = overflowStatus({ cfg: c, model: m, tokens: 110_000, prefixTokens: 90_000 })
    expect(st.used).toBe(20_000) // body-after-prefix preserved in receipt
    expect(st.phase).toBe("hard")
  })

  test("prefix=0 leaves raw==used, behaviour is unchanged", () => {
    // With no prefix, raw==used and the phase logic is unchanged.
    expect(overflowStatus({ cfg: c, model: m, tokens: 70_000, prefixTokens: 0 }).phase).toBe("ok")
    expect(overflowStatus({ cfg: c, model: m, tokens: 85_000, prefixTokens: 0 }).phase).toBe("reminder")
  })

  test("prefix does NOT de-escalate phase — raw 95k >= fallbackLine 88k → fallback", () => {
    // BUG-007 fix: old code deducted prefix first → body=85k → 'reminder'. Correct: raw 95k
    // already crosses fallbackLine 88k, so the phase must be 'fallback' regardless of prefix.
    const st = overflowStatus({ cfg: c, model: m, tokens: 95_000, prefixTokens: 10_000 })
    expect(st.used).toBe(85_000) // `used` kept for diagnostics (cache/cost)
    expect(st.phase).toBe("fallback") // was "reminder" — that was the bug
  })
})

// V4.0.1 P0b OUTPUT soft-landing — the continuation cap knob.
describe("outputContinuationMax", () => {
  test("defaults to OUTPUT_CONTINUATION_MAX when the env is unset/invalid", () => {
    const saved = process.env["DEEPAGENT_CODE_OUTPUT_CONTINUATION_MAX"]
    delete process.env["DEEPAGENT_CODE_OUTPUT_CONTINUATION_MAX"]
    expect(outputContinuationMax()).toBe(OUTPUT_CONTINUATION_MAX)
    process.env["DEEPAGENT_CODE_OUTPUT_CONTINUATION_MAX"] = "not-a-number"
    expect(outputContinuationMax()).toBe(OUTPUT_CONTINUATION_MAX)
    if (saved === undefined) delete process.env["DEEPAGENT_CODE_OUTPUT_CONTINUATION_MAX"]
    else process.env["DEEPAGENT_CODE_OUTPUT_CONTINUATION_MAX"] = saved
  })

  test("honors a valid non-negative integer override (including 0 = disabled)", () => {
    const saved = process.env["DEEPAGENT_CODE_OUTPUT_CONTINUATION_MAX"]
    process.env["DEEPAGENT_CODE_OUTPUT_CONTINUATION_MAX"] = "5"
    expect(outputContinuationMax()).toBe(5)
    process.env["DEEPAGENT_CODE_OUTPUT_CONTINUATION_MAX"] = "0"
    expect(outputContinuationMax()).toBe(0)
    if (saved === undefined) delete process.env["DEEPAGENT_CODE_OUTPUT_CONTINUATION_MAX"]
    else process.env["DEEPAGENT_CODE_OUTPUT_CONTINUATION_MAX"] = saved
  })
})
