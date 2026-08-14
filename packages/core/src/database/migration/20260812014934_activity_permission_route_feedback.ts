import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812014934_activity_permission_route_feedback",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_activity_permission_decision\` ADD \`feedback\` text;`)
      yield* tx.run(`ALTER TABLE \`session_activity_permission_request\` ADD \`workspace_id\` text;`)
      yield* tx.run(`DROP TRIGGER session_activity_permission_request_legal_update`)
      yield* tx.run(`
        UPDATE session_activity_permission_request
        SET workspace_id = (
          SELECT session.workspace_id
          FROM session
          WHERE session.id = session_activity_permission_request.session_id
        )
        WHERE workspace_id IS NULL
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_request_legal_update
        BEFORE UPDATE ON session_activity_permission_request
        WHEN NEW.request_id != OLD.request_id
          OR NEW.activity_kind != OLD.activity_kind
          OR NEW.activity_id != OLD.activity_id
          OR NEW.session_id != OLD.session_id
          OR NEW.project_id != OLD.project_id
          OR NEW.request_kind != OLD.request_kind
          OR NEW.idempotency_key != OLD.idempotency_key
          OR NEW.permission != OLD.permission
          OR NEW.patterns != OLD.patterns
          OR NEW.always_patterns != OLD.always_patterns
          OR NEW.metadata_hash != OLD.metadata_hash
          OR COALESCE(NEW.tool_message_id, '') != COALESCE(OLD.tool_message_id, '')
          OR COALESCE(NEW.tool_call_id, '') != COALESCE(OLD.tool_call_id, '')
          OR NEW.authority_epoch != OLD.authority_epoch
          OR NEW.requested_scope != OLD.requested_scope
          OR NEW.owner_type != OLD.owner_type
          OR NEW.owner_id != OLD.owner_id
          OR NEW.created_at != OLD.created_at
          OR COALESCE(NEW.expires_at, -1) != COALESCE(OLD.expires_at, -1)
          OR OLD.state != 'pending'
          OR NEW.state = 'pending'
          OR NEW.decided_at IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM session_activity_permission_decision decision
            WHERE decision.request_id = OLD.request_id AND decision.decision = NEW.state
          )
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_activity_permission_request transition');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_route_immutable
        BEFORE UPDATE ON session_activity_permission_request
        WHEN NEW.workspace_id IS NOT OLD.workspace_id
        BEGIN
          SELECT RAISE(ABORT, 'permission request workspace identity is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_feedback_immutable
        BEFORE UPDATE ON session_activity_permission_decision
        WHEN NEW.feedback IS NOT OLD.feedback
        BEGIN
          SELECT RAISE(ABORT, 'permission decision feedback is immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
