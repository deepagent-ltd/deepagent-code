/**
 * C0-08 legacy-zero inventory gate (modes + byte-stable snapshot).
 *
 * The gate exposes three modes over the C0-01 frozen caller inventory:
 *
 *   - currentTreeCounts(): the real numbers on the current tree — never hidden. This is the
 *                           red oracle's honest report while migration is incomplete.
 *   - mustBeZero():        throws a LegacyZeroError listing every violating entry+dimension and
 *                           every selection-bridge site when any zero-target is non-zero.
 *   - redOracle():         prints the counts and returns the byte-stable snapshot (digest over
 *                           the stable identity, independent of machine-local state).
 *
 * The gate is script+test only (never imported by production src), so it carries zero
 * overhead when unused.
 */
import { buildInventory } from "../caller-inventory/build"
import type { Inventory } from "../caller-inventory/types"
import {
  computeCounters,
  violationsByVerdict,
  violationsFor,
  type LegacyZeroCounters,
  type Violation,
} from "./counter"
import {
  countSelectionBridgeUsages,
  selectionBridgeSites,
  type SelectionBridgeSite,
} from "./selection-bridge"
import { contentDigest } from "../../src/contract/digest"

/** Schema identity of this gate's snapshot (frozen; bump via a successor only). */
export const GATE_SCHEMA_VERSION = "legacy-zero.v1" as const

/** The gate's stable machine-readable snapshot. */
export type LegacyZeroSnapshot = {
  readonly gate: "C0-08 legacy-zero inventory gate"
  readonly schemaVersion: typeof GATE_SCHEMA_VERSION
  readonly baseCommit: string
  readonly entries: number
  readonly roles: number
  readonly counters: LegacyZeroCounters
  readonly selectionBridgeUsages: number
  readonly selectionBridgeSites: readonly SelectionBridgeSite[]
  readonly violations: readonly Violation[]
  readonly violationCounts: Readonly<Record<string, number>>
  /** Byte-stable SHA-256 over the stable identity (excludes itself). */
  readonly snapshotDigest: string
}

/** Thrown by mustBeZero() while any legacy-zero target is non-zero. */
export class LegacyZeroError extends Error {
  readonly violations: readonly Violation[]
  readonly selectionBridgeSites: readonly SelectionBridgeSite[]
  readonly counters: LegacyZeroCounters

  constructor(message: string, detail: {
    readonly counters: LegacyZeroCounters
    readonly violations: readonly Violation[]
    readonly selectionBridgeSites: readonly SelectionBridgeSite[]
  }) {
    super(message)
    this.name = "LegacyZeroError"
    this.counters = detail.counters
    this.violations = detail.violations
    this.selectionBridgeSites = detail.selectionBridgeSites
  }
}

/** The stable identity a snapshot digest is computed over (excludes the digest itself). */
function stableIdentity(snapshot: Omit<LegacyZeroSnapshot, "snapshotDigest">): unknown {
  return {
    gate: snapshot.gate,
    schemaVersion: snapshot.schemaVersion,
    baseCommit: snapshot.baseCommit,
    entries: snapshot.entries,
    roles: snapshot.roles,
    counters: snapshot.counters,
    selectionBridgeUsages: snapshot.selectionBridgeUsages,
    selectionBridgeSites: snapshot.selectionBridgeSites,
    violations: snapshot.violations,
    violationCounts: snapshot.violationCounts,
  }
}

/**
 * Build the gate snapshot for one inventory build + the live source scan.
 *
 * Deterministic: same inventory and same source tree produce the same bytes and the same
 * snapshot digest, so re-running the gate detects denominator drift as a diff.
 */
export function buildSnapshot(inventory: Inventory, bridgeSites: readonly SelectionBridgeSite[] = selectionBridgeSites()): LegacyZeroSnapshot {
  const counters = computeCounters(inventory)
  const violations = violationsFor(inventory)
  const stable = {
    gate: "C0-08 legacy-zero inventory gate" as const,
    schemaVersion: GATE_SCHEMA_VERSION,
    baseCommit: inventory.baseCommit,
    entries: inventory.entries.length,
    roles: inventory.entries.reduce((sum, entry) => sum + entry.roles.length, 0),
    counters,
    selectionBridgeUsages: countSelectionBridgeUsages(bridgeSites),
    selectionBridgeSites: bridgeSites,
    violations,
    violationCounts: violationsByVerdict(violations),
    snapshotDigest: "",
  }
  const digest = contentDigest(stableIdentity(stable))
  return { ...stable, snapshotDigest: digest }
}

/**
 * currentTreeCounts(): the real legacy-zero numbers on the current tree, never hidden.
 *
 * An inventory may be supplied to avoid re-running the AST extraction; by default the gate
 * builds the frozen production caller inventory itself.
 */
export function currentTreeCounts(inventory: Inventory = buildInventory()): LegacyZeroCounters {
  return computeCounters(inventory)
}

/**
 * mustBeZero(): throw a LegacyZeroError naming every violating entry+dimension and every
 * selection-bridge site while any zero-target is non-zero. Returns the snapshot digest when
 * the tree is clean (legacy=0, double-write=0, adapter=0, selection-bridge=0). Pass a
 * bridgeSites override (e.g. [] in a fixture test) to decouple the counter check from the live
 * source scan.
 */
export function mustBeZero(inventory: Inventory = buildInventory(), bridgeSites: readonly SelectionBridgeSite[] = selectionBridgeSites()): string {
  const counters = computeCounters(inventory)
  const bridgeUsages = countSelectionBridgeUsages(bridgeSites)
  const violations = violationsFor(inventory)
  if (counters.legacyDims === 0 && counters.doubleWrite === 0 && counters.adapterDims === 0 && bridgeUsages === 0) {
    return buildSnapshot(inventory, bridgeSites).snapshotDigest
  }
  const lines: string[] = []
  lines.push("legacy-zero gate FAILED — production tree still carries legacy authority:")
  lines.push(`  legacy dims=${counters.legacyDims} double_write=${counters.doubleWrite} adapter=${counters.adapterDims} selection_bridge=${bridgeUsages}`)
  lines.push("violations (entry :: dimension :: verdict):")
  for (const violation of violations) {
    lines.push(`    ${violation.entryId} :: ${violation.dimension} :: ${violation.verdict}`)
  }
  if (bridgeUsages > 0) {
    lines.push("v2-none selection-bridge usage sites:")
    for (const site of bridgeSites) lines.push(`    ${site.repoFile}:${site.line}`)
  }
  throw new LegacyZeroError(lines.join("\n"), { counters, violations, selectionBridgeSites: bridgeSites })
}

/**
 * redOracle(): print the counts and return the byte-stable snapshot. The print is a single
 * ordered block so re-running the oracle on the same tree produces identical output.
 */
export function redOracle(inventory: Inventory = buildInventory()): LegacyZeroSnapshot {
  const snapshot = buildSnapshot(inventory)
  const c = snapshot.counters
  console.log("C0-08 legacy-zero inventory gate (red oracle)")
  console.log(`  base_commit        ${snapshot.baseCommit}`)
  console.log(`  entries            ${snapshot.entries}`)
  console.log(`  roles              ${snapshot.roles}`)
  console.log(`  legacy_dims        ${c.legacyDims}`)
  console.log(`  double_write       ${c.doubleWrite}`)
  console.log(`  adapter_dims       ${c.adapterDims}`)
  console.log(`  v2_dims            ${c.v2Dims}`)
  console.log(`  read_only_dims     ${c.readOnlyDims}`)
  console.log(`  unclassified_dims  ${c.unclassifiedDims}`)
  console.log(`  selection_bridge   ${snapshot.selectionBridgeUsages}`)
  console.log(`  snapshot_digest    ${snapshot.snapshotDigest}`)
  return snapshot
}
