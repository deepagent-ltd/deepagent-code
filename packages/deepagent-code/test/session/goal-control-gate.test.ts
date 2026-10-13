import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DocumentStore } from "@deepagent-code/core/deepagent/document-store"
import { initializeGoal } from "@deepagent-code/core/deepagent/goal-loop"
import { createPlanDoc, planScope } from "@deepagent-code/core/deepagent/plan-controller"
import { Hash } from "@deepagent-code/core/util/hash"
import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@deepagent-code/core/database/database"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalControlSchema } from "@deepagent-code/core/deepagent/goal-control.schema"
import { GoalControlFixture } from "../../../core/test/fixture/goal-control"
import { GoalWorkBoundaryFixture } from "../fixture/goal-work-boundary"
import { makeGoalTickPort, type GoalTickPortDeps } from "../../src/session/goal-tick-port"
import { testEffect } from "../lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

it.live(
  "actual cold port rejects bound Work roots and real descendants before issuing a permit or accessing dependencies",
  () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* GoalWorkBoundaryFixture.reserve(db, "bound-root")
      const root = yield* GoalControlFixture.activate(db, "bound-root")
      const child = yield* GoalControlFixture.activate(db, "bound-child")
      const grandchild = yield* GoalControlFixture.activate(db, "bound-grandchild")
      yield* db.run(sql`UPDATE session SET parent_id=${root.input.sessionID} WHERE id=${child.input.sessionID}`)
      yield* db.run(sql`UPDATE session SET parent_id=${child.input.sessionID} WHERE id=${grandchild.input.sessionID}`)
      const calls: string[] = []
      const port = makeGoalTickPort(
        new Proxy({ db } as GoalTickPortDeps, {
          get(target, key) {
            if (key === "db") return target.db
            calls.push(String(key))
            throw new Error(`Unexpected downstream access: ${String(key)}`)
          },
        }),
      )
      const outcomes = yield* Effect.forEach([root, child, grandchild], (setup) =>
        port(setup.tick).pipe(
          Effect.exit,
          Effect.map((exit) => {
            if (Exit.isSuccess(exit)) return "success"
            const error = Cause.squash(exit.cause)
            return error instanceof GoalControlSchema.Error ? error.code : "downstream_defect"
          }),
        ),
      )
      expect({
        outcomes,
        calls,
        permits: yield* db.all(sql`SELECT permit_id FROM goal_tick_permit`),
        inputs: yield* db.all(sql`SELECT id FROM session_input`),
        providers: yield* db.all(sql`SELECT attempt_id FROM session_provider_attempt`),
      }).toEqual({
        outcomes: ["unsupported", "unsupported", "unsupported"],
        calls: [],
        permits: [],
        inputs: [],
        providers: [],
      })
    }),
)

// The production port and real SQL authority are the subject. All expensive downstream services
// are tripwires, not a replacement tick implementation; even accessing one fails the oracle.
it.live("actual cold port rejects stale, paused, stopped and legacy ticks before any downstream access", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const setup = yield* GoalControlFixture.activate(db, "cold-gate")
    const calls: string[] = []
    const port = makeGoalTickPort(
      new Proxy({ db } as GoalTickPortDeps, {
        get(target, key) {
          if (key === "db") return target.db
          calls.push(String(key))
          throw new Error(`Unexpected downstream access: ${String(key)}`)
        },
      }),
    )
    expect(Exit.isFailure(yield* port({ ...setup.tick, revision: undefined }).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* port({ ...setup.tick, goalId: "old-goal" }).pipe(Effect.exit))).toBe(true)
    yield* GoalControl.control(db, {
      sessionID: setup.input.sessionID,
      goalId: setup.row.goal_id,
      expectedRevision: 1,
      requestID: "pause",
      action: "pause",
    })
    expect(Exit.isFailure(yield* port(setup.tick).pipe(Effect.exit))).toBe(true)
    expect(Exit.isFailure(yield* port({ ...setup.tick, revision: 2 }).pipe(Effect.exit))).toBe(true)
    yield* GoalControl.control(db, {
      sessionID: setup.input.sessionID,
      goalId: setup.row.goal_id,
      expectedRevision: 2,
      requestID: "stop",
      action: "stop",
    })
    expect(Exit.isFailure(yield* port({ ...setup.tick, revision: 3 }).pipe(Effect.exit))).toBe(true)
    expect(calls).toEqual([])
    expect(
      yield* db
        .get<{ count: number }>(sql`SELECT count(*) AS count FROM goal_tick_permit WHERE goal_id=${setup.row.goal_id}`)
        .pipe(Effect.orDie),
    ).toEqual({ count: 0 })
  }),
)

it.live("actual cold port fails closed on immutable binding, cursor and storage corruption", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const calls: string[] = []
    const port = makeGoalTickPort(
      new Proxy({ db } as GoalTickPortDeps, {
        get(target, key) {
          if (key === "db") return target.db
          calls.push(String(key))
          throw new Error(`Unexpected downstream access: ${String(key)}`)
        },
      }),
    )
    const cases = [
      sql`initialization=json_set(initialization,'$.spec.limits.maxTicks',99)`,
      sql`initialization=json_set(initialization,'$.model.modelID','changed')`,
      sql`driver_mode='resident'`,
      sql`directory='/tmp/other-goal-target'`,
      sql`next_seq=4`,
      sql`plan_version=7`,
    ]
    for (const [index, patch] of cases.entries()) {
      const setup = yield* GoalControlFixture.activate(db, `corrupt-${index}`)
      yield* db.run(sql`UPDATE goal_control SET ${patch} WHERE goal_id=${setup.row.goal_id}`).pipe(Effect.orDie)
      expect(
        Exit.isFailure(
          yield* port({
            ...setup.tick,
            ...(index === 4 ? { seq: 4 } : {}),
            ...(index === 5 ? { expectedPlanVersion: 7 } : {}),
          }).pipe(Effect.exit),
        ),
      ).toBe(true)
    }
    const placement = yield* GoalControlFixture.activate(db, "missing-placement")
    yield* db.run(sql`UPDATE session SET directory='' WHERE id=${placement.input.sessionID}`).pipe(Effect.orDie)
    expect(Exit.isFailure(yield* port(placement.tick).pipe(Effect.exit))).toBe(true)
    const unknown = yield* GoalControlFixture.activate(db, "unknown")
    yield* GoalControl.beginTick(db, unknown.tick)
    expect(Exit.isFailure(yield* port(unknown.tick).pipe(Effect.exit))).toBe(true)
    yield* db.run(sql`DROP TABLE goal_control_command`).pipe(Effect.orDie)
    yield* db.run(sql`DROP TABLE goal_tick_permit`).pipe(Effect.orDie)
    yield* db.run(sql`DROP TABLE goal_control`).pipe(Effect.orDie)
    expect(Exit.isFailure(yield* port(unknown.tick).pipe(Effect.exit))).toBe(true)
    expect(calls).toEqual([])
  }),
)

it.live("actual cold port quarantines a modified DocumentStore spec before wiring", () =>
  Effect.gen(function* () {
    const root = mkdtempSync(path.join(tmpdir(), "goal-control-state-"))
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true, force: true })))
    const db = (yield* Database.Service).db
    const source = yield* GoalControlFixture.prepare(db, "state-binding")
    yield* db.run(sql`DELETE FROM goal_control_command WHERE goal_id=${source.row.goal_id}`).pipe(Effect.orDie)
    yield* db.run(sql`DELETE FROM goal_control WHERE goal_id=${source.row.goal_id}`).pipe(Effect.orDie)
    const store = DocumentStore.shared(root)
    const plan = store.upsert({
      type: "plan",
      scope: planScope(source.input.sessionID),
      description: "State binding",
      idSlug: "plan",
      body: JSON.stringify(createPlanDoc(source.input.sessionID, "Done", [])),
      provenance: { source: "runner", run_ref: planScope(source.input.sessionID) },
    })
    const initialization = {
      ...source.input.initialization,
      spec: { ...source.input.initialization.spec, planDocId: plan.id },
      planVersion: plan.version,
      planHash: Hash.sha256(plan.body),
    }
    const input = { ...source.input, planDocId: plan.id, initialization }
    const prepared = yield* GoalControl.reserveStart(db, input)
    yield* initializeGoal({ store, now: () => 100, netTokenBudget: false }, initialization.spec, prepared.row.goal_id)
    yield* GoalControl.activate(db, { ...input, goalId: prepared.row.goal_id })
    const ref = store.list({ type: "run_context", scope: planScope(input.sessionID) })[0]!
    const state = JSON.parse(store.get(ref.id)!.body)
    store.update(
      ref.id,
      JSON.stringify({ ...state, spec: { ...state.spec, limits: { ...state.spec.limits, maxTicks: 99 } } }),
    )
    const accesses: string[] = []
    const port = makeGoalTickPort(
      new Proxy({ db } as GoalTickPortDeps, {
        get(target, key) {
          if (key === "db") return target.db
          if (key === "goalStoreRoot") return () => root
          accesses.push(String(key))
          throw new Error(`Unexpected downstream access: ${String(key)}`)
        },
      }),
    )
    expect(
      Exit.isFailure(
        yield* port({
          sessionID: input.sessionID,
          goalId: prepared.row.goal_id,
          planDocId: plan.id,
          seq: 0,
          expectedPlanVersion: plan.version,
          revision: 1,
        }).pipe(Effect.exit),
      ),
    ).toBe(true)
    expect(accesses).toEqual([])
    expect(
      yield* db.get(sql`SELECT state FROM goal_tick_permit WHERE goal_id=${prepared.row.goal_id}`).pipe(Effect.orDie),
    ).toEqual({ state: "unknown" })
  }),
)
