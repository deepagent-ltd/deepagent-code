import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LSP } from "@/lsp/lsp"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// L4 (S1-v3.4): workspace-level diagnostic pull. workspace/diagnostic where the server
// advertises diagnosticProvider, else graceful fallback to aggregating known per-file
// diagnostics. Never throws.

const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")

const lspLayer = () =>
  LSP.layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.layer({})),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
  )

const it = testEffect(Layer.mergeAll(lspLayer(), CrossSpawnSpawner.defaultLayer))

const fakeServerConfig = (env: Record<string, string> = {}) => ({
  config: { lsp: { fake: { command: [process.execPath, fakeServerPath], extensions: [".repro"], env } } },
})

const write = (dir: string, name: string) =>
  Effect.gen(function* () {
    const file = path.join(dir, name)
    yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
    return file
  })

describe("L4 workspace diagnostics", () => {
  // workspace/diagnostic pull when the server advertises diagnosticProvider.
  it.instance(
    "pulls workspace diagnostics via workspace/diagnostic when supported",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = yield* write(dir, "ws.repro")
          yield* lsp.touchFile(file)
          const result = yield* lsp.workspaceDiagnostics()
          const allDiags = Object.values(result).flat()
          expect(allDiags.length).toBeGreaterThan(0)
        }),
      ),
    fakeServerConfig({
      FAKE_LSP_CONFIG: JSON.stringify({
        capabilities: { textDocumentSync: { change: 2 }, diagnosticProvider: { workspaceDiagnostics: true } },
        responses: {
          "workspace/diagnostic": {
            items: [
              {
                uri: "file:///ws.repro",
                items: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                    severity: 1,
                    message: "boom",
                  },
                ],
              },
            ],
          },
        },
      }),
    }),
  )

  // graceful fallback: server without diagnosticProvider → aggregate known diagnostics, no throw.
  it.instance(
    "falls back without throwing when workspace/diagnostic is unsupported",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = yield* write(dir, "wsfb.repro")
          yield* lsp.touchFile(file)
          // No diagnosticProvider advertised → fallback path; should return an object, not throw.
          const result = yield* lsp.workspaceDiagnostics()
          expect(typeof result).toBe("object")
        }),
      ),
    fakeServerConfig({
      FAKE_LSP_CONFIG: JSON.stringify({ capabilities: { textDocumentSync: { change: 2 } }, responses: {} }),
    }),
  )
})
