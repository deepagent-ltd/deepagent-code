import { describe, expect, test } from "bun:test"
import { CodeQuery } from "@deepagent-code/core/code-intelligence/query"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import { ContextLinkStore } from "@deepagent-code/core/context-federation/link-store"
import { FederatedContextQuery } from "@deepagent-code/core/context-federation/query"
import {
  IndexSpaceID,
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
} from "@deepagent-code/core/context-federation/reference"
import type { ContextRef, ProjectionSnapshotRevision } from "@deepagent-code/core/context-federation/reference"
import { Database } from "@deepagent-code/core/database/database"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { DocumentStore, documentRevision } from "@deepagent-code/core/deepagent/document-store"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"
import { Effect, Layer } from "effect"
import { LegacyContextStores, layer } from "../../src/context-federation/federated-query-service"
import { LocationIndexCoordinator } from "../../src/location-index/coordinator"
import { LocationIndexRuntime } from "../../src/location-index/runtime"
import { tmpdir } from "../fixture/fixture"

const namespace = SecurityNamespaceID.make("sec_federated_query")
const location = LocationKey.make("loc_federated_query")
const project = ProjectScopeKey.make("prjctx_federated_query")
const revision: ProjectionSnapshotRevision = {
  projectionKind: "repo_documents",
  indexIncarnation: 1,
  generation: 1,
  manifestHash: "manifest",
  schemaVersion: 1,
  adapterSetVersion: "test",
}

describe("LiveFederatedContextQuery", () => {
  test("traces an authorized ref across graphs and preserves a typed source failure", async () => {
    const doc = documentRef(location)
    const code = codeRef()
    const service = await makeService(doc, code)
    const result = await service.query({
      intent: "trace_evidence",
      ref: doc,
      relation: "supports",
      sources: ["documents", "code"],
      limit: 10,
      consistency: "stale_ok",
      principal: principal(location),
      egress,
      sessionId: "session",
    })

    expect(result.hits.some((hit) => hit.ref.entityId === code.entityId)).toBe(true)
    expect(result.hits.find((hit) => hit.ref.entityId === code.entityId)?.relationPath).toEqual([
      { relation: "supports", ref: code, freshness: "exact" },
    ])
    expect(result.hits.find((hit) => hit.ref.entityId === code.entityId)?.excerpt).toContain(
      "call_graph: callers=2, callees=1",
    )
    expect(result.statuses.find((status) => status.graph === "code")).toMatchObject({ kind: "complete" })
    expect(result.statuses.find((status) => status.graph === "documents")).toMatchObject({
      kind: "partial",
      reasonCode: "partial_sources",
    })
  })

  test("rejects a ref from another Location before querying adapters", async () => {
    const service = await makeService(documentRef(location), codeRef())
    await expect(service.query({
      intent: "related",
      ref: documentRef(LocationKey.make("loc_other")),
      limit: 10,
      consistency: "stale_ok",
      principal: principal(LocationKey.make("loc_other")),
      egress,
      sessionId: "session",
    })).rejects.toMatchObject({ _tag: "FederatedContextQuery.InvalidQueryError", reason: "ref" })
  })

  test("uses only the provider-turn released selection and blocks active-document fallback", async () => {
    await using tmp = await tmpdir()
    const store = new DocumentStore(tmp.path)
    const released = store.create({
      type: "knowledge",
      scope: `durable:project:${projectIdForWorkspace(identity.canonicalRoot)}`,
      description: "Released provider retry guidance",
      body: "Retry only before provider dispatch.",
      idSlug: "released-retry",
      provenance: { source: "human" },
      confidence: { evidence_strength: "strong", support_count: 1 },
      extensions: { sensitivity: "public" },
    })
    store.setStatus(released.id, "active", documentRevision(released))
    const unreleased = store.create({
      type: "knowledge",
      scope: `durable:project:${projectIdForWorkspace(identity.canonicalRoot)}`,
      description: "Unreleased provider retry guidance",
      body: "This must stay invisible.",
      idSlug: "unreleased-retry",
      provenance: { source: "human" },
      confidence: { evidence_strength: "strong", support_count: 1 },
      extensions: { sensitivity: "public" },
    })
    store.setStatus(unreleased.id, "active", documentRevision(unreleased))
    const documents = [DeepAgentReleasedSnapshot.documentRef(store.get(released.id)!, "project")]
    const selection = {
      snapshotId: "snapshot-federated-query",
      securityNamespaceId: namespace,
      projectScopeKey: project,
      legacyProjectId: projectIdForWorkspace(identity.canonicalRoot),
      parentSnapshotId: null,
      generation: 1,
      membershipHash: Hash.sha256(CanonicalJson.stringify(documents)),
      manifestHash: Hash.sha256("manifest-federated-query"),
      documents,
    }
    const service = await makeService(documentRef(location), codeRef(), [store, store])
    const result = await service.query({
      intent: "search",
      query: "provider retry guidance",
      sources: ["knowledge"],
      limit: 10,
      consistency: "stale_ok",
      principal: principal(location),
      egress: knowledgeEgress,
      sessionId: "session",
      releasedKnowledgeSelection: selection,
    })
    expect(result.hits.map((hit) => hit.ref.entityId)).toEqual([released.id])

    const blocked = await service.query({
      intent: "search",
      query: "provider retry guidance",
      sources: ["knowledge"],
      limit: 10,
      consistency: "stale_ok",
      principal: principal(location),
      egress: knowledgeEgress,
      sessionId: "session",
    })
    expect(blocked.hits).toEqual([])
    expect(blocked.statuses).toContainEqual(expect.objectContaining({
      graph: "knowledge",
      kind: "blocked",
      reasonCode: "released_snapshot_unavailable",
    }))
  })
})

async function makeService(doc: ContextRef, codeRefValue: ContextRef, stores: readonly DocumentStore[] = []) {
  const coordinator = coordinatorFor(doc)
  const app = layer({ perGraphTimeoutMs: 100, freshTimeoutMs: 100 }).pipe(
    Layer.provide(Database.layerFromPath(":memory:")),
    Layer.provide(Layer.succeed(LegacyContextStores, LegacyContextStores.of({ forWorkspace: () => stores }))),
    Layer.provide(Layer.succeed(LocationIndexRuntime.Service, LocationIndexRuntime.Service.of({
      init: () => Effect.void,
      current: () => Effect.succeed({ identity, coordinator }),
    }))),
    Layer.provide(Layer.succeed(CodeQuery.Service, CodeQuery.Service.of({
      query: () => Effect.succeed({
        index: {
          state: "ready",
          revision: { ...revision, projectionKind: "code" },
          generation: 1,
          dirtyPathCount: 0,
          semanticCoverage: { "source.ts": "semantic" },
          stale: false,
        },
        status: {
          graph: "code",
          kind: "complete",
          state: "ready",
          outcome: "matched",
          revisions: [{ source: "code_graph", revision: codeRefValue.revision, state: "ready" }],
        },
        consistency: "stale_ok",
        freshnessSatisfied: true,
        enrichment: { lsp: "not_applicable", editorOverlay: "not_applicable" },
        hits: [{
          ref: codeRefValue,
          file: "source.ts",
          symbol: "target",
          snippet: "export function target() {}",
          sources: ["graph", "filesystem"],
          score: 1,
          degree: { inDegree: 3, outDegree: 1, callsIn: 2, callsOut: 1 },
          editorOverlay: "not_applicable",
        }],
        truncated: false,
      }),
    }))),
    Layer.provide(Layer.succeed(ContextLinkStore.Service, ContextLinkStore.Service.of({
      neighbors: (input: Parameters<ContextLinkStore.Interface["neighbors"]>[0]) => Effect.succeed({
        links: input.ref.entityId === doc.entityId ? [{
          linkId: "link",
          from: doc,
          to: codeRefValue,
          relation: "supports",
          evidenceRefs: [],
          confidence: 1,
          accessFingerprint: "access",
          constraints: [{ scope: "location", locationKey: location }],
          producer: { kind: "human", id: "test" },
          source: "human",
          state: "active",
          direction: "forward",
          createdAt: 1,
        }] : [],
        refreshPending: false,
      }),
    } as unknown as ContextLinkStore.Interface))),
  )
  const service = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* FederatedContextQuery.Service
    }).pipe(Effect.provide(app), Effect.scoped),
  )
  return { query: (input: FederatedContextQuery.Request) => Effect.runPromise(service.query(input)) }
}

function coordinatorFor(doc: ContextRef): LocationIndexCoordinator.Interface {
  return {
    initialize: () => Effect.void,
    observe: () => Effect.void,
    observeRename: () => Effect.void,
    requestReconciliation: () => Effect.void,
    drain: () => Effect.void,
    codeStatus: () => Effect.succeed({ state: "cold", generation: 0, dirtyPathCount: 0, semanticCoverage: {} }),
    searchCode: () => Effect.succeed({ revision: undefined, hits: [] }),
    codeNeighbors: () => Effect.succeed({ revision: undefined, hits: [] }),
    searchDocuments: () => Effect.succeed({ revision, hits: [] }),
    lookupDocuments: () => Effect.succeed({
      revision,
      hits: [{
        score: 1,
        document: {
          documentId: doc.entityId,
          path: "docs/design.md",
          contentSha: "sha",
          headingPath: "Design",
          anchor: "design",
          startLine: 1,
          endLine: 2,
          searchableText: "Design evidence",
        },
      }],
    }),
    pause: () => Effect.void,
    retire: () => Effect.void,
  }
}

const identity: Identity = {
  securityNamespaceId: namespace,
  locationKey: location,
  projectScopeKey: project,
  indexSpaceId: IndexSpaceID.make("idx_federated_query"),
  canonicalRoot: AbsolutePath.make("/workspace"),
}

function documentRef(locationKey: LocationKey): ContextRef {
  return {
    graph: "documents",
    entityId: "document",
    binding: { scope: "location", securityNamespaceId: namespace, locationKey, projectScopeKey: project },
    locator: { path: "docs/design.md", heading: "Design", startLine: 1, endLine: 2 },
    revision: JSON.stringify(revision),
  }
}

function codeRef(): ContextRef {
  return {
    graph: "code",
    entityId: "code-target",
    binding: { scope: "location", securityNamespaceId: namespace, locationKey: location, projectScopeKey: project },
    locator: { path: "source.ts", symbolPath: "target", startLine: 1, endLine: 1 },
    revision: JSON.stringify({ ...revision, projectionKind: "code" }),
  }
}

function principal(locationKey: LocationKey) {
  return {
    securityNamespaceId: namespace,
    principalId: "principal",
    authorizationEpoch: 1,
    locationKeys: [locationKey],
    projectScopeKeys: [project],
    sessionIds: ["session"],
    subjectIds: [],
    allowBuiltin: false,
  }
}

const egress = {
  policyId: "test",
  epoch: 1,
  graphs: ["code", "documents"] as const,
  sensitivities: ["source_code"] as const,
}

const knowledgeEgress = {
  policyId: "test-knowledge",
  epoch: 1,
  graphs: ["knowledge"] as const,
  sensitivities: ["public"] as const,
}
