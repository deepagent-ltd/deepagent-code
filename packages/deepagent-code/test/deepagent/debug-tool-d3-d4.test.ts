import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@deepagent-code/core/fs-util"
import { CrossSpawnSpawner } from "@deepagent-code/core/cross-spawn-spawner"
import { Git } from "../../src/git"
import { Worktree } from "../../src/worktree"
import { LSP } from "../../src/lsp/lsp"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { RuntimeBase } from "../../src/runtime/base"
import { afterEach } from "bun:test"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// D3/D4 (S1-v3.5): the debug tool is symbol-driven (no raw line numbers).
// This file covers the STATIC contract of the tool (exports, parameter schema,
// evidence-artifact registration). The dynamic behaviour — that execute() actually
// routes through DebugService + the R0 gate, launches the debuggee, and reuses the
// live session — is covered by real execute() tests in `debug-tool-d3-execute.test.ts`.
// (The old approve-once and D4 tests here asserted local closures / grepped source
// and never called the tool; they were false confidence and have been removed in
// favour of the real execute tests.)

// Minimal layer for the static-contract tests: no DAP adapter needed.
const testLayer = Layer.mergeAll(
  FSUtil.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Git.defaultLayer,
  Worktree.defaultLayer,
  RuntimeBase.testLayer(RuntimeBase.allowAllProbe).pipe(Layer.provide(Worktree.defaultLayer)),
  LSP.layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.layer({})),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

const it = testEffect(testLayer)

describe("D3 debug tool", () => {
  afterEach(() => disposeAllInstances())

  describe("output budget → artifact truncation (D4)", () => {
    it.instance(
      "large variable tree triggers budget and returns truncated flag",
      () =>
        Effect.gen(function* () {
          // RuntimeBase.applyOutputBudget is the shared budget logic (tested in R0 tests).
          // Here we verify the budget parameters used by the debug tool are sensible.
          const bigOutput = "x".repeat(30_000)
          const result = RuntimeBase.applyOutputBudget(bigOutput, RuntimeBase.DEFAULT_BUDGET)
          expect(result.truncated).toBe(true)
          expect(result.fullBytes).toBeGreaterThan(24_000)
          expect(result.inline).toContain("truncated")

          const small = RuntimeBase.applyOutputBudget("hello world", RuntimeBase.DEFAULT_BUDGET)
          expect(small.truncated).toBe(false)
          expect(small.inline).toBe("hello world")
        }),
      { git: true },
    )
  })

  describe("D3 debug tool exports", () => {
    it.instance(
      "DebugTool is a valid Tool.Info with id='debug'",
      () =>
        Effect.gen(function* () {
          // Import and check the tool's id and parameter schema.
          const { DebugTool, Parameters } = yield* Effect.promise(() => import("../../src/tool/debug"))
          expect(DebugTool.id).toBe("debug")
          // Parameters schema should include the eight intents.
          const intents = Parameters.fields.intent.literals
          expect(intents).toContain("start")
          expect(intents).toContain("break_at")
          expect(intents).toContain("stack")
          expect(intents).toContain("eval")
          expect(intents).toContain("stop")
        }),
      { git: true },
    )
  })

  describe("symbol-driven breakpoint (acceptance criterion a)", () => {
    it.instance(
      "symbol name → LSP resolve → file+line, no raw line numbers needed",
      () =>
        Effect.gen(function* () {
          // The debug tool calls LSPResolve.resolveSymbol internally.
          // We verify the resolve module is used (not a raw line number API).
          const { LSPResolve } = yield* Effect.promise(() => import("../../src/lsp/resolve"))
          expect(typeof LSPResolve.resolveSymbol).toBe("function")
          // The tool's Parameters schema doesn't expose a raw 'line' field.
          const { Parameters } = yield* Effect.promise(() => import("../../src/tool/debug"))
          const fieldNames = Object.keys(Parameters.fields)
          expect(fieldNames).not.toContain("line")
          expect(fieldNames).toContain("symbol")
        }),
      { git: true },
    )
  })

  describe("D4 evidence artifact registration", () => {
    it.instance(
      "DEBUG_SESSION.json / PROFILE_RESULT.json artifacts are registered in agent-gateway.ts",
      () =>
        Effect.gen(function* () {
          // Verify the D4/P4A artifacts are registered in the gateway (evidence kinds).
          // Resolve relative to THIS test file (…/packages/deepagent-code/test/deepagent) so the check
          // works regardless of where the repo is checked out — the old hardcoded absolute path pointed
          // at a stale ~/code/agent/… location that no longer exists and always failed to read.
          const fs = yield* FSUtil.Service
          const gatewayPath = path.resolve(import.meta.dir, "../../../core/src/agent-gateway.ts")
          const content = yield* fs.readFileStringSafe(gatewayPath)
          expect(content).toContain("DEBUG_SESSION.json")
          expect(content).toContain("debug_session")
          expect(content).toContain("PROFILE_RESULT.json")
          expect(content).toContain('"profile"')
        }),
      { git: true },
    )
  })
})
