/**
 * FEAT-011 T3/T6 — FacadeActivity dispatcher tests.
 *
 * Covers: budget min-clamping + result bound (pure), goal delegation lifecycle (start/status/
 * result/control + lazy convergence settle), the partial-unique-index fail-closed admission
 * fence, delegation-failure settlement (active rows never linger without a runner), task/panel
 * runner-unavailable honesty (no fabricated control), panel stop + convergence via a fake
 * background-job surface, and the status list bound.
 */
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Database } from "@deepagent-code/core/database/database"
import { SessionFacadeActivityTable } from "@deepagent-code/core/deepagent/activity-authority.sql"
import { ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionTable } from "@deepagent-code/core/session/sql"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { GoalManager } from "@/session/goal-manager"
import { SessionID } from "@/session/schema"
import {
  applyResultBound,
  clampFacadeBudget,
  FACADE_POLICY_LIMITS,
  FacadeActivity,
  FacadeActivityConflict,
  FacadeActivityInvalidInput,
  FacadeActivityNotFound,
  FacadeActivityRunnerUnavailable,
  FacadeActivityUnsupportedControl,
} from "@/session/facade-activity"
import { testEffect } from "../lib/effect"

const database = Layer.mergeAll(Database.layerFromPath(":memory:"), CrossSpawnSpawner.defaultLayer)
const facadeLayer = Layer.effect(FacadeActivity.Service, FacadeActivity.build)

const parentSessionID = SessionID.make("ses_facade_parent")
const otherSessionID = SessionID.make("ses_facade_other")

// Seed the FK parents (session_facade_activity.parent_session_id references session.id).
const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  for (const id of [parentSessionID, otherSessionID]) {
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: ProjectV2.ID.global,
        slug: `facade-${id}`,
        directory: "/project",
        title: "facade parent",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  }
})

const latestRow = (sessionID: SessionID, subkind: "task" | "goal" | "panel") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(SessionFacadeActivityTable)
      .where(eq(SessionFacadeActivityTable.parent_session_id, sessionID))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.filter((row) => row.subkind === subkind).at(-1)),
      )
  })

// ── fake GoalManager (records calls; phase is steerable per test) ─────────────────────────────

const goalFakeState: {
  phase: string
  started: Array<{ objective?: string; limits?: { maxTicks?: number; maxTokens?: number; maxWallclockMs?: number } }>
} = { phase: "running", started: [] }

const fakeGoals = {
  start: (input: { objective?: string; limits?: { maxTicks?: number; maxTokens?: number; maxWallclockMs?: number } }) =>
    Effect.sync(() => {
      goalFakeState.started.push(input)
      return { goalId: "goal_1", planDocId: "plan_1", phase: "running", running: true } as const
    }),
  pause: () => Effect.succeed(true),
  resume: () => Effect.succeed(true),
  stop: () => Effect.succeed(true),
  status: () =>
    Effect.succeed({ goalId: "goal_1", planDocId: "plan_1", phase: goalFakeState.phase, running: goalFakeState.phase === "running" }),
  startable: () => Effect.succeed({ startable: true, source: "plan" as const }),
  editPlan: () => Effect.die("unused in facade tests"),
} as unknown as GoalManager.Interface

const resetGoalFake = () => {
  goalFakeState.phase = "running"
  goalFakeState.started = []
}

// ── fake BackgroundJob (only the surface the panel branch touches) ─────────────────────────────

const panelJobs = new Map<string, { status: string }>()

const fakeBackground = {
  get: (id: string) => Effect.succeed(panelJobs.has(id) ? ({ id, status: panelJobs.get(id)!.status } as any) : undefined),
  cancel: (id: string) =>
    Effect.sync(() => {
      const job = panelJobs.get(id)
      if (!job || job.status !== "running") return undefined
      job.status = "cancelled"
      return { id, status: "cancelled" } as any
    }),
} as unknown as BackgroundJob.Interface

// ── layer variants ─────────────────────────────────────────────────────────────────────────────

const it = testEffect(facadeLayer.pipe(Layer.provideMerge(Layer.mergeAll(database, RuntimeFlags.layer({})))))
const itGoal = testEffect(
  facadeLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(database, RuntimeFlags.layer({}), Layer.succeed(GoalManager.Service, fakeGoals))),
  ),
)
const itPanel = testEffect(
  facadeLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(database, RuntimeFlags.layer({}), Layer.succeed(BackgroundJob.Service, fakeBackground)),
    ),
  ),
)
const itDurable = testEffect(
  facadeLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(database, RuntimeFlags.layer({ subagentControlPlane: "durable" }))),
  ),
)

describe("facade-activity.budget", () => {
  it.effect("clamps model limits with min against the policy ceiling", () =>
    Effect.gen(function* () {
      // No request ⇒ the ceiling itself (never looser, never invented tighter).
      expect(clampFacadeBudget()).toEqual(FACADE_POLICY_LIMITS)
      // Oversized request ⇒ clamped down to the ceiling.
      expect(
        clampFacadeBudget({ maxTicks: 999_999, maxTokens: 999_999_999, maxWallclockMs: Number.MAX_SAFE_INTEGER }),
      ).toEqual(FACADE_POLICY_LIMITS)
      // Tighter request ⇒ kept verbatim (floor semantics).
      expect(clampFacadeBudget({ maxTicks: 3, maxTokens: 1000, maxWallclockMs: 5000 })).toEqual({
        maxTicks: 3,
        maxTokens: 1000,
        maxWallclockMs: 5000,
      })
      // Invalid fields (0/negative/NaN/non-integral) fall back to the ceiling per field.
      expect(clampFacadeBudget({ maxTicks: 0, maxTokens: -5, maxWallclockMs: Number.NaN })).toEqual(
        FACADE_POLICY_LIMITS,
      )
      expect(clampFacadeBudget({ maxTicks: 7.9 }).maxTicks).toBe(7)
    }),
  )

  it.effect("applyResultBound truncates code-point-safely with a marker", () =>
    Effect.gen(function* () {
      expect(applyResultBound("short", 10)).toEqual({ text: "short", truncated: false })
      const bounded = applyResultBound("a".repeat(50), 10)
      expect(bounded.truncated).toBe(true)
      expect(bounded.text.endsWith("…[truncated]")).toBe(true)
      expect(Array.from(bounded.text.replace("…[truncated]", "")).length).toBe(10)
      // Never splits a surrogate pair: bound between the two units of one code point.
      const emoji = "😀".repeat(5) // 5 astral chars = 10 utf16 units
      const pair = applyResultBound(emoji, 3)
      expect(pair.truncated).toBe(true)
      expect(pair.text.startsWith("😀😀😀")).toBe(true)
    }),
  )
})

describe("facade-activity.goal delegation", () => {
  itGoal.instance("start writes the active row, min-clamps the budget, and returns the goal ref", () =>
    Effect.gen(function* () {
      resetGoalFake()
      yield* setup
      const facade = yield* FacadeActivity.Service
      const started = yield* facade.start({
        sessionID: parentSessionID,
        subkind: "goal",
        objective: "make the widget green",
        budget: { maxTicks: 999_999, maxTokens: 42 },
      })
      expect(started.subkind).toBe("goal")
      expect(started.ref.goalID).toBe("goal_1")
      expect(started.budget).toEqual({
        maxTicks: FACADE_POLICY_LIMITS.maxTicks,
        maxTokens: 42,
        maxWallclockMs: FACADE_POLICY_LIMITS.maxWallclockMs,
      })
      // The delegated GoalManager.start received the CLAMPED limits (min semantics).
      expect(goalFakeState.started).toHaveLength(1)
      expect(goalFakeState.started[0]!.limits).toEqual(started.budget)

      const row = yield* latestRow(parentSessionID, "goal")
      expect(row?.state).toBe("active")
      expect(row?.objective_text).toBe("make the widget green")
      expect(row?.source).toBe("activity_facade")
    }),
  )

  itGoal.instance("fail-closed: a second active goal facade for the same session is refused", () =>
    Effect.gen(function* () {
      resetGoalFake()
      yield* setup
      const facade = yield* FacadeActivity.Service
      yield* facade.start({ sessionID: parentSessionID, subkind: "goal", objective: "first" })
      const second = yield* facade
        .start({ sessionID: parentSessionID, subkind: "goal", objective: "second" })
        .pipe(Effect.flip)
      expect(second).toBeInstanceOf(FacadeActivityConflict)
      // A DIFFERENT session is unaffected by the per-session fence.
      yield* facade.start({ sessionID: otherSessionID, subkind: "goal", objective: "other session" })
    }),
  )

  itGoal.instance("status/result stay bounded while active; terminal phase converges via settle", () =>
    Effect.gen(function* () {
      resetGoalFake()
      yield* setup
      const facade = yield* FacadeActivity.Service
      const started = yield* facade.start({ sessionID: parentSessionID, subkind: "goal", objective: "long goal" })

      // While running: status is active with the goal ref; result refuses the terminal projection.
      const active = yield* facade.status({ sessionID: parentSessionID })
      expect(active).toHaveLength(1)
      expect(active[0]!.state).toBe("active")
      expect(active[0]!.ref.goalID).toBe("goal_1")
      const pending = yield* facade.result({ sessionID: parentSessionID, subkind: "goal" })
      expect(pending.terminal).toBe(false)
      expect(pending.state).toBe("active")

      // control delegates pause/resume/stop to GoalManager.
      expect((yield* facade.control({ sessionID: parentSessionID, subkind: "goal", action: "pause" })).applied).toBe(true)
      expect((yield* facade.control({ sessionID: parentSessionID, subkind: "goal", action: "resume" })).applied).toBe(true)

      // steer without a message fails closed (and no steer buffer exists in this graph).
      const noMessage = yield* facade
        .control({ sessionID: parentSessionID, subkind: "goal", action: "steer" })
        .pipe(Effect.flip)
      expect(noMessage).toBeInstanceOf(FacadeActivityInvalidInput)
      const steer = yield* facade
        .control({ sessionID: parentSessionID, subkind: "goal", action: "steer", message: "go left" })
        .pipe(Effect.flip)
      expect(steer).toBeInstanceOf(FacadeActivityRunnerUnavailable)

      // The domain reaches a terminal phase → the next touch settles the facade row (authority).
      goalFakeState.phase = "done"
      expect((yield* facade.control({ sessionID: parentSessionID, subkind: "goal", action: "stop" })).applied).toBe(true)
      const settled = yield* facade.status({ sessionID: parentSessionID })
      expect(settled[0]!.state).toBe("settled")
      expect(settled[0]!.reason).toBe("goal_done")

      // T6: the result now projects ONLY the terminal view.
      const projection = yield* facade.result({ sessionID: parentSessionID, subkind: "goal" })
      expect(projection.terminal).toBe(true)
      expect(projection.state).toBe("settled")
      expect(projection.phase).toBe("done")
      expect(projection.activityID).toBe(started.activityID)

      // A settled facade frees the unique index: a new goal start is admitted again.
      const restarted = yield* facade.start({ sessionID: parentSessionID, subkind: "goal", objective: "next" })
      expect(restarted.activityID).not.toBe(started.activityID)
    }),
  )

  itGoal.instance("result for a session without a facade activity fails NotFound", () =>
    Effect.gen(function* () {
      resetGoalFake()
      yield* setup
      const facade = yield* FacadeActivity.Service
      const error = yield* facade.result({ sessionID: otherSessionID, subkind: "task" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(FacadeActivityNotFound)
      const controlError = yield* facade
        .control({ sessionID: otherSessionID, subkind: "goal", action: "stop" })
        .pipe(Effect.flip)
      expect(controlError).toBeInstanceOf(FacadeActivityNotFound)
    }),
  )
})

describe("facade-activity.runner honesty (no fabricated runners)", () => {
  it.instance("goal start without GoalManager settles the admitted row as failed (no lingering active)", () =>
    Effect.gen(function* () {
      yield* setup
      const facade = yield* FacadeActivity.Service
      const error = yield* facade.start({ sessionID: parentSessionID, subkind: "goal", objective: "x" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(FacadeActivityRunnerUnavailable)
      // Delegation failure must settle the freshly-admitted row — an orphan active row would
      // block the unique index forever.
      const row = yield* latestRow(parentSessionID, "goal")
      expect(row?.state).toBe("failed")
      expect(row?.reason_code?.startsWith("start_failed:")).toBe(true)
      // …and the failed row must NOT block a retry (fail-closed applies to ACTIVE rows only).
      const retry = yield* facade.start({ sessionID: parentSessionID, subkind: "goal", objective: "y" }).pipe(Effect.flip)
      expect(retry).toBeInstanceOf(FacadeActivityRunnerUnavailable)
    }),
  )

  it.instance("empty objective is rejected before any row is written", () =>
    Effect.gen(function* () {
      yield* setup
      const facade = yield* FacadeActivity.Service
      const error = yield* facade.start({ sessionID: parentSessionID, subkind: "goal", objective: "   " }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(FacadeActivityInvalidInput)
      expect(yield* latestRow(parentSessionID, "goal")).toBeUndefined()
    }),
  )

  it.instance("task start refuses unless the durable control plane is enabled", () =>
    Effect.gen(function* () {
      yield* setup
      const facade = yield* FacadeActivity.Service
      const error = yield* facade.start({ sessionID: parentSessionID, subkind: "task", objective: "x" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(FacadeActivityRunnerUnavailable)
      expect((error as FacadeActivityRunnerUnavailable).reason).toContain("durable")
    }),
  )

  itDurable.instance("task start under durable still refuses without session/agent/provider services", () =>
    Effect.gen(function* () {
      yield* setup
      const facade = yield* FacadeActivity.Service
      const error = yield* facade.start({ sessionID: parentSessionID, subkind: "task", objective: "x" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(FacadeActivityRunnerUnavailable)
      const row = yield* latestRow(parentSessionID, "task")
      expect(row?.state).toBe("failed")
    }),
  )

  it.instance("panel start refuses without its runner dependencies", () =>
    Effect.gen(function* () {
      yield* setup
      const facade = yield* FacadeActivity.Service
      const error = yield* facade.start({ sessionID: parentSessionID, subkind: "panel", objective: "x" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(FacadeActivityRunnerUnavailable)
    }),
  )

  it.instance("task/panel pause+resume are NOT fabricated — only stop is delegated", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      // Seed settled rows so control() finds a latest facade per subkind.
      const now = Date.now()
      for (const [index, subkind] of ["task", "panel"].entries()) {
        yield* db
          .insert(SessionFacadeActivityTable)
          .values({
            activity_id: `job_seed_${subkind}`,
            subkind: subkind as "task" | "panel",
            parent_session_id: parentSessionID,
            objective_text: `seed ${subkind}`,
            budget_json: clampFacadeBudget(),
            state: "active",
            source: "test",
            created_at: now + index,
            mutation_epoch: 0,
          })
          .run()
          .pipe(Effect.orDie)
      }
      const facade = yield* FacadeActivity.Service
      for (const subkind of ["task", "panel"] as const) {
        for (const action of ["pause", "resume", "steer"] as const) {
          const error = yield* facade.control({ sessionID: parentSessionID, subkind, action }).pipe(Effect.flip)
          expect(error).toBeInstanceOf(FacadeActivityUnsupportedControl)
        }
      }
    }),
  )
})

describe("facade-activity.panel stop + convergence", () => {
  itPanel.instance("panel stop cancels the job and converges the facade row to interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const activityID = "job_panel_test"
      yield* db
        .insert(SessionFacadeActivityTable)
        .values({
          activity_id: activityID,
          subkind: "panel",
          parent_session_id: parentSessionID,
          objective_text: "which design should we take?",
          budget_json: clampFacadeBudget(),
          state: "active",
          source: "activity_facade",
          created_at: Date.now(),
          mutation_epoch: 0,
        })
        .run()
        .pipe(Effect.orDie)
      panelJobs.set(activityID, { status: "running" })

      const facade = yield* FacadeActivity.Service
      const outcome = yield* facade.control({ sessionID: parentSessionID, subkind: "panel", action: "stop" })
      expect(outcome.applied).toBe(true)

      const rows = yield* facade.status({ sessionID: parentSessionID, subkind: "panel" })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.state).toBe("interrupted")
      expect(rows[0]!.reason).toBe("panel_cancelled")

      const projection = yield* facade.result({ sessionID: parentSessionID, subkind: "panel" })
      expect(projection.terminal).toBe(true)
      expect(projection.state).toBe("interrupted")
      panelJobs.clear()
    }),
  )

  itPanel.instance("panel stop without a running job reports applied=false but still converges if terminal", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const activityID = "job_panel_idle"
      yield* db
        .insert(SessionFacadeActivityTable)
        .values({
          activity_id: activityID,
          subkind: "panel",
          parent_session_id: parentSessionID,
          objective_text: "idle panel",
          budget_json: clampFacadeBudget(),
          state: "active",
          source: "activity_facade",
          created_at: Date.now(),
          mutation_epoch: 0,
        })
        .run()
        .pipe(Effect.orDie)
      // No job registered at all: cancel is a no-op, convergence keeps the row active.
      panelJobs.clear()
      const facade = yield* FacadeActivity.Service
      const outcome = yield* facade.control({ sessionID: parentSessionID, subkind: "panel", action: "stop" })
      expect(outcome.applied).toBe(false)
      const rows = yield* facade.status({ sessionID: parentSessionID, subkind: "panel" })
      expect(rows[0]!.state).toBe("active")
    }),
  )
})

describe("facade-activity.status bound", () => {
  it.instance("status never returns more than the ceiling and honors the requested limit", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const now = Date.now()
      for (let index = 0; index < 25; index++) {
        yield* db
          .insert(SessionFacadeActivityTable)
          .values({
            activity_id: `job_bound_${index}`,
            subkind: "goal",
            parent_session_id: parentSessionID,
            objective_text: `objective ${index}`,
            budget_json: clampFacadeBudget(),
            state: "failed",
            reason_code: "start_failed:test",
            source: "test",
            created_at: now + index,
            settled_at: now + index,
            mutation_epoch: 1,
          })
          .run()
          .pipe(Effect.orDie)
      }
      const facade = yield* FacadeActivity.Service
      const capped = yield* facade.status({ sessionID: parentSessionID, limit: 99 })
      expect(capped).toHaveLength(20)
      const bounded = yield* facade.status({ sessionID: parentSessionID, limit: 3 })
      expect(bounded).toHaveLength(3)
      // Newest first.
      expect(bounded[0]!.activityID).toBe("job_bound_24")
    }),
  )
})
