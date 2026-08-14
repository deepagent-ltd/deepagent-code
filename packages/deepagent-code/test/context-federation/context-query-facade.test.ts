import { describe, expect, test } from "bun:test"
import { ContextArtifactStore } from "@deepagent-code/core/context-federation/artifact-store"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import { FederatedContextQuery } from "@deepagent-code/core/context-federation/query"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import {
  IndexSpaceID,
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
} from "@deepagent-code/core/context-federation/reference"
import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import { Database } from "@deepagent-code/core/database/database"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Effect, Exit, Layer } from "effect"
import { randomBytes } from "node:crypto"
import { ContextQueryFacade } from "../../src/context-federation/context-query-facade"
import { LocationIndexRuntime } from "../../src/location-index/runtime"

const namespace = SecurityNamespaceID.make("sec_context_facade")
const location = LocationKey.make("loc_context_facade")
const project = ProjectScopeKey.make("prjctx_context_facade")

describe("ContextQueryFacade", () => {
  test("authenticates refs, writes artifacts, and binds pagination to the federated snapshot", async () => {
    const codec = ContextTokenCodec.make({ activeKeyId: "test", keys: [{ id: "test", secret: randomBytes(32) }] })
    const snapshot = { value: "snapshot-1" }
    const app = ContextQueryFacade.layer.pipe(
      Layer.provide(Layer.succeed(FederatedContextQuery.Service, FederatedContextQuery.Service.of({
        query: () => Effect.succeed(result(snapshot.value)),
      }))),
      Layer.provide(Layer.succeed(ContextQueryAuthorization.Service, ContextQueryAuthorization.Service.of({
        resolve: () => Effect.succeed(envelope),
      }))),
      Layer.provide(Layer.succeed(ContextTokenCodec.Service, ContextTokenCodec.Service.of(codec))),
      Layer.provide(Layer.succeed(LocationIndexRuntime.Service, LocationIndexRuntime.Service.of({
        init: () => Effect.void,
        current: () => Effect.succeed({ identity, coordinator: {} as never }),
      }))),
      Layer.provide(Layer.succeed(ContextArtifactStore.Service, artifactStore(codec))),
      Layer.provide(Database.layerFromPath(":memory:")),
    )
    const run = (request: Parameters<ContextQueryFacade.Interface["execute"]>[0]["request"]) => Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ContextQueryFacade.Service).execute({ request, sessionId: "session", agent: "general", now: 100 })
      }).pipe(Effect.provide(app), Effect.scoped),
    )
    const ref = codec.sealContextRef(contextRef(0), { issuedAt: 0, expiresAt: 1_000 })
    const first = await run({ intent: "related", ref, limit: 1 })
    expect(first.hits).toHaveLength(1)
    expect(first.nextCursor).toBeDefined()
    expect(first.artifactRef).toBeDefined()
    expect((await Effect.runPromise(codec.openContextRef(first.hits[0]!.ref, 101))).entityId).toBe("entity-1")

    const second = await run({ intent: "related", ref, limit: 1, cursor: first.nextCursor })
    expect((await Effect.runPromise(codec.openContextRef(second.hits[0]!.ref, 101))).entityId).toBe("entity-2")

    const bounded = await run({ intent: "related", ref, limit: 100 })
    expect(JSON.stringify(bounded).length).toBeLessThan(12_000)
    expect(bounded.truncated).toBe(true)
    expect(bounded.nextCursor).toBeDefined()

    snapshot.value = "snapshot-2"
    const stale = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ContextQueryFacade.Service).execute({
          request: { intent: "related", ref, limit: 1, cursor: first.nextCursor },
          sessionId: "session",
          agent: "general",
          now: 100,
        })
      }).pipe(Effect.provide(app), Effect.scoped, Effect.exit),
    )
    expect(Exit.isFailure(stale)).toBe(true)

    const tampered = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ContextQueryFacade.Service).execute({
          request: { intent: "related", ref: `${ref.slice(0, -1)}x` },
          sessionId: "session",
          agent: "general",
          now: 100,
        })
      }).pipe(Effect.provide(app), Effect.scoped, Effect.exit),
    )
    expect(Exit.isFailure(tampered)).toBe(true)
  })
})

function result(snapshotFingerprint: string): FederatedContextQuery.Result {
  return {
    statuses: [{
      graph: "documents",
      kind: "complete",
      state: "ready",
      outcome: "matched",
      revisions: [{ source: "repo_documents", revision: snapshotFingerprint, state: "ready" }],
    }],
    hits: Array.from({ length: 30 }, (_, offset) => offset + 1).map((index) => ({
      ref: contextRef(index),
      title: `Document ${index}`,
      graph: "documents" as const,
      excerpt: `Excerpt ${index} ${"evidence ".repeat(60)}`,
      provenance: [],
      validity: { state: "current" as const },
      score: 1 / index,
      sensitivity: "source_code" as const,
    })),
    truncated: false,
    snapshotFingerprint,
  }
}

function artifactStore(codec: ContextTokenCodec.Codec): ContextArtifactStore.Interface {
  return {
    policy: "best_effort",
    write: (input) => Effect.succeed({
      artifactId: "artifact",
      ref: codec.sealArtifact({
        securityNamespaceId: input.securityNamespaceId,
        sessionId: input.sessionId,
        selectionId: input.selectionId,
        artifactId: "artifact",
      }, { issuedAt: input.now ?? 100, expiresAt: (input.now ?? 100) + 1_000 }),
      contentHash: "hash",
      expiresAt: (input.now ?? 100) + 1_000,
    }),
    read: () => Effect.die("unused"),
    sweep: () => Effect.succeed(0),
    sweepOrphans: () => Effect.succeed(0),
  }
}

function contextRef(index: number) {
  return {
    graph: "documents" as const,
    entityId: `entity-${index}`,
    binding: { scope: "location" as const, securityNamespaceId: namespace, locationKey: location, projectScopeKey: project },
    locator: { path: "docs/design.md", heading: `Document ${index}` },
    revision: "revision",
  }
}

const identity: Identity = {
  securityNamespaceId: namespace,
  locationKey: location,
  projectScopeKey: project,
  indexSpaceId: IndexSpaceID.make("idx_context_facade"),
  canonicalRoot: AbsolutePath.make("/workspace"),
}

const envelope: ContextQueryAuthorization.Envelope = {
  principal: {
    securityNamespaceId: namespace,
    principalId: "principal",
    authorizationEpoch: 1,
    locationKeys: [location],
    projectScopeKeys: [project],
    sessionIds: ["session"],
    subjectIds: [],
    allowBuiltin: false,
  },
  egress: {
    policyId: "provider",
    epoch: 1,
    graphs: ["documents"],
    sensitivities: ["source_code"],
  },
}
