import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "../../src/database/database"
import { DatabaseMigration } from "../../src/database/migration"
import governanceSchemaMigration from "../../src/database/migration/20260812034116_learning_governance_authority"
import governanceLifecycleMigration from "../../src/database/migration/20260812035000_learning_governance_lifecycle"
import governanceCompensationMigration from "../../src/database/migration/20260813041300_learning_governance_compensation_authority"
import {
  applyGovernanceAction,
  applyGovernanceCompensation,
  executeClaimedGovernanceAction,
} from "../../src/deepagent/durable-learning"
import { DurableKnowledgeStore, type KnowledgeDocInput } from "../../src/deepagent/durable-knowledge-store"
import { DeepAgentLearningGovernance } from "../../src/deepagent/learning-governance"
import { DeepAgentLearningJob } from "../../src/deepagent/learning-job"
import { CanonicalJson } from "../../src/util/canonical-json"
import { Hash } from "../../src/util/hash"

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-learning-governance-recovery-"))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("durable learning governance recovery", () => {
  test("keeps near-duplicate active knowledge unchanged while staging an exact review proposal", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const store = new DurableKnowledgeStore(path.join(root, "knowledge"))
        const existing = store.stageCandidate({
          ...document,
          idSlug: "existing-active",
          description: "replay the exact durable learning candidate safely",
          body: "replay the exact durable learning candidate safely",
        })
        store.approve(existing.id)
        const active = store.documentStore.get(existing.id)!
        const prepared = yield* DeepAgentLearningGovernance.prepare(
          db,
          prepareInput([
            {
              candidateId: document.idSlug!,
              kind: "document_stage",
              payload: { document, decision: "manual_review" },
            },
          ]),
        )
        const claimed = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 100,
          now: 10,
        })
        const result = yield* applyGovernanceAction(claimed!, store, root)
        const proposal = store.documentStore.get(result.ref.split("@v")[0]!)!

        expect(proposal).toMatchObject({ status: "candidate", version: 2 })
        expect(proposal.id).not.toBe(active.id)
        expect(store.documentStore.get(active.id)).toEqual(active)
      }),
    )
  })

  test("replays an exact auto-admission after takeover without another document revision", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const store = new DurableKnowledgeStore(path.join(root, "knowledge"))
        const reviewRef = "learning-review:job-governance-recovery"
        const prepared = yield* DeepAgentLearningGovernance.prepare(
          db,
          prepareInput([
            {
              candidateId: document.idSlug!,
              kind: "document_stage",
              payload: { document, decision: "auto_admit", review_ref: reviewRef },
            },
          ]),
        )
        const first = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 100,
          now: 10,
        })
        const firstResult = yield* applyGovernanceAction(first!, store, root)
        const active = store.documentStore.get(firstResult.ref.split("@v")[0]!)!
        expect(active).toMatchObject({ status: "active", version: 3 })

        const takeover = yield* DeepAgentLearningGovernance.takeover(db, {
          jobId: "job-governance-recovery",
          owner: "worker-b",
          leaseMs: 100,
          now: 110,
        })
        const replay = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: takeover!.plan.planId,
          owner: "worker-b",
          leaseMs: 100,
          now: 110,
        })
        expect(yield* applyGovernanceAction(replay!, store, root)).toEqual(firstResult)
        expect(store.documentStore.get(active.id)).toEqual(active)
      }),
    )
  })

  test("replays an exact document after takeover without creating a new revision", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const store = new DurableKnowledgeStore(path.join(root, "knowledge"))
        const prepared = yield* DeepAgentLearningGovernance.prepare(
          db,
          prepareInput([{ candidateId: document.idSlug!, kind: "document_stage", payload: { document } }]),
        )
        const first = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 100,
          now: 10,
        })
        const firstResult = yield* applyGovernanceAction(first!, store, root)
        const staged = store.documentStore.get(firstResult.ref.split("@v")[0]!)!

        expect(staged).toMatchObject({ version: 2, status: "candidate", confidence: document.confidence })
        expect(yield* DeepAgentLearningGovernance.get(db, prepared.plan.planId)).toMatchObject({
          actions: [{ state: "running", owner: "worker-a", version: 1 }],
        })

        const takeover = yield* DeepAgentLearningGovernance.takeover(db, {
          jobId: "job-governance-recovery",
          owner: "worker-b",
          leaseMs: 100,
          now: 110,
        })
        const replay = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: takeover!.plan.planId,
          owner: "worker-b",
          leaseMs: 100,
          now: 110,
        })
        const replayResult = yield* applyGovernanceAction(replay!, store, root)

        expect(replayResult).toEqual(firstResult)
        expect(store.documentStore.list({ type: "memory" })).toHaveLength(1)
        expect(store.documentStore.get(staged.id)).toMatchObject({
          version: 2,
          status: "candidate",
          confidence: document.confidence,
        })
        const settled = yield* DeepAgentLearningGovernance.settleAction(db, {
          actionId: replay!.actionId,
          owner: "worker-b",
          expectedVersion: replay!.version,
          resultRef: replayResult.ref,
          resultHash: replayResult.hash,
          now: 111,
        })
        expect(
          yield* DeepAgentLearningGovernance.settleAction(db, {
            actionId: first!.actionId,
            owner: "worker-a",
            expectedVersion: first!.version,
            resultRef: firstResult.ref,
            resultHash: firstResult.hash,
            now: 112,
          }),
        ).toEqual(settled)
        expect(
          yield* DeepAgentLearningGovernance.settleAction(db, {
            actionId: first!.actionId,
            owner: "worker-a",
            expectedVersion: first!.version,
            resultRef: `${firstResult.ref}:conflict`,
            resultHash: Hash.sha256("conflicting stale result"),
            now: 112,
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "DeepAgentLearningGovernance.FenceError" })
      }),
    )
  })

  test("reconciles an exact inbox file after takeover without rewriting it", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const store = new DurableKnowledgeStore(path.join(root, "knowledge"))
        const file = path.join(root, "project", "docs", "memory-inbox", "candidate-inbox.json")
        const content = CanonicalJson.stringify({ id: "candidate-inbox", created_at: "1970-01-01T00:00:00.010Z" })
        const prepared = yield* DeepAgentLearningGovernance.prepare(
          db,
          prepareInput([
            {
              candidateId: "candidate-inbox",
              kind: "memory_inbox",
              payload: { item: { id: "candidate-inbox" }, path: file, content, content_hash: Hash.sha256(content) },
            },
          ]),
        )
        const first = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 100,
          now: 10,
        })
        const firstResult = yield* applyGovernanceAction(first!, store, root)
        const firstMtime = statSync(file).mtimeMs

        const takeover = yield* DeepAgentLearningGovernance.takeover(db, {
          jobId: "job-governance-recovery",
          owner: "worker-b",
          leaseMs: 100,
          now: 110,
        })
        const replay = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: takeover!.plan.planId,
          owner: "worker-b",
          leaseMs: 100,
          now: 110,
        })
        const replayResult = yield* applyGovernanceAction(replay!, store, root)

        expect(replayResult).toEqual(firstResult)
        expect(readFileSync(file, "utf8")).toBe(content)
        expect(statSync(file).mtimeMs).toBe(firstMtime)
        yield* DeepAgentLearningGovernance.settleAction(db, {
          actionId: replay!.actionId,
          owner: "worker-b",
          expectedVersion: replay!.version,
          resultRef: replayResult.ref,
          resultHash: replayResult.hash,
          now: 111,
        })
      }),
    )
  })

  test("isolates an inbox conflict without overwriting the durable output", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const store = new DurableKnowledgeStore(path.join(root, "knowledge"))
        const file = path.join(root, "project", "docs", "memory-inbox", "candidate-conflict.json")
        const content = CanonicalJson.stringify({ id: "candidate-conflict", state: "pending" })
        const prepared = yield* DeepAgentLearningGovernance.prepare(
          db,
          prepareInput([
            {
              candidateId: "candidate-conflict",
              kind: "memory_inbox",
              payload: {
                item: { id: "candidate-conflict" },
                path: file,
                content,
                content_hash: Hash.sha256(content),
              },
            },
          ]),
        )
        const claimed = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 100,
          now: 10,
        })
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, "conflicting durable content")

        expect(
          yield* executeClaimedGovernanceAction(db, claimed!, "worker-a", store, root, 10).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })
        expect(readFileSync(file, "utf8")).toBe("conflicting durable content")
        expect(yield* DeepAgentLearningGovernance.get(db, prepared.plan.planId)).toMatchObject({
          plan: { state: "recovery_required", errorCode: "governance_action_apply_failed" },
          actions: [{ state: "recovery_required", errorCode: "governance_action_apply_failed" }],
        })
        expect(yield* DeepAgentLearningJob.get(db, "job-governance-recovery")).toMatchObject({
          state: "recovery_required",
          sideEffectState: "unknown",
          errorCode: "governance_action_apply_failed",
        })
      }),
    )
  })

  test("compensates settled governance actions in reverse order after a later action fails", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const store = new DurableKnowledgeStore(path.join(root, "knowledge"))
        const file = path.join(root, "project", "docs", "memory-inbox", "candidate-compensation.json")
        const prepared = yield* DeepAgentLearningGovernance.prepare(
          db,
          prepareInput([
            { candidateId: document.idSlug!, kind: "document_stage", payload: { document } },
            {
              candidateId: document.idSlug!,
              kind: "memory_inbox",
              predecessorSequence: 0,
              payload: {
                item: { id: document.idSlug },
                path: file,
                content: "pending",
                content_hash: Hash.sha256("pending"),
              },
            },
            {
              candidateId: `${document.idSlug}-failed`,
              kind: "memory_inbox",
              predecessorSequence: 1,
              payload: {
                item: { id: `${document.idSlug}-failed` },
                path: path.join(root, "project", "docs", "memory-inbox", "candidate-compensation-failed.json"),
                content: "failed",
                content_hash: Hash.sha256("wrong"),
              },
            },
          ]),
        )
        const documentAction = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 100,
          now: 10,
        })
        const documentResult = yield* applyGovernanceAction(documentAction!, store, root)
        yield* DeepAgentLearningGovernance.settleAction(db, {
          actionId: documentAction!.actionId,
          owner: "worker-a",
          expectedVersion: documentAction!.version,
          resultRef: documentResult.ref,
          resultHash: documentResult.hash,
          now: 11,
        })
        const inboxAction = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 100,
          now: 12,
        })
        const inboxResult = yield* applyGovernanceAction(inboxAction!, store, root)
        yield* DeepAgentLearningGovernance.settleAction(db, {
          actionId: inboxAction!.actionId,
          owner: "worker-a",
          expectedVersion: inboxAction!.version,
          resultRef: inboxResult.ref,
          resultHash: inboxResult.hash,
          now: 13,
        })
        const failingAction = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 100,
          now: 14,
        })
        expect(
          yield* executeClaimedGovernanceAction(db, failingAction!, "worker-a", store, root, 15).pipe(Effect.exit),
        ).toMatchObject({ _tag: "Failure" })

        const inboxCompensation = yield* DeepAgentLearningGovernance.claimCompensation(db, {
          planId: prepared.plan.planId,
          owner: "recovery-a",
          leaseMs: 100,
          now: 20,
        })
        expect(inboxCompensation).toMatchObject({ kind: "memory_inbox_revoke", sequence: 0 })
        const inboxRevoke = yield* applyGovernanceCompensation(inboxCompensation!, inboxAction!, store, root)
        yield* DeepAgentLearningGovernance.settleCompensation(db, {
          compensationId: inboxCompensation!.compensationId,
          owner: "recovery-a",
          expectedVersion: inboxCompensation!.version,
          resultRef: inboxRevoke.ref,
          resultHash: inboxRevoke.hash,
          now: 21,
        })
        const documentCompensation = yield* DeepAgentLearningGovernance.claimCompensation(db, {
          planId: prepared.plan.planId,
          owner: "recovery-a",
          leaseMs: 100,
          now: 22,
        })
        expect(documentCompensation).toMatchObject({ kind: "document_quarantine", sequence: 1 })
        const quarantine = yield* applyGovernanceCompensation(documentCompensation!, documentAction!, store, root)
        yield* DeepAgentLearningGovernance.settleCompensation(db, {
          compensationId: documentCompensation!.compensationId,
          owner: "recovery-a",
          expectedVersion: documentCompensation!.version,
          resultRef: quarantine.ref,
          resultHash: quarantine.hash,
          now: 23,
        })
        expect(store.documentStore.get(documentResult.ref.split("@v")[0]!)).toMatchObject({
          status: "quarantined",
          version: 3,
        })
        expect(
          yield* DeepAgentLearningGovernance.claimCompensation(db, {
            planId: prepared.plan.planId,
            owner: "recovery-a",
            leaseMs: 100,
            now: 24,
          }),
        ).toBeUndefined()
      }),
    )
  })

  test("takes over a compensation after its immutable side effect landed without adding another revision", async () => {
    await run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const store = new DurableKnowledgeStore(path.join(root, "knowledge"))
        const file = path.join(root, "project", "docs", "memory-inbox", "candidate-takeover.json")
        const prepared = yield* DeepAgentLearningGovernance.prepare(
          db,
          prepareInput([
            { candidateId: document.idSlug!, kind: "document_stage", payload: { document } },
            {
              candidateId: document.idSlug!,
              kind: "memory_inbox",
              predecessorSequence: 0,
              payload: {
                item: { id: document.idSlug },
                path: file,
                content: "pending",
                content_hash: Hash.sha256("pending"),
              },
            },
            {
              candidateId: `${document.idSlug}-failed`,
              kind: "memory_inbox",
              predecessorSequence: 1,
              payload: {
                item: { id: `${document.idSlug}-failed` },
                path: path.join(root, "project", "docs", "memory-inbox", "candidate-takeover-failed.json"),
                content: "failed",
                content_hash: Hash.sha256("wrong"),
              },
            },
          ]),
        )
        const action = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 100,
          now: 10,
        })
        const result = yield* applyGovernanceAction(action!, store, root)
        yield* DeepAgentLearningGovernance.settleAction(db, {
          actionId: action!.actionId,
          owner: "worker-a",
          expectedVersion: action!.version,
          resultRef: result.ref,
          resultHash: result.hash,
          now: 11,
        })
        const inbox = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 100,
          now: 12,
        })
        const inboxResult = yield* applyGovernanceAction(inbox!, store, root)
        yield* DeepAgentLearningGovernance.settleAction(db, {
          actionId: inbox!.actionId,
          owner: "worker-a",
          expectedVersion: inbox!.version,
          resultRef: inboxResult.ref,
          resultHash: inboxResult.hash,
          now: 13,
        })
        const failing = yield* DeepAgentLearningGovernance.claimAction(db, {
          planId: prepared.plan.planId,
          owner: "worker-a",
          leaseMs: 100,
          now: 14,
        })
        yield* executeClaimedGovernanceAction(db, failing!, "worker-a", store, root, 15).pipe(Effect.exit)
        const first = yield* DeepAgentLearningGovernance.claimCompensation(db, {
          planId: prepared.plan.planId,
          owner: "recovery-a",
          leaseMs: 10,
          now: 20,
        })
        expect(first).toMatchObject({ kind: "memory_inbox_revoke", sequence: 0 })
        const firstResult = yield* applyGovernanceCompensation(first!, inbox!, store, root)

        const takeover = yield* DeepAgentLearningGovernance.claimCompensation(db, {
          planId: prepared.plan.planId,
          owner: "recovery-b",
          leaseMs: 10,
          now: 32,
        })
        expect(takeover).toMatchObject({ owner: "recovery-b", version: 2 })
        expect(yield* applyGovernanceCompensation(takeover!, inbox!, store, root)).toEqual(firstResult)
        yield* DeepAgentLearningGovernance.settleCompensation(db, {
          compensationId: takeover!.compensationId,
          owner: "recovery-b",
          expectedVersion: takeover!.version,
          resultRef: firstResult.ref,
          resultHash: firstResult.hash,
          now: 33,
        })
        const documentCompensation = yield* DeepAgentLearningGovernance.claimCompensation(db, {
          planId: prepared.plan.planId,
          owner: "recovery-b",
          leaseMs: 10,
          now: 34,
        })
        expect(documentCompensation).toMatchObject({ kind: "document_quarantine", sequence: 1 })
        const documentQuarantine = yield* applyGovernanceCompensation(documentCompensation!, action!, store, root)
        yield* DeepAgentLearningGovernance.settleCompensation(db, {
          compensationId: documentCompensation!.compensationId,
          owner: "recovery-b",
          expectedVersion: documentCompensation!.version,
          resultRef: documentQuarantine.ref,
          resultHash: documentQuarantine.hash,
          now: 35,
        })
        expect(store.documentStore.get(result.ref.split("@v")[0]!)).toMatchObject({ status: "quarantined", version: 3 })
        expect(
          yield* DeepAgentLearningGovernance.claimCompensation(db, {
            planId: prepared.plan.planId,
            owner: "recovery-b",
            leaseMs: 10,
            now: 36,
          }),
        ).toBeUndefined()
      }),
    )
  })
})

const document: KnowledgeDocInput = {
  type: "memory",
  description: "replay the exact durable learning candidate",
  body: "replay the exact durable learning candidate",
  domain: "learning",
  scope: "user-global",
  sensitivity: "public",
  risk: "low",
  confidence: { evidence_strength: "medium", support_count: 2 },
  provenance: { source: "runner", run_ref: "run:governance-recovery", evidence_refs: ["run:governance-recovery"] },
  idSlug: "candidate-document-recovery",
  createdRound: 1,
}

function prepareInput(actions: readonly DeepAgentLearningGovernance.ActionInput[]) {
  return {
    jobId: "job-governance-recovery",
    owner: "worker-a",
    expectedJobVersion: 4,
    leaseMs: 100,
    actions,
    now: 10,
  } as const
}

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* DatabaseMigration.applyOnly(db, [
        governanceSchemaMigration,
        governanceLifecycleMigration,
        governanceCompensationMigration,
      ])
      yield* db.run(
        `INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
         VALUES ('project-governance-recovery', '${root}', '[]', 1, 1)`,
      )
      yield* db.run(`
        INSERT INTO learning_job (
          job_id, project_id, session_id, run_id, trigger, dedupe_key, candidate_input_ref, policy,
          max_attempts, admission_fingerprint, state, attempts, owner, lease_expires_at, version,
          side_effect_state, side_effect_kind, next_attempt_at, created_at, started_at, updated_at
        ) VALUES (
          'job-governance-recovery', 'project-governance-recovery', NULL, 'run-governance-recovery',
          'session_finalization', 'governance:run-governance-recovery',
          'candidate-input:run-governance-recovery', 'manual_review', 3, '${Hash.sha256("admission")}',
          'governance', 1, 'worker-a', 100, 4, 'not_started', NULL, 0, 1, 1, 1
        )
      `)
      return yield* effect
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
}
