import type { SessionContextUsageSchema } from "@deepagent-code/core/session/context-usage.schema"

export function contextTokens(value: number | null | undefined, locale: string) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—"
  if (value === 0) return "0K"
  if (value > 0 && value < 1000) return "<1K"
  return `${Math.round(value / 1000).toLocaleString(locale)}K`
}

export function contextPercent(estimate: SessionContextUsageSchema.Summary["estimate"] | undefined, dirty: boolean) {
  if (
    dirty ||
    estimate?.status !== "complete" ||
    estimate.inputTokens === null ||
    estimate.contextLimit === null ||
    estimate.contextLimit <= 0
  )
    return
  const raw = (estimate.inputTokens / estimate.contextLimit) * 100
  return {
    raw,
    used: raw > 0 && raw < 1 ? "<1" : String(Math.round(raw)),
    remaining: raw > 0 && raw < 1 ? ">99" : String(Math.max(0, 100 - Math.round(raw))),
    over: raw > 100,
  }
}

export const contextTokenTotal = (tokens: SessionContextUsageSchema.Tokens) =>
  tokens.nonCachedInput + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning
