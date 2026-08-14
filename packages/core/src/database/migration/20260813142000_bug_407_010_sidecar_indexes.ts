import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813142000_bug_407_010_sidecar_indexes",
  up() {
    // Drizzle schema baseline only. Runtime migrations 131300/131310/131400 own the online index DDL.
    return Effect.void
  },
} satisfies DatabaseMigration.Migration
