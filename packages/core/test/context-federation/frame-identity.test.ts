import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../../src/database/database"
import { DurableKnowledgeStore } from "../../src/deepagent/durable-knowledge-store"
import { DeepAgentReleasedSnapshot } from "../../src/deepagent/released-snapshot"
import {
  ProductionV2Sources,
  type ProductionV2AdapterInput,
  type ProductionV2LocationIdentity,
} from "../../src/context-federation/production-adapters"
import { ContextFederation } from "../../src/context-federation/federation"
import {
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
  type ContextRef,
} from "../../src/context-federation/reference"
import { SessionContext } from "../../src/context-federation/session-context"
import { SessionRunnerCanonical } from "../../src/session/runner/canonical-turn"
import { SessionSchema } from "../../src/session/schema"
import { SessionMessage } from "../../src/session/message"
import { Prompt } from "../../src/session/prompt"
import { SessionInputTable, SessionTable } from "../../src/session/sql"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/sql"
import { AbsolutePath } from "../../src/schema"
import { SessionContextSelectionTable } from "../../src/context-federation/session-sql"
import { type CodeQuery } from "../../src/code-intelligence/query"
import { type ProjectionSnapshotRevision } from "../../src/context-federation/reference"
import { mkdtempSync } from "node:fs"
import { tmpdir as osTmpdir } from "node:os"
import path from "node:path"
import { testEffect } from "../lib/effect"

// W3.8 A — the core-frame identity unlock. The V2 runner envelope must carry the REAL location
// identity (location-derived security namespace / project scope / legacy project id) when the
// production sources seam provides it, so refs produced by the live sources (bound to the same
// real identity) pass resolver authorization and the four graphs resolve {ready, empty}. Without
// an identity the frame falls back to the `v2:local` degradation — the documented pre-W3.8
// behavior for callers without location context.

const tmpdirPath = mkdtempSync(path.join(osTmpdir(), "deepagent-code-w3-8-frame-"))

const ns = SecurityNamespaceID.make("sec_w38")
const proj = ProjectScopeKey.make("prj_w38")
const loc = LocationKey.make("loc_w38")
const legacyProjectId = "prj-legacy-w38"

const frameIdentity = (): ProductionV2LocationIdentity => ({
  securityNamespaceId: ns,
  locationKey: loc,
  projectScopeKey: proj,
  legacyProjectId,
})

const codeRef: ContextRef = {
  graph: "code",
  entityId: "seed-symbol",
  binding: { scope: "location", securityNamespaceId: ns, locationKey: loc, projectScopeKey: proj },
  revision: "code:1",
  locator: { path: "src/seed.ts", symbolPath: "seed", startLine: 1, endLine: 3 },
}

/** A fake CodeQuery service that records every intent it receives (same shape as production-adapters.test.ts). */
function fakeCodeQuery(records: { readonly intents: string[] }, hit?: ContextRef): CodeQuery.Interface {
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
      index: { state: "ready" as const, generation: 1, dirtyPathCount: 0, semanticCoverage: {}, revision, stale: false },
      status: ContextFederation.status.matched("code", [{ source: "code_graph", revision: JSON.stringify(revision), state: "ready" }]),
      consistency: request.consistency,
      freshnessSatisfied: true,
      enrichment: { lsp: "not_applicable", editorOverlay: "not_applicable" },
      hits: hit === undefined ? [] : [{ ref: hit, file: "src/seed.ts", symbol: "seed", kind: "function", score: 1, snippet: "export function seed() {}", sources: ["graph"] as const, editorOverlay: "not_applicable" as const }],
      truncated: false,
    })
  }
  return { query }
}

const database = Database.layerFromPath(":memory:")
const contexts = SessionContext.layer.pipe(
  Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
  Layer.provide(database),
)
const sessionID = SessionSchema.ID.make("ses_w38_frame")

const seed = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, slug: "frame", directory: "/project", title: "frame", version: "test" })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionInputTable)
    .values({ id: SessionMessage.ID.make("msg_w38_frame"), session_id: sessionID, admitted_seq: 1, prompt: new Prompt({ text: "trigger" }), delivery: "steer", promoted_seq: 1, time_created: 1 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const it = testEffect(Layer.mergeAll(database, contexts))

it.effect("A: real identity frame — code graph resolves ready with real-scope refs (never denied)", () => {
  const records: { intents: string[] } = { intents: [] }
  return Effect.gen(function* () {
    yield* seed
    const db = (yield* Database.Service).db
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_w38_frame"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_w38_frame",
    })
    const row = yield* db
      .select()
      .from(SessionContextSelectionTable)
      .where(eq(SessionContextSelectionTable.selection_id, admission.selectionId))
      .get()
      .pipe(Effect.orDie)
    // The selection row carries the REAL frame identity — not the v2:local pin.
    expect(row?.security_namespace_id).toBe(ns)
    expect(row?.project_scope_key).toBe(proj)
    expect(row?.location_key).toBe(loc)
    const statuses = JSON.parse(row?.graph_statuses ?? "{}") as Record<string, { status: string; reasonCode: string; candidateCount: number; rejectedCount?: number }>
    expect(statuses.code?.status).toBe("ready")
    expect(statuses.code?.reasonCode).toBe("none")
    expect(statuses.code?.candidateCount).toBe(1)
    expect(statuses.code?.rejectedCount).toBe(0)
    const refs = JSON.parse(row?.selected_refs ?? "[]") as { graph: string; ref: string; version: string; provenanceRefs: string[] }[]
    expect(refs.find((ref) => ref.graph === "code")).toMatchObject({
      ref: expect.stringContaining("seed-symbol"),
      version: "code:1",
      provenanceRefs: [],
    })
    const evidence = yield* SessionRunnerCanonical.selectionGraphEvidence(db, admission.selectionId)
    expect(evidence).toContain("[adapter version code-intelligence.v1]")
    expect(evidence).toContain('version="code:1" ref=')
    expect(evidence).toContain("provenance_refs=degraded_unavailable")
    expect(new TextEncoder().encode(evidence ?? "").length).toBeLessThanOrEqual(SessionRunnerCanonical.EvidenceByteBudget)
    // v2:local never leaks into a real frame.
    expect(row?.graph_revisions).not.toContain("v2:local")
  }).pipe(
    Effect.provideService(ProductionV2Sources, {
      identity: frameIdentity(),
      code: fakeCodeQuery(records, codeRef),
    } as ProductionV2AdapterInput),
  )
})

it.effect("A: no-location-context frame falls back to the v2:local degradation (unchanged)", () =>
  Effect.gen(function* () {
    yield* seed
    const db = (yield* Database.Service).db
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_w38_frame"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_w38_frame",
    })
    const row = yield* db
      .select()
      .from(SessionContextSelectionTable)
      .where(eq(SessionContextSelectionTable.selection_id, admission.selectionId))
      .get()
      .pipe(Effect.orDie)
    expect(row?.security_namespace_id).toBe(SecurityNamespaceID.make("v2:local"))
    expect(row?.project_scope_key).toBe(ProjectScopeKey.make("v2:local"))
    expect(row?.location_key).toBe(LocationKey.make("/project#"))
    const statuses = JSON.parse(row?.graph_statuses ?? "{}") as Record<string, { status: string }>
    expect(statuses.code?.status).toBe("degraded_unavailable")
  }),
)

it.effect("A: the released picker receives the real envelope scope (match path, legacyProjectId included)", () => {
  const scopes: DeepAgentReleasedSnapshot.Scope[] = []
  return Effect.gen(function* () {
    yield* seed
    const db = (yield* Database.Service).db
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_w38_frame"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_w38_frame",
    })
    // Envelope bind + knowledge + memory (GraphOrder): every picker call must observe the real scope.
    expect(scopes.length).toBeGreaterThan(0)
    expect(scopes.every((scope) =>
      scope.securityNamespaceId === String(ns) &&
      scope.projectScopeKey === String(proj) &&
      scope.legacyProjectId === legacyProjectId,
    )).toBe(true)
    const row = yield* db
      .select()
      .from(SessionContextSelectionTable)
      .where(eq(SessionContextSelectionTable.selection_id, admission.selectionId))
      .get()
      .pipe(Effect.orDie)
    // No released snapshot exists for the scope: a legitimate empty domain, never degraded.
    const statuses = JSON.parse(row?.graph_statuses ?? "{}") as Record<string, { status: string; reasonCode: string }>
    expect(statuses.knowledge?.status).toBe("empty")
    expect(statuses.knowledge?.reasonCode).toBe("none")
  }).pipe(
    Effect.provideService(ProductionV2Sources, {
      identity: frameIdentity(),
      knowledge: {
        stores: [new DurableKnowledgeStore(tmpdirPath)],
        released: {
          snapshotId: "",
          binding: "unavailable",
          current: (scope) => {
            scopes.push(scope)
            return Effect.succeed(undefined)
          },
        },
      },
    } as ProductionV2AdapterInput),
  )
})

it.effect("A: queryIntent is threaded into the envelope (L1) — trace_evidence maps to references", () => {
  const records: { intents: string[] } = { intents: [] }
  return Effect.gen(function* () {
    yield* seed
    const db = (yield* Database.Service).db
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_w38_frame"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_w38_frame",
      queryIntent: "trace_evidence",
    })
    expect(admission.selectionId).toBeTruthy()
    // The code adapter received the mapped bounded intent through intentFor (L1 wiring end-to-end).
    expect(records.intents).toEqual(["references"])
  }).pipe(
    Effect.provideService(ProductionV2Sources, {
      identity: frameIdentity(),
      code: fakeCodeQuery(records, codeRef),
    } as ProductionV2AdapterInput),
  )
})

it.effect("L2: the evidence tail respects the 4 KB byte budget with a high-token selection", () => {
  const longRef: ContextRef = { ...codeRef, entityId: "long-symbol" }
  const longHit = {
    ref: longRef,
    file: "src/seed.ts",
    symbol: "s".repeat(5_000),
    kind: "function",
    score: 1,
    snippet: "export function seed() {}",
    sources: ["graph"] as const,
    editorOverlay: "not_applicable" as const,
  }
  return Effect.gen(function* () {
    yield* seed
    const db = (yield* Database.Service).db
    const admission = yield* SessionRunnerCanonical.admitSelection({
      db,
      contexts: yield* SessionContext.Service,
      sessionID,
      agent: "build",
      location: { directory: "/project" },
      promotedInputIds: ["msg_w38_frame"],
      system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
      historyEndMessageId: "msg_w38_frame",
    })
    const evidence = yield* SessionRunnerCanonical.selectionGraphEvidence(db, admission.selectionId)
    expect(evidence).toBeDefined()
    expect(new TextEncoder().encode(evidence ?? "").length).toBeLessThanOrEqual(SessionRunnerCanonical.EvidenceByteBudget)
    // The long token was truncated by the writer and the (and N more refs) marker stays bounded.
    expect(evidence).toContain("Selected refs:")
    expect(evidence).not.toContain("s".repeat(121))
  }).pipe(
    Effect.provideService(ProductionV2Sources, {
      identity: frameIdentity(),
      code: {
        query: () =>
          Effect.succeed({
            index: { state: "ready" as const, generation: 1, dirtyPathCount: 0, semanticCoverage: {}, stale: false } as never,
            status: ContextFederation.status.matched("code", []) as never,
            consistency: "stale_ok" as const,
            freshnessSatisfied: true,
            enrichment: { lsp: "not_applicable", editorOverlay: "not_applicable" },
            hits: [longHit],
            truncated: false,
          }),
      } as unknown as CodeQuery.Interface,
    } as ProductionV2AdapterInput),
  )
})
