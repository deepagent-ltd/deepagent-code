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

  test("collects run-graph docs scoped run:<runId> (≠ sessionId), not just run:<sessionId> (adversarial 2026-07-09)", () => {
    // The prod scope model: the goal loop writes under run:<sessionId>, but the per-run graph
    // materializer writes under run:<runId> (a distinct UUID). The old exact run:<sessionId> filter
    // dropped the run-graph trajectory. byScopePrefix("run:") now collects BOTH (the store union is
    // already scoped to one session upstream).
    const { store, root } = freshStore()
    roots.push(root)
    const runProv = { source: "runner" as const, run_ref: "run:run-uuid-xyz" }
    // A worklog + diagnosis under a run:<runId> scope that is NOT the sessionId.
    store.create({ type: "worklog", scope: "run:run-uuid-xyz", body: "run-graph worklog", description: "wl", provenance: runProv })
    store.create({ type: "diagnosis", scope: "run:run-uuid-xyz", body: "run-graph diag", description: "dg", provenance: runProv })
    // And a plan under run:<sessionId>.
    store.create({ type: "plan", scope: "run:sess-1", body: "the plan", description: "plan", provenance: { source: "runner", run_ref: "run:sess-1" } })
    const arch = archiver(store, freshDurable())
    const archive = run(arch.archiveSession("sess-1"))
    const types = archive.entries.map((e) => e.type).sort()
    expect(types).toEqual(["diagnosis", "plan", "worklog"]) // run:<runId> docs now included
    expect(archive.markdown).toContain("run-graph diag")
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
  test("DAP-8 stage→approve: promoteToWiki only STAGES a candidate (not active); approvePromotion flips it", () => {
    const { store, sessionId } = seedSession()
    const promotionStore = freshDurable()
    const arch = archiver(store, promotionStore)

    // Step 1 — promoteToWiki stages a CANDIDATE only; it must NOT be active/projectable yet.
    const { candidateId } = run(arch.promoteToWiki({ archiveId: sessionId, editor: { id: "bob", name: "Bob" } }))
    const staged = promotionStore.documentStore.get(candidateId)!
    expect(staged.status).toBe("candidate") // NOT active — auto-approve is gone
    expect(promotionStore.listByStatus("active").length).toBe(0)
    expect(staged.provenance.source).toBe("human")
    expect(staged.tags).toContain("execution-archive")

    // Step 2 — a SEPARATE human approval flips it active → a governed, projectable knowledge page.
    const page = run(arch.approvePromotion({ candidateId }))
    expect(page.type).toBe("knowledge")
    expect(page.editable).toBe(true)
    const doc = promotionStore.documentStore.get(page.docId)!
    expect(doc.status).toBe("active")
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
