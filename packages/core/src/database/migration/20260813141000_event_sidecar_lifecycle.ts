import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
import { MigrationIdentity } from "../migration-identity"

export default {
  id: MigrationIdentity.Canonical.eventSidecarLifecycle,
  up() {
    // Drizzle schema baseline only. The staged runtime migrations below this ID own the online DDL.
    return Effect.void
  },
} satisfies DatabaseMigration.Migration
