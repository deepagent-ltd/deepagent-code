import { describe, expect, test, afterEach } from "bun:test"
import { rmSync } from "node:fs"
import { Effect } from "effect"
import { WikiGraph } from "../../src/wiki/wiki-service"
import { WikiSearchIndex, type WikiSearchHit } from "../../src/wiki/search-index"
import { freshStore, knowledgeInput, designInput, codeSymbolInput } from "./helpers"

const roots: string[] = []
const closers: WikiSearchIndex[] = []
afterEach(() => {
  for (const c of closers.splice(0)) c.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runSync(e)

const setup = () => {
  const { store, root } = freshStore()
  roots.push(root)
  const graph = new WikiGraph([store])
  const index = new WikiSearchIndex(":memory:", graph)
  closers.push(index)
  return { store, graph, index }
}

const ids = (hits: readonly WikiSearchHit[]) => hits.map((h) => h.docId).sort()

describe("WikiSearchIndex — §B.4 FTS over the graph projection", () => {
  test("search finds a knowledge page by body term", () => {
    const { store, index } = setup()
    const k = store.create(knowledgeInput({ description: "auth tokens", body: "rotate refresh tokens hourly" }))
    run(index.rebuild())
    const hits = run(index.search({ text: "refresh" }))
    expect(hits.some((h) => h.docId === k.id)).toBe(true)
  })

  test("search finds a code_symbol by symbol name", () => {
    const { store, index } = setup()
    const sym = store.create(codeSymbolInput("src/foo.ts", "AuthService.rotate", 5))
    run(index.rebuild())
    const hits = run(index.search({ text: "rotate" }))
    expect(hits.some((h) => h.docId === sym.id)).toBe(true)
  })

  test("rebuild from graph is idempotent (rebuild twice → same hits)", () => {
    const { store, index } = setup()
    store.create(knowledgeInput({ description: "alpha topic", body: "alpha beta gamma" }))
    store.create(designInput({ description: "design alpha", body: "alpha design detail" }))
    run(index.rebuild())
    const first = ids(run(index.search({ text: "alpha" })))
    run(index.rebuild())
    const second = ids(run(index.search({ text: "alpha" })))
    expect(second).toEqual(first)
    expect(first.length).toBe(2)
  })

  test("scope + type filters narrow results", () => {
    const { store, index } = setup()
    const durableK = store.create(knowledgeInput({ description: "shared widget", body: "widget widget" }))
    store.create(designInput({ description: "widget design", body: "widget widget" }))
    run(index.rebuild())
    const typed = run(index.search({ text: "widget", type: "knowledge" }))
    expect(ids(typed)).toEqual([durableK.id])
    const scoped = run(index.search({ text: "widget", scope: "durable", type: "knowledge" }))
    expect(ids(scoped)).toEqual([durableK.id])
  })

  test("sealed docs are NEVER indexed (INV-7)", () => {
    const { store, index } = setup()
    store.create(knowledgeInput({ scope: "sealed", description: "sealed secret", body: "topsecret payload" }))
    store.create(knowledgeInput({ description: "public fact", body: "topsecret is a word here too" }))
    run(index.rebuild())
    const hits = run(index.search({ text: "topsecret" }))
    // only the non-sealed doc surfaces
    expect(hits.every((h) => h.scope !== "sealed")).toBe(true)
    expect(hits.length).toBe(1)
  })

  test("empty / punctuation-only query → no results, no throw", () => {
    const { store, index } = setup()
    store.create(knowledgeInput())
    run(index.rebuild())
    expect(run(index.search({ text: "" }))).toEqual([])
    expect(run(index.search({ text: "   " }))).toEqual([])
    expect(run(index.search({ text: "()*:" }))).toEqual([])
  })

  test("special-char user text does not break FTS syntax", () => {
    const { store, index } = setup()
    const k = store.create(knowledgeInput({ description: "c++ parser", body: "handles c++ and foo-bar tokens" }))
    run(index.rebuild())
    const hits = run(index.search({ text: 'foo-bar "unterminated (paren' }))
    expect(hits.some((h) => h.docId === k.id)).toBe(true)
  })
})
