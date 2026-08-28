import { describe, expect, test } from "bun:test"
import type { CodeGraph } from "@deepagent-code/core/code-intelligence/code-graph"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import {
  IndexSpaceID,
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
} from "@deepagent-code/core/context-federation/reference"
import { Database } from "@deepagent-code/core/database/database"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Effect, Layer } from "effect"
import { ContextFederationReadiness } from "../../src/context-federation/readiness"
import { LocationIndexCoordinator } from "../../src/location-index/coordinator"
import { LocationIndexRuntime } from "../../src/location-index/runtime"

describe("ContextFederationReadiness", () => {
  test("derives a stable scoped revision from identity, index, journal, and storage authorities", async () => {
    const authority = {
      status: readyStatus(1),
      journalHighWater: 7,
      journalAvailable: true,
    }
    const run = makeHarness(authority)
    const first = await run()
    const exactRetry = await run()

    expect(first).toMatchObject({
      state: "ready",
      identityBound: true,
      indexAvailable: true,
      storageHealthy: true,
      projectScopeKey: identity.projectScopeKey,
      locationKey: identity.locationKey,
      indexGeneration: 1,
      journalHighWater: 7,
      reasons: [],
    })
    expect(first.indexRevision).toEqual(readyStatus(1).revision)
    expect(first.expiresAt - first.observedAt).toBe(15_000)
    expect(exactRetry.revision).toBe(first.revision)

    authority.status = readyStatus(2)
    authority.journalHighWater = 8
    const changed = await run()
    expect(changed.revision).not.toBe(first.revision)
    expect(changed).toMatchObject({ indexGeneration: 2, journalHighWater: 8 })
  })

  test("distinguishes building and degraded journal evidence without activating a second authority", async () => {
    const authority = {
      status: buildingStatus(),
      journalHighWater: 3,
      journalAvailable: true,
    }
    const run = makeHarness(authority)

    expect(await run()).toMatchObject({
      state: "building",
      indexAvailable: false,
      reasons: ["index_building"],
      journalHighWater: 3,
    })

    authority.status = readyStatus(1)
    authority.journalAvailable = false
    expect(await run()).toMatchObject({
      state: "degraded",
      indexAvailable: true,
      reasons: ["journal_unavailable"],
    })
  })
})

function makeHarness(authority: {
  status: CodeGraph.IndexStatus
  journalHighWater: number
  journalAvailable: boolean
}) {
  const coordinator = LocationIndexCoordinator.Service.of({
    initialize: () => Effect.void,
    observe: () => Effect.void,
    observeRename: () => Effect.void,
    requestReconciliation: () => Effect.void,
    drain: () => Effect.void,
    codeStatus: () => Effect.succeed(authority.status),
    searchCode: () => Effect.succeed({ revision: undefined, hits: [] }),
    codeNeighbors: () => Effect.succeed({ revision: undefined, hits: [] }),
    searchDocuments: () => Effect.succeed({ revision: undefined, hits: [] }),
    lookupDocuments: () => Effect.succeed({ revision: undefined, hits: [] }),
    mutationEpoch: () =>
      authority.journalAvailable
        ? Effect.succeed(authority.journalHighWater)
        : Effect.fail(new LocationIndexCoordinator.IndexError({ projectionKind: "code", reason: "not_initialized" })),
    pause: () => Effect.void,
    retire: () => Effect.void,
  })
  const app = ContextFederationReadiness.layer.pipe(
    Layer.provide(
      Layer.merge(
        Database.layerFromPath(":memory:"),
        Layer.succeed(
          LocationIndexRuntime.Service,
          LocationIndexRuntime.Service.of({
            init: () => Effect.void,
            current: () => Effect.succeed({ identity, coordinator }),
          }),
        ),
      ),
    ),
  )
  return () =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ContextFederationReadiness.Service).snapshot()
      }).pipe(Effect.provide(app), Effect.scoped),
    )
}

function readyStatus(generation: number): CodeGraph.IndexStatus {
  return {
    state: "ready",
    revision: {
      projectionKind: "code",
      indexIncarnation: 1,
      generation,
      manifestHash: `manifest-${generation}`,
      schemaVersion: 1,
      adapterSetVersion: "test",
    },
    generation,
    indexedAt: 100 + generation,
    dirtyPathCount: 0,
    semanticCoverage: {},
  }
}

function buildingStatus(): CodeGraph.IndexStatus {
  return {
    state: "indexing",
    generation: 0,
    dirtyPathCount: 0,
    semanticCoverage: {},
  }
}

const identity: Identity = {
  securityNamespaceId: SecurityNamespaceID.make("sec_context_readiness"),
  locationKey: LocationKey.make("loc_context_readiness"),
  projectScopeKey: ProjectScopeKey.make("prjctx_context_readiness"),
  indexSpaceId: IndexSpaceID.make("idx_context_readiness"),
  canonicalRoot: AbsolutePath.make("/workspace/context-readiness"),
}
