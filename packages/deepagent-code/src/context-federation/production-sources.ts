export * as ProductionSources from "./production-sources"

import { CodeQuery } from "@deepagent-code/core/code-intelligence/query"
import {
  ProductionV2Sources,
  type ProductionDocumentsSource,
  type ProductionReleasedBinding,
  type ProductionV2AdapterInput,
} from "@deepagent-code/core/context-federation/production-adapters"
import { Database } from "@deepagent-code/core/database/database"
import { isConfigured, storesForWorkspace } from "@deepagent-code/core/deepagent/knowledge-source"
import { DeepAgentReleasedSnapshot } from "@deepagent-code/core/deepagent/released-snapshot"
import { Effect, Layer } from "effect"
import { LiveEditorBufferSnapshot } from "../code-intelligence/editor-buffer-snapshot"
import { LiveCodeQuery } from "../code-intelligence/query-service"
import { LSP } from "../lsp/lsp"
import { LocationIndexRuntime } from "../location-index/runtime"

// W3.7 — the deepagent-code production composition for the W3 `ProductionV2Sources` seam. It feeds
// the V2 runner's four-graph adapters with the LIVE sources of this server instance:
//
//   code       LiveCodeQuery over the current instance's LocationIndexCoordinator (graph + LSP
//              enrichment + cold bootstrap; per-query live, sensitivity/authorization guarded).
//   documents  the same coordinator's repo-document index (markdown suite incl. W10
//              `docs/deepagent/*`); search + mutation epoch are closed over the runtime handle so
//              they observe the index of the CURRENT instance at resolve time.
//   knowledge  the durable knowledge store pair (user-global + project-shared) via the canonical
//              `storesForWorkspace` accessor, plus the real released-snapshot picker — the
//              released-knowledge adapter serves the current authority (bound/drift semantics are
//              derived by the runner from the picker); no release head => ready/empty.
//   memory     the same store pair through the durable-memory adapter (W3.2: no store-level
//              generation counter yet — per-doc revisions ride the candidate refs).
//
// Honesty contract: anything not constructible degrades, never fakes. No `LocationIndexRuntime`
// handle (index flag off / instance not attached) makes code/documents unavailable through the
// production-adapters' catch; no configured knowledge base or release makes knowledge/memory
// ready/empty. The `=false` flag fallback (staged adapters) is core behavior and is unaffected by
// this layer.
//
// Scope note: the app composition passes `process.cwd()` as `workspaceDirectory` — the production
// topology is one server per project workspace (desktop/CLI spawn per project), and durable
// knowledge + released-snapshot scoping must be that workspace. The code/documents sources are
// per-call over `runtime.current()`, so they always observe the index of the instance the resolve
// runs under.

export function productionSourcesLayer(options: { readonly workspaceDirectory: string }) {
  return Layer.effect(
    ProductionV2Sources,
    Effect.gen(function* () {
      const runtime = yield* LocationIndexRuntime.Service
      const code = yield* CodeQuery.Service
      const db = (yield* Database.Service).db
      return productionInput({ runtime, code, db, workspaceDirectory: options.workspaceDirectory })
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        LiveCodeQuery.layer({ freshTimeoutMs: 750, lspTimeoutMs: 500 }).pipe(
          Layer.provide(LSP.defaultLayer),
          Layer.provide(LiveEditorBufferSnapshot.layer()),
        ),
        Database.defaultLayer,
      ),
    ),
    // The LiveCodeQuery sub-graph requires LocationIndexRuntime (mirrors
    // `federated-query-service.defaultLayer`); provided at the outer level so both the query layer
    // and the seam share the ONE memoized process runtime singleton.
    Layer.provide(LocationIndexRuntime.defaultLayer),
  )
}

/** Pure assembly (identity-agnostic): the same value the layer provides, constructible in tests. */
export function productionInput(input: {
  readonly runtime: LocationIndexRuntime.Interface
  readonly code: CodeQuery.Interface
  readonly db: Database.Interface["db"]
  readonly workspaceDirectory: string
}): ProductionV2AdapterInput {
  return {
    code: input.code,
    documents: documentsSource(input.runtime),
    knowledge: {
      stores: isConfigured() ? storesForWorkspace(input.workspaceDirectory) : [],
      released: {
        snapshotId: "",
        binding: "unavailable",
        current: releasedCurrent(input.db, input.runtime),
      },
    },
  }
}

/**
 * Repo-document search + mutation epoch over the current instance handle. A missing handle (index
 * runtime unavailable / flag off / no instance attached) fails the effect, which the
 * production-adapters turns into `documents:unavailable` — an honest degradation, never a fake.
 */
function documentsSource(runtime: LocationIndexRuntime.Interface): ProductionDocumentsSource {
  return {
    search: (input) =>
      Effect.gen(function* () {
        const handle = yield* requireHandle(runtime)
        return yield* handle.coordinator.searchDocuments({ query: input.query, limit: input.limit })
      }),
    mutationEpoch: () =>
      Effect.gen(function* () {
        const handle = yield* requireHandle(runtime)
        return yield* handle.coordinator.mutationEpoch?.() ?? Effect.succeed(0)
      }),
  }
}

function requireHandle(runtime: LocationIndexRuntime.Interface) {
  return Effect.gen(function* () {
    const handle = yield* runtime.current()
    if (!handle) return yield* Effect.fail(new Error("location index runtime unavailable"))
    return handle
  })
}

/**
 * Real released-knowledge picker: forwards the envelope scope to `DeepAgentReleasedSnapshot.current`
 * and degrades a missing/unreadable head to `undefined` (the knowledge adapter then reports
 * `released:none` — ready/empty, never degraded). The V2 envelope scope is the core W3 pin
 * (v2:local) today; the same picker serves the real location identity verbatim once the core
 * envelope carries it. Translating the scope here would silently bypass the released-snapshot
 * integrity contract (selection scope must match the query scope), so the picker stays a thin,
 * honest forwarder.
 */
function releasedCurrent(
  db: Database.Interface["db"],
  runtime: LocationIndexRuntime.Interface,
): ProductionReleasedBinding["current"] {
  return (scope) =>
    Effect.gen(function* () {
      // The picker needs the index handle only to keep the source honest: no instance attached
      // (index flag off / no run) means the turn's location authority is unavailable, so no
      // release can be bound for it either.
      const handle = yield* runtime.current()
      if (!handle) return undefined
      return yield* DeepAgentReleasedSnapshot.current(db, scope).pipe(Effect.catch(() => Effect.succeed(undefined)))
    })
}
