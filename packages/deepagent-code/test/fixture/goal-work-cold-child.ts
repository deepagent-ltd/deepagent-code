import { Cause, Effect, Exit } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { GoalControl } from "@deepagent-code/core/deepagent/goal-control"
import { GoalControlSchema } from "@deepagent-code/core/deepagent/goal-control.schema"
import { WorkAuthorityFixture } from "../../../core/test/fixture/work-authority"
import { makeGoalTickPort, type GoalTickPortDeps } from "../../src/session/goal-tick-port"

const result = await Effect.runPromise(
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
    const outcomes = yield* Effect.forEach(["file-root", "file-child", "file-grandchild"], (suffix) =>
      Effect.gen(function* () {
        const row = (yield* GoalControl.current(db, `ses_goal_${suffix}`))!
        const exit = yield* port({
          sessionID: row.session_id,
          goalId: row.goal_id,
          planDocId: row.plan_doc_id,
          seq: row.next_seq,
          expectedPlanVersion: row.plan_version,
          revision: row.revision,
        }).pipe(Effect.exit)
        if (Exit.isSuccess(exit)) return "success"
        const error = Cause.squash(exit.cause)
        return error instanceof GoalControlSchema.Error ? error.code : "downstream_defect"
      }),
    )
    return { outcomes, calls }
  }).pipe(Effect.provide(WorkAuthorityFixture.database(process.argv[2]!)), Effect.scoped),
)
console.log(JSON.stringify(result))
