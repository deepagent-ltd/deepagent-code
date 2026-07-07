import type { Ledger, LedgerEntry } from "./ledger"
import { taskAnchor, currentNext, recallCandidates } from "./ledger"
import type { ContextConfig } from "./config"
import { workingSetBudgetTokens } from "./config"
import { estimate } from "./token-meter"
import { knowledgeSimilarity } from "../document-store"

// V3.8 Appendix-A C1 — the Working Set Curator (public axiom 1: "不换对话 → 持续专注"). Each turn the
// Curator BUILDS a budgeted working set instead of "take all history → compact when it overflows".
// Composition, filled by fixed priority until the budget is spent:
//   1. task anchor (NEVER dropped): active Goal + active Constraint (from the Ledger).
//   2. near-field: the most recent N verbatim turns (short-term memory / coherence).
//   3. active references: latest version of files/tool-results the current task touches.
//   4. relevance recall: a few Ledger entries relevant to the current step (via GraphQuery-scored
//      keyword/token similarity — NO embeddings).
//   5. budget guardrail: the whole set is <= workingSetBudgetTokens(context) — a HARD 50% ceiling.
//
// Reasoning is EXCLUDED by default (C1): it is drafted + logged but not carried to the next turn.
// This module is a PURE assembler: it takes already-scored recall hits + the ledger + near-field
// items and produces a budgeted plan. It does NOT do IO — the caller (a thin Effect service) supplies
// the ledger, the recent turns, and the recall hits (obtained via GraphQuery). That keeps the 50%
// arithmetic unit-testable with no store/provider wiring.

export type WorkingSetItemKind = "anchor" | "near_field" | "reference" | "recall"

// A candidate for admission to the working set. `tokens` may be supplied (real provider count, C5);
// otherwise it is estimated from `text` with the CJK/code-aware estimator.
export type WorkingSetCandidate = {
  readonly id: string
  readonly kind: WorkingSetItemKind
  readonly text: string
  // If the caller has a real/measured token count, pass it — the Curator prefers it over estimate().
  readonly tokens?: number
  // For recall ordering: higher first. Ignored for anchor/near_field (their own order is preserved).
  readonly score?: number
  // Marks reasoning-origin content so the exclude-reasoning guard can drop it (C1). Never true for
  // anchor items.
  readonly isReasoning?: boolean
}

export type WorkingSetItem = WorkingSetCandidate & { readonly tokens: number }

export type WorkingSet = {
  readonly items: readonly WorkingSetItem[]
  readonly tokens: number
  readonly budget: number
  // Candidates that did NOT fit under the ceiling — the caller routes large/over-budget inputs here
  // to the C1.5 chunked-ingest path instead of growing the working set (C1.5: never widen the set).
  readonly overflow: readonly WorkingSetItem[]
}

const priceOf = (c: WorkingSetCandidate): number =>
  typeof c.tokens === "number" && c.tokens >= 0 ? c.tokens : estimate(c.text)

// Assemble a budgeted working set from prioritized candidates under a HARD token ceiling.
//
// Enforcement (the 50% hard ceiling): `budget` is computed by workingSetBudgetTokens (fraction is
// pre-clamped to <= MAX_BUDGET_FRACTION in config). Items are admitted in priority order and the
// running total is asserted to NEVER exceed `budget`. The anchor is admitted first and is expected to
// be tiny; if even the anchor exceeds budget we still stop at the ceiling (return only what fits) so
// the invariant `result.tokens <= budget` ALWAYS holds — we never emit an over-budget set.
export const assemble = (input: {
  contextTokens: number
  config: ContextConfig
  // Priority-ordered groups. anchor first, then near-field (most-recent last is fine — caller orders),
  // then references, then recall (already sorted best-first by the caller / GraphQuery score).
  anchor: readonly WorkingSetCandidate[]
  nearField: readonly WorkingSetCandidate[]
  references: readonly WorkingSetCandidate[]
  recall: readonly WorkingSetCandidate[]
}): WorkingSet => {
  const budget = workingSetBudgetTokens(input.contextTokens, input.config)
  const admitted: WorkingSetItem[] = []
  const overflow: WorkingSetItem[] = []
  let total = 0

  const consider = (c: WorkingSetCandidate) => {
    // Reasoning is excluded from the working set by default (C1). Route it nowhere (it lives in the
    // Conversation Log, not here).
    if (input.config.excludeReasoning && c.isReasoning) return
    const tokens = priceOf(c)
    const item: WorkingSetItem = { ...c, tokens }
    // HARD CEILING: admit only if it keeps the running total within budget.
    if (total + tokens <= budget) {
      admitted.push(item)
      total += tokens
    } else {
      overflow.push(item)
    }
  }

  // Fixed priority order. Anchor first so the task never drops.
  for (const c of input.anchor) consider({ ...c, kind: "anchor", isReasoning: false })
  for (const c of input.nearField) consider({ ...c, kind: "near_field" })
  for (const c of input.references) consider({ ...c, kind: "reference" })
  // recall sorted best-first
  for (const c of [...input.recall].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) consider({ ...c, kind: "recall" })

  // Invariant assertion (belt-and-suspenders alongside config clamping): the emitted set is never
  // over the ceiling. This throws only on a real bug in the arithmetic above, never on user input
  // (over-budget input lands in `overflow`, not `admitted`).
  if (total > budget) {
    throw new Error(`working-set invariant violated: ${total} > ceiling ${budget}`)
  }

  return { items: admitted, tokens: total, budget, overflow }
}

// Build the anchor candidates from a ledger's task anchor (active goals + constraints) plus the
// current live step (`next`). These are the never-drop items (C1 §1).
export const anchorCandidates = (ledger: Ledger): WorkingSetCandidate[] => {
  const out: WorkingSetCandidate[] = taskAnchor(ledger).map((e) => entryCandidate(e, "anchor"))
  const next = currentNext(ledger)
  if (next) out.push(entryCandidate(next, "anchor"))
  return out
}

const entryCandidate = (e: LedgerEntry, kind: WorkingSetItemKind): WorkingSetCandidate => ({
  id: e.id,
  kind,
  text: e.rationale ? `[${e.kind}] ${e.text} — ${e.rationale}` : `[${e.kind}] ${e.text}`,
})

// Score ledger recall candidates against the current task using the SAME keyword/token similarity
// primitive GraphQuery uses (knowledgeSimilarity — overlap coefficient, NO embeddings). This is the
// in-ledger recall fallback used when a full GraphQuery pass is not wired; the Curator service prefers
// GraphQuery hits and uses this only over the local ledger entries. Returns candidates sorted
// best-first, capped to config.recallLimit, excluding the anchor kinds.
export const ledgerRecall = (ledger: Ledger, task: string, config: ContextConfig): WorkingSetCandidate[] => {
  const scored = recallCandidates(ledger)
    .map((e) => {
      const sim = task && task.length > 0 ? knowledgeSimilarity(`${e.text} ${e.rationale ?? ""}`, task) : 0
      return { entry: e, score: sim }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.recallLimit)
  return scored.map((s) => ({ ...entryCandidate(s.entry, "recall"), score: s.score }))
}
