import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811225000_activity_permission_owner_lease",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_activity_permission_owner_lease (
          owner_id TEXT PRIMARY KEY,
          lease_expires_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          CHECK (length(trim(owner_id)) > 0),
          CHECK (lease_expires_at > heartbeat_at)
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_activity_permission_owner_lease_expiry_idx
        ON session_activity_permission_owner_lease(lease_expires_at, owner_id)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_owner_lease_legal_update
        BEFORE UPDATE ON session_activity_permission_owner_lease
        WHEN NEW.owner_id != OLD.owner_id
          OR NEW.heartbeat_at < OLD.heartbeat_at
          OR NEW.lease_expires_at <= NEW.heartbeat_at
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_activity_permission_owner_lease update');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
