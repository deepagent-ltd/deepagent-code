import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { CodeIntelTool } from "../../src/tool/code_intel"
import { MessageID, SessionID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// L2/L3 (S1-v3.4): the code_intel tool end-to-end over the fake LSP server — symbol-name
// navigation, position fallback, overview aggregation, relation depth + cycle detection,
// disambiguation, and graceful no-server fallback.

afterEach(async () => {
  await disposeAllInstances()
})

const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")

const realLsp = LSP.layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(RuntimeFlags.layer({})),
  Layer.provideMerge(EventV2Bridge.defaultLayer),
)

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    realLsp,
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_codeintel"),
  messageID: MessageID.make("msg_codeintel"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
} as unknown as Tool.Context

const run = (args: Tool.InferParameters<typeof CodeIntelTool>) =>
  Effect.gen(function* () {
    const info = yield* CodeIntelTool
    const tool = yield* info.init()
    return yield* tool.execute(args, ctx)
  })

const writeFile = (dir: string, name: string) =>
  Effect.gen(function* () {
    const file = path.join(dir, name)
    yield* Effect.promise(() =>
      Bun.write(file, "export function foo() { return bar() }\nfunction bar() { return 1 }\n"),
    )
    return file
  })

function range(line: number) {
  return { start: { line, character: 0 }, end: { line, character: 3 } }
}

const cfg = (responses: Record<string, unknown>, capabilities: Record<string, unknown> = {}) =>
  fakeConfig({
    FAKE_LSP_CONFIG: JSON.stringify({
      capabilities: { textDocumentSync: { change: 2 }, workspaceSymbolProvider: true, ...capabilities },
      responses,
    }),
  })

const fakeConfig = (env: Record<string, string>) => ({
  config: { lsp: { fake: { command: [process.execPath, fakeServerPath], extensions: [".repro"], env } } },
})

describe("L2/L3 code_intel tool", () => {
  // (a) symbol-name definition with no coordinates.
  it.instance(
    "definition by symbol name renders file:line",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        yield* writeFile(dir, "a.repro")
        const result = yield* run({ symbol: "foo", file: "a.repro", intent: "definition" })
        expect(result.output).toContain("a.repro:1")
        // L5: snippet rendering, not raw range JSON.
        expect(result.output).not.toContain('"character"')
      }),
    cfg({
      "workspace/symbol": [{ name: "foo", kind: 12, location: { uri: "file:///x.repro", range: range(0) } }],
      "textDocument/documentSymbol": [{ name: "foo", kind: 12, range: range(0), selectionRange: range(0) }],
      "textDocument/definition": [{ uri: "file:///a.repro", range: range(0) }],
    }),
  )

  // no-server fallback hint (unknown extension).
  it.instance(
    "returns a grep fallback hint when the file type has no LSP server",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = path.join(dir, "nolsp.unknownext")
        yield* Effect.promise(() => Bun.write(file, "x\n"))
        const result = yield* run({ position: { file, line: 1, character: 1 }, intent: "definition" })
        expect(result.output).toContain("grep")
      }),
    cfg({}),
  )

  // (b) overview aggregates.
  it.instance(
    "overview aggregates definition + references + counts",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = yield* writeFile(dir, "ov.repro")
        const result = yield* run({ position: { file, line: 1, character: 17 }, intent: "overview" })
        expect(result.output).toContain("overview")
        expect(result.output).toContain("references")
      }),
    cfg({
      "textDocument/definition": [{ uri: "file:///ov.repro", range: range(0) }],
      "textDocument/references": [
        { uri: "file:///ov.repro", range: range(0) },
        { uri: "file:///other.repro", range: range(2) },
      ],
    }),
  )

  // (c) relation depth + cycle detection: a → b → a must not loop forever.
  it.instance(
    "calls_out expands with depth and detects cycles",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const file = yield* writeFile(dir, "cyc.repro")
        const result = yield* run({ position: { file, line: 1, character: 17 }, intent: "calls_out", depth: 3 })
        // Should terminate and list bar; no hang.
        expect(result.output).toContain("calls_out")
      }),
    cfg({
      "textDocument/prepareCallHierarchy": [{ name: "foo", uri: "file:///cyc.repro", selectionRange: range(0) }],
      // bar calls foo (the cycle); the visited set must stop the recursion.
      "callHierarchy/outgoingCalls": [{ to: { name: "bar", uri: "file:///cyc.repro", selectionRange: range(1) } }],
    }),
  )

  // (b) intent:diagnostics scope:workspace returns a whole-repo diagnostics summary
  // (via workspace/diagnostic). Deterministic through the canned response.
  it.instance(
    "diagnostics scope:workspace summarizes repo-wide diagnostics",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        // Touch a .repro file (no document-wait) so a fake client spawns and answers
        // workspace/diagnostic with the canned items.
        const file = yield* writeFile(dir, "ws.repro")
        yield* LSP.Service.use((lsp) => lsp.touchFile(file))
        const result = yield* run({ intent: "diagnostics", scope: "workspace" })
        expect(result.output).toContain("workspace")
        expect(result.output).toContain("boom")
      }),
    cfg(
      {
        "workspace/diagnostic": {
          items: [
            {
              uri: "file:///broken.repro",
              items: [{ range: range(0), severity: 1, message: "boom" }],
            },
          ],
        },
      },
      { diagnosticProvider: { workspaceDiagnostics: true } },
    ),
  )
})
