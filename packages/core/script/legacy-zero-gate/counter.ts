/**
 * C0-08 legacy-zero inventory counters.
 *
 * Static counters derived from the C0-01 frozen production caller inventory
 * (script/caller-inventory/build.ts buildInventory). The gate's job is to report
 * and eventually zero the legacy-authority leak classes the worklist names:
 *
 *   1. legacy dims          : (entry, dimension) roles still classified as legacy
 *                             owner/writer (design.md §2.1 — a legacy authority).
 *   2. double-write         : roles that write the same authority onto both the
 *                             legacy and the V2 channel (design.md §1 gap 5).
 *   3. legacy-only adapters : adapter roles that carry execution/producer/writer
 *                             authority (design.md §2.1 — legacy may keep only a
 *                             read-only reader or a no-execution adapter).
 *
 * The counters are pure functions over an Inventory, so they are tested both
 * with a small fixture inventory and with the real buildInventory() output.
 * The gate itself is script+test only and is never imported by production src
 * (zero overhead when unused).
 */
import type { Dimension, Evidence, Inventory, Verdict } from "../caller-inventory/types"

/** Verdicts the legacy-zero gate treats as an active legacy-authority leak. */
export type ZeroTargetVerdict = "legacy" | "double_write" | "adapter"

/** Stable counter totals for one inventory build. */
export type LegacyZeroCounters = {
  /** Roles (entry × dimension) still classified as a legacy owner/writer. */
  readonly legacyDims: number
  /** Roles classified double-write (writing both legacy and V2 authority). */
  readonly doubleWrite: number
  /** Distinct entries that carry at least one double-write role. */
  readonly doubleWriteEntries: number
  /** Roles already on the V2 authority (informational, not a zero-target). */
  readonly v2Dims: number
  /** Adapter roles that carry legacy execution/producer/writer authority. */
  readonly adapterDims: number
  /** Roles read-only on the dimension (informational total). */
  readonly readOnlyDims: number
  /** Roles left unclassified (an honest freeze residual; never hidden). */
  readonly unclassifiedDims: number
}

/** One entry×dimension the legacy-zero gate must report/fail on. */
export type Violation = {
  readonly entryId: string
  readonly surface: string
  readonly dimension: Dimension
  readonly verdict: Verdict
  readonly evidence: readonly Evidence[]
}

/** Verdict words treated as legacy-zero violations (targets that must reach 0). */
export const ZERO_TARGET_VERDICTS: readonly ZeroTargetVerdict[] = ["legacy", "double_write", "adapter"]

const ZERO_TARGETS = new Set<ZeroTargetVerdict>(ZERO_TARGET_VERDICTS)

/**
 * Compute the legacy-zero counters from an inventory build.
 *
 * Counters are derived directly from {@link Inventory.entries} roles (each entry carries
 * exactly one role per authority dimension), so they stay self-consistent for both a
 * fixture inventory and the real buildInventory() output. The four frozen numbers asserted
 * by the real-inventory test (legacy dims 903, double-write 1, v2 dims 25, adapter dims 3)
 * are reported exactly as-is — the red oracle never hides a number.
 */
export function computeCounters(inventory: Inventory): LegacyZeroCounters {
  let legacyDims = 0, doubleWrite = 0, v2Dims = 0, adapterDims = 0, readOnlyDims = 0, unclassifiedDims = 0
  const doubleWriteEntries = new Set<string>()
  for (const entry of inventory.entries) {
    for (const role of entry.roles) {
      switch (role.verdict) {
        case "legacy": legacyDims += 1; break
        case "double_write": doubleWrite += 1; doubleWriteEntries.add(entry.entry.id); break
        case "v2": v2Dims += 1; break
        case "adapter": adapterDims += 1; break
        case "read_only": readOnlyDims += 1; break
        case "unclassified": unclassifiedDims += 1; break
      }
    }
  }
  return {
    legacyDims,
    doubleWrite,
    doubleWriteEntries: doubleWriteEntries.size,
    v2Dims,
    adapterDims,
    readOnlyDims,
    unclassifiedDims,
  }
}

/**
 * Enumerate every entry×dimension whose verdict is a legacy-zero target (legacy
 * owner/writer, double-write, or a legacy-only adapter carrying authority). This is the
 * exact list mustBeZero() throws over, so a failure names every violating entry and
 * dimension with its machine-verified evidence trail.
 */
export function violationsFor(inventory: Inventory): Violation[] {
  const violations: Violation[] = []
  for (const entry of inventory.entries) {
    for (const role of entry.roles) {
      if (!ZERO_TARGETS.has(role.verdict as ZeroTargetVerdict)) continue
      violations.push({
        entryId: entry.entry.id,
        surface: entry.entry.surface,
        dimension: role.dimension,
        verdict: role.verdict,
        evidence: role.evidence,
      })
    }
  }
  return violations
}

/**
 * Count violations grouped by verdict word — used by the red oracle's summary line
 * and by mustBeZero()'s failure message.
 */
export function violationsByVerdict(violations: readonly Violation[]): Readonly<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const violation of violations) out[violation.verdict] = (out[violation.verdict] ?? 0) + 1
  return out
}
