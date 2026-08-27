/**
 * C0-08 legacy-zero inventory gate tests.
 *
 * The gate is a red oracle on the current tree: the C0-01 frozen caller inventory still
 * classifies production entry points as legacy owner/writer (903 dimension roles), one
 * double-write path (event.v2-bridge), three legacy-only adapters carrying authority, and the
 * V2 selection bridge still commits four v2-none graph-revision fallbacks. The counter tests
 * verify the COUNTER implementation against both a small fixture inventory and the real
 * buildInventory() output, and mustBeZero() is asserted to FAIL honestly on the current tree —
 * green arrives only when C1B/C2-C5 migration completes.
 */
import { describe, expect, test } from "bun:test"
import { buildInventory } from "../script/caller-inventory/build"
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
    expect(violations.length).toBe(9)
    expect(violationsByVerdict(violations)).toEqual({ legacy: 7, double_write: 1, adapter: 1 })
    expect(violations.some((v) => v.entryId === "fixture.v2-bridge" && v.dimension === "event_producer_consumer" && v.verdict === "double_write")).toBe(true)
    for (const violation of violations) expect(violation.evidence.length).toBeGreaterThan(0)
  })

  test("mustBeZero throws LegacyZeroError on the dirty fixture", () => {
    let caught: unknown
    try { mustBeZero(dirtyFixture(), []) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(LegacyZeroError)
    const error = caught as LegacyZeroError
    expect(error.counters.legacyDims).toBe(7)
    expect(error.violations.length).toBe(9)
    expect(error.message).toContain("legacy-zero gate FAILED")
    expect(error.message).toContain("fixture.v2-bridge :: event_producer_consumer :: double_write")
  })

  test("mustBeZero passes on the clean fixture (green path when all zero-targets are 0)", () => {
    const digest = mustBeZero(cleanFixture(), [])
    expect(digest).toMatch(SHA256)
    const counters = computeCounters(cleanFixture())
    expect(counters.legacyDims).toBe(0)
    expect(counters.doubleWrite).toBe(0)
    expect(counters.adapterDims).toBe(0)
  })

  test("empty inventory yields all-zero counters and no violations", () => {
    const empty = fixtureInventory([])
    const counters = computeCounters(empty)
    expect(counters.legacyDims).toBe(0)
    expect(counters.v2Dims).toBe(0)
    expect(counters.adapterDims).toBe(0)
    expect(counters.readOnlyDims).toBe(0)
    expect(counters.unclassifiedDims).toBe(0)
    expect(violationsFor(empty)).toEqual([])
    expect(mustBeZero(empty, [])).toMatch(SHA256)
  })

  test("zero-target verdict set is frozen", () => {
    expect(ZERO_TARGET_VERDICTS).toEqual(["legacy", "double_write", "adapter"])
  })
})

describe("C0-08 legacy-zero gate real inventory (actual frozen numbers)", () => {
  const inventory = buildInventory()
  const bridgeSites = selectionBridgeSites()

  test("frozen counters match the C0-01 report (red oracle, never hidden)", () => {
    const counters = currentTreeCounts(inventory)
    expect(counters.legacyDims).toBe(903)
    expect(counters.doubleWrite).toBe(1)
    expect(counters.doubleWriteEntries).toBe(1)
    expect(counters.v2Dims).toBe(25)
    expect(counters.adapterDims).toBe(3)
    expect(counters.readOnlyDims).toBe(1721)
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

  test("selection-bridge usages are the canonical-turn v2-none fallback (4 graph revisions)", () => {
    expect(countSelectionBridgeUsages(bridgeSites)).toBe(4)
    for (const site of bridgeSites) {
      expect(site.repoFile).toBe("packages/core/src/session/runner/canonical-turn.ts")
      expect(site.line).toBe(37)
    }
  })

  test("the known double-write path is event.v2-bridge :: event_producer_consumer", () => {
    const doubleWrite = violationsFor(inventory).filter((v) => v.verdict === "double_write")
    expect(doubleWrite.length).toBe(1)
    expect(doubleWrite[0].entryId).toBe("event.v2-bridge")
    expect(doubleWrite[0].dimension).toBe("event_producer_consumer")
    expect(doubleWrite[0].evidence.length).toBeGreaterThanOrEqual(2)
  })

  test("every legacy/write/adapter violation carries machine evidence", () => {
    for (const violation of violationsFor(inventory)) {
      expect(violation.evidence.length).toBeGreaterThan(0)
      expect(violation.entryId.length).toBeGreaterThan(0)
      expect(violation.dimension.length).toBeGreaterThan(0)
    }
  })

  test("mustBeZero is RED on the current tree (green only after C1B/C2-C5 migration)", () => {
    let caught: unknown
    try { mustBeZero(inventory) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(LegacyZeroError)
    const error = caught as LegacyZeroError
    expect(error.counters.legacyDims).toBe(903)
    expect(error.counters.doubleWrite).toBe(1)
    expect(error.counters.adapterDims).toBe(3)
    expect(error.selectionBridgeSites.length).toBe(4)
    expect(error.message).toContain("legacy dims=903")
    expect(error.message).toContain("event.v2-bridge :: event_producer_consumer :: double_write")
    expect(error.violations.length).toBe(903 + 1 + 3)
  })
})

describe("C0-08 legacy-zero gate snapshot (byte-stable)", () => {
  const inventory = buildInventory()
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
    expect(snapshot.counters.legacyDims).toBe(903)
    expect(snapshot.counters.doubleWrite).toBe(1)
    expect(snapshot.counters.adapterDims).toBe(3)
    expect(snapshot.counters.v2Dims).toBe(25)
    expect(snapshot.entries).toBe(379)
    expect(snapshot.roles).toBe(2653)
    expect(snapshot.selectionBridgeUsages).toBe(4)
  })

  test("redOracle prints the same byte-stable snapshot digest as buildSnapshot", () => {
    const original = console.log
    const captured: string[] = []
    console.log = (line: unknown) => { captured.push(String(line)) }
    let returned: ReturnType<typeof redOracle> | undefined
    try { returned = redOracle(inventory) } finally { console.log = original }
    expect(returned).toBeDefined()
    expect(returned!.snapshotDigest).toBe(buildSnapshot(inventory, bridgeSites).snapshotDigest)
    expect(captured.join("\n")).toContain("legacy_dims        903")
  })
})
