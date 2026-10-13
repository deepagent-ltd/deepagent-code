import { expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { AgentV2 } from "../../src/agent"
import { Database } from "../../src/database/database"
import { GoalChildExecution } from "../../src/deepagent/goal-child-execution"
import { SessionExecution } from "../../src/session/execution"
import { GoalChild } from "../../src/deepagent/goal-child"
import { GoalChildPolicy } from "../../src/deepagent/goal-child-policy"
import { GoalTickCheckpointV2 } from "../../src/deepagent/goal-tick-checkpoint-v2"
import { DeepAgentPlanStore } from "../../src/deepagent/plan-store"
import { SessionV2 } from "../../src/session"
import { SessionMessage } from "../../src/session/message"
import { SessionSchema } from "../../src/session/schema"
import { ApplicationTools } from "../../src/tool/application-tools"
import { ToolRegistry } from "../../src/tool/registry"
import { PlanWriteTool } from "../../src/tool/plan"
import { ToolOutputStore } from "../../src/tool-output-store"
import { GoalChildC1Fixture } from "../fixture/goal-child-c1"
import { GoalChildC2Fixture } from "../fixture/goal-child-c2"

const registry = ToolRegistry.layer.pipe(
  Layer.provide(ApplicationTools.layer),
  Layer.provide(
    Layer.mock(ToolOutputStore.Service, {
      bound: (input: ToolOutputStore.BoundInput) => Effect.succeed({ output: input.output, outputPaths: [] }),
    }),
  ),
)

for (const permitted of [true, false]) {
  test(`actual Plan leaf targets only v3 scratch; explicit parent deny=${!permitted}`, () =>
    GoalChildC2Fixture.isolated(({ directory, state }) =>
      Effect.gen(function* () {
        const setup = yield* GoalChildC2Fixture.prepare(directory, "plain", {
          parent: [
            { action: "*", resource: "*", effect: "allow" },
            ...(!permitted ? [{ action: "plan", resource: "*", effect: "deny" } as const] : []),
          ],
        })
        DeepAgentPlanStore.configureRoot(directory)
        const db = (yield* Database.Service).db
        yield* GoalTickCheckpointV2.activate(db, {
          permitID: setup.permit.permit_id,
          revision: 0,
          role: 0,
          text: setup.admission.text,
        })
        const policy = yield* GoalChildPolicy.prepare(db, yield* AgentV2.Service, {
          version: 3,
          frame: setup.frame,
          permitID: setup.permit.permit_id,
          roleKey: setup.admission.roleKey,
          agent: "worker",
          mode: "plain",
        })
        const child = yield* GoalChild.admitV2(db, yield* SessionV2.Service, { ...setup.admission, policy })
        const output = yield* GoalChildC1Fixture.permissions(
          directory,
          Effect.gen(function* () {
            const tools = yield* ToolRegistry.Service
            const materialized = yield* tools.materialize()
            const results: ToolRegistry.Settlement[] = []
            state.run = () =>
              materialized
                .settle({
                  sessionID: SessionSchema.ID.make(child.unit.child_session_id),
                  agent: AgentV2.ID.make("worker"),
                  assistantMessageID: SessionMessage.ID.make("msg_scratch"),
                  call: {
                    type: "tool-call",
                    id: "scratch-plan",
                    name: "plan",
                    input: {
                      operation: "create",
                      expected_plan_id: null,
                      expected_version: null,
                      goal: "Owned scratch",
                      steps: [{ title: "Verify", status: "active" }],
                    },
                  },
                })
                .pipe(
                  Effect.tap((value) => Effect.sync(() => results.push(value))),
                  Effect.asVoid,
                  Effect.orDie,
                )
            const owned = yield* SessionExecution.requireOwned(yield* SessionExecution.Service)
            const run = yield* owned.run(GoalChildExecution.target(child.unit))
            if (run.status !== "started") throw new Error(run.status)
            const outcome = yield* owned.await(run.receipt)
            expect(outcome.status === "settled" && Exit.isSuccess(outcome.exit)).toBeTrue()
            expect(results).toHaveLength(1)
            return results[0]
          }).pipe(Effect.provide(Layer.provideMerge(PlanWriteTool.layer, registry))),
        )
        expect(output.result.type).toBe(permitted ? "text" : "error")
        const exact = DeepAgentPlanStore.readExactPlan(
          child.unit.child_session_id,
          GoalChildPolicy.inspect(policy)!.policy.planResource,
        )
        expect(exact.plan?.goal ?? null).toBe(permitted ? "Owned scratch" : null)
        expect(exact.doc?.scope ?? null).toBe(permitted ? `run:${child.unit.child_session_id}` : null)
        expect(exact.doc?.id ?? null).not.toBe(setup.goal.plan_doc_id)
        expect(DeepAgentPlanStore.readExactPlan(setup.parent.id, `doc:plan:plan-${setup.parent.id}`).doc).toBeNull()
      }),
    ))
}
