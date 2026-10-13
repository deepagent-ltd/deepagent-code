import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import { AgentV2 } from "../../src/agent"
import { Database } from "../../src/database/database"
import { SessionV2 } from "../../src/session"
import { GoalChild } from "../../src/deepagent/goal-child"
import { GoalChildPolicy } from "../../src/deepagent/goal-child-policy"
import { GoalControl } from "../../src/deepagent/goal-control"
import { GoalTickCheckpoint } from "../../src/deepagent/goal-tick-checkpoint"
import { GoalTickCheckpointV2 } from "../../src/deepagent/goal-tick-checkpoint-v2"
import { GoalChildC2Fixture } from "../fixture/goal-child-c2"

function code<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isSuccess(exit)) return "success"
  const error = Cause.squash(exit.cause)
  return typeof error === "object" && error !== null && "code" in error ? error.code : String(error)
}

test("v2 program reserves fileDB authority and activates an exact stable input before actual admission", () =>
  GoalChildC2Fixture.isolated(({ directory, state }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC2Fixture.prepare(directory)
      const db = (yield* Database.Service).db
      expect(setup.checkpoint.version).toBe(2)
      expect(setup.checkpoint.reserved_bytes).toBe(1048576)
      expect(code(yield* GoalTickCheckpoint.read(db, setup.permit.permit_id).pipe(Effect.exit))).toBe(
        "CHECKPOINT_INVALID",
      )
      const policyBefore = yield* GoalChildPolicy.prepare(db, yield* AgentV2.Service, {
        version: 3,
        frame: setup.frame,
        permitID: setup.permit.permit_id,
        roleKey: setup.admission.roleKey,
        agent: "worker",
        mode: "plain",
      }).pipe(Effect.exit)
      expect(code(policyBefore)).toBe("GOAL_CHILD_CONFLICT")
      const activated = yield* GoalTickCheckpointV2.activate(db, {
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
      const admitted = yield* GoalChild.admitV2(db, yield* SessionV2.Service, { ...setup.admission, policy })
      expect(admitted.unit.binding.version).toBe(3)
      if (admitted.unit.binding.version !== 3) throw new Error("Expected actual version 3 binding")
      expect(admitted.unit.binding.policy.parentPlanResource).toBe(setup.goal.plan_doc_id)
      expect(admitted.unit.binding.policy.planResource).toBe(`doc:plan:plan-${admitted.unit.child_session_id}`)
      expect(admitted.unit.binding.policy.programHash).toBe(activated.journal.programHash)
      expect(admitted.unit.binding.policy.activationHash).toBe(
        GoalControl.fingerprint(activated.journal.activations[0]),
      )
      expect(admitted.unit.inputs[0].inputID).toBe(activated.journal.activations[0].inputID)
      expect(yield* db.all(sql`SELECT id FROM session_input`)).toHaveLength(1)
      expect(state.runs).toBe(0)
      expect(yield* db.all(sql`SELECT receipt_id FROM session_v2_provider_turn_receipt`)).toHaveLength(0)
    }),
  ))

test("exact activation retry cannot change text, consume a new input, or bypass current control", () =>
  GoalChildC2Fixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC2Fixture.prepare(directory)
      const db = (yield* Database.Service).db
      const request = { permitID: setup.permit.permit_id, revision: 0, role: 0, text: setup.admission.text }
      const first = yield* GoalTickCheckpointV2.activate(db, request)
      const retry = yield* GoalTickCheckpointV2.activate(db, { ...request, revision: first.revision })
      expect(retry.revision).toBe(first.revision)
      expect(
        code(
          yield* GoalTickCheckpointV2.activate(db, { ...request, revision: first.revision, text: "changed" }).pipe(
            Effect.exit,
          ),
        ),
      ).toBe("CHECKPOINT_CONFLICT")
      yield* GoalControl.control(db, {
        sessionID: setup.parent.id,
        goalId: setup.goal.goal_id,
        expectedRevision: 1,
        requestID: "pause-program",
        action: "pause",
      })
      expect(
        code(yield* GoalTickCheckpointV2.activate(db, { ...request, revision: first.revision }).pipe(Effect.exit)),
      ).toBe("CHECKPOINT_CONTROL_CHANGED")
      expect(yield* db.all(sql`SELECT id FROM session_input`)).toHaveLength(0)
    }),
  ))

test("unknown v2 tombstone keeps reservation and rejects all new activation", () =>
  GoalChildC2Fixture.isolated(({ directory }) =>
    Effect.gen(function* () {
      const setup = yield* GoalChildC2Fixture.prepare(directory)
      const db = (yield* Database.Service).db
      const unknown = yield* GoalTickCheckpointV2.markUnknown(db, setup.permit.permit_id)
      expect(unknown?.state).toBe("recovery_required")
      expect(unknown?.reserved_bytes).toBe(1048576)
      expect(
        code(
          yield* GoalTickCheckpointV2.activate(db, {
            permitID: setup.permit.permit_id,
            revision: unknown!.revision,
            role: 0,
            text: setup.admission.text,
          }).pipe(Effect.exit),
        ),
      ).toBe("CHECKPOINT_RECOVERY_REQUIRED")
      expect(yield* db.all(sql`SELECT unit_id FROM goal_child_unit`)).toHaveLength(0)
    }),
  ))
