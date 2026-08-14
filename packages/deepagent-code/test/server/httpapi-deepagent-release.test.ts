import { afterEach, describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Database } from "@deepagent-code/core/database/database"
import {
  ReleasedKnowledgeEvaluationTable,
  ReleasedKnowledgeSnapshotDocumentTable,
  ReleasedKnowledgeSnapshotHeadTable,
  ReleasedKnowledgeSnapshotTable,
} from "@deepagent-code/core/deepagent/released-snapshot.sql"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const testTimeout = 30_000
const it = testEffect(
  Layer.mergeAll(
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
    Database.defaultLayer,
    httpApiLayer,
  ),
)

type ReleaseResult = {
  readonly active_snapshot_id: string
  readonly generation: number
  readonly membership_hash: string
}

function post(directory: string, path: string, payload: unknown) {
  return HttpServer.HttpServer.use((server) =>
    Effect.promise(async () => {
      const url = new URL(path, HttpServer.formatAddress(server.address))
      url.searchParams.set("directory", directory)
      const response = await globalThis.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      return { status: response.status, body: (await response.json()) as unknown }
    }),
  )
}

function get(directory: string, path: string) {
  return HttpServer.HttpServer.use((server) =>
    Effect.promise(async () => {
      const url = new URL(path, HttpServer.formatAddress(server.address))
      url.searchParams.set("directory", directory)
      const response = await globalThis.fetch(url)
      return { status: response.status, body: (await response.json()) as unknown }
    }),
  )
}

function releaseResult(value: unknown): ReleaseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid release response")
  const result = value as Record<string, unknown>
  if (
    typeof result.active_snapshot_id !== "string" ||
    typeof result.generation !== "number" ||
    typeof result.membership_hash !== "string"
  ) {
    throw new Error("invalid release response")
  }
  return {
    active_snapshot_id: result.active_snapshot_id,
    generation: result.generation,
    membership_hash: result.membership_hash,
  }
}

function errorMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return (value as Record<string, unknown>).message
}

function expectedParent(result: ReleaseResult) {
  return {
    snapshotId: result.active_snapshot_id,
    generation: result.generation,
    membershipHash: result.membership_hash,
  }
}

function releaseBaseline(directory: string, id: string) {
  return post(directory, "/deepagent/knowledge/release-baseline", {
    snapshotId: `snapshot_baseline_${id}`,
    evaluationId: `evaluation_baseline_${id}`,
    candidateRefs: [],
    baselineRef: `baseline_${id}`,
  }).pipe(
    Effect.map((response) => {
      expect(response.status).toBe(200)
      return releaseResult(response.body)
    }),
  )
}

function shipGate(
  directory: string,
  input: {
    readonly id: string
    readonly parent: ReleaseResult
    readonly candidates: readonly AgentGateway.DeepAgentReleasedSnapshot.DocumentRef[]
    readonly max: number
  },
) {
  const task = `task_${input.id}`
  return post(directory, "/deepagent/knowledge/ship-gate", {
    snapshotId: `snapshot_${input.id}`,
    evaluationId: `evaluation_${input.id}`,
    expectedParent: expectedParent(input.parent),
    tasks: [task],
    metrics: [
      { group: "general", task, metric: 1 },
      { group: "high", task, metric: 1 },
      { group: "max", task, metric: input.max },
    ],
    candidateRefs: input.candidates,
  })
}

function seedProject(directory: string, id: string, body: string) {
  return AgentGateway.DeepAgentKnowledgeSource.storesForWorkspace(directory)[1]!.seedActive({
    type: "knowledge",
    description: `release test ${id}`,
    body,
    domain: "code",
    scope: "project-shared",
    projectId: AgentGateway.DeepAgentDurableKnowledgeStore.projectIdForWorkspace(directory),
    sensitivity: "public",
    risk: "low",
    confidence: { evidence_strength: "strong", support_count: 1 },
    provenance: { source: "runner", run_ref: `run_${id}`, evidence_refs: [`evidence_${id}`] },
    idSlug: id,
  })
}

function seedUserGlobal(id: string, body: string) {
  return AgentGateway.DeepAgentKnowledgeSource.storesForWorkspace()[0]!.seedActive({
    type: "knowledge",
    description: `release test ${id}`,
    body,
    domain: "code",
    scope: "user-global",
    sensitivity: "public",
    risk: "low",
    confidence: { evidence_strength: "strong", support_count: 1 },
    provenance: { source: "runner", run_ref: `run_${id}`, evidence_refs: [`evidence_${id}`] },
    idSlug: id,
  })
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("DeepAgent released knowledge HTTP API", () => {
  it.instance(
    "commits review decisions against the listed store and rejects stale or legacy refs without writing",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      expect((yield* get(instance.directory, "/deepagent/knowledge/pending")).status).toBe(200)
      const input = {
        type: "knowledge" as const,
        description: "exact review authority",
        body: "exact review authority",
        domain: "code",
        sensitivity: "public" as const,
        risk: "low" as const,
        confidence: { evidence_strength: "strong" as const, support_count: 1 },
        provenance: { source: "runner" as const, run_ref: "run_review_exact", evidence_refs: ["evidence_review"] },
        idSlug: "same-review-id",
      }
      const userGlobalStore = AgentGateway.DeepAgentKnowledgeSource.storesForWorkspace(instance.directory)[0]!
      const projectStore = AgentGateway.DeepAgentKnowledgeSource.storesForWorkspace(instance.directory)[1]!
      const userGlobal = userGlobalStore.stageCandidate(
        { ...input, scope: "user-global" },
        { requireExactCandidate: true },
      )
      const project = projectStore.stageCandidate(
        {
          ...input,
          scope: "project-shared",
          projectId: AgentGateway.DeepAgentDurableKnowledgeStore.projectIdForWorkspace(instance.directory),
        },
        { requireExactCandidate: true },
      )
      expect(project.id).toBe(userGlobal.id)

      const pending = yield* get(instance.directory, "/deepagent/knowledge/pending")
      expect(pending.status).toBe(200)
      const items = (pending.body as { readonly items: readonly Record<string, unknown>[] }).items.filter(
        (item) => item.id === project.id,
      )
      expect(items).toHaveLength(2)
      const projectRef = items.find((item) => item.sourceStore === "project")!
      const decisionPayload = {
        sourceStore: projectRef.sourceStore,
        id: projectRef.id,
        version: projectRef.version,
        hash: projectRef.hash,
        candidateId: projectRef.candidateId,
        fingerprint: projectRef.fingerprint,
        expectedGovernanceRevision: projectRef.governanceRevision,
      }
      const approved = yield* post(instance.directory, "/deepagent/knowledge/approve", decisionPayload)
      expect(approved.status).toBe(200)
      expect(approved.body).toMatchObject({
        updated: { sourceStore: "project", id: project.id, approval_status: "approved" },
      })
      expect(projectStore.documentStore.get(project.id)?.status).toBe("active")
      expect(userGlobalStore.documentStore.get(userGlobal.id)?.status).toBe("candidate")
      expect(
        AgentGateway.DeepAgentDocumentStore.getGovernanceEnvelope(projectStore.documentStore.get(project.id)!),
      ).toMatchObject({ actor_type: "human", actor_id: "server", review_status: "approved" })
      const projectVersion = projectStore.documentStore.get(project.id)!.version
      const userGlobalVersion = userGlobalStore.documentStore.get(userGlobal.id)!.version

      expect((yield* post(instance.directory, "/deepagent/knowledge/approve", decisionPayload)).status).toBe(409)
      expect((yield* post(instance.directory, "/deepagent/knowledge/reject-ids", decisionPayload)).status).toBe(409)
      expect((yield* post(instance.directory, "/deepagent/knowledge/approve", { ids: [project.id] })).status).toBe(400)
      expect(projectStore.documentStore.get(project.id)!.version).toBe(projectVersion)
      expect(userGlobalStore.documentStore.get(userGlobal.id)!.version).toBe(userGlobalVersion)
    }),
    { git: false },
    testTimeout,
  )

  it.instance(
    "reconciles the original reject after a released-head CAS conflict without another governance revision",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      expect((yield* get(instance.directory, "/deepagent/knowledge/pending")).status).toBe(200)
      const project = seedProject(instance.directory, "reject-reconcile", "project rejection authority")
      const userGlobal = seedUserGlobal("reject-reconcile", "global authority with the same id")
      expect(project.id).toBe(userGlobal.id)
      const stores = AgentGateway.DeepAgentKnowledgeSource.storesForWorkspace(instance.directory)
      const authority = { userGlobal: stores[0]!.documentStore, project: stores[1]!.documentStore }
      const baselineResponse = yield* post(instance.directory, "/deepagent/knowledge/release-baseline", {
        snapshotId: "snapshot_reject_reconcile_baseline",
        evaluationId: "evaluation_reject_reconcile_baseline",
        candidateRefs: [
          AgentGateway.DeepAgentReleasedSnapshot.documentRef(project, "project"),
          AgentGateway.DeepAgentReleasedSnapshot.documentRef(userGlobal, "user_global"),
        ],
        baselineRef: "reject-reconcile-baseline",
      })
      expect(baselineResponse.status).toBe(200)
      const database = yield* Database.Service
      const head = yield* database.db.select().from(ReleasedKnowledgeSnapshotHeadTable).get()
      const scope = {
        securityNamespaceId: head!.security_namespace_id,
        projectScopeKey: head!.project_scope_key,
        legacyProjectId: AgentGateway.DeepAgentDurableKnowledgeStore.projectIdForWorkspace(instance.directory),
      }
      const baseline = (yield* AgentGateway.DeepAgentReleasedSnapshot.current(database.db, scope))!
      const pending = yield* get(instance.directory, "/deepagent/knowledge/pending")
      const projectRef = (pending.body as { readonly items: readonly Record<string, unknown>[] }).items.find(
        (item) => item.sourceStore === "project" && item.id === project.id,
      )!
      expect(projectRef).toMatchObject({ version: project.version, hash: project.hash, approval_status: "approved" })
      const payload = {
        sourceStore: projectRef.sourceStore as "project",
        id: projectRef.id as string,
        version: projectRef.version as number,
        hash: projectRef.hash as string,
        candidateId: projectRef.candidateId as string,
        fingerprint: projectRef.fingerprint as string,
        expectedGovernanceRevision: projectRef.governanceRevision as string,
      }
      const localRef = AgentGateway.DeepAgentKnowledgeSource.listAllForWorkspace(instance.directory).find(
        (item) => item.sourceStore === "project" && item.id === project.id,
      )!
      expect(localRef.sourceStore).toBe("project")
      expect(payload.id).toBe(localRef.id)
      expect(payload.version).toBe(localRef.version)
      expect(payload.hash).toBe(localRef.hash)
      expect(payload.candidateId).toBe(localRef.candidateId)
      expect(payload.fingerprint).toBe(localRef.fingerprint)
      expect(payload.expectedGovernanceRevision).toBe(localRef.governanceRevision)

      AgentGateway.DeepAgentKnowledgeSource.commitReviewDecisionForWorkspace(
        instance.directory,
        { ...payload, governanceRevision: payload.expectedGovernanceRevision },
        "reject",
        { type: "human", id: "server" },
      )
      const rejectedVersion = stores[1]!.documentStore.get(project.id)!.version
      const competing = (yield* AgentGateway.DeepAgentReleasedSnapshot.publish(
        database.db,
        {
          snapshotId: "snapshot_reject_reconcile_competing",
          evaluationId: "evaluation_reject_reconcile_competing",
          scope,
          expectedParentSnapshotId: baseline.snapshotId,
          expectedGeneration: baseline.generation,
          releaseKind: "rollback",
          verdict: "passed",
          documents: baseline.documents,
          evaluationMatrix: { kind: "competing_release" },
          baselineRef: "reject-reconcile-competing",
          repetitions: 1,
          actor: { type: "system", id: "test" },
        },
        authority,
      ))!
      const stale = yield* AgentGateway.DeepAgentReleasedSnapshot.revoke(
        database.db,
        {
          scope,
          expectedParent: baseline,
          document: AgentGateway.DeepAgentReleasedSnapshot.documentRef(project, "project"),
          actor: { type: "human", id: "server" },
        },
        authority,
      ).pipe(Effect.flip)
      expect(stale).toMatchObject({ _tag: "DeepAgentReleasedSnapshot.SnapshotConflictError" })
      expect((yield* AgentGateway.DeepAgentReleasedSnapshot.current(database.db, scope))?.snapshotId).toBe(
        competing.snapshotId,
      )
      const rejected = stores[1]!.documentStore.get(project.id)!
      expect(rejected).toMatchObject({ version: payload.version + 1, status: "rejected" })
      expect(AgentGateway.DeepAgentDocumentStore.getGovernanceEnvelope(rejected)).toMatchObject({
        fingerprint: payload.fingerprint,
        review_status: "rejected",
        actor_type: "human",
        actor_id: "server",
        reason: "human review rejected",
        source_doc_ref: `${payload.id}@v${payload.version}`,
      })
      expect(stores[1]!.documentStore.get(payload.id, payload.version)).not.toBeNull()
      expect(
        AgentGateway.DeepAgentKnowledgeSource.commitReviewDecisionForWorkspace(
          instance.directory,
          { ...payload, governanceRevision: payload.expectedGovernanceRevision },
          "reject",
          { type: "human", id: "server" },
        ),
      ).toMatchObject({ version: payload.version + 1, approval_status: "rejected" })

      const retried = yield* post(instance.directory, "/deepagent/knowledge/reject-ids", payload)
      expect(retried.status).toBe(200)
      expect(retried.body).toMatchObject({
        updated: { sourceStore: "project", id: project.id, approval_status: "rejected" },
        release_revocation: {
          state: "revoked",
          previous_snapshot_id: competing.snapshotId,
          generation: competing.generation + 1,
          document_count: 1,
        },
      })
      expect(stores[1]!.documentStore.get(project.id)!.version).toBe(rejectedVersion)
      const current = (yield* AgentGateway.DeepAgentReleasedSnapshot.current(database.db, scope))!
      expect(current.documents).toEqual([AgentGateway.DeepAgentReleasedSnapshot.documentRef(userGlobal, "user_global")])
      expect((yield* AgentGateway.DeepAgentReleasedSnapshot.get(database.db, scope, baseline.snapshotId))?.documents).toEqual(
        baseline.documents,
      )

      const replay = yield* post(instance.directory, "/deepagent/knowledge/reject-ids", payload)
      expect(replay.status).toBe(200)
      expect(replay.body).toMatchObject({
        release_revocation: { state: "already_revoked", active_snapshot_id: current.snapshotId },
      })
      expect(stores[1]!.documentStore.get(project.id)!.version).toBe(rejectedVersion)
    }),
    { git: false },
    testTimeout,
  )

  it.instance(
    "rejects evaluated publish before an explicit baseline exists",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const response = yield* post(instance.directory, "/deepagent/knowledge/ship-gate", {
        snapshotId: "snapshot_without_baseline",
        evaluationId: "evaluation_without_baseline",
        expectedParent: { snapshotId: null, generation: 0, membershipHash: null },
        tasks: ["task_without_baseline"],
        metrics: [
          { group: "general", task: "task_without_baseline", metric: 1 },
          { group: "high", task: "task_without_baseline", metric: 1 },
          { group: "max", task: "task_without_baseline", metric: 1 },
        ],
        candidateRefs: [],
      })

      expect(response.status).toBe(400)
      expect(errorMessage(response.body)).toContain("baseline is required")
    }),
    { git: false },
    testTimeout,
  )

  it.instance(
    "publishes the evaluated v1 revision after the store has advanced to v2",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const baseline = yield* releaseBaseline(instance.directory, "historical_revision")
      const v1 = seedProject(instance.directory, "historical_revision", "evaluated body v1")
      const v1Ref = AgentGateway.DeepAgentReleasedSnapshot.documentRef(v1, "project")
      const v2 = AgentGateway.DeepAgentKnowledgeSource.storesForWorkspace(instance.directory)[1]!.documentStore.update(
        v1.id,
        "latest body v2",
      )

      expect(v2.id).toBe(v1.id)
      expect(v2.version).toBe(v1.version + 1)

      const response = yield* shipGate(instance.directory, {
        id: "historical_revision",
        parent: baseline,
        candidates: [v1Ref],
        max: 1,
      })
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ ship: true, active_snapshot_id: "snapshot_historical_revision" })

      const database = yield* Database.Service
      const documents = yield* database.db
        .select()
        .from(ReleasedKnowledgeSnapshotDocumentTable)
        .where(eq(ReleasedKnowledgeSnapshotDocumentTable.snapshot_id, "snapshot_historical_revision"))
        .all()

      expect(documents).toHaveLength(1)
      expect(documents[0]).toMatchObject({
        source_store: "project",
        doc_id: v1.id,
        doc_version: v1.version,
        doc_hash: v1.hash,
      })
      expect(documents[0]?.doc_hash).not.toBe(v2.hash)
    }),
    { git: false },
    testTimeout,
  )

  it.instance(
    "uses sourceStore to resolve the exact document when both stores contain the same id",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const baseline = yield* releaseBaseline(instance.directory, "same_id_store")
      const userGlobal = seedUserGlobal("same_id_store", "user-global body")
      const project = seedProject(instance.directory, "same_id_store", "project body")

      expect(project.id).toBe(userGlobal.id)
      expect(project.hash).not.toBe(userGlobal.hash)

      const response = yield* shipGate(instance.directory, {
        id: "same_id_store",
        parent: baseline,
        candidates: [AgentGateway.DeepAgentReleasedSnapshot.documentRef(project, "project")],
        max: 1,
      })
      expect(response.status).toBe(200)

      const database = yield* Database.Service
      const documents = yield* database.db
        .select()
        .from(ReleasedKnowledgeSnapshotDocumentTable)
        .where(eq(ReleasedKnowledgeSnapshotDocumentTable.snapshot_id, "snapshot_same_id_store"))
        .all()

      expect(documents).toHaveLength(1)
      expect(documents[0]).toMatchObject({
        source_store: "project",
        doc_id: project.id,
        doc_version: project.version,
        doc_hash: project.hash,
      })
      expect(documents[0]?.doc_hash).not.toBe(userGlobal.hash)
    }),
    { git: false },
    testTimeout,
  )

  it.instance(
    "rejects an evaluated publish when the expected parent no longer matches",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const baseline = yield* releaseBaseline(instance.directory, "parent_conflict")
      const response = yield* post(instance.directory, "/deepagent/knowledge/ship-gate", {
        snapshotId: "snapshot_parent_conflict",
        evaluationId: "evaluation_parent_conflict",
        expectedParent: { ...expectedParent(baseline), generation: baseline.generation + 1 },
        tasks: ["task_parent_conflict"],
        metrics: [
          { group: "general", task: "task_parent_conflict", metric: 1 },
          { group: "high", task: "task_parent_conflict", metric: 1 },
          { group: "max", task: "task_parent_conflict", metric: 1 },
        ],
        candidateRefs: [],
      })

      expect(response.status).toBe(400)
      expect(errorMessage(response.body)).toContain("parent changed")
    }),
    { git: false },
    testTimeout,
  )

  it.instance(
    "rejects duplicate candidate authorities without recording a release",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const baseline = yield* releaseBaseline(instance.directory, "duplicate_candidates")
      const v1 = seedProject(instance.directory, "duplicate_candidates", "candidate body v1")
      const v1Ref = AgentGateway.DeepAgentReleasedSnapshot.documentRef(v1, "project")
      const duplicate = yield* shipGate(instance.directory, {
        id: "duplicate_candidate_refs",
        parent: baseline,
        candidates: [v1Ref, v1Ref],
        max: 1,
      })

      expect(duplicate.status).toBe(400)
      expect(errorMessage(duplicate.body)).toContain("duplicate document authority")

      const v2 = AgentGateway.DeepAgentKnowledgeSource.storesForWorkspace(instance.directory)[1]!.documentStore.update(
        v1.id,
        "candidate body v2",
      )
      const conflict = yield* shipGate(instance.directory, {
        id: "conflicting_candidate_refs",
        parent: baseline,
        candidates: [v1Ref, AgentGateway.DeepAgentReleasedSnapshot.documentRef(v2, "project")],
        max: 1,
      })

      expect(conflict.status).toBe(400)
      expect(errorMessage(conflict.body)).toContain("duplicate document authority")

      const database = yield* Database.Service
      expect(
        yield* database.db
          .select()
          .from(ReleasedKnowledgeEvaluationTable)
          .where(eq(ReleasedKnowledgeEvaluationTable.evaluation_id, "evaluation_duplicate_candidate_refs"))
          .all(),
      ).toHaveLength(0)
      expect(
        yield* database.db
          .select()
          .from(ReleasedKnowledgeEvaluationTable)
          .where(eq(ReleasedKnowledgeEvaluationTable.evaluation_id, "evaluation_conflicting_candidate_refs"))
          .all(),
      ).toHaveLength(0)
      expect(
        yield* database.db
          .select()
          .from(ReleasedKnowledgeSnapshotTable)
          .where(eq(ReleasedKnowledgeSnapshotTable.snapshot_id, "snapshot_duplicate_candidate_refs"))
          .all(),
      ).toHaveLength(0)
      expect(
        yield* database.db
          .select()
          .from(ReleasedKnowledgeSnapshotTable)
          .where(eq(ReleasedKnowledgeSnapshotTable.snapshot_id, "snapshot_conflicting_candidate_refs"))
          .all(),
      ).toHaveLength(0)

      const passed = yield* shipGate(instance.directory, {
        id: "after_duplicate_candidate_refs",
        parent: baseline,
        candidates: [AgentGateway.DeepAgentReleasedSnapshot.documentRef(v2, "project")],
        max: 1,
      })
      expect(passed.status).toBe(200)
      expect(passed.body).toMatchObject({
        ship: true,
        active_snapshot_id: "snapshot_after_duplicate_candidate_refs",
        generation: baseline.generation + 1,
      })
    }),
    { git: false },
    testTimeout,
  )

  it.instance(
    "rejects incomplete or ambiguous metric evidence without advancing the released head",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const baseline = yield* releaseBaseline(instance.directory, "invalid_metrics")
      const task = "task_invalid_metrics"
      const validMetrics = [
        { group: "general", task, metric: 1 },
        { group: "high", task, metric: 1 },
        { group: "max", task, metric: 1 },
      ]
      const invalid = [
        { id: "empty_tasks", tasks: [], metrics: [] },
        { id: "duplicate_tasks", tasks: [task, task], metrics: validMetrics },
        { id: "empty_metrics", tasks: [task], metrics: [] },
        { id: "partial_metrics", tasks: [task], metrics: validMetrics.slice(0, 2) },
        { id: "duplicate_metrics", tasks: [task], metrics: [...validMetrics, validMetrics[2]] },
        {
          id: "extra_metrics",
          tasks: [task],
          metrics: [...validMetrics, { group: "max", task: "task_not_declared", metric: 1 }],
        },
        {
          id: "non_finite_metric",
          tasks: [task],
          metrics: validMetrics.map((metric, index) =>
            index === 2 ? { ...metric, metric: Number.POSITIVE_INFINITY } : metric,
          ),
        },
        { id: "unsupported_repeats", tasks: [task], metrics: validMetrics, repeats: 2 },
      ] as const

      for (const input of invalid) {
        const response = yield* post(instance.directory, "/deepagent/knowledge/ship-gate", {
          snapshotId: `snapshot_${input.id}`,
          evaluationId: `evaluation_${input.id}`,
          expectedParent: expectedParent(baseline),
          tasks: input.tasks,
          metrics: input.metrics,
          candidateRefs: [],
          ...("repeats" in input ? { repeats: input.repeats } : {}),
        })
        expect(response.status).toBe(400)
      }

      const candidate = seedProject(instance.directory, "after_invalid_metrics", "candidate after invalid evidence")
      const passed = yield* shipGate(instance.directory, {
        id: "after_invalid_metrics",
        parent: baseline,
        candidates: [AgentGateway.DeepAgentReleasedSnapshot.documentRef(candidate, "project")],
        max: 1,
      })
      expect(passed.status).toBe(200)
      expect(passed.body).toMatchObject({
        ship: true,
        active_snapshot_id: "snapshot_after_invalid_metrics",
        generation: baseline.generation + 1,
      })
    }),
    { git: false },
    testTimeout,
  )

  it.instance(
    "keeps the passed head unchanged after a failed evaluation",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const baseline = yield* releaseBaseline(instance.directory, "failed_head")
      const failed = yield* shipGate(instance.directory, {
        id: "failed_head",
        parent: baseline,
        candidates: [],
        max: 0,
      })

      expect(failed.status).toBe(200)
      expect(failed.body).toMatchObject({
        ship: false,
        release_snapshot_id: "snapshot_failed_head",
        active_snapshot_id: baseline.active_snapshot_id,
        generation: baseline.generation,
        membership_hash: baseline.membership_hash,
      })

      const candidate = seedProject(instance.directory, "after_failed_head", "candidate after failed release")
      const passed = yield* shipGate(instance.directory, {
        id: "after_failed_head",
        parent: baseline,
        candidates: [AgentGateway.DeepAgentReleasedSnapshot.documentRef(candidate, "project")],
        max: 1,
      })

      expect(passed.status).toBe(200)
      expect(passed.body).toMatchObject({
        ship: true,
        active_snapshot_id: "snapshot_after_failed_head",
        generation: baseline.generation + 1,
      })
    }),
    { git: false },
    testTimeout,
  )
})
