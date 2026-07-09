import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  desensitize,
  decideFastPath,
  useGateAction,
  type AdoptionRecord,
  type EnvironmentFactCandidate,
} from "../../src/deepagent/environment-fact"
import { openUserGlobalStore } from "../../src/deepagent/durable-knowledge-store"

const base = () => mkdtempSync(path.join(tmpdir(), "envfact-"))

describe("V3.8.1 §G environment-fact desensitization (fail-closed)", () => {
  test("strips a connection-URL credential and mints a secret ref", () => {
    const r = desensitize("connect via postgres://admin:hunter2@db.test:5432/milvus", "milvus")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sanitized).not.toContain("hunter2")
      expect(r.sanitized).toContain("postgres://db.test:5432")
      expect(r.secretRefs.length).toBeGreaterThan(0)
    }
  })

  test("a URL whose only signal is stripped userinfo passes clean", () => {
    // The credential is inside the URL userinfo; once stripped, no keyword remains -> clean fast path.
    const r = desensitize("endpoint at redis://svc:sk-abcdefghijklmnopqrstuvwxyz012345@cache.test:6379", "svc")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sanitized).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345")
      expect(r.sanitized).toContain("redis://cache.test:6379")
    }
  })

  test("fails closed when a bare 'token' keyword survives even after the value is stripped", () => {
    // Conservative by design (§G.4 step 2): the value is excised but the keyword signal remains.
    const r = desensitize("use token sk-abcdefghijklmnopqrstuvwxyz012345 for the endpoint", "svc")
    expect(r.ok).toBe(false)
  })

  test("fails closed when a residual keyword+value remains after stripping", () => {
    // "password: hunter2" is a keyword signal with a value we cannot structurally excise → review.
    const r = desensitize("the password is hunter2, connect to db.test", "db")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("residual_sensitive")
  })

  test("a pure fact with no secrets desensitizes cleanly with no refs", () => {
    const r = desensitize("milvus standalone on 10.0.0.4:19530, container milvus-standalone", "milvus")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.secretRefs).toEqual([])
  })
})

describe("V3.8.1 §G decideFastPath routing", () => {
  const clean: EnvironmentFactCandidate = {
    description: "milvus integration test server",
    body: { host: "10.0.0.4", port: 19530, container: "milvus-standalone", purpose: "integration tests", last_confirmed_at: "2026-07-07T00:00:00Z" },
  }

  test("clean fact takes the fast path", () => {
    const d = decideFastPath(clean)
    expect(d.kind).toBe("fast_path")
  })

  test("fact whose notes leak a residual secret routes to review", () => {
    const d = decideFastPath({ ...clean, body: { ...clean.body, notes: "root password is s3cr3tpw manual" } })
    expect(d.kind).toBe("review")
  })

  test("fast path folds minted refs into the sanitized body", () => {
    const d = decideFastPath({
      ...clean,
      body: { ...clean.body, notes: "admin url mysql://u:p@10.0.0.4:3306" },
    })
    expect(d.kind).toBe("fast_path")
    if (d.kind === "fast_path") expect(d.sanitizedBody.secret_refs?.length).toBeGreaterThan(0)
  })
})

describe("V3.8.1 §G provisional store write + no silent injection", () => {
  test("environment_fact lands at provisional in user-global and is NOT returned by retrieve()", () => {
    const store = openUserGlobalStore(base())
    const doc = store.stageProvisionalEnvironmentFact({
      description: "milvus test server",
      body: JSON.stringify({ host: "10.0.0.4", port: 19530, last_confirmed_at: "2026-07-07T00:00:00Z" }),
      provenance: { source: "human" },
    })
    expect(doc.status).toBe("provisional")
    expect(doc.scope).toBe("durable")

    // retrieve() must never surface it (whitelist excludes environment_fact AND status!=active).
    const got = store.retrieve({ types: ["environment_fact", "knowledge", "memory"], limit: 20 })
    expect(got.find((s) => s.doc.id === doc.id)).toBeUndefined()

    // but it IS discoverable through the use-gate listing.
    expect(store.listProvisionalEnvironmentFacts().some((r) => r.id === doc.id)).toBe(true)
  })

  test("re-declaring the same fact updates in place (idempotent, no row pileup)", () => {
    const store = openUserGlobalStore(base())
    const first = store.stageProvisionalEnvironmentFact({
      description: "milvus test server",
      body: JSON.stringify({ host: "10.0.0.4", last_confirmed_at: "2026-07-07T00:00:00Z" }),
      provenance: { source: "human" },
    })
    store.stageProvisionalEnvironmentFact({
      description: "milvus test server",
      body: JSON.stringify({ host: "10.0.0.5", last_confirmed_at: "2026-07-09T00:00:00Z" }),
      provenance: { source: "human" },
    })
    expect(store.listProvisionalEnvironmentFacts().length).toBe(1)
    expect(store.listProvisionalEnvironmentFacts()[0]!.id).toBe(first.id)
  })

  test("markEnvironmentFactStale quarantines the fact and rejects non-env docs", () => {
    const store = openUserGlobalStore(base())
    const doc = store.stageProvisionalEnvironmentFact({
      description: "flaky server",
      body: JSON.stringify({ host: "10.0.0.9", last_confirmed_at: "2026-07-07T00:00:00Z" }),
      provenance: { source: "human" },
    })
    expect(store.markEnvironmentFactStale(doc.id)).toBe(true)
    expect(store.markEnvironmentFactStale("doc:knowledge:nope")).toBe(false)
    expect(store.listProvisionalEnvironmentFacts().some((r) => r.id === doc.id)).toBe(false) // no longer provisional
  })
})

describe("V3.8.1 §G use-gate adoption (per project × fact)", () => {
  const facts: readonly AdoptionRecord[] = [
    { fact_id: "doc:environment_fact:milvus", stance: "adopted", decided_at: "2026-07-08T00:00:00Z", adopted_version: 1 },
    { fact_id: "doc:environment_fact:old-redis", stance: "rejected", decided_at: "2026-07-08T00:00:00Z" },
    { fact_id: "doc:environment_fact:pg", stance: "adopted", decided_at: "2026-07-08T00:00:00Z", override_doc_id: "doc:environment_fact:pg-local" },
  ]

  test("unseen fact -> ask", () => {
    expect(useGateAction("doc:environment_fact:new", facts).action).toBe("ask")
  })
  test("adopted fact -> use silently", () => {
    expect(useGateAction("doc:environment_fact:milvus", facts).action).toBe("use")
  })
  test("rejected fact -> skip (never ask again in this project)", () => {
    expect(useGateAction("doc:environment_fact:old-redis", facts).action).toBe("skip")
  })
  test("project-override adoption returns the override doc id", () => {
    const r = useGateAction("doc:environment_fact:pg", facts)
    expect(r.action).toBe("use")
    expect(r.overrideDocId).toBe("doc:environment_fact:pg-local")
  })
})
