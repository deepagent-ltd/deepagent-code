import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { consultPanel, type ConsultDeps } from "../../src/panel/consult"
import type { PanelTurnRunner } from "../../src/panel/panelist-runner"
import type { ReviewResult } from "../../src/agent/schema/orchestration"

/**
 * V3.9 §C — the STANDALONE Expert Panel entry. These assert that convening the panel WITHOUT the goal
 * loop produces a deterministic verdict from the shared panelist-runner + arbiter, and that graceful
 * degradation (all panelists absent) yields needs_human, never a silent approve.
 */

// A stub PanelTurnRunner: returns a ReviewResult keyed by which lens prompt it sees (the lens name is
// embedded in the differentiated prompt). Lets us drive per-lens verdicts deterministically.
const reviewFor = (verdict: ReviewResult["verdict"], withFinding: boolean): ReviewResult => ({
  verdict,
  findings: withFinding
    ? [
        {
          severity: "high",
          category: "correctness",
          file: "src/x.ts",
          line: 10,
          summary: "bug",
          failureScenario: "input A ⇒ wrong B",
          confidence: 0.9,
        },
      ]
    : [],
})

const runnerReturning = (byLensKeyword: Record<string, ReviewResult>): PanelTurnRunner => (input) => {
  // The prompt embeds the lens's differentiated system prompt; match on a keyword present in it.
  const lower = input.prompt.toLowerCase()
  for (const [keyword, review] of Object.entries(byLensKeyword)) {
    if (lower.includes(keyword)) return Effect.succeed({ structured: review })
  }
  return Effect.succeed({ structured: reviewFor("approve", false) })
}

const deps = (runTurn: PanelTurnRunner): ConsultDeps => ({ runTurn })

describe("consultPanel (§C standalone)", () => {
  test("all lenses approve ⇒ verdict approve", async () => {
    const runTurn = runnerReturning({}) // default: everyone approves
    const verdict = await Effect.runPromise(
      consultPanel(
        {
          question: "Is this change safe?",
          codeRefs: ["src/x.ts:10"],
          parentSessionID: "sess-1",
          lenses: ["correctness", "security"],
        },
        deps(runTurn),
      ),
    )
    expect(verdict.decision).toBe("approve")
  })

  test("a security block with evidence forces block under the security policy", async () => {
    // security lens blocks with a reproducible finding; others approve.
    const runTurn = runnerReturning({ security: reviewFor("block", true) })
    const verdict = await Effect.runPromise(
      consultPanel(
        {
          question: "Does this expose a vuln?",
          codeRefs: ["src/auth.ts:5"],
          parentSessionID: "sess-2",
          lenses: ["correctness", "security", "performance"],
          policy: "security",
        },
        deps(runTurn),
      ),
    )
    expect(verdict.decision).toBe("block")
  })

  test("all panelists absent ⇒ needs_human (never a silent approve)", async () => {
    // A runner that always dies ⇒ every panelist is absent ⇒ below quorum ⇒ needs_human. (The
    // PanelTurnRunner lives on the `never` channel; a real failure surfaces as a defect, which
    // buildPanelistRunner catches to null.)
    const runTurn: PanelTurnRunner = () => Effect.die(new Error("panelist down"))
    const verdict = await Effect.runPromise(
      consultPanel(
        {
          question: "anything",
          codeRefs: [],
          parentSessionID: "sess-3",
          lenses: ["correctness", "security"],
        },
        deps(runTurn),
      ),
    )
    expect(verdict.decision).toBe("needs_human")
  })

  test("defaults to all five core lenses when none specified", async () => {
    const seen = new Set<string>()
    const runTurn: PanelTurnRunner = (input) => {
      for (const lens of ["correctness", "security", "performance", "architecture", "repro"]) {
        if (input.prompt.toLowerCase().includes(lens)) seen.add(lens)
      }
      return Effect.succeed({ structured: reviewFor("approve", false) })
    }
    await Effect.runPromise(
      consultPanel({ question: "q", codeRefs: [], parentSessionID: "sess-4" }, deps(runTurn)),
    )
    expect(seen.size).toBe(5)
  })
})
