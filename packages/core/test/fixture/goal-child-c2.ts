export * as GoalChildC2Fixture from "./goal-child-c2"

import { Effect } from "effect"
import { PermissionSchema } from "../../src/permission/schema"
import { AgentV2 } from "../../src/agent"
import { Database } from "../../src/database/database"
import { GoalChildFixture } from "./goal-child"
import { GoalChildC1Fixture } from "./goal-child-c1"
import { GoalChildPolicy } from "../../src/deepagent/goal-child-policy"
import { GoalTickCheckpointV2 } from "../../src/deepagent/goal-tick-checkpoint-v2"
import { GoalTickProgram } from "../../src/deepagent/goal-tick-program"

export const isolated: typeof GoalChildC1Fixture.isolated = (body) =>
  GoalChildC1Fixture.isolated((input) => body(input).pipe(Effect.scoped))
export const prepare = (
  directory: string,
  mode: "plain" | "structured" = "plain",
  options: { parent?: PermissionSchema.Ruleset } = {},
) =>
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.update((editor) => {
      editor.update(AgentV2.defaultID, (agent) => {
        agent.permissions = [...(options.parent ?? [{ action: "*", resource: "*", effect: "allow" }])]
      })
      editor.update(AgentV2.ID.make("worker"), (agent) => {
        agent.mode = "subagent"
        agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      })
      editor.goalRole(AgentV2.ID.make("worker"), { version: "owned-goal-v2", kind: "worker", planWriteOwnGoal: true })
    })
    const source = yield* GoalChildFixture.prepare(directory)
    const program: GoalTickProgram.Program = {
      version: 2,
      contract: "owned-goal-v2",
      roles: [
        {
          key: source.admission.roleKey,
          agent: "worker",
          kind: "worker",
          ordinal: 0,
          criterion: null,
          round: null,
          lens: null,
          mode,
          policyHash: GoalChildPolicy.roleHash(yield* agents.snapshot!("build"), yield* agents.snapshot!("worker"))!,
          recipe: {
            id: "goal-worker-v2",
            hash: GoalTickProgram.hash("actual fixture recipe"),
            schemaHash: GoalTickProgram.hash({ type: "string" }),
            dependencies: [],
          },
        },
      ],
      documents: [],
      localEffectSlots: 0,
      nextStateBytes: 4096,
    }
    const db = (yield* Database.Service).db
    const checkpoint = yield* GoalTickCheckpointV2.begin(db, {
      permitID: source.permit.permit_id,
      permitToken: source.permit.token,
      program,
    })
    const frame = yield* GoalChildPolicy.openFrame(db, source.permit.permit_id)
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        GoalChildPolicy.revokeFrame(frame)
        yield* GoalChildPolicy.releaseFrame(db, frame).pipe(Effect.orDie)
      }),
    )
    return {
      ...source,
      frame,
      program,
      checkpoint,
      admission: {
        ...source.admission,
        agent: "worker",
        mode,
        stage: mode === "plain" ? ("plain" as const) : ("research" as const),
      },
    }
  })
