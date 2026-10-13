import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { GoalControl } from "../../src/deepagent/goal-control"
import { GoalControlFixture } from "../fixture/goal-control"
import { testEffect } from "../lib/effect"

const it = testEffect(Database.layerFromPath(":memory:"))

it.live("start preparation, activation and command retry are one durable identity", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const setup = yield* GoalControlFixture.prepare(db, "start")
    expect((yield* GoalControl.current(db, setup.input.sessionID))?.preparation).toBe("preparing")
    expect(yield* GoalControl.pendingWakes(db)).toEqual([])
    expect((yield* GoalControl.reserveStart(db, setup.input)).row.goal_id).toBe(setup.row.goal_id)
    const receipt = yield* GoalControl.activate(db, { ...setup.input, goalId: setup.row.goal_id })
    expect(receipt).toMatchObject({ revision: 1, wakeState: "pending", preparation: "ready" })
    expect((yield* GoalControl.activate(db, { ...setup.input, goalId: setup.row.goal_id })).receiptID).toBe(
      receipt.receiptID,
    )
    expect((yield* GoalControl.pendingWakes(db)).filter((row) => row.goal_id === setup.row.goal_id)).toHaveLength(1)
    expect(
      (yield* GoalControl.reserveStart(db, { ...setup.input, requestHash: "b".repeat(64) }).pipe(Effect.flip)).code,
    ).toBe("request_conflict")
  }),
)

it.live("pause/resume/stop CAS and exact retries precede revision checks", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const setup = yield* GoalControlFixture.activate(db, "control")
    const pause = {
      sessionID: setup.input.sessionID,
      goalId: setup.row.goal_id,
      expectedRevision: 1,
      requestID: "pause-control",
      action: "pause" as const,
    }
    const paused = yield* GoalControl.control(db, pause)
    expect(paused).toMatchObject({ revision: 2, requestedPhase: "paused", inFlight: false })
    expect(yield* GoalControl.control(db, pause)).toMatchObject({
      revision: 2,
      replayed: true,
      receiptID: paused.receiptID,
    })
    expect((yield* GoalControl.beginTick(db, setup.tick).pipe(Effect.flip)).code).toBe("revision_conflict")
    const resume = { ...pause, expectedRevision: 2, requestID: "resume-control", action: "resume" as const }
    const attempts = yield* Effect.all(
      [
        GoalControl.control(db, resume).pipe(Effect.exit),
        GoalControl.control(db, { ...resume, requestID: "competing-resume" }).pipe(Effect.exit),
      ],
      { concurrency: 2 },
    )
    expect(attempts.filter((item) => Exit.isSuccess(item))).toHaveLength(1)
    const stopped = yield* GoalControl.control(db, {
      ...pause,
      expectedRevision: 3,
      requestID: "stop-control",
      action: "stop",
    })
    expect(stopped).toMatchObject({ revision: 4, requestedPhase: "stopped" })
    expect(
      (yield* GoalControl.control(db, { ...resume, expectedRevision: 4, requestID: "reopen" }).pipe(Effect.flip)).code,
    ).toBe("target_conflict")
  }),
)

it.live("issued permits remain unresolved across pause and cannot be replaced by resume", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const setup = yield* GoalControlFixture.activate(db, "permit")
    const admitted = yield* GoalControl.beginTick(db, setup.tick)
    expect(admitted.replayed).toBe(false)
    expect((yield* GoalControl.beginTick(db, setup.tick).pipe(Effect.flip)).code).toBe("recovery_required")
    const paused = yield* GoalControl.control(db, {
      sessionID: setup.input.sessionID,
      goalId: setup.row.goal_id,
      expectedRevision: 1,
      requestID: "pause-permit",
      action: "pause",
    })
    expect(paused.inFlight).toBe(true)
    expect(
      (yield* GoalControl.control(db, {
        sessionID: setup.input.sessionID,
        goalId: setup.row.goal_id,
        expectedRevision: 2,
        requestID: "resume-permit",
        action: "resume",
      }).pipe(Effect.flip)).code,
    ).toBe("recovery_required")
    yield* GoalControl.settleTick(db, { permit: admitted.permit, nextSeq: 1, planVersion: 2, phase: "running" })
    expect((yield* GoalControl.current(db, setup.input.sessionID))?.requested_phase).toBe("paused")
    const resumed = yield* GoalControl.control(db, {
      sessionID: setup.input.sessionID,
      goalId: setup.row.goal_id,
      expectedRevision: 2,
      requestID: "resume-after-settle",
      action: "resume",
    })
    expect(resumed).toMatchObject({ revision: 3, inFlight: false })
  }),
)

it.live("SQL receipt failure rolls back control and wake supersession", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const setup = yield* GoalControlFixture.activate(db, "rollback")
    yield* db
      .run(
        sql`CREATE TRIGGER goal_test_insert_failure BEFORE INSERT ON goal_control_command WHEN NEW.request_id = 'fail-control' BEGIN SELECT RAISE(ABORT, 'fixture'); END`,
      )
      .pipe(Effect.orDie)
    const error = yield* GoalControl.control(db, {
      sessionID: setup.input.sessionID,
      goalId: setup.row.goal_id,
      expectedRevision: 1,
      requestID: "fail-control",
      action: "pause",
    }).pipe(Effect.flip)
    expect(error.code).toBe("unavailable")
    expect((yield* GoalControl.current(db, setup.input.sessionID))?.revision).toBe(1)
    expect((yield* GoalControl.command(db, setup.input.sessionID, setup.input.requestID))?.wake_state).toBe("pending")
  }),
)

it.live("stop records requested control without claiming an unknown tick was interrupted", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const setup = yield* GoalControlFixture.activate(db, "stop-inflight")
    const admitted = yield* GoalControl.beginTick(db, setup.tick)
    yield* GoalControl.unknown(db, admitted.permit)
    const stopped = yield* GoalControl.control(db, {
      sessionID: setup.input.sessionID,
      goalId: setup.row.goal_id,
      expectedRevision: 1,
      requestID: "stop-unknown",
      action: "stop",
    })
    expect(stopped).toMatchObject({ requestedPhase: "stopped", running: false, inFlight: true, recoveryRequired: true })
    expect(
      yield* db
        .get(
          sql`SELECT state, interrupt_state, settled_at FROM goal_tick_permit WHERE permit_id=${admitted.permit.permit_id}`,
        )
        .pipe(Effect.orDie),
    ).toEqual({ state: "unknown", interrupt_state: "requested", settled_at: null })
    expect(
      (yield* GoalControl.reserveStart(db, { ...setup.input, requestID: "new-goal", requestHash: "c".repeat(64) }).pipe(
        Effect.flip,
      )).code,
    ).toBe("busy")
  }),
)
