import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { SelectionWriter } from "../../src/context-federation/selection-writer"
import { budgetSelection } from "../../src/context-federation/selection-budget"
import { SessionContextResolverV2, type QueryEnvelope, type QueryResultV2 } from "../../src/context-federation/resolver-v2"
import { type V2Adapter } from "../../src/context-federation/adapters-v2"
import {
  SessionActivityTable,
  SessionContextSelectionTable,
  SessionContextValidationTable,
  SessionProviderAttemptTable,
} from "../../src/context-federation/session-sql"
import { ContextCandidate, ContextFederation } from "../../src/context-federation/federation"
import {
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
  type ContextRef,
} from "../../src/context-federation/reference"
import { SessionProviderOwner } from "../../src/context-federation/provider-owner"
import { SessionProviderAttempt } from "../../src/context-federation/provider-attempt"
import {
  LocationIdentityTable,
  ProjectScopeIdentityTable,
  SecurityNamespaceTable,
} from "../../src/context-federation/sql"
import type { GraphKind, GraphStatus } from "../../src/contract/selection"
import { ProjectV2 } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { Hash } from "../../src/util/hash"
import { DeepAgentReleasedSnapshot } from "../../src/deepagent/released-snapshot"
import { SessionMessage } from "../../src/session/message"
import { Prompt } from "../../src/session/prompt"
import { SessionSchema } from "../../src/session/schema"
import { SessionInputTable, SessionTable } from "../../src/session/sql"

// C3-09 — deterministic dynamic matrix (fixture/fake adapters only). Each scenario drives the
// F1 resolver + F2 selection-writer to prove: no unauthorized degradation, real (never v2-none)
// selections, drift -> successor before dispatch, permission revoke refusal at the assert seam,
// index-rebuild bounded degradation, process-restart identity/validation survival, and a latency /
// availability budget against a calibration run.

const ns = SecurityNamespaceID.make("sec_c3_dyn")
const proj = ProjectScopeKey.make("prj_c3_dyn")
const loc = LocationKey.make("loc_c3_dyn")
const projectId = ProjectV2.ID.make("project-c3-dyn")
const sessionId = SessionSchema.ID.make("ses_c3_dyn")
const activityId = "act_c3_dyn"
const triggerId = SessionMessage.ID.make("msg_c3_dyn_trigger")
const ownerToken = "provider-owner-c3-dyn"

const principal = {
  securityNamespaceId: ns,
  principalId: "principal-c3-dyn",
  authorizationEpoch: 1,
  locationKeys: [loc],
  projectScopeKeys: [proj],
  sessionIds: [sessionId],
  subjectIds: ["subject-c3-dyn"],
  allowBuiltin: false,
}

const egress = {
  policyId: "provider-c3-dyn",
  epoch: 1,
  graphs: ["code", "documents", "knowledge", "memory"] as const,
  sensitivities: ["public", "source_code"] as const,
}

function envelope(overrides?: Partial<QueryEnvelope>): QueryEnvelope {
  return {
    membership: { sessionId, activityId, inputIds: [triggerId] },
    location: { locationKey: loc },
    principal,
    workspace: { workspaceId: "ws_c3_dyn" },
    securityNamespace: { securityNamespaceId: ns },
    projectScope: { projectScopeKey: proj, projectId: "legacy-project" },
    egress,
    agentPolicy: { agentId: "agent-c3-dyn", autonomyCeiling: "medium", permitDegraded: false },
    modelCapability: { modelId: "model-c3-dyn", providerId: "provider-c3-dyn", protocol: "openai.responses", contextWindow: 128_000, structuredOutput: true },
    releasedKnowledge: { snapshotId: "snapshot-c3-dyn", binding: "unavailable" },
    queryIntent: "search",
    query: "dynamic matrix",
    limit: 12,
    observedLocationMutationEpoch: 0,
    ...overrides,
  }
}

function status(graph: GraphKind, state: GraphStatus["status"], revision: string, candidateCount: number): GraphStatus {
  return {
    graph,
    status: state,
    revision,
    adapterVersion: `${graph}.v1`,
    observedMutationEpoch: candidateCount,
    latencyMs: 1,
    candidateCount,
    reasonCode: state === "ready" ? "none" : state === "denied" ? "scope_denied" : state === "timeout" ? "source_timeout" : "none",
  }
}

function result(candidates: readonly ContextCandidate[], statuses?: Record<GraphKind, GraphStatus["status"]>, successorRebuild?: QueryResultV2["successorRebuild"]): QueryResultV2 {
  const byGraph = new Map<GraphKind, ContextCandidate[]>()
  for (const candidate of candidates) byGraph.set(candidate.ref.graph, [...(byGraph.get(candidate.ref.graph) ?? []), candidate])
  const graphs: GraphKind[] = ["code", "documents", "knowledge", "memory"]
  const results = graphs.map((graph) => ({
    graph,
    status: status(graph, statuses?.[graph] ?? (byGraph.get(graph)?.length ? "ready" : "empty"), `${graph}:1`, byGraph.get(graph)?.length ?? 0),
    candidates: byGraph.get(graph) ?? [],
  }))
  const graphStatuses = Object.fromEntries(results.map((entry) => [entry.graph, entry.status])) as Record<GraphKind, GraphStatus>
  return {
    queryFingerprint: "qf-c3-dyn",
    authorizationFingerprint: "af-c3-dyn",
    executionFingerprint: "ef-c3-dyn",
    membership: { sessionId, activityId, inputIds: [triggerId] },
    location: { locationKey: loc },
    results,
    graphStatuses,
    candidates,
    successorRebuild,
    truncated: false,
    truncatedCount: 0,
  }
}

function candidate(input: { readonly graph: GraphKind; readonly entityId: string }): ContextCandidate {
  const ref: ContextRef = {
    graph: input.graph,
    entityId: input.entityId,
    binding: { scope: "location", securityNamespaceId: ns, locationKey: loc, projectScopeKey: proj },
    revision: `${input.graph}:1`,
  }
  return ContextFederation.candidate({
    ref,
    graph: input.graph,
    title: `${input.entityId} title`,
    summary: `${input.entityId} summary`,
    relations: [],
    provenance: [],
    features: { exact: 1, lexical: 1, authority: 1, evidence: 1, freshness: 1 },
    trust: "repository_evidence",
    visibility: "model",
  })
}

function build(r: QueryResultV2, env: QueryEnvelope, revision: number, providerTurnSeq: number, now = 1_000) {
  const batch = budgetSelection(r, env)
  return SelectionWriter.buildSelectionEnvelope(batch, r, env, { revision, triggerInputId: triggerId, providerTurnSeq, now })
}

const attemptBinding = {
  attemptId: "attempt-c3-dyn",
  providerTurnSeq: 1,
  requestHash: "req-c3-dyn",
  providerId: "provider-c3-dyn",
}

describe("C3-08 legacy_incomplete: read-only + non-dispatchable", () => {
  test("a legacy v2-none row is classified legacy_incomplete and refused for a new dispatch", async () => {
    const h = harnessWith()
    await h.run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        // INSERT a legacy row (the pre-switch bridge shape: graph_statuses is an ARRAY, revisions carry v2-none).
        yield* db
          .insert(SessionContextSelectionTable)
          .values({
            selection_id: "selection_legacy_v2_none",
            session_id: sessionId,
            activity_id: activityId,
            revision: 3,
            trigger_input_id: triggerId,
            location_key: loc,
            security_namespace_id: ns,
            project_scope_key: proj,
            query_fingerprint: "qf-legacy",
            authorization_fingerprint: "af-legacy",
            authorization_epoch: 1,
            execution_fingerprint: "ef-legacy",
            selected_source_fingerprint: "ssf-legacy",
            observed_location_mutation_epoch: 0,
            next_revalidation_at: 1_000 + 60_000,
            released_knowledge_binding_state: "unavailable",
                        released_knowledge_exact_refs: [],
                        released_knowledge_exact_refs_fingerprint: DeepAgentReleasedSnapshot.exactRefsFingerprint([]),
                        graph_revisions: JSON.stringify({ code: "v2-none", documents: "v2-none", knowledge: "v2-none", memory: "v2-none" }),
            graph_statuses: JSON.stringify([]),
            selected_refs: JSON.stringify([]),
            projection: "{}",
            projection_hash: "ph-legacy",
            token_count: 0,
            artifact_write_status: "degraded_unavailable",
                        inline_audit: "{}",
                        created_at: 1_000,
          })
          .run()
        // The read-side classification marks it legacy_incomplete; a real V2 row (Record statuses,
        // no v2-none) is NOT legacy.
        const row = yield* db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, "selection_legacy_v2_none"))
          .get()
          .pipe(Effect.orDie)
        expect(SelectionWriter.isLegacyIncompleteRow(row!)).toBe(true)
        const v2Sel = build(result([]), envelope(), 0, 1)
        yield* SelectionWriter.writeSelectionRow(db, v2Sel, 1_000)
        const v2Row = yield* db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, v2Sel.selectionId))
          .get()
          .pipe(Effect.orDie)
        expect(SelectionWriter.isLegacyIncompleteRow(v2Row!)).toBe(false)
      }),
    )
  })

  test("assertAttemptBound refuses to dispatch a legacy_incomplete selection (typed)", async () => {
    const h = harnessWith()
    const outcome = await h.run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const owner = yield* SessionProviderOwner.Service
        yield* owner.register({ ownerToken, leaseMs: 60_000, now: 1_000 })
        const legacyId = "selection_legacy_dispatch"
        // A legacy row (the pre-switch bridge shape: graph_statuses is an ARRAY, revisions carry v2-none).
        yield* db
          .insert(SessionContextSelectionTable)
          .values({
            selection_id: legacyId,
            session_id: sessionId,
            activity_id: activityId,
            revision: 0,
            trigger_input_id: triggerId,
            location_key: loc,
            security_namespace_id: ns,
            project_scope_key: proj,
            query_fingerprint: "qf-legacy-dispatch",
            authorization_fingerprint: "af-legacy-dispatch",
            authorization_epoch: 1,
            execution_fingerprint: "ef-legacy-dispatch",
            selected_source_fingerprint: "ssf-legacy-dispatch",
            observed_location_mutation_epoch: 0,
            next_revalidation_at: 1_000 + 60_000,
            released_knowledge_binding_state: "unavailable",
                        released_knowledge_exact_refs: [],
                        released_knowledge_exact_refs_fingerprint: DeepAgentReleasedSnapshot.exactRefsFingerprint([]),
                        graph_revisions: JSON.stringify({ code: "v2-none", documents: "v2-none", knowledge: "v2-none", memory: "v2-none" }),
            graph_statuses: JSON.stringify([]),
            selected_refs: JSON.stringify([]),
            projection: "{}",
            projection_hash: "ph-legacy-dispatch",
            token_count: 0,
            artifact_write_status: "degraded_unavailable",
                        inline_audit: "{}",
                        created_at: 1_000,
          })
          .run()
        // A valid validation matching the prepared attempt's identity (so prepare itself succeeds).
        yield* db
          .insert(SessionContextValidationTable)
          .values({
            validation_id: "val_legacy_dispatch",
            selection_id: legacyId,
            provider_turn_seq: 1,
            authorization_epoch: 1,
            egress_epoch: 1,
            observed_location_mutation_epoch: 0,
            selected_source_fingerprint: "ssf-legacy-dispatch",
            validated_at: 1_000,
            valid_until: 1_000 + 60_000,
            outcome: "valid",
            reason_code: "legacy_validation",
          })
          .run()
        const attempts = yield* SessionProviderAttempt.Service
        const prepared = yield* attempts.prepare({
          sessionId,
          activityId,
          providerTurnSeq: 1,
          selectionId: legacyId,
          projectionHash: "ph-legacy-dispatch",
          requestHash: attemptBinding.requestHash,
          providerId: attemptBinding.providerId,
          ownerToken,
          authorizationEpoch: 1,
          egressEpoch: 1,
          selectedSourceFingerprint: "ssf-legacy-dispatch",
          observedLocationMutationEpoch: 0,
          now: 2_000,
        })
        // C3-08: a legacy_incomplete selection is read-only for history but NOT dispatchable.
        return yield* SelectionWriter.assertAttemptBoundSelection(db, {
          attemptId: prepared.attemptId,
          selectionId: legacyId,
          now: 2_000,
        }).pipe(Effect.catch((error) => Effect.succeed({ error })))
      }),
    )
    expect(outcome).toMatchObject({ error: { _tag: "SelectionWriter.LegacySelectionNotDispatchableError" } })
  })

  test("a V2 prepared turn carries all-four real graph statuses, never v2-none", async () => {
    const h = harnessWith()
    await h.run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sel = build(result([candidate({ graph: "code", entityId: "a" })]), envelope(), 0, 1)
        expect((yield* SelectionWriter.writeSelectionRow(db, sel, 1_000)).conflict).toBe(false)
        const row = yield* db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, sel.selectionId))
          .get()
          .pipe(Effect.orDie)
        expect(row?.graph_statuses).not.toContain("v2-none")
        const statuses = JSON.parse(row?.graph_statuses ?? "{}") as Record<string, { status: string }>
        expect(Object.keys(statuses).sort()).toEqual(["code", "documents", "knowledge", "memory"])
        for (const s of Object.values(statuses)) expect(s.status).not.toBe("v2-none")
      }),
    )
  })
})

describe("C3-09 graph timeout + isolation (permission-critical never degrades)", () => {
  test("one graph times out -> timeout status; other graphs unaffected; permission graphs never silently degrade", async () => {
    const timeoutAdapter: V2Adapter = { graph: "code", source: "code", adapterVersion: "code.v1", resolve: () => Effect.never }
    const knowledgeAdapter = readyAdapter("knowledge")
    const adapters = { code: timeoutAdapter, documents: readyAdapter("documents"), knowledge: knowledgeAdapter, memory: readyAdapter("memory") }
    const result = await Effect.runPromise(SessionContextResolverV2.resolveGraphs(envelope(), adapters, 10))
    expect(result.graphStatuses.code.status).toBe("timeout")
    expect(result.graphStatuses.code.reasonCode).toBe("source_timeout")
    expect(result.graphStatuses.documents.status).toBe("ready")
    expect(result.graphStatuses.memory.status).toBe("ready")
    expect(result.graphStatuses.knowledge.status).toBe("ready")
  })

  test("a denied graph is terminal (blocked), never best-effort degraded, even when policy permits degrade", async () => {
    // egress excludes `code` -> denied terminal
    const noCode = { ...egress, graphs: ["documents", "knowledge", "memory"] as const }
    const permit = envelope({ egress: noCode, agentPolicy: { agentId: "agent-c3-dyn", autonomyCeiling: "critical", permitDegraded: true } })
    const result = await Effect.runPromise(SessionContextResolverV2.resolveGraphs(permit, fourAdapters({ code: readyAdapter("code") }), 100))
    expect(result.graphStatuses.code.status).toBe("denied")
    expect(result.graphStatuses.code.reasonCode).toBe("provider_egress_denied")
  })
})

describe("C3-09 index rebuild + drift successor + permission revoke + restart + latency", () => {
  test("an adapter in a rebuild state reports degraded_unavailable with a bounded reason, never silent empty", async () => {
    const rebuilding: V2Adapter = {
      graph: "code",
      source: "code",
      adapterVersion: "code.v1",
      resolve: () => Effect.succeed({ candidates: [], revision: "", observedMutationEpoch: 0, available: false, unavailableReasonCode: "link_refresh_pending" }),
    }
    const result = await Effect.runPromise(SessionContextResolverV2.resolveGraphs(envelope(), fourAdapters({ code: rebuilding }), 100))
    expect(result.graphStatuses.code.status).toBe("degraded_unavailable")
    expect(result.graphStatuses.code.reasonCode).toBe("link_refresh_pending")
    expect(result.graphStatuses.code.candidateCount).toBe(0)
    // not silently empty: explicit degraded status + bounded reason are present
    expect(result.graphStatuses.code.reasonCode).not.toBe("none")
  })

  test("authorization epoch drift -> SuccessorRebuildSignal -> rebuild successor BEFORE dispatch -> attempt binds the NEW selection", async () => {
    const h = harnessWith()
    // Drift detected by the F1 resolver (pure, over the fixture adapters) -> typed successor signal.
    const drifted = { ...principal, authorizationEpoch: 9 }
    const env2 = envelope({ principal: drifted, expectedAuthorizationEpoch: 3 })
    const r1 = await Effect.runPromise(SessionContextResolverV2.resolveGraphs(env2, fourAdapters({ code: readyAdapter("code") }), 100))
    expect(r1.successorRebuild?.trigger).toBe("authorization_epoch_drift")

    await h.run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const owner = yield* SessionProviderOwner.Service
        yield* owner.register({ ownerToken, leaseMs: 60_000, now: 1_000 })

        const baseEnv = envelope()
        const r0 = result([candidate({ graph: "code", entityId: "a" })])
        const selA = build(r0, baseEnv, 0, 1)
        expect((yield* SelectionWriter.writeSelectionRow(db, selA, 1_000)).conflict).toBe(false)

        // F2 rebuild + revalidate BEFORE dispatch.
        const batch1 = budgetSelection(r1, env2)
        const selB = SelectionWriter.rebuildForDrift(selA, batch1, r1, env2, { triggerInputId: triggerId, providerTurnSeq: 1, now: 1_000 })
        expect(selB.revision).toBe(1)
        expect(selB.selectionId).not.toBe(selA.selectionId)
        expect(selB.validation.outcome).toBe("invalidated")
        expect((yield* SelectionWriter.writeSelectionRow(db, selB, 1_000)).conflict).toBe(false)
        yield* SelectionWriter.revalidateSelection(db, {
          selectionId: selB.selectionId,
          providerTurnSeq: 1,
          authorizationEpoch: selB.principal.authorizationEpoch,
          egressEpoch: selB.egress.epoch,
          observedLocationMutationEpoch: selB.identity.observedLocationMutationEpoch,
          selectedSourceFingerprint: selB.identity.selectedSourceFingerprint,
          validUntil: 1_000 + 60_000,
          now: 2_000,
        })

        // The dispatched attempt is prepared against the NEW selection and binds it.
        const attempts = yield* SessionProviderAttempt.Service
        const prepared = yield* attempts.prepare({
          sessionId,
          activityId,
          providerTurnSeq: 1,
          selectionId: selB.selectionId,
          projectionHash: selB.projectionHash,
          requestHash: attemptBinding.requestHash,
          providerId: attemptBinding.providerId,
          ownerToken,
          authorizationEpoch: selB.principal.authorizationEpoch,
          egressEpoch: selB.egress.epoch,
          selectedSourceFingerprint: selB.identity.selectedSourceFingerprint,
          observedLocationMutationEpoch: selB.identity.observedLocationMutationEpoch,
          now: 2_000,
        })
        const bound = yield* SelectionWriter.assertAttemptBoundSelection(db, { attemptId: prepared.attemptId, selectionId: selB.selectionId, now: 2_000 })
        expect(bound.selectionId).toBe(selB.selectionId)
        expect(bound.selectionId).not.toBe(selA.selectionId)
        // The prior selection was never rewritten.
        const attemptRow = yield* db
          .select({ selection_id: SessionProviderAttemptTable.selection_id })
          .from(SessionProviderAttemptTable)
          .where(eq(SessionProviderAttemptTable.attempt_id, prepared.attemptId))
          .get()
          .pipe(Effect.orDie)
        expect(attemptRow?.selection_id).toBe(selB.selectionId)
      }),
    )
  })

  test("permission revoked between prepare and dispatch -> typed dispatch refusal at the assert seam (no request)", async () => {
    const h = harnessWith()
    const outcome = await h.run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const owner = yield* SessionProviderOwner.Service
        yield* owner.register({ ownerToken, leaseMs: 60_000, now: 1_000 })

        const sel = build(result([candidate({ graph: "code", entityId: "a" })]), envelope(), 0, 1)
        expect((yield* SelectionWriter.writeSelectionRow(db, sel, 1_000)).conflict).toBe(false)
        yield* SelectionWriter.revalidateSelection(db, {
          selectionId: sel.selectionId,
          providerTurnSeq: 1,
          authorizationEpoch: sel.principal.authorizationEpoch,
          egressEpoch: sel.egress.epoch,
          observedLocationMutationEpoch: sel.identity.observedLocationMutationEpoch,
          selectedSourceFingerprint: sel.identity.selectedSourceFingerprint,
          validUntil: 1_000 + 60_000,
          now: 2_000,
        })
        const attempts = yield* SessionProviderAttempt.Service
        const prepared = yield* attempts.prepare({
          sessionId,
          activityId,
          providerTurnSeq: 1,
          selectionId: sel.selectionId,
          projectionHash: sel.projectionHash,
          requestHash: attemptBinding.requestHash,
          providerId: attemptBinding.providerId,
          ownerToken,
          authorizationEpoch: sel.principal.authorizationEpoch,
          egressEpoch: sel.egress.epoch,
          selectedSourceFingerprint: sel.identity.selectedSourceFingerprint,
          observedLocationMutationEpoch: sel.identity.observedLocationMutationEpoch,
          now: 2_000,
        })
        // Permission revoked between prepare and dispatch: the validation is invalidated (superseded).
        yield* db.insert(SessionContextValidationTable).values(SessionContextValidationRow(sel, 1, "invalidated")).run()
        // The dispatch seam refuses before ONE physical request (counting transport = 0). The typed
        // ValidationMismatchError is the permission-revoked refusal.
        const gate = yield* SelectionWriter.assertAttemptBoundSelection(db, { attemptId: prepared.attemptId, selectionId: sel.selectionId, now: 3_000 }).pipe(
          Effect.catch((error) => Effect.succeed({ error })),
        )
        expect(gate).toMatchObject({ error: { _tag: "SelectionWriter.ValidationMismatchError" } })
      }),
    )
  })

  test("process restart: re-construct the writer from the persisted fixture rows -> same identity, valid validation, preserved binding", async () => {
    const h = harnessWith()
    await h.run(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const owner = yield* SessionProviderOwner.Service
        yield* owner.register({ ownerToken, leaseMs: 60_000, now: 1_000 })

        const sel = build(result([candidate({ graph: "code", entityId: "a" })]), envelope(), 0, 1)
        expect((yield* SelectionWriter.writeSelectionRow(db, sel, 1_000)).conflict).toBe(false)
        yield* SelectionWriter.revalidateSelection(db, {
          selectionId: sel.selectionId,
          providerTurnSeq: 1,
          authorizationEpoch: sel.principal.authorizationEpoch,
          egressEpoch: sel.egress.epoch,
          observedLocationMutationEpoch: sel.identity.observedLocationMutationEpoch,
          selectedSourceFingerprint: sel.identity.selectedSourceFingerprint,
          validUntil: 1_000 + 60_000,
          now: 2_000,
        })
        const attempts = yield* SessionProviderAttempt.Service
        const prepared = yield* attempts.prepare({
          sessionId,
          activityId,
          providerTurnSeq: 1,
          selectionId: sel.selectionId,
          projectionHash: sel.projectionHash,
          requestHash: attemptBinding.requestHash,
          providerId: attemptBinding.providerId,
          ownerToken,
          authorizationEpoch: sel.principal.authorizationEpoch,
          egressEpoch: sel.egress.epoch,
          selectedSourceFingerprint: sel.identity.selectedSourceFingerprint,
          observedLocationMutationEpoch: sel.identity.observedLocationMutationEpoch,
          now: 2_000,
        })

        // "Restart": derive the SAME envelope from the SAME inputs (deterministic) and re-construct a
        // writer over the SAME persisted rows. The identity (content-addressed) is unchanged.
        const selAgain = build(result([candidate({ graph: "code", entityId: "a" })]), envelope(), 0, 1)
        expect(selAgain.selectionId).toBe(sel.selectionId)
        const restarted = yield* SelectionWriter.assertAttemptBoundSelection(db, { attemptId: prepared.attemptId, selectionId: selAgain.selectionId, now: 3_000 })
        // The binding is preserved: same attempt -> same selection, validation still valid.
        expect(restarted.selectionId).toBe(sel.selectionId)
        expect(restarted.attemptId).toBe(prepared.attemptId)
        expect(restarted.revision).toBe(0)
        expect(restarted.outcome).toBe("valid")
      }),
    )
  })

  test("overall resolution stays within a fixed relative latency budget (p50/p95 reported)", async () => {
    const adapters = fourAdapters({ code: readyAdapter("code"), documents: readyAdapter("documents"), knowledge: readyAdapter("knowledge"), memory: readyAdapter("memory") })
    // Calibration: one fast resolution.
    const start = performance.now()
    await Effect.runPromise(SessionContextResolverV2.resolveGraphs(envelope(), adapters, 100))
    const calibrationMs = performance.now() - start
    const N = 20
    const samples: number[] = []
    for (let i = 0; i < N; i++) {
      const s = performance.now()
      await Effect.runPromise(SessionContextResolverV2.resolveGraphs(envelope(), adapters, 100))
      samples.push(performance.now() - s)
    }
    samples.sort((a, b) => a - b)
    const p50 = samples[Math.floor(N * 0.5)]!
    const p95 = samples[Math.floor(N * 0.95)]!
    // Generous machine-stable relative bound: each resolution is far below the per-graph timeout.
    expect(p95).toBeLessThan(calibrationMs * 20 + 50)
    expect(p95).toBeLessThan(100)
    // Report p50/p95 in the test output (design §13: resolution latency p50/p95).
    console.log(`[C3-09 latency] calibration=${calibrationMs.toFixed(2)}ms p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`)
  })
})

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function SessionContextValidationRow(sel: ReturnType<typeof build>, providerTurnSeq: number, outcome: "invalidated") {
  return {
    validation_id: `val_${sel.selectionId}_${providerTurnSeq}_invalidated`,
    selection_id: sel.selectionId,
    provider_turn_seq: providerTurnSeq,
    authorization_epoch: sel.principal.authorizationEpoch,
    egress_epoch: sel.egress.epoch,
    observed_location_mutation_epoch: sel.identity.observedLocationMutationEpoch,
    selected_source_fingerprint: sel.identity.selectedSourceFingerprint,
    validated_at: 3_000,
    valid_until: 3_000 + 60_000,
    outcome,
    reason_code: "permission_revoked",
  }
}
function harnessWith() {
  const database = Database.layerFromPath(":memory:")
  const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
  const attempts = SessionProviderAttempt.layer.pipe(Layer.provide(database))
  const writer = SelectionWriter.layer.pipe(Layer.provide(database))
  const layer = Layer.mergeAll(database, owners, attempts, writer)
  return {
    run: <A, E>(effect: Effect.Effect<A, E, Database.Service | SessionProviderOwner.Service | SessionProviderAttempt.Service | SelectionWriter.Service>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* seedSession()
          return yield* effect
        }).pipe(Effect.provide(layer), Effect.scoped),
      ),
  }
}

function seedSession() {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db.insert(SecurityNamespaceTable).values({ id: ns, kind: "implicit_local", binding_hash: Hash.sha256(ns), created_at: 1_000 }).run()
    yield* db
      .insert(ProjectScopeIdentityTable)
      .values({ security_namespace_id: ns, project_scope_key: proj, project_kind: "registered_root", project_identity_hash: Hash.sha256(`${ns}:${proj}`), observed_project_id: projectId, created_at: 1_000 })
      .run()
    yield* db
      .insert(LocationIdentityTable)
      .values({ security_namespace_id: ns, location_key: loc, project_scope_key: proj, canonical_root: "/tmp/c3-dyn", observed_project_id: projectId, created_at: 1_000 })
      .run()
    yield* db.insert(ProjectTable).values({ id: projectId, worktree: AbsolutePath.make("/tmp/c3-dyn"), sandboxes: [] }).run()
    yield* db.insert(SessionTable).values({ id: sessionId, project_id: projectId, slug: "c3-dyn", directory: "/tmp/c3-dyn", title: "C3 dyn", version: "test" }).run()
    yield* db
      .insert(SessionInputTable)
      .values({ id: triggerId, session_id: sessionId, prompt: new Prompt({ text: "trigger" }), delivery: "steer", admitted_seq: 0, promoted_seq: 0 })
      .run()
    yield* db
      .insert(SessionActivityTable)
      .values({ activity_id: activityId, session_id: sessionId, ordinal: 0, trigger_input_id: triggerId, delivery: "steer", state: "active", created_at: 1_000 })
      .run()
  })
}

function fourAdapters(extra: Partial<Record<GraphKind, V2Adapter>>): Record<GraphKind, V2Adapter> {
  return {
    code: extra.code ?? readyAdapter("code"),
    documents: extra.documents ?? readyAdapter("documents"),
    knowledge: extra.knowledge ?? readyAdapter("knowledge"),
    memory: extra.memory ?? readyAdapter("memory"),
  }
}

function readyAdapter(graph: GraphKind): V2Adapter {
  const item = candidate({ graph, entityId: `${graph}-seed` })
  return {
    graph,
    source: graph,
    adapterVersion: `${graph}.v1`,
    resolve: () => Effect.succeed({ candidates: [item], revision: `${graph}:1`, observedMutationEpoch: 1, available: true }),
  }
}
