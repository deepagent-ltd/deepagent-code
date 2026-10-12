import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { DocumentStore } from "../../src/deepagent/document-store"
import { initializeGoal, readGoalTickCursor } from "../../src/deepagent/goal-loop"
import { createPlanDoc, planScope } from "../../src/deepagent/plan-controller"
import { GoalControlFixture } from "../fixture/goal-control"

test("stable initialization reopens the original GoalLoop record without resetting it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "goal-stable-initialization-"))
  try {
    const store = new DocumentStore(root)
    const plan = store.upsert({
      type: "plan",
      scope: planScope("ses_stable"),
      description: "Stable Goal",
      idSlug: "plan",
      body: JSON.stringify(createPlanDoc("ses_stable", "Done", [])),
      provenance: { source: "runner", run_ref: "run:ses_stable" },
    })
    const spec = { ...GoalControlFixture.initialization.spec, planDocId: plan.id }
    const first = await Effect.runPromise(
      initializeGoal({ store, now: () => 100, netTokenBudget: false }, spec, "goal_stable"),
    )
    const state = store.list({ type: "run_context", scope: planScope("ses_stable") })[0]!
    const original = store.get(state.id)!
    const cold = new DocumentStore(root)
    cold.rebuildIndex()
    const replay = await Effect.runPromise(
      initializeGoal({ store: cold, now: () => 9999, netTokenBudget: false }, spec, "goal_stable"),
    )
    expect(replay).toEqual(first)
    expect(cold.get(state.id)?.body).toBe(original.body)
    expect(cold.get(state.id)?.version).toBe(original.version)
    expect(readGoalTickCursor(cold, "ses_stable", "goal_stable")).toMatchObject({ seq: 0, phase: "running" })
    const conflict = await Effect.runPromise(
      initializeGoal(
        { store: cold, now: () => 9999, netTokenBudget: false },
        { ...spec, stallThreshold: 99 },
        "goal_stable",
      ).pipe(Effect.flip),
    )
    expect(conflict.reason).toContain("identity conflicts")
    expect(cold.get(state.id)?.body).toBe(original.body)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
