import { expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { AgentV2 } from "../../src/agent"
import { Database } from "../../src/database/database"
import { SessionSchema } from "../../src/session/schema"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { AbsolutePath } from "../../src/schema"
import { PermissionV2 } from "../../src/permission"
import { GoalControl } from "../../src/deepagent/goal-control"
import { GoalChild } from "../../src/deepagent/goal-child"
import { GoalChildPolicy } from "../../src/deepagent/goal-child-policy"
import { GoalChildExecution } from "../../src/deepagent/goal-child-execution"
import { GoalTickCheckpointV2 } from "../../src/deepagent/goal-tick-checkpoint-v2"
import { GoalTickProgram } from "../../src/deepagent/goal-tick-program"
import { DocumentStore } from "../../src/deepagent/document-store"
import { DeepAgentPlanStore } from "../../src/deepagent/plan-store"
import { createPlanDoc } from "../../src/deepagent/plan-controller"
import { GoalChildC2Fixture } from "../fixture/goal-child-c2"
import { GoalChildC1Fixture } from "../fixture/goal-child-c1"
import { GoalControlFixture } from "../fixture/goal-control"

const prepare = (directory: string, effect: "allow" | "deny" | "ask") =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const sessions = yield* SessionV2.Service
    const agents = yield* AgentV2.Service
    yield* agents.update((editor) => {
      editor.update(AgentV2.defaultID, (item) => {
        item.permissions = [
          { action: "*", resource: "*", effect: "allow" },
          { action: "plan", resource: "*", effect },
        ]
      })
      editor.update(AgentV2.ID.make("worker"), (item) => {
        item.mode = "subagent"
        item.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      })
      editor.goalRole(AgentV2.ID.make("worker"), { version: "owned-goal-v2", kind: "worker", planWriteOwnGoal: true })
    })
    const parent = yield* sessions.create({
      location: { directory: AbsolutePath.make(directory) },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    })
    DeepAgentPlanStore.configureRoot(directory)
    const plan = createPlanDoc(parent.id, "Parent immutable criteria", [
      { step_id: "step_one", title: "Verify", status: "active", acceptance: "actual validation" },
    ])
    const store = DocumentStore.openExactForCreate(DeepAgentPlanStore.planStoreRoot(parent.id), [
      `doc:plan:plan-${parent.id}`,
    ])
    const parentDoc = store.projectExact(
      {
        id: `doc:plan:plan-${parent.id}`,
        type: "plan",
        scope: `run:${parent.id}`,
        status: "draft",
        version: 1,
        superseded_by: null,
        created_round: null,
        domain: null,
        tags: [],
        description: "Plan",
        provenance: { source: "runner" },
        links: [],
        body: JSON.stringify(plan),
      },
      null,
    )
    const input = {
      sessionID: parent.id,
      requestID: "scratch",
      requestHash: GoalControl.fingerprint(parent.id),
      planDocId: parentDoc.id,
      driverMode: "event" as const,
      initialization: {
        ...GoalControlFixture.initialization,
        spec: { ...GoalControlFixture.initialization.spec, planDocId: parentDoc.id },
        planHash: parentDoc.hash.slice(7),
      },
    }
    const goal = yield* GoalControl.reserveStart(db, input)
    yield* GoalControl.activate(db, { ...input, goalId: goal.row.goal_id })
    const tick = yield* GoalControl.beginTick(db, {
      sessionID: parent.id,
      goalId: goal.row.goal_id,
      planDocId: parentDoc.id,
      revision: 1,
      seq: 0,
      expectedPlanVersion: 1,
      mode: "event",
    })
    const unitID = `goalchild_${GoalControl.fingerprint([tick.permit.permit_id, "worker.0"])}`
    const childID = `ses_goalchild_${GoalControl.fingerprint([tick.permit.permit_id, "worker.0"]).slice(0, 40)}`
    const payload = GoalTickProgram.canonical({
      ...Object.fromEntries(Object.entries(parentDoc).filter(([key]) => key !== "hash")),
      id: `doc:plan:plan-${childID}`,
      scope: `run:${childID}`,
      body: JSON.stringify({ ...plan, session_id: childID, plan_id: `plan_${unitID}` }),
    })
    const program: GoalTickProgram.Program = {
      version: 2,
      contract: "owned-goal-v2",
      roles: [
        {
          key: "worker.0",
          agent: "worker",
          kind: "worker",
          ordinal: 0,
          criterion: null,
          round: null,
          lens: null,
          mode: "plain",
          policyHash: GoalChildPolicy.roleHash(
            yield* agents.snapshot!(parent.agent),
            yield* agents.snapshot!("worker"),
          )!,
          recipe: {
            id: "goal-worker-v2",
            hash: GoalTickProgram.hash("scratch recipe"),
            schemaHash: GoalControl.fingerprint({ type: "string" }),
            dependencies: [],
          },
          scratch: {
            documentID: `doc:plan:plan-${childID}`,
            payload,
            payloadHash: GoalTickProgram.hash(payload),
            parentDocumentID: parentDoc.id,
            parentVersion: 1,
            parentHash: parentDoc.hash.slice(7),
            criteriaHash: GoalControl.fingerprint(input.initialization.spec.criteria),
          },
        },
      ],
      documents: [],
      localEffectSlots: 0,
      nextStateBytes: 0,
    }
    yield* GoalTickCheckpointV2.begin(db, { permitID: tick.permit.permit_id, permitToken: tick.permit.token, program })
    const frame = yield* GoalChildPolicy.openFrame(db, tick.permit.permit_id)
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        GoalChildPolicy.revokeFrame(frame)
        yield* GoalChildPolicy.releaseFrame(db, frame).pipe(Effect.orDie)
      }),
    )
    yield* GoalTickCheckpointV2.activate(db, {
      permitID: tick.permit.permit_id,
      revision: 0,
      role: 0,
      text: "Work only the frozen plan",
    })
    const policy = yield* GoalChildPolicy.prepare(db, agents, {
      version: 3,
      frame,
      permitID: tick.permit.permit_id,
      roleKey: "worker.0",
      agent: "worker",
      mode: "plain",
    })
    const view = GoalChildPolicy.inspect(policy)!
    const child = yield* GoalChild.admitV2(db, sessions, {
      permitID: tick.permit.permit_id,
      permitToken: tick.permit.token,
      roleKey: "worker.0",
      mode: "plain",
      stage: "plain",
      text: "Work only the frozen plan",
      steeringHash: view.steeringHash,
      promptPolicyHash: view.promptPolicyHash,
      policy,
    })
    const current = () =>
      DeepAgentPlanStore.readExactPlan(child.unit.child_session_id, program.roles[0].scratch!.documentID)
    return { db, parent, goal: goal.row, child, policy, current, program }
  })

for (const effect of ["allow", "deny"] as const)
  test(`native scratch preparation ${effect} preserves admission and exact target`, () =>
    GoalChildC2Fixture.isolated(({ directory, state }) =>
      Effect.gen(function* () {
        const setup = yield* prepare(directory, effect)
        yield* GoalChildC1Fixture.permissions(
          directory,
          Effect.gen(function* () {
            const permission = yield* PermissionV2.Service
            const owned = yield* SessionExecution.requireOwned(yield* SessionExecution.Service)
            expect(
              Exit.isFailure(yield* owned.run(GoalChildExecution.target(setup.child.unit)).pipe(Effect.exit)),
            ).toBeTrue()
            expect(
              Exit.isFailure(
                yield* permission.prepareGoalScratch!({
                  unitID: setup.child.unit.unit_id,
                  policy: { ...setup.policy },
                }).pipe(Effect.exit),
              ),
            ).toBeTrue()
            expect(setup.current().doc).toBeNull()
            const result = yield* permission.prepareGoalScratch!({
              unitID: setup.child.unit.unit_id,
              policy: setup.policy,
            }).pipe(Effect.exit)
            expect(Exit.isSuccess(result)).toBe(effect === "allow")
            if (Exit.isSuccess(result)) {
              expect(
                yield* permission.prepareGoalScratch!({ unitID: setup.child.unit.unit_id, policy: setup.policy }),
              ).toEqual(result.value)
              expect(setup.current().doc!.version).toBe(1)
              expect(setup.current().plan!.steps[0].step_id).toBe("step_one")
              expect(
                Exit.isFailure(
                  yield* permission
                    .assert({
                      sessionID: SessionSchema.ID.make(setup.child.unit.child_session_id),
                      action: "plan",
                      resources: [setup.program.roles[0].scratch!.documentID],
                    })
                    .pipe(Effect.exit),
                ),
              ).toBeTrue()
            } else expect(setup.current().doc).toBeNull()
          }),
        )
        expect(state.runs).toBe(0)
        expect(yield* setup.db.all("SELECT id FROM session_input")).toHaveLength(1)
        expect(yield* setup.db.all("SELECT receipt_id FROM session_v2_provider_turn_receipt")).toEqual([])
      }),
    ))

test("permission approval after control change cannot create scratch or wake admitted input", () =>
  GoalChildC2Fixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const setup = yield* prepare(directory, "ask")
      yield* GoalChildC1Fixture.permissions(
        directory,
        Effect.gen(function* () {
          const permission = yield* PermissionV2.Service
          const fiber = yield* permission.prepareGoalScratch!({
            unitID: setup.child.unit.unit_id,
            policy: setup.policy,
          }).pipe(Effect.forkChild)
          for (let index = 0; index < 100; index++) {
            if ((yield* permission.list()).length) break
            yield* Effect.sleep("1 millis")
          }
          const pending = yield* permission.list()
          expect(pending).toHaveLength(1)
          yield* GoalControl.control(setup.db, {
            sessionID: setup.parent.id,
            goalId: setup.goal.goal_id,
            expectedRevision: 1,
            requestID: "pause-seed",
            action: "pause",
          })
          expect(
            Exit.isFailure(yield* permission.reply({ requestID: pending[0].id, reply: "once" }).pipe(Effect.exit)),
          ).toBeTrue()
          expect(Exit.isFailure(yield* Fiber.join(fiber).pipe(Effect.exit))).toBeTrue()
        }),
      )
      expect(setup.current().doc).toBeNull()
      expect(state.runs).toBe(0)
      expect(yield* setup.db.all("SELECT id FROM session_input")).toHaveLength(1)
    }),
  ))
