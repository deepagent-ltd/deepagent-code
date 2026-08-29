/**
 * C0-08 legacy-zero inventory gate runner.
 *
 *   bun run script/legacy-zero-gate/run-gate.ts [counts|oracle|must-be-zero]
 *
 *   - counts       : print the real counters (never hidden).
 *   - oracle       : print the red-oracle report + byte-stable snapshot.
 *   - must-be-zero : exit non-zero while any zero-target is non-zero (the CI gate).
 *
 * The default mode is `oracle`. The gate is script+test only and never imported by
 * production src (zero overhead when unused).
 */
import { buildInventory } from "../caller-inventory/build"
import { violationsByVerdict, violationsFor } from "./counter"
import { countSelectionBridgeUsages } from "./selection-bridge"
import { currentTreeCounts, mustBeZero, redOracle } from "./gate"

const mode = process.argv[2] ?? "oracle"

if (mode === "counts") {
  const inventory = buildInventory()
  const counters = currentTreeCounts(inventory)
  const violations = violationsFor(inventory)
  console.log(JSON.stringify(counters, null, 2))
  console.log(`violations=${JSON.stringify(violationsByVerdict(violations))}`)
  console.log(`selection_bridge=${countSelectionBridgeUsages()}`)
} else if (mode === "must-be-zero") {
  try {
    const digest = mustBeZero()
    console.log(`legacy-zero gate PASSED (snapshot ${digest})`)
    process.exit(0)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
} else {
  const snapshot = redOracle()
  void snapshot
}
