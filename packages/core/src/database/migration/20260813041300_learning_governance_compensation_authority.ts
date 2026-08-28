import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813041300_learning_governance_compensation_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TRIGGER learning_governance_compensation_identity_immutable
        BEFORE UPDATE ON learning_governance_compensation
        WHEN NEW.compensation_id != OLD.compensation_id
          OR NEW.plan_id != OLD.plan_id
          OR NEW.action_id != OLD.action_id
          OR NEW.sequence != OLD.sequence
          OR NEW.kind != OLD.kind
          OR NEW.source_payload_fingerprint != OLD.source_payload_fingerprint
          OR NEW.created_at != OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_compensation_identity_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_compensation_insert_guard
        BEFORE INSERT ON learning_governance_compensation
        WHEN NOT EXISTS (
          SELECT 1
          FROM learning_governance_action action
          JOIN learning_governance_plan plan ON plan.plan_id = action.plan_id
          WHERE action.action_id = NEW.action_id
            AND action.plan_id = NEW.plan_id
            AND (
              action.state = 'settled' OR (
                action.state = 'recovery_required'
                AND action.result_ref IS NOT NULL
                AND action.result_hash IS NOT NULL
                AND action.result_fingerprint IS NOT NULL
              )
            )
            AND action.payload_fingerprint = NEW.source_payload_fingerprint
            AND NEW.kind = CASE action.kind
              WHEN 'document_stage' THEN 'document_quarantine'
              WHEN 'memory_inbox' THEN 'memory_inbox_revoke'
            END
            AND plan.state = 'recovery_required'
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_compensation_source_invalid');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_compensation_version_fence
        BEFORE UPDATE ON learning_governance_compensation
        WHEN NEW.version != OLD.version + 1
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_compensation_version_must_advance_once');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_compensation_transition_guard
        BEFORE UPDATE OF state ON learning_governance_compensation
        WHEN NOT (
          (OLD.state = 'prepared' AND NEW.state = 'running'
            AND NEW.lease_expires_at > NEW.updated_at) OR
          (OLD.state = 'running' AND NEW.state = 'running'
            AND OLD.lease_expires_at <= NEW.updated_at
            AND NEW.lease_expires_at > NEW.updated_at) OR
          (OLD.state = 'running' AND NEW.state IN ('settled', 'recovery_required')
            AND NEW.owner IS NULL)
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_compensation_transition_invalid');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_compensation_sequence_guard
        BEFORE UPDATE OF state ON learning_governance_compensation
        WHEN NEW.state = 'running' AND NEW.sequence > 0 AND NOT EXISTS (
          SELECT 1 FROM learning_governance_compensation predecessor
          WHERE predecessor.plan_id = NEW.plan_id
            AND predecessor.sequence = NEW.sequence - 1
            AND predecessor.state = 'settled'
        )
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_compensation_predecessor_unsettled');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_governance_compensation_delete_guard
        BEFORE DELETE ON learning_governance_compensation
        BEGIN
          SELECT RAISE(ABORT, 'learning_governance_compensation_delete_forbidden');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
