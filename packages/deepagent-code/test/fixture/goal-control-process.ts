import { Effect, Layer } from "effect"
import path from "node:path"
import { sql } from "drizzle-orm"
import { DeepAgentEventBus } from "@deepagent-code/core/deepagent/deepagent-event-bus"
import { GoalControlDispatcher } from "../../src/session/goal-control-dispatcher"
import { Database } from "@deepagent-code/core/database/database"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalControlFixture } from "../../../core/test/fixture/goal-control"
import { makeGoalTickPort, type GoalTickPortDeps } from "../../src/session/goal-tick-port"

const root = process.argv[2]!
const phase = process.argv[3]!
const database = Database.layerFromPath(path.join(root, "authority.sqlite"))
await Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const setup = yield* GoalControlFixture.activate(db, "process")
  if (phase === "publish-gap") {
    yield* db
      .run(
        sql`CREATE TRIGGER goal_wake_gap BEFORE UPDATE OF wake_state ON goal_control_command WHEN NEW.wake_state='published' BEGIN SELECT RAISE(ABORT,'crash gap fixture'); END`,
      )
      .pipe(Effect.orDie)
    yield* GoalControlDispatcher.drain(db, yield* DeepAgentEventBus.Service)
  }
  if (phase.startsWith("verify-wake")) {
    yield* db.run(sql`DROP TRIGGER IF EXISTS goal_wake_gap`).pipe(Effect.orDie)
    const bus = yield* DeepAgentEventBus.Service
    yield* GoalControlDispatcher.drain(db, bus)
    yield* GoalControlDispatcher.drain(db, bus)
    const events = yield* db
      .get(sql`SELECT count(*) AS count FROM deepagent_event WHERE idempotency_key=${setup.command.wake_key}`)
      .pipe(Effect.orDie)
    const deliveries = yield* db
      .get(
        sql`SELECT count(*) AS count FROM deepagent_event_delivery WHERE event_id IN (SELECT id FROM deepagent_event WHERE idempotency_key=${setup.command.wake_key}) AND status='pending'`,
      )
      .pipe(Effect.orDie)
    const command = yield* GoalControl.command(db, setup.input.sessionID, setup.input.requestID)
    if (command?.wake_state !== "published") throw new Error("Wake obligation not repaired")
    yield* Effect.promise(() =>
      Bun.write(
        path.join(root, `${phase}.json`),
        JSON.stringify({ events, deliveries, wakeState: command.wake_state }),
      ),
    )
  }
  if (phase === "permit") yield* GoalControl.beginTick(db, setup.tick)
  if (phase === "pause")
    yield* GoalControl.control(db, {
      sessionID: setup.input.sessionID,
      goalId: setup.row.goal_id,
      expectedRevision: 1,
      requestID: "cold-pause",
      action: "pause",
    })
  if (phase === "verify-paused" || phase === "verify-unknown") {
    const accesses: string[] = []
    const port = makeGoalTickPort(
      new Proxy({ db } as GoalTickPortDeps, {
        get(target, key) {
          if (key === "db") return target.db
          accesses.push(String(key))
          throw new Error(`Downstream reached: ${String(key)}`)
        },
      }),
    )
    const result = yield* port(setup.tick).pipe(Effect.exit)
    if (result._tag !== "Failure" || accesses.length)
      throw new Error("Cold tick was not rejected before downstream work")
    if (phase === "verify-paused") {
      const receipt = yield* GoalControl.control(db, {
        sessionID: setup.input.sessionID,
        goalId: setup.row.goal_id,
        expectedRevision: 1,
        requestID: "cold-pause",
        action: "pause",
      })
      if (receipt.revision !== 2 || !receipt.replayed) throw new Error("Cold exact retry changed its receipt")
    }
    const row = yield* GoalControl.current(db, setup.input.sessionID)
    if (!row) throw new Error("Goal authority missing")
    const snapshot = yield* GoalControl.snapshot(db, row)
    yield* Effect.promise(() => Bun.write(path.join(root, `${phase}.json`), JSON.stringify({ snapshot, accesses })))
  }
  console.log("GOAL_CONTROL_READY")
  yield* Effect.never
}).pipe(
  Effect.provide(DeepAgentEventBus.layerWith().pipe(Layer.provideMerge(database))),
  Effect.scoped,
  Effect.runPromise,
)
