import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812120000_legacy_provider_recovery",
  up(tx) {
    return Effect.gen(function* () {
      // The original receipt table predated Session FK ownership. Rebuild it with its two FK
      // children detached so SQLite cannot cascade evidence away or retain references to a renamed
      // old table. The compaction trigger also references the receipt table from a different table;
      // detach it so Node SQLite can validate the schema while the receipt table is being renamed.
      // Historical orphan receipts are intentionally omitted from the rebuilt authority.
      yield* tx.run("DROP TRIGGER IF EXISTS compaction_run_continuation_response_validate")
      yield* tx.run(`
        CREATE TEMP TABLE legacy_provider_recovery_argument_receipt AS
        SELECT * FROM session_tool_argument_receipt
      `)
      yield* tx.run(`
        CREATE TEMP TABLE legacy_provider_recovery_activity_progress AS
        SELECT * FROM session_activity_progress
      `)
      yield* tx.run("DROP TABLE session_tool_argument_receipt")
      yield* tx.run("DROP TABLE session_activity_progress")
      yield* tx.run(`
        CREATE TABLE session_tool_request_receipt_rebuilt (
          receipt_id TEXT NOT NULL PRIMARY KEY,
          request_ordinal INTEGER NOT NULL CHECK (request_ordinal >= 1),
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          user_message_id TEXT NOT NULL,
          assistant_message_id TEXT,
          provider_attempt_id TEXT,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          protocol TEXT,
          registry_tool_ids TEXT NOT NULL,
          permission_filtered_tool_ids TEXT NOT NULL,
          final_offered_tool_ids TEXT NOT NULL,
          call_ids TEXT NOT NULL DEFAULT '[]',
          tool_definition_hash TEXT,
          tool_choice_mode TEXT,
          adapter_tool_capability TEXT,
          adapter_lowering_outcome TEXT,
          estimated_input_tokens INTEGER,
          physical_input_budget INTEGER,
          reserved_output_tokens INTEGER,
          safety_margin_tokens INTEGER,
          context_limit_provenance TEXT,
          request_state TEXT NOT NULL CHECK (request_state IN ('prepared','dispatched','rejected')),
          request_error_code TEXT,
          created_at INTEGER NOT NULL,
          prompt_epoch INTEGER,
          prompt_window_id TEXT,
          effective_history_hash TEXT,
          world_state_baseline_hash TEXT,
          prompt_cache_key TEXT,
          provider_request_hash TEXT,
          response_chain_reuse_decision TEXT,
          response_chain_refusal_reason TEXT,
          request_input_hash TEXT,
          final_request_hash TEXT,
          provider_state TEXT NOT NULL DEFAULT 'preparing',
          adapter_prepared_at INTEGER,
          dispatching_at INTEGER,
          streaming_at INTEGER,
          terminal_at INTEGER,
          response_fingerprint TEXT,
          owner_token TEXT
        )
      `)
      yield* tx.run(`
        INSERT INTO session_tool_request_receipt_rebuilt
        SELECT receipt.*
        FROM session_tool_request_receipt receipt
        JOIN session ON session.id = receipt.session_id
      `)
      yield* tx.run("DROP TABLE session_tool_request_receipt")
      yield* tx.run("ALTER TABLE session_tool_request_receipt_rebuilt RENAME TO session_tool_request_receipt")
      yield* tx.run(`
        CREATE UNIQUE INDEX session_tool_request_receipt_session_ordinal_idx
        ON session_tool_request_receipt(session_id, request_ordinal)
      `)
      yield* tx.run(`
        CREATE INDEX session_tool_request_receipt_session_idx
        ON session_tool_request_receipt(session_id, created_at)
      `)
      yield* tx.run(`
        CREATE INDEX session_tool_request_receipt_msg_idx
        ON session_tool_request_receipt(assistant_message_id)
      `)
      yield* tx.run(`
        CREATE INDEX session_tool_request_receipt_prompt_window_idx
        ON session_tool_request_receipt(session_id, prompt_epoch, prompt_window_id)
      `)
      yield* tx.run(`
        CREATE INDEX session_tool_request_receipt_provider_state_idx
        ON session_tool_request_receipt(session_id, provider_state, created_at)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_provider_transition
        BEFORE UPDATE OF provider_state ON session_tool_request_receipt
        WHEN NEW.provider_state != OLD.provider_state AND NOT (
          (OLD.provider_state = 'preparing' AND NEW.provider_state IN ('prepared', 'failed')) OR
          (OLD.provider_state = 'prepared' AND NEW.provider_state IN ('dispatching', 'failed')) OR
          (OLD.provider_state = 'dispatching' AND NEW.provider_state IN ('streaming', 'settled', 'failed', 'indeterminate_after_crash')) OR
          (OLD.provider_state = 'streaming' AND NEW.provider_state IN ('settled', 'failed', 'indeterminate_after_crash'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'illegal provider receipt transition');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_dispatch_guard
        BEFORE UPDATE OF provider_state ON session_tool_request_receipt
        WHEN NEW.provider_state = 'dispatching' AND (
          NEW.final_request_hash IS NULL OR NEW.adapter_prepared_at IS NULL OR
          NEW.prompt_epoch IS NULL OR NEW.prompt_window_id IS NULL OR
          NEW.effective_history_hash IS NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'provider dispatch requires final request authority');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_binding_immutable
        BEFORE UPDATE ON session_tool_request_receipt
        WHEN NEW.receipt_id != OLD.receipt_id
          OR NEW.request_ordinal != OLD.request_ordinal
          OR NEW.session_id != OLD.session_id
          OR NEW.user_message_id != OLD.user_message_id
          OR NEW.assistant_message_id IS NOT OLD.assistant_message_id
          OR NEW.provider_id != OLD.provider_id
          OR NEW.model_id != OLD.model_id
          OR NEW.protocol IS NOT OLD.protocol
          OR NEW.prompt_epoch IS NOT OLD.prompt_epoch
          OR NEW.prompt_window_id IS NOT OLD.prompt_window_id
          OR NEW.effective_history_hash IS NOT OLD.effective_history_hash
          OR NEW.world_state_baseline_hash IS NOT OLD.world_state_baseline_hash
          OR NEW.request_input_hash IS NOT OLD.request_input_hash
          OR NEW.owner_token IS NOT OLD.owner_token
          OR NEW.created_at != OLD.created_at
          OR (OLD.final_request_hash IS NOT NULL AND NEW.final_request_hash IS NOT OLD.final_request_hash)
          OR (OLD.prompt_cache_key IS NOT NULL AND NEW.prompt_cache_key IS NOT OLD.prompt_cache_key)
          OR (OLD.response_fingerprint IS NOT NULL AND NEW.response_fingerprint IS NOT OLD.response_fingerprint)
        BEGIN
          SELECT RAISE(ABORT, 'provider receipt binding is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_response_guard
        BEFORE UPDATE OF response_fingerprint ON session_tool_request_receipt
        WHEN NEW.response_fingerprint IS NOT OLD.response_fingerprint AND (
          OLD.response_fingerprint IS NOT NULL OR NEW.response_fingerprint IS NULL OR
          NEW.provider_state NOT IN ('settled', 'failed')
        )
        BEGIN
          SELECT RAISE(ABORT, 'provider response fingerprint requires terminal receipt');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_run_continuation_response_validate
        BEFORE UPDATE OF continuation_state ON compaction_run
        WHEN NEW.continuation_state IN ('settled', 'failed') AND NOT EXISTS (
          SELECT 1
          FROM session_tool_request_receipt receipt
          WHERE receipt.receipt_id = NEW.continuation_receipt_id
            AND receipt.response_fingerprint IS NOT NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'compaction continuation response is not durable');
        END
      `)
      yield* tx.run(`
        CREATE TABLE session_tool_argument_receipt (
          receipt_id TEXT NOT NULL,
          layer TEXT NOT NULL CHECK (layer IN ('raw_frame','ai_sdk_input','adapter_assembly','processor_decoded')),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          call_id TEXT,
          tool_name TEXT,
          event_type TEXT NOT NULL,
          payload_hash TEXT,
          payload_length INTEGER CHECK (payload_length IS NULL OR payload_length >= 0),
          payload_keys TEXT NOT NULL,
          unavailable_reason TEXT,
          created_at INTEGER NOT NULL,
          validation_outcome TEXT NOT NULL DEFAULT 'not_evaluated' CHECK (validation_outcome IN (
            'not_evaluated','schema_valid','schema_invalid','semantic_valid','semantic_invalid',
            'conflict','no_progress'
          )),
          PRIMARY KEY (receipt_id, layer, ordinal),
          FOREIGN KEY (receipt_id) REFERENCES session_tool_request_receipt(receipt_id) ON DELETE CASCADE,
          CHECK (call_id IS NULL OR length(trim(call_id)) > 0),
          CHECK (tool_name IS NULL OR length(trim(tool_name)) > 0),
          CHECK (
            (payload_hash IS NOT NULL AND length(payload_hash) = 64 AND payload_length IS NOT NULL AND unavailable_reason IS NULL) OR
            (payload_hash IS NULL AND payload_length IS NULL AND unavailable_reason IS NOT NULL AND length(trim(unavailable_reason)) > 0)
          )
        )
      `)
      yield* tx.run(`
        INSERT INTO session_tool_argument_receipt
        SELECT argument.*
        FROM legacy_provider_recovery_argument_receipt argument
        JOIN session_tool_request_receipt receipt ON receipt.receipt_id = argument.receipt_id
      `)
      yield* tx.run("DROP TABLE legacy_provider_recovery_argument_receipt")
      yield* tx.run(`
        CREATE INDEX session_tool_argument_receipt_call_idx
        ON session_tool_argument_receipt(receipt_id, call_id, layer, ordinal)
      `)
      yield* tx.run(`
        CREATE INDEX session_tool_argument_receipt_created_idx
        ON session_tool_argument_receipt(created_at)
      `)
      yield* tx.run(`
        CREATE TABLE session_activity_progress (
          activity_id TEXT NOT NULL REFERENCES session_legacy_activity(activity_id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          assistant_message_id TEXT NOT NULL UNIQUE REFERENCES message(id) ON DELETE CASCADE,
          text_part_id TEXT REFERENCES part(id) ON DELETE SET NULL,
          provider_receipt_id TEXT NOT NULL UNIQUE REFERENCES session_tool_request_receipt(receipt_id),
          state TEXT NOT NULL CHECK (state IN ('provisional', 'progress', 'final', 'interrupted', 'recovery_required')),
          finish_observed TEXT,
          response_fingerprint TEXT,
          created_at INTEGER NOT NULL,
          settled_at INTEGER,
          PRIMARY KEY (activity_id, revision),
          CHECK (
            (state = 'provisional' AND settled_at IS NULL AND response_fingerprint IS NULL) OR
            (state != 'provisional' AND settled_at IS NOT NULL)
          )
        )
      `)
      yield* tx.run(`
        INSERT INTO session_activity_progress
        SELECT progress.*
        FROM legacy_provider_recovery_activity_progress progress
        JOIN session_tool_request_receipt receipt ON receipt.receipt_id = progress.provider_receipt_id
      `)
      yield* tx.run("DROP TABLE legacy_provider_recovery_activity_progress")
      yield* tx.run(`
        CREATE TRIGGER session_activity_progress_validate_insert
        BEFORE INSERT ON session_activity_progress
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1
            FROM session_legacy_activity activity
            JOIN message assistant ON assistant.id = NEW.assistant_message_id
            JOIN session_tool_request_receipt receipt ON receipt.receipt_id = NEW.provider_receipt_id
            WHERE activity.activity_id = NEW.activity_id
              AND activity.state = 'active'
              AND assistant.session_id = activity.session_id
              AND receipt.session_id = activity.session_id
              AND receipt.assistant_message_id = NEW.assistant_message_id
          ) THEN RAISE(ABORT, 'activity progress ownership mismatch') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_progress_legal_update
        BEFORE UPDATE ON session_activity_progress
        WHEN NEW.activity_id != OLD.activity_id
          OR NEW.revision != OLD.revision
          OR NEW.assistant_message_id != OLD.assistant_message_id
          OR NEW.provider_receipt_id != OLD.provider_receipt_id
          OR NEW.created_at != OLD.created_at
          OR OLD.state != 'provisional'
          OR NEW.state NOT IN ('progress', 'final', 'interrupted', 'recovery_required')
          OR NEW.settled_at IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_activity_progress transition');
        END
      `)

      // SQLite cannot add a CHECK literal in place. Rebuild the PromptEpoch authority and its two
      // FK-owned child tables together so recovery is a first-class reason without cascading away
      // existing membership or World State rows.
      yield* tx.run("DROP TRIGGER IF EXISTS session_prompt_epoch_validate_insert")
      yield* tx.run("DROP TRIGGER IF EXISTS session_prompt_epoch_validate_update")
      yield* tx.run("DROP TRIGGER IF EXISTS session_prompt_epoch_message_validate_insert")
      yield* tx.run("DROP TRIGGER IF EXISTS session_prompt_epoch_message_validate_update")
      yield* tx.run("DROP TRIGGER IF EXISTS session_prompt_epoch_message_owner_immutable")
      yield* tx.run("DROP TRIGGER IF EXISTS session_history_state_ready_validate_insert")
      yield* tx.run("DROP TRIGGER IF EXISTS session_history_state_ready_validate_update")
      yield* tx.run("DROP TRIGGER IF EXISTS session_history_state_recovery_validate_insert")
      yield* tx.run("DROP TRIGGER IF EXISTS session_history_state_recovery_validate_update")
      yield* tx.run(`
        CREATE TEMP TABLE legacy_provider_recovery_epoch_message AS
        SELECT * FROM session_prompt_epoch_message
      `)
      yield* tx.run(`
        CREATE TEMP TABLE legacy_provider_recovery_world_state AS
        SELECT * FROM session_world_state_baseline
      `)
      yield* tx.run("DROP TABLE session_prompt_epoch_message")
      yield* tx.run("DROP TABLE session_world_state_baseline")
      yield* tx.run(`
        CREATE TABLE session_prompt_epoch_rebuilt (
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          epoch INTEGER NOT NULL CHECK (epoch >= 0),
          state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
          checkpoint_user_id TEXT,
          checkpoint_assistant_id TEXT,
          retained_tail_start_id TEXT,
          source_end_message_id TEXT,
          checkpoint_hash TEXT,
          reason TEXT NOT NULL CHECK (reason IN
            ('bootstrap', 'compaction', 'recovery', 'model', 'agent', 'directory',
             'workspace', 'tools', 'permission', 'renderer')),
          created_at INTEGER NOT NULL,
          retired_at INTEGER,
          projection_version INTEGER,
          canonicalization_version INTEGER,
          base_message_count INTEGER,
          effective_history_hash TEXT,
          first_window_id TEXT,
          previous_window_id TEXT,
          window_id TEXT,
          world_state_baseline_hash TEXT,
          authority_state TEXT CHECK (authority_state IN ('legacy_pending', 'ready', 'recovery_required')),
          recovery_reason TEXT,
          recovery_resolution_id TEXT,
          PRIMARY KEY (session_id, epoch)
        )
      `)
      yield* tx.run(`
        INSERT INTO session_prompt_epoch_rebuilt (
          session_id, epoch, state, checkpoint_user_id, checkpoint_assistant_id,
          retained_tail_start_id, source_end_message_id, checkpoint_hash, reason,
          created_at, retired_at, projection_version, canonicalization_version,
          base_message_count, effective_history_hash, first_window_id, previous_window_id,
          window_id, world_state_baseline_hash, authority_state, recovery_reason,
          recovery_resolution_id
        )
        SELECT
          session_id, epoch, state, checkpoint_user_id, checkpoint_assistant_id,
          retained_tail_start_id, source_end_message_id, checkpoint_hash, reason,
          created_at, retired_at, projection_version, canonicalization_version,
          base_message_count, effective_history_hash, first_window_id, previous_window_id,
          window_id, world_state_baseline_hash, authority_state, recovery_reason, NULL
        FROM session_prompt_epoch
      `)
      yield* tx.run("DROP TABLE session_prompt_epoch")
      yield* tx.run("ALTER TABLE session_prompt_epoch_rebuilt RENAME TO session_prompt_epoch")
      yield* tx.run(`
        CREATE UNIQUE INDEX session_prompt_epoch_active_idx
        ON session_prompt_epoch (session_id) WHERE state = 'active'
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_prompt_epoch_window_idx
        ON session_prompt_epoch (window_id) WHERE window_id IS NOT NULL
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_prompt_epoch_recovery_resolution_idx
        ON session_prompt_epoch (recovery_resolution_id)
        WHERE recovery_resolution_id IS NOT NULL
      `)
      yield* tx.run(`
        CREATE TABLE session_prompt_epoch_message (
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          prompt_epoch INTEGER NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
          PRIMARY KEY (session_id, prompt_epoch, ordinal),
          UNIQUE (session_id, prompt_epoch, message_id),
          FOREIGN KEY (session_id, prompt_epoch)
            REFERENCES session_prompt_epoch(session_id, epoch) ON DELETE CASCADE
        )
      `)
      yield* tx.run(`
        INSERT INTO session_prompt_epoch_message
        SELECT * FROM legacy_provider_recovery_epoch_message
      `)
      yield* tx.run("DROP TABLE legacy_provider_recovery_epoch_message")
      yield* tx.run(`
        CREATE INDEX session_prompt_epoch_message_lookup_idx
        ON session_prompt_epoch_message (session_id, prompt_epoch, message_id)
      `)
      yield* tx.run(`
        CREATE TABLE session_world_state_baseline (
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          prompt_epoch INTEGER NOT NULL,
          section_id TEXT NOT NULL,
          snapshot TEXT NOT NULL,
          fragment TEXT NOT NULL,
          fragment_hash TEXT NOT NULL,
          provenance TEXT NOT NULL CHECK (provenance IN
            ('native', 'fork_rebuilt', 'legacy_migration', 'recovery_copied', 'recovery_recollected')),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, prompt_epoch, section_id),
          FOREIGN KEY (session_id, prompt_epoch)
            REFERENCES session_prompt_epoch(session_id, epoch) ON DELETE CASCADE
        )
      `)
      yield* tx.run(`
        INSERT INTO session_world_state_baseline
        SELECT * FROM legacy_provider_recovery_world_state
      `)
      yield* tx.run("DROP TABLE legacy_provider_recovery_world_state")
      yield* tx.run(`
        CREATE INDEX session_world_state_baseline_epoch_idx
        ON session_world_state_baseline (session_id, prompt_epoch)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_message_validate_insert
        BEFORE INSERT ON session_prompt_epoch_message
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND epoch = NEW.prompt_epoch
          ) THEN RAISE(ABORT, 'prompt_epoch_message_epoch_missing') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM message WHERE id = NEW.message_id AND session_id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_message_cross_session') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_message_validate_update
        BEFORE UPDATE ON session_prompt_epoch_message
        BEGIN
          SELECT CASE WHEN NEW.session_id IS NOT OLD.session_id OR
            NEW.prompt_epoch IS NOT OLD.prompt_epoch OR NEW.ordinal IS NOT OLD.ordinal OR
            NEW.message_id IS NOT OLD.message_id
          THEN RAISE(ABORT, 'prompt_epoch_message_binding_immutable') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_message_owner_immutable
        BEFORE UPDATE OF session_id ON message
        WHEN EXISTS (
          SELECT 1 FROM session_prompt_epoch
          WHERE checkpoint_user_id = OLD.id OR checkpoint_assistant_id = OLD.id OR
            retained_tail_start_id = OLD.id OR source_end_message_id = OLD.id
        )
        BEGIN
          SELECT RAISE(ABORT, 'prompt_epoch_referenced_message_owner_immutable');
        END
      `)

      yield* tx.run(`
        CREATE TRIGGER session_history_state_ready_validate_insert
        BEFORE INSERT ON session_history_state
        WHEN NEW.state = 'ready'
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND state = 'active' AND authority_state = 'ready'
          ) THEN RAISE(ABORT, 'session_history_ready_without_authority') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_history_state_ready_validate_update
        BEFORE UPDATE ON session_history_state
        WHEN NEW.state = 'ready'
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND state = 'active' AND authority_state = 'ready'
          ) THEN RAISE(ABORT, 'session_history_ready_without_authority') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_history_state_recovery_validate_insert
        BEFORE INSERT ON session_history_state
        WHEN NEW.state = 'recovery_required'
        BEGIN
          SELECT CASE WHEN NEW.reason IS NULL
            THEN RAISE(ABORT, 'session_history_recovery_without_reason') END;
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND state = 'active' AND authority_state != 'recovery_required'
          ) THEN RAISE(ABORT, 'session_history_recovery_without_quarantined_authority') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_history_state_recovery_validate_update
        BEFORE UPDATE ON session_history_state
        WHEN NEW.state = 'recovery_required'
        BEGIN
          SELECT CASE WHEN NEW.reason IS NULL
            THEN RAISE(ABORT, 'session_history_recovery_without_reason') END;
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND state = 'active' AND authority_state != 'recovery_required'
          ) THEN RAISE(ABORT, 'session_history_recovery_without_quarantined_authority') END;
        END
      `)

      yield* tx.run(`
        CREATE TABLE session_tool_request_resolution_command (
          command_id TEXT NOT NULL PRIMARY KEY,
          request_hash TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          receipt_id TEXT NOT NULL REFERENCES session_tool_request_receipt(receipt_id) ON DELETE CASCADE,
          result_resolution_id TEXT,
          created_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_tool_request_resolution_command_session_idx
        ON session_tool_request_resolution_command (session_id, created_at)
      `)
      yield* tx.run(`
        CREATE TABLE session_tool_request_resolution (
          resolution_id TEXT NOT NULL PRIMARY KEY,
          receipt_id TEXT NOT NULL UNIQUE REFERENCES session_tool_request_receipt(receipt_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          legacy_activity_id TEXT,
          assistant_message_id TEXT NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
          source_prompt_epoch INTEGER NOT NULL,
          source_window_id TEXT NOT NULL,
          source_effective_history_hash TEXT NOT NULL,
          source_request_hash TEXT NOT NULL,
          source_mutation_epoch INTEGER NOT NULL,
          expected_provider_state TEXT NOT NULL CHECK (expected_provider_state = 'indeterminate_after_crash'),
          decision TEXT NOT NULL CHECK (decision = 'abandoned'),
          actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'administrator', 'system-verifier')),
          actor_id TEXT NOT NULL,
          reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
          risk_acknowledged INTEGER NOT NULL CHECK (risk_acknowledged = 0),
          safe_end_message_id TEXT REFERENCES message(id) ON DELETE RESTRICT,
          safe_history_hash TEXT NOT NULL,
          safe_message_ids TEXT NOT NULL,
          ambiguity_message_id TEXT NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
          physical_message_high_water TEXT NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
          successor_prompt_epoch INTEGER NOT NULL,
          successor_window_id TEXT NOT NULL,
          successor_history_hash TEXT NOT NULL,
          successor_mutation_epoch INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id, source_prompt_epoch)
            REFERENCES session_prompt_epoch(session_id, epoch)
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_tool_request_resolution_session_idx
        ON session_tool_request_resolution (session_id, created_at)
      `)
      yield* tx.run(`
        CREATE TABLE session_prompt_epoch_recovery (
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          prompt_epoch INTEGER NOT NULL,
          resolution_id TEXT NOT NULL UNIQUE,
          source_prompt_epoch INTEGER NOT NULL,
          source_mutation_epoch INTEGER NOT NULL,
          successor_mutation_epoch INTEGER NOT NULL,
          ambiguity_message_id TEXT NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
          physical_message_high_water TEXT NOT NULL REFERENCES message(id) ON DELETE RESTRICT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, prompt_epoch),
          FOREIGN KEY (session_id, prompt_epoch)
            REFERENCES session_prompt_epoch(session_id, epoch) ON DELETE CASCADE,
          FOREIGN KEY (session_id, source_prompt_epoch)
            REFERENCES session_prompt_epoch(session_id, epoch),
          FOREIGN KEY (resolution_id)
            REFERENCES session_tool_request_resolution(resolution_id)
        )
      `)

      yield* tx.run(`
        CREATE TRIGGER session_tool_request_resolution_validate_insert
        BEFORE INSERT ON session_tool_request_resolution
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_tool_request_receipt receipt
            WHERE receipt.receipt_id = NEW.receipt_id
              AND receipt.session_id = NEW.session_id
              AND receipt.assistant_message_id = NEW.assistant_message_id
              AND receipt.provider_attempt_id IS NULL
              AND receipt.provider_state = NEW.expected_provider_state
              AND receipt.prompt_epoch = NEW.source_prompt_epoch
              AND receipt.prompt_window_id = NEW.source_window_id
              AND receipt.effective_history_hash = NEW.source_effective_history_hash
              AND COALESCE(receipt.final_request_hash, receipt.provider_request_hash, receipt.request_input_hash) = NEW.source_request_hash
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
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_resolution_command_validate_insert
        BEFORE INSERT ON session_tool_request_resolution_command
        BEGIN
          SELECT CASE WHEN NEW.result_resolution_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM session_tool_request_resolution resolution
            WHERE resolution.resolution_id = NEW.result_resolution_id
              AND resolution.session_id = NEW.session_id
              AND resolution.receipt_id = NEW.receipt_id
          ) THEN RAISE(ABORT, 'legacy_provider_resolution_command_result_invalid') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_resolution_immutable_update
        BEFORE UPDATE ON session_tool_request_resolution
        BEGIN
          SELECT RAISE(ABORT, 'legacy_provider_resolution_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_resolution_immutable_delete
        BEFORE DELETE ON session_tool_request_resolution
        WHEN EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'legacy_provider_resolution_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_resolution_command_immutable_update
        BEFORE UPDATE ON session_tool_request_resolution_command
        BEGIN
          SELECT CASE WHEN OLD.result_resolution_id IS NOT NULL OR
            NEW.command_id IS NOT OLD.command_id OR NEW.request_hash IS NOT OLD.request_hash OR
            NEW.session_id IS NOT OLD.session_id OR NEW.receipt_id IS NOT OLD.receipt_id OR
            NEW.created_at IS NOT OLD.created_at OR NEW.result_resolution_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM session_tool_request_resolution resolution
              WHERE resolution.resolution_id = NEW.result_resolution_id
                AND resolution.session_id = NEW.session_id
                AND resolution.receipt_id = NEW.receipt_id
            )
          THEN RAISE(ABORT, 'legacy_provider_resolution_command_immutable') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_resolution_command_immutable_delete
        BEFORE DELETE ON session_tool_request_resolution_command
        WHEN EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'legacy_provider_resolution_command_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_recovery_validate_insert
        BEFORE INSERT ON session_prompt_epoch_recovery
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch successor
            WHERE successor.session_id = NEW.session_id
              AND successor.epoch = NEW.prompt_epoch
              AND successor.reason = 'recovery'
              AND successor.authority_state = 'ready'
              AND successor.recovery_resolution_id = NEW.resolution_id
              AND successor.source_end_message_id = NEW.physical_message_high_water
          ) THEN RAISE(ABORT, 'prompt_epoch_recovery_successor_invalid') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch source
            WHERE source.session_id = NEW.session_id
              AND source.epoch = NEW.source_prompt_epoch
              AND source.state = 'retired'
              AND source.authority_state = 'recovery_required'
          ) THEN RAISE(ABORT, 'prompt_epoch_recovery_source_invalid') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_tool_request_resolution resolution
            WHERE resolution.resolution_id = NEW.resolution_id
              AND resolution.session_id = NEW.session_id
              AND resolution.source_prompt_epoch = NEW.source_prompt_epoch
              AND resolution.source_mutation_epoch = NEW.source_mutation_epoch
          ) THEN RAISE(ABORT, 'prompt_epoch_recovery_resolution_source_invalid') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_tool_request_resolution resolution
            JOIN session_prompt_epoch successor
              ON successor.session_id = NEW.session_id AND successor.epoch = NEW.prompt_epoch
            WHERE resolution.resolution_id = NEW.resolution_id
              AND resolution.session_id = NEW.session_id
              AND resolution.successor_prompt_epoch = NEW.prompt_epoch
              AND resolution.successor_window_id = successor.window_id
              AND resolution.successor_history_hash = successor.effective_history_hash
              AND resolution.safe_history_hash = successor.effective_history_hash
              AND resolution.successor_mutation_epoch = NEW.successor_mutation_epoch
          ) THEN RAISE(ABORT, 'prompt_epoch_recovery_resolution_successor_invalid') END;
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_tool_request_resolution resolution
            WHERE resolution.resolution_id = NEW.resolution_id
              AND resolution.ambiguity_message_id = NEW.ambiguity_message_id
              AND resolution.physical_message_high_water = NEW.physical_message_high_water
          ) THEN RAISE(ABORT, 'prompt_epoch_recovery_resolution_boundary_invalid') END;
          SELECT CASE WHEN NEW.successor_mutation_epoch != NEW.source_mutation_epoch + 1
            THEN RAISE(ABORT, 'prompt_epoch_recovery_mutation_epoch_invalid') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_recovery_immutable_update
        BEFORE UPDATE ON session_prompt_epoch_recovery
        BEGIN
          SELECT RAISE(ABORT, 'prompt_epoch_recovery_binding_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_recovery_immutable_delete
        BEFORE DELETE ON session_prompt_epoch_recovery
        WHEN EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'prompt_epoch_recovery_binding_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_parent_cleanup
        AFTER DELETE ON session
        BEGIN
          DELETE FROM session_tool_request_receipt WHERE session_id = OLD.id;
        END
      `)

      yield* tx.run("DROP TRIGGER IF EXISTS session_prompt_epoch_validate_insert")
      yield* tx.run("DROP TRIGGER IF EXISTS session_prompt_epoch_validate_update")
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_validate_insert
        BEFORE INSERT ON session_prompt_epoch
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session WHERE id = NEW.session_id
          ) THEN RAISE(ABORT, 'prompt_epoch_session_missing') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND
            NEW.checkpoint_user_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM message WHERE id = NEW.checkpoint_user_id AND session_id = NEW.session_id
            ) THEN RAISE(ABORT, 'prompt_epoch_checkpoint_user_cross_session') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND
            NEW.checkpoint_assistant_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM message WHERE id = NEW.checkpoint_assistant_id AND session_id = NEW.session_id
            ) THEN RAISE(ABORT, 'prompt_epoch_checkpoint_assistant_cross_session') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND
            NEW.retained_tail_start_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM message WHERE id = NEW.retained_tail_start_id AND session_id = NEW.session_id
            ) THEN RAISE(ABORT, 'prompt_epoch_retained_tail_cross_session') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND
            NEW.source_end_message_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM message WHERE id = NEW.source_end_message_id AND session_id = NEW.session_id
            ) THEN RAISE(ABORT, 'prompt_epoch_source_end_cross_session') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND
            NEW.previous_window_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM session_prompt_epoch
            WHERE session_id = NEW.session_id AND window_id = NEW.previous_window_id
          ) THEN RAISE(ABORT, 'prompt_epoch_previous_window_cross_session') END;
          SELECT CASE WHEN NEW.authority_state = 'ready' AND (
            NEW.projection_version IS NULL OR NEW.canonicalization_version IS NULL OR
            NEW.base_message_count IS NULL OR NEW.base_message_count < 0 OR
            NEW.effective_history_hash IS NULL OR NEW.first_window_id IS NULL OR NEW.window_id IS NULL OR
            (NEW.recovery_resolution_id IS NOT NULL AND NEW.world_state_baseline_hash IS NULL) OR
            (NEW.recovery_resolution_id IS NULL AND NEW.epoch > 0 AND (
              NEW.checkpoint_user_id IS NULL OR NEW.checkpoint_assistant_id IS NULL OR
              NEW.checkpoint_hash IS NULL OR NEW.world_state_baseline_hash IS NULL
            ))
          ) THEN RAISE(ABORT, 'prompt_epoch_ready_binding_incomplete') END;
          SELECT CASE WHEN NEW.recovery_resolution_id IS NOT NULL AND (
            NEW.authority_state != 'ready' OR NEW.checkpoint_user_id IS NOT NULL OR
            NEW.checkpoint_assistant_id IS NOT NULL OR NEW.retained_tail_start_id IS NOT NULL OR
            NEW.reason != 'recovery'
          ) THEN RAISE(ABORT, 'prompt_epoch_recovery_binding_invalid') END;
          SELECT CASE WHEN NEW.recovery_resolution_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM session_tool_request_resolution resolution
            WHERE resolution.resolution_id = NEW.recovery_resolution_id
              AND resolution.session_id = NEW.session_id
              AND resolution.successor_prompt_epoch = NEW.epoch
          ) THEN RAISE(ABORT, 'prompt_epoch_recovery_resolution_invalid') END;
          SELECT CASE WHEN NEW.reason = 'recovery' AND NEW.recovery_resolution_id IS NULL
            THEN RAISE(ABORT, 'prompt_epoch_recovery_resolution_missing') END;
          SELECT CASE WHEN NEW.authority_state = 'recovery_required' AND NEW.recovery_reason IS NULL
            THEN RAISE(ABORT, 'prompt_epoch_recovery_without_reason') END;
          SELECT CASE WHEN NEW.authority_state != 'recovery_required' AND NEW.recovery_reason IS NOT NULL
            THEN RAISE(ABORT, 'prompt_epoch_nonrecovery_with_reason') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_prompt_epoch_validate_update
        BEFORE UPDATE ON session_prompt_epoch
        BEGIN
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND
            NEW.checkpoint_user_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM message WHERE id = NEW.checkpoint_user_id AND session_id = NEW.session_id
            ) THEN RAISE(ABORT, 'prompt_epoch_checkpoint_user_cross_session') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND
            NEW.checkpoint_assistant_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM message WHERE id = NEW.checkpoint_assistant_id AND session_id = NEW.session_id
            ) THEN RAISE(ABORT, 'prompt_epoch_checkpoint_assistant_cross_session') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND
            NEW.retained_tail_start_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM message WHERE id = NEW.retained_tail_start_id AND session_id = NEW.session_id
            ) THEN RAISE(ABORT, 'prompt_epoch_retained_tail_cross_session') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND
            NEW.source_end_message_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM message WHERE id = NEW.source_end_message_id AND session_id = NEW.session_id
            ) THEN RAISE(ABORT, 'prompt_epoch_source_end_cross_session') END;
          SELECT CASE WHEN NEW.authority_state IS NOT 'recovery_required' AND
            NEW.previous_window_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM session_prompt_epoch
              WHERE session_id = NEW.session_id AND window_id = NEW.previous_window_id
            ) THEN RAISE(ABORT, 'prompt_epoch_previous_window_cross_session') END;
          SELECT CASE WHEN OLD.authority_state = 'ready' AND (
            NEW.session_id IS NOT OLD.session_id OR NEW.epoch IS NOT OLD.epoch OR
            NEW.checkpoint_user_id IS NOT OLD.checkpoint_user_id OR
            NEW.checkpoint_assistant_id IS NOT OLD.checkpoint_assistant_id OR
            NEW.retained_tail_start_id IS NOT OLD.retained_tail_start_id OR
            NEW.source_end_message_id IS NOT OLD.source_end_message_id OR
            NEW.checkpoint_hash IS NOT OLD.checkpoint_hash OR
            NEW.projection_version IS NOT OLD.projection_version OR
            NEW.canonicalization_version IS NOT OLD.canonicalization_version OR
            NEW.base_message_count IS NOT OLD.base_message_count OR
            NEW.effective_history_hash IS NOT OLD.effective_history_hash OR
            NEW.first_window_id IS NOT OLD.first_window_id OR
            NEW.previous_window_id IS NOT OLD.previous_window_id OR
            NEW.window_id IS NOT OLD.window_id OR
            NEW.world_state_baseline_hash IS NOT OLD.world_state_baseline_hash OR
            NEW.recovery_resolution_id IS NOT OLD.recovery_resolution_id OR NEW.reason IS NOT OLD.reason
          ) THEN RAISE(ABORT, 'prompt_epoch_ready_binding_immutable') END;
          SELECT CASE WHEN OLD.authority_state = 'recovery_required' AND NEW.authority_state != 'recovery_required'
            THEN RAISE(ABORT, 'prompt_epoch_recovery_state_immutable') END;
          SELECT CASE WHEN OLD.authority_state = 'ready' AND NEW.authority_state NOT IN ('ready', 'recovery_required')
            THEN RAISE(ABORT, 'prompt_epoch_invalid_authority_transition') END;
          SELECT CASE WHEN NEW.authority_state = 'ready' AND (
            NEW.projection_version IS NULL OR NEW.canonicalization_version IS NULL OR
            NEW.base_message_count IS NULL OR NEW.base_message_count < 0 OR
            NEW.effective_history_hash IS NULL OR NEW.first_window_id IS NULL OR NEW.window_id IS NULL OR
            (NEW.recovery_resolution_id IS NOT NULL AND NEW.world_state_baseline_hash IS NULL) OR
            (NEW.recovery_resolution_id IS NULL AND NEW.epoch > 0 AND (
              NEW.checkpoint_user_id IS NULL OR NEW.checkpoint_assistant_id IS NULL OR
              NEW.checkpoint_hash IS NULL OR NEW.world_state_baseline_hash IS NULL
            ))
          ) THEN RAISE(ABORT, 'prompt_epoch_ready_binding_incomplete') END;
          SELECT CASE WHEN NEW.recovery_resolution_id IS NOT NULL AND (
            NEW.authority_state != 'ready' OR NEW.checkpoint_user_id IS NOT NULL OR
            NEW.checkpoint_assistant_id IS NOT NULL OR NEW.retained_tail_start_id IS NOT NULL OR
            NEW.reason != 'recovery'
          ) THEN RAISE(ABORT, 'prompt_epoch_recovery_binding_invalid') END;
          SELECT CASE WHEN NEW.recovery_resolution_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM session_tool_request_resolution resolution
            WHERE resolution.resolution_id = NEW.recovery_resolution_id
              AND resolution.session_id = NEW.session_id
              AND resolution.successor_prompt_epoch = NEW.epoch
          ) THEN RAISE(ABORT, 'prompt_epoch_recovery_resolution_invalid') END;
          SELECT CASE WHEN NEW.reason = 'recovery' AND NEW.recovery_resolution_id IS NULL
            THEN RAISE(ABORT, 'prompt_epoch_recovery_resolution_missing') END;
          SELECT CASE WHEN NEW.authority_state = 'recovery_required' AND NEW.recovery_reason IS NULL
            THEN RAISE(ABORT, 'prompt_epoch_recovery_without_reason') END;
          SELECT CASE WHEN NEW.authority_state != 'recovery_required' AND NEW.recovery_reason IS NOT NULL
            THEN RAISE(ABORT, 'prompt_epoch_nonrecovery_with_reason') END;
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
