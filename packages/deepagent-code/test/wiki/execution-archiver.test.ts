import { describe, expect, test, afterEach } from "bun:test"
import { rmSync } from "node:fs"
import { Effect } from "effect"
import { WikiGraph, WikiService, GateRejectedError } from "../../src/wiki/wiki-service"
import { ExecutionArchiver } from "../../src/wiki/execution-archiver"
import { DurableKnowledgeStore } from "@deepagent-code/core/deepagent/durable-knowledge-store"
import { freshStore } from "./helpers"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runSync(e)

const runnerProv = { source: "runner" as const, run_ref: "run:s1" }

// Build a session run store with a plan + worklog + diagnosis + decision trajectory (scope run:s1).
const seedSession = (sessionId = "s1") => {
  const { store, root } = freshStore()
  roots.push(root)
  const scope = `run:${sessionId}`
  store.create({ type: "plan", scope, body: "goal: ship feature\nstep 1 done", description: "plan", provenance: runnerProv })
  store.create({ type: "worklog", scope, body: "did the work", description: "worklog", provenance: runnerProv })
  store.create({ type: "diagnosis", scope, body: "root cause X", description: "diagnosis", provenance: runnerProv })
  store.create({ type: "decision", scope, body: "accept", description: "decision", provenance: runnerProv })
  // a durable knowledge doc that must NOT appear in the archive (wrong scope)
  store.create({
    type: "knowledge",
    scope: "durable",
    body: "unrelated",
    description: "durable fact",
    confidence: { evidence_strength: "weak", support_count: 1 },
    provenance: { source: "model" },
  })
  return { store, sessionId }
}

const archiver = (store: DurableKnowledgeStore["documentStore"], promotionStore: DurableKnowledgeStore) => {
  const graph = new WikiGraph([store])
  const wiki = new WikiService(new WikiGraph([store, promotionStore.documentStore]))
  return new ExecutionArchiver({ graph, promotionStore, wiki })
}

const freshDurable = () => {
  const root = mkdtempSync(path.join(tmpdir(), "deepagent-wiki-dks-"))
  roots.push(root)
  return new DurableKnowledgeStore(root)
}

describe("ExecutionArchiver — §B.6 archiveSession", () => {
  test("aggregates plan+worklog+diagnosis+decision, excludes wrong-scope docs", () => {
    const { store, sessionId } = seedSession()
    const arch = archiver(store, freshDurable())
    const archive = run(arch.archiveSession(sessionId))
    const types = archive.entries.map((e) => e.type).sort()
    expect(types).toEqual(["decision", "diagnosis", "plan", "worklog"])
    expect(archive.markdown).toContain("Execution Archive — session s1")
    expect(archive.markdown).toContain("root cause X")
    // durable knowledge doc is NOT in the archive
    expect(archive.entries.some((e) => e.type === "knowledge")).toBe(false)
  })

  test("empty session → archive with no entries", () => {
    const { store, root } = freshStore()
    roots.push(root)
    const arch = archiver(store, freshDurable())
    const archive = run(arch.archiveSession("nope"))
    expect(archive.entries.length).toBe(0)
    expect(archive.markdown).toContain("No trajectory documents")
  })
})

describe("ExecutionArchiver — §B.6 promoteToWiki (evidence-gate governance)", () => {
  test("promotes an archive into a governed active knowledge page", () => {
    const { store, sessionId } = seedSession()
    const promotionStore = freshDurable()
    const arch = archiver(store, promotionStore)
    const page = run(arch.promoteToWiki({ archiveId: sessionId, editor: { id: "bob", name: "Bob" } }))
    expect(page.type).toBe("knowledge")
    expect(page.editable).toBe(true)
    // landed active in the durable store via stage→approve (DAP-8 governance path)
    const doc = promotionStore.documentStore.get(page.docId)!
    expect(doc.status).toBe("active")
    expect(doc.provenance.source).toBe("human")
    expect(doc.tags).toContain("execution-archive")
  })

  test("empty session → GateRejectedError (nothing to promote)", () => {
    const { store, root } = freshStore()
    roots.push(root)
    const arch = archiver(store, freshDurable())
    const err = Effect.runSync(arch.promoteToWiki({ archiveId: "empty", editor: { id: "u1" } }).pipe(Effect.flip))
    expect(err).toBeInstanceOf(GateRejectedError)
  })

  test("injected gate rejection → GateRejectedError, nothing persisted", () => {
    const { store, sessionId } = seedSession()
    const promotionStore = freshDurable()
    const graph = new WikiGraph([store])
    const wiki = new WikiService(new WikiGraph([store, promotionStore.documentStore]))
    const arch = new ExecutionArchiver({
      graph,
      promotionStore,
      wiki,
      gate: () => ({ pass: false, reason: "denied by policy" }),
    })
    const err = Effect.runSync(arch.promoteToWiki({ archiveId: sessionId, editor: { id: "u1" } }).pipe(Effect.flip))
    expect(err).toBeInstanceOf(GateRejectedError)
    expect((err as GateRejectedError).reason).toBe("denied by policy")
    // nothing staged
    expect(promotionStore.listByStatus("candidate").length).toBe(0)
    expect(promotionStore.listByStatus("active").length).toBe(0)
  })
})
