import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DurableKnowledgeStore,
  type KnowledgeDocInput,
  isVisibleToWorkspace,
  scopeStringFor,
  statusToApproval,
  userGlobalKnowledgeRoot,
  projectKnowledgeRoot,
  openProjectStore,
  openUserGlobalStore,
  projectIdForWorkspace,
} from "../../src/deepagent/durable-knowledge-store"

let root: string
let store: DurableKnowledgeStore

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-dks-"))
  store = new DurableKnowledgeStore(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const conf = { evidence_strength: "strong" as const, support_count: 3 }
const prov = { source: "runner" as const, run_ref: "run:t1", evidence_refs: ["run:t1"] }

const mem = (over: Partial<KnowledgeDocInput> = {}): KnowledgeDocInput => ({
  type: "memory",
  description: "stage to shared mem before compute",
  body: "details",
  domain: "code",
  scope: "user-global",
  sensitivity: "public",
  risk: "low",
  confidence: conf,
  provenance: prov,
  ...over,
})

describe("S0 DurableKnowledgeStore", () => {
  test("stageCandidate writes status=candidate (never directly active) — DAP-8", () => {
    const doc = store.stageCandidate(mem())
    expect(doc.status).toBe("candidate")
    expect(store.isApproved(doc.id)).toBe(false)
    // candidate is not retrievable
    expect(store.retrieve({ types: ["memory"], limit: 5 })).toHaveLength(0)
  })

  test("approve flips in place to active (same id) and becomes retrievable", () => {
    const doc = store.stageCandidate(mem())
    expect(store.approve(doc.id)).toBe(true)
    const after = store.documentStore.get(doc.id)!
    expect(after.id).toBe(doc.id) // no new id (docs/34 §7.1)
    expect(after.version).toBe(doc.version) // in-place, no supersede
    expect(after.status).toBe("active")
    const hits = store.retrieve({ types: ["memory"], limit: 5 })
    expect(hits.map((h) => h.doc.id)).toContain(doc.id)
  })

  test("reject is reversible and removes from retrieval", () => {
    const doc = store.stageCandidate(mem())
    store.approve(doc.id)
    expect(store.retrieve({ types: ["memory"], limit: 5 })).toHaveLength(1)
    expect(store.reject(doc.id)).toBe(true)
    expect(store.retrieve({ types: ["memory"], limit: 5 })).toHaveLength(0)
    // reversible back to active
    expect(store.approve(doc.id)).toBe(true)
    expect(store.retrieve({ types: ["memory"], limit: 5 })).toHaveLength(1)
  })

  test("approve/reject on unknown id returns false (no-op signal) — P1-2", () => {
    expect(store.approve("doc:memory:nope")).toBe(false)
    expect(store.reject("strategy:in-code-ref")).toBe(false)
  })

  test("project-shared visible only to its project; user-global visible everywhere", () => {
    const shared = store.stageCandidate(
      mem({ scope: "project-shared", projectId: "project_aaa", description: "A-only" }),
    )
    const global = store.stageCandidate(mem({ scope: "user-global", description: "everyone" }))
    store.approve(shared.id)
    store.approve(global.id)

    const fromA = store.retrieve({ types: ["memory"], projectId: "project_aaa", limit: 10 }).map((h) => h.doc.id)
    expect(fromA).toContain(shared.id)
    expect(fromA).toContain(global.id)

    const fromB = store.retrieve({ types: ["memory"], projectId: "project_bbb", limit: 10 }).map((h) => h.doc.id)
    expect(fromB).not.toContain(shared.id) // isolated
    expect(fromB).toContain(global.id) // global still visible
  })

  test("session-private is never durable (stage throws)", () => {
    expect(() => store.stageCandidate(mem({ scope: "session-private" }))).toThrow(/session-private/)
  })

  test("setStatus flip keeps INV-2 hash integrity (verify ok)", () => {
    const doc = store.stageCandidate(mem())
    store.approve(doc.id)
    store.reject(doc.id)
    expect(store.documentStore.verify().ok).toBe(true)
  })

  test("retrieve excludes non-knowledge types and applies stable id tiebreaker", () => {
    const a = store.stageCandidate(mem({ description: "zzz", idSlug: "zzz" }))
    const b = store.stageCandidate(mem({ description: "aaa", idSlug: "aaa" }))
    store.approve(a.id)
    store.approve(b.id)
    // equal score -> id ascending tiebreaker
    const ids = store.retrieve({ types: ["memory"], limit: 10 }).map((h) => h.doc.id)
    expect([...ids].sort()).toEqual(ids)
  })

  test("scopeStringFor / visibility encoding", () => {
    expect(scopeStringFor("user-global")).toBe("durable")
    expect(scopeStringFor("project-shared", "project_x")).toBe("durable:project:project_x")
    expect(() => scopeStringFor("project-shared")).toThrow(/projectId/)
    const sealed = { scope: "sealed" } as never
    expect(isVisibleToWorkspace(sealed, "project_x")).toBe(false)
  })

  test("statusToApproval mapping", () => {
    expect(statusToApproval("active")).toBe("approved")
    expect(statusToApproval("rejected")).toBe("rejected")
    expect(statusToApproval("candidate")).toBe("pending")
    expect(statusToApproval("draft")).toBe("pending")
  })

  test("listByStatus narrows by workspace scope", () => {
    const shared = store.stageCandidate(mem({ scope: "project-shared", projectId: "project_aaa" }))
    store.stageCandidate(mem({ scope: "user-global" }))
    const candAll = store.listByStatus("candidate")
    expect(candAll.length).toBe(2)
    const candProj = store.listByStatus("candidate", "project-shared", "project_aaa")
    expect(candProj.map((r) => r.id)).toEqual([shared.id])
  })
})

describe("S0 durable store root resolution (docs/34 §7.2)", () => {
  test("roots derive from injected baseDir, never real home", () => {
    expect(userGlobalKnowledgeRoot("/base")).toBe(path.join("/base", "public", "knowledge"))
    expect(projectKnowledgeRoot("/base", "project_x")).toBe(path.join("/base", "project", "project_x", "knowledge"))
    expect(userGlobalKnowledgeRoot("/base").startsWith("/base")).toBe(true)
    expect(projectKnowledgeRoot("/base", "project_x").startsWith("/base")).toBe(true)
  })

  test("openProjectStore isolates by workspace path; user-global shared", () => {
    const a = openProjectStore(root, "/work/projectA")
    const b = openProjectStore(root, "/work/projectB")
    const g = openUserGlobalStore(root)
    const da = a.stageCandidate(mem({ scope: "project-shared", projectId: projectIdForWorkspace("/work/projectA") }))
    a.approve(da.id)
    const dg = g.stageCandidate(mem({ scope: "user-global" }))
    g.approve(dg.id)

    const pidA = projectIdForWorkspace("/work/projectA")
    expect(a.retrieve({ types: ["memory"], projectId: pidA, limit: 5 }).map((h) => h.doc.id)).toContain(da.id)
    expect(
      b.retrieve({ types: ["memory"], projectId: projectIdForWorkspace("/work/projectB"), limit: 5 }),
    ).toHaveLength(0)
    expect(g.retrieve({ types: ["memory"], limit: 5 }).map((h) => h.doc.id)).toContain(dg.id)
  })

  test("projectIdForWorkspace is stable per path", () => {
    expect(projectIdForWorkspace("/work/projectA")).toBe(projectIdForWorkspace("/work/projectA"))
    expect(projectIdForWorkspace("/work/projectA")).not.toBe(projectIdForWorkspace("/work/projectB"))
  })

  test("stageCandidate dedups exact duplicates and reinforces instead of creating rows", () => {
    const first = store.stageCandidate(
      mem({
        description: "use redis for the rate limiter",
        confidence: { evidence_strength: "weak", support_count: 1 },
      }),
    )
    const again = store.stageCandidate(
      mem({
        description: "use redis for the rate limiter",
        confidence: { evidence_strength: "medium", support_count: 1 },
      }),
    )
    // Same logical knowledge -> same doc id, support_count bumped, evidence raised to the stronger.
    expect(again.id).toBe(first.id)
    expect(store.documentStore.list({ type: "memory" })).toHaveLength(1)
    expect(again.confidence?.support_count).toBe(2)
    expect(again.confidence?.evidence_strength).toBe("medium")
  })

  test("stageCandidate merges near-duplicates (same point, different wording)", () => {
    const first = store.stageCandidate(mem({ description: "cache the user session in redis to speed up auth" }))
    const reworded = store.stageCandidate(mem({ description: "cache the user session in redis to speed auth up" }))
    expect(reworded.id).toBe(first.id)
    expect(store.documentStore.list({ type: "memory" })).toHaveLength(1)
    expect(reworded.confidence?.support_count).toBe((first.confidence?.support_count ?? 0) + 1)
  })

  test("stageCandidate keeps unrelated knowledge as separate rows", () => {
    store.stageCandidate(mem({ description: "use redis for the rate limiter" }))
    store.stageCandidate(mem({ description: "validate webhook signatures before processing" }))
    expect(store.documentStore.list({ type: "memory" })).toHaveLength(2)
  })

  test("stageCandidate does not merge across different scope/domain", () => {
    store.stageCandidate(mem({ description: "use redis for the rate limiter", domain: "code" }))
    store.stageCandidate(mem({ description: "use redis for the rate limiter", domain: "infra" }))
    expect(store.documentStore.list({ type: "memory" })).toHaveLength(2)
  })
})
