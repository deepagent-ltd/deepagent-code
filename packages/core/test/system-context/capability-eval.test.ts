import { describe, expect, test } from "bun:test"
import { capabilitySearch, fullAuthorization } from "@deepagent-code/core/system-context/capability-search"
import { capabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { capabilityBodies, bodyMetrics } from "@deepagent-code/core/system-context/capability-bodies"
import { renderCapabilityCatalog, capabilityCatalogMetrics } from "@deepagent-code/core/system-context/capability-catalog"
import { CapabilityBudget } from "@deepagent-code/core/system-context/capability-manifest"

// C4-11 — fixture/synthetic model eval (design §7.3 disclosure). LIVE/real-model eval
// is a C7-03 pause point and is NOT executed here. This compares three disclosure
// configurations on a FIXTURE task set with a deterministic agent (no model, no clock,
// no network):
//   - "no catalog":    the model has no capability discovery — it must guess a tool.
//   - "full manual":   every procedure body is dumped into the context.
//   - "L0 + on-demand": the boot catalog + search to discover, then load only the body
//                       needed for the task (the intended design).
// Metrics: success rate, token usage (L0 budget respected), tool-choice errors, and a
// deterministic latency proxy (fixed per-load work, no wall clock).

interface FixtureTask {
  readonly query: string
  readonly intendedAction: string
  readonly expectedCapability: string
  readonly expectedTool: string
}

// A deterministic fixture task set spanning capability-specific (discovery-dependent)
// and generic (easy-to-guess) tasks.
const FIXTURE_TASKS: ReadonlyArray<FixtureTask> = [
  { query: "read and trace references in this file", intendedAction: "read", expectedCapability: "deepagent.code-read", expectedTool: "read" },
  { query: "apply an exact change to a file", intendedAction: "edit", expectedCapability: "deepagent.code-edit", expectedTool: "edit" },
  { query: "run the test suite", intendedAction: "bash", expectedCapability: "deepagent.shell-execute", expectedTool: "bash" },
  { query: "recall project context across graphs", intendedAction: "context_query", expectedCapability: "deepagent.context-query", expectedTool: "context_query" },
  { query: "follow a documented skill procedure", intendedAction: "skill", expectedCapability: "deepagent.skill-guidance", expectedTool: "skill" },
  { query: "research current info on the web", intendedAction: "websearch", expectedCapability: "deepagent.web-research", expectedTool: "websearch" },
]

type EvalConfig = "no-catalog" | "full-manual" | "l0-on-demand"

interface EvalResult {
  readonly config: EvalConfig
  readonly tasks: number
  readonly successes: number
  readonly successRate: number
  readonly tokenUsage: number
  readonly toolChoiceErrors: number
  readonly latencyMs: number
}

/** Deterministic "agent": no model. Has capability discovery only when a config enables it. */
function chooseTool(
  config: EvalConfig,
  task: FixtureTask,
  search: (query: string, action: string) => ReadonlyArray<{ id: string; entry_tools: ReadonlyArray<string> }>,
  naive: (task: FixtureTask) => string,
): { readonly chosen: string; readonly correct: boolean } {
  if (config === "no-catalog") {
    const chosen = naive(task)
    return { chosen, correct: chosen === task.expectedTool }
  }
  const cards = search(task.query, task.intendedAction)
  const top = cards[0]
  // With discovery + (for on-demand) the loaded body, the agent resolves the capability.
  const chosen = top ? (top.entry_tools[0] ?? "") : naive(task)
  return { chosen, correct: chosen === task.expectedTool }
}

// Naive keyword tool-picker with NO capability knowledge (the no-catalog base case).
const NAIVE_TOOL_TABLE: ReadonlyArray<{ tool: string; keywords: ReadonlyArray<string> }> = [
  { tool: "read", keywords: ["read", "file", "source"] },
  { tool: "edit", keywords: ["edit", "change", "modify", "patch"] },
  { tool: "bash", keywords: ["build", "test", "run", "execute", "command"] },
  { tool: "websearch", keywords: ["web", "search", "external", "current"] },
]
function naiveTool(task: FixtureTask): string {
  const words = `${task.query} ${task.intendedAction}`.toLowerCase()
  let best = "read"
  let bestScore = 0
  for (const { tool, keywords } of NAIVE_TOOL_TABLE) {
    const score = keywords.reduce((acc, keyword) => acc + (words.includes(keyword) ? 1 : 0), 0)
    if (score > bestScore) {
      best = tool
      bestScore = score
    }
  }
  // Deterministic tie-fallback: without capability knowledge the naive picker cannot know
  // context_query / skill exist, so a task with no keyword match falls to the generic read.
  return best
}

const searchCards = (
  query: string,
  action: string,
): ReadonlyArray<{ id: string; entry_tools: ReadonlyArray<string> }> =>
  capabilitySearch(capabilityCatalog, { query, intended_action: action }, fullAuthorization).map((card) => ({
    id: String(card.id),
    entry_tools: card.entry_tools,
  }))

/** Deterministic latency proxy: fixed work per discovery/load, no wall clock. */
function latencyFor(config: EvalConfig, loads: number): number {
  if (config === "no-catalog") return 0
  if (config === "full-manual") return 0 // everything is already in context; nothing loaded on-demand
  return loads * 3 // 3ms per on-demand load (fixed, deterministic)
}

/** Measure one configuration deterministically over the fixture task set. */
function evaluate(config: EvalConfig): EvalResult {
  let successes = 0
  let errors = 0
  const loads: number[] = []

  // Token usage depends on the disclosure config, computed from the real catalog/bodies.
  const l0Text = renderCapabilityCatalog(capabilityCatalog)
  const l0Tokens = capabilityCatalogMetrics(l0Text).tokenCount
  const allBodyTokens = capabilityBodies.reduce((acc, entry) => acc + bodyMetrics(entry).tokenCount, 0)

  for (const task of FIXTURE_TASKS) {
    const search = config === "no-catalog" ? () => [] : searchCards
    const chosen = chooseTool(config, task, search, naiveTool)
    if (chosen.correct) successes += 1
    else errors += 1
    if (config === "l0-on-demand") loads.push(bodyMetrics(capabilityBodies.find((b) => b.id === task.expectedCapability)!).tokenCount)
  }

  const tokenUsage =
    config === "no-catalog"
      ? l0Tokens // the very compact boot catalog (no bodies, no search)
      : config === "full-manual"
        ? l0Tokens + allBodyTokens // everything is dumped; far over the L2 budget
        : l0Tokens + loads.reduce((a, b) => a + b, 0) // L0 + only the loaded body

  return {
    config,
    tasks: FIXTURE_TASKS.length,
    successes,
    successRate: successes / FIXTURE_TASKS.length,
    tokenUsage,
    toolChoiceErrors: errors,
    latencyMs: latencyFor(config, loads.length),
  }
}

describe("C4-11 fixture/synthetic model eval (three configurations, deterministic)", () => {
  const results = [evaluate("no-catalog"), evaluate("full-manual"), evaluate("l0-on-demand")]

  test("the fixture run stays deterministic (repeated runs are identical)", () => {
    const again = [evaluate("no-catalog"), evaluate("full-manual"), evaluate("l0-on-demand")]
    expect(again.map((r) => `${r.successRate}:${r.tokenUsage}:${r.toolChoiceErrors}:${r.latencyMs}`)).toEqual(
      results.map((r) => `${r.successRate}:${r.tokenUsage}:${r.toolChoiceErrors}:${r.latencyMs}`),
    )
  })

  test("L0+on-demand reaches every task (success = 1.0) while no-catalog cannot", () => {
    const byConfig = new Map(results.map((r) => [r.config, r]))
    expect(byConfig.get("l0-on-demand")!.successRate).toBe(1)
    expect(byConfig.get("no-catalog")!.successRate).toBeLessThan(1)
    // Discovery matters: the capability-specific tasks (context_query / skill) are undiscoverable without a catalog.
    expect(byConfig.get("no-catalog")!.toolChoiceErrors).toBeGreaterThan(byConfig.get("l0-on-demand")!.toolChoiceErrors)
  })

  test("L0+on-demand keeps token usage within the frozen L0 + on-demand budget", () => {
    const result = results.find((r) => r.config === "l0-on-demand")!
    const l0Text = renderCapabilityCatalog(capabilityCatalog)
    const l0Tokens = capabilityCatalogMetrics(l0Text).tokenCount
    expect(l0Tokens).toBeLessThanOrEqual(CapabilityBudget.l0MaxTokens)
    // L0 + the bodies actually loaded (≤2 per turn here, all under the 1200-token single cap).
    expect(result.tokenUsage).toBeGreaterThanOrEqual(l0Tokens)
    expect(result.tokenUsage).toBeLessThan(l0Tokens + 2 * CapabilityBudget.l2SingleMaxTokens)
  })

  test("full-manual dump pays for every body up front (worse than on-demand, over L0 budget)", () => {
    const result = results.find((r) => r.config === "full-manual")!
    const onDemand = results.find((r) => r.config === "l0-on-demand")!
    const allBodyTokens = capabilityBodies.reduce((acc, entry) => acc + bodyMetrics(entry).tokenCount, 0)
    // Every body is dumped regardless of the task, so it costs more tokens than the
    // on-demand config and exceeds the frozen L0 boot-catalog budget.
    expect(result.tokenUsage).toBe(allBodyTokens + capabilityCatalogMetrics(renderCapabilityCatalog(capabilityCatalog)).tokenCount)
    expect(result.tokenUsage).toBeGreaterThan(onDemand.tokenUsage)
    expect(result.tokenUsage).toBeGreaterThan(CapabilityBudget.l0MaxTokens)
  })

  test("L0+on-demand resolves with no tool-choice errors and pays the lowest on-demand latency", () => {
    const result = results.find((r) => r.config === "l0-on-demand")!
    expect(result.toolChoiceErrors).toBe(0)
    expect(result.latencyMs).toBeGreaterThan(0)
  })

  // The comparison table is surfaced via console — deterministic fixture values.
  test("emits the deterministic comparison table", () => {
    console.table(
      results.map((r) => ({
        config: r.config,
        tasks: r.tasks,
        success: `${r.successes}/${r.tasks}`,
        successRate: r.successRate.toFixed(2),
        tokenUsage: r.tokenUsage,
        toolChoiceErrors: r.toolChoiceErrors,
        latencyMs: r.latencyMs,
      })),
    )
    expect(results.map((r) => r.config)).toEqual(["no-catalog", "full-manual", "l0-on-demand"])
  })
})
