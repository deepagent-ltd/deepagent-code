import { migrations } from "@deepagent-code/core/database/migration.gen"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { DatabaseUpgradeRun } from "@deepagent-code/core/database/upgrade-run"
import type { PreflightObservations, PreflightOptions } from "@deepagent-code/core/database/preflight"

// C1A-15 HISTORICAL FIXTURES. Deterministic DB-journal fixtures (JSON/SQL builders) that the migrator
// / preflight classifies as known / alias-resolved / merged-history / UNKNOWN. The eras (1.4.7,
// 1.4.8-rN, 2.0-alpha) are represented by the real historical-compat mechanisms in the code:
// historicalAliases (renamed released migrations) and mergedHistoryAnchor/insertions (the merged
// lineage gap). A fixture is a minimal `migration` journal (migration table rows) + a journal matrix.

export const registryIds: readonly string[] = migrations.map((migration) => migration.id)

/** canonical -> the alias ids that substitute for it (from the frozen historicalAliases map). */
export const aliasesByCanonical: ReadonlyMap<string, string[]> = (() => {
  const byCanonical = new Map<string, string[]>()
  for (const [alias, canonical] of DatabaseMigration.historicalAliases) {
    const existing = byCanonical.get(canonical) ?? []
    existing.push(alias)
    byCanonical.set(canonical, existing)
  }
  return byCanonical
})()

/** canonical id -> its content hash (the C0-02 receipt identity the journal hash must match). */
export const contentHashes: ReadonlyMap<string, string> = new Map(
  migrations.map((migration) => [migration.id, DatabaseUpgradeRun.migrationContentHash(migration)]),
)

export const mergedHistoryAnchor = DatabaseMigration.mergedHistoryAnchor
export const mergedHistoryInsertions: ReadonlySet<string> = DatabaseMigration.mergedHistoryInsertions

/**
 * Build a `migration` journal matrix for a fixture: `ids` is the set of migration ids present (some
 * may be aliases, replaced by their canonical — the caller decides). Returns PreflightObservations
 * with that journal.
 */
export const observationsFor = (
  ids: readonly string[],
  overrides: Partial<PreflightObservations> = {},
): PreflightObservations => ({
  filename: "/tmp/historical-fixture.db",
  exists: true,
  size: 4096,
  mode: 0o100644,
  sqliteHeaderValid: true,
  pageSize: 4096,
  pageCount: 10,
  journalMode: "wal",
  dbReadable: true,
  journalRows: ids.map((id) => ({ id, time_completed: 1 })),
  capabilities: [],
  upgradeRuns: [],
  walExists: false,
  walSize: 0,
  shmExists: false,
  shmSize: 0,
  freeSpaceBytes: 512 * 1024 * 1024,
  localFilesystem: true,
  activeProcess: false,
  ...overrides,
})

export const preflightOptionsFor = (overrides: Partial<PreflightOptions> = {}): PreflightOptions => ({
  filename: "/tmp/historical-fixture.db",
  readerProtocol: 3,
  writerProtocol: 3,
  knownMigrationIds: registryIds,
  historicalAliases: Object.fromEntries(DatabaseMigration.historicalAliases),
  knownContentHashes: Object.fromEntries(contentHashes),
  mergedHistoryAnchor,
  mergedHistoryInsertions: new Set(mergedHistoryInsertions as Iterable<string>),
  buildDigest: "historical-fixture-digest",
  buildVersion: "2.0.0-beta",
  ...overrides,
})

/** A 1.4.7/1.4.8-rN-era "known" journal: a contiguous PREFIX of the current registry (linear history). */
export const eraKnownIds = (count: number): readonly string[] => registryIds.slice(0, count)
