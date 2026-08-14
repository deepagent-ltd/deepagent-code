import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ContextAdapters, type Adapter } from "../../src/context-federation/adapters"
import { ContextFederation } from "../../src/context-federation/federation"
import { ContextLinkStore } from "../../src/context-federation/link-store"
import { FederatedContextResolver } from "../../src/context-federation/resolver"
import {
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
  type ContextRef,
} from "../../src/context-federation/reference"
import { Database } from "../../src/database/database"
import { DocumentStore, documentRevision } from "../../src/deepagent/document-store"
import { tmpdir } from "../fixture/tmpdir"

const namespace = SecurityNamespaceID.make("sec_resolver_test")
const project = ProjectScopeKey.make("prjctx_resolver_test")
const location = LocationKey.make("loc_resolver_test")
const codeRef: ContextRef = {
  graph: "code",
  entityId: "code-seed",
  binding: { scope: "location", securityNamespaceId: namespace, projectScopeKey: project, locationKey: location },
  revision: "code:1",
}
const principal = {
  securityNamespaceId: namespace,
  principalId: "principal",
  authorizationEpoch: 1,
  locationKeys: [location],
  projectScopeKeys: [project],
  sessionIds: ["ses_resolver_test"],
  subjectIds: ["subject"],
  allowBuiltin: false,
}
const egress = {
  policyId: "provider",
  epoch: 1,
  graphs: ["code", "knowledge", "memory", "documents"] as const,
  sensitivities: ["public", "source_code"] as const,
}

describe("FederatedContextResolver shadow mode", () => {
  test("queries all graphs, expands authorized links, and has no model projection surface", async () => {
    await using tmp = await tmpdir()
    const store = new DocumentStore(tmp.path)
    const knowledge = store.create({
      type: "knowledge",
      scope: "durable:project:legacy-project",
      description: "Use durable admission before execution",
      body: "Keep admission and model execution separate.",
      idSlug: "durable-admission",
      provenance: { source: "human" },
      confidence: { evidence_strength: "strong", support_count: 1 },
      extensions: { sensitivity: "public" },
    })
    store.setStatus(knowledge.id, "active", documentRevision(knowledge))
    const scope = {
      securityNamespaceId: namespace,
      projectScopeKey: project,
      legacyProjectId: "legacy-project",
      subjectId: "subject",
      sessionId: "ses_resolver_test",
      principal,
      egress,
    }
    const harness = makeHarness([
      codeAdapter(),
      ContextAdapters.knowledge({ stores: [store, store], scope, releasedSelection: selection([store.get(knowledge.id)!]) }),
      ContextAdapters.memory({ stores: [store, store], scope, releasedSelection: selection([]) }),
      ContextAdapters.documents([
        ContextAdapters.executionDocuments({ source: "execution_documents", stores: [store], scope }),
      ]),
    ])
    await harness.run(
      Effect.gen(function* () {
        const links = yield* ContextLinkStore.Service
        yield* links.put({
          securityNamespaceId: namespace,
          projectScopeKey: project,
          producer: { kind: "human", id: "reviewer" },
          source: "human",
          link: {
            from: codeRef,
            to: {
              graph: "knowledge",
              entityId: knowledge.id,
              binding: { scope: "project", securityNamespaceId: namespace, projectScopeKey: project },
              revision: JSON.stringify({
                version: 1,
                hash: store.get(knowledge.id)!.hash,
                status: "active",
                supersededBy: null,
                validity: {},
              }),
            },
            relation: "supports",
            evidenceRefs: [],
            confidence: 1,
          },
          createdBy: "reviewer",
          now: 10,
        })
        expect(
          (yield* links.neighbors({
            securityNamespaceId: namespace,
            projectScopeKey: project,
            ref: codeRef,
            principal,
            egress,
            now: 100,
          })).links,
        ).toHaveLength(1)
        const result = yield* (yield* FederatedContextResolver.Service).queryShadow(input("inspect the code seed"))
        expect(result.mode).toBe("shadow")
        expect("projection" in result).toBe(false)
        expect(result.statuses.map((item) => item.graph)).toEqual(["code", "documents", "knowledge", "memory"])
        expect(result.ranked.map((item) => item.candidate.ref.entityId)).toContain(knowledge.id)
      }),
    )
  })

  test("contains one graph timeout without converting other graphs to empty failures", async () => {
    await using tmp = await tmpdir()
    const store = new DocumentStore(tmp.path)
    const decision = store.create({
      type: "decision",
      scope: "run:ses_resolver_test",
      description: "Decision evidence for timeout containment",
      body: "continue with remaining graph evidence",
      idSlug: "timeout-decision",
      provenance: { source: "runner" },
      extensions: { sensitivity: "public" },
    })
    const scope = {
      securityNamespaceId: namespace,
      projectScopeKey: project,
      legacyProjectId: "legacy-project",
      subjectId: "subject",
      sessionId: "ses_resolver_test",
      principal,
      egress,
    }
    const timeout: Adapter = { graph: "code", source: "code", query: () => Effect.never }
    const harness = makeHarness(
      [
        timeout,
        ContextAdapters.knowledge({ stores: [store, store], scope, releasedSelection: selection([]) }),
        ContextAdapters.memory({ stores: [store, store], scope, releasedSelection: selection([]) }),
        ContextAdapters.documents([
          ContextAdapters.executionDocuments({ source: "execution_documents", stores: [store], scope }),
        ]),
      ],
      5,
    )
    await harness.run(
      Effect.gen(function* () {
        const result = yield* (yield* FederatedContextResolver.Service).queryShadow(
          input("timeout containment decision"),
        )
        expect(result.statuses.find((item) => item.graph === "code")).toMatchObject({
          kind: "partial",
          reasonCode: "source_timeout",
        })
        expect(result.statuses.find((item) => item.graph === "documents")).toMatchObject({
          kind: "complete",
          outcome: "matched",
        })
        expect(result.ranked.some((item) => item.candidate.ref.entityId === decision.id)).toBe(true)
      }),
    )
  })
})

function makeHarness(adapters: readonly Adapter[], timeout = 100) {
  const database = Database.layerFromPath(":memory:")
  const authority = Layer.succeed(
    ContextLinkStore.RevisionAuthority,
    ContextLinkStore.RevisionAuthority.of({
      withCurrent: (_input, use) => use,
      isCurrent: () => Effect.succeed(true),
    }),
  )
  const links = ContextLinkStore.layer.pipe(Layer.provideMerge(Layer.merge(database, authority)))
  const layer = FederatedContextResolver.layer({ adapters, perGraphTimeoutMs: timeout }).pipe(Layer.provideMerge(links))
  return {
    run: <A, E>(effect: Effect.Effect<A, E, ContextLinkStore.Service | FederatedContextResolver.Service>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped)),
  }
}

function codeAdapter(): Adapter {
  const item = ContextFederation.candidate({
    ref: codeRef,
    graph: "code",
    title: "code seed",
    summary: "code seed",
    relations: [],
    provenance: [],
    features: { exact: 1, lexical: 1, authority: 1, evidence: 1, freshness: 1 },
    trust: "repository_evidence",
    visibility: "model",
  })
  return {
    graph: "code",
    source: "code",
    query: () =>
      Effect.succeed({
        candidates: [item],
        status: ContextFederation.status.matched("code", [{ source: "code", revision: "code:1", state: "ready" }]),
      }),
  }
}

function input(text: string) {
  return {
    securityNamespaceId: namespace,
    projectScopeKey: project,
    principal,
    egress,
    text,
    toolCall: true,
    now: 100,
  }
}

function selection(documents: readonly NonNullable<ReturnType<DocumentStore["get"]>>[]) {
  return {
    snapshotId: "snapshot_resolver_test",
    securityNamespaceId: namespace,
    projectScopeKey: project,
    legacyProjectId: "legacy-project",
    parentSnapshotId: null,
    generation: 1,
    membershipHash: `sha256:${"0".repeat(64)}`,
    manifestHash: `sha256:${"1".repeat(64)}`,
    documents: documents.map((doc) => ({
      sourceStore: "project" as const,
      id: doc.id,
      version: doc.version,
      hash: doc.hash,
      type: doc.type,
      scope: doc.scope,
    })),
  }
}
