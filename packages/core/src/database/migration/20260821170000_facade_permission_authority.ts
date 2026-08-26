import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const databaseNow = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"

/**
 * Admit facade tool permissions without projecting facade rows into the objective authority.
 * The four permission tables are rebuilt together so existing legacy/v2 receipts and foreign
 * keys survive the forward-only migration.
 */
export default {
  id: "20260821170000_facade_permission_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("DROP TRIGGER session_workspace_pending_permission_guard")
      yield* tx.run("DROP TRIGGER session_activity_objective_permission_terminal")
      yield* tx.run("DROP TRIGGER session_activity_objective_permission_effect_terminal_guard")
      yield* tx.run("DROP TRIGGER session_legacy_activity_permission_effect_terminal_guard")
      yield* tx.run("DROP TRIGGER session_v2_activity_permission_effect_terminal_guard")
      yield* tx.run("DROP TRIGGER session_facade_activity_permission_effect_terminal_guard")
      yield* tx.run("DROP TRIGGER session_facade_activity_legal_update")

      yield* tx.run(`
        CREATE TABLE session_activity_permission_request_new (
          request_id TEXT PRIMARY KEY,
          activity_kind TEXT NOT NULL CHECK (activity_kind IN ('legacy', 'v2', 'facade')),
          activity_id TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          workspace_id TEXT,
          request_kind TEXT NOT NULL CHECK (request_kind IN ('tool', 'no_progress')),
          idempotency_key TEXT NOT NULL UNIQUE,
          permission TEXT NOT NULL,
          patterns TEXT NOT NULL,
          always_patterns TEXT NOT NULL,
          metadata_hash TEXT NOT NULL,
          tool_message_id TEXT,
          tool_call_id TEXT,
          state TEXT NOT NULL CHECK (state IN ('pending', 'approved_once', 'approved_always', 'denied', 'expired', 'interrupted')),
          authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
          requested_scope TEXT NOT NULL CHECK (requested_scope IN ('once', 'project')),
          owner_type TEXT NOT NULL CHECK (owner_type IN ('runtime', 'system')),
          owner_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          decided_at INTEGER,
          CHECK (
            (state = 'pending' AND decided_at IS NULL) OR
            (state != 'pending' AND decided_at IS NOT NULL)
          ),
          CHECK (expires_at IS NULL OR expires_at > created_at)
        )
      `)
      yield* tx.run(`
        INSERT INTO session_activity_permission_request_new
        SELECT request_id, activity_kind, activity_id, session_id, project_id, workspace_id,
          request_kind, idempotency_key, permission, patterns, always_patterns, metadata_hash,
          tool_message_id, tool_call_id, state, authority_epoch, requested_scope, owner_type,
          owner_id, created_at, expires_at, decided_at
        FROM session_activity_permission_request
      `)

      yield* tx.run(`
        CREATE TABLE session_activity_permission_decision_new (
          decision_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE REFERENCES session_activity_permission_request_new(request_id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL UNIQUE,
          decision TEXT NOT NULL CHECK (decision IN ('approved_once', 'approved_always', 'denied', 'expired', 'interrupted')),
          actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'administrator', 'system')),
          actor_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('once', 'project')),
          authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
          decided_at INTEGER NOT NULL,
          expires_at INTEGER,
          feedback TEXT,
          CHECK (expires_at IS NULL OR expires_at > decided_at),
          CHECK (decision != 'approved_always' OR expires_at IS NULL)
        )
      `)
      yield* tx.run(`
        INSERT INTO session_activity_permission_decision_new
        SELECT decision_id, request_id, idempotency_key, decision, actor_type, actor_id, scope,
          authority_epoch, decided_at, expires_at, feedback
        FROM session_activity_permission_decision
      `)

      yield* tx.run(`
        CREATE TABLE session_activity_permission_once_consumption_new (
          request_id TEXT PRIMARY KEY REFERENCES session_activity_permission_request_new(request_id) ON DELETE CASCADE,
          consumer_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          consumed_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        INSERT INTO session_activity_permission_once_consumption_new
        SELECT request_id, consumer_id, idempotency_key, consumed_at
        FROM session_activity_permission_once_consumption
      `)

      yield* tx.run(`
        CREATE TABLE session_activity_permission_effect_dispatch_new (
          receipt_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL REFERENCES session_activity_permission_request_new(request_id) ON DELETE CASCADE,
          activity_kind TEXT NOT NULL CHECK (activity_kind IN ('legacy', 'v2', 'facade')),
          activity_id TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          workspace_id TEXT,
          tool_message_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          consumer_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('started', 'settled', 'unknown')),
          version INTEGER NOT NULL CHECK (version >= 1),
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success', 'failure')),
          result_json TEXT,
          result_hash TEXT,
          started_at INTEGER NOT NULL,
          settled_at INTEGER
        )
      `)
      yield* tx.run(`
        INSERT INTO session_activity_permission_effect_dispatch_new
        SELECT receipt_id, request_id, activity_kind, activity_id, session_id, project_id,
          workspace_id, tool_message_id, tool_call_id, tool_name, consumer_id, idempotency_key,
          owner_id, state, version, outcome, result_json, result_hash, started_at, settled_at
        FROM session_activity_permission_effect_dispatch
      `)

      yield* tx.run("DROP TABLE session_activity_permission_effect_dispatch")
      yield* tx.run("DROP TABLE session_activity_permission_once_consumption")
      yield* tx.run("DROP TABLE session_activity_permission_decision")
      yield* tx.run("DROP TABLE session_activity_permission_request")
      yield* tx.run("ALTER TABLE session_activity_permission_request_new RENAME TO session_activity_permission_request")
      yield* tx.run(
        "ALTER TABLE session_activity_permission_decision_new RENAME TO session_activity_permission_decision",
      )
      yield* tx.run(
        "ALTER TABLE session_activity_permission_once_consumption_new RENAME TO session_activity_permission_once_consumption",
      )
      yield* tx.run(
        "ALTER TABLE session_activity_permission_effect_dispatch_new RENAME TO session_activity_permission_effect_dispatch",
      )

      yield* tx.run(
        `CREATE INDEX session_activity_permission_request_pending_idx ON session_activity_permission_request(session_id, state, created_at)`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX session_activity_permission_request_pending_no_progress_idx ON session_activity_permission_request(activity_kind, activity_id) WHERE state = 'pending' AND request_kind = 'no_progress'`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX session_activity_permission_decision_request_idx ON session_activity_permission_decision(request_id)`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX session_activity_permission_once_consumption_idempotency_idx ON session_activity_permission_once_consumption(idempotency_key)`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX session_activity_permission_effect_dispatch_request_idx ON session_activity_permission_effect_dispatch(request_id)`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX session_activity_permission_effect_dispatch_idempotency_idx ON session_activity_permission_effect_dispatch(idempotency_key)`,
      )
      yield* tx.run(
        `CREATE INDEX session_activity_permission_effect_dispatch_activity_idx ON session_activity_permission_effect_dispatch(activity_kind, activity_id, state, started_at)`,
      )
      yield* tx.run(
        `CREATE INDEX session_activity_permission_effect_dispatch_owner_idx ON session_activity_permission_effect_dispatch(owner_id, state, started_at)`,
      )

      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_request_validate_insert
        BEFORE INSERT ON session_activity_permission_request
        BEGIN
          SELECT CASE WHEN NOT (
            (
              NEW.activity_kind IN ('legacy', 'v2') AND EXISTS (
                SELECT 1 FROM session_activity_objective objective
                JOIN session session ON session.id = objective.session_id
                WHERE objective.activity_kind = NEW.activity_kind
                  AND objective.activity_id = NEW.activity_id
                  AND objective.session_id = NEW.session_id
                  AND session.project_id = NEW.project_id
                  AND (
                    (NEW.request_kind = 'tool' AND objective.state = 'active') OR
                    (NEW.request_kind = 'no_progress' AND objective.state = 'needs_human')
                  )
              )
            ) OR (
              NEW.activity_kind = 'facade' AND NEW.request_kind = 'tool' AND EXISTS (
                SELECT 1 FROM session_facade_activity activity
                JOIN session session ON session.id = activity.owner_session_id
                WHERE activity.activity_id = NEW.activity_id
                  AND activity.owner_session_id = NEW.session_id
                  AND session.project_id = NEW.project_id
                  AND activity.subkind = 'task'
                  AND activity.state = 'active'
              )
            )
          ) THEN RAISE(ABORT, 'permission request activity owner mismatch') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM permission_saved_epoch epoch
            WHERE epoch.project_id = NEW.project_id AND epoch.epoch = NEW.authority_epoch
          ) THEN RAISE(ABORT, 'permission request authority epoch mismatch') END;
          SELECT CASE WHEN
            (NEW.request_kind = 'tool' AND (NEW.tool_message_id IS NULL OR NEW.tool_call_id IS NULL)) OR
            (NEW.request_kind = 'no_progress' AND (NEW.tool_message_id IS NOT NULL OR NEW.tool_call_id IS NOT NULL))
          THEN RAISE(ABORT, 'permission request tool identity mismatch') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_request_workspace_insert_guard
        BEFORE INSERT ON session_activity_permission_request
        WHEN NOT EXISTS (
          SELECT 1 FROM session
          WHERE session.id = NEW.session_id
            AND session.workspace_id IS NEW.workspace_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'permission request workspace identity mismatch');
        END
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
        CREATE TRIGGER session_activity_permission_decision_validate_insert
        BEFORE INSERT ON session_activity_permission_decision
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_activity_permission_request request
            WHERE request.request_id = NEW.request_id
              AND request.state = 'pending'
              AND (
                (NEW.decision = 'expired' AND request.expires_at IS NOT NULL AND request.expires_at <= NEW.decided_at) OR
                (NEW.decision != 'expired' AND (request.expires_at IS NULL OR request.expires_at > NEW.decided_at))
              )
              AND (
                (NEW.decision = 'approved_always' AND NEW.scope = 'project'
                  AND NEW.authority_epoch >= request.authority_epoch
                  AND EXISTS (
                    SELECT 1 FROM permission_saved_epoch epoch
                    WHERE epoch.project_id = request.project_id AND epoch.epoch = NEW.authority_epoch
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(request.always_patterns) pattern
                    WHERE NOT EXISTS (
                      SELECT 1 FROM permission saved
                      WHERE saved.project_id = request.project_id
                        AND saved.action = request.permission
                        AND saved.resource = pattern.value
                    )
                  )) OR
                (NEW.decision != 'approved_always' AND NEW.authority_epoch = request.authority_epoch)
              )
          ) THEN RAISE(ABORT, 'permission decision request CAS mismatch') END;
          SELECT CASE WHEN
            (NEW.decision = 'approved_once' AND NEW.scope != 'once') OR
            (NEW.decision = 'approved_always' AND NEW.scope != 'project') OR
            (NEW.decision IN ('denied', 'expired', 'interrupted') AND NEW.scope != request.requested_scope)
          THEN RAISE(ABORT, 'permission decision scope mismatch') END
          FROM session_activity_permission_request request
          WHERE request.request_id = NEW.request_id;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_decision_immutable
        BEFORE UPDATE ON session_activity_permission_decision
        BEGIN
          SELECT RAISE(ABORT, 'session_activity_permission_decision is immutable');
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

      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_once_consumption_validate_insert
        BEFORE INSERT ON session_activity_permission_once_consumption
        WHEN NOT EXISTS (
          SELECT 1
          FROM session_activity_permission_request request
          JOIN session_activity_permission_decision decision ON decision.request_id = request.request_id
          WHERE request.request_id = NEW.request_id
            AND request.state = 'approved_once'
            AND decision.decision = 'approved_once'
            AND decision.scope = 'once'
            AND (request.expires_at IS NULL OR request.expires_at > ${databaseNow})
            AND (decision.expires_at IS NULL OR decision.expires_at > ${databaseNow})
        )
        BEGIN
          SELECT RAISE(ABORT, 'permission once receipt is not consumable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_once_consumption_immutable
        BEFORE UPDATE ON session_activity_permission_once_consumption
        BEGIN
          SELECT RAISE(ABORT, 'session_activity_permission_once_consumption is immutable');
        END
      `)

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
          NEW.activity_kind NOT IN ('legacy', 'v2', 'facade') OR
          NEW.state != 'started' OR NEW.version != 1 OR
          NEW.outcome IS NOT NULL OR NEW.result_json IS NOT NULL OR
          NEW.result_hash IS NOT NULL OR NEW.settled_at IS NOT NULL OR
          NEW.started_at < ${databaseNow} - 1000 OR NEW.started_at > ${databaseNow} OR
          NOT EXISTS (
            SELECT 1
            FROM session_activity_permission_request request
            JOIN session_activity_permission_decision decision ON decision.request_id = request.request_id
            JOIN session session ON session.id = request.session_id
            JOIN session_activity_permission_owner_lease owner ON owner.owner_id = NEW.owner_id
            WHERE request.request_id = NEW.request_id
              AND request.request_kind = 'tool'
              AND request.state IN ('approved_once', 'approved_always')
              AND decision.decision = request.state
              AND (request.expires_at IS NULL OR request.expires_at > ${databaseNow})
              AND (decision.expires_at IS NULL OR decision.expires_at > ${databaseNow})
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
                  SELECT 1 FROM session_activity_objective objective
                  JOIN session_legacy_activity activity ON activity.activity_id = objective.activity_id
                  WHERE objective.activity_kind = 'legacy'
                    AND objective.activity_id = request.activity_id
                    AND objective.session_id = request.session_id
                    AND objective.state = 'active'
                    AND activity.session_id = request.session_id
                    AND activity.state = 'active'
                )) OR
                (request.activity_kind = 'v2' AND EXISTS (
                  SELECT 1 FROM session_activity_objective objective
                  JOIN session_activity activity ON activity.activity_id = objective.activity_id
                  WHERE objective.activity_kind = 'v2'
                    AND objective.activity_id = request.activity_id
                    AND objective.session_id = request.session_id
                    AND objective.state = 'active'
                    AND activity.session_id = request.session_id
                    AND activity.state = 'active'
                )) OR
                (request.activity_kind = 'facade' AND EXISTS (
                  SELECT 1 FROM session_facade_activity activity
                  WHERE activity.activity_id = request.activity_id
                    AND activity.owner_session_id = request.session_id
                    AND activity.subkind = 'task'
                    AND activity.state = 'active'
                ))
              )
              AND (
                (decision.decision = 'approved_once' AND EXISTS (
                  SELECT 1 FROM session_activity_permission_once_consumption consumption
                  WHERE consumption.request_id = request.request_id
                    AND consumption.consumer_id = NEW.consumer_id
                    AND consumption.consumed_at = NEW.started_at
                )) OR
                (decision.decision = 'approved_always' AND NOT EXISTS (
                  SELECT 1 FROM session_activity_permission_once_consumption consumption
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
                SELECT 1 FROM session_activity_permission_owner_lease owner
                WHERE owner.owner_id = OLD.owner_id AND owner.lease_expires_at > ${databaseNow}
              )
            )
          ) OR
          (
            NEW.state = 'unknown' AND (
              NEW.outcome IS NOT NULL OR NEW.result_json IS NOT NULL OR NEW.result_hash IS NOT NULL OR
              EXISTS (
                SELECT 1 FROM session_activity_permission_owner_lease owner
                WHERE owner.owner_id = OLD.owner_id AND owner.lease_expires_at > ${databaseNow}
              ) OR
              NOT EXISTS (
                SELECT 1 FROM session_activity_permission_owner_lease owner
                WHERE owner.owner_id != OLD.owner_id AND owner.lease_expires_at > ${databaseNow}
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
              WHEN request.expires_at IS NOT NULL AND request.expires_at <= NEW.updated_at THEN 'expired'
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
      yield* tx.run(`
        CREATE TRIGGER session_facade_activity_legal_update
        BEFORE UPDATE ON session_facade_activity
        WHEN NOT (
          OLD.state = 'active'
          AND NEW.state = 'active'
          AND OLD.owner_session_id IS NULL
          AND NEW.owner_session_id IS NOT NULL
          AND NEW.activity_id IS OLD.activity_id
          AND NEW.subkind IS OLD.subkind
          AND NEW.parent_session_id IS OLD.parent_session_id
          AND NEW.owner_token IS OLD.owner_token
          AND NEW.spawn_tool_call_id IS OLD.spawn_tool_call_id
          AND NEW.objective_text IS OLD.objective_text
          AND NEW.budget_json IS OLD.budget_json
          AND NEW.reason_code IS OLD.reason_code
          AND NEW.source IS OLD.source
          AND NEW.created_at IS OLD.created_at
          AND NEW.settled_at IS OLD.settled_at
          AND NEW.mutation_epoch IS OLD.mutation_epoch
        ) AND (
          NEW.activity_id != OLD.activity_id
          OR NEW.subkind != OLD.subkind
          OR NEW.parent_session_id != OLD.parent_session_id
          OR COALESCE(NEW.owner_session_id, '') != COALESCE(OLD.owner_session_id, '')
          OR COALESCE(NEW.spawn_tool_call_id, '') != COALESCE(OLD.spawn_tool_call_id, '')
          OR COALESCE(NEW.objective_text, '') != COALESCE(OLD.objective_text, '')
          OR COALESCE(NEW.budget_json, '') != COALESCE(OLD.budget_json, '')
          OR COALESCE(NEW.source, '') != COALESCE(OLD.source, '')
          OR NEW.created_at != OLD.created_at
          OR OLD.state != 'active'
          OR NEW.state NOT IN ('settled', 'failed', 'interrupted', 'recovery_required')
          OR NEW.settled_at IS NULL
          OR NEW.reason_code IS NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_facade_activity transition');
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
      yield* tx.run(`
        CREATE TRIGGER session_facade_activity_permission_effect_terminal_guard
        BEFORE UPDATE OF state ON session_facade_activity
        WHEN NEW.state IN ('settled', 'failed', 'interrupted', 'recovery_required') AND EXISTS (
          SELECT 1
          FROM session_activity_permission_effect_dispatch dispatch
          WHERE dispatch.activity_kind = 'facade'
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
        CREATE TRIGGER session_facade_activity_permission_terminal_fence
        AFTER UPDATE OF state ON session_facade_activity
        WHEN OLD.state = 'active' AND NEW.state != 'active'
        BEGIN
          INSERT INTO session_activity_permission_decision (
            decision_id, request_id, idempotency_key, decision, actor_type, actor_id,
            scope, authority_epoch, decided_at, expires_at, feedback
          )
          SELECT
            'permission-facade-terminal:' || request.request_id,
            request.request_id,
            'permission-facade-terminal:' || request.request_id,
            CASE
              WHEN request.expires_at IS NOT NULL AND request.expires_at <= NEW.settled_at THEN 'expired'
              ELSE 'interrupted'
            END,
            'system',
            'facade-terminal-fence',
            request.requested_scope,
            request.authority_epoch,
            NEW.settled_at,
            NULL,
            NEW.reason_code
          FROM session_activity_permission_request request
          WHERE request.activity_kind = 'facade'
            AND request.activity_id = NEW.activity_id
            AND request.state = 'pending';

          UPDATE session_activity_permission_request
          SET state = (
                SELECT decision.decision
                FROM session_activity_permission_decision decision
                WHERE decision.request_id = session_activity_permission_request.request_id
              ),
              decided_at = NEW.settled_at
          WHERE activity_kind = 'facade'
            AND activity_id = NEW.activity_id
            AND state = 'pending';
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
