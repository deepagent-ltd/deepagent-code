import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { parseModule, rootRepoPath } from "../script/caller-inventory/ast"
import { bodyScopes, edges, verifyRequirements } from "../script/caller-inventory/graph"

test("runtime graph excludes type-only imports and retains mixed, side-effect and dynamic imports", () => {
  const directory = mkdtempSync(join(tmpdir(), "dac-caller-runtime-"))
  const file = join(directory, "imports.ts")
  try {
    writeFileSync(file, [
      'import type { Session } from "@deepagent-code/core/session"',
      'import { type SessionInput } from "@deepagent-code/core/session/input"',
      'import { type Session, SessionV2 } from "@deepagent-code/core/session"',
      'import "@deepagent-code/core/session/input"',
      'void import("@deepagent-code/core/session/projector")',
      'export { type Session } from "@deepagent-code/core/session"',
      'export { type Session, SessionV2 } from "@deepagent-code/core/session"',
    ].join("\n"))
    expect(edges(file).map((edge) => ({ line: edge.line, file: relative(rootRepoPath(), edge.target) }))).toEqual([
      { line: 3, file: "packages/core/src/session.ts" },
      { line: 7, file: "packages/core/src/session.ts" },
      { line: 4, file: "packages/core/src/session/input.ts" },
      { line: 5, file: "packages/core/src/session/projector.ts" },
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("named function proof stays inside the declared health reader", () => {
  const directory = mkdtempSync(join(tmpdir(), "dac-caller-health-"))
  const file = join(directory, "health.ts")
  try {
    writeFileSync(file, [
      'async function checkHealth() { const res = await fetch("/global/health"); return res.ok }',
      'async function unrelated() { await SessionV2.prompt(); utilityProcess.fork("./sidecar.js") }',
    ].join("\n"))
    const scope = bodyScopes([{ name: "health", line: 1, bodyDecl: "checkHealth",
      repoFile: relative(rootRepoPath(), file) }])
    expect(scope.chains.has("res.ok")).toBe(true)
    expect(scope.chains.has("SessionV2.prompt")).toBe(false)
    expect(scope.chains.has("utilityProcess.fork")).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("body and module proofs retain calls through transparent TypeScript expression wrappers", () => {
  const directory = mkdtempSync(join(tmpdir(), "dac-caller-wrapped-"))
  const file = join(directory, "wrapped.ts")
  try {
    writeFileSync(file, [
      'export function invoke() {',
      '  dac!.submit();',
      '  (dac as Adapter).binding();',
      '  (dac satisfies Adapter).command();',
      '  (<Adapter>dac).cancel();',
      '}',
      'const unused = () => foreign!.submit()',
      'const text = "fake!.prompt()" // comment!.prompt()',
    ].join("\n"))
    const module = parseModule(file)
    const scope = bodyScopes([{ name: "invoke", line: 1, bodyDecl: "invoke",
      repoFile: relative(rootRepoPath(), file) }])
    for (const method of ["submit", "binding", "command", "cancel"]) {
      expect(module.refLines.has(`dac.${method}`)).toBe(true)
      expect(scope.chains.has(`dac.${method}`)).toBe(true)
    }
    expect(scope.chains.has("foreign.submit")).toBe(false)
    expect(scope.chains.has("fake.prompt")).toBe(false)
    expect(scope.chains.has("comment.prompt")).toBe(false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("physical sidecar delegation follows actual const URL arguments, never unused or mutable decoys", () => {
  const directory = mkdtempSync(join(tmpdir(), "dac-caller-sidecar-"))
  try {
    const cases = [
      { name: "fork", source: 'const url = new URL("./sidecar.js", import.meta.url); const file = fileURLToPath(url); utilityProcess.fork(file)', bound: true },
      { name: "import", source: 'const url = new URL("./chunks/node.js", import.meta.url); void import(url.href)', bound: true },
      { name: "unused", source: 'const unused = new URL("./chunks/node.js", import.meta.url); void import("./unrelated.js")', bound: false },
      { name: "mutable", source: 'let url = new URL("./chunks/node.js", import.meta.url); url = elsewhere; void import(url.href)', bound: false },
      { name: "decoy", source: 'const url = unrelated("./chunks/node.js"); void import(url.href)', bound: false },
    ]
    for (const item of cases) {
      const file = join(directory, item.name + ".ts")
      writeFileSync(file, 'import { fileURLToPath } from "node:url"\n' + item.source)
      const proof = verifyRequirements(file, [{ kind: "delegatesTo", targetId: "composition.dacode-node-server" }])
      expect(proof.satisfied).toBe(item.bound)
      if (item.bound) expect(proof.evidence[0].line).toBe(2)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("body proof follows yielded authentication Effects without crediting unused declarations", () => {
  const directory = mkdtempSync(join(tmpdir(), "dac-caller-effect-"))
  const file = join(directory, "handlers.ts")
  try {
    writeFileSync(file, [
      'const authenticate = Effect.gen(function* () { yield* Authority.authenticateOperator() })',
      'const unrelated = Effect.succeed("unrelated")',
      'handlers.handle("direct", Effect.fn(function* () { yield* authenticate }))',
      'handlers.handle("piped", Effect.fn(function* () { yield* authenticate.pipe(Effect.mapError(String)) }))',
      'handlers.handle("unused", Effect.fn(function* () { yield* unrelated }))',
    ].join("\n"))
    const scope = (line: number) => bodyScopes([{ name: "probe", group: "probe", line,
      repoFile: relative(rootRepoPath(), file) }])
    expect(scope(3).chains.has("Authority.authenticateOperator")).toBe(true)
    expect(scope(4).chains.has("Authority.authenticateOperator")).toBe(true)
    expect(scope(5).chains.has("Authority.authenticateOperator")).toBe(false)
    expect(scope(5).chains.has("Effect.succeed")).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
