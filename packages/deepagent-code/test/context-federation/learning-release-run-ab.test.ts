import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ContextArtifactStore } from "@deepagent-code/core/context-federation/artifact-store"
import { ContextFederation } from "@deepagent-code/core/context-federation/federation"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import { FederatedContextQuery } from "@deepagent-code/core/context-federation/query"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import {
  IndexSpaceID,
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
} from "@deepagent-code/core/context-federation/reference"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { SessionProviderAttempt } from "@deepagent-code/core/context-federation/provider-attempt"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import {
  SessionContextSelectionTable,
  SessionProviderAttemptTable,
} from "@deepagent-code/core/context-federation/session-sql"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "@deepagent-code/core/context-federation/sql"
import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentDurableLearning } from "@deepagent-code/core/deepagent/durable-learning"
import {
  DurableKnowledgeStore,
  projectIdForWorkspace,
  projectKnowledgeRoot,
} from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { createInitialRoundState } from "@deepagent-code/core/deepagent/round-state"
import { Project, ProjectV2 } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import type { Session } from "../../src/session/session"
import { LiveContextQueryAuthorization } from "../../src/context-federation/query-authorization"
import { SessionFederatedContext } from "../../src/context-federation/session-context-runtime"
import { LocationIndexRuntime } from "../../src/location-index/runtime"

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-learning-release-run-ab-"))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("durable learning released Run A to Run B", () => {
  test("binds only Run A's released exact document revision into Run B's provider attempt", async () => {
    const workspace = path.join(root, "workspace")
    mkdirSync(workspace, { recursive: true })
    const namespace = SecurityNamespaceID.make("sec_learning_release_run_ab")
    const location = LocationKey.make("loc_learning_release_run_ab")
    const projectScope = ProjectScopeKey.make("prjctx_learning_release_run_ab")
    const knowledgeProjectId = ProjectV2.ID.make(projectIdForWorkspace(workspace))
    const databaseProjectId = Project.ID.make("project-db-learning-release-run-ab")
    const sessionId = SessionSchema.ID.make("ses_learning_release_run_ab")
    const runAInputId = SessionMessage.ID.make("msg_learning_release_run_a")
    const runBInputId = SessionMessage.ID.make("msg_learning_release_run_b")
    const identity: Identity = {
      securityNamespaceId: namespace,
      locationKey: location,
      projectScopeKey: projectScope,
      indexSpaceId: IndexSpaceID.make("idx_learning_release_run_ab"),
      canonicalRoot: AbsolutePath.make(workspace),
      observedProjectId: knowledgeProjectId,
    }
    const releasedQueries: Array<DeepAgentReleasedSnapshot.Selection | undefined> = []
    const database = Database.layerFromPath(":memory:")
    const codec = ContextTokenCodec.make({
      activeKeyId: "learning-release-run-ab",
      keys: [{ id: "learning-release-run-ab", secret: Buffer.alloc(32, 7) }],
    })
    const artifacts = ContextArtifactStore.layer({
      securityNamespaceId: namespace,
      policy: "required",
      keyId: "learning-release-run-ab",
      encryptionKey: Buffer.alloc(32, 11),
      tokenCodec: codec,
      limits: {
        maxItemBytes: 32_000,
        maxSessionBytes: 128_000,
        maxGlobalBytes: 512_000,
        retentionMs: 60_000,
        tokenLifetimeMs: 120_000,
      },
    }).pipe(Layer.provide(database))
    const contexts = SessionContext.layer.pipe(Layer.provide(Layer.merge(database, artifacts)))
    const attempts = SessionProviderAttempt.layer.pipe(Layer.provide(database))
    const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
    const authorization = LiveContextQueryAuthorization.layer()
    const runtime = Layer.succeed(
      LocationIndexRuntime.Service,
      LocationIndexRuntime.Service.of({
        init: () => Effect.void,
        current: () =>
          Effect.succeed({
            identity,
            coordinator: { mutationEpoch: () => Effect.succeed(1) } as never,
          }),
      }),
    )
    const query = Layer.succeed(
      FederatedContextQuery.Service,
      FederatedContextQuery.Service.of({
        query: (input) =>
          Effect.sync(() => {
            releasedQueries.push(input.releasedKnowledgeSelection)
            const document = input.releasedKnowledgeSelection?.documents[0]
            if (!document) {
              return {
                statuses: [
                  ContextFederation.status.empty("knowledge", [
                    { source: "knowledge", revision: "unreleased", state: "ready" },
                  ]),
                ],
                hits: [],
                truncated: false,
                snapshotFingerprint: Hash.sha256("unreleased"),
              }
            }
            return {
              statuses: [
                ContextFederation.status.matched("knowledge", [
                  {
                    source: "knowledge",
                    revision: `${document.sourceStore}:${document.id}@v${document.version}:${document.hash}`,
                    state: "ready",
                  },
                ]),
              ],
              hits: [
                {
                  ref: {
                    graph: "knowledge" as const,
                    entityId: document.id,
                    binding: {
                      scope: "project" as const,
                      securityNamespaceId: namespace,
                      projectScopeKey: projectScope,
                    },
                    revision: CanonicalJson.stringify({
                      sourceStore: document.sourceStore,
                      id: document.id,
                      version: document.version,
                      hash: document.hash,
                    }),
                  },
                  title: document.id,
                  graph: "knowledge" as const,
                  excerpt: "Run A learned guidance",
                  provenance: [],
                  validity: { state: "current" as const },
                  score: 1,
                  sensitivity: "public" as const,
                },
              ],
              truncated: false,
              snapshotFingerprint: input.releasedKnowledgeSelection!.membershipHash,
            }
          }),
      }),
    )
    const app = SessionFederatedContext.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          database,
          artifacts,
          contexts,
          attempts,
          owners,
          authorization,
          runtime,
          query,
          Layer.succeed(ContextTokenCodec.Service, ContextTokenCodec.Service.of(codec)),
        ),
      ),
    )
    const testLayer = Layer.mergeAll(database, authorization, attempts, owners, app)

    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* seedAuthority({
          db,
          identity,
          databaseProjectId,
          sessionId,
          runAInputId,
          runBInputId,
          workspace,
        })
        const ownerToken = "provider-owner-learning-release-run-ab"
        const providerAttempts = yield* SessionProviderAttempt.Service
        const providerOwners = yield* SessionProviderOwner.Service
        const federation = yield* SessionFederatedContext.Service
        yield* providerOwners.register({ ownerToken, leaseMs: Number.MAX_SAFE_INTEGER - 1_000, now: 1 })

        const scope = {
          securityNamespaceId: namespace,
          projectScopeKey: projectScope,
          legacyProjectId: knowledgeProjectId,
        }
        const authority = {
          userGlobal: { get: () => null },
          project: new DurableKnowledgeStore(projectKnowledgeRoot(root, knowledgeProjectId)).documentStore,
        }
        const baseline = yield* DeepAgentReleasedSnapshot.publish(
          db,
          {
            snapshotId: "snapshot_learning_release_baseline",
            evaluationId: "evaluation_learning_release_baseline",
            scope,
            expectedParentSnapshotId: null,
            expectedGeneration: 0,
            releaseKind: "legacy_baseline",
            verdict: "passed",
            documents: [],
            evaluationMatrix: { run: "baseline" },
            baselineRef: "none",
            repetitions: 1,
            actor: { type: "system", id: "learning-release-test" },
            now: 10,
          },
          authority,
        )
        if (!baseline) return yield* Effect.die("baseline release is unavailable")

        const runA = yield* federation.resolve({
          session: session(sessionId, databaseProjectId, workspace),
          inputIds: [runAInputId],
          query: "complete Run A",
          agent,
          model,
          releasedKnowledgeSelection: baseline,
          now: 20,
        })
        const runAAttempt = yield* providerAttempts.prepare({
          ...(yield* federation.prepareProviderTurn({
            selection: runA.selection,
            envelope: runA.envelope,
            observedLocationMutationEpoch: runA.observedLocationMutationEpoch,
            requestHash: Hash.sha256("run-a-request"),
            providerId: model.providerID,
            now: 21,
          })),
          ownerToken,
        })
        yield* providerAttempts.sealPrepared({
          attemptId: runAAttempt.attemptId,
          expectedOwnerToken: ownerToken,
          preparedTurnHash: "a".repeat(64),
          wireRequestHash: "b".repeat(64),
          now: 22,
        })
        yield* providerAttempts.markDispatching({
          attemptId: runAAttempt.attemptId,
          expectedOwnerToken: ownerToken,
          now: 23,
        })
        yield* providerAttempts.markStreaming({
          attemptId: runAAttempt.attemptId,
          expectedOwnerToken: ownerToken,
          now: 24,
        })
        yield* providerAttempts.settle({
          attemptId: runAAttempt.attemptId,
          expectedOwnerToken: ownerToken,
          outcome: "settled",
          now: 25,
        })
        yield* federation.settleActivity(runA.selection, "settled")

        const learning = learningAdmission({ root, workspace, sessionId })
        const admitted = yield* DeepAgentDurableLearning.admit(db, learning, { authorityRoot: root })
        const completed = yield* DeepAgentDurableLearning.drain(db, {
          owner: "learning-worker-run-ab",
          authorityRoot: root,
        })
        expect(completed).toHaveLength(1)
        expect(completed[0]).toMatchObject({ jobId: admitted.job.jobId, state: "completed" })

        const store = new DurableKnowledgeStore(projectKnowledgeRoot(root, knowledgeProjectId))
        const activeRef = store.listByStatus("active").at(0)
        if (!activeRef) return yield* Effect.die("Run A did not produce active durable knowledge")
        const learned = store.documentStore.get(activeRef.id, activeRef.version)
        if (!learned) return yield* Effect.die("Run A active document disappeared")
        const releasedRef = DeepAgentReleasedSnapshot.documentRef(learned, "project")

        const released = yield* DeepAgentReleasedSnapshot.publish(
          db,
          {
            snapshotId: "snapshot_learning_release_run_a",
            evaluationId: "evaluation_learning_release_run_a",
            scope,
            expectedParentSnapshotId: baseline.snapshotId,
            expectedGeneration: baseline.generation,
            releaseKind: "evaluated",
            verdict: "passed",
            documents: [releasedRef],
            evaluationMatrix: { run: "A", jobId: admitted.job.jobId },
            baselineRef: baseline.snapshotId,
            repetitions: 1,
            actor: { type: "system", id: "learning-release-test" },
            now: 30,
          },
          { userGlobal: authority.userGlobal, project: store.documentStore },
        )
        if (!released) return yield* Effect.die("Run A release is unavailable")

        const unpublished = store.documentStore.update(learned.id, `${learned.body}\nUnpublished follow-up.`)
        expect(unpublished.version).toBe(learned.version + 1)
        expect(unpublished.status).toBe("active")
        expect((yield* DeepAgentReleasedSnapshot.current(db, scope))?.documents).toEqual([releasedRef])

        const current = yield* DeepAgentReleasedSnapshot.current(db, scope)
        if (!current) return yield* Effect.die("released head disappeared before Run B")
        const runB = yield* federation.resolve({
          session: session(sessionId, databaseProjectId, workspace),
          inputIds: [runBInputId],
          query: "apply Run A learned guidance",
          agent,
          model,
          releasedKnowledgeSelection: current,
          now: 40,
        })
        const runBRequestHash = Hash.sha256(
          CanonicalJson.stringify({
            prompt: "apply Run A learned guidance",
            releasedKnowledge: DeepAgentReleasedSnapshot.binding(current),
          }),
        )
        const runBAttempt = yield* providerAttempts.prepare({
          ...(yield* federation.prepareProviderTurn({
            selection: runB.selection,
            envelope: runB.envelope,
            observedLocationMutationEpoch: runB.observedLocationMutationEpoch,
            requestHash: runBRequestHash,
            providerId: model.providerID,
            now: 41,
          })),
          ownerToken,
        })

        expect(runB.selection.activityId).not.toBe(runA.selection.activityId)
        expect(runB.selection.releasedKnowledgeBinding).toMatchObject({
          state: "bound",
          snapshotId: released.snapshotId,
          exactRefs: [releasedRef],
        })
        expect(runB.selection.selectedRefs).toHaveLength(1)
        expect(JSON.parse(runB.selection.selectedRefs[0]!.ref.revision)).toEqual({
          sourceStore: releasedRef.sourceStore,
          id: releasedRef.id,
          version: releasedRef.version,
          hash: releasedRef.hash,
        })
        expect(releasedQueries.map((selection) => selection?.documents ?? [])).toEqual([[], [releasedRef]])

        const storedSelection = yield* db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, runB.selection.selectionId))
          .get()
        const storedAttempt = yield* db
          .select()
          .from(SessionProviderAttemptTable)
          .where(eq(SessionProviderAttemptTable.attempt_id, runBAttempt.attemptId))
          .get()
        expect(storedSelection?.released_knowledge_exact_refs).toEqual([releasedRef])
        expect(storedAttempt).toMatchObject({
          selection_id: runB.selection.selectionId,
          request_hash: runBRequestHash,
          provider_id: model.providerID,
          state: "prepared",
        })
        expect(storedSelection?.released_knowledge_exact_refs).not.toContainEqual(
          expect.objectContaining({ version: unpublished.version, hash: unpublished.hash }),
        )
        expect(storedSelection?.released_knowledge_exact_refs).not.toContainEqual(
          expect.objectContaining({ version: learned.version - 1 }),
        )
      }).pipe(Effect.provide(testLayer), Effect.scoped),
    )
  }, 30_000)
})

function learningAdmission(input: {
  readonly root: string
  readonly workspace: string
  readonly sessionId: SessionSchema.ID
}): DeepAgentDurableLearning.Admission {
  const runId = "run-learning-release-a"
  const terminalPath = path.join(input.root, "gateway-runs", runId, "DEEPAGENT_RUN_STATE.json")
  const admission = {
    baseDir: input.root,
    workspacePath: input.workspace,
    rejectedBufferDir: path.join(input.root, "memory"),
    terminalArtifact: {
      schema_version: "deepagent-code.learning_terminal_artifact.v1" as const,
      path: terminalPath,
      sha256: "",
      learning_admission_fingerprint: "",
    },
    input: {
      projectID: "untrusted-request-project-id",
      sessionID: input.sessionId,
      runID: runId,
      mode: "high" as const,
      roundState: createInitialRoundState("high"),
      totalRounds: 1,
      finalStatus: "completed" as const,
      trigger: "session_finalization" as const,
      policy: "auto_merge_safe_project" as const,
    },
  }
  const fingerprint = DeepAgentDurableLearning.admissionFingerprint(admission)
  const terminal = `${JSON.stringify(
    {
      schema_version: "deepagent_global_run_state.v1",
      run_id: runId,
      generic_agent_session_id: input.sessionId,
      agent_mode: "high",
      state: "completed",
      learning_admission_fingerprint: fingerprint,
    },
    null,
    2,
  )}\n`
  mkdirSync(path.dirname(terminalPath), { recursive: true })
  writeFileSync(terminalPath, terminal)
  return {
    ...admission,
    terminalArtifact: {
      ...admission.terminalArtifact,
      sha256: Hash.sha256(terminal),
      learning_admission_fingerprint: fingerprint,
    },
  }
}

function seedAuthority(input: {
  readonly db: Database.Interface["db"]
  readonly identity: Identity
  readonly databaseProjectId: Project.ID
  readonly sessionId: SessionSchema.ID
  readonly runAInputId: SessionMessage.ID
  readonly runBInputId: SessionMessage.ID
  readonly workspace: string
}) {
  return Effect.gen(function* () {
    yield* input.db
      .insert(SecurityNamespaceTable)
      .values({
        id: input.identity.securityNamespaceId,
        kind: "implicit_local",
        binding_hash: "learning-release-run-ab-namespace",
        created_at: 1,
      })
      .run()
    yield* input.db
      .insert(ProjectScopeIdentityTable)
      .values({
        security_namespace_id: input.identity.securityNamespaceId,
        project_scope_key: input.identity.projectScopeKey,
        project_kind: "registered_root",
        project_identity_hash: "learning-release-run-ab-project",
        observed_project_id: input.identity.observedProjectId,
        created_at: 1,
      })
      .run()
    yield* input.db
      .insert(LocationIdentityTable)
      .values({
        security_namespace_id: input.identity.securityNamespaceId,
        location_key: input.identity.locationKey,
        project_scope_key: input.identity.projectScopeKey,
        canonical_root: input.workspace,
        observed_project_id: input.identity.observedProjectId,
        created_at: 1,
      })
      .run()
    yield* input.db
      .insert(ProjectTable)
      .values({
        id: input.databaseProjectId,
        worktree: AbsolutePath.make(input.workspace),
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      .run()
    yield* input.db
      .insert(SessionTable)
      .values({
        id: input.sessionId,
        project_id: input.databaseProjectId,
        slug: "learning-release-run-ab",
        directory: input.workspace,
        title: "Learning release Run A to Run B",
        version: "test",
        time_created: 1,
        time_updated: 1,
      })
      .run()
    yield* input.db
      .insert(SessionInputTable)
      .values([
        {
          id: input.runAInputId,
          session_id: input.sessionId,
          prompt: new Prompt({ text: "complete Run A" }),
          delivery: "steer",
          admitted_seq: 0,
          promoted_seq: 0,
        },
        {
          id: input.runBInputId,
          session_id: input.sessionId,
          prompt: new Prompt({ text: "apply Run A learned guidance" }),
          delivery: "steer",
          admitted_seq: 1,
          promoted_seq: 1,
        },
      ])
      .run()
  })
}

function session(id: SessionSchema.ID, projectID: Project.ID, workspace: string): Session.Info {
  return {
    id,
    slug: "learning-release-run-ab",
    projectID,
    directory: workspace,
    title: "Learning release Run A to Run B",
    version: "test",
    time: { created: 1, updated: 1 },
  } as Session.Info
}

const model = {
  id: "model-learning-release-run-ab",
  providerID: "provider-learning-release-run-ab",
  api: {
    id: "model-learning-release-run-ab",
    url: "https://example.invalid",
    npm: "@ai-sdk/openai-compatible",
  },
  name: "Learning release Run A to Run B",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
} as Provider.Model

const agent = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "context_query", pattern: "*", action: "allow" }],
} as Agent.Info
