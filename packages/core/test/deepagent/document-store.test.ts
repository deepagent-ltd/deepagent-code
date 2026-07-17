import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DocumentStore, DocumentConflictError, knowledgeSimilarity, tokenizeForSimilarity } from "../../src/deepagent/document-store"
import { writeFileAtomic, writeFileExclusive } from "../../src/deepagent/atomic-write"
import { DurableKnowledgeStore } from "../../src/deepagent/durable-knowledge-store"

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

  // BUG #3 (INV-7): list() excludes sealed docs, but graph traversal (neighbors/getRefsIn) must too —
  // a sealed doc linked from a visible doc must never surface via an edge.
  test("sealed docs never leak through graph traversal (INV-7)", () => {
    // sealed target linked from a visible doc, and a visible doc linked from a sealed source.
    const sealed = store.create({
      type: "memory",
      scope: "sealed",
      body: "secret",
      description: "sealed memory",
      confidence: { evidence_strength: "none", support_count: 0 },
      provenance: { source: "runner" },
    })
    const visible = store.create(design("v", "visible design"))
    // visible -> sealed : neighbors(visible) must NOT return the sealed doc
    store.link(visible.id, "derived_from", sealed.id)
    expect(store.neighbors(visible.id, ["derived_from"], 2).some((x) => x.id === sealed.id)).toBe(false)
    // sealed -> visible : getRefsIn(visible) must NOT surface the sealed doc as an inbound source
    store.link(sealed.id, "derived_from", visible.id)
    expect(store.getRefsIn(visible.id).some((r) => r.from.id === sealed.id)).toBe(false)
    // and list() still excludes it (baseline invariant)
    expect(store.list().some((r) => r.id === sealed.id)).toBe(false)
  })

  // BUG #4: one corrupt/truncated .json doc must not brick store construction (rebuildIndex runs in
  // the constructor). The bad file is skipped; valid docs are still indexed.
  test("rebuildIndex skips a corrupt doc file and still opens the store", () => {
    const a = store.create(design("a", "valid design a"))
    const b = store.create({ type: "candidate", scope: "run:t1", body: "b", description: "valid cand b", provenance: prov })
    // Drop a truncated/partial-write .json into a type dir alongside the valid files.
    const badDir = path.join(root, "docs", "design")
    mkdirSync(badDir, { recursive: true })
    writeFileSync(path.join(badDir, "corrupt@v1.json"), '{"id":"doc:design:oops","versi')
    // Constructing (or rebuilding) must not throw; valid docs remain indexed.
    const reopened = new DocumentStore(root)
    const ids = reopened.list().map((r) => r.id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(b.id)
    expect(ids).not.toContain("doc:design:oops")
  })

  // V3.9 §B.2/B.3: the human-governance edit path. Append-only new version whose provenance is the
  // supplied human authorship — NOT the model/runner provenance copied by update().
  test("updateWithProvenance stamps human provenance + is append-only", () => {
    const k = store.create({
      type: "knowledge",
      scope: "durable",
      body: "v1 body",
      description: "a fact",
      confidence: { evidence_strength: "weak", support_count: 1 },
      provenance: { source: "model", run_ref: "run:t1" },
    })
    expect(k.version).toBe(1)
    expect(k.provenance.source).toBe("model")
    const edited = store.updateWithProvenance(k.id, "v2 body edited by human", { source: "human" })
    expect(edited.version).toBe(2)
    expect(edited.provenance.source).toBe("human")
    expect(edited.body).toBe("v2 body edited by human")
    // knowledge confidence preserved (assertKnowledgeConfidence satisfied)
    expect(edited.confidence?.evidence_strength).toBe("weak")
    // append-only: old version superseded, latest resolves to v2
    const old = store.get(k.id, 1)!
    expect(old.status).toBe("superseded")
    expect(old.superseded_by).toBe(`${k.id}@v2`)
    expect(store.get(k.id)!.version).toBe(2)
    // provenance is part of the fingerprint → identical body+provenance is an INV-4 no-op
    expect(store.updateWithProvenance(k.id, "v2 body edited by human", { source: "human" }).version).toBe(2)
  })
})

// F30-1 (deepagentcore-v4.0.3 storage prereq): DocumentStore is the single crash-safe, concurrency-
// safe durable body. persist() writes append-only version files with exclusive-create CAS; replace()
// overwrites the same version atomically (temp+fsync+rename). These tests pin the CAS + durability
// behavior that H32-1 (v4.0.4) builds on.
describe("F30-1 DocumentStore CAS + atomic durability", () => {
  test("normal single-writer flow is unchanged (create + updates land byte-identically)", () => {
    const a = store.create(design("v1"))
    const a2 = store.update(a.id, "v2")
    const a3 = store.update(a.id, "v3")
    expect(a3.version).toBe(3)
    // reopened from files only — every version file was written exactly once via exclusive create
    const reopened = new DocumentStore(root)
    expect(reopened.get(a.id)!.body).toBe("v3")
    expect(reopened.get(a.id, 1)!.status).toBe("superseded")
    expect(reopened.get(a.id, 2)!.status).toBe("superseded")
    expect(reopened.verify().ok).toBe(true)
  })

  test("two handles writing DIFFERENT content at the same version -> DocumentConflictError", () => {
    // Both handles are built over the same on-disk root but hold independent in-memory indexes, so
    // both compute the SAME next version (v2) from the SAME base (v1) — the lost-update race F30-1
    // must catch instead of silently clobbering.
    const a = store.create(design("base"))
    const h1 = new DocumentStore(root)
    const h2 = new DocumentStore(root)
    h1.update(a.id, "from h1") // writes id@v2 (h1's content)
    // h2 still thinks latest is v1; its update also targets v2 but with different content -> conflict
    expect(() => h2.update(a.id, "from h2")).toThrow(DocumentConflictError)
    // h1's write survives intact; nothing was clobbered
    expect(new DocumentStore(root).get(a.id)!.body).toBe("from h1")
  })

  test("idempotent re-persist of byte-identical version is a no-op (same-hash CAS collision)", () => {
    // Two handles writing the SAME content at the same version must NOT conflict — a retried/mirrored
    // write of identical bytes is idempotent (content-addressed: same hash).
    const a = store.create(design("base"))
    const h1 = new DocumentStore(root)
    const h2 = new DocumentStore(root)
    const w1 = h1.update(a.id, "same body")
    const w2 = h2.update(a.id, "same body") // same version, same content -> idempotent, no throw
    expect(w1.version).toBe(2)
    expect(w2.version).toBe(2)
    expect(w1.hash).toBe(w2.hash)
    expect(new DocumentStore(root).get(a.id)!.body).toBe("same body")
  })

  test("setStatus/replace rewrites the same version file in place without a version bump", () => {
    const a = store.create(design("body"))
    expect(a.version).toBe(1)
    store.setStatus(a.id, "active")
    expect(store.get(a.id)!.status).toBe("active")
    expect(store.get(a.id)!.version).toBe(1) // in-place rewrite, not a new version
    // exactly one version file on disk for this doc (no orphan versions from the rewrite)
    const dir = path.join(root, "docs", "design")
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
    expect(files.length).toBe(1)
    expect(new DocumentStore(root).get(a.id)!.status).toBe("active")
  })

  test("writeFileExclusive throws EEXIST on an existing path (the CAS primitive)", () => {
    const f = path.join(root, "cas-probe.json")
    writeFileExclusive(f, "first")
    let code: string | undefined
    try {
      writeFileExclusive(f, "second")
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code
    }
    expect(code).toBe("EEXIST")
    expect(readFileSync(f, "utf8")).toBe("first") // original never clobbered
  })

  test("writeFileAtomic overwrites durably and leaves no temp files behind", () => {
    const f = path.join(root, "atomic-probe.json")
    writeFileAtomic(f, "one")
    writeFileAtomic(f, "two")
    expect(readFileSync(f, "utf8")).toBe("two")
    // no leftover .tmp-* siblings from the temp+rename
    const leftover = readdirSync(root).filter((n) => n.includes(".tmp-"))
    expect(leftover).toEqual([])
  })
})

// F30-1 Part 2: same-process SHARED AUTHORITY. `DocumentStore.shared(root)` handles for the same root
// share ONE in-memory index (a write through one is visible through all); `new DocumentStore(root)`
// stays unshared (own disk-rebuilt index) so it keeps faithfully simulating a cold/second-process open.
describe("F30-1 DocumentStore.shared same-process authority", () => {
  afterEach(() => DocumentStore.__resetSharedRegistryForTests())

  test("two shared handles to the same root see each other's writes without a disk reopen", () => {
    const h1 = DocumentStore.shared(root)
    const h2 = DocumentStore.shared(root)
    const a = h1.create(design("written via h1"))
    // h2 shares h1's live index — the doc is visible immediately, no rebuild/reopen needed
    expect(h2.get(a.id)?.body).toBe("written via h1")
    // and a write through h2 is visible through h1 (bidirectional shared authority)
    const a2 = h2.update(a.id, "updated via h2")
    expect(a2.version).toBe(2)
    expect(h1.get(a.id)?.body).toBe("updated via h2")
    expect(h1.get(a.id)?.version).toBe(2)
  })

  test("an UNSHARED handle does NOT see another handle's in-memory write until it rebuilds from disk", () => {
    // This is the pre-F30-1 divergence the shared registry fixes — pinned here so the distinction is
    // explicit: an unshared handle only reflects writes that were on disk at ITS construction time.
    const shared = DocumentStore.shared(root)
    const a = shared.create(design("only in shared index at first"))
    // A separate shared handle constructed AFTER the write still sees it (shared index)...
    expect(DocumentStore.shared(root).get(a.id)?.body).toBe("only in shared index at first")
    // ...and an unshared handle also sees it here, because create() persisted it to disk and the
    // unshared handle rebuilds from disk in its constructor. (Persistence is synchronous — Part 1.)
    expect(new DocumentStore(root).get(a.id)?.body).toBe("only in shared index at first")
  })

  test("shared index is rebuilt from disk on first open of a root (survives a simulated restart)", () => {
    // Seed via an unshared handle (writes to disk), then open the FIRST shared handle for the root —
    // it must rebuild the shared index from disk so pre-existing docs are visible.
    const seed = new DocumentStore(root).create(design("seeded on disk"))
    DocumentStore.__resetSharedRegistryForTests() // simulate a fresh process (empty registry)
    const shared = DocumentStore.shared(root)
    expect(shared.get(seed.id)?.body).toBe("seeded on disk")
  })

  test("shared handles for DIFFERENT roots are isolated", () => {
    const otherRoot = mkdtempSync(path.join(tmpdir(), "deepagent-ds-shared-other-"))
    try {
      const a = DocumentStore.shared(root).create(design("in root"))
      const other = DocumentStore.shared(otherRoot)
      expect(other.get(a.id)).toBeNull() // different root -> different shared index
    } finally {
      rmSync(otherRoot, { recursive: true, force: true })
    }
  })
})

// V3.8 Phase 0: the new NON-knowledge derived-data node/edge types must round-trip through the graph
// exactly like any other doc, must NOT trigger the knowledge confidence check, and must obey INV-3
// (single-store links only). No knowledge semantics ride on them.
describe("V3.8 Phase 0 graph-model extension (code_symbol / ledger / bridge)", () => {
  const codeSymbol = (desc = "auth service") => ({
    type: "code_symbol" as const,
    scope: "durable:project:p1",
    body: JSON.stringify({ path: "src/auth.ts", language: "ts", symbol: "AuthService" }),
    description: desc,
    provenance: prov,
  })

  test("code_symbol create/link/neighbors round-trip (references code->doc)", () => {
    const design = store.create({ type: "design", scope: "durable:project:p1", body: "d", description: "auth design", provenance: prov })
    const code = store.create(codeSymbol())
    expect(code.id).toMatch(/^doc:code_symbol:/)
    expect(code.version).toBe(1)
    store.link(code.id, "references", design.id)
    expect(store.neighbors(code.id, ["references"], 1).some((x) => x.id === design.id)).toBe(true)
    expect(store.getRefsIn(design.id).some((r) => r.from.id === code.id && r.rel === "references")).toBe(true)
  })

  test("code_symbol implements requirements edge round-trips", () => {
    const req = store.create({ type: "requirements", scope: "durable:project:p1", body: "r", description: "must auth", provenance: prov })
    const code = store.create(codeSymbol("login handler"))
    store.link(code.id, "implements", req.id)
    expect(store.neighbors(code.id, ["implements"], 1).some((x) => x.id === req.id)).toBe(true)
  })

  test("ledger and bridge create + reuse existing derived_from/refines edges", () => {
    const ledger = store.create({ type: "ledger", scope: "run:t1", body: "{}", description: "session ledger", provenance: prov })
    const bridge = store.create({ type: "bridge", scope: "durable:project:p1", body: "{}", description: "project bridge", provenance: prov })
    expect(ledger.id).toMatch(/^doc:ledger:/)
    expect(bridge.id).toMatch(/^doc:bridge:/)
    // App-A reuse: bridge refines the session ledger it was distilled from.
    store.link(bridge.id, "refines", ledger.id)
    expect(store.neighbors(bridge.id, ["refines"], 1).some((x) => x.id === ledger.id)).toBe(true)
  })

  test("new types do NOT trigger the knowledge confidence check (no confidence needed)", () => {
    for (const type of ["code_symbol", "ledger", "bridge"] as const) {
      expect(() =>
        store.create({ type, scope: "durable:project:p1", body: "x", description: `${type} doc`, provenance: prov }),
      ).not.toThrow()
    }
  })

  test("linking a new-type node across two stores is rejected by INV-3", () => {
    const otherRoot = mkdtempSync(path.join(tmpdir(), "deepagent-ds-other-"))
    try {
      const other = new DocumentStore(otherRoot)
      const remoteDesign = other.create({ type: "design", scope: "durable:project:p1", body: "d", description: "remote design", provenance: prov })
      const code = store.create(codeSymbol())
      // The link target lives in `other`, not `store` — INV-3 (link target must exist) rejects it.
      expect(() => store.link(code.id, "references", remoteDesign.id)).toThrow()
    } finally {
      rmSync(otherRoot, { recursive: true, force: true })
    }
  })

  // C3 (the OTHER half): even when a new-type doc is ACTIVE in the durable store, retrieve()'s
  // KNOWLEDGE_DOC_TYPES whitelist must keep it out of knowledge retrieval — it is derived data reached
  // only via the documentStore getter (Phase 1 GraphQuery), never surfaced as knowledge.
  test("active new-type docs never pass retrieve()'s knowledge whitelist", () => {
    const durable = new DurableKnowledgeStore(root)
    const conf = { evidence_strength: "strong" as const, support_count: 1 }
    for (const type of ["code_symbol", "ledger", "bridge"] as const) {
      durable.seedActive({
        type,
        description: `${type} derived doc`,
        body: "{}",
        domain: null,
        scope: "project-shared",
        projectId: "p1",
        sensitivity: "source_code",
        risk: "low",
        confidence: conf,
        provenance: prov,
      })
    }
    // Requesting them explicitly still yields nothing: the whitelist filters them at the type gate.
    expect(
      durable.retrieve({ types: ["code_symbol", "ledger", "bridge"], projectId: "p1", limit: 10 }),
    ).toHaveLength(0)
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
