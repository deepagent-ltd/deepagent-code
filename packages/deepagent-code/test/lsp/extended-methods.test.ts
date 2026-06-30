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

// L1 (S1-v3.4): extended LSP raw-capability wrappers. These exercise the thin
// wrappers over `client.connection.sendRequest` against the fake server, plus the
// capability probe and graceful degradation. Acceptance (a)-(f) in docs/S1-v3.4.

const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")

const WORKSPACE_EDIT = {
  changes: {
    "file:///x.repro": [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "bar" },
    ],
  },
}

// Canned responses + advertised capabilities, injected into the fake server via env.
const FAKE_CONFIG = {
  responses: {
    "textDocument/typeDefinition": [
      { uri: "file:///x.repro", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
    ],
    "textDocument/inlayHint": [{ position: { line: 0, character: 10 }, label: ": Promise<User>" }],
    "textDocument/codeAction": [{ title: "Organize Imports", kind: "source.organizeImports" }],
    "textDocument/prepareTypeHierarchy": [{ name: "Base", kind: 11, uri: "file:///x.repro" }],
    "typeHierarchy/subtypes": [{ name: "Impl", kind: 5, uri: "file:///impl.repro" }],
    "typeHierarchy/supertypes": [{ name: "Super", kind: 11, uri: "file:///super.repro" }],
    "textDocument/rename": WORKSPACE_EDIT,
    "workspace/executeCommand": WORKSPACE_EDIT,
    "textDocument/documentHighlight": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }],
  },
  capabilities: {
    textDocumentSync: { change: 2 },
    typeDefinitionProvider: true,
    inlayHintProvider: true,
    codeActionProvider: true,
    typeHierarchyProvider: true,
    renameProvider: { prepareProvider: true },
  },
}

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
      fake: {
        command: [process.execPath, fakeServerPath],
        extensions: [".repro"],
        env,
      },
    },
  },
})

const writeAndTouch = (lsp: LSP.Interface, dir: string, name = "sample.repro") =>
  Effect.gen(function* () {
    const file = path.join(dir, name)
    yield* Effect.promise(() => Bun.write(file, "export const x = 1\n"))
    yield* lsp.touchFile(file)
    return file
  })

describe("L1 LSP extended methods", () => {
  // (a) typeDefinition / inlayHint / codeAction return non-empty structures when supported.
  it.instance(
    "typeDefinition/inlayHint/codeAction return non-empty results when the server supports them",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = yield* writeAndTouch(lsp, dir)
          const typeDef = yield* lsp.typeDefinition({ file, line: 0, character: 0 })
          const hints = yield* lsp.inlayHint({
            file,
            start: { line: 0, character: 0 },
            end: { line: 0, character: 20 },
          })
          const actions = yield* lsp.codeAction({
            file,
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          })
          expect(typeDef.length).toBeGreaterThan(0)
          expect(hints.length).toBeGreaterThan(0)
          expect(actions.length).toBeGreaterThan(0)
        }),
      ),
    fakeServerConfig({ FAKE_LSP_CONFIG: JSON.stringify(FAKE_CONFIG) }),
  )

  // (b) supertypes/subtypes return inheritance, distinct from call hierarchy.
  it.instance(
    "supertypes/subtypes return inheritance chain (type hierarchy, not call hierarchy)",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = yield* writeAndTouch(lsp, dir)
          const subs = yield* lsp.subtypes({ file, line: 0, character: 0 })
          const supers = yield* lsp.supertypes({ file, line: 0, character: 0 })
          expect(subs.some((s: any) => s.name === "Impl")).toBe(true)
          expect(supers.some((s: any) => s.name === "Super")).toBe(true)
        }),
      ),
    fakeServerConfig({ FAKE_LSP_CONFIG: JSON.stringify(FAKE_CONFIG) }),
  )

  // (c) server that returns null/empty for an unsupported method does not throw.
  it.instance(
    "unsupported methods return empty and do not throw (graceful degradation)",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = yield* writeAndTouch(lsp, dir)
          // No FAKE_LSP_CONFIG → fake server returns null for everything.
          const typeDef = yield* lsp.typeDefinition({ file, line: 0, character: 0 })
          const subs = yield* lsp.subtypes({ file, line: 0, character: 0 })
          const hints = yield* lsp.inlayHint({
            file,
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          })
          expect(typeDef).toEqual([])
          expect(subs).toEqual([])
          expect(hints).toEqual([])
        }),
      ),
    fakeServerConfig(),
  )

  // (d) rename + edit-producing executeCommand return WorkspaceEdit previews, no fs writes.
  it.instance(
    "rename and executeCommand return WorkspaceEdit previews without writing files",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = yield* writeAndTouch(lsp, dir)
          const before = yield* Effect.promise(() => Bun.file(file).text())
          const renameEdit = yield* lsp.rename({ file, line: 0, character: 13, newName: "bar" })
          const cmdEdit = yield* lsp.executeCommand("organizeImports", [file])
          const after = yield* Effect.promise(() => Bun.file(file).text())
          expect(renameEdit).toMatchObject({ changes: expect.anything() })
          expect(cmdEdit).toMatchObject({ changes: expect.anything() })
          // The file content must be untouched — Service only returns previews.
          expect(after).toBe(before)
        }),
      ),
    fakeServerConfig({ FAKE_LSP_CONFIG: JSON.stringify(FAKE_CONFIG) }),
  )

  // capability probe reflects advertised capabilities.
  it.instance(
    "serverCapabilities exposes advertised capabilities for the probe",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = yield* writeAndTouch(lsp, dir)
          const caps = yield* lsp.serverCapabilities(file)
          expect(caps?.typeHierarchyProvider).toBe(true)
          expect(caps?.inlayHintProvider).toBe(true)
        }),
      ),
    fakeServerConfig({ FAKE_LSP_CONFIG: JSON.stringify(FAKE_CONFIG) }),
  )

  // (f) no LSP server for the file type → hasClients=false, wrappers return empty gracefully.
  it.instance(
    "no LSP server: new methods return empty via hasClients=false (no degradation)",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = path.join(dir, "nolsp.unknownext")
          yield* Effect.promise(() => Bun.write(file, "x\n"))
          const has = yield* lsp.hasClients(file)
          expect(has).toBe(false)
          const typeDef = yield* lsp.typeDefinition({ file, line: 0, character: 0 })
          expect(typeDef).toEqual([])
          const caps = yield* lsp.serverCapabilities(file)
          expect(caps).toBeUndefined()
        }),
      ),
    fakeServerConfig({ FAKE_LSP_CONFIG: JSON.stringify(FAKE_CONFIG) }),
  )
})
