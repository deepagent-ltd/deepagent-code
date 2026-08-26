import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
import { MigrationIdentity } from "../migration-identity"

export default {
  id: MigrationIdentity.Canonical.eventSidecarIndexes,
  up() {
    // Drizzle schema baseline only. Runtime migrations 131300/131310/131400 own the online index DDL.
    return Effect.void
  },
} satisfies DatabaseMigration.Migration
