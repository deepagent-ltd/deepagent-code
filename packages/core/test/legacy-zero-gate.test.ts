/**
 * C0-08 legacy-zero inventory gate tests.
 *
 * The EXIT gate covers the V2 production entry set and fails on legacy, double-write,
 * unclassified, or selection-bridge authority. Sanctioned non-V1 adapters remain informational.
 * The counter tests verify the
 * COUNTER implementation against a small fixture inventory and the real await buildInventory()
 * output; mustBeZero() is asserted GREEN on the current tree and to throw on double-write
 * authority.
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildInventory } from "../script/caller-inventory/build"
import { rootRepoPath } from "../script/caller-inventory/ast"
import { tmpdir } from "./fixture/tmpdir"
import {
  DIMENSIONS,
  SURFACE_IDS,
  type ClassifiedEntry,
  type Dimension,
  type Evidence,
  type Inventory,
  type RoleClassification,
  type SurfaceId,
  type Verdict,
} from "../script/caller-inventory/types"
import {
  computeCounters,
  violationsByVerdict,
  violationsFor,
  ZERO_TARGET_VERDICTS,
} from "../script/legacy-zero-gate/counter"
import { countSelectionBridgeUsages, selectionBridgeSites } from "../script/legacy-zero-gate/selection-bridge"
import {
  GATE_SCHEMA_VERSION,
  LegacyZeroError,
  buildSnapshot,
  currentTreeCounts,
  mustBeZero,
  redOracle,
} from "../script/legacy-zero-gate/gate"

const FIXTURE_EVIDENCE: Evidence = { repoFile: "src/fixture.ts", line: 1, marker: "reach:fixture", distance: 0 }

function makeRole(dimension: Dimension, verdict: Verdict): RoleClassification {
  return { dimension, verdict, evidence: verdict === "unclassified" ? [] : [FIXTURE_EVIDENCE] }
}

function allRoles(verdict: Verdict): RoleClassification[] {
  return DIMENSIONS.map((dimension) => makeRole(dimension, verdict))
}

function makeEntry(id: string, surface: SurfaceId, roles: RoleClassification[]): ClassifiedEntry {
  return {
    entry: { id, surface, kind: "fixture", name: id, repoFile: "src/fixture.ts", line: 1 },
    handlers: [],
    roles,
    unclassifiedCount: roles.filter((r) => r.verdict === "unclassified").length,
  }
}

function fixtureInventory(entries: ClassifiedEntry[]): Inventory {
  const byVerdict = { legacy: 0, v2: 0, adapter: 0, read_only: 0, double_write: 0, unclassified: 0 } as Record<Verdict, number>
  const bySurface = Object.fromEntries(SURFACE_IDS.map((s) => [s, 0])) as Record<SurfaceId, number>
  let unclassifiedRoles = 0
  for (const entry of entries) {
    bySurface[entry.entry.surface] += 1
    for (const role of entry.roles) {
      byVerdict[role.verdict] += 1
      if (role.verdict === "unclassified") unclassifiedRoles += 1
    }
  }
  return {
    baseCommit: "fixturebase00000000000000000000000000000000",
    entries,
    totals: {
      entries: entries.length,
      unclassifiedEntries: entries.filter((e) => e.unclassifiedCount > 0).length,
      unclassifiedRoles,
      byVerdict,
      bySurface,
    },
  }
}

function dirtyFixture(): Inventory {
  const legacySvc = makeEntry("fixture.legacy-svc", "http", allRoles("legacy"))
  const doubleBridge = makeEntry(
    "fixture.v2-bridge",
    "event",
    DIMENSIONS.map((d) => (d === "event_producer_consumer" ? makeRole(d, "double_write") : makeRole(d, "read_only"))),
  )
  const adapterProv = makeEntry(
    "fixture.adapter-prov",
    "provider",
    DIMENSIONS.map((d) => (d === "provider_tool_writer" ? makeRole(d, "adapter") : makeRole(d, "read_only"))),
  )
  const v2Ctx = makeEntry("fixture.v2-ctx", "composition", allRoles("v2"))
  return fixtureInventory([legacySvc, doubleBridge, adapterProv, v2Ctx])
}

function cleanFixture(): Inventory {
  return fixtureInventory([
    makeEntry("fixture.v2-ctx", "composition", allRoles("v2")),
    makeEntry("fixture.ro-reader", "recovery", allRoles("read_only")),
  ])
}

const SHA256 = /^[0-9a-f]{64}$/

describe("C0-08 legacy-zero counter (fixture inventory)", () => {
  test("dirty fixture counters are exact", () => {
    const counters = computeCounters(dirtyFixture())
    expect(counters.legacyDims).toBe(7)
    expect(counters.doubleWrite).toBe(1)
    expect(counters.doubleWriteEntries).toBe(1)
    expect(counters.v2Dims).toBe(7)
    expect(counters.adapterDims).toBe(1)
    expect(counters.readOnlyDims).toBe(12)
    expect(counters.unclassifiedDims).toBe(0)
  })

  test("violations enumerate every violating entry x dimension", () => {
    const violations = violationsFor(dirtyFixture())
    expect(violations.length).toBe(8)
    expect(violationsByVerdict(violations)).toEqual({ legacy: 7, double_write: 1 })
    expect(violations.some((v) => v.entryId === "fixture.v2-bridge" && v.dimension === "event_producer_consumer" && v.verdict === "double_write")).toBe(true)
    for (const violation of violations) expect(violation.evidence.length).toBeGreaterThan(0)
  })

  test("mustBeZero throws LegacyZeroError on the dirty fixture", async () => {
    let caught: unknown
    try { await mustBeZero(dirtyFixture(), []) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(LegacyZeroError)
    const error = caught as LegacyZeroError
    expect(error.counters.legacyDims).toBe(7)
    expect(error.violations.length).toBe(8)
    expect(error.message).toContain("legacy-zero gate FAILED")
    expect(error.message).toContain("fixture.v2-bridge :: event_producer_consumer :: double_write")
  })

  test("mustBeZero passes on the clean fixture (green path when all zero-targets are 0)", async () => {
    const digest = await mustBeZero(cleanFixture(), [])
    expect(digest).toMatch(SHA256)
    const counters = computeCounters(cleanFixture())
    expect(counters.legacyDims).toBe(0)
    expect(counters.doubleWrite).toBe(0)
    expect(counters.adapterDims).toBe(0)
  })

  test("mustBeZero permits sanctioned adapters but rejects legacy authority", async () => {
    const adapterOnly = fixtureInventory([makeEntry("fixture.adapter", "provider", allRoles("adapter"))])
    const digest = await mustBeZero(adapterOnly, [])
    expect(digest).toMatch(SHA256)
    const counters = computeCounters(adapterOnly)
    expect(counters.legacyDims).toBe(0)
    expect(counters.adapterDims).toBeGreaterThan(0)
    expect(counters.doubleWrite).toBe(0)
    await expect(mustBeZero(fixtureInventory([makeEntry("fixture.legacy-owner", "im", allRoles("legacy"))]), [])).rejects.toThrow(LegacyZeroError)
  })

  test("empty inventory yields all-zero counters and no violations", async () => {
    const empty = fixtureInventory([])
    const counters = computeCounters(empty)
    expect(counters.legacyDims).toBe(0)
    expect(counters.v2Dims).toBe(0)
    expect(counters.adapterDims).toBe(0)
    expect(counters.readOnlyDims).toBe(0)
    expect(counters.unclassifiedDims).toBe(0)
    expect(violationsFor(empty)).toEqual([])
    expect(await mustBeZero(empty, [])).toMatch(SHA256)
  })

  test("zero-target verdict set is frozen", () => {
    expect(ZERO_TARGET_VERDICTS).toEqual(["legacy", "double_write"])
  })
})

const realInventory = await buildInventory()

describe("C0-08 legacy-zero gate real inventory (actual frozen numbers)", () => {
  const inventory = realInventory
  const bridgeSites = selectionBridgeSites()

  test("frozen counters match the C0-01 report (red oracle, never hidden)", async () => {
    const counters = await currentTreeCounts(inventory)
    expect(counters.legacyDims).toBe(0)
    expect(counters.doubleWrite).toBe(0)
    expect(counters.doubleWriteEntries).toBe(0)
    // v2f-d IM durable-only migration re-pin (2026-09-18): +3 v2 (im.agent-execution
    // admission/execution, im.reply-outbox event), -28 adapter (the deleted executor/reply-sink/
    // progress-stream faces became read_only mention resolution / dead orchestrator; createMessage
    // and the goal/panel pack keep adapter with V2-native markers), read-only 2153→2178.
    // v2f-i residual sweep (2026-09-18): the production-dead core agent-orchestrator module is
    // deleted, removing its read_only-on-all-7 entry — read-only 2178→2171.
    // v2w-j4 GitHub durable-only ingress (2026-09-19): the new github.agent-execution declared
    // entry carries v2 on admission/execution (+2) and read_only on its other five dims (+5).
    // V2.0.1 merge-wave re-pin (2026-09-23): w-c-desktop removed the desktop.wsl-sidecar
    // entry (-7 v2 dims) and the merged W-b/K-04/M-b/C-P2-08 waves added read-only surfaces
    // (shell scan/arity, migration orchestrator + md-export endpoints, provider config
    // provenance, task admission/reclamation) — v2 220->213, read-only 2176->2204.
    expect(counters.v2Dims).toBe(213)
    // V2.0.2 caller expansion: 2 proxy chat adapters plus 3 tenant mutations (+35 dims);
    // 15 learning/catalog/admin-query/bundle and other routes are read-only (+105 dims).
    expect(counters.adapterDims).toBe(474)
    expect(counters.readOnlyDims).toBe(2344)
    expect(counters.unclassifiedDims).toBe(0)
  })

  test("counters derived from roles agree with inventory.totals.byVerdict", () => {
    const counters = computeCounters(inventory)
    expect(counters.legacyDims).toBe(inventory.totals.byVerdict.legacy)
    expect(counters.doubleWrite).toBe(inventory.totals.byVerdict.double_write)
    expect(counters.v2Dims).toBe(inventory.totals.byVerdict.v2)
    expect(counters.adapterDims).toBe(inventory.totals.byVerdict.adapter)
    expect(counters.readOnlyDims).toBe(inventory.totals.byVerdict.read_only)
    expect(counters.unclassifiedDims).toBe(inventory.totals.byVerdict.unclassified)
  })

  test("selection-bridge usages are ZERO after C3-08 (v2-none fallback removed)", () => {
    expect(countSelectionBridgeUsages(bridgeSites)).toBe(0)
    expect(bridgeSites).toEqual([])
  })

  test("the known double-write path is GONE (C7-05 flip: event.v2-bridge is V2 authority)", () => {
    const doubleWrite = violationsFor(inventory).filter((v) => v.verdict === "double_write")
    expect(doubleWrite.length).toBe(0)
    const v2 = inventory.entries
      .find((entry) => entry.entry.id === "event.v2-bridge")
      ?.roles.find((role) => role.dimension === "event_producer_consumer")
    expect(v2?.verdict).toBe("v2")
  })

  test("every legacy/write/adapter violation carries machine evidence", () => {
    for (const violation of violationsFor(inventory)) {
      expect(violation.evidence.length).toBeGreaterThan(0)
      expect(violation.entryId.length).toBeGreaterThan(0)
      expect(violation.dimension.length).toBeGreaterThan(0)
    }
  })

  test("mustBeZero is GREEN at the zero-clearance freeze point (RI-71 zero wave, 2026-09-11)", async () => {
    // The gate flipped from RED (kept red through 108 legacy dims) to GREEN: every legacy
    // dimension was migrated with a machine-verified proof, not by relaxing the gate.
    const digest = await mustBeZero(inventory)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    const counters = await currentTreeCounts(inventory)
    expect(counters.legacyDims).toBe(0)
    expect(counters.doubleWrite).toBe(0)
    expect(counters.adapterDims).toBe(474)
  })
})

describe("C0-08 legacy-zero gate snapshot (byte-stable)", () => {
  const inventory = realInventory
  const bridgeSites = selectionBridgeSites()

  test("buildSnapshot is deterministic (same input tree -> identical bytes + digest)", () => {
    const a = buildSnapshot(inventory, bridgeSites)
    const b = buildSnapshot(inventory, bridgeSites)
    expect(b.snapshotDigest).toBe(a.snapshotDigest)
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  test("snapshot digest is a sha256 hex and the snapshot is schema-frozen", () => {
    const snapshot = buildSnapshot(inventory, bridgeSites)
    expect(snapshot.snapshotDigest).toMatch(SHA256)
    expect(snapshot.schemaVersion).toBe(GATE_SCHEMA_VERSION)
    expect(snapshot.schemaVersion).toBe("legacy-zero.v1")
    expect(snapshot.gate).toBe("C0-08 legacy-zero inventory gate")
  })

  test("digest changes when the counters change (red vs clean tree)", () => {
    const red = buildSnapshot(dirtyFixture(), [])
    const green = buildSnapshot(cleanFixture(), [])
    expect(red.snapshotDigest).not.toBe(green.snapshotDigest)
  })

  test("snapshot counters carry the frozen red numbers", () => {
    const snapshot = buildSnapshot(inventory, bridgeSites)
    expect(snapshot.counters.legacyDims).toBe(0)
    expect(snapshot.counters.doubleWrite).toBe(0)
    expect(snapshot.counters.adapterDims).toBe(474)
    // v2w-j4 (2026-09-19): +2 v2 dims (github.agent-execution admission/execution).
    // V2.0.1 merge-wave re-pin (2026-09-23): w-c removed desktop.wsl-sidecar (-7 v2 dims);
    // merged W-b/K-04/M-b/C-P2-08 waves added read-only surfaces — v2 220->213, read-only ->2204.
    expect(snapshot.counters.v2Dims).toBe(213)
    // 2026-09-08 step 5c 重钉:同批漂移(402→401)。v2f-d (2026-09-18): entries net-zero
    // (deleted reply-sink/progress-stream faces replaced by durable admission + reply outbox).
    // v2f-i (2026-09-18): the dead core agent-orchestrator entry is deleted (404→403, roles −7).
    // v2w-j4 (2026-09-19): github.agent-execution is declared (+1 entry, +7 roles — v2 on
    // admission/execution, read_only on the rest).
    expect(snapshot.entries).toBe(433)
    // 2026-09-08 step 5c 重钉:同批漂移(2814→2807)。
    expect(snapshot.roles).toBe(3031)
    expect(snapshot.selectionBridgeUsages).toBe(0)
  })

  test("redOracle prints the same byte-stable snapshot digest as buildSnapshot", async () => {
    const original = console.log
    const captured: string[] = []
    console.log = (line: unknown) => { captured.push(String(line)) }
    let returned: Awaited<ReturnType<typeof redOracle>> | undefined
    try { returned = await redOracle(inventory) } finally { console.log = original }
    expect(returned).toBeDefined()
    expect(returned!.snapshotDigest).toBe(buildSnapshot(inventory, bridgeSites).snapshotDigest)
    expect(captured.join("\n")).toContain("legacy_dims        0")
  })

  test("the snapshot digest binds evidence-anchor CONTENT: a content-only edit under identical file:line anchors flips it", async () => {
    await using tmp = await tmpdir()
    const anchor = path.join(tmp.path, "anchor.ts")
    const repoFile = path.relative(rootRepoPath(), anchor)
    const anchorEntry = (): ClassifiedEntry => ({
      entry: { id: "fixture.anchor", surface: "composition", kind: "fixture", name: "fixture.anchor", repoFile, line: 1 },
      handlers: [],
      roles: DIMENSIONS.map((dimension): RoleClassification => ({
        dimension,
        verdict: "v2",
        evidence: [{ repoFile, line: 1, marker: "reach:anchor", distance: 0 }],
      })),
      unclassifiedCount: 0,
    })

    await Bun.write(anchor, "export const anchor = 1\n")
    const before = buildSnapshot(fixtureInventory([anchorEntry()]), [])
    await Bun.write(anchor, "export const anchor = 2\n")
    const after = buildSnapshot(fixtureInventory([anchorEntry()]), [])

    // Identical entries/counters/anchors — only the file bytes changed.
    expect(after.entries).toBe(before.entries)
    expect(after.counters).toEqual(before.counters)
    expect(after.snapshotDigest).not.toBe(before.snapshotDigest)
    expect(before.evidenceFileDigests[repoFile]).not.toBe(after.evidenceFileDigests[repoFile])
    expect(after.evidenceFileDigests[repoFile]).toBe(
      createHash("sha256").update(readFileSync(anchor, "utf8")).digest("hex"),
    )
  })

  test("evidence digests cover the real inventory anchors and match the bytes on disk", () => {
    const snapshot = buildSnapshot(inventory, bridgeSites)
    const digests = Object.entries(snapshot.evidenceFileDigests)
    expect(digests.length).toBeGreaterThan(0)
    expect(
      digests.map(([file]) => file),
    ).toEqual(digests.map(([file]) => file).sort())
    for (const [file, digest] of digests) {
      expect(digest).toBe(createHash("sha256").update(readFileSync(path.join(rootRepoPath(), file), "utf8")).digest("hex"))
    }
  })
})
