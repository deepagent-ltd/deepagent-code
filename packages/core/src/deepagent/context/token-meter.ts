// V3.8 Appendix-A C5 — token metering that the Curator's budgeted assembly relies on. Two rules:
//  1. REAL usage preferred: when a provider reports actual token counts, use them; only estimate when
//     no real count is available. `preferReal` implements that precedence.
//  2. Better estimate: the repo-wide fallback is chars/4 (util/token.ts), which is badly wrong for
//     CJK and code (App-A C5: "对中文和代码严重偏差"). `estimate` splits the text into CJK vs
//     ASCII/other and applies a per-class chars-per-token ratio, so a budget computed over Chinese or
//     dense code is far closer to reality. This stays additive: util/token.ts is untouched; this is
//     the context-management-local upgrade the Curator uses. chars/4 remains the floor when a string
//     has no CJK (ASCII ~4 chars/token is already decent).
//
// Not a tokenizer — no model BPE here (none available in-repo). It is a calibrated heuristic whose
// only job is to keep the 50%-ceiling arithmetic honest enough that a real provider count rarely
// surprises us. When the real count arrives it always wins.

// CJK unified ideographs + common Han/Kana/Hangul ranges. Each such char is ~1 token (often <1 for
// common Han under BPE, but 1 is a safe, slightly-conservative upper estimate that avoids
// under-budgeting — the failure mode we care about is over-filling the window).
const CJK_RE =
  /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/u

const ASCII_CHARS_PER_TOKEN = 4

export const isCJK = (ch: string): boolean => CJK_RE.test(ch)

// Estimate tokens for a string. CJK runs are counted ~1 token/char; the rest at ~ASCII_CHARS_PER_TOKEN
// chars/token. Never negative; empty -> 0.
export const estimate = (input: string): number => {
  if (!input) return 0
  let cjk = 0
  let other = 0
  for (const ch of input) {
    if (CJK_RE.test(ch)) cjk++
    else other++
  }
  return Math.max(0, Math.round(cjk + other / ASCII_CHARS_PER_TOKEN))
}

// Real provider token usage for one message/turn, if the provider reported it. All fields optional
// so a partial report still yields a best real total.
export type RealUsage = {
  readonly input?: number
  readonly output?: number
  readonly reasoning?: number
  readonly total?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

// Collapse a RealUsage to a single token count: prefer an explicit `total`, else sum the parts.
// Returns undefined when nothing usable was reported (caller then estimates).
export const realTotal = (usage: RealUsage | undefined): number | undefined => {
  if (!usage) return undefined
  if (typeof usage.total === "number" && usage.total > 0) return usage.total
  const parts = [usage.input, usage.output, usage.reasoning, usage.cacheRead, usage.cacheWrite].filter(
    (v): v is number => typeof v === "number" && v >= 0,
  )
  if (parts.length === 0) return undefined
  const sum = parts.reduce((a, b) => a + b, 0)
  return sum > 0 ? sum : undefined
}

// The C5 precedence in one call: real provider count when available, otherwise the CJK/code-aware
// estimate over `text`. This is what the Curator uses to price an item.
export const preferReal = (real: RealUsage | undefined, text: string): number => {
  const r = realTotal(real)
  return r !== undefined ? r : estimate(text)
}
