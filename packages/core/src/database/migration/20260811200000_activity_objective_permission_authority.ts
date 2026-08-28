import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811200000_activity_objective_permission_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_activity_objective (
          activity_kind TEXT NOT NULL CHECK (activity_kind IN ('legacy', 'v2')),
          activity_id TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          version INTEGER NOT NULL CHECK (version >= 1),
          admission_fingerprint TEXT NOT NULL,
          objective_fingerprint TEXT,
          objective_text TEXT,
          completion_criteria TEXT NOT NULL,
          enforcement_state TEXT NOT NULL CHECK (enforcement_state IN ('disabled', 'monitoring')),
          stall_threshold INTEGER CHECK (stall_threshold IS NULL OR stall_threshold > 0),
          state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'needs_human', 'interrupted', 'recovery_required')),
          no_progress_count INTEGER NOT NULL CHECK (no_progress_count >= 0),
          latest_observation_revision INTEGER NOT NULL CHECK (latest_observation_revision >= -1),
          latest_vector_hash TEXT,
          next_action TEXT,
          terminal_reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          settled_at INTEGER,
          PRIMARY KEY (activity_kind, activity_id),
          CHECK (
            (enforcement_state = 'disabled' AND stall_threshold IS NULL) OR
            (enforcement_state = 'monitoring' AND stall_threshold IS NOT NULL)
          ),
          CHECK (
            (state = 'active' AND settled_at IS NULL AND terminal_reason IS NULL) OR
            (state != 'active' AND settled_at IS NOT NULL AND terminal_reason IS NOT NULL)
          ),
          CHECK (
            (latest_observation_revision = -1 AND latest_vector_hash IS NULL) OR
            (latest_observation_revision >= 0 AND latest_vector_hash IS NOT NULL)
          )
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_activity_objective_session_idx
        ON session_activity_objective(session_id, state, updated_at)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_objective_validate_insert
        BEFORE INSERT ON session_activity_objective
        BEGIN
          SELECT CASE WHEN NEW.activity_kind = 'legacy' AND NOT EXISTS (
            SELECT 1 FROM session_legacy_activity activity
            WHERE activity.activity_id = NEW.activity_id
              AND activity.session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'legacy activity objective owner mismatch') END;
          SELECT CASE WHEN NEW.activity_kind = 'v2' AND NOT EXISTS (
            SELECT 1 FROM session_activity activity
            WHERE activity.activity_id = NEW.activity_id
              AND activity.session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'v2 activity objective owner mismatch') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_objective_legal_update
        BEFORE UPDATE ON session_activity_objective
        WHEN NEW.activity_kind != OLD.activity_kind
          OR NEW.activity_id != OLD.activity_id
          OR NEW.session_id != OLD.session_id
          OR NEW.admission_fingerprint != OLD.admission_fingerprint
          OR NEW.created_at != OLD.created_at
          OR NEW.version != OLD.version + 1
          OR NEW.updated_at < OLD.updated_at
          OR (OLD.objective_fingerprint IS NOT NULL AND (
            NEW.objective_fingerprint IS NULL
            OR NEW.objective_fingerprint != OLD.objective_fingerprint
            OR COALESCE(NEW.objective_text, '') != COALESCE(OLD.objective_text, '')
            OR NEW.completion_criteria != OLD.completion_criteria
            OR NEW.enforcement_state != OLD.enforcement_state
            OR COALESCE(NEW.stall_threshold, -1) != COALESCE(OLD.stall_threshold, -1)
          ))
          OR OLD.state IN ('completed', 'interrupted')
          OR (OLD.state = 'recovery_required' AND NEW.state != 'recovery_required')
          OR (OLD.state = 'needs_human' AND NEW.state NOT IN ('needs_human', 'active', 'interrupted', 'recovery_required'))
          OR (OLD.state = 'active' AND NEW.state NOT IN ('active', 'completed', 'needs_human', 'interrupted', 'recovery_required'))
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_activity_objective transition');
        END
      `)
      yield* tx.run(`
        INSERT INTO session_activity_objective (
          activity_kind, activity_id, session_id, version, admission_fingerprint, objective_fingerprint, objective_text,
          completion_criteria, enforcement_state, stall_threshold, state, no_progress_count,
          latest_observation_revision, latest_vector_hash, next_action, terminal_reason,
          created_at, updated_at, settled_at
        )
        SELECT
          'legacy',
          activity.activity_id,
          activity.session_id,
          1,
          admission.payload_fingerprint,
          NULL,
          NULL,
          '[]',
          'disabled',
          NULL,
          CASE
            WHEN activity.state = 'settled' THEN 'completed'
            WHEN activity.state = 'failed' THEN 'recovery_required'
            ELSE activity.state
          END,
          0,
          -1,
          NULL,
          NULL,
          activity.terminal_reason,
          activity.created_at,
          COALESCE(activity.settled_at, activity.created_at),
          activity.settled_at
        FROM session_legacy_activity activity
        JOIN session_activity_admission admission
          ON admission.admission_id = activity.trigger_admission_id
      `)
      yield* tx.run(`
        INSERT INTO session_activity_objective (
          activity_kind, activity_id, session_id, version, admission_fingerprint, objective_fingerprint, objective_text,
          completion_criteria, enforcement_state, stall_threshold, state, no_progress_count,
          latest_observation_revision, latest_vector_hash, next_action, terminal_reason,
          created_at, updated_at, settled_at
        )
        SELECT
          'v2',
          activity.activity_id,
          activity.session_id,
          1,
          'session-input:' || activity.trigger_input_id,
          NULL,
          NULL,
          '[]',
          'disabled',
          NULL,
          CASE
            WHEN activity.state = 'settled' THEN 'completed'
            WHEN activity.state = 'failed' THEN 'recovery_required'
            ELSE activity.state
          END,
          0,
          -1,
          NULL,
          NULL,
          CASE WHEN activity.state = 'active' THEN NULL ELSE activity.state END,
          activity.created_at,
          COALESCE(activity.settled_at, activity.created_at),
          activity.settled_at
        FROM session_activity activity
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_objective_insert
        AFTER INSERT ON session_legacy_activity
        BEGIN
          INSERT INTO session_activity_objective (
            activity_kind, activity_id, session_id, version, admission_fingerprint, objective_fingerprint, objective_text,
            completion_criteria, enforcement_state, stall_threshold, state, no_progress_count,
            latest_observation_revision, latest_vector_hash, next_action, terminal_reason,
            created_at, updated_at, settled_at
          )
          SELECT
            'legacy', NEW.activity_id, NEW.session_id, 1, admission.payload_fingerprint, NULL, NULL,
            '[]', 'disabled', NULL,
            CASE
              WHEN NEW.state = 'settled' THEN 'completed'
              WHEN NEW.state = 'failed' THEN 'recovery_required'
              ELSE NEW.state
            END,
            0, -1, NULL, NULL, NEW.terminal_reason, NEW.created_at,
            COALESCE(NEW.settled_at, NEW.created_at), NEW.settled_at
          FROM session_activity_admission admission
          WHERE admission.admission_id = NEW.trigger_admission_id;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_activity_objective_insert
        AFTER INSERT ON session_activity
        BEGIN
          INSERT INTO session_activity_objective (
            activity_kind, activity_id, session_id, version, admission_fingerprint, objective_fingerprint, objective_text,
            completion_criteria, enforcement_state, stall_threshold, state, no_progress_count,
            latest_observation_revision, latest_vector_hash, next_action, terminal_reason,
            created_at, updated_at, settled_at
          ) VALUES (
            'v2', NEW.activity_id, NEW.session_id, 1, 'session-input:' || NEW.trigger_input_id, NULL, NULL,
            '[]', 'disabled', NULL,
            CASE
              WHEN NEW.state = 'settled' THEN 'completed'
              WHEN NEW.state = 'failed' THEN 'recovery_required'
              ELSE NEW.state
            END,
            0, -1, NULL, NULL,
            CASE WHEN NEW.state = 'active' THEN NULL ELSE NEW.state END,
            NEW.created_at, COALESCE(NEW.settled_at, NEW.created_at), NEW.settled_at
          );
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_objective_terminal_projection
        AFTER UPDATE OF state ON session_legacy_activity
        WHEN OLD.state = 'active' AND NEW.state != 'active'
        BEGIN
          UPDATE session_activity_objective
          SET version = version + 1,
              state = CASE
                WHEN NEW.state = 'settled' THEN 'completed'
                WHEN NEW.state = 'failed' THEN 'recovery_required'
                ELSE NEW.state
              END,
              terminal_reason = NEW.terminal_reason,
              updated_at = NEW.settled_at,
              settled_at = NEW.settled_at
          WHERE activity_kind = 'legacy'
            AND activity_id = NEW.activity_id
            AND enforcement_state = 'disabled'
            AND state = 'active';
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_activity_objective_terminal_projection
        AFTER UPDATE OF state ON session_activity
        WHEN OLD.state = 'active' AND NEW.state != 'active'
        BEGIN
          UPDATE session_activity_objective
          SET version = version + 1,
              state = CASE
                WHEN NEW.state = 'settled' THEN 'completed'
                WHEN NEW.state = 'failed' THEN 'recovery_required'
                ELSE NEW.state
              END,
              terminal_reason = NEW.state,
              updated_at = NEW.settled_at,
              settled_at = NEW.settled_at
          WHERE activity_kind = 'v2'
            AND activity_id = NEW.activity_id
            AND enforcement_state = 'disabled'
            AND state = 'active';
        END
      `)

      yield* tx.run(`
        CREATE TABLE session_activity_evidence (
          activity_kind TEXT NOT NULL CHECK (activity_kind IN ('legacy', 'v2')),
          activity_id TEXT NOT NULL,
          evidence_fingerprint TEXT NOT NULL,
          evidence_kind TEXT NOT NULL,
          source_receipt_id TEXT,
          first_observation_revision INTEGER NOT NULL CHECK (first_observation_revision >= 0),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (activity_kind, activity_id, evidence_fingerprint),
          FOREIGN KEY (activity_kind, activity_id)
            REFERENCES session_activity_objective(activity_kind, activity_id) ON DELETE CASCADE
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_activity_evidence_activity_idx
        ON session_activity_evidence(activity_kind, activity_id, first_observation_revision)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_evidence_validate_insert
        BEFORE INSERT ON session_activity_evidence
        WHEN NOT EXISTS (
          SELECT 1 FROM session_activity_objective objective
          WHERE objective.activity_kind = NEW.activity_kind
            AND objective.activity_id = NEW.activity_id
            AND objective.state = 'active'
            AND NEW.first_observation_revision = objective.latest_observation_revision + 1
        )
        BEGIN
          SELECT RAISE(ABORT, 'activity evidence does not match next active observation');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_evidence_immutable
        BEFORE UPDATE ON session_activity_evidence
        BEGIN
          SELECT RAISE(ABORT, 'session_activity_evidence is immutable');
        END
      `)

      yield* tx.run(`
        CREATE TABLE session_activity_effect_receipt (
          activity_kind TEXT NOT NULL CHECK (activity_kind IN ('legacy', 'v2')),
          activity_id TEXT NOT NULL,
          receipt_id TEXT NOT NULL,
          effect_fingerprint TEXT NOT NULL,
          first_observation_revision INTEGER NOT NULL CHECK (first_observation_revision >= 0),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (activity_kind, activity_id, receipt_id),
          FOREIGN KEY (activity_kind, activity_id)
            REFERENCES session_activity_objective(activity_kind, activity_id) ON DELETE CASCADE
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_activity_effect_receipt_activity_idx
        ON session_activity_effect_receipt(activity_kind, activity_id, first_observation_revision)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_effect_receipt_validate_insert
        BEFORE INSERT ON session_activity_effect_receipt
        WHEN NOT EXISTS (
          SELECT 1 FROM session_activity_objective objective
          WHERE objective.activity_kind = NEW.activity_kind
            AND objective.activity_id = NEW.activity_id
            AND objective.state = 'active'
            AND NEW.first_observation_revision = objective.latest_observation_revision + 1
        )
        BEGIN
          SELECT RAISE(ABORT, 'activity effect receipt does not match next active observation');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_effect_receipt_immutable
        BEFORE UPDATE ON session_activity_effect_receipt
        BEGIN
          SELECT RAISE(ABORT, 'session_activity_effect_receipt is immutable');
        END
      `)

      yield* tx.run(`
        CREATE TABLE session_activity_progress_observation (
          activity_kind TEXT NOT NULL CHECK (activity_kind IN ('legacy', 'v2')),
          activity_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          idempotency_key TEXT NOT NULL UNIQUE,
          observation_fingerprint TEXT NOT NULL,
          expected_objective_version INTEGER NOT NULL CHECK (expected_objective_version >= 1),
          workspace_revision TEXT,
          plan_version INTEGER,
          validation_fingerprint TEXT,
          evidence_set_hash TEXT NOT NULL,
          effect_receipt_set_hash TEXT NOT NULL,
          vector_hash TEXT NOT NULL,
          next_action TEXT,
          changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
          no_progress_count INTEGER NOT NULL CHECK (no_progress_count >= 0),
          observed_at INTEGER NOT NULL,
          PRIMARY KEY (activity_kind, activity_id, revision),
          FOREIGN KEY (activity_kind, activity_id)
            REFERENCES session_activity_objective(activity_kind, activity_id) ON DELETE CASCADE
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_activity_progress_observation_latest_idx
        ON session_activity_progress_observation(activity_kind, activity_id, observed_at)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_progress_observation_validate_insert
        BEFORE INSERT ON session_activity_progress_observation
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_activity_objective objective
            WHERE objective.activity_kind = NEW.activity_kind
              AND objective.activity_id = NEW.activity_id
              AND objective.state = 'active'
              AND objective.version = NEW.expected_objective_version
              AND NEW.revision = objective.latest_observation_revision + 1
          ) THEN RAISE(ABORT, 'activity observation objective CAS mismatch') END;
          SELECT CASE WHEN NEW.revision = 0 AND (NEW.changed != 1 OR NEW.no_progress_count != 0)
            THEN RAISE(ABORT, 'initial activity observation must establish progress') END;
          SELECT CASE WHEN NEW.revision > 0 AND NOT EXISTS (
            SELECT 1 FROM session_activity_progress_observation previous
            WHERE previous.activity_kind = NEW.activity_kind
              AND previous.activity_id = NEW.activity_id
              AND previous.revision = NEW.revision - 1
          ) THEN RAISE(ABORT, 'activity observation revision is not continuous') END;
          SELECT CASE WHEN NEW.revision > 0 AND NOT EXISTS (
            SELECT 1 FROM session_activity_objective objective
            WHERE objective.activity_kind = NEW.activity_kind
              AND objective.activity_id = NEW.activity_id
              AND (
                (NEW.vector_hash != objective.latest_vector_hash AND NEW.changed = 1 AND NEW.no_progress_count = 0) OR
                (NEW.vector_hash = objective.latest_vector_hash AND NEW.changed = 0
                  AND NEW.no_progress_count = objective.no_progress_count + 1)
              )
          ) THEN RAISE(ABORT, 'activity observation progress classification mismatch') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_progress_observation_immutable
        BEFORE UPDATE ON session_activity_progress_observation
        BEGIN
          SELECT RAISE(ABORT, 'session_activity_progress_observation is immutable');
        END
      `)

      yield* tx.run(`
        CREATE TABLE permission_saved_epoch (
          project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
          epoch INTEGER NOT NULL CHECK (epoch >= 0),
          updated_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        INSERT INTO permission_saved_epoch (project_id, epoch, updated_at)
        SELECT id, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM project
      `)
      yield* tx.run(`
        CREATE TRIGGER permission_saved_epoch_project_insert
        AFTER INSERT ON project
        BEGIN
          INSERT INTO permission_saved_epoch (project_id, epoch, updated_at)
          VALUES (NEW.id, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER permission_saved_epoch_legal_update
        BEFORE UPDATE ON permission_saved_epoch
        WHEN NEW.project_id != OLD.project_id OR NEW.epoch != OLD.epoch + 1 OR NEW.updated_at < OLD.updated_at
        BEGIN
          SELECT RAISE(ABORT, 'illegal permission_saved_epoch transition');
        END
      `)

      yield* tx.run(`
        CREATE TABLE session_activity_permission_request (
          request_id TEXT PRIMARY KEY,
          activity_kind TEXT NOT NULL CHECK (activity_kind IN ('legacy', 'v2')),
          activity_id TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
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
          FOREIGN KEY (activity_kind, activity_id)
            REFERENCES session_activity_objective(activity_kind, activity_id) ON DELETE CASCADE,
          CHECK (
            (state = 'pending' AND decided_at IS NULL) OR
            (state != 'pending' AND decided_at IS NOT NULL)
          ),
          CHECK (expires_at IS NULL OR expires_at > created_at)
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_activity_permission_request_pending_idx
        ON session_activity_permission_request(session_id, state, created_at)
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_activity_permission_request_pending_no_progress_idx
        ON session_activity_permission_request(activity_kind, activity_id)
        WHERE state = 'pending' AND request_kind = 'no_progress'
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_permission_request_validate_insert
        BEFORE INSERT ON session_activity_permission_request
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
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
        CREATE TABLE session_activity_permission_decision (
          decision_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE REFERENCES session_activity_permission_request(request_id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL UNIQUE,
          decision TEXT NOT NULL CHECK (decision IN ('approved_once', 'approved_always', 'denied', 'expired', 'interrupted')),
          actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'administrator', 'system')),
          actor_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('once', 'project')),
          authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
          decided_at INTEGER NOT NULL,
          expires_at INTEGER,
          CHECK (expires_at IS NULL OR expires_at > decided_at),
          CHECK (decision != 'approved_always' OR expires_at IS NULL)
        )
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
        CREATE TABLE session_activity_permission_once_consumption (
          request_id TEXT PRIMARY KEY REFERENCES session_activity_permission_request(request_id) ON DELETE CASCADE,
          consumer_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          consumed_at INTEGER NOT NULL
        )
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
            AND (request.expires_at IS NULL OR request.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)
            AND (decision.expires_at IS NULL OR decision.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)
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
    })
  },
} satisfies DatabaseMigration.Migration
