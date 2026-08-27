import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnHarnessChild, killHard, removeScratch } from "./kill-controller"
import { CRASH_POINTS, assertUniqueCrashPointIds } from "./crash-points"

// C0-04 - restart oracle + scenario runner.
// Oracle source of truth: the fixture DB row + the external sentinel markers
// (fsync'ed files in a separate directory) - NOT logs.

export type OracleOutcome = "converged" | "indeterminate" | "divergent"

export interface ScenarioResult {
  readonly scenarioId: string
  readonly crashPointId: string
  readonly outcome: OracleOutcome
  readonly expected: OracleOutcome
  readonly dbRow: boolean
  readonly doneMarker: boolean
  readonly pass: boolean
}

function readOracle(scratch: string): { dbRow: boolean; doneMarker: boolean } {
  const dbPath = join(scratch, "state.db")
  const markers = join(scratch, "markers")
  let dbRow = false
  if (existsSync(dbPath)) {
    try {
      const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
      const db = new Database(dbPath, { readonly: true })
      const rows = db.query("SELECT key FROM state WHERE key='flow' AND value='committed'").all() as unknown[]
      dbRow = rows.length > 0
      db.close()
    } catch {
      // DB not openable (fresh crash before create) - treat as no row.
    }
  }
  return { dbRow, doneMarker: existsSync(join(markers, "done")) }
}

export function classify(dbRow: boolean, doneMarker: boolean): OracleOutcome {
  if (dbRow && doneMarker) return "converged"
  if (dbRow && !doneMarker) return "indeterminate"
  if (!dbRow && !doneMarker) return "converged"
  return "divergent"
}

const FIXTURE = join(import.meta.dir, "fixture-child.ts")

export async function runScenario(opts: {
  readonly scenarioId: string
  readonly crashPointId: string
  readonly killAt: "before-commit" | "after-commit" | "never"
}): Promise<ScenarioResult> {
  const scratch = mkdtempSync(join(process.env.DEEPAGENT_CODE_TEST_HOME ?? tmpdir(), "crash-harness-"))
  const dbPath = join(scratch, "state.db")
  const markers = join(scratch, "markers")
  const spawned = spawnHarnessChild({
    run: FIXTURE,
    childArgs: [dbPath, markers],
    cwd: process.cwd(),
    env: opts.killAt === "never" ? { CRASH_SLEEP_MS: "120" } : {},
  })
  try {
    await spawned.ready
    if (opts.killAt === "before-commit") {
      killHard(spawned.child)
    } else {
      await spawned.committed
      if (opts.killAt === "after-commit") killHard(spawned.child)
      else await spawned.done
    }
  } finally {
    if (opts.killAt !== "never") {
      // ensure the child is fully dead before reading the oracle
      try {
        killHard(spawned.child)
      } catch {
        /* already exited */
      }
      await spawned.exit
    }
  }
  const { dbRow, doneMarker } = readOracle(scratch)
  const outcome = classify(dbRow, doneMarker)
  const expected = CRASH_POINTS.find((point) => point.id === opts.crashPointId)?.expected ?? "converged"
  removeScratch(scratch)
  return { scenarioId: opts.scenarioId, crashPointId: opts.crashPointId, outcome, expected, dbRow, doneMarker, pass: outcome === expected }
}

export function assertUniquePoints(): void {
  assertUniqueCrashPointIds()
}

export async function runAllFetch(): Promise<readonly ScenarioResult[]> {
  return [
    await runScenario({ scenarioId: "crash-before-commit", crashPointId: "CRASH-migration-receipt-002", killAt: "before-commit" }),
    await runScenario({ scenarioId: "crash-after-commit", crashPointId: "CRASH-tool-effect-001", killAt: "after-commit" }),
    await runScenario({ scenarioId: "full-run", crashPointId: "CRASH-migration-receipt-002", killAt: "never" }),
  ]
}
