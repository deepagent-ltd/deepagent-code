import { describe, expect, test, beforeEach } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as SessionState from "../../src/deepagent/session-state"
import * as PlanController from "../../src/deepagent/plan-controller"
import { planGate, HookPolicy } from "../../src/deepagent/hooks"

// U1 end-to-end contract (the exact decision the tools.ts chokepoint computes): a stale plan
// soft-blocks a mutating tool, read/plan tools pass, and calling the plan tool (setPlan) clears the
// latch so the next mutating tool is allowed again. This mirrors the wiring in session/tools.ts
// without booting the full session loop.

const gate = new HookPolicy().on("before_tool_use", planGate())

// Reproduce the chokepoint decision exactly (session/tools.ts), including the U1 anti-deadlock
// payload fields (staleReason, graceRelease) and the shell command classification.
const decideAt = (sessionId: string, toolId: string, mode: string, command?: string) => {
  const latch = SessionState.planLatch(sessionId)
  const planStale = latch?.latch === "stale" && !PlanController.shouldEscapeToHuman(latch)
  return gate.evaluate({
    name: "before_tool_use",
    payload: {
      planStale,
      staleReason: latch?.stale_reason ?? null,
      graceRelease: latch != null && PlanController.shouldGraceRelease(latch),
      isMutating: PlanController.isMutatingTool(toolId, command),
      lightweight: PlanController.isLightweightMode(mode),
    },
  })
}

// Mirror the tools.ts block/reset bookkeeping so the loop tests advance the runtime grace counter
// exactly as production does: a block records a gate block; a mutating tool that runs resets it.
const applyOutcome = (sessionId: string, decision: string) => {
  if (decision === "block") SessionState.recordPlanGateBlock(sessionId)
}

describe("U1 soft-gate loop (chokepoint contract)", () => {
  beforeEach(() => {
    SessionState.configure(mkdtempSync(path.join(tmpdir(), "plan-gate-")))
  })

  test("high mode: stale plan blocks edit, allows read/plan, plan tool unblocks", () => {
    SessionState.getOrCreate("gate-s1", "high")
    // a failing validation flips the latch from runtime truth
    SessionState.recordValidation(
      "gate-s1",
      [{ command: "tsc", passed: false, exit_code: 1, output: "e", duration_ms: 1 }],
      "e",
    )

    expect(decideAt("gate-s1", "edit", "high").decision).toBe("block")
    expect(decideAt("gate-s1", "read", "high").decision).toBe("allow")
    expect(decideAt("gate-s1", "plan", "high").decision).toBe("allow")

    // model calls the plan tool -> setPlan clears the latch
    SessionState.setPlan(
      "gate-s1",
      PlanController.buildPlanFromInput("gate-s1", { goal: "g", steps: [{ title: "fix", status: "active" }] }),
    )
    expect(decideAt("gate-s1", "edit", "high").decision).toBe("allow")
  })

  test("general (lightweight) mode: stale plan only warns, never blocks", () => {
    SessionState.getOrCreate("gate-s2", "general")
    SessionState.markPlanStale("gate-s2", "user_appended")
    expect(decideAt("gate-s2", "edit", "general").decision).toBe("warn")
  })

  test("escape hatch: after too many replans the gate stops blocking (routes to human elsewhere)", () => {
    SessionState.getOrCreate("gate-s3", "high")
    // exhaust the replan budget: each setPlan bumps replan_count
    for (let i = 0; i <= PlanController.DEFAULT_REPLAN_LIMIT; i++) {
      SessionState.markPlanStale("gate-s3", "no_progress")
      SessionState.setPlan(
        "gate-s3",
        PlanController.buildPlanFromInput("gate-s3", { goal: "g", steps: [{ title: "t", status: "active" }] }),
      )
    }
    // now mark stale once more; replan_count already exceeds the limit
    SessionState.markPlanStale("gate-s3", "no_progress")
    expect(PlanController.shouldEscapeToHuman(SessionState.planLatch("gate-s3")!)).toBe(true)
    // gate no longer blocks (escape hatch) — the macro-round stop gate routes to needs_human instead
    expect(decideAt("gate-s3", "edit", "high").decision).toBe("allow")
  })

  // ── U1 anti-deadlock: read-only shell commands are never gated ──────────────────────────────────
  test("read-only bash (ls/git status/grep) is allowed even while the plan is stale", () => {
    SessionState.getOrCreate("gate-ro", "xhigh")
    SessionState.markPlanStale("gate-ro", "validation_failed")
    // a mutating bash command IS gated…
    expect(decideAt("gate-ro", "bash", "xhigh", "rm -rf build").decision).toBe("block")
    // …but read-only shell inspections pass (the agent must be able to see to repair the plan).
    expect(decideAt("gate-ro", "bash", "xhigh", "ls -la").decision).toBe("allow")
    expect(decideAt("gate-ro", "bash", "xhigh", "git status").decision).toBe("allow")
    expect(decideAt("gate-ro", "bash", "xhigh", "grep -rn TODO src/").decision).toBe("allow")
    expect(decideAt("gate-ro", "bash", "xhigh", "cat file.txt | head -20").decision).toBe("allow")
  })

  // ── U1 anti-deadlock: runtime-driven grace release (the production-deadlock fix) ────────────────
  test("grace release: after repeated blocks with no re-plan, the gate releases WITHOUT model help", () => {
    SessionState.getOrCreate("gate-grace", "xhigh")
    SessionState.markPlanStale("gate-grace", "validation_failed")

    // The model keeps trying a mutating bash command and NEVER calls the plan tool (the exact
    // production failure mode: 280 consecutive blocked bash calls). Each block advances the runtime
    // grace counter — no setPlan required.
    for (let i = 0; i < PlanController.DEFAULT_GRACE_BLOCK_LIMIT; i++) {
      const decision = decideAt("gate-grace", "bash", "xhigh", "make build").decision
      expect(decision).toBe("block")
      applyOutcome("gate-grace", decision)
    }

    // The escape-to-human hatch has NOT fired (replan_count never advanced — the model didn't
    // cooperate), proving the old hatch alone would have deadlocked forever here.
    expect(PlanController.shouldEscapeToHuman(SessionState.planLatch("gate-grace")!)).toBe(false)

    // But the runtime grace release fires: the next mutating call is downgraded to a WARN (tool runs,
    // reminder attached) instead of a hard block. The agent is never permanently denied its tools.
    expect(PlanController.shouldGraceRelease(SessionState.planLatch("gate-grace")!)).toBe(true)
    expect(decideAt("gate-grace", "bash", "xhigh", "make build").decision).toBe("warn")
  })

  test("grace counter resets when forward progress happens (mutating tool executes)", () => {
    SessionState.getOrCreate("gate-reset", "xhigh")
    SessionState.markPlanStale("gate-reset", "validation_failed")
    SessionState.recordPlanGateBlock("gate-reset")
    SessionState.recordPlanGateBlock("gate-reset")
    expect(SessionState.planLatch("gate-reset")!.consecutive_blocks).toBe(2)
    // a mutating tool actually ran → reset
    SessionState.resetPlanGateBlocks("gate-reset")
    expect(SessionState.planLatch("gate-reset")!.consecutive_blocks).toBe(0)
    expect(PlanController.shouldGraceRelease(SessionState.planLatch("gate-reset")!)).toBe(false)
  })

  // ── U1 anti-deadlock: a new user message must not hard-block work the user is asking for ────────
  test("user_appended stale reason warns (tool runs) rather than hard-blocking, even at xhigh", () => {
    SessionState.getOrCreate("gate-user", "xhigh")
    SessionState.markPlanStale("gate-user", "user_appended")
    // mutating edit is downgraded to warn (runs + reminder), not blocked
    expect(decideAt("gate-user", "edit", "xhigh").decision).toBe("warn")
    // whereas a genuine reality-change signal still hard-blocks
    SessionState.clearPlanStale("gate-user")
    SessionState.markPlanStale("gate-user", "validation_failed")
    expect(decideAt("gate-user", "edit", "xhigh").decision).toBe("block")
  })
})
