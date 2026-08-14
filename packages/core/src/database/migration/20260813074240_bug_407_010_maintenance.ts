import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Drizzle records the declared end-state here. The following custom migrations install the
// same schema together with bounded backfill receipts, integrity triggers, and crash-safe state.
export default {
  id: "20260813074240_bug_407_010_maintenance",
  up() {
    return Effect.void
  },
} satisfies DatabaseMigration.Migration
