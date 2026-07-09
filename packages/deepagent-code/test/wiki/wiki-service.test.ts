import { describe, expect, test, afterEach } from "bun:test"
import { rmSync } from "node:fs"
import { Effect } from "effect"
import {
  WikiService,
  WikiGraph,
  WikiNotFoundError,
  WikiReadOnlyError,
  GateRejectedError,
} from "../../src/wiki/wiki-service"
import { freshStore, knowledgeInput, designInput, codeFileInput, codeSymbolInput } from "./helpers"

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const svc = () => {
  const { store, root } = freshStore()
  roots.push(root)
  return { store, service: new WikiService(new WikiGraph([store])) }
}

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runSync(e)
const runExit = <A, E>(e: Effect.Effect<A, E>) => Effect.runSyncExit(e)

describe("WikiService — §B.2 editable boundary", () => {
  test("knowledge page is editable", () => {
    const { store, service } = svc()
    const k = store.create(knowledgeInput())
    const page = run(service.renderPage({ docId: k.id, scope: "durable" }))
    expect(page.editable).toBe(true)
    expect(page.type).toBe("knowledge")
    expect(page.confidence?.evidence_strength).toBe("medium")
    expect(page.markdown).toContain("# a governed fact")
  })

  test("memory/strategy/methodology are editable", () => {
    const { store, service } = svc()
    for (const type of ["memory", "strategy", "methodology"] as const) {
      const d = store.create(knowledgeInput({ type, description: `${type} doc` }))
      const page = run(service.renderPage({ docId: d.id, scope: "durable" }))
      expect(page.editable).toBe(true)
    }
  })

  test("design (Document graph) is read-only", () => {
    const { store, service } = svc()
    const d = store.create(designInput())
    const page = run(service.renderPage({ docId: d.id, scope: "durable" }))
    expect(page.editable).toBe(false)
    expect(page.markdown).toContain("(read-only)")
  })

  test("code_symbol (Code graph) is read-only", () => {
    const { store, service } = svc()
    const c = store.create(codeFileInput())
    const page = run(service.renderPage({ docId: c.id, scope: "durable" }))
    expect(page.editable).toBe(false)
  })

  test("editKnowledge on a read-only design → WikiReadOnlyError", () => {
    const { store, service } = svc()
    const d = store.create(designInput())
    const exit = runExit(service.editKnowledge({ docId: d.id, body: "x", editor: { id: "u1" } }))
    expect(exit._tag).toBe("Failure")
    const err = Effect.runSync(service.editKnowledge({ docId: d.id, body: "x", editor: { id: "u1" } }).pipe(Effect.flip))
    expect(err).toBeInstanceOf(WikiReadOnlyError)
  })

  test("editKnowledge on a read-only code_symbol → WikiReadOnlyError", () => {
    const { store, service } = svc()
    const c = store.create(codeFileInput())
    const err = Effect.runSync(service.editKnowledge({ docId: c.id, body: "x", editor: { id: "u1" } }).pipe(Effect.flip))
    expect(err).toBeInstanceOf(WikiReadOnlyError)
  })
})

describe("WikiService — §B.3 editKnowledge governance", () => {
  test("edit stamps provenance.source=human + bumps version (append-only)", () => {
    const { store, service } = svc()
    const k = store.create(knowledgeInput({ body: "v1" }))
    expect(k.version).toBe(1)
    expect(k.provenance.source).toBe("model")
    const page = run(service.editKnowledge({ docId: k.id, body: "v2 edited", editor: { id: "alice", name: "Alice" } }))
    expect(page.version).toBe(2)
    // underlying doc has human provenance + evidence ref pinning the editor
    const latest = store.get(k.id)!
    expect(latest.provenance.source).toBe("human")
    expect(latest.provenance.evidence_refs?.[0]).toContain("human:alice")
    expect(latest.body).toBe("v2 edited")
    // append-only: v1 superseded, confidence preserved (knowledge invariant intact)
    const v1 = store.get(k.id, 1)!
    expect(v1.status).toBe("superseded")
    expect(v1.superseded_by).toBe(`${k.id}@v2`)
    expect(latest.confidence?.evidence_strength).toBe("medium")
  })

  test("gate rejection → GateRejectedError (empty body blanks a page)", () => {
    const { store, service } = svc()
    const k = store.create(knowledgeInput())
    const err = Effect.runSync(service.editKnowledge({ docId: k.id, body: "   ", editor: { id: "u1" } }).pipe(Effect.flip))
    expect(err).toBeInstanceOf(GateRejectedError)
    // page unchanged (still v1)
    expect(store.get(k.id)!.version).toBe(1)
  })

  test("custom injected gate can reject", () => {
    const { store, root } = freshStore()
    roots.push(root)
    const service = new WikiService(new WikiGraph([store]), () => ({ pass: false, reason: "policy denies" }))
    const k = store.create(knowledgeInput())
    const err = Effect.runSync(service.editKnowledge({ docId: k.id, body: "new", editor: { id: "u1" } }).pipe(Effect.flip))
    expect(err).toBeInstanceOf(GateRejectedError)
    expect((err as GateRejectedError).reason).toBe("policy denies")
  })
})

describe("WikiService — §B.7 sealed never projected (INV-7)", () => {
  test("renderPage on a sealed doc → WikiNotFoundError", () => {
    const { store, service } = svc()
    const sealed = store.create(knowledgeInput({ scope: "sealed", description: "sealed secret" }))
    const err = Effect.runSync(service.renderPage({ docId: sealed.id, scope: "sealed" }).pipe(Effect.flip))
    expect(err).toBeInstanceOf(WikiNotFoundError)
  })

  test("renderPage scope mismatch → WikiNotFoundError", () => {
    const { store, service } = svc()
    const k = store.create(knowledgeInput())
    const err = Effect.runSync(service.renderPage({ docId: k.id, scope: "run:other" }).pipe(Effect.flip))
    expect(err).toBeInstanceOf(WikiNotFoundError)
  })

  test("editKnowledge on a sealed doc → WikiNotFoundError (never editable)", () => {
    const { store, service } = svc()
    const sealed = store.create(knowledgeInput({ scope: "sealed" }))
    const err = Effect.runSync(service.editKnowledge({ docId: sealed.id, body: "x", editor: { id: "u1" } }).pipe(Effect.flip))
    expect(err).toBeInstanceOf(WikiNotFoundError)
  })
})

describe("WikiService — §B.5 docs↔code cross-links", () => {
  test("resolvable code target → CodeRef with file:line, not stale", () => {
    const { store, service } = svc()
    const sym = store.create(codeSymbolInput("src/foo.ts", "Foo.bar", 9))
    const design = store.create(designInput())
    // design references the symbol node (code←→doc via references rel)
    store.link(design.id, "references", sym.id)
    const links = run(service.crossLinks(design.id))
    const ref = links.toCode.find((c) => c.docId === sym.id)
    expect(ref).toBeDefined()
    expect(ref!.stale).toBe(false)
    expect(ref!.path).toBe("src/foo.ts")
    expect(ref!.line).toBe(10) // 0-based 9 → 1-based 10
    expect(ref!.symbolPath).toBe("Foo.bar")
  })

  test("§B.5 / INV-7: a SEALED code target is OMITTED entirely, never surfaced (not even as a stale id)", () => {
    const { store, service } = svc()
    // A sealed code_symbol is still in the store's index (so link() satisfies INV-3), but the human
    // projection must NEVER surface it (INV-7). Its id is slug-derived from its description, so exposing
    // it even as a `stale` ref would leak the sealed doc's title. The fix OMITS it entirely.
    const sealedSym = store.create(codeSymbolInput("src/gone.ts", "Gone.fn", 3, { scope: "sealed" }))
    const design = store.create(designInput())
    store.link(design.id, "references", sealedSym.id) // link created (target exists in index)
    const links = run(service.crossLinks(design.id))
    // The sealed target must NOT appear at all — not resolved, not stale.
    expect(links.toCode.find((c) => c.docId === sealedSym.id)).toBeUndefined()
  })

  test("WikiGraph.isSealed distinguishes a sealed target from a genuinely-absent one (INV-7 basis)", () => {
    // This is the disambiguation crossLinks relies on to OMIT sealed vs mark-stale absent.
    const { store, root } = freshStore()
    roots.push(root)
    const sealedSym = store.create(codeSymbolInput("src/s.ts", "S.fn", 1, { scope: "sealed" }))
    const graph = new WikiGraph([store])
    expect(graph.get(sealedSym.id)).toBeNull() // sealed → not projected
    expect(graph.isSealed(sealedSym.id)).toBe(true) // …but recognizably SEALED (→ omit)
    expect(graph.isSealed("doc:code_symbol:never-created")).toBe(false) // truly absent → not sealed (→ stale)
  })

  test("inbound code→doc reference surfaces on the doc's cross-links", () => {
    const { store, service } = svc()
    const codeFile = store.create(codeFileInput("src/svc.ts"))
    const design = store.create(designInput())
    // code node references the design doc (references: code→doc)
    store.link(codeFile.id, "references", design.id)
    const links = run(service.crossLinks(design.id))
    expect(links.toCode.some((c) => c.docId === codeFile.id && !c.stale)).toBe(true)
  })
})
