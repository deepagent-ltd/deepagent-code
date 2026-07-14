import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as Registry from "../../src/deepagent/domain-pack-registry"
import { admitIndexRefs, formatPackIndexSection } from "../../src/deepagent/context-admission"
import type {
  ExtendedProblemProfile,
  PackManifest,
  DomainPackIndexEntry,
} from "../../src/deepagent/domain-pack-registry"

let dir: string

const profile = (over: Partial<ExtendedProblemProfile> = {}): ExtendedProblemProfile => ({
  scenario_mode: "intelligence",
  agent_strength: "max",
  task_kind: "implement",
  code_domains: ["code"],
  business_domains: [],
  platforms: [],
  languages: ["typescript"],
  frameworks: [],
  data_classes: [],
  risk_markers: [],
  repo_signals: [],
  round_signals: [],
  user_overrides: [],
  ...over,
})

const writePack = (id: string, manifest: Partial<PackManifest>, index: DomainPackIndexEntry[] = []) => {
  const packDir = path.join(dir, id)
  mkdirSync(packDir, { recursive: true })
  writeFileSync(
    path.join(packDir, "pack.json"),
    JSON.stringify({
      schema_version: "domain_pack.v1",
      id,
      name: id,
      version: "1.0.0",
      scope: "system",
      risk: "low",
      domains: [],
      provides: [],
      ...manifest,
    }),
  )
  writeFileSync(path.join(packDir, "index.json"), JSON.stringify(index))
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "deepagent-packreg-"))
  Registry.configureRegistry(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("S4 DomainPackRegistry", () => {
  test("built-in packs are discovered with no user dir (bundled packages/domain-packs)", () => {
    Registry.configureRegistry(undefined)
    const ids = Registry.discover().map((m) => m.id)
    // The 9 seed packs ship with the app and must be discoverable out of the box.
    expect(ids).toContain("code.core")
    expect(ids).toContain("code.gpu-kernel")
    expect(ids).toContain("business.finance")
    expect(ids.length).toBeGreaterThanOrEqual(9)
    Registry.configureRegistry(dir) // restore test isolation
  })

  test("built-in pack resolver supports desktop bundled chunk paths", () => {
    const packagesDir = path.resolve(fileURLToPath(import.meta.url), "../../../..")
    const resolved = Registry.resolveBuiltinPackDirForMetaUrl(
      pathToFileURL(path.join(packagesDir, "desktop/out/main/chunks/node-test.js")).href,
    )
    expect(resolved).not.toBeNull()
    if (!resolved) return
    expect([path.join(packagesDir, "desktop/out/main/domain-packs"), path.join(packagesDir, "domain-packs")]).toContain(
      resolved,
    )
  })

  test("discover reads manifests (not bodies), skips malformed", () => {
    writePack("code.core", { domains: ["code"] })
    writePack("bad", {})
    mkdirSync(path.join(dir, "nopack"), { recursive: true })
    mkdirSync(path.join(dir, "broken"), { recursive: true })
    writeFileSync(path.join(dir, "broken", "pack.json"), "{not json")
    const found = Registry.discover().map((m) => m.id)
    expect(found).toContain("code.core")
    expect(found).toContain("bad")
    expect(found).not.toContain("broken")
  })

  test("score uses inline detector", () => {
    writePack("code.ts", {
      domains: ["typescript"],
      detector: { inline: "profile.languages.includes('typescript') ? 0.9 : 0", threshold: 0.5 },
    })
    const scores = Registry.score(profile({ languages: ["typescript"] }))
    expect(scores.find((s) => s.packId === "code.ts")?.score).toBe(0.9)
    const miss = Registry.score(profile({ languages: ["python"] }))
    expect(miss.find((s) => s.packId === "code.ts")?.score).toBe(0)
  })

  test("a broken detector scores 0 (never crashes)", () => {
    writePack("code.bad", { detector: { inline: "profile.nonexistent.deep.crash()", threshold: 0.5 } })
    const scores = Registry.score(profile())
    expect(scores.find((s) => s.packId === "code.bad")?.score).toBe(0)
  })

  test("resolve expands transitive dependencies", () => {
    writePack("code.core", { domains: ["code"] })
    writePack("code.ts", { domains: ["typescript"], depends_on: ["code.core"] })
    writePack("code.react", { domains: ["react"], depends_on: ["code.ts"] })
    const res = Registry.resolve(["code.react"])
    expect(res.activePackIds).toContain("code.core")
    expect(res.activePackIds).toContain("code.ts")
    expect(res.activePackIds).toContain("code.react")
  })

  test("resolve flags conflicts; high-risk conflict blocks", () => {
    writePack("risk.a", { risk: "high", conflicts_with: ["risk.b"] })
    writePack("risk.b", { risk: "high" })
    const res = Registry.resolve(["risk.a", "risk.b"])
    expect(res.conflicts.length).toBeGreaterThan(0)
    expect(res.conflicts[0]!.severity).toBe("block")
  })

  test("lockSnapshot is deterministic for the same pack set", () => {
    writePack("code.core", { version: "1.2.0" })
    const s1 = Registry.lockSnapshot(["code.core"])
    const s2 = Registry.lockSnapshot(["code.core"])
    expect(s1.id).toBe(s2.id)
    const s3 = Registry.lockSnapshot(["code.core", "other"])
    expect(s3.id).not.toBe(s1.id)
  })

  test("activateForProfile honors user overrides (pinned packs)", () => {
    writePack("code.core", { domains: ["code"], detector: { inline: "0", threshold: 0.5 } })
    const { resolution } = Registry.activateForProfile(profile({ user_overrides: ["code.core"] }))
    expect(resolution.activePackIds).toContain("code.core")
  })

  test("loadIndexRefs returns only the active pack's entries", () => {
    const entry: DomainPackIndexEntry = {
      ref_id: "strategy:code.core:x",
      type: "strategy",
      title: "X",
      summary: "do x",
      domains: ["code"],
      triggers: [],
      scope: "system",
      evidence_strength: "strong",
      risk: "low",
      sensitivity: "public",
      allowed_strengths: ["high", "max", "ultra"],
      pack_id: "code.core",
    }
    writePack("code.core", { domains: ["code"] }, [entry])
    const snap = Registry.lockSnapshot(["code.core"])
    const refs = Registry.loadIndexRefs(snap)
    expect(refs.map((r) => r.ref_id)).toEqual(["strategy:code.core:x"])
  })
})

describe("S6 ContextAdmissionGate", () => {
  const mkEntry = (over: Partial<DomainPackIndexEntry> = {}): DomainPackIndexEntry => ({
    ref_id: "strategy:x",
    type: "strategy",
    title: "T",
    summary: "summary text",
    domains: ["code"],
    triggers: [],
    scope: "system",
    evidence_strength: "strong",
    risk: "low",
    sensitivity: "public",
    allowed_strengths: ["high", "max", "ultra"],
    pack_id: "p",
    ...over,
  })

  test("general admits nothing (DAP-3)", () => {
    const r = admitIndexRefs([mkEntry()], "general")
    expect(r.admitted).toHaveLength(0)
    expect(r.truncated).toHaveLength(1)
  })

  test("high admits skills but not strategy/knowledge", () => {
    const r = admitIndexRefs(
      [mkEntry({ type: "skill", ref_id: "skill:a" }), mkEntry({ type: "strategy", ref_id: "strategy:b" })],
      "high",
    )
    const ids = r.admitted.map((e) => e.ref_id)
    expect(ids).toContain("skill:a")
    expect(ids).not.toContain("strategy:b")
  })

  test("max admits strategy + skill", () => {
    const r = admitIndexRefs(
      [mkEntry({ type: "skill", ref_id: "skill:a" }), mkEntry({ type: "strategy", ref_id: "strategy:b" })],
      "max",
    )
    expect(r.admitted.map((e) => e.ref_id).sort()).toEqual(["skill:a", "strategy:b"])
  })

  test("xhigh admits skills + domain knowledge but not strategy (docs/39 §3.1)", () => {
    const strengths = ["high", "xhigh", "max", "ultra"] as const
    const r = admitIndexRefs(
      [
        mkEntry({ type: "skill", ref_id: "skill:a", allowed_strengths: strengths }),
        mkEntry({ type: "knowledge", ref_id: "knowledge:b", allowed_strengths: strengths }),
        mkEntry({ type: "strategy", ref_id: "strategy:c", allowed_strengths: strengths }),
      ],
      "xhigh",
    )
    const ids = r.admitted.map((e) => e.ref_id)
    expect(ids).toContain("skill:a")
    expect(ids).toContain("knowledge:b")
    expect(ids).not.toContain("strategy:c")
  })

  test("high admits skills but not domain knowledge (docs/39 §3.1)", () => {
    const strengths = ["high", "xhigh", "max", "ultra"] as const
    const r = admitIndexRefs(
      [
        mkEntry({ type: "skill", ref_id: "skill:a", allowed_strengths: strengths }),
        mkEntry({ type: "knowledge", ref_id: "knowledge:b", allowed_strengths: strengths }),
      ],
      "high",
    )
    const ids = r.admitted.map((e) => e.ref_id)
    expect(ids).toContain("skill:a")
    expect(ids).not.toContain("knowledge:b")
  })

  test("weak/none evidence is excluded", () => {
    const r = admitIndexRefs(
      [mkEntry({ evidence_strength: "weak", ref_id: "w" }), mkEntry({ evidence_strength: "strong", ref_id: "s" })],
      "max",
    )
    expect(r.admitted.map((e) => e.ref_id)).toEqual(["s"])
  })

  test("ref count cap truncates the overflow", () => {
    const entries = Array.from({ length: 30 }, (_, i) => mkEntry({ ref_id: `strategy:${i}` }))
    const r = admitIndexRefs(entries, "max", { max_index_refs: 5 })
    expect(r.admitted).toHaveLength(5)
    expect(r.truncated).toHaveLength(25)
  })

  test("token budget skips an over-budget ref but still admits a smaller one behind it", () => {
    // large ref (~200 tokens) sits ahead of a small ref (~3 tokens) in filter order.
    // budget admits only the small one; the large one must be SKIPPED, not starve the small ref.
    const large = mkEntry({ ref_id: "strategy:large", title: "L", summary: "x".repeat(800) })
    const small = mkEntry({ ref_id: "strategy:small", title: "S", summary: "tiny" })
    const budget = 20
    const r = admitIndexRefs([large, small], "max", { max_estimated_tokens: budget })
    const ids = r.admitted.map((e) => e.ref_id)
    expect(ids).toContain("strategy:small") // previously starved by the greedy break
    expect(ids).not.toContain("strategy:large")
    // budget bookkeeping: skipped ref must not be charged, total must stay within ceiling
    expect(r.estimated_tokens).toBeLessThanOrEqual(budget)
    expect(r.truncated.map((e) => e.ref_id)).toContain("strategy:large")
  })

  test("formatPackIndexSection emits nothing when empty, header when populated", () => {
    expect(
      formatPackIndexSection({ admitted: [], truncated: [], admitted_ref_count: 0, estimated_tokens: 0 }, []),
    ).toBe("")
    const section = formatPackIndexSection(
      { admitted: [mkEntry()], truncated: [], admitted_ref_count: 1, estimated_tokens: 10 },
      ["code"],
    )
    expect(section).toContain("Active domain packs: code")
    expect(section).toContain("strategy:x")
  })
})
