import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DocumentStore, knowledgeSimilarity, tokenizeForSimilarity } from "../../src/deepagent/document-store"

let root: string
let store: DocumentStore

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-ds-"))
  store = new DocumentStore(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const prov = { source: "model" as const, run_ref: "run:t1" }
const design = (body = "d", desc = "auth design") => ({
  type: "design" as const,
  scope: "run:t1",
  body,
  description: desc,
  provenance: prov,
})

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
    expect(() =>
      store.create({
        type: "strategy",
        scope: "durable",
        body: "x",
        description: "s",
        provenance: { source: "human" },
      }),
    ).toThrow()
  })

  test("dangling link rejected", () => {
    const c = store.create({ type: "candidate", scope: "run:t1", body: "c", description: "cand", provenance: prov })
    expect(() => store.link(c.id, "derived_from", "doc:design:nope")).toThrow()
  })

  test("index rebuildable from files; verify clean", () => {
    const a = store.create(design("a"))
    const b = store.create({ type: "candidate", scope: "run:t1", body: "b", description: "cand b", provenance: prov })
    store.link(b.id, "derived_from", a.id)
    const before = store
      .list()
      .map((r) => r.id)
      .sort()
    const reopened = new DocumentStore(root) // rebuilds index from files only
    expect(
      reopened
        .list()
        .map((r) => r.id)
        .sort(),
    ).toEqual(before)
    expect(reopened.getRefsIn(a.id).some((r) => r.from.id === b.id)).toBe(true)
    expect(reopened.verify().ok).toBe(true)
  })

  test("sealed scope never listed (INV-7)", () => {
    store.create({
      type: "memory",
      scope: "sealed",
      body: "leak",
      description: "sealed",
      confidence: { evidence_strength: "none", support_count: 0 },
      provenance: { source: "runner" },
    })
    expect(store.list({ type: "memory" }).length).toBe(0)
  })
})

describe("knowledge similarity (dedup helper)", () => {
  test("tokenize drops punctuation and 1-char noise, lowercases", () => {
    expect([...tokenizeForSimilarity("Use Redis, for X!")].sort()).toEqual(["for", "redis", "use"])
  })

  test("identical text scores 1; reworded scores high; unrelated scores low", () => {
    expect(knowledgeSimilarity("use redis for the rate limiter", "use redis for the rate limiter")).toBe(1)
    expect(
      knowledgeSimilarity("cache the session in redis to speed auth", "cache the session in redis to speed up auth"),
    ).toBeGreaterThanOrEqual(0.8)
    expect(
      knowledgeSimilarity("use redis for the rate limiter", "validate webhook signatures before processing"),
    ).toBeLessThan(0.3)
  })

  test("a short summary fully contained in a longer one scores high (overlap coefficient)", () => {
    expect(knowledgeSimilarity("redis rate limiter", "we should use a redis rate limiter for the api")).toBe(1)
  })

  test("empty / no-token input scores 0", () => {
    expect(knowledgeSimilarity("", "redis")).toBe(0)
    expect(knowledgeSimilarity("!!! ???", "redis")).toBe(0)
  })

  test("findSimilarKnowledge merges only same type+scope+domain non-rejected docs", () => {
    const a = store.create({
      type: "memory",
      scope: "user-global",
      domain: "code",
      body: "b",
      description: "use redis for the rate limiter",
      confidence: { evidence_strength: "weak", support_count: 1 },
      provenance: { source: "runner" },
    })
    // near-duplicate, same type/scope/domain -> found
    expect(
      store.findSimilarKnowledge({
        type: "memory",
        scope: "user-global",
        domain: "code",
        description: "use redis for the rate limiter please",
      })?.id,
    ).toBe(a.id)
    // different domain -> not found
    expect(
      store.findSimilarKnowledge({
        type: "memory",
        scope: "user-global",
        domain: "infra",
        description: "use redis for the rate limiter",
      }),
    ).toBeNull()
  })
})
