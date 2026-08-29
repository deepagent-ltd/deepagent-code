import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ContextAdaptersV2 } from "../../src/context-federation/adapters-v2"
import {
  type CodeQuery,
} from "../../src/code-intelligence/query"
import { ContextFederation } from "../../src/context-federation/federation"
import { ContextAdapters } from "../../src/context-federation/adapters"
import { LocationKey, ProjectScopeKey, SecurityNamespaceID } from "../../src/context-federation/reference"
import { DocumentStore, documentRevision } from "../../src/deepagent/document-store"
import { tmpdir } from "../fixture/tmpdir"

const ns = SecurityNamespaceID.make("sec_adapters_v2_test")
const proj = ProjectScopeKey.make("prj_adapters_v2_test")
const loc = LocationKey.make("loc_adapters_v2_test")

const principal = {
  securityNamespaceId: ns,
  principalId: "principal-v2",
  authorizationEpoch: 1,
  locationKeys: [loc],
  projectScopeKeys: [proj],
  sessionIds: ["ses_adapters_v2_test"],
  subjectIds: ["subject-v2"],
  allowBuiltin: false,
}

const egress = {
  policyId: "provider-v2",
  epoch: 1,
  graphs: ["code", "documents", "knowledge", "memory"] as const,
  sensitivities: ["public", "source_code"] as const,
}

const scope = {
  securityNamespaceId: ns,
  projectScopeKey: proj,
  legacyProjectId: "legacy-project",
  subjectId: "subject-v2",
  sessionId: "ses_adapters_v2_test",
  principal,
  egress,
}

function adapterInput(overrides?: { readonly query?: string; readonly entityIds?: readonly string[] }) {
  return {
    query: overrides?.query ?? "inspect the seed",
    ...(overrides?.entityIds ? { entityIds: overrides.entityIds } : {}),
    now: 100,
    sessionId: "ses_adapters_v2_test",
    securityNamespaceId: ns,
    locationKey: loc,
    projectScopeKey: proj,
    legacyProjectId: "legacy-project",
    subjectId: "subject-v2",
    principal,
    egress,
  }
}

describe("ContextAdaptersV2 adapter wiring", () => {
  test("publishes a per-graph adapter version const", () => {
    expect(ContextAdaptersV2.AdapterVersion.code).toBe("code-intelligence.v1")
    expect(ContextAdaptersV2.AdapterVersion.documents).toBe("documents-union.v1")
    expect(ContextAdaptersV2.AdapterVersion.knowledge).toBe("released-knowledge.v1")
    expect(ContextAdaptersV2.AdapterVersion.memory).toBe("durable-memory.v1")
  })

  test("code adapter projects code-intelligence hits and reports revision/epoch", async () => {
    const hit = {
      ref: {
        graph: "code",
        entityId: "symbol-1",
        binding: { scope: "location", securityNamespaceId: ns, locationKey: loc, projectScopeKey: proj },
        revision: "code:1",
      },
      file: "src/foo.ts",
      symbol: "foo",
      score: 1,
      snippet: "export function foo",
      sources: ["graph"],
      editorOverlay: "not_applicable",
    }
    const service = {
      query: () =>
        Effect.succeed({
          index: {
            state: "ready",
            generation: 3,
            dirtyPathCount: 0,
            semanticCoverage: { typescript: "semantic" },
            stale: false,
          },
          status: ContextFederation.status.matched("code", [{ source: "code", revision: "code:1", state: "ready" }]),
          consistency: "stale_ok",
          freshnessSatisfied: true,
          enrichment: { lsp: "not_applicable", editorOverlay: "not_applicable" },
          hits: [hit],
          truncated: false,
        }),
    } as unknown as CodeQuery.Interface
    const adapter = ContextAdaptersV2.code({ service })
    const result = await Effect.runPromise(adapter.resolve(adapterInput()))
    expect(adapter.adapterVersion).toBe("code-intelligence.v1")
    expect(result.available).toBe(true)
    expect(result.observedMutationEpoch).toBe(3)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.ref.entityId).toBe("symbol-1")
  })

  test("knowledge adapter feeds a released, non-superseded snapshot and is unavailable when superseded", async () => {
    await using tmp = await tmpdir()
    const store = new DocumentStore(tmp.path)
    const knowledge = store.create({
      type: "knowledge",
      scope: "durable:project:legacy-project",
      description: "Release admission before execution",
      body: "Keep admission and model execution separate.",
      idSlug: "released-knowledge",
      provenance: { source: "human" },
      confidence: { evidence_strength: "strong", support_count: 1 },
      extensions: { sensitivity: "public" },
    })
    store.setStatus(knowledge.id, "active", documentRevision(knowledge))
    const released = selection([store.get(knowledge.id)!])

    const bound = ContextAdaptersV2.knowledge({
      stores: [store, store],
      scope,
      releasedSelection: released,
      superseded: false,
      binding: "bound",
    })
    const ok = await Effect.runPromise(bound.resolve(adapterInput({ entityIds: [knowledge.id] })))
    expect(ok.available).toBe(true)
    expect(ok.candidates.map((c) => c.ref.entityId)).toContain(knowledge.id)

    const superseded = ContextAdaptersV2.knowledge({
      stores: [store, store],
      scope,
      releasedSelection: released,
      superseded: true,
      binding: "bound",
    })
    const stale = await Effect.runPromise(superseded.resolve(adapterInput({ entityIds: [knowledge.id] })))
    expect(stale.available).toBe(false)
    expect(stale.unavailableReasonCode).toBe("released_snapshot_unavailable")
    expect(stale.candidates).toHaveLength(0)
  })

  test("memory adapter projects durable memory into the current request", async () => {
    await using tmp = await tmpdir()
    const store = new DocumentStore(tmp.path)
    const memory = store.create({
      type: "memory",
      scope: "durable:project:legacy-project",
      description: "Do not open filesystem before admission",
      body: "Admit first.",
      idSlug: "durable-memory",
      provenance: { source: "runner" },
      confidence: { evidence_strength: "strong", support_count: 1 },
      extensions: { sensitivity: "public" },
    })
    store.setStatus(memory.id, "active", documentRevision(memory))
    const released = selection([store.get(memory.id)!])
    const adapter = ContextAdaptersV2.memory({
      stores: [store, store],
      scope,
      releasedSelection: released,
      revision: "mem:1",
      observedMutationEpoch: 2,
    })
    const result = await Effect.runPromise(adapter.resolve(adapterInput({ entityIds: [memory.id] })))
    expect(adapter.adapterVersion).toBe("durable-memory.v1")
    expect(result.available).toBe(true)
    expect(result.candidates.map((c) => c.ref.entityId)).toContain(memory.id)
    expect(result.observedMutationEpoch).toBe(2)
  })

  test("documents adapter unions document sources", async () => {
    await using tmp = await tmpdir()
    const store = new DocumentStore(tmp.path)
    const decision = store.create({
      type: "decision",
      scope: "run:ses_adapters_v2_test",
      description: "Decision evidence",
      body: "decision body",
      idSlug: "run-decision",
      provenance: { source: "runner" },
      extensions: { sensitivity: "public" },
    })
    const docAdapter = ContextAdaptersV2.documents({
      sources: [ContextAdapters.executionDocuments({ source: "execution_documents", stores: [store], scope })],
      revision: "doc:1",
      observedMutationEpoch: 4,
    })
    const result = await Effect.runPromise(docAdapter.resolve(adapterInput({ entityIds: [decision.id] })))
    expect(docAdapter.adapterVersion).toBe("documents-union.v1")
    expect(result.available).toBe(true)
    expect(result.candidates.map((c) => c.ref.entityId)).toContain(decision.id)
    expect(result.observedMutationEpoch).toBe(4)
  })
})

function selection(documents: readonly NonNullable<ReturnType<DocumentStore["get"]>>[]) {
  return {
    snapshotId: "snapshot_adapters_v2_test",
    securityNamespaceId: ns,
    projectScopeKey: proj,
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
