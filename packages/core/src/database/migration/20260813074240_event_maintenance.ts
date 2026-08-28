import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
import { MigrationIdentity } from "../migration-identity"

// Drizzle records the declared end-state here. The following custom migrations install the
// same schema together with bounded backfill receipts, integrity triggers, and crash-safe state.
export default {
  id: MigrationIdentity.Canonical.eventMaintenance,
  up() {
    return Effect.void
  },
} satisfies DatabaseMigration.Migration
