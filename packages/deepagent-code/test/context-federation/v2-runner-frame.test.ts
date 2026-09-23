import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Location } from "@deepagent-code/core/location"
import { AgentV2 } from "@deepagent-code/core/agent"
import {
  ProductionV2Sources,
  type ProductionV2AdapterInput,
} from "@deepagent-code/core/context-federation/production-adapters"
import { LocationIdentity } from "@deepagent-code/core/context-federation/identity"
import { SessionContext } from "@deepagent-code/core/context-federation/session-context"
import { SessionRunnerCanonical } from "@deepagent-code/core/session/runner/canonical-turn"
import { SessionRunner } from "@deepagent-code/core/session/runner"
import { V2ProviderTurn } from "@deepagent-code/core/session/runner/v2-provider-turn"
import { SessionSchema } from "@deepagent-code/core/session/schema"
import {
  IndexSpaceID,
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
} from "@deepagent-code/core/context-federation/reference"
import { SessionContextSelectionTable } from "@deepagent-code/core/context-federation/session-sql"
import { Database } from "@deepagent-code/core/database/database"
import { EventV2 } from "@deepagent-code/core/event"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { ToolRegistry } from "@deepagent-code/core/tool/registry"
import { Flag } from "@deepagent-code/core/flag/flag"
import {
  LocationRuntimeHost,
  LocationServiceMap,
  locationServiceMapDependencies,
} from "@deepagent-code/core/location-layer"
import { AgentGateway } from "@deepagent-code/core/agent-gateway"
import { CodeQuery } from "@deepagent-code/core/code-intelligence/query"
import { ContextToolRuntime } from "@deepagent-code/core/context-federation/tool-runtime"
import { ContextQueryAuthorization } from "@deepagent-code/core/context-federation/query-authorization"
import { LSP } from "@/lsp/lsp"
import { LocationIndexRuntime } from "@/location-index/runtime"
import { LocationIndexCoordinator } from "@/location-index/coordinator"
import { scan, isRepoDocument } from "@/location-index/manifest"
import { layer as bufferLayer } from "@/code-intelligence/editor-buffer-snapshot"
import { make as makeStore } from "@/code-intelligence/live-code-graph-store"
import { layer as queryLayer } from "@/code-intelligence/query-service"
import { indexWorkspace } from "@/code-intelligence/typescript-workspace-adapter"
import { make as makeDocumentStore } from "@/document-intelligence/live-repo-document-store"
import { indexMarkdown } from "@/document-intelligence/markdown-adapter"
import { ProductionSources } from "@/context-federation/production-sources"
import { V2RunnerFrame } from "@/session/v2-runner-frame"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { CodeIntelFacade } from "@/code-intelligence/facade"
import { ContextQueryFacade } from "@/context-federation/context-query-facade"
import { InstanceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { tmpdir } from "../fixture/fixture"
import path from "node:path"

// W3.10 acceptance (O-W3-10, B-review P0): the V2 runner selection frame must carry the REAL
// location identity — the same derivation the C6 readiness probe uses — instead of the v2:local pin
// that made the production code graph degrade to `source_error` (W3.8.1 claimed the runner frame;
// W3.9 proved the app-level seam cannot carry identity — no InstanceRef at build).
//
// This test reproduces the production flow at the host-hook seam:
//   1. the OUTER seam value is built EXACTLY as `productionSourcesLayer` builds it — real
//      code/documents sources, NO identity (the W3.9 reality);
//   2. `runnerFrameSeamFor(ref)` (the W3.10 host hook) is provided under an instance scope: it loads
//      the instance context for the ref directory, resolves `currentIdentity` (the SAME derivation
//      as the readiness probe) and overrides the seam with `{ ...base, identity }`;
//   3. `SessionRunnerCanonical.admitSelection` (the runner admission) runs under the hook and the
//      selection row must carry the REAL `security_namespace_id` (≠ "v2:local") with all four graphs
//      ∈ {ready, empty} — never `source_error`/`source_disabled`.

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

function missingLSP(): LSP.Interface {
  return {
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    workspaceSymbol: () => Effect.succeed([]),
  } as unknown as LSP.Interface
}

describe("W3.10 V2 runner frame host hook (deepagent-code composition)", () => {
  test("admitSelection binds the REAL identity frame with live four-graph sources (never v2:local)", async () => {
    await using fixture = await tmpdir()
    const stateRoot = fixture.path
    const root = path.join(stateRoot, "repo")
    await Bun.write(path.join(root, "src", "api.ts"), "export function computeAnswer(kind: string) { return kind }\n")
    await Bun.write(
      path.join(root, "src", "impl.ts"),
      "import { computeAnswer } from './api'\nexport function answerAggregator() { return computeAnswer('v2') }\n",
    )
    await Bun.write(path.join(root, "README.md"), "# Project Architecture\nshared design notes\n")

    const database = Database.layerFromPath(path.join(stateRoot, "metadata.sqlite"))
    const contexts = SessionContext.layer.pipe(Layer.provide(SessionRunnerCanonical.degradedArtifactStore))
    const sessionID = SessionSchema.ID.make("ses_w310")

    const program = Effect.gen(function* () {
      const ownedDatabase = yield* Database.Service
      // --- real location identity for the fixture directory (registered_root: the canonical
      // durable-knowledge derivation on the legacy project id) ---
      const identityCtx = yield* Layer.build(
        LocationIdentity.layer.pipe(
          Layer.provide(Layer.succeed(Database.Service, ownedDatabase)),
          Layer.provide(FSUtil.defaultLayer),
        ),
      )
      const resolvedIdentity = yield* Context.get(identityCtx, LocationIdentity.Service).resolve({
        boundary: { kind: "implicit_local" },
        directory: AbsolutePath.make(root),
        project: { kind: "registered_root" },
      })
      expect(resolvedIdentity.securityNamespaceId).not.toBe(SecurityNamespaceID.make("v2:local"))

      // --- real index stores + coordinator + live code query (the per-instance handle shape) ---
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
      const runtime = LocationIndexRuntime.Service.of({
        init: () => Effect.void,
        current: () => Effect.succeed({ identity: resolvedIdentity, coordinator }),
      })
      const codeLayer = queryLayer({ freshTimeoutMs: 200, lspTimeoutMs: 100 }).pipe(
        Layer.provide(Layer.succeed(LSP.Service, missingLSP())),
        Layer.provide(bufferLayer()),
        Layer.provide(Layer.succeed(LocationIndexRuntime.Service, runtime)),
      )
      const outerSeamLayer = Layer.unwrap(
        Effect.gen(function* () {
          const code = yield* Layer.build(codeLayer).pipe(Effect.map((built) => Context.get(built, CodeQuery.Service)))
          const value: ProductionV2AdapterInput = ProductionSources.productionInput({
            runtime,
            code,
            db: ownedDatabase.db,
            workspaceDirectory: root,
          })
          // W3.9 production reality: the OUTER seam carries NO identity (app-level build) — the
          // identity is added per location ref by the W3.10 host hook below.
          return Layer.succeed(ProductionV2Sources, value)
        }),
      )
      const outerSeam = yield* Layer.build(outerSeamLayer).pipe(
        Effect.map((built) => Context.get(built, ProductionV2Sources)),
      )
      const hookLayer = V2RunnerFrame.runnerFrameSeamFor(
        Location.Ref.make({ directory: AbsolutePath.make(root) }),
        outerSeam,
      )

      const admission = Effect.gen(function* () {
        // --- durable seats (session/input rows for the canonical admission) ---
        const db = (yield* Database.Service).db
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "w310",
            directory: root,
            title: "w310",
            version: "test",
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionInputTable)
          .values({
            id: SessionMessage.ID.make("msg_w310"),
            session_id: sessionID,
            admitted_seq: 1,
            prompt: new Prompt({ text: "trigger" }),
            delivery: "steer",
            promoted_seq: 1,
            time_created: 1,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)

        const admission = yield* SessionRunnerCanonical.admitSelection({
          db,
          contexts: yield* SessionContext.Service,
          sessionID,
          agent: "build",
          location: { directory: root },
          promotedInputIds: ["msg_w310"],
          system: { baseline: "baseline", revision: 0, baselineSeq: 1 },
          historyEndMessageId: "msg_w310",
        })

        const row = yield* db
          .select()
          .from(SessionContextSelectionTable)
          .where(eq(SessionContextSelectionTable.selection_id, admission.selectionId))
          .get()
          .pipe(Effect.orDie)
        // THE acceptance: the selection row carries the REAL frame — never the v2:local pin.
        expect(row?.security_namespace_id).toBe(resolvedIdentity.securityNamespaceId)
        expect(row?.security_namespace_id).not.toBe(SecurityNamespaceID.make("v2:local"))
        expect(row?.project_scope_key).toBe(resolvedIdentity.projectScopeKey)
        expect(row?.location_key).toBe(resolvedIdentity.locationKey)
        expect(row?.graph_revisions).not.toContain("v2:local")

        const statuses = JSON.parse(row?.graph_statuses ?? "{}") as Record<
          string,
          { status: string; reasonCode: string; rejectedCount?: number }
        >
        for (const [graph, record] of Object.entries(statuses)) {
          expect(record.reasonCode, `${graph} reasonCode`).not.toBe("source_error")
          expect(record.reasonCode, `${graph} reasonCode`).not.toBe("source_disabled")
          expect(["ready", "empty"], `${graph} status`).toContain(record.status)
        }
        // The code graph answers from the LIVE index under the REAL frame (the pre-W3.10 behavior
        // was source_error on the v2:local pin; honest empty when the "session context" query has no
        // fixture hit — never degraded, and the real frame below is the unlock).
        expect(["ready", "empty"]).toContain(statuses.code?.status)
        expect(statuses.code?.reasonCode).toBe("none")
      })
      return yield* admission.pipe(
        // The host-hook seam is the INNERMOST provide (the same ordering the passing no-handle
        // case uses): the hook's own requirements (base seam / index runtime / instance store)
        // resolve from the layers provided around it, and the admission sees the hook's
        // identity-enriched value (the LAST-WINS `ProductionV2Sources` in the environment).
        Effect.provide(hookLayer),
        Effect.provide(outerSeamLayer),
        Effect.provide(Layer.succeed(LocationIndexRuntime.Service, runtime)),
        Effect.provide(InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap))),
        Effect.provide(contexts),
      )
    }).pipe(Effect.provide(database), Effect.scoped)

    await Effect.runPromise(program)
  })

  test("host hook keeps identity undefined and honest v2:local degradation when no handle is attached", async () => {
    await using fixture = await tmpdir()
    const stateRoot = fixture.path
    const root = path.join(stateRoot, "repo")
    const database = Database.layerFromPath(path.join(stateRoot, "metadata.sqlite"))

    const program = Effect.gen(function* () {
      const runtime = LocationIndexRuntime.Service.of({
        init: () => Effect.void,
        current: () => Effect.succeed(undefined),
      })
      const db = Context.get(yield* Layer.build(database), Database.Service).db
      const code = { query: () => Effect.succeed({} as never) } as unknown as CodeQuery.Interface
      const outerSeam = ProductionSources.productionInput({ runtime, code, db, workspaceDirectory: root })
      const hookLayer = V2RunnerFrame.runnerFrameSeamFor(
        Location.Ref.make({ directory: AbsolutePath.make(root) }),
        outerSeam,
      )
      const seam = yield* Layer.build(hookLayer).pipe(
        Effect.map((built) => Context.get(built, ProductionV2Sources)),
        Effect.provide(InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap))),
        Effect.provide(Layer.succeed(LocationIndexRuntime.Service, runtime)),
      )
      // No handle => identity stays undefined => the v2:local degradation frame (never a fake).
      expect(seam.identity).toBeUndefined()
      expect(seam.code).toBeDefined()
    }).pipe(Effect.scoped)

    await Effect.runPromise(program)
  })

  test("explicit Core context tools execute inside the ref-owned instance frame", async () => {
    await using fixture = await tmpdir()
    const root = path.join(fixture.path, "repo")
    let observedDirectory: string | undefined
    const codeIntel = Layer.mock(CodeIntelFacade.Service, {
      execute: () =>
        Effect.gen(function* () {
          observedDirectory = (yield* InstanceRef)?.directory
          return codeIntelResult
        }),
    })
    const contextQuery = Layer.mock(ContextQueryFacade.Service, {
      execute: () => Effect.die("unused"),
    })
    const program = Effect.gen(function* () {
      const runtime = Context.get(
        yield* Layer.build(
          V2RunnerFrame.runnerFrameContextToolsFor(Location.Ref.make({ directory: AbsolutePath.make(root) })),
        ),
        ContextToolRuntime.Service,
      )
      const output = yield* runtime.codeIntel({
        request: { intent: "search", query: "host result" },
        sessionID: SessionSchema.ID.make("ses_v2_context_tool_frame"),
        agent: AgentV2.ID.make("researcher"),
      })
      expect(output).toContain("host result")
      expect(observedDirectory).toBe(root)
    }).pipe(
      Effect.provide(InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap))),
      Effect.provide(availableRuntime(root)),
      Effect.provide(codeIntel),
      Effect.provide(contextQuery),
      Effect.scoped,
    )
    await Effect.runPromise(program)
  })

  test("the keyed Location registry advertises graph tools only when a real index handle exists", async () => {
    await using fixture = await tmpdir()
    const unavailableRoot = path.join(fixture.path, "unavailable")
    const availableRoot = path.join(fixture.path, "available")
    await Bun.write(path.join(unavailableRoot, "README.md"), "# unavailable host\n")
    await Bun.write(path.join(availableRoot, "README.md"), "# available host\n")
    const previous = Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH
    Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = true
    try {
      let available = false
      const runtime = Layer.mock(LocationIndexRuntime.Service, {
        init: () => Effect.void,
        current: () => (available ? Effect.succeed(indexHandle(availableRoot)) : Effect.succeed(undefined)),
      })
      const host = V2RunnerFrame.runnerFrameHostLayer.pipe(
        Layer.provide(Layer.succeed(ProductionV2Sources, {})),
        Layer.provide(RuntimeFlags.defaultLayer),
        Layer.provide(InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap))),
        Layer.provide(runtime),
        Layer.provide(Layer.mock(CodeIntelFacade.Service, { execute: () => Effect.succeed(codeIntelResult) })),
        Layer.provide(Layer.mock(ContextQueryFacade.Service, { execute: () => Effect.die("unused") })),
        Layer.provide(ContextQueryAuthorization.defaultLayer),
      )
      const locations = LocationServiceMap.layerNoDeps.pipe(
        Layer.provide([
          ...locationServiceMapDependencies(
            host,
            Database.defaultLayer,
            EventV2.defaultLayer,
            AgentGateway.runtimeLayer({ enabled: false, agentMode: "high" }),
          ),
        ]),
      )
      const definitions = (root: string) =>
        Effect.runPromise(
          Effect.gen(function* () {
            return (yield* (yield* ToolRegistry.Service).materialize()).definitions.map((tool) => tool.name)
          }).pipe(
            Effect.provide(LocationServiceMap.get({ directory: AbsolutePath.make(root) })),
            Effect.provide(locations),
            Effect.scoped,
          ),
        )
      const unavailableDefinitions = await definitions(unavailableRoot)
      expect(unavailableDefinitions).not.toContain("code_intel")
      expect(unavailableDefinitions).not.toContain("context_query")
      available = true
      const availableDefinitions = await definitions(availableRoot)
      expect(availableDefinitions).toContain("code_intel")
      expect(availableDefinitions).toContain("context_query")
    } finally {
      Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = previous
    }
  }, 15_000)

  test("keyed Location trees bind query envelopes into the ONE store the host facades resolve", async () => {
    await using fixture = await tmpdir()
    const root = path.join(fixture.path, "repo")
    await Bun.write(path.join(root, "README.md"), "# shared authority store\n")
    const previous = Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH
    Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = true
    try {
      // Composed exactly like runnerFrameLocationMapLayer: the REAL graph facades plus
      // ContextQueryAuthorization.defaultLayer as the one process-local authority store.
      // Before the store moved to the LocationRuntimeHost seam, the keyed tree self-provided a
      // private store (Layer.fresh memo map), so every runner bind was invisible to the facades
      // and code_intel / context_query answered authorization_unavailable.
      const storeDeps = Layer.mergeAll(
        CodeIntelFacade.defaultLayer,
        ContextQueryFacade.defaultLayer,
        ContextQueryAuthorization.defaultLayer,
      )
      const host = V2RunnerFrame.runnerFrameHostLayer.pipe(
        Layer.provide(Layer.succeed(ProductionV2Sources, {})),
        Layer.provide(RuntimeFlags.defaultLayer),
        Layer.provide(InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap))),
        Layer.provide(LocationIndexRuntime.defaultLayer),
        Layer.provide(storeDeps),
      )
      const locations = LocationServiceMap.layerNoDeps.pipe(
        Layer.provide([
          ...locationServiceMapDependencies(
            host,
            Database.defaultLayer,
            EventV2.defaultLayer,
            AgentGateway.runtimeLayer({ enabled: false, agentMode: "high" }),
          ),
        ]),
      )
      class RootStore extends Context.Service<RootStore, { readonly resolve: ContextQueryAuthorization.Interface["resolve"] }>()(
        "v2-runner-frame-test/RootStore",
      ) {}
      // Root-scope capture of the store the facades were built with (the same memoized
      // ContextQueryAuthorization.defaultLayer build as storeDeps above).
      const rootStore = Layer.effect(
        RootStore,
        Effect.gen(function* () {
          return RootStore.of({ resolve: (yield* ContextQueryAuthorization.Service).resolve })
        }),
      ).pipe(Layer.provide(storeDeps))
      const program = Effect.gen(function* () {
        const captured = yield* RootStore
        const map = yield* LocationServiceMap
        const runtimeHost = yield* LocationRuntimeHost
        const ref = Location.Ref.make({ directory: AbsolutePath.make(root) })
        // The keyed tree closes its runner's query-authority requirement through this seam
        // (Layer.provide keeps seam outputs out of the tree output, so the runner consumes the
        // store at tree build). Prove the tree builds, then bind through the seam layer — the
        // exact environment the tree build feeds to the runner.
        yield* Effect.void.pipe(Effect.provide(map.get(ref)), Effect.scoped)
        yield* Effect.gen(function* () {
          const controller = yield* ContextQueryAuthorization.Controller
          yield* controller.bind({ sessionId: "ses_shared_store", envelope: sharedStoreEnvelope })
        }).pipe(
          Effect.provide(runtimeHost.layer(ref)),
          Effect.provide(AgentGateway.runtimeLayer({ enabled: false, durableLearning: false })),
          Effect.scoped,
        )
        // Facade-side view at the host graph: the SAME store must resolve the bound session.
        expect(yield* captured.resolve({ sessionId: "ses_shared_store", agent: "build" })).toBeDefined()
        expect(yield* captured.resolve({ sessionId: "ses_never_bound", agent: "build" })).toBeUndefined()
      }).pipe(Effect.provide(Layer.mergeAll(locations, rootStore, host)), Effect.scoped)
      await Effect.runPromise(program)
    } finally {
      Flag.DEEPAGENT_CODE_DISABLE_MODELS_FETCH = previous
    }
  }, 15_000)

  test("the host carries plan-gate and settle hooks into the keyed Location scope", async () => {
    await using fixture = await tmpdir()
    const root = path.join(fixture.path, "repo")
    await Bun.write(path.join(root, "README.md"), "# host hooks\n")
    let settled = 0
    const host = V2RunnerFrame.runnerFrameHostLayer.pipe(
      Layer.provide(Layer.succeed(ProductionV2Sources, {})),
      Layer.provide(RuntimeFlags.layer({ strictPlanGate: true })),
      Layer.provide(InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap))),
      Layer.provide(
        Layer.mock(LocationIndexRuntime.Service, {
          init: () => Effect.void,
          current: () => Effect.succeed(undefined),
        }),
      ),
      Layer.provide(Layer.mock(CodeIntelFacade.Service, { execute: () => Effect.succeed(codeIntelResult) })),
      Layer.provide(Layer.mock(ContextQueryFacade.Service, { execute: () => Effect.die("unused") })),
      Layer.provide(Layer.succeed(SessionRunner.CurrentOnSessionSettled, () => Effect.sync(() => settled++))),
      Layer.provide(Layer.succeed(V2ProviderTurn.CurrentHistoryEpochLookup, () => Effect.succeed(37))),
      Layer.provide(ContextQueryAuthorization.defaultLayer),
    )
    const program = Effect.gen(function* () {
      const runtimeHost = yield* LocationRuntimeHost
      yield* Effect.gen(function* () {
        const gate = yield* SessionRunner.CurrentToolSettleGate
        const onSessionSettled = yield* SessionRunner.CurrentOnSessionSettled
        const gateway = yield* AgentGateway.Runtime
        const historyEpochLookup = yield* V2ProviderTurn.CurrentHistoryEpochLookup
        const runtimeIdentityResolver = yield* V2ProviderTurn.CurrentRuntimeIntegrityIdentity
        expect(gate).toBeDefined()
        expect(onSessionSettled).toBeDefined()
        expect(historyEpochLookup).toBeDefined()
        expect(runtimeIdentityResolver).toBeDefined()
        if (!gate || !onSessionSettled || !historyEpochLookup || !runtimeIdentityResolver) return
        expect(yield* gate({ sessionID: "ses_host_gate", toolName: "edit", args: {} })).toMatchObject({
          kind: "block",
        })
        yield* onSessionSettled(
          {
            sessionID: SessionSchema.ID.make("ses_host_settle"),
            workspacePath: root,
          },
          gateway,
        )
        expect(yield* historyEpochLookup(SessionSchema.ID.make("ses_host_epoch"))).toBe(37)
      }).pipe(
        Effect.provide(runtimeHost.layer(Location.Ref.make({ directory: AbsolutePath.make(root) }))),
        Effect.provide(AgentGateway.runtimeLayer({ baseDir: root, durableLearning: false })),
      )
    }).pipe(Effect.provide(host), Effect.scoped)
    await Effect.runPromise(program)
    expect(settled).toBe(1)
  })
})

const sharedStoreEnvelope: ContextQueryAuthorization.Envelope = {
  principal: {
    securityNamespaceId: SecurityNamespaceID.make("sec_shared_store"),
    principalId: "local-user",
    authorizationEpoch: 1,
    locationKeys: [LocationKey.make("loc_shared_store")],
    projectScopeKeys: [ProjectScopeKey.make("prj_shared_store")],
    sessionIds: ["ses_shared_store"],
    subjectIds: ["local-user"],
    allowBuiltin: true,
  },
  egress: { policyId: "provider:shared-store", epoch: 1, graphs: ["code"], sensitivities: ["public"] },
}

const codeIntelResult: CodeIntelFacade.Result = {
  schemaVersion: 2,
  summary: "host result",
  index: {
    state: "ready",
    generation: 1,
    dirtyPathCount: 0,
    semanticCoverage: {},
    stale: false,
  },
  query: {
    status: { graph: "code", kind: "complete", state: "ready", outcome: "empty", revisions: [] },
    consistency: "stale_ok",
    freshnessSatisfied: true,
  },
  enrichment: { lsp: "not_applicable", editorOverlay: "not_applicable" },
  hits: [],
  truncated: false,
}

const indexHandle = (root: string) => ({
  identity: {
    securityNamespaceId: SecurityNamespaceID.make("sec_test_host"),
    locationKey: LocationKey.make(`loc_${root}`),
    projectScopeKey: ProjectScopeKey.make("prj_test_host"),
    indexSpaceId: IndexSpaceID.make("idx_test_host"),
    canonicalRoot: AbsolutePath.make(root),
  },
  // Registry availability only needs the durable handle to exist; query behavior is supplied by
  // the facade mocks in these tests.
  coordinator: {} as LocationIndexCoordinator.Interface,
})

const availableRuntime = (root: string) =>
  Layer.mock(LocationIndexRuntime.Service, {
    init: () => Effect.void,
    current: () => Effect.succeed(indexHandle(root)),
  })
