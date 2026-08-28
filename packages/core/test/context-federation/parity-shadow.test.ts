import { afterEach, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../../src/database/database"
import { SelectionWriter } from "../../src/context-federation/selection-writer"
import { ParityShadow, setShadowModeForTest } from "../../src/context-federation/parity-shadow"
import { budgetSelection } from "../../src/context-federation/selection-budget"
import { Hash } from "../../src/util/hash"
import { type QueryEnvelope, type QueryResultV2 } from "../../src/context-federation/resolver-v2"
import { SessionActivityTable, SessionContextSelectionTable } from "../../src/context-federation/session-sql"
import { ContextCandidate, ContextFederation } from "../../src/context-federation/federation"
import { LocationKey, ProjectScopeKey, SecurityNamespaceID, type ContextRef } from "../../src/context-federation/reference"
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

const ns = SecurityNamespaceID.make("sec_parity_test")
const proj = ProjectScopeKey.make("prj_parity_test")
const loc = LocationKey.make("loc_parity_test")
const projectId = ProjectV2.ID.make("project-parity-test")
const sessionId = SessionSchema.ID.make("ses_parity_test")
const activityId = "act_parity_test"
const triggerId = SessionMessage.ID.make("msg_parity_trigger")

const principal = {
  securityNamespaceId: ns,
  principalId: "principal-parity",
  authorizationEpoch: 1,
  locationKeys: [loc],
  projectScopeKeys: [proj],
  sessionIds: [sessionId],
  subjectIds: ["subject-parity"],
  allowBuiltin: false,
}

const egress = {
  policyId: "provider-parity",
  epoch: 1,
  graphs: ["code", "documents", "knowledge", "memory"] as const,
  sensitivities: ["public", "source_code"] as const,
}

function envelope(overrides?: Partial<QueryEnvelope>): QueryEnvelope {
  return {
    membership: { sessionId, activityId, inputIds: [triggerId] },
    location: { locationKey: loc },
    principal,
    workspace: { workspaceId: "ws_parity" },
    securityNamespace: { securityNamespaceId: ns },
    projectScope: { projectScopeKey: proj, projectId: "legacy-project" },
    egress,
    agentPolicy: { agentId: "agent-parity", autonomyCeiling: "medium", permitDegraded: false },
    modelCapability: {
      modelId: "model-parity",
      providerId: "provider-parity",
      protocol: "openai.responses",
      contextWindow: 128_000,
      structuredOutput: true,
    },
    releasedKnowledge: { snapshotId: "snapshot-parity", binding: "unavailable" },
    queryIntent: "search",
    query: "parity the selection",
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

function result(candidates: readonly ContextCandidate[], statusesByGraph?: Record<GraphKind, GraphStatus["status"]>): QueryResultV2 {
  const byGraph = new Map<GraphKind, ContextCandidate[]>()
  for (const candidate of candidates) {
    const list = byGraph.get(candidate.ref.graph) ?? []
    list.push(candidate)
    byGraph.set(candidate.ref.graph, list)
  }
  const graphs: GraphKind[] = ["code", "documents", "knowledge", "memory"]
  const results = graphs.map((graph) => ({
    graph,
    status: status(
      graph,
      statusesByGraph?.[graph] ?? (byGraph.get(graph)?.length ? "ready" : "empty"),
      `${graph}:1`,
      byGraph.get(graph)?.length ?? 0,
    ),
    candidates: byGraph.get(graph) ?? [],
  }))
  const graphStatuses = Object.fromEntries(results.map((entry) => [entry.graph, entry.status])) as Record<GraphKind, GraphStatus>
  return {
    queryFingerprint: "qf-parity",
    authorizationFingerprint: "af-parity",
    executionFingerprint: "ef-parity",
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

function snapshot(
  refs: string[],
  states: Array<{ graph: GraphKind; status: GraphStatus["status"] }>,
): ParityShadow.SelectionSnapshot {
  const selectedRefs: SelectionRef[] = refs.map((ref) => ({
    graph: "code",
    ref,
    token: ref,
    score: 1,
    freshness: "current",
    sensitivity: "public",
    reason: "test",
  }))
  const graphStatuses = Object.fromEntries(
    states.map((entry) => [entry.graph, status(entry.graph, entry.status, `${entry.graph}:1`, 0)]),
  ) as Record<GraphKind, GraphStatus>
  return { selectedRefs, graphStatuses }
}

afterEach(() => setShadowModeForTest(false))

describe("ParityShadow (C3-07: recorded parity + side-effect-free shadow)", () => {
  test("parity hash is deterministic and the delta reflects a changed selection", () => {
    const recorded = snapshot(["a"], [
      { graph: "code", status: "ready" },
      { graph: "documents", status: "empty" },
    ])
    const v2 = snapshot(["a", "b"], [
      { graph: "code", status: "ready" },
      { graph: "documents", status: "empty" },
    ])
    const first = ParityShadow.buildRecordedParity(recorded, v2, "provider_contract_replay", "input-1")
    const second = ParityShadow.buildRecordedParity(recorded, v2, "provider_contract_replay", "input-1")
    expect(second.hash).toBe(first.hash)
    expect(first.delta.added).toEqual(["b"])
    expect(first.delta.removed).toEqual([])
    expect(first.verdict).toBe("differs")

    const changed = ParityShadow.buildRecordedParity(recorded, v2, "provider_contract_replay", "input-2")
    expect(changed.hash).not.toBe(first.hash)

    const match = ParityShadow.buildRecordedParity(recorded, recorded, "provider_contract_replay", "input-1")
    expect(match.verdict).toBe("match")
    expect(match.delta.added).toEqual([])
    expect(match.delta.removed).toEqual([])
  })

  test("the delta is explainable: added/removed refs + per-graph status mapping", () => {
    const recorded = snapshot(["a", "b"], [
      { graph: "code", status: "ready" },
      { graph: "knowledge", status: "ready" },
    ])
    const v2 = snapshot(["a", "c"], [
      { graph: "code", status: "ready" },
      { graph: "knowledge", status: "degraded_unavailable" },
    ])
    const parity = ParityShadow.buildRecordedParity(recorded, v2, "provider_contract_replay", "input-e")
    expect(parity.delta.added).toEqual(["c"])
    expect(parity.delta.removed).toEqual(["b"])
    expect(parity.delta.common).toBe(1)
    expect(parity.graphMapping.knowledge).toMatchObject({ recorded: "ready", v2: "degraded_unavailable", changed: true })
    expect(parity.graphMapping.code).toMatchObject({ recorded: "ready", v2: "ready", changed: false })
    expect(parity.hash.length).toBe(64)
  })

  test("shadow runs the V2 resolver but never dispatches (0 transport/tool calls)", async () => {
    setShadowModeForTest(true)
    const harness = shadowHarness()
    const out = await harness.run(
      Effect.gen(function* () {
        const svc = yield* ParityShadow.Service
        let transportCalls = 0
        let toolCalls = 0
        return yield* svc.runShadow({
          case: "provider_contract_replay",
          inputFingerprint: "input-shadow",
          recorded: snapshot([], [
            { graph: "code", status: "empty" },
            { graph: "documents", status: "empty" },
            { graph: "knowledge", status: "empty" },
            { graph: "memory", status: "empty" },
          ]),
          resolve: () => Effect.succeed(result([candidate({ graph: "code", entityId: "a" })])),
          dispatch: {
            transport: () => Effect.sync(() => {
              transportCalls += 1
            }),
            tool: () => Effect.sync(() => {
              toolCalls += 1
            }),
          },
        }).pipe(Effect.map((value) => ({ value, transportCalls, toolCalls })))
      }),
    )
    expect(out.value.mode).toBe("shadow")
    expect(out.transportCalls).toBe(0)
    expect(out.toolCalls).toBe(0)
  })

  test("shadow writes NO selection rows and leaves the recorded dispatched selection unchanged", async () => {
    setShadowModeForTest(true)
    const harness = dbShadowHarness()
    await harness.run(
      Effect.gen(function* () {
        const writer = yield* SelectionWriter.Service
        const svc = yield* ParityShadow.Service
        const env = envelope()
        const batch = budgetSelection(result([candidate({ graph: "code", entityId: "a" })]), env)
        const sel = SelectionWriter.buildSelectionEnvelope(batch, result([candidate({ graph: "code", entityId: "a" })]), env, {
          revision: 0,
          triggerInputId: triggerId,
          providerTurnSeq: 1,
          now: 1_000,
        })
        expect((yield* writer.write({ envelope: sel, attempt: { attemptId: "a", providerTurnSeq: 1, requestHash: "r", providerId: "p" }, now: 1_000 })).kind).toBe("written")

        const db = (yield* Database.Service).db
        const before = yield* db
          .select({ id: SessionContextSelectionTable.selection_id })
          .from(SessionContextSelectionTable)
          .all()
          .pipe(Effect.orDie)
        expect(before).toHaveLength(1)

        const shadow = yield* svc.runShadow({
          case: "provider_contract_replay",
          inputFingerprint: "input-db",
          recorded: { selectedRefs: sel.selectedRefs, graphStatuses: sel.graphStatuses },
          resolve: () => Effect.succeed(result([candidate({ graph: "code", entityId: "b" })])),
          dispatch: {
            transport: () => Effect.succeed(undefined),
            tool: () => Effect.succeed(undefined),
          },
        })
        expect(shadow.mode).toBe("shadow")

        const after = yield* db
          .select({ id: SessionContextSelectionTable.selection_id })
          .from(SessionContextSelectionTable)
          .all()
          .pipe(Effect.orDie)
        expect(after).toHaveLength(1)
        const row = yield* db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, sel.selectionId))
          .get()
          .pipe(Effect.orDie)
        expect(row?.revision).toBe(0)
      }),
    )
  })
})

function shadowHarness() {
  const layer = ParityShadow.layer
  return {
    run: <A, E>(effect: Effect.Effect<A, E, ParityShadow.Service>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped)),
  }
}

function dbShadowHarness() {
  const database = Database.layerFromPath(":memory:")
  const writer = SelectionWriter.layer.pipe(Layer.provide(database))
  const parityShadow = ParityShadow.layer
  const layer = Layer.mergeAll(database, writer, parityShadow)
  return {
    run: <A, E>(effect: Effect.Effect<A, E, Database.Service | SelectionWriter.Service | ParityShadow.Service>) =>
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
        canonical_root: "/tmp/parity-test",
        observed_project_id: projectId,
        created_at: 1_000,
      })
      .run()
    yield* db.insert(ProjectTable).values({ id: projectId, worktree: AbsolutePath.make("/tmp/parity-test"), sandboxes: [] }).run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionId, project_id: projectId, slug: "parity-test", directory: "/tmp/parity-test", title: "Parity test", version: "test" })
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
