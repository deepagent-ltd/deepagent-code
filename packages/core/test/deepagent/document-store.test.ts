import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DocumentStore } from "../../src/deepagent/document-store"

let root: string
let store: DocumentStore

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "deepagent-ds-")); store = new DocumentStore(root) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

const prov = { source: "model" as const, run_ref: "run:t1" }
const design = (body = "d", desc = "auth design") => ({ type: "design" as const, scope: "run:t1", body, description: desc, provenance: prov })

describe("V3 DocumentStore", () => {
  test("create assigns stable id + content hash", () => {
    const a = store.create(design())
    expect(a.id).toMatch(/^doc:design:/)
    expect(a.version).toBe(1)
    expect(a.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(store.create(design()).id).not.toBe(a.id) // distinct logical docs
  })

  test("update is append-only with supersede chain", () => {
    const a = store.create(design("v1"))
    const a2 = store.update(a.id, "v2")
    expect(a2.version).toBe(2)
    const old = store.get(a.id, 1)!
    expect(old.status).toBe("superseded")
    expect(old.superseded_by).toBe(`${a.id}@v2`)
    expect(store.get(a.id)!.version).toBe(2)
    expect(store.update(a.id, "v2").version).toBe(2) // no-op on identical content
  })

  test("links are bidirectional and traversable", () => {
    const d = store.create(design())
    const c = store.create({ type: "candidate", scope: "run:t1", body: "c", description: "cand", provenance: prov })
    store.link(c.id, "derived_from", d.id)
    expect(store.getRefsIn(d.id).some((r) => r.from.id === c.id && r.rel === "derived_from")).toBe(true)
    expect(store.neighbors(c.id, ["derived_from"], 1).some((x) => x.id === d.id)).toBe(true)
  })

  test("knowledge-class doc requires confidence", () => {
    expect(() => store.create({ type: "strategy", scope: "durable", body: "x", description: "s", provenance: { source: "human" } })).toThrow()
  })

  test("dangling link rejected", () => {
    const c = store.create({ type: "candidate", scope: "run:t1", body: "c", description: "cand", provenance: prov })
    expect(() => store.link(c.id, "derived_from", "doc:design:nope")).toThrow()
  })

  test("index rebuildable from files; verify clean", () => {
    const a = store.create(design("a"))
    const b = store.create({ type: "candidate", scope: "run:t1", body: "b", description: "cand b", provenance: prov })
    store.link(b.id, "derived_from", a.id)
    const before = store.list().map((r) => r.id).sort()
    const reopened = new DocumentStore(root) // rebuilds index from files only
    expect(reopened.list().map((r) => r.id).sort()).toEqual(before)
    expect(reopened.getRefsIn(a.id).some((r) => r.from.id === b.id)).toBe(true)
    expect(reopened.verify().ok).toBe(true)
  })

  test("sealed scope never listed (INV-7)", () => {
    store.create({ type: "memory", scope: "sealed", body: "leak", description: "sealed", confidence: { evidence_strength: "none", support_count: 0 }, provenance: { source: "runner" } })
    expect(store.list({ type: "memory" }).length).toBe(0)
  })
})
