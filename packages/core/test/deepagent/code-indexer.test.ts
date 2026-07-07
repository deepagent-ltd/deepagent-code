import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openProjectStore, openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"
import type { DurableKnowledgeStore } from "../../src/deepagent/durable-knowledge-store"
import { indexFiles, registerFile } from "../../src/deepagent/code-indexer"
import type { CreateDocInput, DocType, Provenance } from "../../src/deepagent/document-store"

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
