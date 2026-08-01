import { describe, expect, test } from "bun:test"
import { ContextArtifactStore } from "@deepagent-code/core/context-federation/artifact-store"
import { ContextFederation } from "@deepagent-code/core/context-federation/federation"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import { FederatedContextQuery } from "@deepagent-code/core/context-federation/query"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { SessionProviderAttempt } from "@deepagent-code/core/context-federation/provider-attempt"
import { SessionContextValidationTable, SessionProviderAttemptTable } from "@deepagent-code/core/context-federation/session-sql"
import {
  IndexSpaceID,
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
} from "@deepagent-code/core/context-federation/reference"
import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import { Database } from "@deepagent-code/core/database/database"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ProjectV2 } from "@deepagent-code/core/project"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
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
const projectId = ProjectV2.ID.make("global")
const identity: Identity = {
  securityNamespaceId: namespace,
  locationKey: location,
  projectScopeKey: projectScope,
  indexSpaceId: IndexSpaceID.make("idx_session_runtime"),
  canonicalRoot: AbsolutePath.make("/workspace"),
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
    const authorization = LiveContextQueryAuthorization.layer()
    const mutation = { value: 1 }
    const revision = { value: "revision-1" }
    const runtime = Layer.succeed(LocationIndexRuntime.Service, LocationIndexRuntime.Service.of({
      init: () => Effect.void,
      current: () => Effect.succeed({
        identity,
        coordinator: {
          mutationEpoch: () => Effect.succeed(mutation.value),
        } as never,
      }),
    }))
    const query = Layer.succeed(FederatedContextQuery.Service, FederatedContextQuery.Service.of({
      query: () => Effect.succeed(result(revision.value)),
    }))
    const app = SessionFederatedContext.layer.pipe(
      Layer.provide(Layer.mergeAll(
        database,
        artifacts,
        contexts,
        attempts,
        authorization,
        runtime,
        query,
        Layer.succeed(ContextTokenCodec.Service, ContextTokenCodec.Service.of(codec)),
      )),
    )
    const testLayer = Layer.mergeAll(database, authorization, app)

    await Effect.runPromise(Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.insert(ProjectTable).values({
        id: projectId,
        worktree: AbsolutePath.make("/workspace"),
        sandboxes: [],
      }).run()
      yield* db.insert(SessionTable).values({
        id: sessionId,
        project_id: projectId,
        slug: "runtime",
        directory: "/workspace",
        title: "Runtime",
        version: "test",
      }).run()
      yield* db.insert(SessionInputTable).values({
        id: inputId,
        session_id: sessionId,
        prompt: new Prompt({ text: "find the session runner" }),
        delivery: "steer",
        admitted_seq: 0,
        promoted_seq: 0,
      }).run()

      const service = yield* SessionFederatedContext.Service
      const auth = yield* ContextQueryAuthorization.Service
      const selected = yield* service.resolve({
        session: session(),
        inputIds: [inputId],
        query: "find the session runner",
        agent,
        model,
        now: 100,
      })
      expect(selected.selection.revision).toBe(0)
      expect(selected.selection.selectedRefs).toHaveLength(1)
      expect(selected.selection.graphStatuses).toEqual(result("revision-1").statuses)
      expect(selected.selection.projection).toContain("project-context-json-v1")
      expect((yield* auth.resolve({ sessionId, agent: "build" }))?.principal.sessionIds).toEqual([sessionId])

      const transitions: string[] = []
      const attempt = yield* service.prepareProviderTurn({
        selection: selected.selection,
        envelope: selected.envelope,
        observedLocationMutationEpoch: selected.observedLocationMutationEpoch,
        requestHash: "request-1",
        providerId: "provider-test",
        now: 200,
      })
      const exactSelection = yield* service.resolve({
        session: session(),
        inputIds: [inputId],
        query: "find the session runner",
        agent,
        model,
        now: 210,
      })
      const exactAttempt = yield* service.prepareProviderTurn({
        selection: exactSelection.selection,
        envelope: exactSelection.envelope,
        observedLocationMutationEpoch: exactSelection.observedLocationMutationEpoch,
        requestHash: "request-1",
        providerId: "provider-test",
        now: 220,
      })
      expect(exactSelection.selection.selectionId).toBe(selected.selection.selectionId)
      expect(exactAttempt.attemptId).toBe(attempt.attemptId)
      yield* exactAttempt.dispatching.pipe(Effect.tap(() => Effect.sync(() => transitions.push("dispatching"))))
      yield* exactAttempt.streaming.pipe(Effect.tap(() => Effect.sync(() => transitions.push("streaming"))))
      yield* exactAttempt.settled.pipe(Effect.tap(() => Effect.sync(() => transitions.push("settled"))))
      expect(transitions).toEqual(["dispatching", "streaming", "settled"])
      expect((yield* db.select().from(SessionProviderAttemptTable).get())?.state).toBe("settled")

      mutation.value = 2
      const unchanged = yield* service.resolve({
        session: session(),
        inputIds: [],
        query: "",
        agent,
        model,
        current: selected.selection,
        now: 300,
      })
      expect(unchanged.selection.selectionId).toBe(selected.selection.selectionId)
      expect(unchanged.selection.projection).toBe(selected.selection.projection)
      expect(unchanged.observedLocationMutationEpoch).toBe(2)
      const second = yield* service.prepareProviderTurn({
        selection: unchanged.selection,
        envelope: unchanged.envelope,
        observedLocationMutationEpoch: unchanged.observedLocationMutationEpoch,
        requestHash: "request-2",
        providerId: "provider-test",
        now: 400,
      })
      expect((yield* db.select().from(SessionContextValidationTable).orderBy(SessionContextValidationTable.validated_at).all()).at(-1)?.observed_location_mutation_epoch).toBe(2)
      yield* second.dispatching
      yield* second.streaming
      yield* second.settled

      const recoveredSelection = yield* service.resolve({
        session: session(),
        inputIds: [inputId],
        query: "find the session runner",
        agent,
        model,
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
        now: 500,
      })
      expect(invalidated.selection.revision).toBe(1)
      expect(invalidated.selection.selectionId).not.toBe(selected.selection.selectionId)
      expect(invalidated.selection.selectedRefs[0]?.ref.revision).toBe("revision-2")

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
      const indeterminate = yield* service.prepareProviderTurn({
        selection: revoked.selection,
        envelope: revoked.envelope,
        observedLocationMutationEpoch: revoked.observedLocationMutationEpoch,
        requestHash: "request-replay",
        providerId: "provider-test",
        now: 700,
      })
      yield* indeterminate.dispatching
      expect(yield* service.recover(sessionId)).toBe(1)
      const replay = yield* service.replayIndeterminate({
        session: session(),
        attemptId: indeterminate.attemptId,
        actorId: "local-user",
        reason: "operator acknowledged duplicate risk",
        riskAcknowledged: true,
        now: 710,
      })
      expect(replay).toMatchObject({
        attempt: { state: "resolved_replayed" },
        replay: { state: "prepared", parentAttemptId: indeterminate.attemptId },
      })
      const replayLifecycle = yield* service.prepareProviderTurn({
        selection: revoked.selection,
        envelope: revoked.envelope,
        observedLocationMutationEpoch: revoked.observedLocationMutationEpoch,
        requestHash: "request-replay",
        providerId: "provider-test",
        now: 720,
      })
      expect(replayLifecycle.attemptId).toBe(replay.replay.attemptId)
      yield* replayLifecycle.dispatching
      yield* replayLifecycle.streaming
      yield* replayLifecycle.settled
      yield* service.settleActivity(revoked.selection, "settled")
      expect(yield* auth.resolve({ sessionId, agent: "build" })).toBeUndefined()
    }).pipe(Effect.provide(testLayer), Effect.scoped))
  })
})

function result(revision: string): FederatedContextQuery.Result {
  return {
    statuses: [
      ContextFederation.status.matched("code", [{ source: "code", revision, state: "ready" }]),
      ContextFederation.status.empty("documents", [{ source: "documents", revision: "documents-1", state: "ready" }]),
      ContextFederation.status.empty("knowledge", [{ source: "knowledge", revision: "knowledge-1", state: "ready" }]),
      ContextFederation.status.empty("memory", [{ source: "memory", revision: "memory-1", state: "ready" }]),
    ],
    hits: [{
      ref: {
        graph: "code",
        entityId: "session-runner",
        binding: { scope: "location", securityNamespaceId: namespace, locationKey: location, projectScopeKey: projectScope },
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
    }],
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
  permission: [
    { permission: "context_query", pattern: "*", action: "allow" },
  ],
} as Agent.Info
