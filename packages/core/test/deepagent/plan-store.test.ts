import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as PlanStore from "../../src/deepagent/plan-store"
import * as SessionState from "../../src/deepagent/session-state"
import { DocumentStore } from "../../src/deepagent/document-store"
import { createPlanDoc, type PlanDoc, type PlanStep } from "../../src/deepagent/plan-controller"

// I33-1 (deepagentcore-v4.0.3): the DocumentStore `type:"plan"` doc is the SINGLE structural authority
// for a session's plan. session-state.setPlan/getPlan delegate to plan-store; the goal path writes the
// same doc (same root + slug). These tests pin that single-authority contract + the legacy migration.

let stateDir: string
const step = (id: string, status: PlanStep["status"] = "pending"): PlanStep => ({
  step_id: id,
  title: `step ${id}`,
  status,
  acceptance: null,
  assigned_agent: null,
  evidence: [],
  note: null,
})
const plan = (sid: string, steps: PlanStep[]): PlanDoc => createPlanDoc(sid, `goal ${sid}`, steps)

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "deepagent-planstore-"))
  SessionState.configure(stateDir) // also configures plan-store root (I33-1 coupling)
})
afterEach(() => {
  DocumentStore.__resetSharedRegistryForTests()
  rmSync(stateDir, { recursive: true, force: true })
})

describe("I33-1 plan-store single authority", () => {
  test("setPlanDoc/getPlanDoc round-trip through the DocumentStore", () => {
    expect(PlanStore.getPlanDoc("s1")).toBeNull()
    const p = plan("s1", [step("step_1"), step("step_2")])
    const ref = PlanStore.setPlanDoc("s1", p)
    expect(ref.version).toBe(1)
    const read = PlanStore.getPlanDoc("s1")
    expect(read?.goal).toBe("goal s1")
    expect(read?.steps.map((s) => s.step_id)).toEqual(["step_1", "step_2"])
  })

  test("identical body is an INV-4 no-op (no version bump); a change appends a version", () => {
    const p = plan("s2", [step("step_1")])
    expect(PlanStore.setPlanDoc("s2", p).version).toBe(1)
    expect(PlanStore.setPlanDoc("s2", p).version).toBe(1) // unchanged -> no-op
    const changed = plan("s2", [step("step_1", "done")])
    expect(PlanStore.setPlanDoc("s2", changed).version).toBe(2)
    expect(PlanStore.getPlanDoc("s2")?.steps[0].status).toBe("done")
  })

  test("session-state.setPlan/getPlan delegate to the store (body NOT on session state)", () => {
    SessionState.getOrCreate("s3", "high")
    const p = plan("s3", [step("step_1")])
    SessionState.setPlan("s3", p)
    // readable via session-state (delegates to plan-store) AND directly from plan-store (same doc)
    expect(SessionState.getPlan("s3")?.goal).toBe("goal s3")
    expect(PlanStore.getPlanDoc("s3")?.goal).toBe("goal s3")
    // the latch pointer is bound to the plan id (the hot-path value object that STAYS on session state)
    expect(SessionState.planLatch("s3")?.plan_id).toBe(p.plan_id)
    // the persisted sessions.json must NOT carry the plan body (authority moved to the store)
    const raw = require("node:fs").readFileSync(path.join(stateDir, "sessions.json"), "utf8")
    expect(JSON.parse(raw)["s3"].plan).toBeUndefined()
  })

  test("plan-store root equals the goal store root (tool path and goal path converge on one doc)", () => {
    // goal-manager.goalStoreRoot(sid) === <stateDir>/goal/<sid>/graph — plan-store must match exactly,
    // so materializePlanDoc (goal) and setPlanDoc (tool) upsert the SAME doc id.
    expect(PlanStore.planStoreRoot("s4")).toBe(path.join(stateDir, "goal", "s4", "graph"))
  })

  test("a plan written via a goal-style handle is read back by the tool path (single doc)", () => {
    // Simulate the goal path: write the SAME doc identity (type plan, scope run:<sid>, slug plan-<sid>)
    // through a shared handle at the goal root, then read it via the tool path (plan-store). One doc.
    const goalRoot = path.join(stateDir, "goal", "s5", "graph")
    const goalHandle = DocumentStore.shared(goalRoot)
    goalHandle.upsert({
      type: "plan",
      scope: "run:s5",
      description: "session plan s5",
      idSlug: "plan-s5",
      body: JSON.stringify(plan("s5", [step("step_1", "active")])),
      provenance: { source: "model", run_ref: "run:s5" },
    })
    // The tool path (plan-store, shared handle on the SAME root) sees the goal's write immediately.
    expect(PlanStore.getPlanDoc("s5")?.steps[0].status).toBe("active")
    // And a subsequent tool write is visible to the goal handle (bidirectional single authority).
    SessionState.getOrCreate("s5", "high")
    SessionState.setPlan("s5", plan("s5", [step("step_1", "done")]))
    const fromGoal = goalHandle.get("doc:plan:plan-s5")
    expect((JSON.parse(fromGoal!.body) as PlanDoc).steps[0].status).toBe("done")
  })

  test("legacy inline plan on sessions.json is migrated into the store on load", () => {
    // Write a pre-I33-1 sessions.json that still carries the structural plan body inline.
    const legacyPlan = plan("s6", [step("step_1"), step("step_2", "done")])
    const legacy = {
      s6: {
        sessionId: "s6",
        mode: "high",
        completedAt: null,
        planLatch: { plan_id: legacyPlan.plan_id, latch: "fresh", stale_reason: null, replan_count: 0, consecutive_blocks: 0 },
        plan: legacyPlan, // the legacy inline body
      },
    }
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path.join(stateDir, "sessions.json"), JSON.stringify(legacy))
    DocumentStore.__resetSharedRegistryForTests()
    // Re-configure to trigger loadFromDisk (which runs the migration).
    SessionState.configure(stateDir)
    // The plan body is now readable from the store authority...
    expect(PlanStore.getPlanDoc("s6")?.steps.map((s) => s.status)).toEqual(["pending", "done"])
    // ...and getPlan (delegating to the store) returns it.
    expect(SessionState.getPlan("s6")?.plan_id).toBe(legacyPlan.plan_id)
  })

  test("migration does not clobber a newer store doc (e.g. a goal edit) with a stale inline body", () => {
    // Seed a NEWER plan into the store first (as a goal edit would), THEN load a legacy sessions.json
    // whose inline body is older. The migration must NOT overwrite the newer store doc.
    const newer = plan("s7", [step("step_1", "done")])
    PlanStore.setPlanDoc("s7", newer)
    const legacyOlder = plan("s7", [step("step_1", "pending")])
    const legacy = {
      s7: {
        sessionId: "s7",
        mode: "high",
        completedAt: null,
        planLatch: { plan_id: legacyOlder.plan_id, latch: "fresh", stale_reason: null, replan_count: 0, consecutive_blocks: 0 },
        plan: legacyOlder,
      },
    }
    writeFileSync(path.join(stateDir, "sessions.json"), JSON.stringify(legacy))
    SessionState.configure(stateDir) // load; migration sees the store already has a plan -> skips
    expect(PlanStore.getPlanDoc("s7")?.steps[0].status).toBe("done") // newer store doc preserved
  })
})
