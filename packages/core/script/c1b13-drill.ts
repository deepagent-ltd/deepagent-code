import { Database as BunDatabase } from "bun:sqlite"
import path from "node:path"
import { DatabaseMigration } from "../src/database/migration"
import { migrations } from "../src/database/migration.gen"

// C1B-13 — user incident-DB read-only drill (user-authorized: the authorized snapshot COPY only;
// the original is never opened for write, and this drill uses an extra per-run tmp copy).
// Output: exact classification (known / alias-resolved / merged-history / UNKNOWN → blocked) and
// the unresolved-items summary. Zero writes: readonly connection, read-only pragmas.

const target = process.argv[2]
if (!target) {
  console.error("usage: bun script/c1b13-drill.ts <db-path>")
  process.exit(2)
}

const db = new BunDatabase(path.resolve(target), { readonly: true })
const registryIds = migrations.map((m) => m.id)
const registrySet = new Set(registryIds)
const aliasesByCanonical = new Map<string, string[]>()
for (const [alias, canonical] of DatabaseMigration.historicalAliases) {
  const list = aliasesByCanonical.get(canonical) ?? []
  list.push(alias)
  aliasesByCanonical.set(canonical, list)
}
const aliasSet = new Set(DatabaseMigration.historicalAliases.keys())
const mergedAnchor = DatabaseMigration.mergedHistoryAnchor
const mergedInsertions = new Set(DatabaseMigration.mergedHistoryInsertions)

// Read the journal (migration rows) — only if the table exists.
let journalIds: string[] = []
try {
  journalIds = (db.query("SELECT id FROM migration").all() as { id: string }[]).map((row) => row.id)
} catch {
  console.error("classification: no readable migration journal (table missing or unreadable)")
}
const journalSet = new Set(journalIds)

// Classification oracle (mirrors C1A-15's closed bucket logic).
const unknownIds = journalIds.filter((id) => !registrySet.has(id) && !aliasSet.has(id))
const aliasIds = journalIds.filter((id) => aliasSet.has(id))
const mergedGap = journalIds.filter((id) => mergedInsertions.has(id))
const missingIds = registryIds.filter((id) => !journalSet.has(id))
let classification = "unknown-lineage"
if (unknownIds.length === 0 && missingIds.length === 0) classification = "current"
else if (unknownIds.length === 0) classification = "prefix-or-contiguous"
if (mergedGap.length > 0) classification = "merged-history-gap"
if (unknownIds.length > 0) classification = "unknown-lineage"

// Integrity + unresolved items (read-only).
const quickCheck = (() => {
  try {
    return db.query("PRAGMA quick_check").get() as { quick_check: string }
  } catch {
    return { quick_check: "unavailable" }
  }
})()
const tableInfo = (name: string): number => {
  try {
    const row = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) as { name: string } | null
    if (!row) return -1
    return (db.query(`SELECT COUNT(*) as c FROM "${name}"`).get() as { c: number }).c
  } catch {
    return -2
  }
}
const unresolved = {
  recovery_events: tableInfo("recovery_event"),
  session_provider_attempts: tableInfo("session_provider_attempt"),
  migration_receipts: tableInfo("database_migration_receipt"),
  sessions: tableInfo("session"),
}

console.log(
  JSON.stringify(
    {
      drill: "C1B-13 incident dry-run (read-only)",
      target_copy: target,
      classification,
      journal_ids: journalIds.length,
      registry_ids: registryIds.length,
      unknown_ids: unknownIds.slice(0, 5),
      missing_ids: missingIds.length,
      alias_ids: aliasIds.length,
      merged_gap_ids: mergedGap.length,
      quick_check: quickCheck.quick_check,
      unresolved,
      verdict: unknownIds.length === 0 && quickCheck.quick_check === "ok" ? "recoverable-vestige" : "blocked_schema",
    },
    null,
    2,
  ),
)
db.close()
