import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ContextLinkStore } from "../../src/context-federation/link-store"
import { ContextLinkBatchTable } from "../../src/context-federation/link-sql"
import {
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
  canonicalContextRef,
  sameProjectionRevision,
  type ContextRef,
  type ProjectionSnapshotRevision,
} from "../../src/context-federation/reference"
import { Database } from "../../src/database/database"

const namespace = SecurityNamespaceID.make("sec_link_test")
const project = ProjectScopeKey.make("prjctx_link_test")
const otherProject = ProjectScopeKey.make("prjctx_other")
const location = LocationKey.make("loc_link_test")
const code = ref("code", "code", {
  scope: "location",
  securityNamespaceId: namespace,
  projectScopeKey: project,
  locationKey: location,
})
const memory = ref("memory", "memory", { scope: "user", securityNamespaceId: namespace, subjectId: "subject" })
const evidence = ref("documents", "evidence", {
  scope: "session",
  securityNamespaceId: namespace,
  projectScopeKey: project,
  sessionId: "ses_link_test",
})
const projectDoc = ref("documents", "project-doc", {
  scope: "project",
  securityNamespaceId: namespace,
  projectScopeKey: project,
})

describe("ContextLinkStore", () => {
  test("canonicalizes nested binding and locator field order", () => {
    const first = {
      graph: "code" as const,
      entityId: "ordered",
      binding: {
        scope: "location" as const,
        securityNamespaceId: namespace,
        projectScopeKey: project,
        locationKey: location,
      },
      locator: { endLine: 2, path: "src/a.ts", startLine: 1 },
      revision: "code:1",
    }
    const second = {
      revision: "code:1",
      locator: { startLine: 1, path: "src/a.ts", endLine: 2 },
      binding: {
        locationKey: location,
        projectScopeKey: project,
        securityNamespaceId: namespace,
        scope: "location" as const,
      },
      entityId: "ordered",
      graph: "code" as const,
    }
    expect(canonicalContextRef(first)).toBe(canonicalContextRef(second))
  })

  test("derives conjunctive access and never exposes private edge existence", async () => {
    const harness = makeHarness(snapshot(1))
    await harness.run(
      Effect.gen(function* () {
        const links = yield* ContextLinkStore.Service
        const batch = yield* links.stageProjectionBatch({
          securityNamespaceId: namespace,
          projectScopeKey: project,
          producerId: "code-index",
          projectionKind: "code",
          sourceRevision: snapshot(1),
          links: [{ from: code, to: memory, evidenceRefs: [evidence], relation: "observed_in", confidence: 0.9 }],
          createdBy: "parser",
          now: 10,
        })
        expect((yield* links.neighbors(query(code, principal()))).links).toEqual([])
        yield* links.activateProjectionBatch(batch.batchId, 11)

        const visible = yield* links.neighbors(query(code, principal()))
        expect(visible.refreshPending).toBe(false)
        expect(visible.links).toHaveLength(1)
        expect(visible.links[0]).toMatchObject({
          relation: "observed_in",
          direction: "forward",
          constraints: [
            { scope: "location", locationKey: location },
            { scope: "session", sessionId: "ses_link_test" },
            { scope: "subject", subjectId: "subject" },
          ],
        })
        expect((yield* links.neighbors(query(memory, principal()))).links[0]?.direction).toBe("inverse")
        expect((yield* links.neighbors(query(code, principal({ subjectIds: [] })))).links).toEqual([])
        expect((yield* links.neighbors(query(code, principal({ sessionIds: [] })))).links).toEqual([])
        expect((yield* links.neighbors(query(code, principal({ locationKeys: [] })))).links).toEqual([])
        expect((yield* links.neighbors({ ...query(code, principal()), egress: egress(["code"]) })).links).toEqual([])

        harness.setCurrent(snapshot(2))
        const staleAuthorized = yield* links.neighbors(query(code, principal()))
        expect(staleAuthorized).toEqual({ links: [], refreshPending: true })
        const staleUnauthorized = yield* links.neighbors(query(code, principal({ subjectIds: [] })))
        expect(staleUnauthorized).toEqual({ links: [], refreshPending: false })
      }),
    )
  })

  test("publishes projection batches atomically and supersedes the complete old relation set", async () => {
    const harness = makeHarness(snapshot(1))
    await harness.run(
      Effect.gen(function* () {
        const links = yield* ContextLinkStore.Service
        const first = yield* links.stageProjectionBatch({
          securityNamespaceId: namespace,
          projectScopeKey: project,
          producerId: "code-index",
          projectionKind: "code",
          sourceRevision: snapshot(1),
          links: [{ from: code, to: memory, evidenceRefs: [], relation: "references", confidence: 0.8 }],
          createdBy: "parser",
          now: 10,
        })
        expect(
          (yield* links.stageProjectionBatch({
            securityNamespaceId: namespace,
            projectScopeKey: project,
            producerId: "code-index",
            projectionKind: "code",
            sourceRevision: snapshot(1),
            links: [{ from: code, to: memory, evidenceRefs: [], relation: "references", confidence: 0.8 }],
            createdBy: "parser",
            now: 10,
          })).batchId,
        ).toBe(first.batchId)
        yield* links.activateProjectionBatch(first.batchId, 11)
        harness.setCurrent(snapshot(2))
        const second = yield* links.stageProjectionBatch({
          securityNamespaceId: namespace,
          projectScopeKey: project,
          producerId: "code-index",
          projectionKind: "code",
          sourceRevision: snapshot(2),
          links: [{ from: code, to: projectDoc, evidenceRefs: [], relation: "implements", confidence: 0.9 }],
          createdBy: "parser",
          now: 20,
        })
        yield* links.activateProjectionBatch(second.batchId, 21)
        const current = yield* links.neighbors(query(code, principal()))
        expect(current.links.map((link) => [link.relation, link.to.entityId])).toEqual([
          ["implements", projectDoc.entityId],
        ])
        const batches = yield* (yield* Database.Service).db.select().from(ContextLinkBatchTable).all()
        expect(batches.map((batch) => [batch.batch_id, batch.state]).toSorted()).toEqual(
          [
            [first.batchId, "superseded"],
            [second.batchId, "active"],
          ].toSorted(),
        )

        const future = yield* links.stageProjectionBatch({
          securityNamespaceId: namespace,
          projectScopeKey: project,
          producerId: "code-index",
          projectionKind: "code",
          sourceRevision: snapshot(3),
          links: [],
          createdBy: "parser",
          now: 30,
        })
        expect((yield* links.activateProjectionBatch(future.batchId, 31).pipe(Effect.flip))._tag).toBe(
          "ContextLink.RevisionChangedError",
        )
      }),
    )
  })

  test("rejects cross-partition links and excludes candidate, broken, revoked, and expired edges", async () => {
    const harness = makeHarness(snapshot(1))
    await harness.run(
      Effect.gen(function* () {
        const links = yield* ContextLinkStore.Service
        const crossProject = ref("documents", "other-project", {
          scope: "project",
          securityNamespaceId: namespace,
          projectScopeKey: otherProject,
        })
        expect(
          (yield* links
            .put({
              securityNamespaceId: namespace,
              projectScopeKey: project,
              producer: { kind: "human", id: "human" },
              source: "human",
              link: { from: code, to: crossProject, evidenceRefs: [], relation: "supports", confidence: 1 },
              createdBy: "human",
            })
            .pipe(Effect.flip))._tag,
        ).toBe("ContextLink.InvalidLinkError")

        yield* links.put({
          securityNamespaceId: namespace,
          projectScopeKey: project,
          producer: { kind: "model", id: "model" },
          source: "model",
          link: { from: code, to: projectDoc, evidenceRefs: [], relation: "supports", confidence: 0.5 },
          createdBy: "model",
          now: 10,
        })
        const active = yield* links.put({
          securityNamespaceId: namespace,
          projectScopeKey: project,
          producer: { kind: "human", id: "human" },
          source: "human",
          link: { from: code, to: projectDoc, evidenceRefs: [], relation: "supports", confidence: 1 },
          createdBy: "human",
          now: 10,
        })
        yield* links.put({
          securityNamespaceId: namespace,
          projectScopeKey: project,
          producer: { kind: "runner", id: "expired" },
          source: "runner",
          link: { from: code, to: projectDoc, evidenceRefs: [], relation: "validated_by", confidence: 1 },
          createdBy: "runner",
          validUntil: 20,
          now: 10,
        })
        expect((yield* links.neighbors({ ...query(code, principal()), now: 15 })).links).toHaveLength(2)
        yield* links.retire({ linkId: active.linkId, state: "revoked", now: 11 })
        expect((yield* links.neighbors({ ...query(code, principal()), now: 21 })).links).toEqual([])
      }),
    )
  })
})

function makeHarness(initial: ProjectionSnapshotRevision) {
  const database = Database.layerFromPath(":memory:")
  let current = initial
  const authority = Layer.succeed(
    ContextLinkStore.RevisionAuthority,
    ContextLinkStore.RevisionAuthority.of({
      withCurrent: (input, use) =>
        sameProjectionRevision(input.revision, current)
          ? use
          : Effect.fail(new ContextLinkStore.RevisionChangedError()),
      isCurrent: (input) => Effect.succeed(sameProjectionRevision(input.revision, current)),
    }),
  )
  const links = ContextLinkStore.layer.pipe(Layer.provide(Layer.merge(database, authority)))
  const layer = Layer.mergeAll(database, authority, links)
  return {
    setCurrent: (revision: ProjectionSnapshotRevision) => {
      current = revision
    },
    run: <A, E>(effect: Effect.Effect<A, E, Database.Service | ContextLinkStore.Service>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped)),
  }
}

function query(reference: ContextRef, value: ReturnType<typeof principal>) {
  return {
    securityNamespaceId: namespace,
    projectScopeKey: project,
    ref: reference,
    principal: value,
    egress: egress(),
    now: 15,
  }
}

function principal(
  override: Partial<{
    locationKeys: readonly LocationKey[]
    projectScopeKeys: readonly ProjectScopeKey[]
    sessionIds: readonly string[]
    subjectIds: readonly string[]
  }> = {},
) {
  return {
    securityNamespaceId: namespace,
    principalId: "principal",
    authorizationEpoch: 1,
    locationKeys: override.locationKeys ?? [location],
    projectScopeKeys: override.projectScopeKeys ?? [project],
    sessionIds: override.sessionIds ?? ["ses_link_test"],
    subjectIds: override.subjectIds ?? ["subject"],
    allowBuiltin: false,
  }
}

function egress(
  graphs: readonly ("code" | "knowledge" | "memory" | "documents")[] = ["code", "knowledge", "memory", "documents"],
) {
  return { policyId: "provider", epoch: 1, graphs, sensitivities: ["public", "source_code"] as const }
}

function snapshot(generation: number): ProjectionSnapshotRevision {
  return {
    projectionKind: "code",
    indexIncarnation: 1,
    generation,
    manifestHash: `manifest-${generation}`,
    schemaVersion: 1,
    adapterSetVersion: "ts-v1",
  }
}

function ref(graph: ContextRef["graph"], entityId: string, binding: ContextRef["binding"]): ContextRef {
  return { graph, entityId, binding, revision: `${graph}:1` }
}
