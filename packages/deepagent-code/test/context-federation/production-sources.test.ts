import { describe, expect, test } from "bun:test"
import { CodeQuery } from "@deepagent-code/core/code-intelligence/query"
import {
  CONTEXT_FEDERATION_PRODUCTION_ENV,
  ProductionV2Sources,
  productionAdaptersEnabled,
  productionV2Adapters,
  productionV2SourcesLayer,
  type ProductionV2AdapterInput,
} from "@deepagent-code/core/context-federation/production-adapters"
import { stagedV2Adapters } from "@deepagent-code/core/context-federation/staged-adapters-v2"
import {
  IndexSpaceID,
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
} from "@deepagent-code/core/context-federation/reference"
import { SessionContextResolverV2, type QueryEnvelope } from "@deepagent-code/core/context-federation/resolver-v2"
import { Database } from "@deepagent-code/core/database/database"
import { projectIdForWorkspace } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import {
  configure as configureKnowledgeSource,
  reset as resetKnowledgeSource,
  storesForWorkspace,
} from "@deepagent-code/core/deepagent/knowledge-source"
import { LocationIdentity, type Identity } from "@deepagent-code/core/context-federation/identity"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Context, Effect, Layer, ManagedRuntime, LayerMap, Option } from "effect"
import path from "node:path"
import { layer as bufferLayer } from "../../src/code-intelligence/editor-buffer-snapshot"
import { make as makeStore } from "../../src/code-intelligence/live-code-graph-store"
import { layer as queryLayer } from "../../src/code-intelligence/query-service"
import { indexWorkspace } from "../../src/code-intelligence/typescript-workspace-adapter"
import { make as makeDocumentStore } from "../../src/document-intelligence/live-repo-document-store"
import { indexMarkdown } from "../../src/document-intelligence/markdown-adapter"
import { LSP } from "../../src/lsp/lsp"
import { LocationIndexCoordinator } from "../../src/location-index/coordinator"
import { LocationIndexRuntime } from "../../src/location-index/runtime"
import { isRepoDocument, scan } from "../../src/location-index/manifest"
import { productionInput, identityFromHandle } from "../../src/context-federation/production-sources"
import {
  buildReadinessEnvelope,
  readinessAdapters,
} from "../../src/server/routes/instance/httpapi/handlers/context"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { ProjectV2 } from "@deepagent-code/core/project"
import { tmpdir } from "../fixture/fixture"

// W3.7 — the deepagent-code real-source composition closed loop. A REAL code + repo-document index
// is built over a tmp fixture project (ts-js-v1 + markdown adapters), a REAL LiveCodeQuery runs over
// it, the REAL durable knowledge store pair is configured/seeded, and the assembled
// `ProductionV2AdapterInput` (the exact value `productionSourcesLayer` provides) is resolved
// through the production adapter set. Expected: four-graph statuses ∈ {ready, empty} — never the
// staged `source_disabled` — with the `=false` flag asserting the staged fallback is unchanged.

const ns = SecurityNamespaceID.make("sec_w37")
const proj = ProjectScopeKey.make("prj_w37")

function envelopeIdentity(): Identity {
  return {
    securityNamespaceId: ns,
    locationKey: LocationKey.make("loc_w37"),
    projectScopeKey: proj,
    indexSpaceId: IndexSpaceID.make("idx_w37"),
    canonicalRoot: AbsolutePath.make(process.cwd()),
    observedProjectId: undefined,
  }
}

function envelope(identity: Identity, query: string, overrides?: Partial<QueryEnvelope>): QueryEnvelope {
  const principal = {
    securityNamespaceId: identity.securityNamespaceId,
    principalId: "principal-w37",
    authorizationEpoch: 1,
    locationKeys: [identity.locationKey],
    projectScopeKeys: [identity.projectScopeKey],
    sessionIds: ["ses_w37"],
    subjectIds: ["subject-w37"],
    allowBuiltin: false,
  }
  return {
    membership: { sessionId: "ses_w37", activityId: "act_w37", inputIds: ["msg_w37"] },
    location: { locationKey: identity.locationKey },
    principal,
    workspace: { workspaceId: "" },
    securityNamespace: { securityNamespaceId: identity.securityNamespaceId },
    projectScope: { projectScopeKey: identity.projectScopeKey },
    egress: {
      policyId: "provider-w37",
      epoch: 1,
      graphs: ["code", "documents", "knowledge", "memory"] as const,
      sensitivities: ["public", "source_code"] as const,
    },
    agentPolicy: { agentId: "agent-w37", autonomyCeiling: "medium", permitDegraded: true },
    modelCapability: {
      modelId: "model",
      providerId: "provider",
      protocol: "openai.responses",
      contextWindow: 128_000,
      structuredOutput: false,
    },
    releasedKnowledge: { snapshotId: "", binding: "unavailable" },
    queryIntent: "search",
    query,
    limit: 12,
    observedLocationMutationEpoch: 0,
    ...overrides,
  }
}

function missingLSP(): LSP.Interface {
  return {
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    workspaceSymbol: () => Effect.succeed([]),
  } as unknown as LSP.Interface
}

describe("W3.7 production sources (deepagent-code composition)", () => {
  test("assembles live sources, resolves real code/document hits, and degrades knowledge honestly", async () => {
    await using fixture = await tmpdir()
    const stateRoot = fixture.path
    const root = path.join(stateRoot, "repo")
    await Bun.write(path.join(root, "src", "api.ts"), "export function computeAnswer(kind: string) { return kind }\n")
    await Bun.write(
      path.join(root, "src", "impl.ts"),
      "import { computeAnswer } from './api'\nexport function answerAggregator() { return computeAnswer('v2') }\n",
    )
    await Bun.write(path.join(root, "README.md"), "# Project Architecture\nshared design notes\n")
    await Bun.write(path.join(root, "docs", "deepagent", "HANDOFF.md"), "# Handoff\ncurrent state of the project\n")
    await Bun.write(path.join(root, "docs", "deepagent", "LOG.md"), "# Log\ninitial change entry\n")

    configureKnowledgeSource(stateRoot)
    const stores = storesForWorkspace(root)
    // 项目级 knowledge doc：无 released 快照时 knowledge 图是 ready/empty（released:none）
    stores[stores.length - 1].seedActive({
      type: "knowledge",
      description: "project durable seed",
      body: "project shared knowledge body",
      domain: null,
      tags: [],
      scope: "project-shared",
      projectId: projectIdForWorkspace(root),
      sensitivity: "public",
      risk: "low",
      confidence: { evidence_strength: "strong", support_count: 1 },
      provenance: { source: "runner", evidence_refs: [] },
    })
    // 用户级 memory doc：证明 durable store 已接线（当前核心 V2 封装帧 subjectIds=[] 时
    // user 作用域 ref 会被 subject_scope_denied —— 诚实 empty，拒绝语义留核心演进）
    const memoryDoc = stores[0].seedActive({
      type: "memory",
      description: "durable seed knowledge fact",
      body: "the durable seed knowledge fact about the architecture and the compute answers",
      domain: null,
      tags: [],
      scope: "user-global",
      sensitivity: "public",
      risk: "low",
      confidence: { evidence_strength: "strong", support_count: 1 },
      provenance: { source: "runner", evidence_refs: [] },
    })

    const metadataPath = path.join(stateRoot, "metadata.sqlite")
    const database = Database.layerFromPath(metadataPath)
    await Effect.runPromise(
      Effect.gen(function* () {
        const dbCtx = yield* Layer.build(database)
        const db = Context.get(dbCtx, Database.Service).db
        const identityCtx = yield* Layer.build(
          LocationIdentity.layer.pipe(Layer.provideMerge(database), Layer.provide(FSUtil.defaultLayer)),
        )
        const resolvedIdentity = yield* Context.get(identityCtx, LocationIdentity.Service).resolve({
          boundary: { kind: "implicit_local" },
          directory: AbsolutePath.make(root),
          project: { kind: "registered_root" },
        })

        const manifest = yield* Effect.promise(() => scan({ root }))
        const codeStore = makeStore({
          filename: path.join(stateRoot, "code.sqlite"),
          indexSpaceId: resolvedIdentity.indexSpaceId,
          indexIncarnation: 1,
          canonicalRoot: root,
          adapterSetVersion: "ts-js-v1",
        })
        codeStore.fullCommit({
          indexIncarnation: 1,
          fencingToken: 1,
          expectedGeneration: 0,
          indexedAt: Date.now(),
          build: indexWorkspace({ root, files: manifest.files }),
        })
        const documentStore = makeDocumentStore({
          filename: path.join(stateRoot, "documents.sqlite"),
          indexSpaceId: resolvedIdentity.indexSpaceId,
          indexIncarnation: 1,
          adapterSetVersion: "markdown-v1",
        })
        documentStore.fullCommit({
          indexIncarnation: 1,
          fencingToken: 1,
          expectedGeneration: 0,
          indexedAt: Date.now(),
          documents: manifest.files.filter((file) => isRepoDocument(file.path)).flatMap(indexMarkdown),
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            codeStore.close()
            documentStore.close()
          }),
        )

        const coordinator = LocationIndexCoordinator.Service.of({
          initialize: () => Effect.void,
          observe: () => Effect.void,
          observeRename: () => Effect.void,
          requestReconciliation: () => Effect.void,
          drain: () => Effect.void,
          codeStatus: () => Effect.sync(() => codeStore.status()),
          searchCode: (input) => Effect.sync(() => codeStore.search(input)),
          codeNeighbors: (input) => Effect.sync(() => codeStore.neighbors(input)),
          searchDocuments: (input) => Effect.sync(() => documentStore.search(input)),
          lookupDocuments: (input) => Effect.sync(() => documentStore.lookup(input)),
          mutationEpoch: () => Effect.succeed(1),
          pause: () => Effect.void,
          retire: () => Effect.void,
        })
        const runtime: LocationIndexRuntime.Interface = {
          init: () => Effect.void,
          current: () => Effect.succeed({ identity: resolvedIdentity, coordinator }),
        }
        const code = yield* Layer.build(
          queryLayer({ freshTimeoutMs: 200, lspTimeoutMs: 100 }).pipe(
            Layer.provide(Layer.succeed(LSP.Service, missingLSP())),
            Layer.provide(bufferLayer()),
            Layer.provide(Layer.succeed(LocationIndexRuntime.Service, LocationIndexRuntime.Service.of(runtime))),
          ),
        ).pipe(Effect.map((context) => Context.get(context, CodeQuery.Service)))

        const input: ProductionV2AdapterInput = productionInput({
          runtime,
          code,
          db,
          workspaceDirectory: root,
          // W3.8.1 — exactly what `productionSourcesLayer` computes: the frame identity from the
          // CURRENT instance handle (the layer reads `runtime.current()` and maps it).
          identity: identityFromHandle({ identity: resolvedIdentity }),
        })
        const seamIdentity = input.identity!
        expect(seamIdentity.securityNamespaceId).toBe(resolvedIdentity.securityNamespaceId)
        expect(seamIdentity.locationKey).toBe(resolvedIdentity.locationKey)
        expect(seamIdentity.projectScopeKey).toBe(resolvedIdentity.projectScopeKey)
        // registered_root project without an observed project id: the released-knowledge derivation.
        expect(seamIdentity.legacyProjectId).toBe(projectIdForWorkspace(root))
        // 组合层装配：sources 非空，code 源有查询面，documents 有搜索面，knowledge 有真 store + 释放 picker
        expect(input.code).toBeDefined()
        expect(input.documents).toBeDefined()
        expect(input.knowledge?.stores.length).toBe(2)
        expect(input.knowledge?.released).toBeDefined()

        // code 源查询面是活的：真实索引命中 fixture 符号
        const liveHit = yield* code.query({
          intent: "search",
          query: "computeAnswer",
          limit: 5,
          consistency: "stale_ok",
          principal: envelope(resolvedIdentity, "").principal,
          egress: envelope(resolvedIdentity, "").egress,
          sessionId: "ses_w37",
        })
        expect(liveHit.hits[0]?.symbol).toBe("computeAnswer")

        const adapters = productionV2Adapters(input)
        const resolvedCode = yield* SessionContextResolverV2.resolveGraphs(
          envelope(resolvedIdentity, "computeAnswer"),
          adapters,
          5_000,
        )
        const statuses = resolvedCode.graphStatuses
        // 生产默认四图状态（真实索引 + 真实知识库，无 released 快照）
        console.log(
          `W3.7 production default four-graph statuses: ${Object.entries(statuses)
            .map(([graph, record]) => `${graph}=${record.status}(${record.reasonCode}${record.rejectedCount > 0 ? `,rejected:${record.rejectedCount}` : ""})`)
            .join(" ")}`,
        )
        expect(statuses.code.status).toBe("ready")
        expect(statuses.code.rejectedCount).toBe(0)
        expect(resolvedCode.candidates.some((candidate) => candidate.graph === "code")).toBe(true)
        // documents: 索引存在但 "computeAnswer" 不是文档词——honest ready/empty
        expect(statuses.documents.status).toBe("empty")
        expect(statuses.documents.reasonCode).toBe("none")
        // knowledge: V2 envelope 无 released 快照——ready/empty（绝不 degraded）
        expect(statuses.knowledge.status).toBe("empty")
        expect(statuses.knowledge.reasonCode).toBe("none")
        expect(statuses.knowledge.rejectedCount).toBe(0)

        const resolvedDocs = yield* SessionContextResolverV2.resolveGraphs(
          envelope(resolvedIdentity, "architecture"),
          adapters,
          5_000,
        )
        expect(resolvedDocs.graphStatuses.documents.status).toBe("ready")
        expect(resolvedDocs.candidates.some((candidate) => candidate.graph === "documents")).toBe(true)

        // durable store 已接线：seeded memory doc 真实存在于 store 中
        expect(stores[0].documentStore.get(memoryDoc.id)).not.toBeNull()
        // memory/knowledge 的诚实状态（当前核心 V2 封装帧）：user 作用域 ref 被 subject_scope_denied、
        // 项目作用域 ref 因 legacyProjectId 未携带而不绑，且无 released 快照 —— graphs 均为
        // ready/empty（reasonCode none，绝不 degraded）
        const resolvedMemory = yield* SessionContextResolverV2.resolveGraphs(
          envelope(resolvedIdentity, "durable seed knowledge fact"),
          adapters,
          5_000,
        )
        expect(resolvedMemory.graphStatuses.memory.status).toBe("empty")
        expect(resolvedMemory.graphStatuses.memory.reasonCode).toBe("none")
        expect(resolvedMemory.graphStatuses.knowledge.status).toBe("empty")

        // W3.7 L5 — C6 readiness uses the SAME flag-gated adapter selection as the runner, so the
        // probe cannot split from real turns. W3.8.1 — the seam now carries the real frame
        // identity, and the readiness envelope is built with it (the same frame the V2 runner
        // builds), so the probe answers from the LIVE sources with the REAL scope — code is no
        // longer denied to `source_error` by the v2:local pin. Expected: code ∈ {ready, empty}
        // (the probe query "session context" has no fixture hit — honest empty), never
        // `degraded_unavailable(source_error)`.
        const readinessEnvelope = buildReadinessEnvelope(
          {
            id: SessionID.make("ses_w37"),
            slug: "w37-readiness",
            projectID: ProjectV2.ID.global,
            directory: root,
            title: "w37 readiness",
            version: "test",
            time: { created: 1, updated: 1 },
          },
          input.identity,
        )
        expect(readinessEnvelope.principal.securityNamespaceId).toBe(input.identity!.securityNamespaceId)
        expect(readinessEnvelope.location.locationKey).toBe(input.identity!.locationKey)
        expect(readinessEnvelope.projectScope.projectScopeKey).toBe(input.identity!.projectScopeKey)
        expect(readinessEnvelope.projectScope.projectId).toBe(input.identity!.legacyProjectId)
        const readinessResolved = yield* SessionContextResolverV2.resolveGraphs(
          readinessEnvelope,
          readinessAdapters(input),
          5_000,
        )
        const readinessGraphs = readinessResolved.graphStatuses
        console.log(
          `W3.8.1 real-frame readiness four-graph statuses: ${Object.entries(readinessGraphs)
            .map(([graph, record]) => `${graph}=${record.status}(${record.reasonCode}${record.rejectedCount > 0 ? `,rejected:${record.rejectedCount}` : ""})`)
            .join(" ")}`,
        )
        for (const [graph, record] of Object.entries(readinessGraphs)) {
          expect(record.reasonCode).not.toBe("source_disabled")
          expect(record.reasonCode).not.toBe("source_error")
          expect(["ready", "empty"]).toContain(record.status)
        }
      }).pipe(Effect.scoped),
    )
    resetKnowledgeSource()
  })

  test("flag=false falls back to staged adapters (existing behavior, sources ignored)", async () => {
    const original = process.env[CONTEXT_FEDERATION_PRODUCTION_ENV]
    try {
      process.env[CONTEXT_FEDERATION_PRODUCTION_ENV] = "false"
      expect(productionAdaptersEnabled()).toBe(false)
      const resolved = await Effect.runPromise(
        SessionContextResolverV2.resolveGraphs(envelope(envelopeIdentity(), "anything"), stagedV2Adapters(), 5_000),
      )
      for (const [graph, record] of Object.entries(resolved.graphStatuses)) {
        expect(record.status).toBe("degraded_unavailable")
        expect(record.reasonCode).toBe("source_disabled")
      }
    } finally {
      if (original === undefined) delete process.env[CONTEXT_FEDERATION_PRODUCTION_ENV]
      else process.env[CONTEXT_FEDERATION_PRODUCTION_ENV] = original
      expect(productionAdaptersEnabled()).toBe(true)
    }
  })

  test("location-layer seam forwards the outer ProductionV2Sources value (host injection mechanism)", async () => {
    // Replicates the core location-layer flow: a LayerMap lookup builds a location graph that
    // provides `productionV2SourcesLayer` into a runner reading `ProductionV2Sources` via
    // serviceOption (canonical-turn). A host app providing the real seam layer at its root must be
    // visible inside that lookup build context; absent it, the documented empty default holds.
    class LocationMap extends Context.Service<LocationMap, LayerMap.LayerMap<string, Runner, never>>()(
      "@test/LocationMap",
    ) {}
    class Runner extends Context.Service<Runner, { readonly value: string }>()("@test/Runner") {}
    const runner = Layer.effect(
      Runner,
      Effect.gen(function* () {
        const sources = yield* Effect.serviceOption(ProductionV2Sources)
        return Option.isSome(sources) && sources.value.code !== undefined
          ? { value: "forwarded" }
          : { value: "empty" }
      }),
    )
    const locationGraph = Layer.provide(runner, productionV2SourcesLayer)
    const lookup = (_key: string) => locationGraph
    const mapLayer = Layer.effect(
      LocationMap,
      Effect.gen(function* () {
        return yield* LayerMap.make(lookup)
      }),
    )
    const location = Layer.unwrap(
      Effect.gen(function* () {
        const map = yield* LocationMap
        return map.get("loc")
      }),
    )
    const probe = Effect.gen(function* () {
      return (yield* Runner).value
    })

    const withSeam = ManagedRuntime.make(
      Layer.provide(
        mapLayer,
        Layer.succeed(ProductionV2Sources, { code: { query: () => Effect.succeed({} as never) } }),
      ),
    )
    expect(await withSeam.runPromise(probe.pipe(Effect.provide(location)))).toBe("forwarded")
    await withSeam.dispose()

    const withoutSeam = ManagedRuntime.make(mapLayer)
    expect(await withoutSeam.runPromise(probe.pipe(Effect.provide(location)))).toBe("empty")
    await withoutSeam.dispose()
  })
})

describe("W3.8.1 production frame identity (deepagent-code side)", () => {
  test("identityFromHandle maps the handle identity and derives the legacy project id", () => {
    // registered_root (no observed project id): the canonical durable-knowledge derivation.
    expect(identityFromHandle({ identity: envelopeIdentity() })).toEqual({
      securityNamespaceId: ns,
      locationKey: LocationKey.make("loc_w37"),
      projectScopeKey: proj,
      legacyProjectId: projectIdForWorkspace(process.cwd()),
    })
    // git: the observed project id is the publisher's derivation — carried verbatim.
    const gitIdentity: Identity = {
      securityNamespaceId: ns,
      locationKey: LocationKey.make("loc_w37"),
      projectScopeKey: proj,
      indexSpaceId: IndexSpaceID.make("idx_w37"),
      canonicalRoot: AbsolutePath.make(process.cwd()),
      observedProjectId: "git-observed-42",
    }
    expect(identityFromHandle({ identity: gitIdentity })?.legacyProjectId).toBe("git-observed-42")
    // No handle => undefined => the v2:local degradation frame (never a fake).
    expect(identityFromHandle(undefined)).toBeUndefined()
  })

  test("no handle keeps the seam identity undefined and the readiness envelope pinned to v2:local", async () => {
    await using fixture = await tmpdir()
    const stateRoot = fixture.path
    const root = path.join(stateRoot, "repo")
    const database = Database.layerFromPath(path.join(stateRoot, "metadata.sqlite"))
    await Effect.runPromise(
      Effect.gen(function* () {
        const dbCtx = yield* Layer.build(database)
        const db = Context.get(dbCtx, Database.Service).db
        const runtime: LocationIndexRuntime.Interface = {
          init: () => Effect.void,
          current: () => Effect.succeed(undefined),
        }
        const code = { query: () => Effect.succeed({} as never) } as unknown as CodeQuery.Interface
        // Exactly the layer expression: identityFromHandle(yield* runtime.current()).
        const layerIdentity = yield* Effect.map(runtime.current(), identityFromHandle)
        expect(layerIdentity).toBeUndefined()
        const input = productionInput({ runtime, code, db, workspaceDirectory: root, identity: layerIdentity })
        expect(input.identity).toBeUndefined()
        const session = {
          id: SessionID.make("ses_w381"),
          slug: "w381-readiness",
          projectID: ProjectV2.ID.global,
          directory: root,
          title: "w381 readiness",
          version: "test",
          time: { created: 1, updated: 1 },
        }
        const envelope = buildReadinessEnvelope(session)
        expect(envelope.principal.securityNamespaceId).toBe(SecurityNamespaceID.make("v2:local"))
        expect(envelope.securityNamespace.securityNamespaceId).toBe(SecurityNamespaceID.make("v2:local"))
        expect(envelope.projectScope.projectScopeKey).toBe(ProjectScopeKey.make("v2:local"))
        expect(envelope.projectScope.projectId).toBe("v2:local")
        expect(envelope.location.locationKey).toBe(LocationKey.make(root))
      }).pipe(Effect.scoped),
    )
  })
})
