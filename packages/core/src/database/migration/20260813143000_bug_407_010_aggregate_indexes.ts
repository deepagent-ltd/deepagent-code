import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813143000_bug_407_010_aggregate_indexes",
  up() {
    // Drizzle schema baseline only. Runtime migrations own the online index DDL.
    return Effect.void
  },
} satisfies DatabaseMigration.Migration
