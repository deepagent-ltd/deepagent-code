import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
import { MigrationIdentity } from "../migration-identity"

export default {
  id: MigrationIdentity.Canonical.eventAggregateIndexes,
  up() {
    // Drizzle schema baseline only. Runtime migrations own the online index DDL.
    return Effect.void
  },
} satisfies DatabaseMigration.Migration
