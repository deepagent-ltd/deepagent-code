import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DocumentRevisionConflictError,
  DocumentStore,
  documentRevision,
  getGovernanceEnvelope,
} from "../../src/deepagent/document-store"

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "deepagent-document-governance-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  DocumentStore.__resetSharedRegistryForTests()
})

const createCandidate = (store: DocumentStore) => {
  const draft = store.create({
    type: "strategy",
    scope: "durable",
    body: "use a durable admission receipt",
    description: "durable admission",
    tags: ["learned"],
    idSlug: "candidate:durable-admission",
    provenance: { source: "runner", run_ref: "run:1", evidence_refs: ["eval:1"] },
    confidence: { evidence_strength: "strong", support_count: 1 },
    extensions: { candidate_id: "candidate:durable-admission" },
  })
  return store.commitGovernance(draft.id, documentRevision(draft), {
    kind: "stage",
    actor: { type: "system", id: "test-stage" },
    transitionedAt: 1,
  })
}

const versionFile = (doc: { readonly id: string; readonly type: string; readonly version: number }) =>
  path.join(root, "docs", doc.type, `${doc.id.replaceAll(":", "__")}@v${doc.version}.json`)

describe("BUG-407-002 immutable document governance", () => {
  test("two shared handles using one expected revision have one winner", () => {
    const first = DocumentStore.shared(root)
    const staged = createCandidate(first)
    const second = DocumentStore.shared(root)
    const before = readFileSync(versionFile(staged), "utf8")
    const approved = first.commitGovernance(staged.id, documentRevision(staged), {
      kind: "approve",
      actor: { type: "human", id: "reviewer-a" },
      reviewRef: "review:1",
      transitionedAt: 2,
    })

    expect(() =>
      second.commitGovernance(staged.id, documentRevision(staged), {
        kind: "reject",
        actor: { type: "human", id: "reviewer-b" },
        reason: "conflicting evidence",
        transitionedAt: 2,
      }),
    ).toThrow(DocumentRevisionConflictError)
    expect(readFileSync(versionFile(staged), "utf8")).toBe(before)
    expect(new DocumentStore(root).get(staged.id)).toEqual(approved)
  })

  test("exact decision retry is a no-op, while reread permits an explicit follow-up", () => {
    const store = new DocumentStore(root)
    const staged = createCandidate(store)
    const approved = store.commitGovernance(staged.id, documentRevision(staged), {
      kind: "approve",
      actor: { type: "human", id: "reviewer" },
      reviewRef: "review:retry",
      transitionedAt: 2,
    })
    const retried = store.commitGovernance(approved.id, documentRevision(approved), {
      kind: "approve",
      actor: { type: "human", id: "reviewer" },
      reviewRef: "review:retry",
      transitionedAt: 3,
    })
    expect(retried).toEqual(approved)

    const rejected = store.commitGovernance(retried.id, documentRevision(retried), {
      kind: "reject",
      actor: { type: "human", id: "reviewer" },
      reason: "new counter-evidence",
      reviewRef: "review:follow-up",
      transitionedAt: 4,
    })
    expect(rejected.version).toBe(approved.version + 1)
    expect(rejected.status).toBe("rejected")
  })

  test("rollback appends a new decision and preserves every historical revision", () => {
    const store = new DocumentStore(root)
    const staged = createCandidate(store)
    const approved = store.commitGovernance(staged.id, documentRevision(staged), {
      kind: "approve",
      actor: { type: "human", id: "reviewer" },
      transitionedAt: 2,
    })
    const rejected = store.commitGovernance(approved.id, documentRevision(approved), {
      kind: "reject",
      actor: { type: "human", id: "reviewer" },
      reason: "regression",
      transitionedAt: 3,
    })
    const restored = store.commitGovernance(rejected.id, documentRevision(rejected), {
      kind: "approve",
      actor: { type: "human", id: "rollback-owner" },
      reviewRef: "rollback:1",
      transitionedAt: 4,
    })
    const reopened = new DocumentStore(root)

    expect(restored.id).toBe(staged.id)
    expect(restored.version).toBe(rejected.version + 1)
    expect(reopened.get(staged.id, staged.version)?.status).toBe("candidate")
    expect(reopened.get(staged.id, approved.version)?.status).toBe("active")
    expect(reopened.get(staged.id, rejected.version)?.status).toBe("rejected")
    expect(reopened.get(staged.id, restored.version)?.status).toBe("active")
    expect(getGovernanceEnvelope(restored)).toMatchObject({
      review_status: "approved",
      actor_id: "rollback-owner",
      review_ref: "rollback:1",
    })
    expect(reopened.verify()).toEqual({ ok: true, violations: [] })
  })

  test("two Bun processes racing the same next version produce one commit and one conflict", async () => {
    const store = new DocumentStore(root)
    const doc = store.create({
      type: "design",
      scope: "run:1",
      body: "base",
      description: "process race",
      provenance: { source: "human" },
    })
    const before = readFileSync(versionFile(doc), "utf8")
    const start = path.join(root, "start")
    const fixture = path.join(import.meta.dir, "document-store-writer.ts")
    const processes = ["one", "two"].map((body) => {
      const ready = path.join(root, `ready-${body}`)
      return {
        ready,
        process: Bun.spawn([process.execPath, fixture, root, doc.id, body, ready, start], {
          cwd: import.meta.dir,
          stdout: "pipe",
          stderr: "pipe",
        }),
      }
    })
    const deadline = Date.now() + 5_000
    while (!processes.every((entry) => existsSync(entry.ready))) {
      if (Date.now() >= deadline) throw new Error("document writer processes did not reach the barrier")
      await Bun.sleep(5)
    }
    writeFileSync(start, "go")
    const results = await Promise.all(
      processes.map(async (entry) => ({
        exit: await entry.process.exited,
        stdout: await new Response(entry.process.stdout).text(),
        stderr: await new Response(entry.process.stderr).text(),
      })),
    )

    expect(results.map((result) => result.exit).sort((a, b) => a - b)).toEqual([0, 17])
    expect(results.map((result) => JSON.parse(result.stdout.trim()).outcome).sort()).toEqual(["committed", "conflict"])
    expect(results.every((result) => result.stderr === "")).toBe(true)
    expect(readFileSync(versionFile(doc), "utf8")).toBe(before)
    expect(readdirSync(path.dirname(versionFile(doc))).sort()).toEqual([
      `${doc.id.replaceAll(":", "__")}@v1.json`,
      `${doc.id.replaceAll(":", "__")}@v2.json`,
    ])
    expect(["one", "two"].includes(new DocumentStore(root).get(doc.id)?.body ?? "")).toBe(true)
  })
})
