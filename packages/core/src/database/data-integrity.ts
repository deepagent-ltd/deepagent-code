export * as DataIntegrity from "./data-integrity"

import { Effect } from "effect"
import type { EffectDrizzleSqlite } from "@deepagent-code/effect-drizzle-sqlite"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase

// §16.4 DATA-AND-RECOVERY D-2 — deterministic data integrity oracle. Runs on a DB COPY only
// (never the live authority): physical page integrity (crash-window damage), foreign-key
// integrity (orphan admission across the whole FK graph), and registry set equality (migration
// interruption / partial apply). Every check is a single deterministic query with an explicit
// verdict; nothing here mutates the database.
//
// C1A-11 post-migration gate deviation: the gate runs `check` on the LIVE connection (not a
// copy). Rationale: `PRAGMA quick_check` and `PRAGMA foreign_key_check` are read-only queries that
// never write, and the gate only runs while the process holds the migration lease (single
// migrator), so no competing writer can produce a torn snapshot. The "DB COPY only" comment above
// describes the RELEASE-GATE oracle (script/data-integrity-check.ts), which inspects an arbitrary
// database that may have a live foreign writer and therefore must not hold a write lock. In the
// post-migration gate the process IS the sole migrator, so the live connection is a legitimate
// read-only inspection point; a copy-per-gate would add a full VACUUM INTO + reconnect per startup
// for the same set of deterministic queries.

export type Verdict =
  | { readonly ok: true; readonly quickCheck: string; readonly foreignKeyCount: number }
  | {
      readonly ok: false
      readonly reason: "quick_check_failed" | "foreign_key_violation" | "registry_mismatch"
      readonly detail: string
      readonly rows: ReadonlyArray<Record<string, unknown>>
    }

/**
 * Optional registry-set oracle. When `registryIds` is provided, the applied migration set returned
 * by the `migration` journal (canonicalized through `canonicalize`) must equal the registry set
 * (id-sorted). Any drift (a missing/extra/reordered id) is reported as a `registry_mismatch`
 * verdict — the D-1 oracle from script/data-integrity-check.ts.
 */
export interface CheckOptions {
  /** The canonical migration-registry ids (in registry order). */
  readonly registryIds?: readonly string[]
  /** Maps a journal id to its canonical id (historical aliases → canonical). */
  readonly canonicalize?: (id: string) => string
}

export const check = Effect.fn("DataIntegrity.check")(function* (
  db: Database,
  options?: CheckOptions,
) {
  const quick = yield* db.get<{ quick_check: string }>("PRAGMA quick_check").pipe(Effect.orDie)
  if (quick?.quick_check !== "ok")
    return {
      ok: false,
      reason: "quick_check_failed",
      detail: String(quick?.quick_check),
      rows: [],
    }

  const orphans = yield* db.all<Record<string, unknown>>("PRAGMA foreign_key_check").pipe(Effect.orDie)
  if (orphans.length > 0)
    return {
      ok: false,
      reason: "foreign_key_violation",
      detail: `${orphans.length} orphaned foreign-key reference(s)`,
      rows: orphans,
    }

  if (options?.registryIds && options.registryIds.length > 0) {
    const canonicalize = options.canonicalize ?? ((id: string) => id)
    const migrationTable = yield* db
      .get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration'")
      .pipe(Effect.orDie)
    const applied = (migrationTable
      ? (yield* db.all<{ id: string }>("SELECT id FROM migration ORDER BY id").pipe(Effect.orDie)).map((row) =>
          canonicalize(row.id),
        )
      : []
    ).sort()
    const expected = [...options.registryIds].sort()
    const firstMismatch = applied.findIndex((id, index) => id !== expected[index])
    const mismatch =
      (firstMismatch === -1 && applied.length !== expected.length) || firstMismatch !== -1
    if (mismatch) {
      return {
        ok: false,
        reason: "registry_mismatch",
        detail: `applied migration set does not equal the registry at index ${firstMismatch}: expected=${expected[firstMismatch] ?? "(missing)"} applied=${applied[firstMismatch] ?? "(missing)"}`,
        rows: [
          { expected, applied, firstMismatch, expectedLength: expected.length, appliedLength: applied.length },
        ],
      }
    }
  }

  return { ok: true, quickCheck: "ok", foreignKeyCount: 0 }
})
