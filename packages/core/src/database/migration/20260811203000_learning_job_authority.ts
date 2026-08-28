import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811203000_learning_job_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE learning_job (
          job_id TEXT PRIMARY KEY NOT NULL,
          project_id TEXT NOT NULL REFERENCES project(id),
          session_id TEXT REFERENCES session(id),
          run_id TEXT,
          trigger TEXT NOT NULL CHECK (trigger IN ('idle', 'pause', 'project_switch', 'session_finalization')),
          dedupe_key TEXT NOT NULL,
          candidate_input_ref TEXT NOT NULL,
          policy TEXT NOT NULL CHECK (policy IN ('auto_merge_safe_project', 'manual_review')),
          max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
          admission_fingerprint TEXT NOT NULL
            CHECK (length(admission_fingerprint) = 64 AND admission_fingerprint NOT GLOB '*[^0-9a-f]*'),
          state TEXT NOT NULL
            CHECK (state IN ('queued', 'running', 'reviewing', 'governance', 'completed', 'failed', 'cancelled', 'recovery_required')),
          attempts INTEGER NOT NULL CHECK (attempts >= 0),
          owner TEXT,
          lease_expires_at INTEGER,
          version INTEGER NOT NULL CHECK (version >= 0),
          side_effect_state TEXT NOT NULL
            CHECK (side_effect_state IN ('not_started', 'started', 'settled', 'unknown')),
          side_effect_kind TEXT
            CHECK (side_effect_kind IS NULL OR side_effect_kind IN ('extraction', 'reviewer', 'governance')),
          review_job_id TEXT,
          result_ref TEXT,
          error_code TEXT,
          error_detail TEXT,
          settlement_fingerprint TEXT
            CHECK (
              settlement_fingerprint IS NULL OR
              (length(settlement_fingerprint) = 64 AND settlement_fingerprint NOT GLOB '*[^0-9a-f]*')
            ),
          next_attempt_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          settled_at INTEGER,
          updated_at INTEGER NOT NULL,
          CHECK (
            (side_effect_state = 'not_started' AND side_effect_kind IS NULL) OR
            (side_effect_state IN ('started', 'settled', 'unknown') AND side_effect_kind IS NOT NULL)
          ),
          CHECK (
            side_effect_state <> 'settled' OR length(trim(result_ref)) > 0
          ),
          CHECK (
            state NOT IN ('running', 'reviewing', 'governance') OR
            side_effect_state = 'not_started' OR
            (state = 'running' AND side_effect_kind = 'extraction') OR
            (state = 'reviewing' AND side_effect_kind = 'reviewer') OR
            (state = 'governance' AND side_effect_kind = 'governance')
          ),
          CHECK (
            (
              state = 'queued' AND owner IS NULL AND lease_expires_at IS NULL AND
              side_effect_state = 'not_started'
            ) OR (
              state IN ('running', 'reviewing', 'governance') AND
              started_at IS NOT NULL AND settled_at IS NULL AND (
                (length(trim(owner)) > 0 AND lease_expires_at IS NOT NULL) OR
                (state IN ('reviewing', 'governance') AND owner IS NULL AND
                  lease_expires_at IS NULL AND side_effect_state = 'not_started')
              )
            ) OR (
              state IN ('completed', 'failed', 'cancelled', 'recovery_required') AND
              owner IS NULL AND lease_expires_at IS NULL AND settled_at IS NOT NULL
            )
          ),
          CHECK (
            state <> 'recovery_required' OR
            (side_effect_state <> 'not_started' AND error_code IS NOT NULL)
          ),
          CHECK (
            state <> 'completed' OR
            (side_effect_state = 'settled' AND length(trim(result_ref)) > 0)
          ),
          CHECK (
            state <> 'failed' OR length(trim(error_code)) > 0
          ),
          CHECK (
            state NOT IN ('completed', 'failed', 'cancelled') OR
            side_effect_state IN ('not_started', 'settled')
          )
        )
      `)
      yield* tx.run("CREATE UNIQUE INDEX learning_job_dedupe_idx ON learning_job (dedupe_key)")
      yield* tx.run("CREATE INDEX learning_job_due_idx ON learning_job (state, next_attempt_at, created_at)")
      yield* tx.run("CREATE INDEX learning_job_project_created_idx ON learning_job (project_id, created_at)")
      yield* tx.run(
        "CREATE INDEX learning_job_owner_lease_idx ON learning_job (owner, lease_expires_at) WHERE owner IS NOT NULL",
      )
      yield* tx.run(`
        CREATE TRIGGER learning_job_scope_validate_insert
        BEFORE INSERT ON learning_job
        WHEN NEW.session_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM session
          WHERE session.id = NEW.session_id AND session.project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_job_session_project_mismatch');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_identity_immutable
        BEFORE UPDATE ON learning_job
        WHEN NEW.job_id != OLD.job_id
          OR NEW.project_id != OLD.project_id
          OR NEW.session_id IS NOT OLD.session_id
          OR NEW.run_id IS NOT OLD.run_id
          OR NEW.trigger != OLD.trigger
          OR NEW.dedupe_key != OLD.dedupe_key
          OR NEW.candidate_input_ref != OLD.candidate_input_ref
          OR NEW.policy != OLD.policy
          OR NEW.max_attempts != OLD.max_attempts
          OR NEW.admission_fingerprint != OLD.admission_fingerprint
          OR NEW.created_at != OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'learning_job_identity_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_version_fence
        BEFORE UPDATE ON learning_job
        WHEN NEW.version != OLD.version + 1
        BEGIN
          SELECT RAISE(ABORT, 'learning_job_version_must_advance_once');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_terminal_immutable
        BEFORE UPDATE ON learning_job
        WHEN OLD.state IN ('completed', 'failed', 'cancelled', 'recovery_required')
        BEGIN
          SELECT RAISE(ABORT, 'learning_job_terminal_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_transition_guard
        BEFORE UPDATE OF state ON learning_job
        WHEN NOT (
          (OLD.state = 'queued' AND NEW.state IN ('running', 'cancelled')) OR
          (OLD.state = 'running' AND
            NEW.state IN ('queued', 'running', 'reviewing', 'failed', 'cancelled', 'recovery_required')) OR
          (OLD.state = 'reviewing' AND
            NEW.state IN ('reviewing', 'governance', 'failed', 'cancelled', 'recovery_required')) OR
          (OLD.state = 'governance' AND
            NEW.state IN ('governance', 'completed', 'failed', 'cancelled', 'recovery_required'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_job_transition_invalid');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_phase_advance_guard
        BEFORE UPDATE OF state ON learning_job
        WHEN (
          OLD.state = 'running' AND NEW.state = 'reviewing' AND NOT (
            OLD.side_effect_state = 'settled' AND OLD.side_effect_kind = 'extraction' AND
            NEW.side_effect_state = 'not_started' AND NEW.side_effect_kind IS NULL
          )
        ) OR (
          OLD.state = 'reviewing' AND NEW.state = 'governance' AND NOT (
            OLD.side_effect_state = 'settled' AND OLD.side_effect_kind = 'reviewer' AND
            NEW.side_effect_state = 'not_started' AND NEW.side_effect_kind IS NULL
          )
        ) OR (
          OLD.state = 'governance' AND NEW.state = 'completed' AND NOT (
            OLD.side_effect_state = 'settled' AND OLD.side_effect_kind = 'governance' AND
            NEW.result_ref = OLD.result_ref
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_job_phase_advance_invalid');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_side_effect_settlement_guard
        BEFORE UPDATE ON learning_job
        WHEN OLD.side_effect_state = 'started' AND NEW.side_effect_state = 'settled'
          AND NEW.result_ref IS OLD.result_ref
        BEGIN
          SELECT RAISE(ABORT, 'learning_job_side_effect_result_required');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
