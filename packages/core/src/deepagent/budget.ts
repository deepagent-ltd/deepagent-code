import type { RoundState } from "./round-state"
import { defaultMaxRounds, type AgentMode } from "./mode"

export type BudgetConfig = {
  readonly maxInputTokens: number | null
  readonly maxOutputTokens: number | null
  readonly maxTotalTokens: number | null
  readonly maxRounds: number | null
  readonly maxWallTimeMs: number | null
  readonly warnAtPercent: number
}

export type BudgetStatus = "ok" | "warning" | "exhausted" | "exceeded"

export type BudgetCheck = {
  readonly status: BudgetStatus
  readonly tokensUsed: number
  readonly tokensRemaining: number | null
  readonly roundsUsed: number
  readonly roundsRemaining: number | null
  readonly message: string | null
}

export const defaultBudget = (mode: AgentMode): BudgetConfig => ({
  maxInputTokens: null,
  maxOutputTokens: null,
  maxTotalTokens: null,
  maxRounds: mode === "ultra" ? defaultMaxRounds(mode) : null,
  maxWallTimeMs: null,
  warnAtPercent: 90,
})

export const check = (state: RoundState, config: BudgetConfig): BudgetCheck => {
  const tokensUsed = state.total_input_tokens + state.total_output_tokens
  const tokensRemaining = config.maxTotalTokens !== null ? config.maxTotalTokens - tokensUsed : null
  const roundsRemaining = config.maxRounds !== null ? config.maxRounds - state.round : null

  if (roundsRemaining !== null && roundsRemaining < 0) {
    return { status: "exceeded", tokensUsed, tokensRemaining, roundsUsed: state.round, roundsRemaining: 0, message: "Max rounds exceeded." }
  }

  if (tokensRemaining !== null && tokensRemaining <= 0) {
    return { status: "exhausted", tokensUsed, tokensRemaining: 0, roundsUsed: state.round, roundsRemaining, message: "Token budget exhausted." }
  }

  if (tokensRemaining !== null && config.maxTotalTokens !== null) {
    const percentUsed = (tokensUsed / config.maxTotalTokens) * 100
    if (percentUsed >= config.warnAtPercent) {
      return {
        status: "warning",
        tokensUsed,
        tokensRemaining,
        roundsUsed: state.round,
        roundsRemaining,
        message: `Token budget at ${Math.round(percentUsed)}%. Consider completing soon.`,
      }
    }
  }

  return { status: "ok", tokensUsed, tokensRemaining, roundsUsed: state.round, roundsRemaining, message: null }
}

export const shouldPause = (budgetCheck: BudgetCheck): boolean =>
  budgetCheck.status === "exhausted" || budgetCheck.status === "exceeded"

export const shouldWarn = (budgetCheck: BudgetCheck): boolean => budgetCheck.status === "warning"
