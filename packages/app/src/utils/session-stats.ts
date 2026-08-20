// PARITY-001: cross-session cost/token aggregation for the GUI.
//
// Mirrors the CLI `stats` command (packages/deepagent-code/src/cli/cmd/stats.ts) but aggregates
// over the sessions already synced into the directory store (`store.session`) instead of reading
// the database directly. The SDK `Session` type carries `cost`, `tokens` and `model` per session,
// so no new API endpoint is needed. Per-message breakdowns (tool usage, per-message model usage)
// are intentionally out of scope here — the store only carries session-level rollups.

/** Structural slice of the SDK `Session` shape this aggregation consumes. */
export interface StatsSession {
  readonly id: string
  readonly parentID?: string
  readonly cost?: number
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: {
      readonly read: number
      readonly write: number
    }
  }
  readonly model?: {
    readonly id: string
    readonly providerID: string
  }
  readonly time: {
    readonly created: number
    readonly updated: number
  }
}

export interface StatsModelUsage {
  readonly sessions: number
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: {
      readonly read: number
      readonly write: number
    }
  }
}

export interface SessionStats {
  readonly totalSessions: number
  readonly totalCost: number
  readonly totalTokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: {
      readonly read: number
      readonly write: number
    }
  }
  /** Keyed by `${providerID}/${modelID}`, matching the CLI stats model keys. */
  readonly modelUsage: Record<string, StatsModelUsage>
  readonly dateRange: {
    readonly earliest: number
    readonly latest: number
  }
  readonly days: number
  readonly costPerDay: number
  readonly tokensPerSession: number
  readonly medianTokensPerSession: number
}

const MS_IN_DAY = 24 * 60 * 60 * 1000

const emptyTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

const totalOf = (tokens: SessionStats["totalTokens"]) =>
  tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write

/**
 * Aggregate per-session cost/token rollups into a cross-session overview.
 *
 * Pure and allocation-light so it can run inside a `createMemo` on every store update. Sessions
 * missing `cost`/`tokens` (older rows, not yet rolled up) contribute zero.
 */
export function aggregateSessionStats(sessions: readonly StatsSession[]): SessionStats {
  const totalTokens = emptyTokens()
  const modelUsage: Record<string, StatsModelUsage> = {}
  const sessionTotals: number[] = []
  let totalCost = 0
  let earliest = 0
  let latest = 0

  for (const session of sessions) {
    const cost = typeof session.cost === "number" && Number.isFinite(session.cost) ? session.cost : 0
    const tokens = session.tokens
    totalCost += cost
    if (tokens) {
      totalTokens.input += tokens.input || 0
      totalTokens.output += tokens.output || 0
      totalTokens.reasoning += tokens.reasoning || 0
      totalTokens.cache.read += tokens.cache?.read || 0
      totalTokens.cache.write += tokens.cache?.write || 0
    }
    sessionTotals.push(totalOf({ ...emptyTokens(), ...tokens, cache: { ...emptyTokens().cache, ...tokens?.cache } }))

    if (session.model) {
      const key = `${session.model.providerID}/${session.model.id}`
      const existing = modelUsage[key]
      const merged: StatsModelUsage = existing
        ? {
            sessions: existing.sessions + 1,
            cost: existing.cost + cost,
            tokens: {
              input: existing.tokens.input + (tokens?.input || 0),
              output: existing.tokens.output + (tokens?.output || 0),
              reasoning: existing.tokens.reasoning + (tokens?.reasoning || 0),
              cache: {
                read: existing.tokens.cache.read + (tokens?.cache?.read || 0),
                write: existing.tokens.cache.write + (tokens?.cache?.write || 0),
              },
            },
          }
        : {
            sessions: 1,
            cost,
            tokens: {
              input: tokens?.input || 0,
              output: tokens?.output || 0,
              reasoning: tokens?.reasoning || 0,
              cache: {
                read: tokens?.cache?.read || 0,
                write: tokens?.cache?.write || 0,
              },
            },
          }
      modelUsage[key] = merged
    }

    const created = session.time?.created ?? 0
    const updated = session.time?.updated ?? created
    if (earliest === 0 || (created > 0 && created < earliest)) earliest = created
    if (updated > latest) latest = updated
  }

  const days = earliest > 0 && latest > earliest ? Math.max(1, Math.ceil((latest - earliest) / MS_IN_DAY)) : 1
  const grandTotal = totalOf(totalTokens)
  sessionTotals.sort((a, b) => a - b)
  const mid = Math.floor(sessionTotals.length / 2)
  const median =
    sessionTotals.length === 0
      ? 0
      : sessionTotals.length % 2 === 0
        ? (sessionTotals[mid - 1] + sessionTotals[mid]) / 2
        : sessionTotals[mid]

  return {
    totalSessions: sessions.length,
    totalCost,
    totalTokens,
    modelUsage,
    dateRange: { earliest, latest },
    days,
    costPerDay: totalCost / days,
    tokensPerSession: sessions.length > 0 ? grandTotal / sessions.length : 0,
    medianTokensPerSession: median,
  }
}

/** Compact token formatting shared with the CLI display (1.2K / 3.4M). */
export function formatTokenCount(num: number): string {
  if (!Number.isFinite(num)) return "0"
  const value = Math.round(num)
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M"
  if (value >= 1_000) return (value / 1_000).toFixed(1) + "K"
  return value.toString()
}

/** Dollar formatting for overview-level costs (two decimals). */
export function formatCost(cost: number, decimals = 2): string {
  const value = Number.isFinite(cost) ? cost : 0
  return `$${value.toFixed(decimals)}`
}

/** Model usage rows sorted by cost descending (ties: session count descending). */
export function sortModelUsage(modelUsage: Record<string, StatsModelUsage>): Array<[string, StatsModelUsage]> {
  return Object.entries(modelUsage).sort(
    ([, a], [, b]) => b.cost - a.cost || b.sessions - a.sessions,
  )
}
