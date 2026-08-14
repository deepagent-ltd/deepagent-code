import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813141000_bug_407_010_sidecar_lifecycle",
  up() {
    // Drizzle schema baseline only. The staged runtime migrations below this ID own the online DDL.
    return Effect.void
  },
} satisfies DatabaseMigration.Migration
