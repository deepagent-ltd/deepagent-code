import { describe, expect, test } from "bun:test"
import { parseGoalPlanFile, GOAL_PLAN_FILE } from "../../src/deepagent/goal-plan-file"

const SID = "ses_test"

describe("parseGoalPlanFile", () => {
  test("well-formed file → objective, steps, criteria", () => {
    const md = `# Goal + Plan

## Goal
Migrate the auth service to the new token format.

## Criteria
- tests pass: \`bun test\`
- no diagnostics above warning
- panel approves

## Plan
- [x] Read the current auth flow
- [>] Introduce the new token codec — acceptance: unit tests for codec pass
- [ ] Swap the verifier over
- [ ] Delete the legacy path
`
    const parsed = parseGoalPlanFile(SID, md)
    expect(parsed).not.toBeNull()
    expect(parsed!.plan.goal).toBe("Migrate the auth service to the new token format.")
    expect(parsed!.plan.session_id).toBe(SID)
    expect(parsed!.plan.steps).toHaveLength(4)

    expect(parsed!.plan.steps[0]).toMatchObject({ step_id: "step_1", title: "Read the current auth flow", status: "done" })
    expect(parsed!.plan.steps[1]).toMatchObject({
      step_id: "step_2",
      title: "Introduce the new token codec",
      status: "active",
      acceptance: "unit tests for codec pass",
    })
    expect(parsed!.plan.steps[2].status).toBe("pending")
    expect(parsed!.plan.steps[3].status).toBe("pending")
    // active_step_id derives from the active step (createPlanDoc).
    expect(parsed!.plan.active_step_id).toBe("step_2")

    expect(parsed!.criteria).toEqual([
      { kind: "tests_pass", commands: ["bun test"] },
      { kind: "no_diagnostics", severityAtMost: "warning" },
      { kind: "panel_approves" },
    ])
  })

  test("checklist marks → statuses", () => {
    const md = `## Goal
Do the thing.

## Plan
- [ ] pending step
- [x] done step
- [>] active step
- [-] cancelled step
- [!] blocked step
- plain bullet no checkbox
`
    const parsed = parseGoalPlanFile(SID, md)
    expect(parsed).not.toBeNull()
    const statuses = parsed!.plan.steps.map((s) => s.status)
    expect(statuses).toEqual(["pending", "done", "active", "cancelled", "blocked", "pending"])
  })

  test("missing criteria section → empty criteria (caller applies default)", () => {
    const md = `## Objective
Ship the feature.

## Plan
- [ ] step one
- [ ] step two
`
    const parsed = parseGoalPlanFile(SID, md)
    expect(parsed).not.toBeNull()
    expect(parsed!.criteria).toEqual([])
    expect(parsed!.plan.steps).toHaveLength(2)
  })

  test("heading aliases (Objective / Steps) are recognized", () => {
    const md = `## Objective
Refactor.

## Steps
- [ ] a
- [ ] b
`
    const parsed = parseGoalPlanFile(SID, md)
    expect(parsed).not.toBeNull()
    expect(parsed!.plan.goal).toBe("Refactor.")
    expect(parsed!.plan.steps).toHaveLength(2)
  })

  test("plan_complete / reviewer criteria mapping", () => {
    const md = `## Goal
G.

## Criteria
- all steps done
- reviewer clean
- something unrecognized here

## Plan
- [ ] x
`
    const parsed = parseGoalPlanFile(SID, md)
    expect(parsed!.criteria).toEqual([
      { kind: "plan_complete" },
      { kind: "reviewer_clean", maxSeverity: "high" },
    ])
  })

  test("empty string → null", () => {
    expect(parseGoalPlanFile(SID, "")).toBeNull()
    expect(parseGoalPlanFile(SID, "   \n  \n")).toBeNull()
  })

  test("no objective → null", () => {
    const md = `## Plan
- [ ] step
`
    expect(parseGoalPlanFile(SID, md)).toBeNull()
  })

  test("objective but no steps → null", () => {
    const md = `## Goal
Just a goal, no plan steps.
`
    expect(parseGoalPlanFile(SID, md)).toBeNull()
  })

  test("malformed / non-string input → null (never throws)", () => {
    // @ts-expect-error deliberately wrong type to prove totality
    expect(parseGoalPlanFile(SID, null)).toBeNull()
    // @ts-expect-error deliberately wrong type
    expect(parseGoalPlanFile(SID, undefined)).toBeNull()
    expect(parseGoalPlanFile(SID, "random prose with no headings at all")).toBeNull()
  })

  test("duplicate criteria are de-duplicated", () => {
    const md = `## Goal
G.

## Criteria
- panel approves
- panel approves

## Plan
- [ ] x
`
    const parsed = parseGoalPlanFile(SID, md)
    expect(parsed!.criteria).toEqual([{ kind: "panel_approves" }])
  })

  test("canonical path constant is stable", () => {
    expect(GOAL_PLAN_FILE).toBe(".deepagent-code/plans/goal+plan.md")
  })
})
