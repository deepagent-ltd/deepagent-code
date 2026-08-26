import { describe, expect, test } from "bun:test"
import { CodeQuery } from "@deepagent-code/core/code-intelligence/query"
import { ContextArtifactStore } from "@deepagent-code/core/context-federation/artifact-store"
import { ContextFederation } from "@deepagent-code/core/context-federation/federation"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import {
  IndexSpaceID,
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
  type ProjectionSnapshotRevision,
} from "@deepagent-code/core/context-federation/reference"
import { ContextTokenCodec } from "@deepagent-code/core/context-federation/token-codec"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Effect, Exit, Layer } from "effect"
import { randomBytes } from "node:crypto"
import { Service, layer, type Interface } from "../../src/code-intelligence/facade"
import { LocationIndexRuntime } from "../../src/location-index/runtime"

const namespace = SecurityNamespaceID.make("sec_facade")
const location = LocationKey.make("loc_facade")
const project = ProjectScopeKey.make("prjctx_facade")
const identity: Identity = {
  securityNamespaceId: namespace,
  locationKey: location,
  projectScopeKey: project,
  indexSpaceId: IndexSpaceID.make("idx_facade"),
  canonicalRoot: AbsolutePath.make("/workspace"),
}

describe("CodeIntelFacade", () => {
  test("seals refs, pages with an authenticated cursor, and rejects a changed snapshot", async () => {
    const revision = { current: snapshot(1, 1) }
    const codec = ContextTokenCodec.make({ activeKeyId: "test", keys: [{ id: "test", secret: randomBytes(32) }] })
    const app = layer.pipe(
      Layer.provide(Layer.succeed(CodeQuery.Service, CodeQuery.Service.of({ query: () => Effect.succeed(result(revision.current)) }))),
      Layer.provide(Layer.succeed(ContextQueryAuthorization.Service, ContextQueryAuthorization.Service.of({
        resolve: () => Effect.succeed(envelope()),
      }))),
      Layer.provide(Layer.succeed(ContextTokenCodec.Service, ContextTokenCodec.Service.of(codec))),
      Layer.provide(Layer.succeed(ContextArtifactStore.Service, ContextArtifactStore.Service.of({
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
      }))),
      Layer.provide(Layer.succeed(LocationIndexRuntime.Service, LocationIndexRuntime.Service.of({
        init: () => Effect.void,
        current: () => Effect.succeed({ identity, coordinator: {} as never }),
      }))),
    )
    const run = (request: Parameters<Interface["execute"]>[0]["request"]) => Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Service).execute({ request, sessionId: "session", agent: "general", now: 100 })
      }).pipe(Effect.provide(app), Effect.scoped),
    )
    const first = await run({ intent: "search", query: "symbol", limit: 1 })
    expect(first.hits).toHaveLength(1)
    expect(first.hits[0]!.ref).not.toContain("src/secret-name.ts")
    expect((await Effect.runPromise(codec.openContextRef(first.hits[0]!.ref, 101))).locator?.path).toBe("src/secret-name.ts")
    expect(first.nextCursor).toBeDefined()
    expect(first.artifactRef).toBeDefined()

    const second = await run({ intent: "search", query: "symbol", limit: 1, cursor: first.nextCursor })
    expect(second.hits[0]?.symbol).toBe("symbol2")

    const bounded = await run({ intent: "search", query: "symbol", limit: 100 })
    expect(JSON.stringify(bounded).length).toBeLessThan(12_000)
    expect(bounded.truncated).toBe(true)
    expect(bounded.nextCursor).toBeDefined()

    revision.current = snapshot(2, 1)
    const stale = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Service).execute({
          request: { intent: "search", query: "symbol", limit: 1, cursor: first.nextCursor },
          sessionId: "session",
          agent: "general",
          now: 100,
        })
      }).pipe(Effect.provide(app), Effect.scoped, Effect.exit),
    )
    expect(Exit.isFailure(stale)).toBe(true)
  })
})

function result(revision: ProjectionSnapshotRevision): CodeQuery.Result {
  const hits = Array.from({ length: 30 }, (_, offset) => offset + 1).map((index) => ({
    ref: {
      graph: "code" as const,
      entityId: `entity-${index}`,
      binding: { scope: "location" as const, securityNamespaceId: namespace, locationKey: location, projectScopeKey: project },
      locator: { path: "src/secret-name.ts", symbolPath: `symbol${index}`, startLine: index, endLine: index },
      revision: JSON.stringify(revision),
    },
    file: "src/secret-name.ts",
    startLine: index,
    endLine: index,
    symbol: `symbol${index}`,
    kind: "function",
    snippet: `${index}: ${"source ".repeat(80)}`,
    sources: ["graph" as const, "filesystem" as const],
    score: 1 / index,
    editorOverlay: "not_applicable" as const,
  }))
  return {
    index: {
      state: "ready",
      revision,
      generation: revision.generation,
      dirtyPathCount: 0,
      semanticCoverage: { typescript: "semantic" },
      stale: false,
    },
    status: ContextFederation.status.matched("code", [{ source: "code_graph", revision: JSON.stringify(revision), state: "ready" }]),
    consistency: "stale_ok",
    freshnessSatisfied: true,
    enrichment: { lsp: "unavailable", editorOverlay: "not_applicable", reasonCode: "lsp_unavailable" },
    hits,
    truncated: true,
  }
}

function snapshot(generation: number, incarnation: number): ProjectionSnapshotRevision {
  return {
    projectionKind: "code",
    indexIncarnation: incarnation,
    generation,
    manifestHash: `manifest-${generation}`,
    schemaVersion: 1,
    adapterSetVersion: "ts-js-v1",
  }
}

function envelope(): ContextQueryAuthorization.Envelope {
  return {
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
      graphs: ["code"],
      sensitivities: ["source_code"],
    },
  }
}
