import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { SelectionWriter } from "../../src/context-federation/selection-writer"
import { AdvanceSelection } from "../../src/context-federation/advance-selection"
import { budgetSelection } from "../../src/context-federation/selection-budget"
import { Hash } from "../../src/util/hash"
import { type QueryEnvelope, type QueryResultV2 } from "../../src/context-federation/resolver-v2"
import {
  SessionActivityTable,
  SessionContextSelectionTable,
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
import type { GraphKind, GraphStatus, SelectionRef } from "../../src/contract/selection"
import { ProjectV2 } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { SessionMessage } from "../../src/session/message"
import { Prompt } from "../../src/session/prompt"
import { SessionSchema } from "../../src/session/schema"
import { SessionInputTable, SessionTable } from "../../src/session/sql"

const ns = SecurityNamespaceID.make("sec_advance_test")
const proj = ProjectScopeKey.make("prj_advance_test")
const loc = LocationKey.make("loc_advance_test")
const projectId = ProjectV2.ID.make("project-advance-test")
const sessionId = SessionSchema.ID.make("ses_advance_test")
const activityId = "act_advance_test"
const triggerId = SessionMessage.ID.make("msg_advance_trigger")
const ownerToken = "provider-owner-advance-test"

const principal = {
  securityNamespaceId: ns,
  principalId: "principal-advance",
  authorizationEpoch: 1,
  locationKeys: [loc],
  projectScopeKeys: [proj],
  sessionIds: [sessionId],
  subjectIds: ["subject-advance"],
  allowBuiltin: false,
}

const egress = {
  policyId: "provider-advance",
  epoch: 1,
  graphs: ["code", "documents", "knowledge", "memory"] as const,
  sensitivities: ["public", "source_code"] as const,
}

function envelope(overrides?: Partial<QueryEnvelope>): QueryEnvelope {
  return {
    membership: { sessionId, activityId, inputIds: [triggerId] },
    location: { locationKey: loc },
    principal,
    workspace: { workspaceId: "ws_advance" },
    securityNamespace: { securityNamespaceId: ns },
    projectScope: { projectScopeKey: proj, projectId: "legacy-project" },
    egress,
    agentPolicy: { agentId: "agent-advance", autonomyCeiling: "medium", permitDegraded: false },
    modelCapability: {
      modelId: "model-advance",
      providerId: "provider-advance",
      protocol: "openai.responses",
      contextWindow: 128_000,
      structuredOutput: true,
    },
    releasedKnowledge: { snapshotId: "snapshot-advance", binding: "unavailable" },
    queryIntent: "search",
    query: "advance the selection",
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
    reasonCode: state === "ready" ? "none" : state === "denied" ? "scope_denied" : "none",
  }
}

function result(candidates: readonly ContextCandidate[]): QueryResultV2 {
  const byGraph = new Map<GraphKind, ContextCandidate[]>()
  for (const candidate of candidates) {
    const list = byGraph.get(candidate.ref.graph) ?? []
    list.push(candidate)
    byGraph.set(candidate.ref.graph, list)
  }
  const graphs: GraphKind[] = ["code", "documents", "knowledge", "memory"]
  const results = graphs.map((graph) => ({
    graph,
    status: status(graph, byGraph.get(graph)?.length ? "ready" : "empty", `${graph}:1`, byGraph.get(graph)?.length ?? 0),
    candidates: byGraph.get(graph) ?? [],
  }))
  const graphStatuses = Object.fromEntries(results.map((entry) => [entry.graph, entry.status])) as Record<GraphKind, GraphStatus>
  return {
    queryFingerprint: "qf-advance",
    authorizationFingerprint: "af-advance",
    executionFingerprint: "ef-advance",
    membership: { sessionId, activityId, inputIds: [triggerId] },
    location: { locationKey: loc },
    results,
    graphStatuses,
    candidates,
    successorRebuild: undefined,
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

function build(r: QueryResultV2, env: QueryEnvelope, revision: number, providerTurnSeq: number) {
  const batch = budgetSelection(r, env)
  return SelectionWriter.buildSelectionEnvelope(batch, r, env, { revision, triggerInputId: triggerId, providerTurnSeq, now: 1_000 })
}

const attempt = {
  attemptId: "attempt-advance",
  providerTurnSeq: 1,
  requestHash: "req-advance",
  providerId: "provider-advance",
}

const evidence: SelectionRef = {
  graph: "knowledge",
  ref: "tool-result:evidence-1",
  token: "tool evidence 1",
  score: 0.9,
  freshness: "current",
  sensitivity: "public",
  reason: "tool_result_evidence",
}

function harnessWith() {
  const database = Database.layerFromPath(":memory:")
  const owners = SessionProviderOwner.layer.pipe(Layer.provide(database))
  const attempts = SessionProviderAttempt.layer.pipe(Layer.provide(database))
  const writer = SelectionWriter.layer.pipe(Layer.provide(database))
  const advance = AdvanceSelection.layer.pipe(Layer.provide(database)).pipe(Layer.provide(writer))
  const layer = Layer.mergeAll(database, owners, attempts, writer, advance)
  return {
    run: <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | Database.Service
        | SessionProviderOwner.Service
        | SessionProviderAttempt.Service
        | SelectionWriter.Service
        | AdvanceSelection.Service
      >,
    ) =>
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
      .values({
        security_namespace_id: ns,
        project_scope_key: proj,
        project_kind: "registered_root",
        project_identity_hash: Hash.sha256(`${ns}:${proj}`),
        observed_project_id: projectId,
        created_at: 1_000,
      })
      .run()
    yield* db
      .insert(LocationIdentityTable)
      .values({
        security_namespace_id: ns,
        location_key: loc,
        project_scope_key: proj,
        canonical_root: "/tmp/advance-test",
        observed_project_id: projectId,
        created_at: 1_000,
      })
      .run()
    yield* db.insert(ProjectTable).values({ id: projectId, worktree: AbsolutePath.make("/tmp/advance-test"), sandboxes: [] }).run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionId, project_id: projectId, slug: "advance-test", directory: "/tmp/advance-test", title: "Advance test", version: "test" })
      .run()
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

describe("AdvanceSelection (C3-06b: next-revision feed from tool results)", () => {
  test("advances to revision+1 and leaves the dispatched attempt.selection_id unchanged", async () => {
    const harness = harnessWith()
    await harness.run(
      Effect.gen(function* () {
        const writer = yield* SelectionWriter.Service
        const owner = yield* SessionProviderOwner.Service
        yield* owner.register({ ownerToken, leaseMs: 60_000, now: 1_000 })

        const sel = build(result([candidate({ graph: "code", entityId: "a" })]), envelope(), 0, 1)
        expect((yield* writer.write({ envelope: sel, attempt, now: 1_000 })).kind).toBe("written")
        const prepared = yield* (yield* SessionProviderAttempt.Service).prepare({
          sessionId,
          activityId,
          providerTurnSeq: 1,
          selectionId: sel.selectionId,
          projectionHash: sel.projectionHash,
          requestHash: attempt.requestHash,
          providerId: attempt.providerId,
          ownerToken,
          authorizationEpoch: sel.principal.authorizationEpoch,
          egressEpoch: sel.egress.epoch,
          selectedSourceFingerprint: sel.identity.selectedSourceFingerprint,
          observedLocationMutationEpoch: sel.identity.observedLocationMutationEpoch,
          now: 1_000,
        })

        const advance = yield* AdvanceSelection.Service
        const out = yield* advance.advanceSelectionAfterToolResults({
          attemptId: prepared.attemptId,
          selectionId: sel.selectionId,
          toolEvidence: [evidence],
          now: 2_000,
        })
        expect(out.revision).toBe(1)
        expect(out.selectionId).not.toBe(sel.selectionId)
        expect(out.attemptSelectionId).toBe(sel.selectionId)

        const db = (yield* Database.Service).db
        const attemptRow = yield* db
          .select({ selection_id: SessionProviderAttemptTable.selection_id })
          .from(SessionProviderAttemptTable)
          .where(eq(SessionProviderAttemptTable.attempt_id, prepared.attemptId))
          .get()
          .pipe(Effect.orDie)
        expect(attemptRow?.selection_id).toBe(sel.selectionId)
        const newRow = yield* db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, out.selectionId))
          .get()
          .pipe(Effect.orDie)
        expect(newRow?.revision).toBe(1)
      }),
    )
  })

  test("assertAttemptBound refuses binding the new selection to the OLD attempt", async () => {
    const harness = harnessWith()
    const refused = await harness.run(
      Effect.gen(function* () {
        const writer = yield* SelectionWriter.Service
        const owner = yield* SessionProviderOwner.Service
        yield* owner.register({ ownerToken, leaseMs: 60_000, now: 1_000 })

        const sel = build(result([candidate({ graph: "code", entityId: "a" })]), envelope(), 0, 1)
        yield* writer.write({ envelope: sel, attempt, now: 1_000 })
        const prepared = yield* (yield* SessionProviderAttempt.Service).prepare({
          sessionId,
          activityId,
          providerTurnSeq: 1,
          selectionId: sel.selectionId,
          projectionHash: sel.projectionHash,
          requestHash: attempt.requestHash,
          providerId: attempt.providerId,
          ownerToken,
          authorizationEpoch: sel.principal.authorizationEpoch,
          egressEpoch: sel.egress.epoch,
          selectedSourceFingerprint: sel.identity.selectedSourceFingerprint,
          observedLocationMutationEpoch: sel.identity.observedLocationMutationEpoch,
          now: 1_000,
        })

        const advance = yield* AdvanceSelection.Service
        const out = yield* advance.advanceSelectionAfterToolResults({
          attemptId: prepared.attemptId,
          selectionId: sel.selectionId,
          toolEvidence: [evidence],
          now: 2_000,
        })
        return yield* writer
          .assertAttemptBound({ attemptId: prepared.attemptId, selectionId: out.selectionId, now: 2_000 })
          .pipe(Effect.catch((error) => Effect.succeed({ error })))
      }),
    )
    expect(refused).toMatchObject({ error: { _tag: "SelectionWriter.RequiredAttemptFkError" } })
  })

  test("the successor carries the tool results as new evidence at revision+1", async () => {
    const harness = harnessWith()
    await harness.run(
      Effect.gen(function* () {
        const writer = yield* SelectionWriter.Service
        const owner = yield* SessionProviderOwner.Service
        yield* owner.register({ ownerToken, leaseMs: 60_000, now: 1_000 })

        const sel = build(result([candidate({ graph: "code", entityId: "a" })]), envelope(), 0, 1)
        yield* writer.write({ envelope: sel, attempt, now: 1_000 })
        const prepared = yield* (yield* SessionProviderAttempt.Service).prepare({
          sessionId,
          activityId,
          providerTurnSeq: 1,
          selectionId: sel.selectionId,
          projectionHash: sel.projectionHash,
          requestHash: attempt.requestHash,
          providerId: attempt.providerId,
          ownerToken,
          authorizationEpoch: sel.principal.authorizationEpoch,
          egressEpoch: sel.egress.epoch,
          selectedSourceFingerprint: sel.identity.selectedSourceFingerprint,
          observedLocationMutationEpoch: sel.identity.observedLocationMutationEpoch,
          now: 1_000,
        })

        const advance = yield* AdvanceSelection.Service
        const out = yield* advance.advanceSelectionAfterToolResults({
          attemptId: prepared.attemptId,
          selectionId: sel.selectionId,
          toolEvidence: [evidence],
          now: 2_000,
        })
        const db = (yield* Database.Service).db
        const newRow = yield* db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, out.selectionId))
          .get()
          .pipe(Effect.orDie)
        const refs = JSON.parse(newRow?.selected_refs ?? "[]") as SelectionRef[]
        expect(refs.map((ref) => ref.ref)).toContain(evidence.ref)
      }),
    )
  })

  test("advance is deterministic: the same identity yields the same successor selectionId", async () => {
    const harness = harnessWith()
    await harness.run(
      Effect.gen(function* () {
        const writer = yield* SelectionWriter.Service
        const owner = yield* SessionProviderOwner.Service
        yield* owner.register({ ownerToken, leaseMs: 60_000, now: 1_000 })

        const sel = build(result([candidate({ graph: "code", entityId: "a" })]), envelope(), 0, 1)
        yield* writer.write({ envelope: sel, attempt, now: 1_000 })
        const prepared = yield* (yield* SessionProviderAttempt.Service).prepare({
          sessionId,
          activityId,
          providerTurnSeq: 1,
          selectionId: sel.selectionId,
          projectionHash: sel.projectionHash,
          requestHash: attempt.requestHash,
          providerId: attempt.providerId,
          ownerToken,
          authorizationEpoch: sel.principal.authorizationEpoch,
          egressEpoch: sel.egress.epoch,
          selectedSourceFingerprint: sel.identity.selectedSourceFingerprint,
          observedLocationMutationEpoch: sel.identity.observedLocationMutationEpoch,
          now: 1_000,
        })

        const advance = yield* AdvanceSelection.Service
        const first = yield* advance.advanceSelectionAfterToolResults({
          attemptId: prepared.attemptId,
          selectionId: sel.selectionId,
          toolEvidence: [evidence],
          now: 2_000,
        })
        const second = yield* advance.advanceSelectionAfterToolResults({
          attemptId: prepared.attemptId,
          selectionId: sel.selectionId,
          toolEvidence: [evidence],
          now: 2_000,
        })
        expect(second.selectionId).toBe(first.selectionId)
        expect(second.revision).toBe(first.revision)
        const db = (yield* Database.Service).db
        const rows = yield* db
          .select({ selection_id: SessionContextSelectionTable.selection_id })
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, first.selectionId))
          .all()
          .pipe(Effect.orDie)
        expect(rows).toHaveLength(1)
      }),
    )
  })
})
