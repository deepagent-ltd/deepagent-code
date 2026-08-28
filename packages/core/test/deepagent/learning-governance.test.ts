import { describe, expect, test } from "bun:test"
import { count, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import governanceSchemaMigration from "../../src/database/migration/20260812034116_learning_governance_authority"
import governanceLifecycleMigration from "../../src/database/migration/20260812035000_learning_governance_lifecycle"
import { DeepAgentLearningGovernance } from "../../src/deepagent/learning-governance"
import { LearningGovernanceActionTable, LearningGovernancePlanTable } from "../../src/deepagent/learning-governance.sql"
import { DeepAgentLearningJob } from "../../src/deepagent/learning-job"
import { LearningJobTable } from "../../src/deepagent/learning-job.sql"
import { Hash } from "../../src/util/hash"

describe("durable learning governance authority", () => {
  test("prepares an exact zero-action plan atomically and gates job completion", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const first = yield* DeepAgentLearningGovernance.prepare(db, prepareInput([]))
        const retry = yield* DeepAgentLearningGovernance.prepare(db, prepareInput([]))

        expect(retry).toEqual(first)
        expect(first.plan).toMatchObject({
          actionCount: 0,
          sourceJobVersion: 4,
          jobStartedVersion: 5,
          state: "prepared",
          version: 0,
        })
        expect(first.actions).toEqual([])
        expect(yield* DeepAgentLearningGovernance.getByJob(db, "job-governance-1")).toEqual(first)
        expect(yield* db.select({ count: count() }).from(LearningGovernanceActionTable).get()).toEqual({ count: 0 })
        expect(yield* DeepAgentLearningJob.get(db, "job-governance-1")).toMatchObject({
          state: "governance",
          sideEffectState: "started",
          sideEffectKind: "governance",
          version: 5,
        })

        const settled = yield* DeepAgentLearningGovernance.settlePlan(db, {
          planId: first.plan.planId,
          owner: "worker-a",
          expectedVersion: 0,
          resultRef: "governance-result:job-governance-1",
          resultHash: hash("zero-actions"),
          now: 11,
        })
        expect(settled.plan).toMatchObject({ state: "settled", version: 1 })
        const completed = yield* DeepAgentLearningJob.settle(db, {
          jobId: "job-governance-1",
          owner: "worker-a",
          expectedVersion: 6,
          state: "completed",
          resultRef: "governance-result:job-governance-1",
          now: 12,
        })
        expect(completed).toMatchObject({ state: "completed", version: 7 })
        expect(
          yield* DeepAgentLearningGovernance.settlePlan(db, {
            planId: first.plan.planId,
            owner: "worker-a",
            expectedVersion: settled.plan.version,
            resultRef: "governance-result:conflict",
            resultHash: hash("conflict"),
            now: 13,
          }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "DeepAgentLearningGovernance.FenceError",
          reason: "completed learning job forbids conflicting governance plan output",
        })
        expect(yield* DeepAgentLearningGovernance.get(db, first.plan.planId)).toMatchObject({
          plan: { state: "settled", resultRef: "governance-result:job-governance-1" },
        })
      }),
    )
  })

  test("canonicalizes exact prepare retries and rejects identity conflicts without partial writes", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const first = yield* DeepAgentLearningGovernance.prepare(
          db,
          prepareInput([{ candidateId: "candidate-1", kind: "document_stage", payload: { b: 2, a: 1 } }]),
        )
        const retry = yield* DeepAgentLearningGovernance.prepare(
          db,
          prepareInput([{ candidateId: "candidate-1", kind: "document_stage", payload: { a: 1, b: 2 } }]),
        )
        expect(retry).toEqual(first)

        expect(
          yield* DeepAgentLearningGovernance.prepare(
            db,
            prepareInput([{ candidateId: "candidate-1", kind: "document_stage", payload: { a: 1, b: 3 } }]),
          ).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "DeepAgentLearningGovernance.IdentityConflictError",
          planId: first.plan.planId,
        })
        expect(yield* db.select({ count: count() }).from(LearningGovernancePlanTable).get()).toEqual({ count: 1 })
        expect(yield* db.select({ count: count() }).from(LearningGovernanceActionTable).get()).toEqual({ count: 1 })
      }),
    )

    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        expect(
          yield* DeepAgentLearningGovernance.prepare(db, { ...prepareInput([]), now: 101 }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "DeepAgentLearningGovernance.FenceError" })
        expect(yield* db.select({ count: count() }).from(LearningGovernancePlanTable).get()).toEqual({ count: 0 })
        expect(yield* DeepAgentLearningJob.get(db, "job-governance-1")).toMatchObject({
          sideEffectState: "not_started",
          version: 4,
        })
      }),
    )
  })

  test("fences predecessors and permits a second worker takeover only after lease expiry", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const prepared = yield* DeepAgentLearningGovernance.prepare(
          db,
          prepareInput([
            { candidateId: "candidate-1", kind: "document_stage", payload: { revision: "candidate-1:r1" } },
            {
              candidateId: "candidate-1",
              kind: "memory_inbox",
              predecessorSequence: 0,
              payload: { inbox: "candidate-1" },
            },
          ]),
        )
        const first = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 10,
          now: 10,
        })
        expect(first).toMatchObject({ sequence: 0, state: "running", owner: "worker-a", version: 1 })
        expect(
          yield* DeepAgentLearningGovernance.claimAction(db, {
            planId: prepared.plan.planId,
            owner: "worker-b",
            leaseMs: 20,
            now: 109,
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "DeepAgentLearningGovernance.FenceError" })

        expect(
          yield* DeepAgentLearningGovernance.claimAction(db, {
            planId: prepared.plan.planId,
            owner: "worker-b",
            leaseMs: 20,
            now: 110,
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "DeepAgentLearningGovernance.FenceError" })
        const rebound = yield* DeepAgentLearningGovernance.takeover(db, {
          jobId: "job-governance-1",
          owner: "worker-b",
          leaseMs: 40,
          now: 110,
        })
        expect(rebound?.plan).toMatchObject({ jobOwner: "worker-b", jobStartedVersion: 6, version: 1 })
        expect(
          yield* DeepAgentLearningGovernance.failAction(db, {
            actionId: first!.actionId,
            owner: "worker-a",
            expectedVersion: first!.version,
            errorCode: "stale_worker_failure",
            errorDetail: "old worker completed after takeover",
            now: 111,
          }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "DeepAgentLearningGovernance.FenceError",
          reason: "live governance job fence was lost",
        })
        const afterStaleFailure = yield* DeepAgentLearningGovernance.get(db, prepared.plan.planId)
        expect(afterStaleFailure?.plan).toMatchObject({ state: "prepared", jobOwner: "worker-b" })
        expect(afterStaleFailure?.actions[0]).toMatchObject({ state: "running", owner: "worker-a" })
        expect(
          yield* db
            .run(
              `UPDATE learning_governance_action
               SET state = 'recovery_required', owner = NULL, lease_expires_at = NULL,
                   version = ${first!.version + 1}, error_code = 'stale_worker_failure',
                   error_detail = 'old worker completed after takeover', settled_at = 111, updated_at = 111
               WHERE action_id = '${first!.actionId}'`,
            )
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "EffectDrizzleQueryError" })
        const takeover = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-b",
          leaseMs: 20,
          now: 110,
        })
        expect(takeover).toMatchObject({ actionId: first!.actionId, owner: "worker-b", version: 2 })
        yield* DeepAgentLearningGovernance.settleAction(db, {
          actionId: takeover!.actionId,
          owner: "worker-b",
          expectedVersion: 2,
          resultRef: "document:candidate-1:r1",
          resultHash: hash("document"),
          now: 111,
        })
        const second = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-b",
          leaseMs: 10,
          now: 112,
        })
        expect(second).toMatchObject({ sequence: 1, kind: "memory_inbox", state: "running" })
        yield* DeepAgentLearningGovernance.settleAction(db, {
          actionId: second!.actionId,
          owner: "worker-b",
          expectedVersion: second!.version,
          resultRef: "memory-inbox:candidate-1",
          resultHash: hash("inbox"),
          now: 113,
        })
        const snapshot = yield* DeepAgentLearningGovernance.get(db, prepared.plan.planId)
        expect(snapshot?.actions.map((action) => action.state)).toEqual(["settled", "settled"])
      }),
    )
  })

  test("replays the exact action result and escalates a conflicting output with durable evidence", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const prepared = yield* DeepAgentLearningGovernance.prepare(
          db,
          prepareInput([{ candidateId: "candidate-1", kind: "document_stage", payload: { revision: "r1" } }]),
        )
        const claimed = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 20,
          now: 10,
        })
        const settled = yield* DeepAgentLearningGovernance.settleAction(db, {
          actionId: claimed!.actionId,
          owner: "worker-a",
          expectedVersion: claimed!.version,
          resultRef: "document:candidate-1:r1",
          resultHash: hash("document-r1"),
          now: 11,
        })
        expect(
          yield* DeepAgentLearningGovernance.settleAction(db, {
            actionId: claimed!.actionId,
            owner: "worker-a",
            expectedVersion: claimed!.version,
            resultRef: "document:candidate-1:r1",
            resultHash: hash("document-r1"),
            now: 12,
          }),
        ).toEqual(settled)

        expect(
          yield* DeepAgentLearningGovernance.settleAction(db, {
            actionId: claimed!.actionId,
            owner: "worker-a",
            expectedVersion: claimed!.version,
            resultRef: "document:candidate-1:stale-conflict",
            resultHash: hash("stale-conflict"),
            now: 12,
          }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "DeepAgentLearningGovernance.FenceError",
          reason: "action conflict version fence was lost",
        })

        yield* DeepAgentLearningGovernance.settlePlan(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          expectedVersion: 0,
          resultRef: "governance-result:action-settled",
          resultHash: hash("action-settled"),
          now: 12,
        })

        const conflicted = yield* DeepAgentLearningGovernance.settleAction(db, {
          actionId: claimed!.actionId,
          owner: "worker-a",
          expectedVersion: settled.version,
          resultRef: "document:candidate-1:r2",
          resultHash: hash("document-r2"),
          now: 13,
        })
        expect(conflicted).toMatchObject({
          state: "recovery_required",
          errorCode: "governance_action_output_conflict",
        })
        expect(yield* DeepAgentLearningGovernance.get(db, prepared.plan.planId)).toMatchObject({
          plan: { state: "recovery_required", errorCode: "governance_action_output_conflict" },
        })
        expect(yield* DeepAgentLearningJob.get(db, "job-governance-1")).toMatchObject({
          state: "recovery_required",
          sideEffectState: "unknown",
          errorCode: "governance_action_output_conflict",
        })
      }),
    )
  })

  test("replays an exact plan result and escalates a conflicting result after job side-effect settlement", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const prepared = yield* DeepAgentLearningGovernance.prepare(db, prepareInput([]))
        const settled = yield* DeepAgentLearningGovernance.settlePlan(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          expectedVersion: 0,
          resultRef: "governance-result:r1",
          resultHash: hash("governance-r1"),
          now: 11,
        })
        expect(
          yield* DeepAgentLearningGovernance.settlePlan(db, {
            planId: prepared.plan.planId,
            owner: "worker-a",
            expectedVersion: 0,
            resultRef: "governance-result:r1",
            resultHash: hash("governance-r1"),
            now: 12,
          }),
        ).toEqual(settled)

        expect(
          yield* DeepAgentLearningGovernance.settlePlan(db, {
            planId: prepared.plan.planId,
            owner: "worker-a",
            expectedVersion: 0,
            resultRef: "governance-result:stale-conflict",
            resultHash: hash("stale-conflict"),
            now: 12,
          }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "DeepAgentLearningGovernance.FenceError",
          reason: "plan conflict version fence was lost",
        })

        const conflicted = yield* DeepAgentLearningGovernance.settlePlan(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          expectedVersion: settled.plan.version,
          resultRef: "governance-result:r2",
          resultHash: hash("governance-r2"),
          now: 13,
        })
        expect(conflicted.plan).toMatchObject({
          state: "recovery_required",
          errorCode: "governance_plan_output_conflict",
        })
        expect(yield* DeepAgentLearningJob.get(db, "job-governance-1")).toMatchObject({
          state: "recovery_required",
          sideEffectState: "unknown",
          errorCode: "governance_plan_output_conflict",
        })
      }),
    )
  })

  test("enforces immutable identity, version CAS, plan settlement, and job begin triggers", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const directBegin = yield* db
          .run(
            "UPDATE learning_job SET side_effect_state = 'started', side_effect_kind = 'governance', version = 5, updated_at = 10 WHERE job_id = 'job-governance-1'",
          )
          .pipe(Effect.flip)
        expect(directBegin).toMatchObject({ _tag: "EffectDrizzleQueryError" })
        expect(yield* DeepAgentLearningJob.get(db, "job-governance-1")).toMatchObject({
          sideEffectState: "not_started",
          sideEffectKind: null,
          version: 4,
        })

        const prepared = yield* DeepAgentLearningGovernance.prepare(
          db,
          prepareInput([{ candidateId: "candidate-1", kind: "document_stage", payload: { revision: "r1" } }]),
        )
        const identityMutation = yield* db
          .run(
            `UPDATE learning_governance_plan SET payload_json = '{}', version = 1 WHERE plan_id = '${prepared.plan.planId}'`,
          )
          .pipe(Effect.flip)
        expect(identityMutation).toMatchObject({ _tag: "EffectDrizzleQueryError" })
        const skippedVersion = yield* db
          .run(`UPDATE learning_governance_plan SET version = 2 WHERE plan_id = '${prepared.plan.planId}'`)
          .pipe(Effect.flip)
        expect(skippedVersion).toMatchObject({ _tag: "EffectDrizzleQueryError" })
        const prematureSettlement = yield* db
          .run(
            `UPDATE learning_governance_plan SET state = 'settled', version = 1, result_ref = 'bad', result_hash = '${hash("bad")}', result_fingerprint = '${hash("fingerprint")}', settled_at = 11, updated_at = 11 WHERE plan_id = '${prepared.plan.planId}'`,
          )
          .pipe(Effect.flip)
        expect(prematureSettlement).toMatchObject({ _tag: "EffectDrizzleQueryError" })
        expect(
          yield* db
            .select({ state: LearningGovernancePlanTable.state, version: LearningGovernancePlanTable.version })
            .from(LearningGovernancePlanTable)
            .where(eq(LearningGovernancePlanTable.plan_id, prepared.plan.planId))
            .get(),
        ).toEqual({ state: "prepared", version: 0 })
      }),
    )
  })
})

function prepareInput(actions: readonly DeepAgentLearningGovernance.ActionInput[]) {
  return {
    jobId: "job-governance-1",
    owner: "worker-a",
    expectedJobVersion: 4,
    leaseMs: 100,
    actions,
    now: 10,
  } as const
}

function hash(value: string) {
  return Hash.sha256(value)
}

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [governanceSchemaMigration, governanceLifecycleMigration])
      yield* db.run(
        "INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('project-governance-1', '/tmp/project-governance-1', '[]', 1, 1)",
      )
      yield* db.run(`
        INSERT INTO learning_job (
          job_id, project_id, session_id, run_id, trigger, dedupe_key, candidate_input_ref, policy,
          max_attempts, admission_fingerprint, state, attempts, owner, lease_expires_at, version,
          side_effect_state, side_effect_kind, next_attempt_at, created_at, started_at, updated_at
        ) VALUES (
          'job-governance-1', 'project-governance-1', NULL, 'run-governance-1', 'session_finalization',
          'governance:run-governance-1', 'candidate-input:run-governance-1', 'manual_review', 3,
          '${hash("admission")}', 'governance', 1, 'worker-a', 100, 4,
          'not_started', NULL, 0, 1, 1, 1
        )
      `)
      return yield* effect
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}
