import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const databaseNow = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"

export default {
  id: "20260812213000_permission_effect_dispatch_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_effect_dispatch_insert_guard
        BEFORE INSERT ON session_activity_permission_effect_dispatch
        WHEN length(trim(NEW.receipt_id)) = 0 OR
          length(trim(NEW.request_id)) = 0 OR
          length(trim(NEW.activity_id)) = 0 OR
          length(trim(NEW.tool_message_id)) = 0 OR
          length(trim(NEW.tool_call_id)) = 0 OR
          length(trim(NEW.tool_name)) = 0 OR
          length(trim(NEW.consumer_id)) = 0 OR
          length(trim(NEW.idempotency_key)) = 0 OR
          length(trim(NEW.owner_id)) = 0 OR
          NEW.activity_kind NOT IN ('legacy', 'v2') OR
          NEW.state != 'started' OR NEW.version != 1 OR
          NEW.outcome IS NOT NULL OR NEW.result_json IS NOT NULL OR
          NEW.result_hash IS NOT NULL OR NEW.settled_at IS NOT NULL OR
          NEW.started_at < ${databaseNow} - 1000 OR NEW.started_at > ${databaseNow} OR
          NOT EXISTS (
            SELECT 1
            FROM session_activity_permission_request request
            JOIN session_activity_permission_decision decision
              ON decision.request_id = request.request_id
            JOIN session_activity_objective objective
              ON objective.activity_kind = request.activity_kind
              AND objective.activity_id = request.activity_id
            JOIN session session ON session.id = request.session_id
            JOIN session_activity_permission_owner_lease owner
              ON owner.owner_id = NEW.owner_id
            WHERE request.request_id = NEW.request_id
              AND request.request_kind = 'tool'
              AND request.state IN ('approved_once', 'approved_always')
              AND decision.decision = request.state
              AND (request.expires_at IS NULL OR request.expires_at > ${databaseNow})
              AND (decision.expires_at IS NULL OR decision.expires_at > ${databaseNow})
              AND objective.state = 'active'
              AND objective.session_id = request.session_id
              AND session.project_id = request.project_id
              AND owner.lease_expires_at > ${databaseNow}
              AND NEW.activity_kind = request.activity_kind
              AND NEW.activity_id = request.activity_id
              AND NEW.session_id = request.session_id
              AND NEW.project_id = request.project_id
              AND NEW.workspace_id IS request.workspace_id
              AND NEW.tool_message_id = request.tool_message_id
              AND NEW.tool_call_id = request.tool_call_id
              AND (
                (request.activity_kind = 'legacy' AND EXISTS (
                  SELECT 1 FROM session_legacy_activity activity
                  WHERE activity.activity_id = request.activity_id
                    AND activity.session_id = request.session_id
                    AND activity.state = 'active'
                )) OR
                (request.activity_kind = 'v2' AND EXISTS (
                  SELECT 1 FROM session_activity activity
                  WHERE activity.activity_id = request.activity_id
                    AND activity.session_id = request.session_id
                    AND activity.state = 'active'
                ))
              )
              AND (
                (decision.decision = 'approved_once' AND EXISTS (
                  SELECT 1
                  FROM session_activity_permission_once_consumption consumption
                  WHERE consumption.request_id = request.request_id
                    AND consumption.consumer_id = NEW.consumer_id
                    AND consumption.consumed_at = NEW.started_at
                )) OR
                (decision.decision = 'approved_always' AND NOT EXISTS (
                  SELECT 1
                  FROM session_activity_permission_once_consumption consumption
                  WHERE consumption.request_id = request.request_id
                ))
              )
          )
        BEGIN
          SELECT RAISE(ABORT, 'invalid permission effect dispatch admission');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_effect_dispatch_update_guard
        BEFORE UPDATE ON session_activity_permission_effect_dispatch
        WHEN NEW.receipt_id != OLD.receipt_id OR
          NEW.request_id != OLD.request_id OR
          NEW.activity_kind != OLD.activity_kind OR
          NEW.activity_id != OLD.activity_id OR
          NEW.session_id != OLD.session_id OR
          NEW.project_id != OLD.project_id OR
          NEW.workspace_id IS NOT OLD.workspace_id OR
          NEW.tool_message_id != OLD.tool_message_id OR
          NEW.tool_call_id != OLD.tool_call_id OR
          NEW.tool_name != OLD.tool_name OR
          NEW.consumer_id != OLD.consumer_id OR
          NEW.idempotency_key != OLD.idempotency_key OR
          NEW.owner_id != OLD.owner_id OR
          NEW.started_at != OLD.started_at OR
          OLD.state != 'started' OR NEW.version != OLD.version + 1 OR
          NEW.state NOT IN ('settled', 'unknown') OR
          NEW.settled_at IS NULL OR NEW.settled_at < OLD.started_at OR
          NEW.settled_at > ${databaseNow} OR
          (
            NEW.state = 'settled' AND (
              NEW.outcome NOT IN ('success', 'failure') OR
              NEW.result_json IS NULL OR json_valid(NEW.result_json) != 1 OR
              NEW.result_hash IS NULL OR length(NEW.result_hash) != 64 OR
              NEW.result_hash GLOB '*[^0-9a-f]*' OR
              NOT EXISTS (
                SELECT 1
                FROM session_activity_permission_owner_lease owner
                WHERE owner.owner_id = OLD.owner_id
                  AND owner.lease_expires_at > ${databaseNow}
              )
            )
          ) OR
          (
            NEW.state = 'unknown' AND (
              NEW.outcome IS NOT NULL OR NEW.result_json IS NOT NULL OR NEW.result_hash IS NOT NULL OR
              EXISTS (
                SELECT 1
                FROM session_activity_permission_owner_lease owner
                WHERE owner.owner_id = OLD.owner_id
                  AND owner.lease_expires_at > ${databaseNow}
              ) OR
              NOT EXISTS (
                SELECT 1
                FROM session_activity_permission_owner_lease owner
                WHERE owner.owner_id != OLD.owner_id
                  AND owner.lease_expires_at > ${databaseNow}
              )
            )
          )
        BEGIN
          SELECT RAISE(ABORT, 'illegal permission effect dispatch transition');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_effect_dispatch_delete_guard
        BEFORE DELETE ON session_activity_permission_effect_dispatch
        WHEN EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'permission effect dispatch is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_objective_permission_effect_terminal_guard
        BEFORE UPDATE OF state ON session_activity_objective
        WHEN NEW.state IN ('completed', 'interrupted', 'recovery_required') AND EXISTS (
          SELECT 1
          FROM session_activity_permission_effect_dispatch dispatch
          WHERE dispatch.activity_kind = OLD.activity_kind
            AND dispatch.activity_id = OLD.activity_id
            AND (
              dispatch.state = 'started' OR
              (NEW.state IN ('completed', 'interrupted') AND dispatch.state = 'unknown')
            )
        )
        BEGIN
          SELECT RAISE(ABORT, 'activity has unresolved permission effects');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_permission_effect_terminal_guard
        BEFORE UPDATE OF state ON session_legacy_activity
        WHEN NEW.state IN ('settled', 'failed', 'interrupted', 'recovery_required') AND EXISTS (
          SELECT 1
          FROM session_activity_permission_effect_dispatch dispatch
          WHERE dispatch.activity_kind = 'legacy'
            AND dispatch.activity_id = OLD.activity_id
            AND (
              dispatch.state = 'started' OR
              (NEW.state IN ('settled', 'interrupted') AND dispatch.state = 'unknown')
            )
        )
        BEGIN
          SELECT RAISE(ABORT, 'activity has unresolved permission effects');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_activity_permission_effect_terminal_guard
        BEFORE UPDATE OF state ON session_activity
        WHEN NEW.state IN ('settled', 'failed', 'interrupted') AND EXISTS (
          SELECT 1
          FROM session_activity_permission_effect_dispatch dispatch
          WHERE dispatch.activity_kind = 'v2'
            AND dispatch.activity_id = OLD.activity_id
            AND (
              dispatch.state = 'started' OR
              (NEW.state IN ('settled', 'interrupted') AND dispatch.state = 'unknown')
            )
        )
        BEGIN
          SELECT RAISE(ABORT, 'activity has unresolved permission effects');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
