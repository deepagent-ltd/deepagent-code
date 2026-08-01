import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { ContextAdapters, type Adapter } from "../../src/context-federation/adapters"
import { ContextFederation } from "../../src/context-federation/federation"
import {
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
  type ContextRef,
} from "../../src/context-federation/reference"
import { DocumentStore, type DocType } from "../../src/deepagent/document-store"
import { tmpdir } from "../fixture/tmpdir"

const namespace = SecurityNamespaceID.make("sec_federation_test")
const project = ProjectScopeKey.make("prjctx_federation_test")
const location = LocationKey.make("loc_federation_test")
const scope = {
  securityNamespaceId: namespace,
  projectScopeKey: project,
  legacyProjectId: "legacy-project",
  subjectId: "subject",
  sessionId: "ses_federation_test",
  principal: {
    securityNamespaceId: namespace,
    principalId: "principal",
    authorizationEpoch: 1,
    locationKeys: [location],
    projectScopeKeys: [project],
    sessionIds: ["ses_federation_test"],
    subjectIds: ["subject"],
    allowBuiltin: false,
  },
  egress: {
    policyId: "provider",
    epoch: 1,
    graphs: ["code", "knowledge", "memory", "documents"] as const,
    sensitivities: ["public", "source_code"] as const,
  },
}

describe("federation status and ranking contracts", () => {
  test("rejects illegal status combinations and candidate graph mismatches", () => {
    expect(() =>
      Schema.decodeUnknownSync(ContextFederation.GraphQueryStatus, { onExcessProperty: "error" })({
        graph: "knowledge",
        kind: "complete",
        state: "denied",
        outcome: "matched",
        revisions: [],
      }),
    ).toThrow()
    expect(() =>
      ContextFederation.candidate({
        ...candidate(ref("code", "mismatch")),
        graph: "memory",
      }),
    ).toThrow()
  })

  test("builds deterministic all-graph plans and applies global plus per-graph caps", () => {
    const plan = ContextFederation.queryPlan({ text: "Diagnose the regression in src/session.ts and check the ADR" })
    expect(plan.signals).toContain("code")
    expect(plan.signals).toContain("documents")
    expect(plan.signals).toContain("failure")
    expect(Object.keys(plan.weights).toSorted()).toEqual(["code", "documents", "knowledge", "memory"])

    const lists = {
      code: Array.from({ length: 7 }, (_, index) => candidate(ref("code", `code-${index}`))),
      documents: Array.from({ length: 5 }, (_, index) => candidate(ref("documents", `document-${index}`))),
      knowledge: Array.from({ length: 4 }, (_, index) => candidate(ref("knowledge", `knowledge-${index}`))),
      memory: Array.from({ length: 4 }, (_, index) => candidate(ref("memory", `memory-${index}`))),
    }
    const first = ContextFederation.rank(lists, { weights: plan.weights, toolCall: true })
    const second = ContextFederation.rank(lists, { weights: plan.weights, toolCall: true })
    expect(second).toEqual(first)
    expect(first).toHaveLength(8)
    expect(first.filter((item) => item.candidate.graph === "code").length).toBeLessThanOrEqual(4)
    expect(first.filter((item) => item.candidate.graph === "documents").length).toBeLessThanOrEqual(3)
    expect(first.filter((item) => item.candidate.graph === "knowledge").length).toBeLessThanOrEqual(2)
    expect(first.filter((item) => item.candidate.graph === "memory").length).toBeLessThanOrEqual(2)
  })
})

describe("legacy durable K/M/D adapters", () => {
  test("preserves governed conflicting evidence instead of silently selecting a winner", async () => {
    await using tmp = await tmpdir()
    const store = new DocumentStore(tmp.path)
    const first = add(store, {
      type: "knowledge",
      scope: "durable:project:legacy-project",
      description: "Retries must use exponential backoff",
      body: "Use exponential backoff for provider retries.",
      status: "active",
      evidence: "strong",
      id: "retry-backoff",
    })
    const second = add(store, {
      type: "knowledge",
      scope: "durable:project:legacy-project",
      description: "Provider retries must remain disabled",
      body: "Do not retry provider work after dispatch.",
      status: "active",
      evidence: "strong",
      id: "retry-disabled",
      links: [{ rel: "conflicts_with", to: first.id }],
    })
    store.link(first.id, "conflicts_with", second.id)

    const result = await Effect.runPromise(
      ContextAdapters.knowledge({ stores: [store], scope }).query({ text: "provider retries" }),
    )
    expect(result.candidates.map((item) => item.ref.entityId).toSorted()).toEqual([first.id, second.id].toSorted())
    expect(
      result.candidates.flatMap((item) =>
        item.relations.map((relation) => [item.ref.entityId, relation.relation, relation.ref.entityId]),
      ),
    ).toEqual([
      [first.id, "conflicts_with", second.id],
      [second.id, "conflicts_with", first.id],
    ])
  })

  test("filters governance, sealed, cross-project, sensitivity, relation, and provenance before recall", async () => {
    await using tmp = await tmpdir()
    const store = new DocumentStore(tmp.path)
    const hidden = add(store, {
      type: "knowledge",
      scope: "sealed",
      description: "Durable admission hidden evaluator content",
      body: "secret evaluator",
      status: "active",
      evidence: "strong",
      id: "hidden",
    })
    add(store, {
      type: "knowledge",
      scope: "durable:project:other-project",
      description: "Durable admission from another project",
      body: "private project",
      status: "active",
      evidence: "strong",
      id: "other-project",
    })
    add(store, {
      type: "knowledge",
      scope: "durable:project:legacy-project",
      description: "Durable admission pending review",
      body: "pending",
      status: "candidate",
      evidence: "strong",
      id: "pending",
    })
    add(store, {
      type: "knowledge",
      scope: "durable:project:legacy-project",
      description: "Durable admission sensitive draft",
      body: "sensitive",
      status: "active",
      evidence: "strong",
      id: "secret",
      sensitivity: "secret",
    })
    const visibleEvidence = add(store, {
      type: "knowledge",
      scope: "durable:project:legacy-project",
      description: "Durable admission supporting evidence",
      body: "support",
      status: "active",
      evidence: "medium",
      id: "visible-evidence",
    })
    const visible = add(store, {
      type: "knowledge",
      scope: "durable:project:legacy-project",
      description: "Use durable admission before execution",
      body: "Durable admission and execution must remain separate.",
      status: "active",
      evidence: "strong",
      id: "visible",
      links: [
        { rel: "supports", to: hidden.id },
        { rel: "supports", to: visibleEvidence.id },
      ],
      evidenceRefs: [hidden.id, visibleEvidence.id],
    })

    const adapter = ContextAdapters.knowledge({ stores: [store], scope })
    const result = await Effect.runPromise(adapter.query({ text: "durable admission" }))
    expect(result.status).toMatchObject({ kind: "complete", outcome: "matched" })
    expect(result.candidates.map((item) => item.ref.entityId).toSorted()).toEqual(
      [visible.id, visibleEvidence.id].toSorted(),
    )
    const primary = result.candidates.find((item) => item.ref.entityId === visible.id)!
    expect(primary.relations.map((item) => item.ref.entityId)).toEqual([visibleEvidence.id])
    expect(primary.provenance.map((item) => item.entityId)).toEqual([visibleEvidence.id])

    const originalRevision = result.status.revisions[0]?.revision
    add(store, {
      type: "knowledge",
      scope: "sealed",
      description: "Durable admission another hidden change",
      body: "hidden change",
      status: "active",
      evidence: "strong",
      id: "another-hidden",
    })
    const afterHiddenChange = await Effect.runPromise(adapter.query({ text: "durable admission" }))
    expect(afterHiddenChange.status.revisions[0]?.revision).toBe(originalRevision)
  })

  test("keeps expired memory reference-only and composes a Documents source failure as partial", async () => {
    await using tmp = await tmpdir()
    const store = new DocumentStore(tmp.path)
    const current = add(store, {
      type: "memory",
      scope: "durable:project:legacy-project",
      description: "Previous build uses Bun",
      body: "bun test",
      status: "active",
      evidence: "medium",
      id: "current-memory",
      validUntil: 200,
    })
    const expired = add(store, {
      type: "memory",
      scope: "durable:project:legacy-project",
      description: "Previous build used npm",
      body: "npm test",
      status: "active",
      evidence: "medium",
      id: "expired-memory",
      validUntil: 50,
    })
    const memory = await Effect.runPromise(
      ContextAdapters.memory({ stores: [store], scope }).query({ text: "previous build", now: 100 }),
    )
    expect(memory.candidates.find((item) => item.ref.entityId === current.id)?.visibility).toBe("model")
    expect(memory.candidates.find((item) => item.ref.entityId === expired.id)?.visibility).toBe("reference_only")
    expect(
      ContextFederation.rank(
        { memory: memory.candidates },
        { weights: ContextFederation.queryPlan({ text: "previous" }).weights, toolCall: true },
      ).map((item) => item.candidate.ref.entityId),
    ).toEqual([current.id])

    const document = add(store, {
      type: "decision",
      scope: "run:ses_federation_test",
      description: "Decision to preserve durable admission",
      body: "decision body",
      status: "draft",
      id: "decision",
    })
    add(store, {
      type: "decision",
      scope: "run:ses_other",
      description: "Decision from another session",
      body: "private",
      status: "draft",
      id: "other-session",
    })
    const available = ContextAdapters.executionDocuments({ source: "execution_documents", stores: [store], scope })
    const unavailable: Adapter = {
      graph: "documents",
      source: "repo_documents",
      query: () =>
        Effect.succeed({
          candidates: [],
          status: ContextFederation.status.blocked({
            graph: "documents",
            state: "unavailable",
            reasonCode: "source_error",
            revisions: [{ source: "repo_documents", state: "unavailable", reasonCode: "source_error" }],
          }),
        }),
    }
    const documents = await Effect.runPromise(
      ContextAdapters.documents([available, unavailable]).query({ text: "durable admission", now: 100 }),
    )
    expect(documents.status).toMatchObject({ kind: "partial", reasonCode: "partial_sources" })
    expect(documents.candidates.map((item) => item.ref.entityId)).toEqual([document.id])
  })
})

function ref(graph: "code" | "knowledge" | "memory" | "documents", entityId: string): ContextRef {
  return {
    graph,
    entityId,
    binding: { scope: "location", securityNamespaceId: namespace, locationKey: location, projectScopeKey: project },
    revision: "revision",
  }
}

function candidate(reference: ContextRef) {
  return ContextFederation.candidate({
    ref: reference,
    graph: reference.graph,
    title: reference.entityId,
    summary: reference.entityId,
    relations: [],
    provenance: [],
    features: { exact: 0, lexical: 0.8, authority: 0.8, evidence: 0.8, freshness: 1 },
    trust: reference.graph === "knowledge" ? "governed_guidance" : "repository_evidence",
    visibility: "model",
  })
}

function add(
  store: DocumentStore,
  input: {
    readonly type: DocType
    readonly scope: string
    readonly description: string
    readonly body: string
    readonly status: "draft" | "candidate" | "active"
    readonly id: string
    readonly evidence?: "strong" | "medium" | "weak" | "none"
    readonly sensitivity?: "public" | "source_code" | "pii" | "secret_adjacent" | "secret"
    readonly validUntil?: number
    readonly links?: readonly { readonly rel: "supports" | "conflicts_with"; readonly to: string }[]
    readonly evidenceRefs?: readonly string[]
  },
) {
  const doc = store.create({
    type: input.type,
    scope: input.scope,
    description: input.description,
    body: input.body,
    idSlug: input.id,
    provenance: { source: "human", evidence_refs: input.evidenceRefs },
    links: input.links,
    ...(input.evidence ? { confidence: { evidence_strength: input.evidence, support_count: 1 } } : {}),
    extensions: {
      sensitivity: input.sensitivity ?? "public",
      ...(input.validUntil === undefined ? {} : { valid_until: input.validUntil }),
    },
  })
  if (input.status !== "draft") store.setStatus(doc.id, input.status)
  return store.get(doc.id)!
}
