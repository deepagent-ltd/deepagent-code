import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { count, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import learningArtifactPhaseReceiptMigration from "../../src/database/migration/20260812224000_learning_artifact_phase_receipt"
import learningGovernanceCompensationMigration from "../../src/database/migration/20260813041300_learning_governance_compensation_authority"
import { DeepAgentDurableLearning } from "../../src/deepagent/durable-learning"
import { DurableKnowledgeStore, projectIdForWorkspace } from "../../src/deepagent/durable-knowledge-store"
import { DeepAgentLearningAdmissionOutbox } from "../../src/deepagent/learning-admission-outbox"
import { LearningAdmissionOutboxTable } from "../../src/deepagent/learning-admission-outbox.sql"
import { DeepAgentLearningJob } from "../../src/deepagent/learning-job"
import { LearningJobTable } from "../../src/deepagent/learning-job.sql"
import { DeepAgentLearningReviewerAttempt } from "../../src/deepagent/learning-reviewer-attempt"
import { documentRevision } from "../../src/deepagent/document-store"
import { fingerprint } from "../../src/deepagent/promotion"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { createInitialRoundState } from "../../src/deepagent/round-state"
import { AbsolutePath } from "../../src/schema"
import { SessionSchema } from "../../src/session/schema"
import { SessionTable } from "../../src/session/sql"
import { CanonicalJson } from "../../src/util/canonical-json"
import { Hash } from "../../src/util/hash"
import { DeepAgentCodeHome } from "../../src/deepagent/workspace"

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-durable-learning-"))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("durable learning production pipeline", () => {
  test("persists one exact finalization admission and executes all durable phases", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const input = admission("run-1")
        const first = yield* DeepAgentDurableLearning.admit(db, input, { authorityRoot: root })
        const retry = yield* DeepAgentDurableLearning.admit(db, input, { authorityRoot: root })

        expect(first.created).toBe(true)
        expect(retry.created).toBe(false)
        expect(retry.job).toEqual(first.job)
        expect(
          yield* db
            .select({ count: count() })
            .from(LearningJobTable)
            .where(eq(LearningJobTable.dedupe_key, "session_finalization:project-db-1:ses_learning:run-1"))
            .get(),
        ).toEqual({ count: 1 })
        expect(first.job.projectId).toBe("project-db-1")
        expect(
          yield* db
            .select({ state: LearningAdmissionOutboxTable.state, jobId: LearningAdmissionOutboxTable.job_id })
            .from(LearningAdmissionOutboxTable)
            .get(),
        ).toEqual({ state: "admitted", jobId: first.job.jobId })

        const ref = JSON.parse(first.job.candidateInputRef) as { path: string; sha256: string }
        expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(existsSync(ref.path)).toBe(true)

        const completed = yield* DeepAgentDurableLearning.drain(db, { owner: "worker-1", authorityRoot: root })
        expect(completed).toHaveLength(1)
        expect(completed[0]).toMatchObject({
          jobId: first.job.jobId,
          state: "completed",
          attempts: 1,
          sideEffectState: "settled",
          sideEffectKind: "governance",
          owner: null,
        })
        expect(completed[0]?.reviewJobId).toBe(`review-unavailable:${first.job.jobId}`)

        const store = new DurableKnowledgeStore(path.join(root, "project", knowledgeProjectID(), "knowledge"))
        expect(store.listByStatus("active")).toHaveLength(1)
        expect(store.listByStatus("candidate")).toHaveLength(0)
        expect(existsSync(path.join(root, "project", "forged-knowledge-project"))).toBe(false)
      }),
    )
  })

  test("reconciles a persisted terminal intent on worker startup before claiming learning jobs", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const input = admission("run-pending-intent")
        const terminal = terminalState(
          "run-pending-intent",
          "high",
          "completed",
          input.terminalArtifact.learning_admission_fingerprint,
        )
        writeFileSync(
          input.terminalArtifact.path,
          terminalState("run-pending-intent", "high", "opened", input.terminalArtifact.learning_admission_fingerprint),
        )
        const persisted = yield* DeepAgentDurableLearning.record(db, input)

        expect(persisted.intent).toMatchObject({ state: "pending", jobId: null, candidateInputRef: null })
        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 0 })
        expect(
          yield* DeepAgentDurableLearning.drain(db, { owner: "worker-too-early", authorityRoot: root }),
        ).toHaveLength(0)
        expect(yield* DeepAgentLearningAdmissionOutbox.get(db, persisted.intent.intentId)).toMatchObject({
          state: "pending",
          jobId: null,
        })

        writeFileSync(input.terminalArtifact.path, terminal)
        const completed = yield* DeepAgentDurableLearning.drain(db, { owner: "worker-reconcile", authorityRoot: root })
        expect(completed).toHaveLength(1)
        expect(completed[0]).toMatchObject({ runId: "run-pending-intent", state: "completed" })
        expect(yield* DeepAgentLearningAdmissionOutbox.get(db, persisted.intent.intentId)).toMatchObject({
          state: "admitted",
          jobId: completed[0]?.jobId,
          candidateInputRef: completed[0]?.candidateInputRef,
        })
      }),
    )
  })

  test("rejects a terminal artifact whose exact content no longer matches the recorded intent", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const input = admission("run-terminal-mismatch")
        const persisted = yield* DeepAgentDurableLearning.record(db, input)
        writeFileSync(
          input.terminalArtifact.path,
          `${JSON.stringify({
            schema_version: "deepagent_global_run_state.v1",
            run_id: "run-terminal-mismatch",
            generic_agent_session_id: "ses_learning",
            agent_mode: "high",
            state: "failed",
          })}\n`,
        )

        yield* DeepAgentDurableLearning.reconcile(db, { authorityRoot: root })

        expect(yield* DeepAgentLearningAdmissionOutbox.get(db, persisted.intent.intentId)).toMatchObject({
          state: "rejected",
          rejectionCode: "learning_admission_reconciliation_failed",
          rejectionDetail: "Learning terminal artifact hash does not match the durable admission intent",
        })
        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 0 })
      }),
    )
  })

  test("reuses an immutable input artifact when startup reconciliation finds no learning job", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const input = admission("run-artifact-only")
        const persisted = yield* DeepAgentDurableLearning.record(db, input)
        const manifest = {
          schema_version: "deepagent-code.learning_input.v1",
          base_dir: root,
          workspace_path: path.join(root, "workspace"),
          rejected_buffer_dir: path.join(root, "memory"),
          database_project_id: "project-db-1",
          knowledge_project_id: knowledgeProjectID(),
          session_id: "ses_learning",
          run_id: "run-artifact-only",
          mode: "high",
          diagnoses: [],
          total_rounds: 1,
          final_status: "completed",
          trigger: "session_finalization",
          policy: "auto_merge_safe_project",
          terminal_artifact: input.terminalArtifact,
        } as const
        const content = CanonicalJson.stringify(manifest)
        const file = path.join(
          new DeepAgentCodeHome(root).ensureRun(knowledgeProjectID(), "ses_learning", "run-artifact-only").artifactsDir,
          `learning-input-${Hash.sha256(content)}.json`,
        )
        writeFileSync(file, content)

        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 0 })
        yield* DeepAgentDurableLearning.reconcile(db, { authorityRoot: root })

        const receipt = yield* DeepAgentLearningAdmissionOutbox.get(db, persisted.intent.intentId)
        expect(receipt).toMatchObject({ state: "admitted" })
        expect(JSON.parse(receipt!.candidateInputRef!)).toMatchObject({ path: file, sha256: Hash.sha256(content) })
        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 1 })
      }),
    )
  })

  test("settles invalid terminal intents as durable rejection receipts without creating a job", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const input = admission("run-invalid-session")
        const persisted = yield* DeepAgentDurableLearning.record(db, {
          ...input,
          input: { ...input.input, sessionID: "ses_missing" },
        })

        yield* DeepAgentDurableLearning.reconcile(db, { authorityRoot: root })

        expect(yield* DeepAgentLearningAdmissionOutbox.get(db, persisted.intent.intentId)).toMatchObject({
          state: "rejected",
          jobId: null,
          rejectionCode: "DeepAgentLearningJob.InputError",
          rejectionDetail: "must reference an existing canonical Session",
          settledAt: expect.any(Number),
        })
        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 0 })
      }),
    )
  })

  test("retains reviewer-required candidates pending when the isolated reviewer is unavailable", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const roundState = createInitialRoundState("max")
        roundState.diagnoses.push({
          round: 1,
          root_cause: "api_key leaked into the generated configuration",
          evidence_refs: ["run:run-sensitive:r1"],
          next_action: "revise",
        })
        const input = admission("run-sensitive", "max")
        const admitted = yield* DeepAgentDurableLearning.admit(
          db,
          bindAdmission({
            ...input,
            input: {
              ...input.input,
              mode: "max",
              roundState,
              totalRounds: 2,
            },
          }),
          { authorityRoot: root },
        )

        const completed = yield* DeepAgentDurableLearning.drain(db, { owner: "worker-1", authorityRoot: root })
        expect(completed).toHaveLength(1)
        expect(completed[0]).toMatchObject({ jobId: admitted.job.jobId, state: "completed" })

        const store = new DurableKnowledgeStore(path.join(root, "project", knowledgeProjectID(), "knowledge"))
        expect(store.listByStatus("active")).toHaveLength(0)
        expect(store.listByStatus("candidate")).toHaveLength(1)
        expect(existsSync(path.join(root, "project", knowledgeProjectID(), "docs", "memory-inbox"))).toBe(true)
      }),
    )
  })

  test("binds a fresh isolated reviewer receipt to the exact candidate subset consumed by governance", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const roundState = createInitialRoundState("max")
        roundState.diagnoses.push(
          {
            round: 1,
            root_cause: "The generated API client used the wrong endpoint.",
            evidence_refs: ["run:run-isolated-reviewer:r1"],
            next_action: "revise",
          },
          {
            round: 2,
            root_cause: "The retry policy treated a terminal response as transient.",
            evidence_refs: ["run:run-isolated-reviewer:r2"],
            next_action: "revise",
          },
        )
        const source = admission("run-isolated-reviewer", "max")
        const admitted = yield* DeepAgentDurableLearning.admit(
          db,
          bindAdmission({
            ...source,
            input: { ...source.input, roundState, totalRounds: 3 },
          }),
          { authorityRoot: root },
        )
        const reviewerCalls: unknown[] = []
        const completed = yield* DeepAgentDurableLearning.drain(db, {
          owner: "worker-isolated-reviewer",
          authorityRoot: root,
          reviewer: {
            identity: ({ attemptId, workspacePath }) =>
              Effect.succeed({
                reviewSessionId: `ses-review:${attemptId}`,
                providerId: "provider-review",
                modelId: "model-review",
                policyHash: Hash.sha256(workspacePath),
              }),
            execute: (request) =>
              Effect.sync(() => {
                const input = JSON.parse(request.request) as {
                  candidates: readonly Record<string, unknown>[]
                }
                reviewerCalls.push(input)
                expect(Object.keys(input).toSorted()).toEqual(["candidates", "instructions", "schema_version"])
                expect(input.candidates).toHaveLength(2)
                expect(Object.keys(input.candidates[0]!).toSorted()).toEqual([
                  "candidate_id",
                  "confidence",
                  "evidence_refs",
                  "source_run_id",
                  "summary",
                  "type",
                ])
                return {
                  verdict: "manual_review" as const,
                  selectedCandidateIds: [input.candidates[0]!.candidate_id as string],
                }
              }),
          },
        })

        expect(completed).toHaveLength(1)
        expect(completed[0]).toMatchObject({ jobId: admitted.job.jobId, state: "completed" })
        expect(reviewerCalls).toHaveLength(1)
        expect(yield* DeepAgentLearningReviewerAttempt.getByJob(db, admitted.job.jobId)).toMatchObject({
          state: "settled",
          reviewSessionId: `ses-review:review:${admitted.job.jobId}`,
          providerId: "provider-review",
          modelId: "model-review",
          verdict: "manual_review",
          selectedCandidateIds: ["strategy:run-isolated-reviewer:diagnosis-led-fix:r1"],
        })
        const store = new DurableKnowledgeStore(path.join(root, "project", knowledgeProjectID(), "knowledge"))
        expect(store.listByStatus("candidate").map((document) => document.description)).toEqual([
          'Diagnosis identified "The generated API client used the wrong endpoint." which led to successful fix.',
        ])
        expect(
          yield* DeepAgentDurableLearning.drain(db, {
            owner: "worker-isolated-reviewer-retry",
            authorityRoot: root,
            reviewer: {
              identity: () => Effect.die("reviewer must not run again"),
              execute: () => Effect.die("reviewer must not run again"),
            },
          }),
        ).toEqual([])
      }),
    )
  })

  test("quarantines a dispatched reviewer failure without replaying the provider", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const admitted = yield* DeepAgentDurableLearning.admit(db, admission("run-reviewer-failure"), {
          authorityRoot: root,
        })
        const providerCalls: string[] = []
        const reviewer = {
          identity: ({ attemptId }: { readonly attemptId: string }) =>
            Effect.succeed({
              reviewSessionId: `ses-review:${attemptId}`,
              providerId: "provider-review",
              modelId: "model-review",
              policyHash: "a".repeat(64),
            }),
          execute: ({ attemptId }: { readonly attemptId: string }) =>
            Effect.sync(() => providerCalls.push(attemptId)).pipe(
              Effect.flatMap(() => Effect.fail(new Error("reviewer provider connection closed after dispatch"))),
            ),
        } satisfies DeepAgentDurableLearning.ReviewerPort

        expect(
          yield* DeepAgentDurableLearning.drain(db, {
            owner: "worker-reviewer-failure",
            authorityRoot: root,
            reviewer,
          }).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
        expect(providerCalls).toEqual([`review:${admitted.job.jobId}`])
        expect(yield* DeepAgentLearningReviewerAttempt.getByJob(db, admitted.job.jobId)).toMatchObject({
          state: "recovery_required",
          errorCode: "reviewer_dispatch_indeterminate",
        })
        expect(yield* DeepAgentLearningJob.get(db, admitted.job.jobId)).toMatchObject({
          state: "recovery_required",
          owner: null,
          errorCode: "reviewer_dispatch_indeterminate",
        })
        expect(
          yield* DeepAgentDurableLearning.drain(db, {
            owner: "worker-reviewer-failure-retry",
            authorityRoot: root,
            reviewer,
          }),
        ).toEqual([])
        expect(providerCalls).toHaveLength(1)
      }),
    )
  })

  test("takes over an expired prepared reviewer without creating a second review session", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const admitted = yield* DeepAgentDurableLearning.admit(db, admission("run-reviewer-prepared-takeover"), {
          authorityRoot: root,
        })
        const identities: string[] = []
        const executions: string[] = []
        const reviewer = {
          identity: ({ attemptId }: { readonly attemptId: string }) =>
            Effect.sync(() => {
              identities.push(attemptId)
              return {
                reviewSessionId: `ses-review:${attemptId}`,
                providerId: "provider-review",
                modelId: "model-review",
                policyHash: "a".repeat(64),
              }
            }),
          execute: (input: { readonly attemptId: string; readonly request: string }) =>
            Effect.sync(() => {
              executions.push(input.attemptId)
              const request = JSON.parse(input.request) as { candidates: readonly { candidate_id: string }[] }
              return { verdict: "approve" as const, selectedCandidateIds: [request.candidates[0]!.candidate_id] }
            }),
        } satisfies DeepAgentDurableLearning.ReviewerPort
        yield* db.run(sql`
          CREATE TRIGGER learning_reviewer_dispatch_crash
          BEFORE UPDATE OF state ON learning_reviewer_attempt
          WHEN NEW.state = 'dispatching'
          BEGIN SELECT RAISE(ABORT, 'simulated crash before reviewer dispatch'); END
        `)

        expect(
          yield* DeepAgentDurableLearning.drain(db, {
            owner: "reviewer-owner-expired",
            authorityRoot: root,
            leaseMs: 10_000,
            reviewer,
          }).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
        expect(identities).toHaveLength(1)
        expect(executions).toHaveLength(0)
        expect(yield* DeepAgentLearningReviewerAttempt.getByJob(db, admitted.job.jobId)).toMatchObject({
          state: "prepared",
          owner: "reviewer-owner-expired",
        })

        yield* db.run("DROP TRIGGER learning_reviewer_dispatch_crash")
        yield* db.run(sql`
          UPDATE learning_job
          SET lease_expires_at = 1, version = version + 1, updated_at = updated_at + 1
          WHERE job_id = ${admitted.job.jobId}
        `)
        const completed = yield* DeepAgentDurableLearning.drain(db, {
          owner: "reviewer-owner-takeover",
          authorityRoot: root,
          leaseMs: 10_000,
          reviewer: {
            identity: () => Effect.die("prepared takeover must reuse the frozen reviewer session"),
            execute: reviewer.execute,
          },
        })

        expect(completed).toHaveLength(1)
        expect(completed[0]).toMatchObject({ state: "completed", jobId: admitted.job.jobId })
        expect(identities).toHaveLength(1)
        expect(executions).toEqual([`review:${admitted.job.jobId}`])
        expect(yield* DeepAgentLearningReviewerAttempt.getByJob(db, admitted.job.jobId)).toMatchObject({
          state: "settled",
          owner: "reviewer-owner-takeover",
        })
      }),
    )
  })

  test("quarantines an expired dispatch receipt before the learning worker can replay it", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const admitted = yield* DeepAgentDurableLearning.admit(db, admission("run-reviewer-dispatch-crash"), {
          authorityRoot: root,
        })
        yield* db.run(sql`
          CREATE TRIGGER learning_reviewer_dispatch_crash
          BEFORE UPDATE OF state ON learning_reviewer_attempt
          WHEN NEW.state = 'dispatching'
          BEGIN SELECT RAISE(ABORT, 'simulated crash before reviewer dispatch'); END
        `)
        const reviewer = {
          identity: ({ attemptId }: { readonly attemptId: string }) =>
            Effect.succeed({
              reviewSessionId: `ses-review:${attemptId}`,
              providerId: "provider-review",
              modelId: "model-review",
              policyHash: "a".repeat(64),
            }),
          execute: () => Effect.die("provider must not be called by setup or recovery"),
        } satisfies DeepAgentDurableLearning.ReviewerPort
        yield* DeepAgentDurableLearning.drain(db, {
          owner: "reviewer-dispatch-owner",
          authorityRoot: root,
          leaseMs: 10_000,
          reviewer,
        }).pipe(Effect.exit)
        yield* db.run("DROP TRIGGER learning_reviewer_dispatch_crash")
        const attempt = (yield* DeepAgentLearningReviewerAttempt.getByJob(db, admitted.job.jobId))!
        yield* DeepAgentLearningReviewerAttempt.dispatch(db, {
          attemptId: attempt.attemptId,
          owner: "reviewer-dispatch-owner",
          expectedVersion: attempt.version,
        })
        yield* db.run(sql`
          UPDATE learning_job
          SET lease_expires_at = 1, version = version + 1, updated_at = updated_at + 1
          WHERE job_id = ${admitted.job.jobId}
        `)
        let providerCalls = 0
        expect(
          yield* DeepAgentDurableLearning.drain(db, {
            owner: "reviewer-recovery-owner",
            authorityRoot: root,
            reviewer: {
              identity: () => Effect.die("dispatching reviewer recovery must not create a session"),
              execute: () =>
                Effect.sync(() => providerCalls++).pipe(Effect.as({ verdict: "reject", selectedCandidateIds: [] })),
            },
          }),
        ).toEqual([])
        expect(providerCalls).toBe(0)
        expect(yield* DeepAgentLearningReviewerAttempt.getByJob(db, admitted.job.jobId)).toMatchObject({
          state: "recovery_required",
          errorCode: "reviewer_dispatch_indeterminate_after_crash",
        })
        expect(yield* DeepAgentLearningJob.get(db, admitted.job.jobId)).toMatchObject({
          state: "recovery_required",
          owner: null,
          errorCode: "reviewer_dispatch_indeterminate_after_crash",
        })
      }),
    )
  })

  test("reconciles an extraction artifact published before its database settlement", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const admitted = yield* DeepAgentDurableLearning.admit(db, admission("run-extraction-crash"), {
          authorityRoot: root,
        })
        yield* db.run(sql`
          CREATE TRIGGER learning_extraction_settle_test_abort
          BEFORE UPDATE OF side_effect_state ON learning_job
          WHEN OLD.side_effect_kind = 'extraction' AND NEW.side_effect_state = 'settled'
          BEGIN SELECT RAISE(ABORT, 'test extraction settlement crash'); END
        `)

        expect(
          yield* DeepAgentDurableLearning.drain(db, {
            owner: "worker-crashed",
            authorityRoot: root,
            leaseMs: 10_000,
          }).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
        yield* db.run(sql`
          UPDATE learning_job
          SET lease_expires_at = 1, version = version + 1, updated_at = updated_at + 1
          WHERE job_id = ${admitted.job.jobId}
        `)
        const started = (yield* DeepAgentLearningJob.get(db, admitted.job.jobId))!
        const artifact = JSON.parse(started.expectedResultRef!) as { path: string; sha256: string }
        expect(started).toMatchObject({
          state: "running",
          sideEffectState: "started",
          sideEffectKind: "extraction",
          resultRef: null,
        })
        expect(Hash.sha256(yield* Effect.promise(() => Bun.file(artifact.path).text()))).toBe(artifact.sha256)

        yield* db.run("DROP TRIGGER learning_extraction_settle_test_abort")
        const recovered = yield* Effect.all(
          [
            DeepAgentDurableLearning.recoverArtifactSideEffects(db, { authorityRoot: root }),
            DeepAgentDurableLearning.recoverArtifactSideEffects(db, { authorityRoot: root }),
          ],
          { concurrency: "unbounded" },
        )

        expect(recovered).toHaveLength(2)
        expect(recovered.flat().length).toBeGreaterThanOrEqual(1)
        expect(recovered.flat()[0]).toMatchObject({
          state: "reviewing",
          sideEffectState: "not_started",
          sideEffectKind: null,
          expectedResultRef: null,
          resultRef: started.expectedResultRef,
          owner: null,
          errorCode: "reconciled_exact_artifact_after_lease_expiry",
        })
        expect(yield* DeepAgentLearningJob.get(db, admitted.job.jobId)).toMatchObject({
          state: "reviewing",
          sideEffectState: "not_started",
          resultRef: started.expectedResultRef,
          expectedResultRef: null,
        })
        expect(
          yield* DeepAgentDurableLearning.drain(db, { owner: "worker-recovered", authorityRoot: root }),
        ).toHaveLength(1)
      }),
    )
  })

  test("recreates only the preplanned reviewer artifact when it is missing after a crash", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const admitted = yield* DeepAgentDurableLearning.admit(db, admission("run-review-crash"), {
          authorityRoot: root,
        })
        yield* db.run(sql`
          CREATE TRIGGER learning_review_settle_test_abort
          BEFORE UPDATE OF side_effect_state ON learning_job
          WHEN OLD.side_effect_kind = 'reviewer' AND NEW.side_effect_state = 'settled'
          BEGIN SELECT RAISE(ABORT, 'test review settlement crash'); END
        `)

        expect(
          yield* DeepAgentDurableLearning.drain(db, {
            owner: "reviewer-crashed",
            authorityRoot: root,
            leaseMs: 10_000,
          }).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
        yield* db.run(sql`
          UPDATE learning_job
          SET lease_expires_at = 1, version = version + 1, updated_at = updated_at + 1
          WHERE job_id = ${admitted.job.jobId}
        `)
        const started = (yield* DeepAgentLearningJob.get(db, admitted.job.jobId))!
        const artifact = JSON.parse(started.expectedResultRef!) as { path: string; sha256: string }
        expect(started).toMatchObject({
          state: "reviewing",
          sideEffectState: "started",
          sideEffectKind: "reviewer",
          resultRef: expect.stringContaining("learning-extraction-"),
        })
        rmSync(artifact.path)
        expect(existsSync(artifact.path)).toBe(false)

        yield* db.run("DROP TRIGGER learning_review_settle_test_abort")
        const recovered = yield* DeepAgentDurableLearning.recoverArtifactSideEffects(db, { authorityRoot: root })

        expect(recovered[0]).toMatchObject({
          state: "governance",
          sideEffectState: "not_started",
          resultRef: started.expectedResultRef,
          expectedResultRef: null,
        })
        expect(existsSync(artifact.path)).toBe(true)
        expect(Hash.sha256(yield* Effect.promise(() => Bun.file(artifact.path).text()))).toBe(artifact.sha256)
      }),
    )
  })

  test("quarantines a stale phase when its preplanned artifact path contains conflicting content", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const admitted = yield* DeepAgentDurableLearning.admit(db, admission("run-artifact-conflict"), {
          authorityRoot: root,
        })
        yield* db.run(sql`
          CREATE TRIGGER learning_artifact_conflict_test_abort
          BEFORE UPDATE OF side_effect_state ON learning_job
          WHEN OLD.side_effect_kind = 'extraction' AND NEW.side_effect_state = 'settled'
          BEGIN SELECT RAISE(ABORT, 'test artifact conflict crash'); END
        `)
        yield* DeepAgentDurableLearning.drain(db, {
          owner: "worker-conflict",
          authorityRoot: root,
          leaseMs: 10_000,
        }).pipe(Effect.exit)
        yield* db.run(sql`
          UPDATE learning_job
          SET lease_expires_at = 1, version = version + 1, updated_at = updated_at + 1
          WHERE job_id = ${admitted.job.jobId}
        `)
        const started = (yield* DeepAgentLearningJob.get(db, admitted.job.jobId))!
        const artifact = JSON.parse(started.expectedResultRef!) as { path: string }
        writeFileSync(artifact.path, "{}")

        yield* db.run("DROP TRIGGER learning_artifact_conflict_test_abort")
        const recovered = yield* DeepAgentDurableLearning.recoverArtifactSideEffects(db, { authorityRoot: root })

        expect(recovered[0]).toMatchObject({
          state: "recovery_required",
          sideEffectState: "started",
          sideEffectKind: "extraction",
          expectedResultRef: started.expectedResultRef,
          resultRef: null,
          owner: null,
          errorCode: "artifact_reconciliation_mismatch",
          errorDetail: `Learning artifact collision at ${artifact.path}`,
        })
        expect(yield* DeepAgentLearningJob.claim(db, { owner: "worker-forbidden", leaseMs: 100 })).toBeUndefined()
      }),
    )
  })

  test("rejects a candidate input ref outside the configured authority root before any phase side effect", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const admitted = yield* DeepAgentLearningJob.enqueue(db, {
          projectId: "project-db-1",
          sessionId: "ses_learning",
          runId: "run-hostile",
          trigger: "session_finalization",
          dedupeKey: "session_finalization:project-1:run-hostile",
          candidateInputRef: JSON.stringify({
            schema_version: "deepagent-code.learning_artifact_ref.v1",
            authority_root: path.join(root, "other-authority"),
            path: path.join(root, "other-authority", "input.json"),
            sha256: "a".repeat(64),
          }),
          policy: "manual_review",
        })

        expect(
          yield* DeepAgentDurableLearning.drain(db, { owner: "worker-1", authorityRoot: root }).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
        expect(yield* DeepAgentLearningJob.get(db, admitted.job.jobId)).toMatchObject({
          state: "running",
          sideEffectState: "not_started",
          sideEffectKind: null,
        })
      }),
    )
  })

  test("rejects a job whose immutable identity does not match its candidate input manifest", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const source = yield* DeepAgentDurableLearning.admit(db, admission("run-source"), { authorityRoot: root })
        expect(yield* DeepAgentDurableLearning.drain(db, { owner: "worker-source", authorityRoot: root })).toHaveLength(
          1,
        )
        yield* db.insert(ProjectTable).values({
          id: Project.ID.make("project-db-2"),
          worktree: AbsolutePath.make(path.join(root, "workspace-2")),
          sandboxes: [],
          time_created: 2,
          time_updated: 2,
        })
        yield* db.insert(SessionTable).values({
          id: SessionSchema.ID.make("ses_other"),
          project_id: Project.ID.make("project-db-2"),
          slug: "ses_other",
          directory: path.join(root, "workspace-2"),
          title: "Other learning",
          version: "1",
          time_created: 2,
          time_updated: 2,
        })
        const mismatched = yield* DeepAgentLearningJob.enqueue(db, {
          projectId: "project-db-2",
          sessionId: "ses_other",
          runId: "run-other",
          trigger: "session_finalization",
          dedupeKey: "session_finalization:project-db-2:ses_other:run-other",
          candidateInputRef: source.job.candidateInputRef,
          policy: "auto_merge_safe_project",
        })

        expect(
          yield* DeepAgentDurableLearning.drain(db, {
            owner: "worker-1",
            authorityRoot: root,
          }).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
        expect(yield* DeepAgentLearningJob.get(db, source.job.jobId)).toMatchObject({ state: "completed" })
        expect(yield* DeepAgentLearningJob.get(db, mismatched.job.jobId)).toMatchObject({
          state: "running",
          sideEffectState: "not_started",
          sideEffectKind: null,
        })
      }),
    )
  })

  test("uses immutable document governance rather than the rejected-buffer projection", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* DeepAgentDurableLearning.admit(
          db,
          bindAdmission({
            ...admission("run-rejected"),
            input: { ...admission("run-rejected").input, policy: "manual_review" },
          }),
          { authorityRoot: root },
        )
        yield* DeepAgentDurableLearning.drain(db, { owner: "worker-1", authorityRoot: root })
        const store = new DurableKnowledgeStore(path.join(root, "project", knowledgeProjectID(), "knowledge"))
        const staged = store.documentStore.get(store.listByStatus("candidate")[0]!.id)!
        store.rejectCandidate(
          staged.id,
          documentRevision(staged),
          { type: "human", id: "learning-review" },
          "do not learn this pattern",
          {
            fingerprint: fingerprint({
              candidate_id: "memory:run-rejected:first-pass-success",
              type: "memory",
              status: "staged",
              source_run_id: "run-rejected",
              source_round: 1,
              summary: "Task completed in first round without diagnosis or retry.",
              evidence_refs: ["run:run-rejected"],
              confidence: 0.6,
            }),
          },
        )

        yield* DeepAgentDurableLearning.admit(db, admission("run-retry"), { authorityRoot: root })
        yield* DeepAgentDurableLearning.drain(db, { owner: "worker-2", authorityRoot: root })

        expect(store.listByStatus("rejected")).toHaveLength(1)
        expect(store.listByStatus("candidate")).toHaveLength(0)
        expect(store.listByStatus("active")).toHaveLength(0)
      }),
    )
  })

  test("rejects an artifact path that escapes its authority root through a symlink", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "deepagent-learning-outside-"))
    try {
      await run(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const manifest = JSON.stringify({
            schema_version: "deepagent-code.learning_input.v1",
            base_dir: root,
            workspace_path: path.join(root, "workspace"),
            rejected_buffer_dir: null,
            database_project_id: "project-db-1",
            knowledge_project_id: knowledgeProjectID(),
            session_id: "ses_learning",
            run_id: "run-symlink",
            mode: "high",
            diagnoses: [],
            total_rounds: 1,
            final_status: "completed",
            trigger: "session_finalization",
            policy: "manual_review",
          })
          writeFileSync(path.join(outside, "input.json"), manifest)
          mkdirSync(root, { recursive: true })
          symlinkSync(outside, path.join(root, "linked-outside"), "dir")
          const admitted = yield* DeepAgentLearningJob.enqueue(db, {
            projectId: "project-db-1",
            sessionId: "ses_learning",
            runId: "run-symlink",
            trigger: "session_finalization",
            dedupeKey: "session_finalization:project-db-1:ses_learning:run-symlink",
            candidateInputRef: JSON.stringify({
              schema_version: "deepagent-code.learning_artifact_ref.v1",
              authority_root: root,
              path: path.join(root, "linked-outside", "input.json"),
              sha256: Hash.sha256(manifest),
            }),
            policy: "manual_review",
          })

          expect(
            yield* DeepAgentDurableLearning.drain(db, { owner: "worker-1", authorityRoot: root }).pipe(Effect.exit),
          ).toMatchObject({ _tag: "Failure" })
          expect(yield* DeepAgentLearningJob.get(db, admitted.job.jobId)).toMatchObject({
            state: "running",
            sideEffectState: "not_started",
          })
        }),
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("rolls back the production job when the outbox admission settlement aborts", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const input = admission("run-atomic-failure")
        const persisted = yield* DeepAgentDurableLearning.record(db, input)
        yield* db.run(sql`
          CREATE TRIGGER learning_admission_test_abort
          BEFORE UPDATE OF state ON learning_admission_outbox
          WHEN NEW.state = 'admitted'
          BEGIN SELECT RAISE(ABORT, 'test admission settlement abort'); END
        `)

        yield* DeepAgentDurableLearning.reconcile(db, { authorityRoot: root })
        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 0 })
        expect(yield* DeepAgentLearningAdmissionOutbox.get(db, persisted.intent.intentId)).toMatchObject({
          state: "rejected",
          jobId: null,
          candidateInputRef: null,
        })
      }),
    )
  })

  test("fences a production claim against a mismatched admitted receipt", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const input = admission("run-claim-fence")
        const persisted = yield* DeepAgentDurableLearning.record(db, input)
        const direct = yield* DeepAgentLearningJob.enqueue(db, {
          projectId: "project-db-1",
          sessionId: "ses_learning",
          runId: "run-claim-fence",
          trigger: "session_finalization",
          dedupeKey: "session_finalization:project-db-1:ses_learning:run-claim-fence",
          candidateInputRef: "forged-input-ref",
          policy: "auto_merge_safe_project",
          now: 1,
        })
        yield* db
          .delete(LearningAdmissionOutboxTable)
          .where(eq(LearningAdmissionOutboxTable.intent_id, persisted.intent.intentId))
        yield* db.insert(LearningAdmissionOutboxTable).values({
          intent_id: persisted.intent.intentId,
          session_id: persisted.intent.sessionId,
          run_id: persisted.intent.runId,
          trigger: persisted.intent.trigger,
          dedupe_key: persisted.intent.dedupeKey,
          payload_json: persisted.intent.payloadJson,
          payload_fingerprint: persisted.intent.payloadFingerprint,
          state: "admitted",
          job_id: direct.job.jobId,
          candidate_input_ref: "recorded-input-ref",
          rejection_code: null,
          rejection_detail: null,
          created_at: persisted.intent.createdAt,
          settled_at: persisted.intent.createdAt + 1,
          updated_at: persisted.intent.createdAt + 1,
        })

        expect(
          yield* DeepAgentLearningJob.claim(db, { owner: "worker-fenced", leaseMs: 100, now: 10 }).pipe(Effect.exit),
        ).toMatchObject({
          _tag: "Failure",
          cause: expect.anything(),
        })
        expect(yield* DeepAgentLearningJob.get(db, direct.job.jobId)).toMatchObject({
          state: "queued",
          owner: null,
          version: 0,
        })
      }),
    )
  })

  test("fences a legacy partial admission whose production job exists before its receipt settles", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* DeepAgentDurableLearning.record(db, admission("run-partial-admission"))
        const direct = yield* DeepAgentLearningJob.enqueue(db, {
          projectId: "project-db-1",
          sessionId: "ses_learning",
          runId: "run-partial-admission",
          trigger: "session_finalization",
          dedupeKey: "session_finalization:project-db-1:ses_learning:run-partial-admission",
          candidateInputRef: "legacy-partial-input-ref",
          policy: "auto_merge_safe_project",
          now: 1,
        })

        expect(
          yield* DeepAgentLearningJob.claim(db, { owner: "worker-fenced", leaseMs: 100, now: 10 }).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
        expect(yield* DeepAgentLearningJob.get(db, direct.job.jobId)).toMatchObject({
          state: "queued",
          owner: null,
          version: 0,
        })
      }),
    )
  })

  test("rejects an intent with a hostile authority root before creating an input artifact", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const input = admission("run-hostile-root")
        const persisted = yield* DeepAgentDurableLearning.record(db, {
          ...input,
          baseDir: path.join(root, "other-authority"),
        })

        yield* DeepAgentDurableLearning.reconcile(db, { authorityRoot: root })

        expect(yield* DeepAgentLearningAdmissionOutbox.get(db, persisted.intent.intentId)).toMatchObject({
          state: "rejected",
          jobId: null,
          rejectionDetail: "Learning admission base_dir does not match the canonical authority root",
        })
        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 0 })
        expect(existsSync(path.join(root, "other-authority"))).toBe(false)
      }),
    )
  })

  test("rejects a terminal artifact outside the authority root before reading or writing artifacts", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "deepagent-learning-terminal-outside-"))
    try {
      await run(
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const input = admission("run-hostile-terminal")
          const terminal = terminalState("run-hostile-terminal", "high", "completed")
          const terminalPath = path.join(outside, "DEEPAGENT_RUN_STATE.json")
          writeFileSync(terminalPath, terminal)
          const persisted = yield* DeepAgentDurableLearning.record(db, {
            ...input,
            terminalArtifact: {
              schema_version: "deepagent-code.learning_terminal_artifact.v1",
              path: terminalPath,
              sha256: Hash.sha256(terminal),
              learning_admission_fingerprint: "0".repeat(64),
            },
          })

          yield* DeepAgentDurableLearning.reconcile(db, { authorityRoot: root })

          expect(yield* DeepAgentLearningAdmissionOutbox.get(db, persisted.intent.intentId)).toMatchObject({
            state: "rejected",
            jobId: null,
            rejectionDetail: `Learning artifact escapes its authority root: ${terminalPath}`,
          })
          expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 0 })
          expect(existsSync(path.join(root, "project"))).toBe(false)
        }),
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("keeps an in-root missing terminal artifact pending without creating directories", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const input = admission("run-missing-terminal")
        const missingDirectory = path.join(root, "not-created", "gateway-run")
        const persisted = yield* DeepAgentDurableLearning.record(db, {
          ...input,
          terminalArtifact: {
            schema_version: "deepagent-code.learning_terminal_artifact.v1",
            path: path.join(missingDirectory, "DEEPAGENT_RUN_STATE.json"),
            sha256: input.terminalArtifact.sha256,
            learning_admission_fingerprint: input.terminalArtifact.learning_admission_fingerprint,
          },
        })

        yield* DeepAgentDurableLearning.reconcile(db, { authorityRoot: root })

        expect(yield* DeepAgentLearningAdmissionOutbox.get(db, persisted.intent.intentId)).toMatchObject({
          state: "pending",
          jobId: null,
        })
        expect(yield* db.select({ count: count() }).from(LearningJobTable).get()).toEqual({ count: 0 })
        expect(existsSync(missingDirectory)).toBe(false)
      }),
    )
  })
})

function admission(
  runID: string,
  mode: DeepAgentDurableLearning.Admission["input"]["mode"] = "high",
): DeepAgentDurableLearning.Admission {
  const terminalPath = path.join(root, "gateway-runs", runID, "DEEPAGENT_RUN_STATE.json")
  const input = {
    baseDir: root,
    workspacePath: path.join(root, "workspace"),
    rejectedBufferDir: path.join(root, "memory"),
    terminalArtifact: {
      schema_version: "deepagent-code.learning_terminal_artifact.v1" as const,
      path: terminalPath,
      sha256: "",
      learning_admission_fingerprint: "",
    },
    input: {
      projectID: "forged-knowledge-project",
      sessionID: "ses_learning",
      runID,
      mode,
      roundState: createInitialRoundState(mode),
      totalRounds: 1,
      finalStatus: "completed" as const,
      trigger: "session_finalization" as const,
      policy: "auto_merge_safe_project" as const,
    },
  }
  const learningAdmissionFingerprint = DeepAgentDurableLearning.admissionFingerprint(input)
  const terminal = terminalState(runID, mode, "completed", learningAdmissionFingerprint)
  mkdirSync(path.dirname(terminalPath), { recursive: true })
  writeFileSync(terminalPath, terminal)
  return {
    ...input,
    terminalArtifact: {
      ...input.terminalArtifact,
      sha256: Hash.sha256(terminal),
      learning_admission_fingerprint: learningAdmissionFingerprint,
    },
  }
}

function terminalState(
  runID: string,
  mode: DeepAgentDurableLearning.Admission["input"]["mode"],
  state: "opened" | "completed" | "failed",
  learningAdmissionFingerprint = "0".repeat(64),
) {
  return `${JSON.stringify(
    {
      schema_version: "deepagent_global_run_state.v1",
      run_id: runID,
      generic_agent_session_id: "ses_learning",
      agent_mode: mode,
      state,
      learning_admission_fingerprint: learningAdmissionFingerprint,
    },
    null,
    2,
  )}\n`
}

function bindAdmission(input: DeepAgentDurableLearning.Admission): DeepAgentDurableLearning.Admission {
  const learningAdmissionFingerprint = DeepAgentDurableLearning.admissionFingerprint(input)
  const terminal = terminalState(
    input.input.runID,
    input.input.mode,
    input.input.finalStatus,
    learningAdmissionFingerprint,
  )
  writeFileSync(input.terminalArtifact.path, terminal)
  return {
    ...input,
    terminalArtifact: {
      ...input.terminalArtifact,
      sha256: Hash.sha256(terminal),
      learning_admission_fingerprint: learningAdmissionFingerprint,
    },
  }
}

function knowledgeProjectID() {
  return projectIdForWorkspace(path.join(root, "workspace"))
}

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [learningArtifactPhaseReceiptMigration])
      yield* DatabaseMigration.applyOnly(db, [learningGovernanceCompensationMigration])
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.insert(ProjectTable).values({
        id: Project.ID.make("project-db-1"),
        worktree: AbsolutePath.make(path.join(root, "workspace")),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      yield* db.insert(SessionTable).values({
        id: SessionSchema.ID.make("ses_learning"),
        project_id: Project.ID.make("project-db-1"),
        slug: "ses_learning",
        directory: path.join(root, "workspace"),
        title: "Learning",
        version: "1",
        time_created: 1,
        time_updated: 1,
      })
      return yield* effect
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}
