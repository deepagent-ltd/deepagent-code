import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Drizzle snapshot marker only. Runtime DDL is owned by the preceding hand-written
// released snapshot, activity authority, and learning job migrations.
export default {
  id: "20260811221351_w2_authority_schema",
  up() {
    return Effect.void
  },
} satisfies DatabaseMigration.Migration
