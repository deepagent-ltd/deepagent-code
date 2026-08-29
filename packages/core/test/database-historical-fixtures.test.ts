import { describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import path from "path"
import { Cause, Effect } from "effect"
import { DatabaseMigration } from "@deepagent-code/core/database/migration"
import { Database } from "@deepagent-code/core/database/database"
import { analyzePreflight } from "@deepagent-code/core/database/preflight"
import { tmpdir } from "./fixture/tmpdir"
import {
  registryIds,
  aliasesByCanonical,
  contentHashes,
  mergedHistoryInsertions,
  observationsFor,
  preflightOptionsFor,
  eraKnownIds,
} from "./database/historical-fixtures"

// C1A-15 HISTORICAL FIXTURES CLASSIFICATION. The migrator's readCompletedSet / historicalAliases +
// merged-history logic must classify each fixture deterministically: known / alias-resolved /
// merged-history / UNKNOWN. UNKNOWN and content-mismatch must end in blocked_schema (never guessed or
// silently applied); the C0-02 receipt-hash check refuses a content mismatch.

const classify = (ids: readonly string[], optionOverrides: Parameters<typeof preflightOptionsFor>[0] = {}) => {
  const options = preflightOptionsFor(optionOverrides)
  const observations = observationsFor(ids)
  return analyzePreflight(options, observations)
}

/** Journal ids for the fully-current registry with the alias-bearing migrations switched to aliases. */
const aliasJournalIds = (): readonly string[] =>
  registryIds.map((id) => (aliasesByCanonical.has(id) ? aliasesByCanonical.get(id)![0] : id))

/** Journal ids for the merged-history case: the merged insertions are MISSING (the reconcilable gap). */
const mergedJournalIds = (): readonly string[] =>
  registryIds.filter((id) => !mergedHistoryInsertions.has(id))

describe("Historical fixture classification (C1A-15)", () => {
  test("1.4.7-era contiguous prefix -> KNOWN (linear, forward-migratable)", () => {
    const result = classify(eraKnownIds(3))
    expect(result.ok).toBe(true)
  })

  test("fully-current journal -> KNOWN, no pending", () => {
    const result = classify(registryIds)
    expect(result.ok).toBe(true)
  })

  test("1.4.8-rN-era alias journal -> ALIAS-RESOLVED (historicalAliases map alias -> canonical)", () => {
    const ids = aliasJournalIds()
    const result = classify(ids)
    expect(result.ok).toBe(true)
    // Every journal id is an alias or known; canonicalization makes the completed set == registry.
    const completed = new Set(ids.map((id) => preflightOptionsFor().historicalAliases[id] ?? id))
    expect([...completed].sort()).toEqual([...registryIds].sort())
  })

  test("2.0-alpha-era merged-lineage journal (missing insertions) -> MERGED-HISTORY (reconcilable, no gap)", () => {
    const ids = mergedJournalIds()
    const result = classify(ids)
    // The missing merged insertions are a reconcilable gap, NOT a hard blocker.
    expect(result.ok).toBe(true)
    const issues = "issues" in result ? result.issues.map((issue) => issue.code) : []
    expect(issues).not.toContain("migration_journal_gap")
    expect(issues).not.toContain("migration_journal_unknown_lineage")
  })

  test("UNKNOWN lineage (unreleased legacy id) -> hard blocker, never guessed/applied", () => {
    const ids = [...registryIds, "20250101000000_unreleased_legacy"]
    const result = classify(ids)
    expect(result.ok).toBe(false)
    const issues = "issues" in result ? result.issues : []
    expect(issues.some((issue) => issue.code === "migration_journal_unknown_lineage")).toBe(true)
  })

  test("content mismatch (same id, different receipt hash) -> migration_journal_content_mismatch, never silent-skip", () => {
    const ids = registryIds.map((id) => ({
      id,
      time_completed: 1,
      content_hash: contentHashes.get(id) === "aaaa" ? "bbbb" : "deadbeef",
    }))
    const options = preflightOptionsFor()
    const observations = observationsFor(ids.map((row) => row.id), {
      journalRows: ids.map((row) => ({ id: row.id, time_completed: 1, content_hash: row.content_hash })),
    })
    const result = analyzePreflight(options, observations)
    expect(result.ok).toBe(false)
    const issues = "issues" in result ? result.issues : []
    expect(issues.some((issue) => issue.code === "migration_journal_content_mismatch")).toBe(true)
  })

  test("UNKNOWN lineage through bootstrap -> blocked_schema (business DB never mounted writable)", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "unknown.db")
    const db = new BunDatabase(filename, { create: true })
    db.run("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
    db.run("INSERT INTO migration VALUES ('20250101000000_unreleased_legacy', 1)")
    db.close()

    const bootState = await Database.bootstrap(filename)
    expect(bootState.mode).toBe("blocked_schema")
    expect(bootState.ready).toBe(false)
    expect(bootState.diagnostics.stableCode).toBe("migration_journal_unknown_lineage")
  }, 60_000)

  test("the migrator's readCompletedSet dies on an incompatible lineage (never guesses)", async () => {
    const { SqliteClient } = await import("@effect/sql-sqlite-bun")
    const { EffectDrizzleSqlite } = await import("@deepagent-code/effect-drizzle-sqlite")
    const run = <A, E>(effect: Effect.Effect<A, E, import("effect/unstable/sql/SqlClient").SqlClient>) =>
      Effect.runPromise(
        effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
      )
    await run(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
        yield* db.run(`INSERT INTO migration VALUES ('20250101000000_unreleased_legacy', 1)`)
        const outcome = yield* DatabaseMigration.apply(db).pipe(Effect.exit)
        expect(outcome._tag).toBe("Failure")
        const defect = Cause.squash((outcome as { cause: Cause.Cause<unknown> }).cause)
        expect(String(defect)).toContain("incompatible lineage")
      }),
    )
  }, 60_000)
})
