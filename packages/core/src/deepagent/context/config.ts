// V3.8 Appendix-A (context management redesign) — the ONE place every tunable lives. The user
// constraint is "不要限制的太死" (do not bake limits in tight): budget %, consolidation interval,
// chunk size, and query_log limits are all CONFIGURABLE with sensible defaults, never hardcoded at a
// call site. Callers read `resolveContextConfig(overrides)` so a partial override (from config.ts /
// a test / the gateway) is merged over the defaults.
//
// The single hard invariant that is NOT freely relaxable: the Working Set budget FRACTION is a HARD
// CEILING of the model context (App-A C1: "50% 是硬上限"). The default is 0.5; an override may make
// it SMALLER (more conservative) but `resolveContextConfig` CLAMPS it to <= MAX_BUDGET_FRACTION so a
// misconfiguration can never push the working set past the ceiling. This is asserted here and again
// at assembly time in the Curator (belt-and-suspenders).

export const MAX_BUDGET_FRACTION = 0.5

export type ContextConfig = {
  // Fraction of the model context window the Working Set may occupy. HARD ceiling: clamped to
  // <= MAX_BUDGET_FRACTION. Default 0.5. Leaves >=50% for output + reasoning + volatility (C1).
  readonly budgetFraction: number
  // Fraction of the model context the Project Bridge handoff summary may occupy at session open.
  // Small by design — the bridge is a handoff note, not a context dump.
  readonly bridgeBudgetFraction: number
  // Near-field: how many most-recent verbatim turns the Curator keeps before falling back to Ledger
  // recall for older material. The "short-term memory" that keeps the model coherent (C1 §2).
  readonly nearFieldTurns: number
  // Max Ledger entries pulled into the Working Set by relevance recall each turn (C1 §4). Small on
  // purpose: recall a few RELEVANT entries, not the whole ledger.
  readonly recallLimit: number
  // Consolidation cadence for infinite sessions (C4): run a Ledger consolidation every N turns.
  // 0 disables periodic consolidation.
  readonly consolidationIntervalTurns: number
  // C1.5 chunked ingest: target size (in tokens) of each ingest chunk. Kept far below the working
  // set ceiling so ingest never itself blows the budget (C1.5 §1).
  readonly ingestChunkTokens: number
  // query_log defaults: max entries a single query_log call returns, and the max chars of a single
  // recalled log entry admitted back into the Working Set (Stage 5).
  readonly queryLogDefaultLimit: number
  readonly queryLogMaxLimit: number
  // Whether reasoning is excluded from the Working Set / carried to the next turn (C1). Default true
  // (reasoning is drafted, logged, but NOT re-fed). Configurable for providers/experiments that need
  // it, but the App-A default is exclusion.
  readonly excludeReasoning: boolean
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  budgetFraction: MAX_BUDGET_FRACTION,
  bridgeBudgetFraction: 0.05,
  nearFieldTurns: 4,
  recallLimit: 6,
  consolidationIntervalTurns: 25,
  ingestChunkTokens: 4_000,
  queryLogDefaultLimit: 20,
  queryLogMaxLimit: 200,
  excludeReasoning: true,
}

export type ContextConfigOverrides = Partial<ContextConfig>

const clampFraction = (value: number, max: number): number => Math.max(0, Math.min(max, value))
const positive = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? value : fallback
const nonNegativeInt = (value: number, fallback: number): number =>
  Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback

// Merge overrides over the defaults, clamping the two fractions so the HARD ceiling can never be
// exceeded by config. Everything else is validated to a sane range but stays freely tunable.
export const resolveContextConfig = (overrides: ContextConfigOverrides = {}): ContextConfig => {
  const merged = { ...DEFAULT_CONTEXT_CONFIG, ...overrides }
  return {
    budgetFraction: clampFraction(merged.budgetFraction, MAX_BUDGET_FRACTION),
    bridgeBudgetFraction: clampFraction(merged.bridgeBudgetFraction, MAX_BUDGET_FRACTION),
    nearFieldTurns: nonNegativeInt(merged.nearFieldTurns, DEFAULT_CONTEXT_CONFIG.nearFieldTurns),
    recallLimit: nonNegativeInt(merged.recallLimit, DEFAULT_CONTEXT_CONFIG.recallLimit),
    consolidationIntervalTurns: nonNegativeInt(
      merged.consolidationIntervalTurns,
      DEFAULT_CONTEXT_CONFIG.consolidationIntervalTurns,
    ),
    ingestChunkTokens: positive(merged.ingestChunkTokens, DEFAULT_CONTEXT_CONFIG.ingestChunkTokens),
    queryLogDefaultLimit: positive(merged.queryLogDefaultLimit, DEFAULT_CONTEXT_CONFIG.queryLogDefaultLimit),
    queryLogMaxLimit: positive(merged.queryLogMaxLimit, DEFAULT_CONTEXT_CONFIG.queryLogMaxLimit),
    excludeReasoning: merged.excludeReasoning,
  }
}

// The absolute token ceiling for a working set given a model context window. This is THE enforcement
// point referenced by the Curator: budget = floor(contextTokens * budgetFraction), and budgetFraction
// is already clamped to <= 0.5. Returns 0 for an unknown/zero context (caller then falls back).
export const workingSetBudgetTokens = (contextTokens: number, config: ContextConfig): number => {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return 0
  return Math.floor(contextTokens * config.budgetFraction)
}
