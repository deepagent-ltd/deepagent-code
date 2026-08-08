import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import * as PlanStore from "../../src/deepagent/plan-store"
import * as SessionState from "../../src/deepagent/session-state"
import { DocumentStore } from "../../src/deepagent/document-store"
import {
  createPlanDoc,
  PlanConflictError,
  PlanValidationError,
  type PlanDoc,
  type PlanStep,
} from "../../src/deepagent/plan-controller"

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

  test("round-trips for a REALISTIC session id (slugify mangles the id — resolve by type+scope)", () => {
    // Regression: the doc id is allocated via slugify(idSlug) (lowercase, `_`→`-`, truncate 48), so a
    // raw `doc:plan:plan-<sid>` reconstruction misses for real ids. A production session id has
    // underscores + a uuid and exceeds 48 chars — getPlanDoc must still resolve it.
    const sid = `ses_planstatus_render_${"a".repeat(20)}_0123456789abcdef`
    const p = plan(sid, [step("step_1", "active"), step("step_2")])
    PlanStore.setPlanDoc(sid, p)
    const read = PlanStore.getPlanDoc(sid)
    expect(read).not.toBeNull()
    expect(read?.steps[0].status).toBe("active")
    expect(PlanStore.planDocRef(sid)?.version).toBe(1)
  })

  test("identical body is an INV-4 no-op (no version bump); a change appends a version", () => {
    const p = plan("s2", [step("step_1")])
    expect(PlanStore.setPlanDoc("s2", p).version).toBe(1)
    expect(PlanStore.setPlanDoc("s2", p).version).toBe(1) // unchanged -> no-op
    const changed = plan("s2", [step("step_1", "done")])
    expect(PlanStore.setPlanDoc("s2", changed).version).toBe(2)
    expect(PlanStore.getPlanDoc("s2")?.steps[0].status).toBe("done")
  })

  test("compareAndCommitPlan enforces a logical version precondition", () => {
    const sid = "s_cas"
    const first = plan(sid, [step("step_1")])
    const created = PlanStore.compareAndCommitPlan({ sessionId: sid, expected: null, candidate: first, origin: "model_tool" })
    expect(created.version).toBe(1)
    const expected = { plan_id: first.plan_id, doc_id: created.doc_id, version: created.version }
    const second = { ...first, steps: [{ ...first.steps[0], status: "done" as const }] }
    const committed = PlanStore.compareAndCommitPlan({ sessionId: sid, expected, candidate: second, origin: "model_tool" })
    expect(committed.version).toBe(2)
    expect(() =>
      PlanStore.compareAndCommitPlan({
        sessionId: sid,
        expected,
        candidate: { ...second, goal: "stale writer" },
        origin: "model_tool",
      }),
    ).toThrow(PlanConflictError)
    expect(PlanStore.planDocRef(sid)?.version).toBe(2)
  })

  test("compareAndCommitPlan refuses to overwrite an existing malformed authority", () => {
    const sid = "s_malformed"
    const authority = DocumentStore.shared(PlanStore.planStoreRoot(sid))
    authority.upsert({
      type: "plan",
      scope: PlanStore.planScope(sid),
      description: PlanStore.planDescription(sid),
      idSlug: `plan-${sid}`,
      body: "{not-json",
      provenance: { source: "model", run_ref: PlanStore.planScope(sid) },
    })
    expect(() =>
      PlanStore.compareAndCommitPlan({
        sessionId: sid,
        expected: null,
        candidate: plan(sid, [step("step_1")]),
        origin: "legacy_migration",
      }),
    ).toThrow(PlanValidationError)
    expect(authority.list({ type: "plan", scope: PlanStore.planScope(sid) })).toHaveLength(1)
  })

  test("compareAndCommitPlan refuses parseable authorities that violate PlanDoc invariants", () => {
    const fixtures = [
      (value: PlanDoc): unknown => ({ ...value, steps: [] }),
      (value: PlanDoc): unknown => ({ ...value, steps: [{ ...value.steps[0], status: "unknown" }] }),
      (value: PlanDoc): unknown => ({ ...value, active_step_id: value.steps[0]!.step_id }),
    ]

    fixtures.forEach((malform, index) => {
      const sid = `s_malformed_shape_${index}`
      const authority = DocumentStore.shared(PlanStore.planStoreRoot(sid))
      const malformed = malform(plan(sid, [step("step_1")]))
      const stored = authority.upsert({
        type: "plan",
        scope: PlanStore.planScope(sid),
        description: PlanStore.planDescription(sid),
        idSlug: `plan-${sid}`,
        body: JSON.stringify(malformed),
        provenance: { source: "model", run_ref: PlanStore.planScope(sid) },
      })

      expect(PlanStore.getPlanDoc(sid)).toBeNull()
      expect(() =>
        PlanStore.compareAndCommitPlan({
          sessionId: sid,
          expected: null,
          candidate: plan(sid, [step("replacement")]),
          origin: "legacy_migration",
        }),
      ).toThrow(PlanValidationError)
      expect(authority.get(stored.id)?.body).toBe(JSON.stringify(malformed))
      expect(authority.get(stored.id)?.version).toBe(1)
    })
  })

  test("compareAndCommitPlan validates the candidate at the CAS boundary", () => {
    const sid = "s_invalid_candidate"
    const malformed = { ...plan(sid, [step("step_1")]), steps: [] } as PlanDoc
    expect(() =>
      PlanStore.compareAndCommitPlan({
        sessionId: sid,
        expected: null,
        candidate: malformed,
        origin: "runtime_goal_bridge",
      }),
    ).toThrow(PlanValidationError)
    expect(DocumentStore.shared(PlanStore.planStoreRoot(sid)).list({ type: "plan" })).toHaveLength(0)

    expect(() =>
      PlanStore.compareAndCommitPlan({
        sessionId: sid,
        expected: null,
        candidate: { ...plan(sid, [step("step_1")]), session_id: "another-session" },
        origin: "runtime_goal_bridge",
      }),
    ).toThrow(PlanValidationError)
    expect(DocumentStore.shared(PlanStore.planStoreRoot(sid)).list({ type: "plan" })).toHaveLength(0)
  })

  test("session-state.setPlan/getPlan delegate to the store (body NOT on session state)", async () => {
    SessionState.getOrCreate("s3", "high")
    const p = plan("s3", [step("step_1")])
    SessionState.setPlan("s3", p)
    // saveToDisk() is debounced via setImmediate (PERF, c0b79979): yield one event-loop turn so
    // flushToDisk lands sessions.json before the synchronous read below.
    await new Promise((resolve) => setImmediate(resolve))
    // readable via session-state (delegates to plan-store) AND directly from plan-store (same doc)
    expect(SessionState.getPlan("s3")?.goal).toBe("goal s3")
    expect(PlanStore.getPlanDoc("s3")?.goal).toBe("goal s3")
    // the latch pointer is bound to the plan id (the hot-path value object that STAYS on session state)
    expect(SessionState.planLatch("s3")?.plan_id).toBe(p.plan_id)
    // the persisted sessions.json must NOT carry the plan body (authority moved to the store)
    const raw = readFileSync(path.join(stateDir, "sessions.json"), "utf8")
    expect(JSON.parse(raw)["s3"].plan).toBeUndefined()
  })

  test("plan-store root equals the goal store root (tool path and goal path converge on one doc)", () => {
    // goal-manager.goalStoreRoot(sid) === <stateDir>/goal/<sid>/graph — plan-store must match exactly,
    // so materializePlanDoc (goal) and setPlanDoc (tool) upsert the SAME doc id.
    expect(PlanStore.planStoreRoot("s4")).toBe(path.join(stateDir, "goal", "s4", "graph"))
  })

  test("goal path and tool path converge on ONE doc (realistic id; no plan-<sid>-2 split)", () => {
    // Regression for the P0 the adversarial review found: upsert() dedups on `description`, so the goal
    // path (goal-driver.materializePlanDoc) and the tool path (setPlanDoc) MUST use the identical doc
    // identity — type/scope/idSlug AND description — or upsert creates a SECOND doc (plan-<sid>-2) and
    // getPlan (list[0]) returns whichever is first, re-splitting the store. This replicates the goal
    // path's write FAITHFULLY using the shared identity helpers (planDescription/planScope) — the same
    // ones goal-driver now imports — with a realistic session id (the earlier test masked the bug by
    // hand-rolling "session plan s5" and using a trivial id).
    const sid = `ses_goal_conv_${"z".repeat(24)}_beef`
    const goalRoot = path.join(stateDir, "goal", sid, "graph")
    const goalHandle = DocumentStore.shared(goalRoot)
    // Goal-path write (must match plan-store identity exactly):
    goalHandle.upsert({
      type: "plan",
      scope: PlanStore.planScope(sid),
      description: PlanStore.planDescription(sid),
      idSlug: `plan-${sid}`,
      body: JSON.stringify(plan(sid, [step("step_1", "active")])),
      provenance: { source: "model", run_ref: PlanStore.planScope(sid) },
    })
    expect(PlanStore.getPlanDoc(sid)?.steps[0].status).toBe("active")
    // Tool-path write lands on the SAME doc (new version), NOT a second doc.
    SessionState.getOrCreate(sid, "high")
    SessionState.setPlan(sid, plan(sid, [step("step_1", "done")]))
    expect(PlanStore.getPlanDoc(sid)?.steps[0].status).toBe("done")
    // Exactly ONE plan doc exists under this session's root (no plan-<sid>-2 split).
    const planDocs = DocumentStore.shared(goalRoot).list({ type: "plan", scope: PlanStore.planScope(sid) })
    expect(planDocs.length).toBe(1)
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

  test("legacy migration rejects a malformed inline plan instead of making it authoritative", () => {
    const malformed = { ...plan("s8", [step("step_1")]), steps: [] }
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      path.join(stateDir, "sessions.json"),
      JSON.stringify({
        s8: {
          sessionId: "s8",
          mode: "high",
          completedAt: null,
          planLatch: {
            plan_id: malformed.plan_id,
            latch: "fresh",
            stale_reason: null,
            replan_count: 0,
            consecutive_blocks: 0,
          },
          plan: malformed,
        },
      }),
    )
    DocumentStore.__resetSharedRegistryForTests()
    SessionState.configure(stateDir)
    expect(PlanStore.getPlanDoc("s8")).toBeNull()
    expect(SessionState.getPlan("s8")).toBeNull()
    const diagnostics = DocumentStore.shared(PlanStore.planStoreRoot("s8")).list({
      type: "diagnosis",
      scope: PlanStore.planScope("s8"),
      status: "quarantined",
    })
    expect(diagnostics).toHaveLength(1)
    expect(JSON.parse(DocumentStore.shared(PlanStore.planStoreRoot("s8")).get(diagnostics[0]!.id)!.body)).toMatchObject({
      kind: "legacy_plan_migration",
      session_id: "s8",
      plan_id: malformed.plan_id,
      code: "empty_steps",
    })
  })
})
