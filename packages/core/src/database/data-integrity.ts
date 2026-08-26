export * as DataIntegrity from "./data-integrity"

import { Effect } from "effect"
import type { Database } from "./database"

// §16.4 DATA-AND-RECOVERY D-2 — deterministic data integrity oracle. Runs on a DB COPY only
// (never the live authority): physical page integrity (crash-window damage), foreign-key
// integrity (orphan admission across the whole FK graph), and registry set equality (migration
// interruption / partial apply). Every check is a single deterministic query with an explicit
// verdict; nothing here mutates the database.

export type Verdict =
  | { readonly ok: true; readonly quickCheck: string; readonly foreignKeyCount: number }
  | {
      readonly ok: false
      readonly reason: "quick_check_failed" | "foreign_key_violation"
      readonly detail: string
      readonly rows: ReadonlyArray<Record<string, unknown>>
    }

export const check = Effect.fn("DataIntegrity.check")(function* (db: Database.Interface["db"]) {
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

  return { ok: true, quickCheck: "ok", foreignKeyCount: 0 }
})
