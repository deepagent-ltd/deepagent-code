import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { SelectionWriter } from "../../src/context-federation/selection-writer"
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
import type { GraphKind, GraphStatus } from "../../src/contract/selection"
import { ProjectV2 } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { SessionMessage } from "../../src/session/message"
import { Prompt } from "../../src/session/prompt"
import { SessionSchema } from "../../src/session/schema"
import { SessionInputTable, SessionTable } from "../../src/session/sql"

const ns = SecurityNamespaceID.make("sec_writer_test")
const proj = ProjectScopeKey.make("prj_writer_test")
const loc = LocationKey.make("loc_writer_test")
const projectId = ProjectV2.ID.make("project-writer-test")
const sessionId = SessionSchema.ID.make("ses_writer_test")
const activityId = "act_writer_test"
const triggerId = SessionMessage.ID.make("msg_writer_trigger")
const ownerToken = "provider-owner-writer-test"

const principal = {
  securityNamespaceId: ns,
  principalId: "principal-writer",
  authorizationEpoch: 1,
  locationKeys: [loc],
  projectScopeKeys: [proj],
  sessionIds: [sessionId],
  subjectIds: ["subject-writer"],
  allowBuiltin: false,
}

const egress = {
  policyId: "provider-writer",
  epoch: 1,
  graphs: ["code", "documents", "knowledge", "memory"] as const,
  sensitivities: ["public", "source_code"] as const,
}

function envelope(overrides?: Partial<QueryEnvelope>): QueryEnvelope {
  return {
    membership: { sessionId, activityId, inputIds: [triggerId] },
    location: { locationKey: loc },
    principal,
    workspace: { workspaceId: "ws_writer" },
    securityNamespace: { securityNamespaceId: ns },
    projectScope: { projectScopeKey: proj, projectId: "legacy-project" },
    egress,
    agentPolicy: { agentId: "agent-writer", autonomyCeiling: "medium", permitDegraded: false },
    modelCapability: { modelId: "model-writer", providerId: "provider-writer", protocol: "openai.responses", contextWindow: 128_000, structuredOutput: true },
    releasedKnowledge: { snapshotId: "snapshot-writer", binding: "unavailable" },
    queryIntent: "search",
    query: "write the selection",
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

function result(candidates: readonly ContextCandidate[], statuses?: Record<GraphKind, GraphStatus["status"]>): QueryResultV2 {
  const byGraph = new Map<GraphKind, ContextCandidate[]>()
  for (const candidate of candidates) {
    const list = byGraph.get(candidate.ref.graph) ?? []
    list.push(candidate)
    byGraph.set(candidate.ref.graph, list)
  }
  const graphs: GraphKind[] = ["code", "documents", "knowledge", "memory"]
  const results = graphs.map((graph) => ({
    graph,
    status: status(graph, statuses?.[graph] ?? (byGraph.get(graph)?.length ? "ready" : "empty"), `${graph}:1`, byGraph.get(graph)?.length ?? 0),
    candidates: byGraph.get(graph) ?? [],
  }))
  const graphStatuses = Object.fromEntries(results.map((entry) => [entry.graph, entry.status])) as Record<GraphKind, GraphStatus>
  return {
    queryFingerprint: "qf-writer",
    authorizationFingerprint: "af-writer",
    executionFingerprint: "ef-writer",
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
  attemptId: "attempt-writer",
  providerTurnSeq: 1,
  requestHash: "req-writer",
  providerId: "provider-writer",
}

describe("SelectionWriter (C3-05 production write + FK + no v2-none + successor)", () => {
  test("writes a selection+validation row with a real identity (never v2-none) for an all-denied resolution", async () => {
    const harness = harnessWith()
    await harness.run(
      Effect.gen(function* () {
        const writer = yield* SelectionWriter.Service
        const r = result([], { code: "denied", documents: "denied", knowledge: "denied", memory: "denied" })
        const sel = build(r, envelope(), 0, 1)
        expect(Object.values(sel.graphStatuses).every((s) => s.status === "denied")).toBe(true)
        const outcome = yield* writer.write({ envelope: sel, attempt, now: 1_000 })
        expect(outcome.kind).toBe("written")
        const db = (yield* Database.Service).db
        const row = yield* db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, sel.selectionId))
          .get()
          .pipe(Effect.orDie)
        expect(row?.graph_statuses).not.toContain("v2-none")
        expect(sel.selectedRefs).toHaveLength(0)
        expect(sel.identity.selectionId).toBe(sel.selectionId)
      }),
    )
  })

  test("requires the attempt FK binding: a write without attempt is a typed RequiredAttemptFkError", async () => {
    const harness = harnessWith()
    const outcome = await harness.run(
      Effect.gen(function* () {
        const writer = yield* SelectionWriter.Service
        const sel = build(result([candidate({ graph: "code", entityId: "a" })]), envelope(), 0, 1)
        return yield* writer
          .write({ envelope: sel, attempt: { attemptId: "", providerTurnSeq: 1, requestHash: "", providerId: "" } })
          .pipe(Effect.catch((error) => Effect.succeed({ error })))
      }),
    )
    expect(outcome).toMatchObject({ error: { _tag: "SelectionWriter.RequiredAttemptFkError" } })
  })

  test("assertAttemptBound rejects an attempt that was never bound to a selection (FK absent)", async () => {
    const harness = harnessWith()
    const outcome = await harness.run(
      Effect.gen(function* () {
        const writer = yield* SelectionWriter.Service
        return yield* writer
          .assertAttemptBound({ attemptId: "does-not-exist", selectionId: "sel-missing" })
          .pipe(Effect.catch((error) => Effect.succeed({ error })))
      }),
    )
    expect(outcome).toMatchObject({ error: { _tag: "SelectionWriter.RequiredAttemptFkError" } })
  })

  test("exact retry is idempotent: a second write with the same envelope is typed existing, no duplicate row", async () => {
    const harness = harnessWith()
    await harness.run(
      Effect.gen(function* () {
        const writer = yield* SelectionWriter.Service
        const sel = build(result([candidate({ graph: "code", entityId: "a" })]), envelope(), 0, 1)
        const first = yield* writer.write({ envelope: sel, attempt, now: 1_000 })
        expect(first.kind).toBe("written")
        const second = yield* writer.write({ envelope: sel, attempt, now: 1_000 })
        expect(second.kind).toBe("existing")
        if (second.kind !== "existing") throw new Error("expected exact-retry existing")
        expect(second.conflict).toBe(false)
        expect(second.selectionId).toBe(first.selectionId)
        const db = (yield* Database.Service).db
        const rows = yield* db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, sel.selectionId))
          .all()
          .pipe(Effect.orDie)
        expect(rows).toHaveLength(1)
      }),
    )
  })

  test("a validated V2 attempt bound to a selection passes assertAttemptBound before dispatch", async () => {
    const harness = harnessWith()
    await harness.run(
      Effect.gen(function* () {
        const writer = yield* SelectionWriter.Service
        const owner = yield* SessionProviderOwner.Service
        yield* owner.register({ ownerToken, leaseMs: 60_000, now: 1_000 })
        const sel = build(result([candidate({ graph: "code", entityId: "a" })]), envelope(), 0, 1)
        expect((yield* writer.write({ envelope: sel, attempt, now: 1_000 })).kind).toBe("written")
        const attempts = yield* SessionProviderAttempt.Service
        const prepared = yield* attempts.prepare({
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
        const bound = yield* writer.assertAttemptBound({ attemptId: prepared.attemptId, selectionId: sel.selectionId, now: 1_000 })
        expect(bound.selectionId).toBe(sel.selectionId)
        expect(bound.revision).toBe(0)
        expect(bound.outcome).toBe("valid")
      }),
    )
  })

  test("validation drift → rebuild successor → the dispatched attempt carries the NEW selection identity", async () => {
    const harness = harnessWith()
    await harness.run(
      Effect.gen(function* () {
        const writer = yield* SelectionWriter.Service
        const owner = yield* SessionProviderOwner.Service
        yield* owner.register({ ownerToken, leaseMs: 60_000, now: 1_000 })

        const r0 = result([candidate({ graph: "code", entityId: "a" })])
        const selA = build(r0, envelope(), 0, 1)
        expect((yield* writer.write({ envelope: selA, attempt, now: 1_000 })).kind).toBe("written")

        // Drift detected -> build a SUCCESSOR (revision 1, new identity, invalidated outcome).
        const env2 = envelope({ observedLocationMutationEpoch: 4, expectedLocationMutationEpoch: 2 })
        const r1 = result([candidate({ graph: "code", entityId: "a" })])
        const batch1 = budgetSelection(r1, env2)
        const selB = SelectionWriter.rebuildForDrift(selA, batch1, r1, env2, { triggerInputId: triggerId, providerTurnSeq: 1, now: 1_000 })
        expect(selB.revision).toBe(1)
        expect(selB.selectionId).not.toBe(selA.selectionId)
        expect(selB.validation.outcome).toBe("invalidated")
        expect((yield* writer.write({ envelope: selB, attempt, now: 1_000 })).kind).toBe("written")

        // Re-validate the successor (design §4.1 step 7) so it may dispatch.
        yield* writer.revalidate({
          selectionId: selB.selectionId,
          providerTurnSeq: 1,
          authorizationEpoch: selB.principal.authorizationEpoch,
          egressEpoch: selB.egress.epoch,
          observedLocationMutationEpoch: selB.identity.observedLocationMutationEpoch,
          selectedSourceFingerprint: selB.identity.selectedSourceFingerprint,
          validUntil: 1_000 + 60_000,
          now: 2_000,
        })

        const prepared = yield* (yield* SessionProviderAttempt.Service).prepare({
          sessionId,
          activityId,
          providerTurnSeq: 1,
          selectionId: selB.selectionId,
          projectionHash: selB.projectionHash,
          requestHash: attempt.requestHash,
          providerId: attempt.providerId,
          ownerToken,
          authorizationEpoch: selB.principal.authorizationEpoch,
          egressEpoch: selB.egress.epoch,
          selectedSourceFingerprint: selB.identity.selectedSourceFingerprint,
          observedLocationMutationEpoch: selB.identity.observedLocationMutationEpoch,
          now: 2_000,
        })
        const bound = yield* writer.assertAttemptBound({ attemptId: prepared.attemptId, selectionId: selB.selectionId, now: 2_000 })

        const db = (yield* Database.Service).db
        const attemptRow = yield* db
          .select({ selection_id: SessionProviderAttemptTable.selection_id })
          .from(SessionProviderAttemptTable)
          .where(eq(SessionProviderAttemptTable.attempt_id, prepared.attemptId))
          .get()
          .pipe(Effect.orDie)
        expect(attemptRow?.selection_id).toBe(selB.selectionId)
        expect(bound.selectionId).toBe(selB.selectionId)
        expect(bound.selectionId).not.toBe(selA.selectionId)
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

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
    yield* db
      .insert(SecurityNamespaceTable)
      .values({ id: ns, kind: "implicit_local", binding_hash: Hash.sha256(ns), created_at: 1_000 })
      .run()
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
        canonical_root: "/tmp/writer-test",
        observed_project_id: projectId,
        created_at: 1_000,
      })
      .run()
    yield* db
      .insert(ProjectTable)
      .values({ id: projectId, worktree: AbsolutePath.make("/tmp/writer-test"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionId, project_id: projectId, slug: "writer-test", directory: "/tmp/writer-test", title: "Writer test", version: "test" })
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
