/**
 * C0-01 gate runner.
 *
 *   bun run script/caller-inventory/run-inventory.ts [--out <dir>]
 *
 * Builds the frozen production caller inventory from AST/structured-route sources and
 * writes byte-stable machine-readable reports (report.json + summary.json). Re-running
 * on the same base tree must produce identical bytes; any diff is denominator drift.
 */
import { writeReport } from "./build"
import { rootRepoPath } from "./ast"

const args = process.argv.slice(2)
const outIndex = args.indexOf("--out")
const defaultOut = `${rootRepoPath()}/packages/core/.artifacts/caller-inventory`
const out = outIndex >= 0 ? args[outIndex + 1] : defaultOut
if (!out) throw new Error("--out requires a directory argument")

const started = Date.now()
const { jsonPath, summaryPath, inventory } = writeReport(out)
const durationMs = Date.now() - started

console.log(`caller inventory: ${inventory.totals.entries} entries across ${Object.keys(inventory.totals.bySurface).length} surfaces`)
for (const [surface, count] of Object.entries(inventory.totals.bySurface).sort(([a], [b]) => (a < b ? -1 : 1))) {
  console.log(`  ${surface.padEnd(18)} ${count}`)
}
console.log(`verdicts: ${JSON.stringify(inventory.totals.byVerdict)}`)
console.log(`entries with open owners: ${inventory.totals.unclassifiedEntries} (${inventory.totals.unclassifiedRoles} of ${inventory.totals.entries * 7} dimension verdicts)`)
console.log(`reports written in ${durationMs}ms:`)
console.log(`  ${jsonPath}`)
console.log(`  ${summaryPath}`)
