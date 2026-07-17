import { describe, expect, test, beforeEach } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as SessionState from "../../src/deepagent/session-state"
import * as PlanController from "../../src/deepagent/plan-controller"
import { planGate, HookPolicy } from "../../src/deepagent/hooks"

// U1 end-to-end contract (the exact decision the tools.ts chokepoint computes). DESIGN (aligned with
// codex exec_policy): plan-ledger state is orthogonal to whether a tool may run, so a stale plan
// NEVER hard-blocks a mutating tool — it WARNS (tool runs, reminder attached) so the model is nudged
// to re-sync without being denied its tools. Read/plan tools always pass. The only hard block that
// remains is the U9 per-step binding gate (strict hard modes), and even that has a runtime grace
// release so it can never permanently deadlock. This mirrors session/tools.ts without booting the
// full session loop.

const gate = new HookPolicy().on("before_tool_use", planGate())

// Reproduce the soft-layer chokepoint decision (session/tools.ts): staleReason + isMutating +
// lightweight. The U9 hard-layer fields are exercised separately in the binding tests below.
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

describe("U1 soft-gate loop (chokepoint contract)", () => {
  beforeEach(() => {
    SessionState.configure(mkdtempSync(path.join(tmpdir(), "plan-gate-")))
  })

  test("high mode: stale plan WARNS on edit (never blocks), allows read/plan, plan tool clears warn", () => {
    SessionState.getOrCreate("gate-s1", "high")
    // a failing validation flips the latch from runtime truth
    SessionState.recordValidation(
      "gate-s1",
      [{ command: "tsc", passed: false, exit_code: 1, output: "e", duration_ms: 1 }],
      "e",
    )

    // A stale plan no longer denies a mutating tool — it warns (the tool still runs).
    expect(decideAt("gate-s1", "edit", "high").decision).toBe("warn")
    expect(decideAt("gate-s1", "read", "high").decision).toBe("allow")
    expect(decideAt("gate-s1", "plan", "high").decision).toBe("allow")

    // model calls the plan tool -> setPlan clears the latch -> no more warn
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

  test("escape hatch: after too many replans the gate stops warning (routes to human elsewhere)", () => {
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
    // gate no longer warns (escape hatch flips planStale false) — the macro-round stop gate routes to
    // needs_human instead of looping on plan re-sync.
    expect(decideAt("gate-s3", "edit", "high").decision).toBe("allow")
  })

  // ── read-only shell commands are never gated (the agent's eyes), aligned with codex is_safe_command ──
  test("read-only bash (ls/git status/grep/sed -n/sort) is allowed even while the plan is stale", () => {
    SessionState.getOrCreate("gate-ro", "xhigh")
    SessionState.markPlanStale("gate-ro", "validation_failed")
    // a mutating bash command warns (runs + reminder), never a hard block…
    expect(decideAt("gate-ro", "bash", "xhigh", "rm -rf build").decision).toBe("warn")
    // …and read-only shell inspections pass outright (isMutating=false → allow).
    expect(decideAt("gate-ro", "bash", "xhigh", "ls -la").decision).toBe("allow")
    expect(decideAt("gate-ro", "bash", "xhigh", "git status").decision).toBe("allow")
    expect(decideAt("gate-ro", "bash", "xhigh", "grep -rn TODO src/").decision).toBe("allow")
    expect(decideAt("gate-ro", "bash", "xhigh", "cat file.txt | head -20").decision).toBe("allow")
    // P0: the exact probe form that triggered the production deadlock (sed line-slice) is read-only.
    expect(decideAt("gate-ro", "bash", "xhigh", "sed -n '18,45p' shim_utils.h").decision).toBe("allow")
    expect(decideAt("gate-ro", "bash", "xhigh", "sort file.txt | uniq -c").decision).toBe("allow")
  })

  // ── a new user message must not hard-block work the user is asking for ──────────────────────────
  test("user_appended stale reason warns (tool runs); validation_failed also warns (never blocks)", () => {
    SessionState.getOrCreate("gate-user", "xhigh")
    SessionState.markPlanStale("gate-user", "user_appended")
    expect(decideAt("gate-user", "edit", "xhigh").decision).toBe("warn")
    // a genuine reality-change signal also warns now — plan ledger state never denies execution.
    SessionState.clearPlanStale("gate-user")
    SessionState.markPlanStale("gate-user", "validation_failed")
    expect(decideAt("gate-user", "edit", "xhigh").decision).toBe("warn")
  })
})

// ── U9 per-step binding: the one remaining hard block, with a runtime grace release ───────────────
// The binding gate (strict hard modes: xhigh/max/ultra) requires a mutating tool to be bound to an
// active plan step. This is workflow discipline, not a safety property, so it must never permanently
// deadlock: after repeated blocks with no forward progress the runtime grace release downgrades it to
// a warn WITHOUT any model cooperation — the same anti-deadlock invariant as the stale layer.
describe("U9 binding gate + grace release", () => {
  const decideBinding = (opts: { hasActiveStep: boolean; hardGateMissBlocks: boolean; graceRelease: boolean }) =>
    gate.evaluate({
      name: "before_tool_use",
      payload: {
        planStale: false,
        isMutating: true,
        lightweight: false,
        hardGate: true,
        hasActiveStep: opts.hasActiveStep,
        hardGateMissBlocks: opts.hardGateMissBlocks,
        graceRelease: opts.graceRelease,
      },
    })

  test("strict hard mode blocks a mutating tool with no active step", () => {
    expect(decideBinding({ hasActiveStep: false, hardGateMissBlocks: true, graceRelease: false }).decision).toBe(
      "block",
    )
  })

  test("lenient hard mode (high) only warns on a missing active step", () => {
    expect(decideBinding({ hasActiveStep: false, hardGateMissBlocks: false, graceRelease: false }).decision).toBe(
      "warn",
    )
  })

  test("an active step passes the binding gate", () => {
    expect(decideBinding({ hasActiveStep: true, hardGateMissBlocks: true, graceRelease: false }).decision).toBe(
      "allow",
    )
  })

  test("grace release downgrades the strict binding block to a warn (never permanently deadlocks)", () => {
    // Even in the strictest mode with no active step, once the runtime grace release fires the tool is
    // allowed through with a reminder rather than blocked forever.
    expect(decideBinding({ hasActiveStep: false, hardGateMissBlocks: true, graceRelease: true }).decision).toBe(
      "warn",
    )
  })

  test("grace counter machinery: blocks accumulate, forward progress resets", () => {
    SessionState.configure(mkdtempSync(path.join(tmpdir(), "plan-gate-bind-")))
    SessionState.getOrCreate("gate-bind", "xhigh")
    SessionState.markPlanStale("gate-bind", "validation_failed")
    SessionState.recordPlanGateBlock("gate-bind")
    SessionState.recordPlanGateBlock("gate-bind")
    expect(SessionState.planLatch("gate-bind")!.consecutive_blocks).toBe(2)
    SessionState.resetPlanGateBlocks("gate-bind")
    expect(SessionState.planLatch("gate-bind")!.consecutive_blocks).toBe(0)
    expect(PlanController.shouldGraceRelease(SessionState.planLatch("gate-bind")!)).toBe(false)
  })
})
