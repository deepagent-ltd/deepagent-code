import { describe, expect, test } from "bun:test"
import {
  aggregateSessionStats,
  formatCost,
  formatTokenCount,
  sortModelUsage,
  type StatsSession,
} from "./session-stats"

const MS_IN_DAY = 24 * 60 * 60 * 1000

function session(overrides: Partial<StatsSession> & { id: string }): StatsSession {
  return {
    time: { created: 0, updated: 0 },
    ...overrides,
  }
}

describe("aggregateSessionStats", () => {
  test("empty input yields zeroed stats without NaN", () => {
    const stats = aggregateSessionStats([])
    expect(stats.totalSessions).toBe(0)
    expect(stats.totalCost).toBe(0)
    expect(stats.totalTokens.input).toBe(0)
    expect(stats.tokensPerSession).toBe(0)
    expect(stats.medianTokensPerSession).toBe(0)
    expect(stats.costPerDay).toBe(0)
    expect(Object.keys(stats.modelUsage)).toHaveLength(0)
  })

  test("sums cost and tokens across sessions", () => {
    const stats = aggregateSessionStats([
      session({
        id: "a",
        cost: 1.5,
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } },
      }),
      session({
        id: "b",
        cost: 0.25,
        tokens: { input: 200, output: 30, reasoning: 0, cache: { read: 15, write: 8 } },
      }),
    ])
    expect(stats.totalSessions).toBe(2)
    expect(stats.totalCost).toBeCloseTo(1.75)
    expect(stats.totalTokens.input).toBe(300)
    expect(stats.totalTokens.output).toBe(80)
    expect(stats.totalTokens.reasoning).toBe(10)
    expect(stats.totalTokens.cache.read).toBe(20)
    expect(stats.totalTokens.cache.write).toBe(10)
  })

  test("groups model usage by provider/model key", () => {
    const stats = aggregateSessionStats([
      session({
        id: "a",
        cost: 1,
        tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 3 } },
        model: { providerID: "anthropic", id: "claude" },
      }),
      session({
        id: "b",
        cost: 2,
        tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        model: { providerID: "anthropic", id: "claude" },
      }),
      session({
        id: "c",
        cost: 4,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        model: { providerID: "openai", id: "gpt" },
      }),
    ])
    const claude = stats.modelUsage["anthropic/claude"]
    const gpt = stats.modelUsage["openai/gpt"]
    expect(claude).toBeDefined()
    expect(claude.sessions).toBe(2)
    expect(claude.cost).toBeCloseTo(3)
    expect(claude.tokens.input).toBe(30)
    expect(claude.tokens.output).toBe(15)
    expect(claude.tokens.reasoning).toBe(1)
    expect(claude.tokens.cache.read).toBe(2)
    expect(claude.tokens.cache.write).toBe(3)
    expect(gpt).toBeDefined()
    expect(gpt.sessions).toBe(1)
    expect(gpt.cost).toBeCloseTo(4)
  })

  test("sessions without rollups contribute zero and stay out of model usage", () => {
    const stats = aggregateSessionStats([
      session({ id: "a" }),
      session({ id: "b", cost: Number.NaN, tokens: undefined }),
      session({
        id: "c",
        cost: 1,
        tokens: { input: 4, output: 6, reasoning: 0, cache: { read: 0, write: 0 } },
        model: { providerID: "p", id: "m" },
      }),
    ])
    expect(stats.totalSessions).toBe(3)
    expect(stats.totalCost).toBeCloseTo(1)
    expect(stats.totalTokens.input).toBe(4)
    expect(stats.totalTokens.output).toBe(6)
    expect(Object.keys(stats.modelUsage)).toEqual(["p/m"])
  })

  test("computes per-session averages and median (even count)", () => {
    const stats = aggregateSessionStats([
      session({ id: "a", tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      session({ id: "b", tokens: { input: 30, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      session({ id: "c", tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      session({ id: "d", tokens: { input: 200, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    ])
    expect(stats.tokensPerSession).toBeCloseTo((10 + 30 + 100 + 200) / 4)
    expect(stats.medianTokensPerSession).toBeCloseTo((30 + 100) / 2)
  })

  test("computes date range, days and cost per day", () => {
    const start = Date.UTC(2026, 0, 1)
    const stats = aggregateSessionStats([
      session({ id: "a", cost: 3, time: { created: start, updated: start + MS_IN_DAY } }),
      session({ id: "b", cost: 5, time: { created: start + MS_IN_DAY, updated: start + 3 * MS_IN_DAY } }),
    ])
    expect(stats.dateRange.earliest).toBe(start)
    expect(stats.dateRange.latest).toBe(start + 3 * MS_IN_DAY)
    expect(stats.days).toBe(3)
    expect(stats.costPerDay).toBeCloseTo(8 / 3)
  })

  test("single session collapses to one day", () => {
    const at = Date.UTC(2026, 0, 1)
    const stats = aggregateSessionStats([session({ id: "a", cost: 2, time: { created: at, updated: at } })])
    expect(stats.days).toBe(1)
    expect(stats.costPerDay).toBeCloseTo(2)
  })
})

describe("formatTokenCount", () => {
  test("keeps small numbers verbatim", () => {
    expect(formatTokenCount(0)).toBe("0")
    expect(formatTokenCount(999)).toBe("999")
  })

  test("compacts thousands and millions", () => {
    expect(formatTokenCount(1_500)).toBe("1.5K")
    expect(formatTokenCount(2_500_000)).toBe("2.5M")
  })

  test("tolerates non-finite input", () => {
    expect(formatTokenCount(Number.NaN)).toBe("0")
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe("0")
  })
})

describe("formatCost", () => {
  test("formats dollars with two decimals by default", () => {
    expect(formatCost(1.2345)).toBe("$1.23")
    expect(formatCost(0)).toBe("$0.00")
  })

  test("supports higher precision for model rows", () => {
    expect(formatCost(0.1234, 4)).toBe("$0.1234")
  })

  test("tolerates non-finite input", () => {
    expect(formatCost(Number.NaN)).toBe("$0.00")
  })
})

describe("sortModelUsage", () => {
  test("sorts by cost descending with session count tiebreak", () => {
    const usage = aggregateSessionStats([
      session({ id: "a", cost: 1, model: { providerID: "p", id: "cheap" } }),
      session({ id: "b", cost: 9, model: { providerID: "p", id: "pricey" } }),
      session({ id: "c", cost: 1, model: { providerID: "p", id: "busy" } }),
      session({ id: "d", cost: 0, model: { providerID: "p", id: "busy" } }),
    ]).modelUsage
    const sorted = sortModelUsage(usage).map(([key]) => key)
    expect(sorted).toEqual(["p/pricey", "p/busy", "p/cheap"])
  })
})
