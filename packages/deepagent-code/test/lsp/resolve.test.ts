import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { LSPResolve } from "@/lsp/resolve"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// L2/L3 (S1-v3.4): symbol-name navigation, disambiguation, position fallback, no-server
// fallback, overview aggregation, relation depth + cycle detection. Drives the LSP.Service
// directly through the fake server; the code_intel tool wiring is covered separately.

const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")

const lspLayer = () =>
  LSP.layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.layer({})),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )

const it = testEffect(Layer.mergeAll(lspLayer(), CrossSpawnSpawner.defaultLayer))

const fakeServerConfig = (env: Record<string, string> = {}) => ({
  config: {
    lsp: {
      fake: { command: [process.execPath, fakeServerPath], extensions: [".repro"], env },
    },
  },
})

const write = (dir: string, name: string) =>
  Effect.gen(function* () {
    const file = path.join(dir, name)
    yield* Effect.promise(() => Bun.write(file, "export const foo = 1\nexport const bar = 2\n"))
    return file
  })

describe("L2 resolveSymbol", () => {
  // (a) resolve a symbol by name (workspaceSymbol path) → single coordinate.
  it.instance(
    "resolves a unique symbol name to a coordinate",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = yield* write(dir, "a.repro")
          yield* lsp.touchFile(file)
          const result = yield* LSPResolve.resolveSymbol({ lsp, symbol: "foo" })
          expect(result.type).toBe("resolved")
          if (result.type === "resolved") {
            expect(result.candidate.name).toBe("foo")
            expect(result.candidate.kindLabel).toBe("constant")
          }
        }),
      ),
    fakeServerConfig({
      FAKE_LSP_CONFIG: JSON.stringify({
        capabilities: { textDocumentSync: { change: 2 }, workspaceSymbolProvider: true },
        responses: {
          "workspace/symbol": [{ name: "foo", kind: 14, location: { uri: "file:///a.repro", range: range(0) } }],
        },
      }),
    }),
  )

  // (b) ambiguous symbol → candidate list, not a silent pick.
  it.instance(
    "returns disambiguation candidates for an ambiguous symbol",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = yield* write(dir, "b.repro")
          yield* lsp.touchFile(file)
          const result = yield* LSPResolve.resolveSymbol({ lsp, symbol: "foo" })
          expect(result.type).toBe("ambiguous")
          if (result.type === "ambiguous") expect(result.candidates.length).toBe(2)
        }),
      ),
    fakeServerConfig({
      FAKE_LSP_CONFIG: JSON.stringify({
        capabilities: { textDocumentSync: { change: 2 }, workspaceSymbolProvider: true },
        responses: {
          "workspace/symbol": [
            { name: "foo", kind: 12, location: { uri: "file:///a.repro", range: range(0) } },
            { name: "foo", kind: 12, location: { uri: "file:///b.repro", range: range(5) } },
          ],
        },
      }),
    }),
  )

  // kind filter narrows ambiguity.
  it.instance(
    "kind filter narrows an ambiguous symbol to one",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = yield* write(dir, "c.repro")
          yield* lsp.touchFile(file)
          const result = yield* LSPResolve.resolveSymbol({ lsp, symbol: "foo", kind: "class" })
          expect(result.type).toBe("resolved")
          if (result.type === "resolved") expect(result.candidate.kindLabel).toBe("class")
        }),
      ),
    fakeServerConfig({
      FAKE_LSP_CONFIG: JSON.stringify({
        capabilities: { textDocumentSync: { change: 2 }, workspaceSymbolProvider: true },
        responses: {
          "workspace/symbol": [
            { name: "foo", kind: 12, location: { uri: "file:///a.repro", range: range(0) } },
            { name: "foo", kind: 5, location: { uri: "file:///b.repro", range: range(5) } },
          ],
        },
      }),
    }),
  )

  // not found.
  it.instance(
    "returns not_found for an unknown symbol",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = yield* write(dir, "d.repro")
          yield* lsp.touchFile(file)
          const result = yield* LSPResolve.resolveSymbol({ lsp, symbol: "nonexistent" })
          expect(result.type).toBe("not_found")
        }),
      ),
    fakeServerConfig({
      FAKE_LSP_CONFIG: JSON.stringify({
        capabilities: { textDocumentSync: { change: 2 }, workspaceSymbolProvider: true },
        responses: { "workspace/symbol": [] },
      }),
    }),
  )
})

function range(line: number) {
  return { start: { line, character: 0 }, end: { line, character: 3 } }
}
