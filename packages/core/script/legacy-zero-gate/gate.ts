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
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { buildInventory } from "../caller-inventory/build"
import { rootRepoPath } from "../caller-inventory/ast"
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
  /** SHA-256 of every evidence-anchor file's content (repo-relative path -> digest), so the
   * snapshot binds source bytes, not only file:line anchors. Missing files carry a fixed marker. */
  readonly evidenceFileDigests: Readonly<Record<string, string>>
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
    evidenceFileDigests: snapshot.evidenceFileDigests,
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
    evidenceFileDigests: digestEvidenceFiles(inventory, bridgeSites),
    snapshotDigest: "",
  }
  const digest = contentDigest(stableIdentity(stable))
  return { ...stable, snapshotDigest: digest }
}

const ABSENT_FILE_DIGEST = contentDigest({ present: false })

/**
 * Content-bind every file the snapshot anchors to: entry modules, structurally linked handler
 * modules, role evidence hits and selection-bridge sites. A content-only edit that keeps every
 * file:line anchor identical still changes the snapshot digest. Fixture tests reference
 * nonexistent paths; those keep a fixed absent marker so the digest stays deterministic.
 */
function digestEvidenceFiles(inventory: Inventory, bridgeSites: readonly SelectionBridgeSite[]): Record<string, string> {
  const files = new Set<string>()
  for (const entry of inventory.entries) {
    files.add(entry.entry.repoFile)
    for (const handler of entry.handlers) files.add(handler.repoFile)
    for (const role of entry.roles) for (const proof of role.evidence) files.add(proof.repoFile)
  }
  for (const site of bridgeSites) files.add(site.repoFile)
  const root = rootRepoPath()
  const out: Record<string, string> = {}
  for (const repoFile of [...files].sort()) {
    const absolute = join(root, repoFile)
    out[repoFile] = existsSync(absolute)
      ? createHash("sha256").update(readFileSync(absolute, "utf8")).digest("hex")
      : ABSENT_FILE_DIGEST
  }
  return out
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
 * mustBeZero(): the C0-08 exit gate over the V2-DEFAULT ENTRY SET (user decision D2,
 * 2026-09-03): the tree fails while double-write or selection-bridge authority is non-zero —
 * those are authority leaks inside the default V2 path. `legacy` and `unclassified` dimensions
 * are release-blocking; an `adapter` is informational because valid V2↔vendor protocol adapters
 * are not V1 authority. Returns the snapshot digest when the
 * gate passes. Pass a bridgeSites override (e.g. [] in a fixture test) to decouple the counter
 * check from the live source scan.
 */
export function mustBeZero(inventory: Inventory = buildInventory(), bridgeSites: readonly SelectionBridgeSite[] = selectionBridgeSites()): string {
  const counters = computeCounters(inventory)
  const bridgeUsages = countSelectionBridgeUsages(bridgeSites)
  const violations = violationsFor(inventory)
  if (
    counters.legacyDims === 0 &&
    counters.doubleWrite === 0 &&
    counters.unclassifiedDims === 0 &&
    bridgeUsages === 0
  ) {
    return buildSnapshot(inventory, bridgeSites).snapshotDigest
  }
  const lines: string[] = []
  lines.push("legacy-zero gate FAILED — the V2-default entry set still carries split authority:")
  lines.push(`  legacy=${counters.legacyDims} double_write=${counters.doubleWrite} unclassified=${counters.unclassifiedDims} selection_bridge=${bridgeUsages} (informational adapters=${counters.adapterDims})`)
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
