import { describe, expect, test } from "bun:test"
import { EditorBufferSnapshot } from "@deepagent-code/core/code-intelligence/editor-buffer"
import { CodeQuery } from "@deepagent-code/core/code-intelligence/query"
import type { Identity } from "@deepagent-code/core/context-federation/identity"
import {
  IndexSpaceID,
  LocationKey,
  ProjectScopeKey,
  SecurityNamespaceID,
} from "@deepagent-code/core/context-federation/reference"
import { AbsolutePath } from "@deepagent-code/core/schema"
import { Effect, Layer } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { layer as bufferLayer } from "../../src/code-intelligence/editor-buffer-snapshot"
import { make as makeStore } from "../../src/code-intelligence/live-code-graph-store"
import { layer as queryLayer } from "../../src/code-intelligence/query-service"
import { indexWorkspace } from "../../src/code-intelligence/typescript-workspace-adapter"
import { LSP } from "../../src/lsp/lsp"
import { LocationIndexCoordinator } from "../../src/location-index/coordinator"
import { scan } from "../../src/location-index/manifest"
import { LocationIndexRuntime } from "../../src/location-index/runtime"
import { tmpdir } from "../fixture/fixture"

const namespace = SecurityNamespaceID.make("sec_code_query")
const location = LocationKey.make("loc_code_query")
const project = ProjectScopeKey.make("prjctx_code_query")

describe("LiveCodeQuery", () => {
  test("returns graph results without LSP and traverses call edges", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "leaf.ts"), "export function callsC() { return 1 }\n")
    await Bun.write(path.join(tmp.path, "callee.ts"), "import { callsC } from './leaf'\nexport function callsB() { return callsC() }\n")
    await Bun.write(path.join(tmp.path, "caller.ts"), "import { callsB } from './callee'\nexport function callsA() { return callsB() }\n")
    const harness = await makeHarness(tmp.path, missingLSP())
    try {
      const search = await harness.run(request("search", { query: "callsA" }))
      expect(search.status).toMatchObject({ kind: "complete", state: "ready", outcome: "matched" })
      expect(search.enrichment.lsp).toBe("unavailable")
      expect(search.hits[0]?.sources).toContain("graph")
      expect(search.hits[0]?.sources).toContain("filesystem")

      const oneHop = await harness.run(request("calls_out", { symbol: "callsA", depth: 1 }))
      expect(oneHop.hits.some((hit) => hit.symbol === "callsC")).toBe(false)
      const calls = await harness.run(request("calls_out", { symbol: "callsA", depth: 2 }))
      expect(calls.hits.some((hit) => hit.symbol === "callsB" && hit.relation === "calls")).toBe(true)
      expect(calls.hits.some((hit) => hit.symbol === "callsC" && hit.relation === "calls")).toBe(true)
      const callsB = calls.hits.find((hit) => hit.symbol === "callsB")
      expect(callsB?.direction).toBe("outgoing")
      expect(callsB?.degree).toMatchObject({ callsIn: 1, callsOut: 1 })

      const callers = await harness.run(request("calls_in", { symbol: "callsB", depth: 1 }))
      const callsA = callers.hits.find((hit) => hit.symbol === "callsA")
      expect(callsA?.direction).toBe("incoming")
      expect(callsA?.degree).toMatchObject({ callsIn: 0, callsOut: 1 })
    } finally {
      harness.close()
    }
  })

  test("prefers current source, marks a graph hash conflict stale, and schedules reindexing", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "source.ts"), "export const graphConflictNeedle = 'old'\n")
    const harness = await makeHarness(tmp.path, missingLSP())
    try {
      await Bun.write(path.join(tmp.path, "source.ts"), "export const graphConflictNeedle = 'current'\n")
      const result = await harness.run(request("search", { query: "graphConflictNeedle" }))
      expect(result.index.stale).toBe(true)
      expect(result.hits[0]?.snippet).toContain("current")
      expect(result.hits[0]?.contentSha).toBeUndefined()
      expect(harness.observed).toEqual(["source.ts"])
    } finally {
      harness.close()
    }
  })

  test("returns live LSP evidence while the graph is cold", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "live.ts"), "export const actualSource = true\n")
    const identity = identityFor(tmp.path)
    const coordinator = coldCoordinator()
    const app = queryLayer({ freshTimeoutMs: 100, lspTimeoutMs: 100 }).pipe(
      Layer.provide(Layer.succeed(LocationIndexRuntime.Service, LocationIndexRuntime.Service.of({
        init: () => Effect.void,
        current: () => Effect.succeed({ identity, coordinator }),
      }))),
      Layer.provide(Layer.succeed(LSP.Service, service({
        status: () => Effect.succeed([{ id: "ts", name: "ts", root: "", status: "connected" }]),
        workspaceSymbol: () => Effect.succeed([{
          name: "lspOnlyNeedle",
          kind: 12,
          location: {
            uri: pathToFileURL(path.join(tmp.path, "live.ts")).href,
            range: { start: { line: 0, character: 13 }, end: { line: 0, character: 25 } },
          },
        }]),
      }))),
      Layer.provide(bufferLayer()),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* CodeQuery.Service).query(request("search", { query: "lspOnlyNeedle" }))
      }).pipe(Effect.provide(app), Effect.scoped),
    )

    expect(result.status).toMatchObject({ kind: "partial", state: "cold", reasonCode: "cold_start" })
    expect(result.fallback).toEqual({ from: "graph", reasonCode: "cold_start" })
    expect(result.hits[0]).toMatchObject({ file: "live.ts", symbol: "lspOnlyNeedle" })
    expect(result.hits[0]?.sources).toEqual(["lsp", "filesystem"])
  })
})

async function makeHarness(root: string, lsp: LSP.Interface) {
  const identity = identityFor(root)
  const store = makeStore({
    filename: path.join(root, "code.sqlite"),
    indexSpaceId: identity.indexSpaceId,
    indexIncarnation: 1,
    canonicalRoot: root,
    adapterSetVersion: "ts-js-v1",
  })
  store.fullCommit({
    indexIncarnation: 1,
    fencingToken: 1,
    expectedGeneration: 0,
    indexedAt: Date.now(),
    build: indexWorkspace({ root, files: (await scan({ root })).files }),
  })
  const observed: string[] = []
  const coordinator = LocationIndexCoordinator.Service.of({
    initialize: () => Effect.void,
    observe: (input) => Effect.sync(() => observed.push(path.basename(input.file))),
    observeRename: () => Effect.void,
    requestReconciliation: () => Effect.void,
    drain: () => Effect.void,
    codeStatus: () => Effect.sync(() => store.status()),
    searchCode: (input) => Effect.sync(() => store.search(input)),
    codeNeighbors: (input) => Effect.sync(() => store.neighbors(input)),
    searchDocuments: () => Effect.succeed({ revision: undefined, hits: [] }),
    lookupDocuments: () => Effect.succeed({ revision: undefined, hits: [] }),
    pause: () => Effect.void,
    retire: () => Effect.void,
  })
  const app = queryLayer({ freshTimeoutMs: 100, lspTimeoutMs: 100 }).pipe(
    Layer.provide(Layer.succeed(LocationIndexRuntime.Service, LocationIndexRuntime.Service.of({
      init: () => Effect.void,
      current: () => Effect.succeed({ identity, coordinator }),
    }))),
    Layer.provide(Layer.succeed(LSP.Service, lsp)),
    Layer.provide(bufferLayer()),
  )
  return {
    observed,
    close: () => store.close(),
    run: (input: CodeQuery.Request) => Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* CodeQuery.Service).query(input)
      }).pipe(Effect.provide(app), Effect.scoped),
    ),
  }
}

function coldCoordinator(): LocationIndexCoordinator.Interface {
  return {
    initialize: () => Effect.void,
    observe: () => Effect.void,
    observeRename: () => Effect.void,
    requestReconciliation: () => Effect.void,
    drain: () => Effect.void,
    codeStatus: () => Effect.succeed({ state: "cold", generation: 0, dirtyPathCount: 0, semanticCoverage: {} }),
    searchCode: () => Effect.succeed({ revision: undefined, hits: [] }),
    codeNeighbors: () => Effect.succeed({ revision: undefined, hits: [] }),
    searchDocuments: () => Effect.succeed({ revision: undefined, hits: [] }),
    lookupDocuments: () => Effect.succeed({ revision: undefined, hits: [] }),
    pause: () => Effect.void,
    retire: () => Effect.void,
  }
}

function missingLSP() {
  return service({ status: () => Effect.succeed([]) })
}

function service(overrides: Partial<LSP.Interface>) {
  return {
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    workspaceSymbol: () => Effect.succeed([]),
    ...overrides,
  } as unknown as LSP.Interface
}

function identityFor(root: string): Identity {
  return {
    securityNamespaceId: namespace,
    locationKey: location,
    projectScopeKey: project,
    indexSpaceId: IndexSpaceID.make("idx_code_query"),
    canonicalRoot: AbsolutePath.make(root),
  }
}

function request(
  intent: CodeQuery.Request["intent"],
  input: { readonly query?: string; readonly symbol?: string; readonly depth?: number },
): CodeQuery.Request {
  return {
    intent,
    ...input,
    limit: 10,
    consistency: "stale_ok",
    sessionId: "session",
    principal: {
      securityNamespaceId: namespace,
      principalId: "principal",
      authorizationEpoch: 1,
      locationKeys: [location],
      projectScopeKeys: [project],
      sessionIds: ["session"],
      subjectIds: [],
      allowBuiltin: false,
    },
    egress: {
      policyId: "test",
      epoch: 1,
      graphs: ["code"],
      sensitivities: ["source_code"],
    },
  }
}
