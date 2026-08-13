import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"
import { count, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import { migrations } from "../../src/database/migration.gen"
import learningJobMigration from "../../src/database/migration/20260811203000_learning_job_authority"
import learningGovernanceSchemaMigration from "../../src/database/migration/20260812034116_learning_governance_authority"
import learningGovernanceLifecycleMigration from "../../src/database/migration/20260812035000_learning_governance_lifecycle"
import learningArtifactSchemaMigration from "../../src/database/migration/20260812184453_charming_anthem"
import learningArtifactPhaseReceiptMigration from "../../src/database/migration/20260812224000_learning_artifact_phase_receipt"
import { DeepAgentLearningGovernance } from "../../src/deepagent/learning-governance"
import { DeepAgentLearningJob } from "../../src/deepagent/learning-job"
import { LearningJobTable } from "../../src/deepagent/learning-job.sql"
import { Hash } from "../../src/util/hash"

describe("durable learning job authority", () => {
  test("deduplicates exact admission and rejects conflicting reuse", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const first = yield* DeepAgentLearningJob.enqueue(db, enqueueInput())
        const retry = yield* DeepAgentLearningJob.enqueue(db, enqueueInput())

        expect(first.created).toBe(true)
        expect(retry.created).toBe(false)
        expect(retry.job).toEqual(first.job)
        expect(
          yield* db
            .select({ count: count() })
            .from(LearningJobTable)
            .where(eq(LearningJobTable.dedupe_key, "final:run-1"))
            .get(),
        ).toEqual({ count: 1 })

        const conflict = yield* DeepAgentLearningJob.enqueue(db, {
          ...enqueueInput(),
          candidateInputRef: "run-manifest:other",
        }).pipe(Effect.flip)
        expect(conflict).toMatchObject({
          _tag: "DeepAgentLearningJob.IdentityConflictError",
          dedupeKey: "final:run-1",
        })
      }),
    )
  })

  test("serializes two claimers with an immediate transaction and a version fence", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* DeepAgentLearningJob.enqueue(db, enqueueInput())

        const claims = yield* Effect.all(
          [
            DeepAgentLearningJob.claim(db, { owner: "worker-a", leaseMs: 100, now: 10 }),
            DeepAgentLearningJob.claim(db, { owner: "worker-b", leaseMs: 100, now: 10 }),
          ],
          { concurrency: "unbounded" },
        )
        const winners = claims.filter((claim) => claim !== undefined)
        expect(winners).toHaveLength(1)
        expect(winners[0]).toMatchObject({ state: "running", attempts: 1, version: 1 })
        expect(winners[0]?.owner === "worker-a" || winners[0]?.owner === "worker-b").toBe(true)
      }),
    )
  })

  test("rejects a side-effect kind that does not match the current phase", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* DeepAgentLearningJob.enqueue(db, enqueueInput())
        const claimed = (yield* DeepAgentLearningJob.claim(db, {
          owner: "worker-a",
          leaseMs: 100,
          now: 10,
        }))!
        const invalid = {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: claimed.version,
          state: "running",
          kind: "reviewer",
          now: 11,
        } as unknown as DeepAgentLearningJob.BeginSideEffectInput

        expect(yield* DeepAgentLearningJob.beginSideEffect(db, invalid).pipe(Effect.flip)).toMatchObject({
          _tag: "DeepAgentLearningJob.InputError",
          field: "kind",
          reason: "running requires extraction",
        })
        expect(yield* DeepAgentLearningJob.get(db, claimed.jobId)).toMatchObject({
          state: "running",
          sideEffectState: "not_started",
          sideEffectKind: null,
          version: claimed.version,
        })
      }),
    )
  })

  test("cannot skip the settled reviewing phase before governance", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* DeepAgentLearningJob.enqueue(db, enqueueInput())
        const claimed = (yield* DeepAgentLearningJob.claim(db, {
          owner: "worker-a",
          leaseMs: 100,
          now: 10,
        }))!
        const extracting = yield* DeepAgentLearningJob.beginSideEffect(db, {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: claimed.version,
          state: "running",
          kind: "extraction",
          expectedResultRef: "candidate-set:run-1",
          now: 11,
        })
        const extracted = yield* DeepAgentLearningJob.settleSideEffect(db, {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: extracting.version,
          resultRef: "candidate-set:run-1",
          now: 12,
        })

        expect(
          yield* DeepAgentLearningJob.advance(db, {
            jobId: claimed.jobId,
            owner: "worker-a",
            expectedVersion: extracted.version,
            state: "governance",
            now: 13,
          }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "DeepAgentLearningJob.FenceError",
          reason: "advance requires a settled prior stage and a live fence",
        })
        expect(yield* DeepAgentLearningJob.get(db, claimed.jobId)).toMatchObject({
          state: "running",
          sideEffectState: "settled",
          sideEffectKind: "extraction",
          version: extracted.version,
        })
      }),
    )
  })

  test("requeues an expired claim only when no side effect started", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* DeepAgentLearningJob.enqueue(db, enqueueInput())
        const claimed = yield* DeepAgentLearningJob.claim(db, { owner: "worker-a", leaseMs: 10, now: 100 })
        expect(claimed).toBeDefined()

        const recovered = yield* DeepAgentLearningJob.recoverStale(db, { now: 111 })
        expect(recovered.requeued).toHaveLength(1)
        expect(recovered.recoveryRequired).toHaveLength(0)
        expect(recovered.requeued[0]).toMatchObject({
          state: "queued",
          owner: null,
          version: 2,
          errorCode: "lease_expired_before_side_effect",
        })
        expect(yield* DeepAgentLearningJob.claim(db, { owner: "worker-b", leaseMs: 10, now: 111 })).toMatchObject({
          state: "running",
          owner: "worker-b",
          attempts: 2,
          version: 3,
        })
      }),
    )
  })

  test("moves an expired provider or reviewer side effect to recovery_required", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* DeepAgentLearningJob.enqueue(db, enqueueInput())
        const claimed = yield* DeepAgentLearningJob.claim(db, { owner: "worker-a", leaseMs: 20, now: 100 })
        const extracting = yield* DeepAgentLearningJob.beginSideEffect(db, {
          jobId: claimed!.jobId,
          owner: "worker-a",
          expectedVersion: claimed!.version,
          state: "running",
          kind: "extraction",
          expectedResultRef: "candidate-set:run-1",
          leaseMs: 20,
          now: 101,
        })
        const extracted = yield* DeepAgentLearningJob.settleSideEffect(db, {
          jobId: claimed!.jobId,
          owner: "worker-a",
          expectedVersion: extracting.version,
          resultRef: "candidate-set:run-1",
          now: 102,
        })
        const reviewStage = yield* DeepAgentLearningJob.advance(db, {
          jobId: claimed!.jobId,
          owner: "worker-a",
          expectedVersion: extracted.version,
          state: "reviewing",
          leaseMs: 10,
          now: 103,
        })
        const reviewing = yield* DeepAgentLearningJob.beginSideEffect(db, {
          jobId: claimed!.jobId,
          owner: "worker-a",
          expectedVersion: reviewStage.version,
          state: "reviewing",
          kind: "reviewer",
          expectedResultRef: "review-receipt:review-1",
          reviewJobId: "review-1",
          leaseMs: 10,
          now: 104,
        })

        const unsafeSettlement = yield* DeepAgentLearningJob.settle(db, {
          jobId: claimed!.jobId,
          owner: "worker-a",
          expectedVersion: reviewing.version,
          state: "failed",
          errorCode: "reviewer-disconnected",
          now: 105,
        }).pipe(Effect.flip)
        expect(unsafeSettlement).toMatchObject({ _tag: "DeepAgentLearningJob.FenceError" })

        const recovered = yield* DeepAgentLearningJob.recoverStale(db, { now: 115 })
        expect(recovered.requeued).toHaveLength(0)
        expect(recovered.recoveryRequired).toHaveLength(1)
        expect(recovered.recoveryRequired[0]).toMatchObject({
          jobId: reviewing.jobId,
          state: "recovery_required",
          sideEffectState: "started",
          sideEffectKind: "reviewer",
          reviewJobId: "review-1",
          owner: null,
          errorCode: "ambiguous_side_effect_after_lease_expiry",
        })
        expect(yield* DeepAgentLearningJob.claim(db, { owner: "worker-b", leaseMs: 10, now: 115 })).toBeUndefined()
      }),
    )
  })

  test("advances settled phase receipts after a crash without replaying side effects", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* DeepAgentLearningJob.enqueue(db, enqueueInput())
        const claimed = (yield* DeepAgentLearningJob.claim(db, {
          owner: "worker-a",
          leaseMs: 10,
          now: 100,
        }))!
        const extracting = yield* DeepAgentLearningJob.beginSideEffect(db, {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: claimed.version,
          state: "running",
          kind: "extraction",
          expectedResultRef: "candidate-set:run-1",
          now: 101,
        })
        yield* DeepAgentLearningJob.settleSideEffect(db, {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: extracting.version,
          resultRef: "candidate-set:run-1",
          now: 102,
        })

        const extractionRecovery = yield* DeepAgentLearningJob.recoverStale(db, { now: 111 })
        expect(extractionRecovery.requeued).toHaveLength(1)
        expect(extractionRecovery.completed).toHaveLength(0)
        expect(extractionRecovery.requeued[0]).toMatchObject({
          state: "reviewing",
          owner: null,
          attempts: 1,
          sideEffectState: "not_started",
          resultRef: "candidate-set:run-1",
        })

        const reviewStage = (yield* DeepAgentLearningJob.claim(db, {
          owner: "worker-b",
          leaseMs: 10,
          now: 111,
        }))!
        expect(reviewStage).toMatchObject({ state: "reviewing", attempts: 1, owner: "worker-b" })
        const reviewing = yield* DeepAgentLearningJob.beginSideEffect(db, {
          jobId: claimed.jobId,
          owner: "worker-b",
          expectedVersion: reviewStage.version,
          state: "reviewing",
          kind: "reviewer",
          expectedResultRef: "review-receipt:review-1",
          reviewJobId: "review-1",
          now: 112,
        })
        yield* DeepAgentLearningJob.settleSideEffect(db, {
          jobId: claimed.jobId,
          owner: "worker-b",
          expectedVersion: reviewing.version,
          resultRef: "review-receipt:review-1",
          now: 113,
        })

        const reviewRecovery = yield* DeepAgentLearningJob.recoverStale(db, { now: 123 })
        expect(reviewRecovery.requeued[0]).toMatchObject({
          state: "governance",
          owner: null,
          attempts: 1,
          sideEffectState: "not_started",
          resultRef: "review-receipt:review-1",
        })
        const governanceStage = (yield* DeepAgentLearningJob.claim(db, {
          owner: "worker-c",
          leaseMs: 10,
          now: 123,
        }))!
        const governing = yield* DeepAgentLearningGovernance.prepare(db, {
          jobId: claimed.jobId,
          owner: "worker-c",
          expectedJobVersion: governanceStage.version,
          leaseMs: 10,
          actions: [],
          now: 124,
        })
        yield* DeepAgentLearningGovernance.settlePlan(db, {
          planId: governing.plan.planId,
          owner: "worker-c",
          expectedVersion: governing.plan.version,
          resultRef: "document:candidate-1@1",
          resultHash: Hash.sha256("document:candidate-1@1"),
          now: 125,
        })

        const governanceRecovery = yield* DeepAgentLearningJob.recoverStale(db, { now: 134 })
        expect(governanceRecovery.requeued).toHaveLength(0)
        expect(governanceRecovery.recoveryRequired).toHaveLength(0)
        expect(governanceRecovery.completed[0]).toMatchObject({
          state: "completed",
          owner: null,
          attempts: 1,
          resultRef: "document:candidate-1@1",
        })
        expect(governanceRecovery.completed[0]?.settlementFingerprint).toMatch(/^[0-9a-f]{64}$/)
        expect(yield* DeepAgentLearningJob.claim(db, { owner: "worker-d", leaseMs: 10, now: 134 })).toBeUndefined()
      }),
    )
  })

  test("rejects the wrong owner, supports delayed retry, and fences the next attempt", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* DeepAgentLearningJob.enqueue(db, enqueueInput())
        const claimed = yield* DeepAgentLearningJob.claim(db, { owner: "worker-a", leaseMs: 100, now: 10 })

        const wrongOwner = yield* DeepAgentLearningJob.settle(db, {
          jobId: claimed!.jobId,
          owner: "worker-b",
          expectedVersion: claimed!.version,
          state: "failed",
          errorCode: "wrong-owner",
          now: 11,
        }).pipe(Effect.flip)
        expect(wrongOwner).toMatchObject({ _tag: "DeepAgentLearningJob.FenceError", jobId: claimed!.jobId })
        expect(yield* DeepAgentLearningJob.get(db, claimed!.jobId)).toMatchObject({
          state: "running",
          owner: "worker-a",
          version: 1,
        })

        const queued = yield* DeepAgentLearningJob.retry(db, {
          jobId: claimed!.jobId,
          owner: "worker-a",
          expectedVersion: claimed!.version,
          delayMs: 20,
          errorCode: "transient_before_dispatch",
          now: 11,
        })
        expect(queued).toMatchObject({ state: "queued", owner: null, nextAttemptAt: 31, version: 2 })
        expect(yield* DeepAgentLearningJob.claim(db, { owner: "worker-b", leaseMs: 100, now: 30 })).toBeUndefined()
        expect(yield* DeepAgentLearningJob.claim(db, { owner: "worker-b", leaseMs: 100, now: 31 })).toMatchObject({
          state: "running",
          owner: "worker-b",
          attempts: 2,
          version: 3,
        })
      }),
    )
  })

  test("requires the governance receipt for completion and enforces the admitted retry budget", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* DeepAgentLearningJob.enqueue(db, { ...enqueueInput(), maxAttempts: 1 })
        const claimed = (yield* DeepAgentLearningJob.claim(db, {
          owner: "worker-a",
          leaseMs: 10,
          now: 100,
        }))!

        expect(
          yield* DeepAgentLearningJob.settle(db, {
            jobId: claimed.jobId,
            owner: "worker-a",
            expectedVersion: claimed.version,
            state: "completed",
            resultRef: "document:candidate-1@1",
            now: 101,
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "DeepAgentLearningJob.FenceError" })
        expect(
          yield* DeepAgentLearningJob.retry(db, {
            jobId: claimed.jobId,
            owner: "worker-a",
            expectedVersion: claimed.version,
            delayMs: 0,
            errorCode: "transient_before_dispatch",
            now: 101,
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "DeepAgentLearningJob.FenceError" })

        const recovered = yield* DeepAgentLearningJob.recoverStale(db, { now: 111 })
        expect(recovered.failed).toHaveLength(1)
        expect(recovered.failed[0]).toMatchObject({
          state: "failed",
          attempts: 1,
          maxAttempts: 1,
          errorCode: "attempt_limit_exhausted_after_lease_expiry",
        })
      }),
    )
  })

  test("returns the same terminal receipt for an exact settlement retry", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* DeepAgentLearningJob.enqueue(db, enqueueInput())
        const claimed = (yield* DeepAgentLearningJob.claim(db, {
          owner: "worker-a",
          leaseMs: 100,
          now: 10,
        }))!
        const extracting = yield* DeepAgentLearningJob.beginSideEffect(db, {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: claimed.version,
          state: "running",
          kind: "extraction",
          expectedResultRef: "candidate-set:run-1",
          now: 11,
        })
        const extracted = yield* DeepAgentLearningJob.settleSideEffect(db, {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: extracting.version,
          resultRef: "candidate-set:run-1",
          now: 12,
        })
        const reviewStage = yield* DeepAgentLearningJob.advance(db, {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: extracted.version,
          state: "reviewing",
          now: 13,
        })
        const reviewing = yield* DeepAgentLearningJob.beginSideEffect(db, {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: reviewStage.version,
          state: "reviewing",
          kind: "reviewer",
          expectedResultRef: "review-receipt:review-1",
          reviewJobId: "review-1",
          now: 14,
        })
        const reviewed = yield* DeepAgentLearningJob.settleSideEffect(db, {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: reviewing.version,
          resultRef: "review-receipt:review-1",
          now: 15,
        })
        const governanceStage = yield* DeepAgentLearningJob.advance(db, {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: reviewed.version,
          state: "governance",
          now: 16,
        })
        const governing = yield* DeepAgentLearningGovernance.prepare(db, {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedJobVersion: governanceStage.version,
          leaseMs: 100,
          actions: [],
          now: 17,
        })
        const governed = yield* DeepAgentLearningGovernance.settlePlan(db, {
          planId: governing.plan.planId,
          owner: "worker-a",
          expectedVersion: governing.plan.version,
          resultRef: "document:candidate-1@1",
          resultHash: Hash.sha256("document:candidate-1@1"),
          now: 18,
        })
        const settlement = {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: governed.plan.jobStartedVersion + 1,
          state: "completed" as const,
          resultRef: "document:candidate-1@1",
          now: 19,
        }

        expect(
          yield* DeepAgentLearningJob.settle(db, {
            ...settlement,
            resultRef: "document:candidate-2@1",
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "DeepAgentLearningJob.FenceError" })
        expect(yield* DeepAgentLearningJob.get(db, claimed.jobId)).toMatchObject({
          state: "governance",
          version: governed.plan.jobStartedVersion + 1,
          resultRef: "document:candidate-1@1",
        })

        const first = yield* DeepAgentLearningJob.settle(db, settlement)
        const retry = yield* DeepAgentLearningJob.settle(db, settlement)
        expect(first).toMatchObject({ state: "completed", owner: null, version: 10 })
        expect(retry).toEqual(first)
        expect(first.settlementFingerprint).toMatch(/^[0-9a-f]{64}$/)
      }),
    )
  })

  test("binds side-effect settlement to the immutable expected artifact ref", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* DeepAgentLearningJob.enqueue(db, enqueueInput())
        const claimed = (yield* DeepAgentLearningJob.claim(db, { owner: "worker-a", leaseMs: 100, now: 10 }))!
        const started = yield* DeepAgentLearningJob.beginSideEffect(db, {
          jobId: claimed.jobId,
          owner: "worker-a",
          expectedVersion: claimed.version,
          state: "running",
          kind: "extraction",
          expectedResultRef: "artifact:expected",
          now: 11,
        })

        expect(
          yield* DeepAgentLearningJob.settleSideEffect(db, {
            jobId: claimed.jobId,
            owner: "worker-a",
            expectedVersion: started.version,
            resultRef: "artifact:other",
            now: 12,
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "DeepAgentLearningJob.FenceError" })
        expect(
          yield* db
            .update(LearningJobTable)
            .set({ expected_result_ref: "artifact:rewritten", version: started.version + 1 })
            .where(eq(LearningJobTable.job_id, claimed.jobId))
            .run()
            .pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
        expect(yield* DeepAgentLearningJob.get(db, claimed.jobId)).toMatchObject({
          state: "running",
          sideEffectState: "started",
          expectedResultRef: "artifact:expected",
          resultRef: null,
          version: started.version,
        })
      }),
    )
  })

  test("migration creates the scheduling indexes and protects immutable identity", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const indexes = yield* db.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'learning_job' ORDER BY name",
        )
        expect(indexes.map((index) => index.name)).toEqual([
          "learning_job_dedupe_idx",
          "learning_job_due_idx",
          "learning_job_owner_lease_idx",
          "learning_job_project_created_idx",
          "sqlite_autoindex_learning_job_1",
        ])

        const admitted = yield* DeepAgentLearningJob.enqueue(db, enqueueInput())
        expect(
          yield* DeepAgentLearningJob.enqueue(db, {
            ...enqueueInput(),
            projectId: "project-2",
            dedupeKey: "final:scope-mismatch",
          }).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
        expect(
          yield* db
            .update(LearningJobTable)
            .set({ project_id: "other-project", version: 1 })
            .where(eq(LearningJobTable.job_id, admitted.job.jobId))
            .run()
            .pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
      }),
    )
  })

  test("migration quarantines legacy rows that already crossed an artifact phase boundary", async () => {
    await runBeforeArtifactMigration(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run(`
          INSERT INTO learning_job (
            job_id, project_id, session_id, run_id, trigger, dedupe_key, candidate_input_ref, policy,
            max_attempts, admission_fingerprint, state, attempts, owner, lease_expires_at, version,
            side_effect_state, side_effect_kind, review_job_id, result_ref, next_attempt_at,
            created_at, started_at, updated_at
          ) VALUES
            ('legacy-queued', 'project-1', 'session-1', 'run-queued', 'session_finalization',
              'legacy-queued', 'input:queued', 'manual_review', 3, '${"a".repeat(64)}',
              'queued', 0, NULL, NULL, 0, 'not_started', NULL, NULL, NULL, 1, 1, NULL, 1),
            ('legacy-running-safe', 'project-1', 'session-1', 'run-running-safe', 'session_finalization',
              'legacy-running-safe', 'input:running-safe', 'manual_review', 3, '${"b".repeat(64)}',
              'running', 1, 'worker-safe', 999, 1, 'not_started', NULL, NULL, NULL, 1, 1, 1, 1),
            ('legacy-extracted', 'project-1', 'session-1', 'run-extracted', 'session_finalization',
              'legacy-extracted', 'input:extracted', 'manual_review', 3, '${"c".repeat(64)}',
              'running', 1, 'worker-old', 999, 2, 'settled', 'extraction', NULL, 'artifact:legacy', 1, 1, 1, 1),
            ('legacy-reviewing', 'project-1', 'session-1', 'run-reviewing', 'session_finalization',
              'legacy-reviewing', 'input:reviewing', 'manual_review', 3, '${"d".repeat(64)}',
              'reviewing', 1, NULL, NULL, 3, 'not_started', NULL, NULL, 'artifact:legacy', 1, 1, 1, 1)
        `)

        yield* DatabaseMigration.applyOnly(db, [learningArtifactSchemaMigration, learningArtifactPhaseReceiptMigration])

        expect(
          yield* db.all(
            "SELECT job_id, state, side_effect_state, side_effect_kind, expected_result_ref, error_code FROM learning_job ORDER BY job_id",
          ),
        ).toEqual([
          {
            job_id: "legacy-extracted",
            state: "recovery_required",
            side_effect_state: "unknown",
            side_effect_kind: "extraction",
            expected_result_ref: null,
            error_code: "legacy_artifact_plan_missing",
          },
          {
            job_id: "legacy-queued",
            state: "queued",
            side_effect_state: "not_started",
            side_effect_kind: null,
            expected_result_ref: null,
            error_code: null,
          },
          {
            job_id: "legacy-reviewing",
            state: "recovery_required",
            side_effect_state: "unknown",
            side_effect_kind: "reviewer",
            expected_result_ref: null,
            error_code: "legacy_artifact_plan_missing",
          },
          {
            job_id: "legacy-running-safe",
            state: "running",
            side_effect_state: "not_started",
            side_effect_kind: null,
            expected_result_ref: null,
            error_code: null,
          },
        ])
      }),
    )
  })
})

function enqueueInput(): DeepAgentLearningJob.EnqueueInput {
  return {
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-1",
    trigger: "session_finalization",
    dedupeKey: "final:run-1",
    candidateInputRef: "run-manifest:run-1",
    policy: "manual_review",
    now: 1,
  }
}

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.run(
        "INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('project-1', '/tmp/project-1', '[]', 1, 1), ('project-2', '/tmp/project-2', '[]', 1, 1)",
      )
      yield* db.run(
        "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session-1', 'project-1', 'session-1', '/tmp/project-1', 'Learning', '1', 1, 1)",
      )
      yield* DatabaseMigration.applyOnly(db, [
        learningJobMigration,
        learningGovernanceSchemaMigration,
        learningGovernanceLifecycleMigration,
        learningArtifactPhaseReceiptMigration,
      ])
      return yield* effect
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}

function runBeforeArtifactMigration<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA foreign_keys = ON")
      const migrationIndex = migrations.findIndex((migration) => migration.id === learningArtifactSchemaMigration.id)
      if (migrationIndex < 0) return yield* Effect.die("learning artifact schema migration is not registered")
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, migrationIndex))
      yield* db.run(
        "INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('project-1', '/tmp/project-1', '[]', 1, 1)",
      )
      yield* db.run(
        "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session-1', 'project-1', 'session-1', '/tmp/project-1', 'Learning', '1', 1, 1)",
      )
      return yield* effect.pipe(Effect.provideService(Database.Service, { db }))
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
}
