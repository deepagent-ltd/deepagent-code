import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813110000_provider_recovery_authority_bridge",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_provider_attempt_resolution_rebuilt (
          resolution_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL UNIQUE
            REFERENCES session_provider_attempt(attempt_id) ON DELETE CASCADE,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'administrator', 'system')),
          actor_id TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('abandoned', 'settled', 'replayed')),
          provider_evidence TEXT,
          risk_acknowledged INTEGER NOT NULL CHECK (risk_acknowledged IN (0, 1)),
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        INSERT INTO session_provider_attempt_resolution_rebuilt
        SELECT * FROM session_provider_attempt_resolution
      `)
      yield* tx.run("DROP TABLE session_provider_attempt_resolution")
      yield* tx.run(`
        ALTER TABLE session_provider_attempt_resolution_rebuilt
        RENAME TO session_provider_attempt_resolution
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_resolution_immutable
        BEFORE UPDATE ON session_provider_attempt_resolution
        BEGIN
          SELECT RAISE(ABORT, 'session_provider_attempt_resolution is append-only');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_resolution_immutable_delete
        BEFORE DELETE ON session_provider_attempt_resolution
        WHEN EXISTS (
          SELECT 1
          FROM session_provider_attempt attempt
          JOIN session ON session.id = attempt.session_id
          WHERE attempt.attempt_id = OLD.attempt_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'session_provider_attempt_resolution is append-only');
        END
      `)
      yield* tx.run(`
        CREATE TABLE session_provider_attempt_recovery_bridge (
          resolution_id TEXT NOT NULL PRIMARY KEY,
          attempt_id TEXT NOT NULL UNIQUE
            REFERENCES session_provider_attempt(attempt_id) ON DELETE CASCADE,
          receipt_id TEXT NOT NULL UNIQUE
            REFERENCES session_tool_request_receipt(receipt_id) ON DELETE CASCADE,
          command_id TEXT NOT NULL UNIQUE
            REFERENCES session_tool_request_resolution_command(command_id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_recovery_bridge_validate_insert
        BEFORE INSERT ON session_provider_attempt_recovery_bridge
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1
            FROM session_tool_request_receipt receipt
            JOIN session_provider_attempt attempt
              ON attempt.attempt_id = receipt.provider_attempt_id
            JOIN session_tool_request_resolution_command command
              ON command.command_id = NEW.command_id
            WHERE receipt.receipt_id = NEW.receipt_id
              AND receipt.provider_attempt_id = NEW.attempt_id
              AND receipt.provider_state = 'indeterminate_after_crash'
              AND attempt.session_id = receipt.session_id
              AND attempt.state = 'indeterminate_after_crash'
              AND command.session_id = receipt.session_id
              AND command.receipt_id = receipt.receipt_id
              AND command.result_resolution_id IS NULL
          ) THEN RAISE(ABORT, 'provider_recovery_bridge_authority_invalid') END;
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM session_provider_attempt_resolution
            WHERE attempt_id = NEW.attempt_id
          ) THEN RAISE(ABORT, 'provider_recovery_bridge_attempt_already_resolved') END;
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM session_tool_request_resolution
            WHERE receipt_id = NEW.receipt_id
          ) THEN RAISE(ABORT, 'provider_recovery_bridge_receipt_already_resolved') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_recovery_bridge_immutable_update
        BEFORE UPDATE ON session_provider_attempt_recovery_bridge
        BEGIN
          SELECT RAISE(ABORT, 'provider_recovery_bridge_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_recovery_bridge_immutable_delete
        BEFORE DELETE ON session_provider_attempt_recovery_bridge
        WHEN EXISTS (
          SELECT 1
          FROM session_tool_request_receipt receipt
          JOIN session ON session.id = receipt.session_id
          WHERE receipt.receipt_id = OLD.receipt_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'provider_recovery_bridge_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_resolution_legacy_guard
        BEFORE INSERT ON session_provider_attempt_resolution
        WHEN EXISTS (
          SELECT 1 FROM session_tool_request_receipt receipt
          WHERE receipt.provider_attempt_id = NEW.attempt_id
            AND receipt.provider_state = 'indeterminate_after_crash'
        )
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1
            FROM session_provider_attempt_recovery_bridge bridge
            JOIN session_tool_request_resolution resolution
              ON resolution.resolution_id = bridge.resolution_id
             AND resolution.receipt_id = bridge.receipt_id
            WHERE bridge.resolution_id = NEW.resolution_id
              AND bridge.attempt_id = NEW.attempt_id
              AND resolution.decision = NEW.decision
          ) THEN RAISE(ABORT, 'provider_attempt_requires_unified_legacy_recovery') END;
          SELECT CASE WHEN NEW.decision != 'abandoned'
            THEN RAISE(ABORT, 'provider_attempt_legacy_recovery_only_supports_abandoned') END;
        END
      `)
      yield* tx.run("DROP TRIGGER session_tool_request_resolution_validate_insert")
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_resolution_validate_insert
        BEFORE INSERT ON session_tool_request_resolution
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_tool_request_receipt receipt
            WHERE receipt.receipt_id = NEW.receipt_id
              AND receipt.session_id = NEW.session_id
              AND receipt.assistant_message_id = NEW.assistant_message_id
              AND receipt.provider_state = NEW.expected_provider_state
              AND receipt.prompt_epoch = NEW.source_prompt_epoch
              AND receipt.prompt_window_id = NEW.source_window_id
              AND receipt.effective_history_hash = NEW.source_effective_history_hash
              AND COALESCE(receipt.final_request_hash, receipt.provider_request_hash, receipt.request_input_hash) = NEW.source_request_hash
              AND (
                receipt.provider_attempt_id IS NULL OR EXISTS (
                  SELECT 1
                  FROM session_provider_attempt_recovery_bridge bridge
                  WHERE bridge.resolution_id = NEW.resolution_id
                    AND bridge.receipt_id = NEW.receipt_id
                    AND bridge.attempt_id = receipt.provider_attempt_id
                )
              )
          ) THEN RAISE(ABORT, 'legacy_provider_resolution_receipt_binding_invalid') END;
          SELECT CASE WHEN NEW.legacy_activity_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM session_activity_progress progress
            JOIN session_legacy_activity activity ON activity.activity_id = progress.activity_id
            WHERE progress.provider_receipt_id = NEW.receipt_id
              AND progress.activity_id = NEW.legacy_activity_id
              AND activity.session_id = NEW.session_id
              AND progress.state = 'recovery_required'
              AND activity.state = 'recovery_required'
          ) THEN RAISE(ABORT, 'legacy_provider_resolution_activity_binding_invalid') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch source
            WHERE source.session_id = NEW.session_id
              AND source.epoch = NEW.source_prompt_epoch
              AND source.window_id = NEW.source_window_id
              AND source.state = 'retired'
              AND source.authority_state = 'recovery_required'
          ) THEN RAISE(ABORT, 'legacy_provider_resolution_source_binding_invalid') END;
          SELECT CASE WHEN NEW.successor_prompt_epoch <= NEW.source_prompt_epoch
            THEN RAISE(ABORT, 'legacy_provider_resolution_successor_not_newer') END;
          SELECT CASE WHEN NEW.successor_mutation_epoch != NEW.source_mutation_epoch + 1
            THEN RAISE(ABORT, 'legacy_provider_resolution_mutation_epoch_invalid') END;
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
