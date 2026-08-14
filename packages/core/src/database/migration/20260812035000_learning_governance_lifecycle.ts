import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Runtime DDL is hand-written because governance correctness also depends on
// cross-table lifecycle triggers that Drizzle snapshots cannot express.
export default {
  id: "20260812035000_learning_governance_lifecycle",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TRIGGER learning_governance_plan_identity_immutable
        BEFORE UPDATE ON learning_governance_plan
        WHEN NEW.plan_id != OLD.plan_id
          OR NEW.job_id != OLD.job_id
          OR NEW.policy != OLD.policy
          OR NEW.payload_json != OLD.payload_json
          OR NEW.payload_fingerprint != OLD.payload_fingerprint
          OR NEW.action_count != OLD.action_count
          OR NEW.source_job_version != OLD.source_job_version
          OR NEW.created_at != OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_plan_identity_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_plan_takeover_guard
        BEFORE UPDATE OF job_owner, job_started_version ON learning_governance_plan
        WHEN OLD.state != 'prepared' OR NOT EXISTS (
          SELECT 1 FROM learning_job job
          WHERE job.job_id = OLD.job_id
            AND job.state = 'governance'
            AND job.side_effect_state = 'started'
            AND job.side_effect_kind = 'governance'
            AND job.owner = NEW.job_owner
            AND job.version = NEW.job_started_version
            AND job.lease_expires_at > NEW.updated_at
            AND NEW.job_started_version = OLD.job_started_version + 1
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_plan_takeover_invalid');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_plan_job_fence
        BEFORE INSERT ON learning_governance_plan
        WHEN NOT EXISTS (
          SELECT 1 FROM learning_job job
          WHERE job.job_id = NEW.job_id
            AND job.state = 'governance'
            AND job.side_effect_state = 'not_started'
            AND job.side_effect_kind IS NULL
            AND job.owner = NEW.job_owner
            AND job.version = NEW.source_job_version
            AND job.lease_expires_at > NEW.created_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_plan_job_fence_lost');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_plan_version_fence
        BEFORE UPDATE ON learning_governance_plan
        WHEN NEW.version != OLD.version + 1
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_plan_version_must_advance_once');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_plan_transition_guard
        BEFORE UPDATE OF state ON learning_governance_plan
        WHEN NOT (
          (OLD.state = 'prepared' AND NEW.state IN ('settled', 'recovery_required')) OR
          (OLD.state = 'settled' AND NEW.state = 'recovery_required' AND EXISTS (
            SELECT 1 FROM learning_job job
            WHERE job.job_id = OLD.job_id AND job.state != 'completed'
          ))
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_plan_transition_invalid');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_plan_settle_guard
        BEFORE UPDATE OF state ON learning_governance_plan
        WHEN NEW.state = 'settled' AND (
          (SELECT count(*) FROM learning_governance_action action WHERE action.plan_id = OLD.plan_id) != OLD.action_count OR
          EXISTS (
            SELECT 1 FROM learning_governance_action action
            WHERE action.plan_id = OLD.plan_id AND action.state != 'settled'
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_plan_actions_not_settled');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_plan_delete_guard
        BEFORE DELETE ON learning_governance_plan
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_plan_delete_forbidden');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_action_identity_immutable
        BEFORE UPDATE ON learning_governance_action
        WHEN NEW.action_id != OLD.action_id
          OR NEW.plan_id != OLD.plan_id
          OR NEW.candidate_id != OLD.candidate_id
          OR NEW.sequence != OLD.sequence
          OR NEW.kind != OLD.kind
          OR NEW.predecessor_action_id IS NOT OLD.predecessor_action_id
          OR NEW.payload_json != OLD.payload_json
          OR NEW.payload_fingerprint != OLD.payload_fingerprint
          OR NEW.created_at != OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_action_identity_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_action_insert_guard
        BEFORE INSERT ON learning_governance_action
        WHEN NOT EXISTS (
          SELECT 1 FROM learning_governance_plan plan
          WHERE plan.plan_id = NEW.plan_id
            AND plan.state = 'prepared'
            AND NEW.sequence < plan.action_count
            AND (
              NEW.predecessor_action_id IS NULL OR EXISTS (
                SELECT 1 FROM learning_governance_action predecessor
                WHERE predecessor.action_id = NEW.predecessor_action_id
                  AND predecessor.plan_id = NEW.plan_id
                  AND predecessor.sequence < NEW.sequence
              )
            )
            AND (
              SELECT count(*) FROM learning_governance_action action
              WHERE action.plan_id = NEW.plan_id
            ) < plan.action_count
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_action_insert_invalid');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_action_version_fence
        BEFORE UPDATE ON learning_governance_action
        WHEN NEW.version != OLD.version + 1
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_action_version_must_advance_once');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_action_transition_guard
        BEFORE UPDATE OF state ON learning_governance_action
        WHEN NOT (
          (OLD.state = 'prepared' AND NEW.state = 'running') OR
          (OLD.state = 'running' AND (
            NEW.state IN ('running', 'settled') OR
            (NEW.state = 'recovery_required' AND EXISTS (
              SELECT 1
              FROM learning_governance_plan plan
              JOIN learning_job job ON job.job_id = plan.job_id
              WHERE plan.plan_id = OLD.plan_id
                AND plan.state = 'prepared'
                AND job.state = 'governance'
                AND job.side_effect_state = 'started'
                AND job.side_effect_kind = 'governance'
                AND job.owner = OLD.owner
                AND job.version = plan.job_started_version
                AND job.lease_expires_at > NEW.updated_at
            ))
          )) OR
          (OLD.state = 'settled' AND NEW.state = 'recovery_required' AND EXISTS (
            SELECT 1
            FROM learning_governance_plan plan
            JOIN learning_job job ON job.job_id = plan.job_id
            WHERE plan.plan_id = OLD.plan_id AND job.state != 'completed'
          ))
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_action_transition_invalid');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_action_claim_guard
        BEFORE UPDATE OF state ON learning_governance_action
        WHEN NEW.state = 'running' AND (
          NOT EXISTS (
            SELECT 1 FROM learning_governance_plan plan
            JOIN learning_job job ON job.job_id = plan.job_id
            WHERE plan.plan_id = OLD.plan_id AND plan.state = 'prepared'
              AND job.state = 'governance'
              AND job.side_effect_state = 'started'
              AND job.side_effect_kind = 'governance'
              AND job.owner = NEW.owner
              AND job.version = plan.job_started_version
              AND job.lease_expires_at > NEW.updated_at
              AND NEW.lease_expires_at <= job.lease_expires_at
          ) OR
          (OLD.state = 'prepared' AND NOT (NEW.lease_expires_at > NEW.updated_at)) OR
          (OLD.state = 'running' AND NOT (
            OLD.lease_expires_at <= NEW.updated_at AND NEW.lease_expires_at > NEW.updated_at
          )) OR
          (OLD.predecessor_action_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM learning_governance_action predecessor
            WHERE predecessor.action_id = OLD.predecessor_action_id
              AND predecessor.plan_id = OLD.plan_id
              AND predecessor.state = 'settled'
          ))
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_action_claim_invalid');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_governance_takeover_guard
        BEFORE UPDATE OF owner, lease_expires_at ON learning_job
        WHEN OLD.state = 'governance' AND OLD.side_effect_state = 'started'
          AND OLD.side_effect_kind = 'governance' AND NEW.state = 'governance'
          AND NEW.side_effect_state = 'started' AND NEW.side_effect_kind = 'governance'
          AND NEW.owner IS NOT OLD.owner AND NOT (
            OLD.lease_expires_at <= NEW.updated_at AND length(trim(NEW.owner)) > 0
              AND NEW.lease_expires_at > NEW.updated_at
              AND EXISTS (
                SELECT 1 FROM learning_governance_plan plan
                WHERE plan.job_id = OLD.job_id
                  AND plan.state = 'prepared'
                  AND plan.job_started_version = OLD.version
              )
          )
        BEGIN
          SELECT RAISE(ABORT, 'learning_job_governance_takeover_invalid');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_action_settle_guard
        BEFORE UPDATE OF state ON learning_governance_action
        WHEN NEW.state = 'settled' AND NOT EXISTS (
          SELECT 1 FROM learning_governance_plan plan
          JOIN learning_job job ON job.job_id = plan.job_id
          WHERE plan.plan_id = OLD.plan_id AND plan.state = 'prepared'
            AND job.state = 'governance'
            AND job.side_effect_state = 'started'
            AND job.side_effect_kind = 'governance'
            AND job.owner = OLD.owner
            AND job.version = plan.job_started_version
            AND job.lease_expires_at > NEW.updated_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_action_plan_not_prepared');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_action_result_conflict_guard
        BEFORE UPDATE OF state ON learning_governance_action
        WHEN OLD.state = 'settled' AND NEW.state = 'recovery_required' AND NOT (
          NEW.result_ref = OLD.result_ref AND NEW.result_hash = OLD.result_hash AND
          NEW.result_fingerprint = OLD.result_fingerprint AND
          NEW.error_code = 'governance_action_output_conflict'
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_action_conflict_evidence_required');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_action_delete_guard
        BEFORE DELETE ON learning_governance_action
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_action_delete_forbidden');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_governance_plan_begin_guard
        BEFORE UPDATE ON learning_job
        WHEN OLD.state = 'governance' AND OLD.side_effect_state = 'not_started'
          AND NEW.state = 'governance' AND NEW.side_effect_state = 'started'
          AND NEW.side_effect_kind = 'governance'
          AND NOT EXISTS (
            SELECT 1 FROM learning_governance_plan plan
            WHERE plan.job_id = OLD.job_id
              AND plan.state = 'prepared'
              AND plan.job_owner = NEW.owner
              AND plan.source_job_version = OLD.version
              AND plan.job_started_version = NEW.version
              AND plan.action_count = (
                SELECT count(*) FROM learning_governance_action action WHERE action.plan_id = plan.plan_id
              )
          )
        BEGIN
          SELECT RAISE(ABORT, 'learning_job_governance_plan_required');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_governance_plan_settle_guard
        BEFORE UPDATE ON learning_job
        WHEN OLD.state = 'governance' AND OLD.side_effect_state = 'started'
          AND OLD.side_effect_kind = 'governance' AND NEW.side_effect_state = 'settled'
          AND NOT EXISTS (
            SELECT 1 FROM learning_governance_plan plan
            WHERE plan.job_id = OLD.job_id
              AND plan.state = 'settled'
              AND plan.result_ref = NEW.result_ref
          )
        BEGIN
          SELECT RAISE(ABORT, 'learning_job_governance_plan_not_settled');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_job_governance_completion_guard
        BEFORE UPDATE OF state ON learning_job
        WHEN OLD.state = 'governance' AND NEW.state = 'completed' AND NOT EXISTS (
          SELECT 1 FROM learning_governance_plan plan
          WHERE plan.job_id = OLD.job_id
            AND plan.state = 'settled'
            AND plan.result_ref = NEW.result_ref
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_job_governance_plan_completion_required');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
