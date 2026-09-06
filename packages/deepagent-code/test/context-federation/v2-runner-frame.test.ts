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
import { SessionSchema } from "@deepagent-code/core/session/schema"
import { SecurityNamespaceID } from "@deepagent-code/core/context-federation/reference"
import { SessionContextSelectionTable } from "@deepagent-code/core/context-federation/session-sql"
import { Database } from "@deepagent-code/core/database/database"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { SessionMessage } from "@deepagent-code/core/session/message"
import { Prompt } from "@deepagent-code/core/session/prompt"
import { SessionInputTable, SessionTable } from "@deepagent-code/core/session/sql"
import { Project } from "@deepagent-code/core/project"
import { ProjectTable } from "@deepagent-code/core/project/sql"
import { CodeQuery } from "@deepagent-code/core/code-intelligence/query"
import { ContextToolRuntime } from "@deepagent-code/core/context-federation/tool-runtime"
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
    const contexts = SessionContext.layer.pipe(
      Layer.provide(SessionRunnerCanonical.degradedArtifactStore),
      Layer.provide(database),
    )
    const sessionID = SessionSchema.ID.make("ses_w310")

    const program = Effect.gen(function* () {
      // --- real location identity for the fixture directory (registered_root: the canonical
      // durable-knowledge derivation on the legacy project id) ---
      const identityCtx = yield* Layer.build(
        LocationIdentity.layer.pipe(Layer.provideMerge(database), Layer.provide(FSUtil.defaultLayer)),
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
          const db = Context.get(yield* Layer.build(database), Database.Service).db
          const value: ProductionV2AdapterInput = ProductionSources.productionInput({
            runtime,
            code,
            db,
            workspaceDirectory: root,
          })
          // W3.9 production reality: the OUTER seam carries NO identity (app-level build) — the
          // identity is added per location ref by the W3.10 host hook below.
          return Layer.succeed(ProductionV2Sources, value)
        }),
      )
      const hookLayer = V2RunnerFrame.runnerFrameSeamFor(Location.Ref.make({ directory: AbsolutePath.make(root) }))

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
          .values({ id: sessionID, project_id: Project.ID.global, slug: "w310", directory: root, title: "w310", version: "test" })
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
        Effect.provide(database),
      )
    }).pipe(Effect.scoped)

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
      const outerSeamLayer = Layer.succeed(
        ProductionV2Sources,
        ProductionSources.productionInput({ runtime, code, db, workspaceDirectory: root }),
      )
      const hookLayer = V2RunnerFrame.runnerFrameSeamFor(Location.Ref.make({ directory: AbsolutePath.make(root) }))
      const seam = yield* Layer.build(hookLayer).pipe(
        Effect.map((built) => Context.get(built, ProductionV2Sources)),
        Effect.provide(InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap))),
        Effect.provide(Layer.succeed(LocationIndexRuntime.Service, runtime)),
        Effect.provide(outerSeamLayer),
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
      execute: () => Effect.gen(function* () {
        observedDirectory = (yield* InstanceRef)?.directory
        return codeIntelResult
      }),
    })
    const contextQuery = Layer.mock(ContextQueryFacade.Service, {
      execute: () => Effect.die("unused"),
    })
    const program = Effect.gen(function* () {
      const runtime = Context.get(
        yield* Layer.build(V2RunnerFrame.runnerFrameContextToolsFor(Location.Ref.make({ directory: AbsolutePath.make(root) }))),
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
      Effect.provide(codeIntel),
      Effect.provide(contextQuery),
      Effect.scoped,
    )
    await Effect.runPromise(program)
  })
})

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
