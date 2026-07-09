import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openProjectStore, openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"
import type { DurableKnowledgeStore } from "../../src/deepagent/durable-knowledge-store"
import { indexFiles, registerFile, indexSymbols, linkCallEdges, symbolNodeKey } from "../../src/deepagent/code-indexer"
import type { SymbolExtraction } from "../../src/deepagent/code-indexer"
import type { CreateDocInput, DocType, Provenance } from "../../src/deepagent/document-store"
import { createHash } from "node:crypto"

// V3.8 Phase 3 (v3.8.1 §B.3): the minimal lightweight code indexer. Proves it registers code_symbol
// nodes, builds code→doc `references` edges on EXPLICIT path evidence (same store only, INV-3), and
// that the content-sha version-bloat mitigation keeps re-indexing an unchanged tree idempotent.

const prov: Provenance = { source: "runner", run_ref: "run:t", evidence_refs: [] }
let base: string
const WORK = "/work/repo-indexer"

const node = (store: DurableKnowledgeStore, type: DocType, description: string, over: Partial<CreateDocInput> = {}) =>
  store.documentStore.create({
    type,
    scope: "durable",
    body: over.body ?? description,
    description,
    domain: null,
    tags: [],
    links: [],
    provenance: prov,
    ...(over.idSlug ? { idSlug: over.idSlug } : {}),
  }).id

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "deepagent-indexer-"))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe("code-indexer (Phase 3)", () => {
  it("registers files as code_symbol nodes", () => {
    const proj = openProjectStore(base, WORK)
    const result = indexFiles(proj, [
      { path: "src/a.ts", content: "export const a = 1" },
      { path: "src/b.ts", content: "export const b = 2" },
    ])
    expect(result.created).toBe(2)
    const codeRefs = proj.documentStore.list({ type: "code_symbol" })
    expect(codeRefs.map((r) => r.description).sort()).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("builds a code→doc references edge on explicit path evidence (same store)", () => {
    const proj = openProjectStore(base, WORK)
    // A design doc that explicitly references the file path.
    const designId = node(proj, "design", "retry design", { body: "see src/retry.ts for the impl" })
    const result = indexFiles(proj, [{ path: "src/retry.ts", content: "export function retry() {}" }])
    expect(result.edgesCreated).toBe(1)

    const codeId = result.nodeIds[0]!
    const links = proj.documentStore.get(codeId)!.links
    expect(links).toContainEqual(expect.objectContaining({ rel: "references", to: designId }))
  })

  it("does not link across physical stores (INV-3: same-store edges only)", () => {
    const proj = openProjectStore(base, WORK)
    const ug = openUserGlobalStore(base)
    // The doc that references the path lives in the USER-GLOBAL store, not the project store.
    node(ug, "design", "global design", { body: "references src/only.ts" })
    const result = indexFiles(proj, [{ path: "src/only.ts", content: "export const only = true" }])
    // No same-store doc mentions the path → no edge (and no cross-store link attempt / throw).
    expect(result.edgesCreated).toBe(0)
    const codeId = result.nodeIds[0]!
    expect(proj.documentStore.get(codeId)!.links).toEqual([])
  })

  it("content-sha gating: re-indexing an unchanged tree creates ZERO new versions", () => {
    const proj = openProjectStore(base, WORK)
    const files = [{ path: "src/x.ts", content: "export const x = 1" }]

    const first = indexFiles(proj, files, { buildDocEdges: false })
    expect(first.created).toBe(1)
    const id = first.nodeIds[0]!
    const v1 = proj.documentStore.get(id)!.version

    // Re-index the SAME content many times.
    for (let i = 0; i < 5; i++) {
      const again = indexFiles(proj, files, { buildDocEdges: false })
      expect(again.unchanged).toBe(1)
      expect(again.created).toBe(0)
      expect(again.updated).toBe(0)
    }
    // Version did not advance despite repeated re-index passes.
    expect(proj.documentStore.get(id)!.version).toBe(v1)
  })

  it("a genuine content change bumps the version exactly once", () => {
    const proj = openProjectStore(base, WORK)
    const first = registerFile(proj, { path: "src/y.ts", content: "v1" })
    expect(first.outcome).toBe("created")
    const v1 = proj.documentStore.get(first.id)!.version

    const changed = registerFile(proj, { path: "src/y.ts", content: "v2 different" })
    expect(changed.outcome).toBe("updated")
    expect(changed.id).toBe(first.id)
    expect(proj.documentStore.get(first.id)!.version).toBe(v1 + 1)

    // Re-registering the changed content is now a no-op again.
    const noop = registerFile(proj, { path: "src/y.ts", content: "v2 different" })
    expect(noop.outcome).toBe("unchanged")
    expect(proj.documentStore.get(first.id)!.version).toBe(v1 + 1)
  })

  it("content sha is authoritative: changed content with a STALE (non-advancing) mtime is NOT skipped", () => {
    // mtime must never mask a genuine content change — git checkout/stash/rebase rewind mtimes, so a
    // changed file can carry an older-or-equal mtime. The indexer keys on content sha, not mtime.
    const proj = openProjectStore(base, WORK)
    const created = registerFile(proj, { path: "src/z.ts", content: "orig", mtimeMs: 1000 })
    const v1 = proj.documentStore.get(created.id)!.version
    // Same (non-advancing) mtime but DIFFERENT content → still an update, version bumps.
    const updated = registerFile(proj, { path: "src/z.ts", content: "changed but stale mtime", mtimeMs: 1000 })
    expect(updated.outcome).toBe("updated")
    expect(proj.documentStore.get(created.id)!.version).toBe(v1 + 1)
    expect(proj.documentStore.get(created.id)!.body).toContain("changed but stale mtime")
    // Re-registering the same content is idempotent regardless of mtime.
    const noop = registerFile(proj, { path: "src/z.ts", content: "changed but stale mtime", mtimeMs: 999 })
    expect(noop.outcome).toBe("unchanged")
    expect(proj.documentStore.get(created.id)!.version).toBe(v1 + 1)
  })
})

// V3.9 §A: AST-level symbol index. indexSymbols is PURE (consumes already-extracted symbol data, no
// LSP) so these tests hand-build SymbolExtraction fixtures. Proves: symbol child nodes + contains
// edges, file→file imports edges, symbol→symbol calls edges, the content-sha (symbols_sha) gate
// producing ZERO new versions on re-run, and graceful skipping of unresolved edge targets.

const sha256 = (text: string): string => "sha256:" + createHash("sha256").update(text).digest("hex")

describe("code-indexer §A symbol index (indexSymbols)", () => {
  it("creates symbol child nodes with kind/range/signature + file→symbol contains edges", () => {
    const proj = openProjectStore(base, WORK)
    const content = "export class Foo { bar() {} }\nexport function baz() {}"
    const file = { path: "src/foo.ts", content }
    indexFiles(proj, [file], { buildDocEdges: false })

    const extraction: SymbolExtraction = {
      path: "src/foo.ts",
      contentSha: sha256(content),
      symbols: [
        { symbolPath: "Foo", kind: "class", range: { start: 0, end: 0 }, signature: "class Foo" },
        { symbolPath: "Foo.bar", kind: "method", range: { start: 0, end: 0 }, signature: "bar(): void" },
        { symbolPath: "baz", kind: "function", range: { start: 1, end: 1 }, signature: "function baz(): void" },
      ],
    }
    const result = indexSymbols(proj, extraction)
    expect(result.skipped).toBe(false)
    expect(result.symbolsCreated).toBe(3)
    expect(result.containsEdges).toBe(3)

    // Symbol child nodes exist, keyed by "<path>#<symbolPath>".
    const barKey = symbolNodeKey("src/foo.ts", "Foo.bar")
    const barRef = proj.documentStore.list({ type: "code_symbol" }).find((r) => r.description === barKey)
    expect(barRef).toBeDefined()
    const bar = proj.documentStore.get(barRef!.id)!
    expect(bar.extensions?.kind).toBe("method")
    expect(bar.extensions?.host_path).toBe("src/foo.ts")
    expect((bar.extensions?.range as { start: number; end: number }).start).toBe(0)
    expect(bar.extensions?.signature).toBe("bar(): void")
    expect(bar.tags).toContain("symbol")

    // The file node has a contains edge to each symbol child.
    const fileNode = proj.documentStore.get(result.fileNodeId!)!
    const contained = fileNode.links.filter((l) => l.rel === "contains").map((l) => l.to)
    expect(contained).toContain(barRef!.id)
    expect(contained.length).toBe(3)
  })

  it("builds file→file imports edges only when the target file node exists", () => {
    const proj = openProjectStore(base, WORK)
    const a = { path: "src/a.ts", content: "import { b } from './b'\nexport const a = b" }
    const b = { path: "src/b.ts", content: "export const b = 1" }
    indexFiles(proj, [a, b], { buildDocEdges: false })

    const result = indexSymbols(proj, {
      path: "src/a.ts",
      contentSha: sha256(a.content),
      symbols: [{ symbolPath: "a", kind: "function" }],
      imports: ["src/b.ts", "src/does-not-exist.ts"],
    })
    expect(result.importsEdges).toBe(1) // src/b.ts resolves
    expect(result.importsSkipped).toBe(1) // src/does-not-exist.ts has no file node

    const aNode = proj.documentStore.get(result.fileNodeId!)!
    const bRef = proj.documentStore.list({ type: "code_symbol" }).find((r) => r.description === "src/b.ts")!
    expect(aNode.links.some((l) => l.rel === "imports" && l.to === bRef.id)).toBe(true)
  })

  it("builds symbol→symbol calls edges only when BOTH endpoints exist", () => {
    const proj = openProjectStore(base, WORK)
    const a = { path: "src/a.ts", content: "export function caller() { return callee() }" }
    const b = { path: "src/b.ts", content: "export function callee() { return 1 }" }
    indexFiles(proj, [a, b], { buildDocEdges: false })

    // Create the symbol nodes on both files first (buildCallEdges deferred), then link calls.
    indexSymbols(proj, {
      path: "src/a.ts",
      contentSha: sha256(a.content),
      symbols: [{ symbolPath: "caller", kind: "function" }],
    })
    indexSymbols(proj, {
      path: "src/b.ts",
      contentSha: sha256(b.content),
      symbols: [{ symbolPath: "callee", kind: "function" }],
    })

    const linked = linkCallEdges(proj, "src/a.ts", [
      { fromSymbolPath: "caller", toPath: "src/b.ts", toSymbolPath: "callee" },
      { fromSymbolPath: "caller", toPath: "src/b.ts", toSymbolPath: "ghost" }, // callee node missing
    ])
    expect(linked.callsEdges).toBe(1)
    expect(linked.callsSkipped).toBe(1)

    const callerKey = symbolNodeKey("src/a.ts", "caller")
    const calleeKey = symbolNodeKey("src/b.ts", "callee")
    const callerRef = proj.documentStore.list({ type: "code_symbol" }).find((r) => r.description === callerKey)!
    const calleeRef = proj.documentStore.list({ type: "code_symbol" }).find((r) => r.description === calleeKey)!
    const caller = proj.documentStore.get(callerRef.id)!
    expect(caller.links.some((l) => l.rel === "calls" && l.to === calleeRef.id)).toBe(true)
  })

  it("resolves a call target by LEAF name when the extractor only had the leaf (adversarial 2026-07-09)", () => {
    const proj = openProjectStore(base, WORK)
    const a = { path: "src/a.ts", content: "export function caller() { return o.bar() }" }
    const b = { path: "src/b.ts", content: "export class Foo { bar() { return 1 } }" }
    indexFiles(proj, [a, b], { buildDocEdges: false })

    // The callee is registered with its DOTTED path "Foo.bar" (a method of class Foo)…
    indexSymbols(proj, {
      path: "src/a.ts",
      contentSha: sha256(a.content),
      symbols: [{ symbolPath: "caller", kind: "function" }],
    })
    indexSymbols(proj, {
      path: "src/b.ts",
      contentSha: sha256(b.content),
      symbols: [{ symbolPath: "Foo.bar", kind: "method" }],
    })

    // …but callHierarchy reports the target by its LEAF name "bar". Before the fix this exact-matched
    // "src/b.ts#bar", missed the "src/b.ts#Foo.bar" node, and silently dropped the edge. The leaf
    // fallback now resolves it.
    const linked = linkCallEdges(proj, "src/a.ts", [
      { fromSymbolPath: "caller", toPath: "src/b.ts", toSymbolPath: "bar" },
    ])
    expect(linked.callsEdges).toBe(1)
    expect(linked.callsSkipped).toBe(0)

    const calleeKey = symbolNodeKey("src/b.ts", "Foo.bar")
    const calleeRef = proj.documentStore.list({ type: "code_symbol" }).find((r) => r.description === calleeKey)!
    const callerRef = proj.documentStore
      .list({ type: "code_symbol" })
      .find((r) => r.description === symbolNodeKey("src/a.ts", "caller"))!
    const caller = proj.documentStore.get(callerRef.id)!
    expect(caller.links.some((l) => l.rel === "calls" && l.to === calleeRef.id)).toBe(true)
  })

  it("leaf-name fallback is SKIPPED (not guessed) when the leaf is ambiguous", () => {
    const proj = openProjectStore(base, WORK)
    const a = { path: "src/a.ts", content: "caller" }
    const b = { path: "src/b.ts", content: "two bars" }
    indexFiles(proj, [a, b], { buildDocEdges: false })
    indexSymbols(proj, { path: "src/a.ts", contentSha: sha256(a.content), symbols: [{ symbolPath: "caller", kind: "function" }] })
    // Two hosted symbols share the leaf "bar" (Foo.bar and Baz.bar) → ambiguous.
    indexSymbols(proj, {
      path: "src/b.ts",
      contentSha: sha256(b.content),
      symbols: [
        { symbolPath: "Foo.bar", kind: "method" },
        { symbolPath: "Baz.bar", kind: "method" },
      ],
    })
    const linked = linkCallEdges(proj, "src/a.ts", [
      { fromSymbolPath: "caller", toPath: "src/b.ts", toSymbolPath: "bar" }, // ambiguous leaf
    ])
    expect(linked.callsEdges).toBe(0) // NOT guessed
    expect(linked.callsSkipped).toBe(1)
  })

  it("indexSymbols on the same file also builds calls when both endpoints already exist", () => {
    const proj = openProjectStore(base, WORK)
    const a = { path: "src/a.ts", content: "function helper(){}\nfunction main(){ helper() }" }
    indexFiles(proj, [a], { buildDocEdges: false })
    const result = indexSymbols(proj, {
      path: "src/a.ts",
      contentSha: sha256(a.content),
      symbols: [
        { symbolPath: "helper", kind: "function" },
        { symbolPath: "main", kind: "function" },
      ],
      calls: [{ fromSymbolPath: "main", toPath: "src/a.ts", toSymbolPath: "helper" }],
    })
    expect(result.callsEdges).toBe(1)
  })

  it("content-sha gate: re-indexing an unchanged file creates ZERO new versions", () => {
    const proj = openProjectStore(base, WORK)
    const content = "export function f() {}\nexport function g() {}"
    const file = { path: "src/x.ts", content }
    indexFiles(proj, [file], { buildDocEdges: false })
    const contentSha = sha256(content)
    const extraction: SymbolExtraction = {
      path: "src/x.ts",
      contentSha,
      symbols: [
        { symbolPath: "f", kind: "function", range: { start: 0, end: 0 } },
        { symbolPath: "g", kind: "function", range: { start: 1, end: 1 } },
      ],
    }

    const first = indexSymbols(proj, extraction)
    expect(first.skipped).toBe(false)
    expect(first.symbolsCreated).toBe(2)

    // Snapshot versions of the file node + both symbol nodes after the first pass.
    const fileV = proj.documentStore.get(first.fileNodeId!)!.version
    const symVersions = first.symbolNodeIds.map((id) => proj.documentStore.get(id)!.version)

    for (let i = 0; i < 5; i++) {
      const again = indexSymbols(proj, extraction)
      expect(again.skipped).toBe(true)
      expect(again.symbolsCreated).toBe(0)
      expect(again.containsEdges).toBe(0)
    }

    // Versions did NOT advance despite repeated passes (the symbols_sha gate short-circuits).
    expect(proj.documentStore.get(first.fileNodeId!)!.version).toBe(fileV)
    first.symbolNodeIds.forEach((id, i) => {
      expect(proj.documentStore.get(id)!.version).toBe(symVersions[i])
    })
  })

  it("a genuine content change re-runs the symbol pass (gate does not skip)", () => {
    const proj = openProjectStore(base, WORK)
    const v1Content = "export function f() {}"
    registerFile(proj, { path: "src/x.ts", content: v1Content })
    const r1 = indexSymbols(proj, {
      path: "src/x.ts",
      contentSha: sha256(v1Content),
      symbols: [{ symbolPath: "f", kind: "function" }],
    })
    expect(r1.skipped).toBe(false)
    expect(r1.symbolsCreated).toBe(1)

    // File content changes → the file node's content_sha changes → symbols_sha no longer matches.
    const v2Content = "export function f() {}\nexport function h() {}"
    registerFile(proj, { path: "src/x.ts", content: v2Content })
    const r2 = indexSymbols(proj, {
      path: "src/x.ts",
      contentSha: sha256(v2Content),
      symbols: [
        { symbolPath: "f", kind: "function" },
        { symbolPath: "h", kind: "function" },
      ],
    })
    expect(r2.skipped).toBe(false)
    expect(r2.symbolsCreated).toBe(1) // h is new; f unchanged
    expect(r2.symbolsUnchanged).toBe(1)
  })

  it("no file node for the path → skips cleanly (default-safe, no throw)", () => {
    const proj = openProjectStore(base, WORK)
    const result = indexSymbols(proj, {
      path: "src/never-registered.ts",
      contentSha: sha256("whatever"),
      symbols: [{ symbolPath: "orphan", kind: "function" }],
    })
    expect(result.fileNodeId).toBeNull()
    expect(result.symbolsCreated).toBe(0)
    // No symbol node was created for an orphan extraction.
    const key = symbolNodeKey("src/never-registered.ts", "orphan")
    expect(proj.documentStore.list({ type: "code_symbol" }).some((r) => r.description === key)).toBe(false)
  })

  it("omitting contentSha rebuilds every pass (no gate) but stays idempotent on node identity", () => {
    const proj = openProjectStore(base, WORK)
    const file = { path: "src/y.ts", content: "export const y = 1" }
    indexFiles(proj, [file], { buildDocEdges: false })
    const extraction: SymbolExtraction = {
      path: "src/y.ts",
      symbols: [{ symbolPath: "y", kind: "type" }],
    }
    const first = indexSymbols(proj, extraction)
    expect(first.symbolsCreated).toBe(1)
    const symId = first.symbolNodeIds[0]!
    const v = proj.documentStore.get(symId)!.version
    // Re-run without a sha: not skipped, but the upsert fingerprint is identical → no new version.
    const second = indexSymbols(proj, extraction)
    expect(second.skipped).toBe(false)
    expect(second.symbolsUnchanged).toBe(1)
    expect(proj.documentStore.get(symId)!.version).toBe(v)
  })
})
