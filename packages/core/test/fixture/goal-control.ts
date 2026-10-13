export * as GoalControlFixture from "./goal-control"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../../src/database/database"
import { GoalControl } from "../../src/deepagent/goal-control"
import type { GoalControlSchema } from "../../src/deepagent/goal-control.schema"

export const initialization: GoalControlSchema.Initialization = {
  spec: {
    planDocId: "plan-goal",
    criteria: [{ kind: "plan_complete" }],
    limits: { maxTicks: 3, maxTokens: 1000, maxWallclockMs: 60000 },
    stallThreshold: 3,
  },
  planVersion: 1,
  planHash: "a".repeat(64),
  model: { providerID: "goal-fixture", modelID: "never-called" },
  netTokenBudget: false,
}

export const prepare = Effect.fn("GoalControlFixture.prepare")(function* (
  db: Database.Interface["db"],
  suffix = "one",
) {
  const sessionID = `ses_goal_${suffix}`
  yield* db
    .run(
      sql`INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('goal-project','/tmp/goal-fixture',1,1,'[]') ON CONFLICT DO NOTHING`,
    )
    .pipe(Effect.orDie)
  yield* db
    .run(
      sql`INSERT INTO session (id,project_id,slug,directory,title,version,v2_authority,time_created,time_updated) VALUES (${sessionID},'goal-project',${sessionID},'/tmp/goal-fixture','Goal fixture','2',1,1,1) ON CONFLICT DO NOTHING`,
    )
    .pipe(Effect.orDie)
  const input = {
    sessionID,
    requestID: `start-${suffix}`,
    requestHash: GoalControl.fingerprint({ sessionID, objective: suffix }),
    planDocId: "plan-goal",
    initialization,
    driverMode: "event" as const,
  }
  const prepared = yield* GoalControl.reserveStart(db, input)
  return { input, ...prepared }
})

export const activate = Effect.fn("GoalControlFixture.activate")(function* (
  db: Database.Interface["db"],
  suffix = "one",
) {
  const prepared = yield* prepare(db, suffix)
  const receipt = yield* GoalControl.activate(db, {
    sessionID: prepared.row.session_id,
    goalId: prepared.row.goal_id,
    requestID: prepared.input.requestID,
    requestHash: prepared.input.requestHash,
  })
  return {
    ...prepared,
    receipt,
    tick: {
      sessionID: prepared.row.session_id,
      goalId: prepared.row.goal_id,
      planDocId: "plan-goal",
      revision: 1,
      seq: 0,
      expectedPlanVersion: 1,
      mode: "event" as const,
    },
  }
})
