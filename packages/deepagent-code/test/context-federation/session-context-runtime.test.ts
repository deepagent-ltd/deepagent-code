import { describe, expect, test } from "bun:test"
import { ContextArtifactStore } from "@deepagent-code/core/context-federation/artifact-store"
import { ContextFederation } from "@deepagent-code/core/context-federation/federation"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import { FederatedContextQuery } from "@deepagent-code/core/context-federation/query"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { SessionProviderAttempt } from "@deepagent-code/core/context-federation/provider-attempt"
import { SessionProviderOwner } from "@deepagent-code/core/context-federation/provider-owner"
import {
  SessionContextValidationTable,
  SessionProviderAttemptTable,
} from "@deepagent-code/core/context-federation/session-sql"
import {
  IndexSpaceID,
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
} from "@deepagent-code/core/context-federation/reference"
import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "@deepagent-code/core/context-federation/sql"
import { Database } from "@deepagent-code/core/database/database"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ProjectV2 } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { Hash } from "@deepagent-code/core/util/hash"
import { Effect, Layer } from "effect"
import { randomBytes } from "node:crypto"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import type { Session } from "../../src/session/session"
import { LiveContextQueryAuthorization } from "../../src/context-federation/query-authorization"
import { SessionFederatedContext } from "../../src/context-federation/session-context-runtime"
import { LocationIndexRuntime } from "../../src/location-index/runtime"

const namespace = SecurityNamespaceID.make("sec_session_runtime")
const location = LocationKey.make("loc_session_runtime")
const projectScope = ProjectScopeKey.make("prjctx_session_runtime")
const sessionId = SessionSchema.ID.make("ses_session_runtime")
const inputId = SessionMessage.ID.make("msg_session_runtime")
const nextInputId = SessionMessage.ID.make("msg_session_runtime_next")
const projectId = ProjectV2.ID.make("global")
const identity: Identity = {
  securityNamespaceId: namespace,
  locationKey: location,
  projectScopeKey: projectScope,
  indexSpaceId: IndexSpaceID.make("idx_session_runtime"),
  canonicalRoot: AbsolutePath.make("/workspace"),
  observedProjectId: projectId,
}

describe("SessionFederatedContext", () => {
  test("keeps projection bytes across unrelated mutations and durably brackets provider work", async () => {
    const database = Database.layerFromPath(":memory:")
    const codec = ContextTokenCodec.make({ activeKeyId: "test", keys: [{ id: "test", secret: randomBytes(32) }] })
    const artifacts = ContextArtifactStore.layer({
      securityNamespaceId: namespace,
      policy: "required",
      keyId: "artifact-test",
      encryptionKey: randomBytes(32),
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
    const mutation = { value: 1 }
    const revision = { value: "revision-1" }
    const releasedKnowledgeQueries: (string | undefined)[] = []
    const runtime = Layer.succeed(
      LocationIndexRuntime.Service,
      LocationIndexRuntime.Service.of({
        init: () => Effect.void,
        current: () =>
          Effect.succeed({
            identity,
            coordinator: {
              mutationEpoch: () => Effect.succeed(mutation.value),
            } as never,
          }),
      }),
    )
    const query = Layer.succeed(
      FederatedContextQuery.Service,
      FederatedContextQuery.Service.of({
        query: (input) =>
          Effect.sync(() => {
            releasedKnowledgeQueries.push(input.releasedKnowledgeSelection?.snapshotId)
            return result(revision.value)
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
        const attempts = yield* SessionProviderAttempt.Service
        const owners = yield* SessionProviderOwner.Service
        const ownerToken = "session-context-runtime-owner"
        yield* owners.register({ ownerToken, leaseMs: Number.MAX_SAFE_INTEGER - 1_000, now: 1 })
        const admit = (input: SessionFederatedContext.AttemptAdmission) => attempts.prepare({ ...input, ownerToken })
        yield* db
          .insert(SecurityNamespaceTable)
          .values({
            id: namespace,
            kind: "implicit_local",
            binding_hash: "namespace-binding",
            created_at: 1,
          })
          .run()
        yield* db
          .insert(ProjectScopeIdentityTable)
          .values({
            security_namespace_id: namespace,
            project_scope_key: projectScope,
            project_kind: "registered_root",
            project_identity_hash: "project-identity",
            observed_project_id: projectId,
            created_at: 1,
          })
          .run()
        yield* db
          .insert(LocationIdentityTable)
          .values({
            security_namespace_id: namespace,
            location_key: location,
            project_scope_key: projectScope,
            canonical_root: "/workspace",
            observed_project_id: projectId,
            created_at: 1,
          })
          .run()
        yield* db
          .insert(ProjectTable)
          .values({
            id: projectId,
            worktree: AbsolutePath.make("/workspace"),
            sandboxes: [],
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionId,
            project_id: projectId,
            slug: "runtime",
            directory: "/workspace",
            title: "Runtime",
            version: "test",
          })
          .run()
        yield* db
          .insert(SessionInputTable)
          .values({
            id: inputId,
            session_id: sessionId,
            prompt: new Prompt({ text: "find the session runner" }),
            delivery: "steer",
            admitted_seq: 0,
            promoted_seq: 0,
          })
          .run()
        yield* db
          .insert(SessionInputTable)
          .values({
            id: nextInputId,
            session_id: sessionId,
            prompt: new Prompt({ text: "start the next released-knowledge activity" }),
            delivery: "steer",
            admitted_seq: 1,
            promoted_seq: 1,
          })
          .run()

        const releasedScope = {
          securityNamespaceId: namespace,
          projectScopeKey: projectScope,
          legacyProjectId: projectId,
        }
        const s1Document = releasedDocument(1)
        const documentAuthority = releasedDocumentAuthority([s1Document, releasedDocument(2)])
        const s1 = yield* DeepAgentReleasedSnapshot.publish(
          db,
          {
            snapshotId: "snapshot_session_runtime_s1",
            evaluationId: "evaluation_session_runtime_s1",
            scope: releasedScope,
            expectedParentSnapshotId: null,
            expectedGeneration: 0,
            releaseKind: "legacy_baseline",
            verdict: "passed",
            documents: [s1Document],
            evaluationMatrix: { kind: "baseline" },
            baselineRef: "session-runtime-s1",
            repetitions: 1,
            actor: { type: "system", id: "session-runtime-test" },
            now: 50,
          },
          documentAuthority,
        )
        if (!s1) return yield* Effect.die("S1 baseline did not produce a released selection")

        const service = yield* SessionFederatedContext.Service
        const auth = yield* ContextQueryAuthorization.Service
        const selected = yield* service.resolve({
          session: session(),
          inputIds: [inputId],
          query: "find the session runner",
          agent,
          model,
          releasedKnowledgeSelection: s1,
          now: 100,
        })
        expect(selected.selection.revision).toBe(0)
        expect(selected.selection.selectedRefs).toHaveLength(1)
        expect(selected.selection.graphStatuses).toEqual(result("revision-1").statuses)
        expect(selected.selection.projection).toContain("project-context-json-v1")
        expect(selected.selection.releasedKnowledgeBinding).toMatchObject({
          state: "bound",
          snapshotId: s1.snapshotId,
          generation: s1.generation,
          membershipHash: s1.membershipHash,
          manifestHash: s1.manifestHash,
          exactRefs: [s1Document],
        })
        expect(releasedKnowledgeQueries).toEqual([s1.snapshotId])
        expect((yield* auth.resolve({ sessionId, agent: "build" }))?.principal.sessionIds).toEqual([sessionId])

        const s2Document = releasedDocument(2)
        const s2 = yield* DeepAgentReleasedSnapshot.publish(
          db,
          {
            snapshotId: "snapshot_session_runtime_s2",
            evaluationId: "evaluation_session_runtime_s2",
            scope: releasedScope,
            expectedParentSnapshotId: s1.snapshotId,
            expectedGeneration: s1.generation,
            releaseKind: "evaluated",
            verdict: "passed",
            documents: [s2Document],
            evaluationMatrix: { kind: "evaluated" },
            baselineRef: "session-runtime-s1",
            repetitions: 1,
            actor: { type: "system", id: "session-runtime-test" },
            now: 150,
          },
          documentAuthority,
        )
        if (!s2) return yield* Effect.die("S2 publish did not produce a released selection")
        expect((yield* DeepAgentReleasedSnapshot.current(db, releasedScope))?.snapshotId).toBe(s2.snapshotId)

        const activeReleasedKnowledge = yield* service.releasedKnowledgeForActiveSession(sessionId)
        expect(activeReleasedKnowledge).toMatchObject({
          pinned: true,
          selection: {
            snapshotId: s1.snapshotId,
            generation: s1.generation,
            membershipHash: s1.membershipHash,
            manifestHash: s1.manifestHash,
            documents: [s1Document],
          },
        })
        const pinnedS1 = activeReleasedKnowledge?.selection
        if (!pinnedS1) return yield* Effect.die("active session did not rebuild S1")

        const attempt = yield* admit(
          yield* service.prepareProviderTurn({
            selection: selected.selection,
            envelope: selected.envelope,
            observedLocationMutationEpoch: selected.observedLocationMutationEpoch,
            requestHash: "request-1",
            providerId: "provider-test",
            now: 200,
          }),
        )
        const exactSelection = yield* service.resolve({
          session: session(),
          inputIds: [inputId],
          query: "find the session runner",
          agent,
          model,
          releasedKnowledgeSelection: pinnedS1,
          now: 210,
        })
        const exactAttempt = yield* admit(
          yield* service.prepareProviderTurn({
            selection: exactSelection.selection,
            envelope: exactSelection.envelope,
            observedLocationMutationEpoch: exactSelection.observedLocationMutationEpoch,
            requestHash: "request-1",
            providerId: "provider-test",
            now: 220,
          }),
        )
        expect(exactSelection.selection.selectionId).toBe(selected.selection.selectionId)
        expect(exactAttempt.attemptId).toBe(attempt.attemptId)
        yield* attempts.sealPrepared({
          attemptId: exactAttempt.attemptId,
          expectedOwnerToken: ownerToken,
          preparedTurnHash: "a".repeat(64),
          wireRequestHash: "b".repeat(64),
          now: 221,
        })
        yield* attempts.markDispatching({ attemptId: exactAttempt.attemptId, expectedOwnerToken: ownerToken, now: 221 })
        yield* attempts.markStreaming({ attemptId: exactAttempt.attemptId, expectedOwnerToken: ownerToken, now: 222 })
        yield* attempts.settle({
          attemptId: exactAttempt.attemptId,
          expectedOwnerToken: ownerToken,
          outcome: "settled",
          now: 223,
        })
        expect((yield* db.select().from(SessionProviderAttemptTable).get())?.state).toBe("settled")

        mutation.value = 2
        const unchanged = yield* service.resolve({
          session: session(),
          inputIds: [],
          query: "",
          agent,
          model,
          current: selected.selection,
          releasedKnowledgeSelection: pinnedS1,
          now: 300,
        })
        expect(unchanged.selection.selectionId).toBe(selected.selection.selectionId)
        expect(unchanged.selection.projection).toBe(selected.selection.projection)
        expect(unchanged.observedLocationMutationEpoch).toBe(2)
        const second = yield* admit(
          yield* service.prepareProviderTurn({
            selection: unchanged.selection,
            envelope: unchanged.envelope,
            observedLocationMutationEpoch: unchanged.observedLocationMutationEpoch,
            requestHash: "request-2",
            providerId: "provider-test",
            now: 400,
          }),
        )
        expect(
          (yield* db
            .select()
            .from(SessionContextValidationTable)
            .orderBy(SessionContextValidationTable.validated_at)
            .all()).at(-1)?.observed_location_mutation_epoch,
        ).toBe(2)
        yield* attempts.sealPrepared({
          attemptId: second.attemptId,
          expectedOwnerToken: ownerToken,
          preparedTurnHash: "c".repeat(64),
          wireRequestHash: "d".repeat(64),
          now: 401,
        })
        yield* attempts.markDispatching({ attemptId: second.attemptId, expectedOwnerToken: ownerToken, now: 401 })
        yield* attempts.markStreaming({ attemptId: second.attemptId, expectedOwnerToken: ownerToken, now: 402 })
        yield* attempts.settle({
          attemptId: second.attemptId,
          expectedOwnerToken: ownerToken,
          outcome: "settled",
          now: 403,
        })

        const recoveredSelection = yield* service.resolve({
          session: session(),
          inputIds: [inputId],
          query: "find the session runner",
          agent,
          model,
          releasedKnowledgeSelection: pinnedS1,
          now: 450,
        })
        expect(recoveredSelection.selection.selectionId).toBe(selected.selection.selectionId)
        expect(recoveredSelection.selection.authorizationEpoch).toBe(selected.selection.authorizationEpoch)

        revision.value = "revision-2"
        mutation.value = 3
        const invalidated = yield* service.resolve({
          session: session(),
          inputIds: [],
          query: "",
          agent,
          model,
          current: unchanged.selection,
          releasedKnowledgeSelection: pinnedS1,
          now: 500,
        })
        expect(invalidated.selection.revision).toBe(1)
        expect(invalidated.selection.selectionId).not.toBe(selected.selection.selectionId)
        expect(invalidated.selection.selectedRefs[0]?.ref.revision).toBe("revision-2")

        const indeterminate = yield* admit(
          yield* service.prepareProviderTurn({
            selection: invalidated.selection,
            envelope: invalidated.envelope,
            observedLocationMutationEpoch: invalidated.observedLocationMutationEpoch,
            requestHash: "request-replay",
            providerId: "provider-test",
            now: 550,
          }),
        )
        yield* attempts.sealPrepared({
          attemptId: indeterminate.attemptId,
          expectedOwnerToken: ownerToken,
          preparedTurnHash: "e".repeat(64),
          wireRequestHash: "f".repeat(64),
          now: 551,
        })
        yield* attempts.markDispatching({
          attemptId: indeterminate.attemptId,
          expectedOwnerToken: ownerToken,
          now: 551,
        })
        yield* owners.release({ ownerToken, now: 552 })
        const recoveryOwnerToken = "session-context-runtime-recovery-owner"
        yield* owners.register({ ownerToken: recoveryOwnerToken, leaseMs: Number.MAX_SAFE_INTEGER - 1_000, now: 553 })
        expect(
          yield* attempts.recoverIndeterminate({
            sessionId,
            staleOwnerToken: ownerToken,
            recoveryOwnerToken,
            now: 554,
          }),
        ).toBe(1)
        const replayQueryCount = releasedKnowledgeQueries.length
        const replay = yield* service.replayIndeterminate({
          session: session(),
          attemptId: indeterminate.attemptId,
          actorId: "local-user",
          reason: "operator acknowledged duplicate risk",
          riskAcknowledged: true,
          recoveryOwnerToken,
          now: 560,
        })
        expect(replay).toMatchObject({
          attempt: { state: "resolved_replayed" },
          replay: { state: "prepared", parentAttemptId: indeterminate.attemptId },
        })
        expect(releasedKnowledgeQueries.slice(replayQueryCount)).toEqual([s1.snapshotId])
        const replayLifecycle = yield* attempts.prepare({
          ...(yield* service.prepareProviderTurn({
            selection: invalidated.selection,
            envelope: invalidated.envelope,
            observedLocationMutationEpoch: invalidated.observedLocationMutationEpoch,
            requestHash: "request-replay",
            providerId: "provider-test",
            now: 570,
          })),
          ownerToken: recoveryOwnerToken,
        })
        expect(replayLifecycle.attemptId).toBe(replay.replay.attemptId)
        yield* attempts.sealPrepared({
          attemptId: replayLifecycle.attemptId,
          expectedOwnerToken: recoveryOwnerToken,
          preparedTurnHash: "1".repeat(64),
          wireRequestHash: "2".repeat(64),
          now: 571,
        })
        yield* attempts.markDispatching({
          attemptId: replayLifecycle.attemptId,
          expectedOwnerToken: recoveryOwnerToken,
          now: 571,
        })
        yield* attempts.markStreaming({
          attemptId: replayLifecycle.attemptId,
          expectedOwnerToken: recoveryOwnerToken,
          now: 572,
        })
        yield* attempts.settle({
          attemptId: replayLifecycle.attemptId,
          expectedOwnerToken: recoveryOwnerToken,
          outcome: "settled",
          now: 573,
        })

        const revoked = yield* service.resolve({
          session: session(),
          inputIds: [],
          query: "",
          agent,
          model: {
            ...model,
            options: { ...model.options, contextEgressSensitivities: ["public"] },
          },
          current: invalidated.selection,
          releasedKnowledgeSelection: pinnedS1,
          now: 600,
        })
        expect(revoked.selection.revision).toBe(2)
        expect(revoked.selection.authorizationEpoch).toBeGreaterThan(invalidated.selection.authorizationEpoch)
        expect(revoked.selection.selectedRefs).toEqual([])
        expect(revoked.selection.graphStatuses.find((status) => status.graph === "code")).toMatchObject({
          kind: "blocked",
          state: "denied",
          reasonCode: "provider_egress_denied",
        })
        yield* service.settleActivity(revoked.selection, "settled")
        expect(yield* auth.resolve({ sessionId, agent: "build" })).toBeUndefined()

        const next = yield* service.resolve({
          session: session(),
          inputIds: [nextInputId],
          query: "start the next released-knowledge activity",
          agent,
          model,
          releasedKnowledgeSelection: s2,
          now: 800,
        })
        expect(next.selection.activityId).not.toBe(selected.selection.activityId)
        expect(next.selection.releasedKnowledgeBinding).toMatchObject({
          state: "bound",
          snapshotId: s2.snapshotId,
          generation: s2.generation,
          membershipHash: s2.membershipHash,
          manifestHash: s2.manifestHash,
          exactRefs: [s2Document],
        })
        expect(releasedKnowledgeQueries.at(-1)).toBe(s2.snapshotId)
        yield* service.settleActivity(next.selection, "settled")
      }).pipe(Effect.provide(testLayer), Effect.scoped),
    )
  })
})

function releasedDocument(version: number): DeepAgentReleasedSnapshot.DocumentRef {
  return {
    sourceStore: "project",
    id: "doc:knowledge:code:session-runtime-release",
    version,
    hash: `sha256:${Hash.sha256(`session-runtime-release-v${version}`)}`,
    type: "knowledge",
    scope: `durable:project:${projectId}`,
  }
}

function releasedDocumentAuthority(documents: readonly DeepAgentReleasedSnapshot.DocumentRef[]) {
  return {
    userGlobal: { get: () => null },
    project: {
      get: (id: string, version?: number) => {
        const ref = documents.find((document) => document.id === id && document.version === version)
        return ref
          ? {
              ...ref,
              status: "active" as const,
              superseded_by: null,
              created_round: null,
              domain: null,
              tags: [],
              description: ref.id,
              provenance: { source: "human" as const },
              links: [],
              confidence: { evidence_strength: "strong" as const, support_count: 1 },
              body: ref.id,
            }
          : null
      },
    },
  }
}

function result(revision: string): FederatedContextQuery.Result {
  return {
    statuses: [
      ContextFederation.status.matched("code", [{ source: "code", revision, state: "ready" }]),
      ContextFederation.status.empty("documents", [{ source: "documents", revision: "documents-1", state: "ready" }]),
      ContextFederation.status.empty("knowledge", [{ source: "knowledge", revision: "knowledge-1", state: "ready" }]),
      ContextFederation.status.empty("memory", [{ source: "memory", revision: "memory-1", state: "ready" }]),
    ],
    hits: [
      {
        ref: {
          graph: "code",
          entityId: "session-runner",
          binding: {
            scope: "location",
            securityNamespaceId: namespace,
            locationKey: location,
            projectScopeKey: projectScope,
          },
          locator: { path: "src/session.ts", symbolPath: "SessionRunner" },
          revision,
        },
        title: "SessionRunner",
        graph: "code",
        excerpt: "export class SessionRunner",
        provenance: [],
        validity: { state: "current" },
        score: 0.9,
        sensitivity: "source_code",
      },
    ],
    truncated: false,
    snapshotFingerprint: revision,
  }
}

function session(): Session.Info {
  return {
    id: sessionId,
    slug: "runtime",
    projectID: projectId,
    directory: "/workspace",
    title: "Runtime",
    version: "test",
    time: { created: 0, updated: 0 },
  } as Session.Info
}

const model = {
  id: "model-test",
  providerID: "provider-test",
  api: { id: "model-test", url: "https://example.invalid", npm: "@ai-sdk/openai-compatible" },
  name: "Model Test",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
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
