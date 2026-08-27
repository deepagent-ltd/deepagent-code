import * as fs from "node:fs"
import { DB_TIERS, timeOpen, type DbFixture } from "../fixtures"
import { summarizeGroups, type ScenarioOutcome } from "../lib"

export interface DatabaseOpenOptions {
  readonly fixtures: Record<(typeof DB_TIERS)[number], DbFixture>
  readonly opensPerTier: number
}

/**
 * Reopens the same migrated fixture file N times per tier. Each sample covers the full
 * production open path: sqlite PRAGMAs, DatabaseMigration.apply (idempotent no-op once the
 * linear history is complete), capability protocol scan. OS page cache is warm after the
 * first pass for every tier — that steady-state cost is what is being measured and declared.
 */
export const runDatabaseOpen = async (options: DatabaseOpenOptions): Promise<ScenarioOutcome> => {
  const startedAt = performance.now()
  const groups: Array<ScenarioOutcome["groups"][number]> = []
  let totalFailures = 0

  for (const tier of DB_TIERS) {
    const fixture = options.fixtures[tier]
    const values: number[] = []
    let failures = 0
    for (let index = 0; index < options.opensPerTier; index++) {
      try {
        values.push(await timeOpen(fixture.file))
      } catch {
        failures += 1
      }
    }
    totalFailures += failures
    groups.push({ group: `${tier}_db`, values, failures })
  }

  const walSizes = Object.fromEntries(
    DB_TIERS.map((tier) => {
      const fixture = options.fixtures[tier]
      return [
        `fixture_${tier}`,
        {
          db_bytes: fs.statSync(fixture.file).size,
          wal_bytes: fs.existsSync(`${fixture.file}-wal`) ? fs.statSync(`${fixture.file}-wal`).size : 0,
          shm_bytes: fs.existsSync(`${fixture.file}-shm`) ? fs.statSync(`${fixture.file}-shm`).size : 0,
        },
      ]
    }),
  )

  return summarizeGroups(
    {
      name: "database-open-migration-check",
      owner_note:
        "open path owned by core database layer (packages/core/src/database/database.ts layerFromPath) running PRAGMA setup + linear migration check + capability scan. No application code runs on top.",
      status: "ok",
      evidence_refs: ["packages/core/src/database/database.ts", "packages/core/src/database/migration.ts"],
      groups,
      extras: {
        unit: "ms",
        sample_basis:
          "36 opens per tier after fixture build; open cost is single-digit-to-tens of ms, so 36 samples resolve p95/p99 while keeping tier sweep under a minute",
        fixture_note: "same migrated file reopened per sample; warm page cache steady state",
        opens_per_tier: options.opensPerTier,
        failures_total: totalFailures,
        file_sizes: walSizes,
      },
    },
    performance.now() - startedAt,
  )
}
