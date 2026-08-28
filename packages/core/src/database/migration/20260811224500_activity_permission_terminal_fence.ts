import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811224500_activity_permission_terminal_fence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        INSERT INTO session_activity_permission_decision (
          decision_id, request_id, idempotency_key, decision,
          actor_type, actor_id, scope, authority_epoch, decided_at, expires_at
        )
        SELECT
          'permission-terminal:' || request.request_id,
          request.request_id,
          'permission-terminal:' || request.request_id,
          CASE
            WHEN request.expires_at IS NOT NULL
              AND request.expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000
            THEN 'expired'
            ELSE 'interrupted'
          END,
          'system',
          'activity-authority',
          request.requested_scope,
          request.authority_epoch,
          CAST(strftime('%s', 'now') AS INTEGER) * 1000,
          NULL
        FROM session_activity_permission_request request
        JOIN session_activity_objective objective
          ON objective.activity_kind = request.activity_kind
          AND objective.activity_id = request.activity_id
        WHERE request.state = 'pending'
          AND objective.state IN ('completed', 'interrupted', 'recovery_required')
        ON CONFLICT(request_id) DO NOTHING
      `)
      yield* tx.run(`
        UPDATE session_activity_permission_request
        SET state = (
              SELECT decision.decision
              FROM session_activity_permission_decision decision
              WHERE decision.request_id = session_activity_permission_request.request_id
            ),
            decided_at = (
              SELECT decision.decided_at
              FROM session_activity_permission_decision decision
              WHERE decision.request_id = session_activity_permission_request.request_id
            )
        WHERE state = 'pending'
          AND EXISTS (
            SELECT 1
            FROM session_activity_permission_decision decision
            WHERE decision.request_id = session_activity_permission_request.request_id
              AND decision.decision IN ('expired', 'interrupted')
          )
          AND EXISTS (
            SELECT 1
            FROM session_activity_objective objective
            WHERE objective.activity_kind = session_activity_permission_request.activity_kind
              AND objective.activity_id = session_activity_permission_request.activity_id
              AND objective.state IN ('completed', 'interrupted', 'recovery_required')
          )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_objective_permission_terminal
        AFTER UPDATE OF state ON session_activity_objective
        WHEN OLD.state IN ('active', 'needs_human')
          AND NEW.state IN ('completed', 'interrupted', 'recovery_required')
        BEGIN
          INSERT INTO session_activity_permission_decision (
            decision_id, request_id, idempotency_key, decision,
            actor_type, actor_id, scope, authority_epoch, decided_at, expires_at
          )
          SELECT
            'permission-terminal:' || request.request_id,
            request.request_id,
            'permission-terminal:' || request.request_id,
            CASE
              WHEN request.expires_at IS NOT NULL AND request.expires_at <= NEW.updated_at
              THEN 'expired'
              ELSE 'interrupted'
            END,
            'system',
            'activity-authority',
            request.requested_scope,
            request.authority_epoch,
            NEW.updated_at,
            NULL
          FROM session_activity_permission_request request
          WHERE request.activity_kind = NEW.activity_kind
            AND request.activity_id = NEW.activity_id
            AND request.state = 'pending'
          ON CONFLICT(request_id) DO NOTHING;

          UPDATE session_activity_permission_request
          SET state = (
                SELECT decision.decision
                FROM session_activity_permission_decision decision
                WHERE decision.request_id = session_activity_permission_request.request_id
              ),
              decided_at = NEW.updated_at
          WHERE activity_kind = NEW.activity_kind
            AND activity_id = NEW.activity_id
            AND state = 'pending';
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
