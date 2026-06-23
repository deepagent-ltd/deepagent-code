import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { HookPolicy, stopHookGate, patchSizeGuard } from "../../src/deepagent/hooks"
import { DocumentStore } from "../../src/deepagent/document-store"
import { explainCandidate } from "../../src/deepagent/reviewer"

describe("V3 hooks", () => {
  test("stop hook blocks without validation", () => {
    const p = new HookPolicy().on("stop", stopHookGate())
    expect(p.evaluate({ name: "stop", payload: { requiredValidationsRun: false } }).decision).toBe("block")
    expect(p.evaluate({ name: "stop", payload: { requiredValidationsRun: true } }).decision).toBe("allow")
  })
  test("patch size guard blocks oversized diffs", () => {
    const p = new HookPolicy().on("before_patch_apply", patchSizeGuard(100))
    expect(p.evaluate({ name: "before_patch_apply", payload: { diffLines: 250 } }).decision).toBe("block")
    expect(p.evaluate({ name: "before_patch_apply", payload: { diffLines: 10 } }).decision).toBe("allow")
  })
  // P2-2: providerToolGuard removed — the gateway's ProviderExecutedToolPolicy is the single
  // authoritative provider-executed-tool gate (no parallel hook copy).
})

describe("V3 reviewer projection", () => {
  let root: string
  let store: DocumentStore
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "deepagent-rev-")); store = new DocumentStore(root) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test("explainCandidate answers why accepted via graph links", () => {
    const prov = { source: "model" as const, run_ref: "run:t1" }
    const design = store.create({ type: "design", scope: "run:t1", body: "d", description: "design", provenance: prov })
    const cand = store.create({ type: "candidate", scope: "run:t1", body: "c", description: "cand", provenance: prov, links: [{ rel: "derived_from", to: design.id }] })
    store.create({ type: "eval", scope: "run:t1", body: "10/10", description: "eval", provenance: prov, links: [{ rel: "validated_by", to: cand.id }] })
    store.create({ type: "decision", scope: "run:t1", body: "accept: metric improved 12%, no regressions", description: "decision", provenance: prov, links: [{ rel: "refines", to: cand.id }] })

    const ex = explainCandidate(store, cand.id)
    expect(ex.decision?.verdict).toBe("accept")
    expect(ex.decision?.reason).toContain("metric improved")
    expect(ex.parents.some((p) => p.id === design.id)).toBe(true)
    expect(ex.evals.length).toBe(1)
  })
})
