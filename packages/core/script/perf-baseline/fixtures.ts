import * as fs from "node:fs"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@deepagent-code/core/database/database"
import { populateSessionTables, countFixtureTables, type PopulatePlan } from "./raw-sqlite"

export const DB_TIERS = ["empty", "mid", "large"] as const
export type DbTier = (typeof DB_TIERS)[number]

export const TIER_PLAN: Record<DbTier, PopulatePlan> = {
  empty: { sessions: 0, messages_per_session: 0 },
  mid: { sessions: 50, messages_per_session: 200 }, // ~10k session_message rows
  large: { sessions: 200, messages_per_session: 500 }, // ~100k session_message rows
}

export interface DbFixture {
  readonly tier: DbTier
  readonly file: string
  readonly planned_message_rows: number
  readonly actual_session_rows: number
  readonly actual_message_rows: number
  readonly migrate_ms: number
  readonly populate_ms: number
  readonly db_bytes: number
}

const openMigrated = async (file: string) => {
  await Effect.runPromise(Effect.scoped(Layer.build(Database.layerFromPath(file))))
}

const fileSize = (file: string) => {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Builds a fixture database by running the production migration chain
 * (Database.layerFromPath -> DatabaseMigration.apply) against a fresh temp file,
 * then bulk-populating the real `session` / `session_message` tables with
 * SQLite-level inserts. No synthetic schema is created. The plan override exists
 * for unit tests so correctness checks do not need full-size tiers.
 */
export const buildDbFixture = async (
  root: string,
  tier: DbTier,
  planOverride?: PopulatePlan,
): Promise<DbFixture> => {
  fs.mkdirSync(root, { recursive: true })
  const file = path.join(root, `fixture-${tier}.db`)
  const plan = planOverride ?? TIER_PLAN[tier]

  const migrateStarted = performance.now()
  await openMigrated(file)
  const migrateMs = performance.now() - migrateStarted

  if (plan.sessions === 0) {
    return {
      tier,
      file,
      planned_message_rows: 0,
      actual_session_rows: 0,
      actual_message_rows: 0,
      migrate_ms: migrateMs,
      populate_ms: 0,
      db_bytes: fileSize(file),
    }
  }

  const populateStarted = performance.now()
  populateSessionTables(file, plan)
  const populateMs = performance.now() - populateStarted

  const counts = countFixtureTables(file)
  return {
    tier,
    file,
    planned_message_rows: plan.sessions * plan.messages_per_session,
    actual_session_rows: counts.sessions,
    actual_message_rows: counts.messages,
    migrate_ms: migrateMs,
    populate_ms: populateMs,
    db_bytes: fileSize(file),
  }
}

/** Timing sample of one full production open (PRAGMAs + migration check + capability scan). */
export const timeOpen = async (file: string): Promise<number> => {
  const started = performance.now()
  await openMigrated(file)
  return performance.now() - started
}
