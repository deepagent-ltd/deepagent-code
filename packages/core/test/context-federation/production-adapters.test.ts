import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { DurableKnowledgeStore } from "../../src/deepagent/durable-knowledge-store"
import { DeepAgentReleasedSnapshot } from "../../src/deepagent/released-snapshot"
import {
  ReleasedKnowledgeEvaluationTable,
  ReleasedKnowledgeSnapshotHeadTable,
  ReleasedKnowledgeSnapshotTable,
} from "../../src/deepagent/released-snapshot.sql"
import {
  ProductionV2Sources,
  productionV2Adapters,
  productionAdaptersEnabled,
  type ProductionV2AdapterInput,
  type ProductionDocumentsSource,
  type ProductionReleasedBinding,
} from "../../src/context-federation/production-adapters"
import { createRuntimeFeatureRegistry } from "../../src/flag/runtime-features"
import { SessionContextResolverV2, type QueryEnvelope } from "../../src/context-federation/resolver-v2"
import { ContextFederation } from "../../src/context-federation/federation"
import { LocationKey, ProjectScopeKey, SecurityNamespaceID, type ContextRef } from "../../src/context-federation/reference"
import { intentFor } from "../../src/context-federation/adapters-v2"
import { type CodeQuery } from "../../src/code-intelligence/query"
import { Database } from "../../src/database/database"
import { SessionContext } from "../../src/context-federation/session-context"
import { SessionRunnerCanonical } from "../../src/session/runner/canonical-turn"
import { SessionSchema } from "../../src/session/schema"
import { SessionMessage } from "../../src/session/message"
import { Prompt } from "../../src/session/prompt"
import { SessionInputTable, SessionTable } from "../../src/session/sql"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { eq, sql } from "drizzle-orm"
import { ProjectionSnapshotRevision } from "../../src/context-federation/reference"
import { SessionContextSelectionTable } from "../../src/context-federation/session-sql"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "../../src/context-federation/sql"
import { Hash } from "../../src/util/hash"
import { mkdtempSync } from "node:fs"
import { tmpdir as osTmpdir } from "node:os"
import path from "node:path"
import { testEffect } from "../lib/effect"

// W3 — production adapter assembly with REAL sources (fixture stores over tmpdir, fake CodeQuery
// recording intents, repo-documented search fixtures, fabricated released snapshot). Proves the
// default path yields {ready, empty} (never the staged source_disabled), rejectedCount semantics,
// intent mapping, and released-snapshot drift -> successor signal + canonical re-bind.

const tmpdirPath = mkdtempSync(path.join(osTmpdir(), "deepagent-code-w3-prod-"))

const ns = SecurityNamespaceID.make("sec_prod_adapters")
const proj = ProjectScopeKey.make("prj_prod_adapters")
const loc = LocationKey.make("loc_prod_adapters")

const principal = {
  securityNamespaceId: ns,
  principalId: "principal-prod",
  authorizationEpoch: 1,
  locationKeys: [loc],
  projectScopeKeys: [proj],
  sessionIds: ["ses_prod"],
  subjectIds: ["subject-prod"],
  allowBuiltin: false,
}

const egress = {
  policyId: "provider-prod",
  epoch: 1,
  graphs: ["code", "documents", "knowledge", "memory"] as const,
  sensitivities: ["public", "source_code"] as const,
}

function envelope(overrides?: Partial<QueryEnvelope>): QueryEnvelope {
  return {
    membership: { sessionId: "ses_prod", activityId: "act_prod", inputIds: ["msg_prod"] },
    location: { locationKey: loc },
    principal,
    workspace: { workspaceId: "ws_prod" },
    securityNamespace: { securityNamespaceId: ns },
    projectScope: { projectScopeKey: proj, projectId: "legacy-project" },
    egress,
    agentPolicy: { agentId: "agent-prod", autonomyCeiling: "medium", permitDegraded: true },
    modelCapability: { modelId: "model", providerId: "provider", protocol: "openai.responses", contextWindow: 128_000, structuredOutput: false },
    releasedKnowledge: { snapshotId: "", binding: "unavailable" },
    queryIntent: "search",
    query: "seed knowledge",
    limit: 12,
    observedLocationMutationEpoch: 0,
    ...overrides,
  }
}

/** A fake CodeQuery service that records every intent it receives. */
function fakeCodeQuery(records: { readonly intents: string[] }, hit?: ContextRef) {
  const query: CodeQuery.Interface["query"] = (request) => {
    records.intents.push(request.intent)
    const revision: ProjectionSnapshotRevision = {
      projectionKind: "code",
      indexIncarnation: 1,
      generation: 1,
      manifestHash: "f".repeat(64),
      schemaVersion: 1,
      adapterSetVersion: "ts-js-v1",
    }
    return Effect.succeed({
      index: indexWith(revision),
      status: ContextFederation.status.matched("code", [{ source: "code_graph", revision: JSON.stringify(revision), state: "ready" }]),
      consistency: request.consistency,
      freshnessSatisfied: true,
      enrichment: { lsp: "not_applicable", editorOverlay: "not_applicable" },
      hits: hit === undefined ? [] : [codeHit(hit, request.query ?? "")],
      truncated: false,
    })
  }
  const service: CodeQuery.Interface = { query }
  return service
}

function indexWith(revision: ProjectionSnapshotRevision) {
  return {
    state: "ready" as const,
    generation: 1,
    dirtyPathCount: 0,
    semanticCoverage: {},
    revision,
    stale: false,
  }
}

function codeHit(ref: ContextRef, query: string) {
  return {
    ref,
    file: "src/seed.ts",
    symbol: "seed",
    kind: "function",
    score: 1,
    snippet: `export function seed() { // ${query}`,
    sources: ["graph"] as const,
    editorOverlay: "not_applicable" as const,
  }
}

const codeRef: ContextRef = {
  graph: "code",
  entityId: "seed-symbol",
  binding: { scope: "location", securityNamespaceId: ns, locationKey: loc, projectScopeKey: proj },
  revision: "code:1",
  locator: { path: "src/seed.ts", symbolPath: "seed", startLine: 1, endLine: 3 },
}

function documentsSource(
  hits: readonly { readonly document: import("../../src/document-intelligence/repo-document").Entry; readonly score: number }[],
  epoch = 7,
): ProductionDocumentsSource {
  return {
    search: ({ query, limit }) =>
      Effect.succeed({
        revision: { projectionKind: "repo_documents", indexIncarnation: 3, generation: 2, manifestHash: "docs-manifest", schemaVersion: 1, adapterSetVersion: "markdown-v1" },
        hits: hits.slice(0, limit).filter((hit) => hit.document.searchableText.includes(query)),
      }),
    mutationEpoch: () => Effect.succeed(epoch),
  }
}

function docHit() {
  return {
    document: {
      documentId: "docs:handoff",
      path: "docs/deepagent/HANDOFF.md",
      contentSha: "sha-test",
      headingPath: "Handoff",
      anchor: "handoff",
      startLine: 1,
      endLine: 2,
      searchableText: "handoff seed knowledge",
    },
    score: 1,
  }
}

describe("W3 production adapters: real sources, never staged", () => {
  test("flag gate: production is ON by default and an explicit =false falls back", () => {
    // `RuntimeFeatures` is an immutable process-start snapshot, so the kill-switch resolves at
    // process start and tests exercise it through the injectable registry seam — never by
    // mutating process.env after the snapshot (that mutation is intentionally unobservable).
    const withEnv = (env: Readonly<Record<string, string | undefined>>) =>
      createRuntimeFeatureRegistry(undefined, env)
    expect(productionAdaptersEnabled()).toBe(true)
    expect(productionAdaptersEnabled(withEnv({}))).toBe(true)
    expect(productionAdaptersEnabled(withEnv({ DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION: "false" }))).toBe(false)
    expect(productionAdaptersEnabled(withEnv({ DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION: "0" }))).toBe(false)
    expect(productionAdaptersEnabled(withEnv({ DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION: "true" }))).toBe(true)
  })

  test("four graphs resolve ready/empty with real fixture sources (code/documents never degraded)", async () => {
    const records: { intents: string[] } = { intents: [] }
    const input: ProductionV2AdapterInput = {
      code: fakeCodeQuery(records, codeRef),
      documents: documentsSource([docHit()]),
    }
    const adapters = productionV2Adapters(input)
    const result = await Effect.runPromise(SessionContextResolverV2.resolveGraphs(envelope(), adapters, 100))
    expect(result.graphStatuses.code.status).toBe("ready")
    expect(result.graphStatuses.code.candidateCount).toBe(1)
    expect(result.graphStatuses.documents.status).toBe("ready")
    expect(result.graphStatuses.documents.candidateCount).toBe(1)
    // No knowledge store / no released snapshot: legitimate empty domains (never degraded).
    expect(result.graphStatuses.knowledge.status).toBe("empty")
    expect(result.graphStatuses.knowledge.reasonCode).toBe("none")
    expect(result.graphStatuses.knowledge.rejectedCount).toBe(0)
    expect(result.graphStatuses.memory.status).toBe("empty")
    expect(result.graphStatuses.memory.rejectedCount).toBe(0)
    expect(result.graphStatuses.documents.observedMutationEpoch).toBe(7)
  })

  test("knowledge with a released snapshot + fixture store serves released candidates", async () => {
    const { knowledgeInput, selection } = knowledgeFixture()
    const adapters = productionV2Adapters({ knowledge: knowledgeInput })
    const result = await Effect.runPromise(
      SessionContextResolverV2.resolveGraphs(envelope({ query: "seed knowledge" }), adapters, 100),
    )
    expect(result.graphStatuses.knowledge.status).toBe("ready")
    expect(result.graphStatuses.knowledge.candidateCount).toBe(1)
    // adapters-v2 knowledge reports the stable `released` revision (the snapshot identity rides the
    // candidate refs / the selection row's released binding).
    expect(result.graphStatuses.knowledge.revision).toBe("released")
    expect(result.graphStatuses.knowledge.rejectedCount).toBe(0)
  })

  test("W7 scope gate: another workspace's project-shared docs are never served (knowledge/memory)", async () => {
    // The fixture seeds a project-shared doc under `legacy-project` while the resolving envelope
    // owns `other-project`. The adapter's scope gate (bindingFor on `durable:project:<pid>`) filters
    // it BEFORE candidate creation, so the other workspace reads a legitimate EMPTY domain — no
    // leak, and no "rejected" signal either (rejectedCount stays 0; the gate is not authorization
    // denial, it is isolation).
    const { projectStore } = knowledgeFixtureRoots()
    projectStore.seedActive({
      type: "knowledge",
      description: "project private fact",
      body: "must never leak to another workspace",
      domain: null,
      tags: [],
      scope: "project-shared",
      projectId: "legacy-project",
      sensitivity: "public",
      risk: "low",
      confidence: { evidence_strength: "strong", support_count: 1 },
      provenance: { source: "runner", evidence_refs: [] },
    })
    const adapters = productionV2Adapters({ knowledge: { stores: [projectStore] } })
    const result = await Effect.runPromise(
      SessionContextResolverV2.resolveGraphs(
        envelope({ projectScope: { projectScopeKey: proj, projectId: "other-project" }, query: "project private fact" }),
        adapters,
        100,
      ),
    )
    expect(result.graphStatuses.knowledge.status).toBe("empty")
    expect(result.graphStatuses.knowledge.candidateCount).toBe(0)
    expect(result.graphStatuses.knowledge.rejectedCount).toBe(0)
    expect(result.graphStatuses.memory.status).toBe("empty")
    expect(result.graphStatuses.memory.candidateCount).toBe(0)
    expect(result.candidates).toHaveLength(0)
  })

  test("W7 memory reads active durable memory docs directly (no released snapshot needed)", async () => {
    // memoryAdapter connects the SAME DurableKnowledgeStore(s) as knowledge — status=active memory
    // docs serve from the direct store read, while a `memory`-typed doc never surfaces as knowledge
    // and vice versa (adapter-level type/status gates).
    const { projectStore } = knowledgeFixtureRoots()
    projectStore.seedActive({
      type: "memory",
      description: "learned fact",
      body: "the memory body",
      domain: null,
      tags: [],
      scope: "project-shared",
      projectId: "legacy-project",
      sensitivity: "public",
      risk: "low",
      confidence: { evidence_strength: "strong", support_count: 1 },
      provenance: { source: "runner", evidence_refs: [] },
    })
    const adapters = productionV2Adapters({ knowledge: { stores: [projectStore] } })
    const result = await Effect.runPromise(
      SessionContextResolverV2.resolveGraphs(envelope({ query: "learned fact" }), adapters, 100),
    )
    expect(result.graphStatuses.memory.status).toBe("ready")
    expect(result.graphStatuses.memory.candidateCount).toBe(1)
    expect(result.graphStatuses.memory.revision).toBe("memory:0")
    expect(result.graphStatuses.memory.rejectedCount).toBe(0)
    // The memory graph walks the DurableKnowledgeStore directly — no released selection required,
    // so knowledge (released-gated) stays an empty domain in the same resolution.
    expect(result.graphStatuses.knowledge.status).toBe("empty")
  })

  test("W7 status gate: non-active durable docs never serve (knowledge)", async () => {
    // A staged (candidate-status) project doc is in the same store but `eligible()` requires
    // status=active for knowledge/memory; the read stays empty instead of surfacing a draft.
    const { projectStore } = knowledgeFixtureRoots()
    projectStore.stageCandidate({
      type: "knowledge",
      description: "pending knowledge",
      body: "not yet approved",
      domain: null,
      tags: [],
      scope: "project-shared",
      projectId: "legacy-project",
      sensitivity: "public",
      risk: "low",
      confidence: { evidence_strength: "medium", support_count: 1 },
      provenance: { source: "runner", evidence_refs: [] },
    })
    const adapters = productionV2Adapters({ knowledge: { stores: [projectStore] } })
    const result = await Effect.runPromise(
      SessionContextResolverV2.resolveGraphs(
        envelope({ projectScope: { projectScopeKey: proj, projectId: "legacy-project" }, query: "pending knowledge" }),
        adapters,
        100,
      ),
    )
    expect(result.graphStatuses.knowledge.status).toBe("empty")
    expect(result.graphStatuses.knowledge.candidateCount).toBe(0)
    expect(result.graphStatuses.knowledge.rejectedCount).toBe(0)
  })

  test("rejectedCount: candidates outside the principal scope are recorded, never silent", async () => {
    // The candidate is bound to Location B while the principal owns A: every hit is rejected.
    const crossRef: ContextRef = { ...codeRef, binding: { scope: "location", securityNamespaceId: ns, locationKey: LocationKey.make("loc_other"), projectScopeKey: proj } }
    const adapters = productionV2Adapters({ code: fakeCodeQuery({ intents: [] }, crossRef) })
    const result = await Effect.runPromise(SessionContextResolverV2.resolveGraphs(envelope(), adapters, 100))
    expect(result.graphStatuses.code.status).toBe("empty")
    // "no data" vs "all rejected": source had data but every candidate was rejected.
    expect(result.graphStatuses.code.rejectedCount).toBe(1)
    expect(result.graphStatuses.code.candidateCount).toBe(0)
    expect(result.graphStatuses.code.reasonCode).toBe("none")
    expect(result.candidates).toHaveLength(0)
  })

  test("intentFor maps selection intents and passes bounded code intents through", async () => {
    expect(intentFor("definition")).toBe("definition")
    expect(intentFor("trace_evidence")).toBe("references")
    expect(intentFor("related")).toBe("overview")
    expect(intentFor("recall")).toBe("search")
    expect(intentFor(undefined)).toBe("search")
    const records: { intents: string[] } = { intents: [] }
    const adapter = productionV2Adapters({ code: fakeCodeQuery(records, codeRef) }).code
    await Effect.runPromise(adapter.resolve(adapterInput("definition")))
    await Effect.runPromise(adapter.resolve(adapterInput()))
    expect(records.intents).toEqual(["definition", "search"])
  })

  test("released snapshot drift -> degraded + SuccessorRebuildSignal(released_snapshot_drift)", async () => {
    const { selection, newer } = releasedPair()
    let current = newer
    const input: ProductionV2AdapterInput = {
      knowledge: {
        stores: [new DurableKnowledgeStore(tmpdirPath)],
        released: {
          snapshotId: selection.snapshotId,
          binding: "bound",
          current: () => Effect.succeed(current),
        },
      },
    }
    const adapters = productionV2Adapters(input)
    const result = await Effect.runPromise(
      SessionContextResolverV2.resolveGraphs(
        envelope({ releasedKnowledge: { snapshotId: selection.snapshotId, binding: "bound" } }),
        adapters,
        100,
      ),
    )
    expect(result.graphStatuses.knowledge.status).toBe("degraded_unavailable")
    expect(result.graphStatuses.knowledge.reasonCode).toBe("released_snapshot_unavailable")
    expect(result.successorRebuild?.trigger).toBe("released_snapshot_drift")
    expect(result.successorRebuild?.expected).toBe(selection.snapshotId)
    expect(result.successorRebuild?.observed).toBe(newer.snapshotId)
  })

  test("M2: unbound + degraded knowledge reports degraded with NO successor signal (negative regression)", async () => {
    // The envelope has no released-snapshot expectation (binding "unavailable") while the knowledge
    // source is degraded (picker unavailable): the graph is honestly degraded and the resolver must
    // NOT emit a released_snapshot_drift successor — drift is only meaningful when a snapshot was
    // bound (W3.3 rule), otherwise a stale frame would rebuild every turn forever.
    const input: ProductionV2AdapterInput = {
      knowledge: {
        stores: [new DurableKnowledgeStore(tmpdirPath)],
        released: {
          snapshotId: "snap-unbound",
          binding: "unavailable",
          current: () => Effect.fail(new Error("released picker unavailable")),
        },
      },
    }
    const adapters = productionV2Adapters(input)
    const result = await Effect.runPromise(
      SessionContextResolverV2.resolveGraphs(
        envelope({ releasedKnowledge: { snapshotId: "", binding: "unavailable" } }),
        adapters,
        100,
      ),
    )
    expect(result.graphStatuses.knowledge.status).toBe("degraded_unavailable")
    expect(result.graphStatuses.knowledge.reasonCode).toBe("released_snapshot_unavailable")
    expect(result.successorRebuild).toBeUndefined()
  })

  test("M2: a released-picker integrity defect degrades knowledge, never crashes the resolution (scope mismatch honesty)", async () => {
    // W3.8 A — the deep read (`DeepAgentReleasedSnapshot.current`) dies on a legacy-project scope
    // mismatch inside `requireSnapshotAuthority`. The production adapters convert that defect into
    // the honest degraded outcome (logged), and a bound envelope surfaces the drift signal so the
    // caller re-binds instead of the turn dying.
    const input: ProductionV2AdapterInput = {
      knowledge: {
        stores: [new DurableKnowledgeStore(tmpdirPath)],
        released: {
          snapshotId: "snap-bound",
          binding: "bound",
          current: () => Effect.die("released snapshot legacy project binding mismatch"),
        },
      },
    }
    const adapters = productionV2Adapters(input)
    const result = await Effect.runPromise(
      SessionContextResolverV2.resolveGraphs(
        envelope({ releasedKnowledge: { snapshotId: "snap-bound", binding: "bound" } }),
        adapters,
        100,
      ),
    )
    expect(result.graphStatuses.knowledge.status).toBe("degraded_unavailable")
    expect(result.graphStatuses.knowledge.reasonCode).toBe("released_snapshot_unavailable")
    expect(result.successorRebuild?.trigger).toBe("released_snapshot_drift")
  })
})

// ---------------------------------------------------------------------------
// canonical admission: drift is consumed (re-bind once) instead of being dropped
// ---------------------------------------------------------------------------

const database = Database.layerFromPath(":memory:")
const contexts = SessionContext.layer.pipe(
  Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
  Layer.provide(database),
)
const sessionID = SessionSchema.ID.make("ses_prod_drift")

const seed = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  // The bound selection row's authority trigger requires the v2:local identity chain + a REAL
  // released snapshot authority: an evaluation + snapshot rows under the v2:local scope,
  // generations matching the drift fixtures.
  yield* db
    .insert(SecurityNamespaceTable)
    .values({ id: "v2:local", kind: "implicit_local", binding_hash: Hash.sha256("v2:local"), created_at: 1 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(ProjectScopeIdentityTable)
    .values({
      security_namespace_id: "v2:local",
      project_scope_key: "v2:local",
      project_kind: "registered_root",
      project_identity_hash: Hash.sha256("v2:local:v2:local"),
      observed_project_id: "v2:local",
      created_at: 1,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(LocationIdentityTable)
    .values({
      security_namespace_id: "v2:local",
      location_key: "/project#",
      project_scope_key: "v2:local",
      canonical_root: "/project#",
      created_at: 1,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(ReleasedKnowledgeEvaluationTable)
    .values({
      evaluation_id: "eval_prod_drift",
      security_namespace_id: "v2:local",
      project_scope_key: "v2:local",
      matrix_hash: "a".repeat(64),
      matrix_json: "[]",
      document_manifest_json: "[]",
      baseline_ref: "baseline",
      repetitions: 1,
      evaluator_type: "system",
      evaluator_id: "test",
      created_at: 1,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(ReleasedKnowledgeSnapshotHeadTable)
    .values({ security_namespace_id: "v2:local", project_scope_key: "v2:local", snapshot_id: null, generation: 0, updated_at: 1 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(ReleasedKnowledgeSnapshotTable)
    .values({
      snapshot_id: "snap-1",
      security_namespace_id: "v2:local",
      project_scope_key: "v2:local",
      legacy_project_id: "v2:local",
      parent_snapshot_id: null,
      evaluation_id: "eval_prod_drift",
      release_kind: "legacy_baseline",
      document_count: 0,
      published_generation: 1,
      verdict: "passed",
      failure_reason: null,
      actor_type: "system",
      actor_id: "test",
      created_at: 1,
      finalized_at: null,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(ReleasedKnowledgeSnapshotTable)
    .set({ finalized_at: 2 })
    .where(eq(ReleasedKnowledgeSnapshotTable.snapshot_id, "snap-1"))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .update(ReleasedKnowledgeSnapshotHeadTable)
    .set({ snapshot_id: "snap-1", generation: 1, updated_at: 2 })
    .where(sql`${ReleasedKnowledgeSnapshotHeadTable.security_namespace_id} = 'v2:local' AND ${ReleasedKnowledgeSnapshotHeadTable.project_scope_key} = 'v2:local'`)
    .run()
    .pipe(Effect.orDie)
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, slug: "prod-drift", directory: "/project", title: "prod drift", version: "test" })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionInputTable)
    .values({ id: SessionMessage.ID.make("msg_prod_drift"), session_id: sessionID, admitted_seq: 1, prompt: new Prompt({ text: "trigger" }), delivery: "steer", promoted_seq: 1, time_created: 1 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("W3 canonical drift consumption (released_snapshot_drift)", () => {
  // L7 — deterministic scripted picker: the CURRENT host picker has no state, so a drift script is
  // an explicit snapshot sequence + a recorded call trace. No module-level counters are used (the
  // old implementation shared mutable `reboundCalls`/`persistentCalls` across tests and depended on
  // the exact internal call order), so the admission flow may reorder or repeat picker calls and
  // the tests still assert exactly what happened.
  function scriptedPicker(script: readonly DeepAgentReleasedSnapshot.Selection[]) {
    const calls: string[] = []
    return {
      calls,
      binding: {
        snapshotId: script[0]!.snapshotId,
        binding: "bound" as const,
        current: (): Effect.Effect<DeepAgentReleasedSnapshot.Selection | undefined, unknown> => {
          const value = script[Math.min(calls.length, script.length - 1)]
          calls.push(value.snapshotId)
          return Effect.succeed(value)
        },
      },
    }
  }

  const rebindIt = testEffect(Layer.mergeAll(database, contexts))
  const rebindScope = { securityNamespaceId: "v2:local", projectScopeKey: "v2:local", legacyProjectId: "v2:local" }
  const rebind = releasedPair(rebindScope)
  // Resolution per resolveOnce: bind (envelope) + knowledge + memory (GraphOrder); the drift path
  // re-resolves once, so exactly 6 picker calls: bind#1=stale, then 5× the released authority.
  const rebindScript = [rebind.selection, rebind.newer, rebind.newer, rebind.newer, rebind.newer, rebind.newer]

  rebindIt.effect("a release between bind and resolve re-binds and admits (signal is consumed, not dropped)", () => {
      const scripted = scriptedPicker(rebindScript)
      return Effect.gen(function* () {
        yield* seed
        const db = (yield* Database.Service).db
        const admission = yield* SessionRunnerCanonical.admitSelection({
          db,
          contexts: yield* SessionContext.Service,
          sessionID,
          agent: "build",
          location: { directory: "/project" },
          promotedInputIds: ["msg_prod_drift"],
          system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
          historyEndMessageId: "msg_prod_drift",
        })
        const row = yield* db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, admission.selectionId))
          .get()
          .pipe(Effect.orDie)
        const statuses = JSON.parse(row?.graph_statuses ?? "{}") as Record<string, { status: string }>
        // The rebind observed the post-release authority: knowledge is an empty released domain.
        expect(statuses.knowledge?.status).toBe("empty")
        expect(row?.released_knowledge_binding_state).toBe("bound")
        expect(row?.released_knowledge_snapshot_id).toBe(rebind.newer.snapshotId)
        // Deterministic call-trace assertion (L7): one bind + one knowledge + one memory per
        // resolve, twice — and the drift is consumed exactly once.
        expect(scripted.calls).toEqual([rebind.selection.snapshotId, ...rebindScript.slice(1).map((selection) => selection.snapshotId)])
        expect(scripted.calls).toHaveLength(rebindScript.length)
      }).pipe(
        Effect.provideService(ProductionV2Sources, {
          knowledge: {
            stores: [new DurableKnowledgeStore(tmpdirPath)],
            released: scripted.binding,
          },
        } as ProductionV2AdapterInput),
      )
    },
  )

  const persistentIt = testEffect(Layer.mergeAll(database, contexts))
  const persistent = releasedPair(rebindScope)
  // bind#1 = stale; knowledge#1 = current (drift); rebind#2 = current; knowledge#2 = snap-2 (drift
  // again) — the second resolution still signals, so the admission must fail with rebuild required.
  const persistentScript = [
    persistent.selection,
    persistent.newer,
    persistent.newer,
    persistent.newer,
    { ...persistent.newer, snapshotId: "snap-2", generation: 2 },
    { ...persistent.newer, snapshotId: "snap-2", generation: 2 },
  ]

  persistentIt.effect("a persistent drift fails the admission with selection_rebuild_required (turn rebuild signal, never silent)", () => {
      const scripted = scriptedPicker(persistentScript)
      return Effect.gen(function* () {
        yield* seed
        const db = (yield* Database.Service).db
        const outcome = yield* SessionRunnerCanonical.admitSelection({
          db,
          contexts: yield* SessionContext.Service,
          sessionID,
          agent: "build",
          location: { directory: "/project" },
          promotedInputIds: ["msg_prod_drift"],
          system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
          historyEndMessageId: "msg_prod_drift",
        }).pipe(Effect.catch((error) => Effect.succeed({ error })))
        expect(outcome).toMatchObject({ error: { _tag: "SessionRunnerCanonical.AdmissionError", reason: "selection_rebuild_required:released_snapshot_drift" } })
        expect(scripted.calls).toHaveLength(persistentScript.length)
        expect(scripted.calls[0]).toBe(persistent.selection.snapshotId)
        expect(scripted.calls[1]).toBe(persistent.newer.snapshotId)
        expect(scripted.calls[4]).toBe("snap-2")
      }).pipe(
        Effect.provideService(ProductionV2Sources, {
          knowledge: {
            stores: [new DurableKnowledgeStore(tmpdirPath)],
            released: scripted.binding,
          },
        } as ProductionV2AdapterInput),
      )
    },
  )
})

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Fresh DurableKnowledgeStore roots (user-global + project-shared) over the tmpdir, mirroring the
 * W7 production wiring (`<baseDir>/public/knowledge` + `<baseDir>/project/<pid>/knowledge`). */
function knowledgeFixtureRoots() {
  return {
    userGlobalStore: new DurableKnowledgeStore(tmpdirPath),
    projectStore: new DurableKnowledgeStore(tmpdirPath),
  }
}

function knowledgeFixture() {
  const { userGlobalStore, projectStore } = knowledgeFixtureRoots()
  const doc = projectStore.seedActive({
    type: "knowledge",
    description: "seed knowledge fact",
    body: "the seed knowledge body for the fixture",
    domain: null,
    tags: [],
    scope: "project-shared",
    projectId: "legacy-project",
    sensitivity: "public",
    risk: "low",
    confidence: { evidence_strength: "strong", support_count: 1 },
    provenance: { source: "runner", evidence_refs: [] },
  })
  const ref = DeepAgentReleasedSnapshot.documentRef(doc, "project")
  const selection: DeepAgentReleasedSnapshot.Selection = {
    securityNamespaceId: ns,
    projectScopeKey: proj,
    legacyProjectId: "legacy-project",
    snapshotId: "snap-released-1",
    parentSnapshotId: null,
    generation: 1,
    membershipHash: DeepAgentReleasedSnapshot.exactRefsFingerprint([ref]),
    manifestHash: "f".repeat(64),
    documents: [ref],
  }
  const released: ProductionReleasedBinding = {
    snapshotId: selection.snapshotId,
    binding: "bound",
    current: (): Effect.Effect<DeepAgentReleasedSnapshot.Selection | undefined, unknown> => Effect.succeed(selection),
  }
  return {
    selection,
    knowledgeInput: {
      stores: [userGlobalStore, projectStore],
      released,
    },
  }
}

function releasedPair(scope?: { readonly securityNamespaceId: string; readonly projectScopeKey: string; readonly legacyProjectId: string }) {
  const emptyDocs = [] as readonly DeepAgentReleasedSnapshot.DocumentRef[]
  const current: DeepAgentReleasedSnapshot.Selection = {
    securityNamespaceId: scope?.securityNamespaceId ?? ns,
    projectScopeKey: scope?.projectScopeKey ?? proj,
    legacyProjectId: scope?.legacyProjectId ?? "legacy-project",
    snapshotId: "snap-1",
    parentSnapshotId: null,
    generation: 1,
    membershipHash: DeepAgentReleasedSnapshot.exactRefsFingerprint(emptyDocs),
    manifestHash: "f".repeat(64),
    documents: emptyDocs,
  }
  // A stale bound snapshot (never persisted): the drift fixtures bind THIS at envelope build time,
  // while the CURRENT authority is `current` — only `current` may be written (it exists in the DB).
  const stale: DeepAgentReleasedSnapshot.Selection = { ...current, snapshotId: "snap-0", generation: 1 }
  return { selection: stale, newer: current }
}

function adapterInput(intent?: "definition" | "trace_evidence") {
  return {
    query: "seed",
    ...(intent === undefined ? {} : { intent }),
    now: 100,
    sessionId: "ses_prod",
    securityNamespaceId: ns,
    locationKey: loc,
    projectScopeKey: proj,
    legacyProjectId: "legacy-project",
    subjectId: "subject-prod",
    principal,
    egress,
  }
}
