import { expect, test } from "bun:test"
import SQLite from "bun:sqlite"
import { Cause, Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { GoalChild } from "../../src/deepagent/goal-child"
import { GoalChildExecution } from "../../src/deepagent/goal-child-execution"
import { GoalChildSchema } from "../../src/deepagent/goal-child.schema"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { SessionSchema } from "../../src/session/schema"
import { SessionStore } from "../../src/session/store"
import { GoalChildFixture } from "../fixture/goal-child"

test("owned Started commits actual claim and input link, but drain success is not a Goal result", () =>
  GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const setup = yield* GoalChildFixture.prepare(directory)
      const child = yield* GoalChild.admit(db, yield* SessionV2.Service, setup.admission)
      const owned = yield* SessionExecution.requireOwned(yield* SessionExecution.Service)
      const run = yield* owned.run(GoalChildExecution.target(child.unit))
      if (run.status !== "started") throw new Error(run.status)
      const result = yield* owned.await(run.receipt)
      expect(result.status === "settled" && Exit.isSuccess(result.exit)).toBeTrue()
      const row = (yield* GoalChild.owner(db, child.unit.child_session_id))!
      expect(row.inputs[0].execution?.state).toBe("settled")
      expect(row.inputs[0].execution?.claimToken).toBeGreaterThan(0)
      expect(row.inputs[0].execution?.goalOwnerID).toBe(setup.permit.owner_id)
      expect(row.inputs[0].resultRef).toBeNull()
      expect(row.state).toBe("admitted")
      expect(state.runs).toBe(1)
      expect(
        yield* (yield* SessionStore.Service).claimToken(SessionSchema.ID.make(child.unit.child_session_id)),
      ).toBeUndefined()
      const retry = yield* owned.run(GoalChildExecution.target(row)).pipe(Effect.exit)
      expect(Exit.isFailure(retry)).toBeTrue()
      expect(state.runs).toBe(1)
    }),
  ))

test("actual Started transaction rolls back event and claim when the input-link write fails", () =>
  GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const setup = yield* GoalChildFixture.prepare(directory)
      const child = yield* GoalChild.admit(db, yield* SessionV2.Service, setup.admission)
      const before = yield* db.all(sql`SELECT * FROM event WHERE aggregate_id=${child.unit.child_session_id}`)
      yield* db.run(`CREATE TRIGGER reject_owned_link BEFORE UPDATE OF inputs ON goal_child_unit
      WHEN json_extract(NEW.inputs,'$[0].execution') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'owned link write rejected'); END`)
      const owned = yield* SessionExecution.requireOwned(yield* SessionExecution.Service)
      const run = yield* owned.run(GoalChildExecution.target(child.unit))
      if (run.status !== "started") throw new Error(run.status)
      const result = yield* owned.await(run.receipt)
      expect(result.status === "settled" && Exit.isFailure(result.exit)).toBeTrue()
      expect(yield* db.all(sql`SELECT * FROM event WHERE aggregate_id=${child.unit.child_session_id}`)).toEqual(before)
      expect((yield* GoalChild.owner(db, child.unit.child_session_id))?.inputs[0].execution).toBeUndefined()
      expect(
        yield* (yield* SessionStore.Service).claimToken(SessionSchema.ID.make(child.unit.child_session_id)),
      ).toBeUndefined()
      expect(state).toEqual({ locations: 0, runs: 0, shells: 0 })
    }),
  ))

test("registration throw settles the actual local owner with zero lifecycle, claim, or Location", () =>
  GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const setup = yield* GoalChildFixture.prepare(directory)
      const child = yield* GoalChild.admit(db, yield* SessionV2.Service, setup.admission)
      const before = yield* db.all(sql`SELECT * FROM event WHERE aggregate_id=${child.unit.child_session_id}`)
      const execution = yield* SessionExecution.Service
      const owned = yield* SessionExecution.requireOwned(execution)
      const run = yield* owned.run(GoalChildExecution.target(child.unit), {
        registered: () => {
          throw new Error("caller registration failed")
        },
      })
      if (run.status !== "started") throw new Error(run.status)
      const result = yield* owned.await(run.receipt)
      expect(result.status === "settled" && Exit.isFailure(result.exit)).toBeTrue()
      expect(Array.from(yield* execution.active)).toEqual([])
      expect(yield* db.all(sql`SELECT * FROM event WHERE aggregate_id=${child.unit.child_session_id}`)).toEqual(before)
      expect(state).toEqual({ locations: 0, runs: 0, shells: 0 })
    }),
  ))

test("ordinary/noop compositions cannot report owned execution success", async () => {
  const exit = await Effect.runPromise(
    SessionExecution.Service.use(SessionExecution.requireOwned).pipe(
      Effect.provide(SessionExecution.noopLayer),
      Effect.exit,
    ),
  )
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof GoalChildSchema.Error).toBeTrue()
})

test("a different connection changing current control after registration blocks Started before Location", () =>
  GoalChildFixture.isolated(({ directory, filename, state }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const setup = yield* GoalChildFixture.prepare(directory)
      const child = yield* GoalChild.admit(db, yield* SessionV2.Service, setup.admission)
      const before = yield* db.all(sql`SELECT * FROM event WHERE aggregate_id=${child.unit.child_session_id}`)
      const owned = yield* SessionExecution.requireOwned(yield* SessionExecution.Service)
      const connection = new SQLite(filename)
      const run = yield* owned
        .run(GoalChildExecution.target(child.unit), {
          registered: () => {
            // Separate writer commits in the actual registration -> Started window, not a fake Store.
            connection.run("UPDATE goal_control SET requested_phase='paused',revision=revision+1 WHERE goal_id=?", [
              setup.goal.goal_id,
            ])
          },
        })
        .pipe(Effect.ensuring(Effect.sync(() => connection.close())))
      if (run.status !== "started") throw new Error(run.status)
      const result = yield* owned.await(run.receipt)
      expect(result.status === "settled" && Exit.isFailure(result.exit)).toBeTrue()
      expect(
        result.status === "settled" &&
          Exit.isFailure(result.exit) &&
          result.exit.cause.reasons.some(
            (reason) => Cause.isFailReason(reason) && reason.error instanceof GoalChildSchema.Error,
          ),
      ).toBeTrue()
      expect(yield* db.all(sql`SELECT * FROM event WHERE aggregate_id=${child.unit.child_session_id}`)).toEqual(before)
      expect((yield* GoalChild.owner(db, child.unit.child_session_id))?.inputs[0].execution).toBeUndefined()
      expect(
        yield* (yield* SessionStore.Service).claimToken(SessionSchema.ID.make(child.unit.child_session_id)),
      ).toBeUndefined()
      expect(state).toEqual({ locations: 0, runs: 0, shells: 0 })
    }),
  ))

test("an unlinked prior execution fact is never treated as virgin admission", () =>
  GoalChildFixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const setup = yield* GoalChildFixture.prepare(directory)
      const child = yield* GoalChild.admit(db, yield* SessionV2.Service, setup.admission)
      const owned = yield* SessionExecution.requireOwned(yield* SessionExecution.Service)
      yield* db.run(sql`UPDATE session_input SET promoted_seq=42 WHERE id=${child.admitted.id}`)
      const run = yield* owned.run(GoalChildExecution.target(child.unit)).pipe(Effect.exit)
      expect(Exit.isFailure(run)).toBeTrue()
      expect(state).toEqual({ locations: 0, runs: 0, shells: 0 })
      expect((yield* GoalChild.owner(db, child.unit.child_session_id))?.inputs[0].execution).toBeUndefined()
    }),
  ))
