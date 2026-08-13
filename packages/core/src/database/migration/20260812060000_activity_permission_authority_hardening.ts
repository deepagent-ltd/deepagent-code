import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812060000_activity_permission_authority_hardening",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TEMP TABLE activity_permission_authority_preflight (
          valid INTEGER NOT NULL CHECK (valid = 1)
        )
      `)
      yield* tx.run(`
        INSERT INTO activity_permission_authority_preflight(valid)
        SELECT CASE WHEN EXISTS (
          SELECT 1
          FROM session_activity_permission_request request
          JOIN session ON session.id = request.session_id
          WHERE request.workspace_id IS NOT session.workspace_id
        ) OR EXISTS (
          SELECT 1
          FROM session_activity_permission_owner_lease owner
          WHERE owner.heartbeat_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            OR owner.lease_expires_at <= owner.heartbeat_at
            OR owner.lease_expires_at - owner.heartbeat_at > 31536000000
        ) THEN 0 ELSE 1 END
      `)
      yield* tx.run("DROP TABLE activity_permission_authority_preflight")
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_request_workspace_insert_guard
        BEFORE INSERT ON session_activity_permission_request
        WHEN NOT EXISTS (
          SELECT 1
          FROM session
          WHERE session.id = NEW.session_id
            AND session.workspace_id IS NEW.workspace_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'permission request workspace identity mismatch');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_workspace_pending_permission_guard
        BEFORE UPDATE OF workspace_id ON session
        WHEN NEW.workspace_id IS NOT OLD.workspace_id
          AND EXISTS (
            SELECT 1
            FROM session_activity_permission_request request
            WHERE request.session_id = OLD.id
              AND request.state = 'pending'
          )
        BEGIN
          SELECT RAISE(ABORT, 'session workspace cannot change with pending permission authority');
        END
      `)
      yield* tx.run("DROP TRIGGER session_activity_permission_owner_lease_legal_update")
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_owner_lease_insert_guard
        BEFORE INSERT ON session_activity_permission_owner_lease
        WHEN NEW.heartbeat_at != CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
          OR NEW.lease_expires_at <= NEW.heartbeat_at
          OR NEW.lease_expires_at - NEW.heartbeat_at > 31536000000
        BEGIN
          SELECT RAISE(ABORT, 'permission owner lease requires database observed time');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_owner_lease_legal_update
        BEFORE UPDATE ON session_activity_permission_owner_lease
        WHEN NEW.owner_id != OLD.owner_id
          OR NEW.heartbeat_at != CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
          OR NEW.heartbeat_at < OLD.heartbeat_at
          OR NEW.heartbeat_at >= OLD.lease_expires_at
          OR NEW.lease_expires_at <= NEW.heartbeat_at
          OR NEW.lease_expires_at - NEW.heartbeat_at > 31536000000
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_activity_permission_owner_lease update');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
