import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726070000_context_activity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_activity (
          activity_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          trigger_input_id TEXT NOT NULL REFERENCES session_input(id),
          delivery TEXT NOT NULL CHECK (delivery IN ('steer', 'queue', 'goal_steer')),
          state TEXT NOT NULL CHECK (state IN ('active', 'settled', 'failed', 'interrupted')),
          created_at INTEGER NOT NULL,
          settled_at INTEGER,
          UNIQUE (session_id, ordinal)
        )
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX session_activity_active_idx ON session_activity(session_id) WHERE state = 'active'`,
      )
      yield* tx.run(`
        CREATE TRIGGER session_activity_legal_update
        BEFORE UPDATE ON session_activity
        WHEN NEW.activity_id != OLD.activity_id
          OR NEW.session_id != OLD.session_id
          OR NEW.ordinal != OLD.ordinal
          OR NEW.trigger_input_id != OLD.trigger_input_id
          OR NEW.delivery != OLD.delivery
          OR NEW.created_at != OLD.created_at
          OR OLD.state != 'active'
          OR NEW.state NOT IN ('settled', 'failed', 'interrupted')
          OR NEW.settled_at IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_activity transition');
        END
      `)
      yield* tx.run(`
        CREATE TABLE session_activity_input (
          activity_id TEXT NOT NULL REFERENCES session_activity(activity_id) ON DELETE CASCADE,
          input_id TEXT NOT NULL UNIQUE REFERENCES session_input(id),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          admitted_seq INTEGER NOT NULL CHECK (admitted_seq >= 0),
          role TEXT NOT NULL CHECK (role IN ('trigger', 'steer')),
          promoted_at INTEGER NOT NULL,
          PRIMARY KEY (activity_id, input_id),
          UNIQUE (activity_id, ordinal)
        )
      `)
      yield* tx.run(`
        CREATE TABLE session_context_selection (
          selection_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          activity_id TEXT NOT NULL REFERENCES session_activity(activity_id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          trigger_input_id TEXT NOT NULL REFERENCES session_input(id),
          location_key TEXT NOT NULL,
          query_fingerprint TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 0),
          execution_fingerprint TEXT NOT NULL,
          selected_source_fingerprint TEXT NOT NULL,
          observed_location_mutation_epoch INTEGER NOT NULL CHECK (observed_location_mutation_epoch >= 0),
          next_revalidation_at INTEGER NOT NULL,
          graph_revisions TEXT NOT NULL,
          graph_statuses TEXT NOT NULL,
          selected_refs TEXT NOT NULL,
          projection TEXT NOT NULL,
          projection_hash TEXT NOT NULL,
          token_count INTEGER NOT NULL CHECK (token_count >= 0),
          artifact_write_status TEXT NOT NULL CHECK (artifact_write_status IN ('available', 'degraded_unavailable')),
          artifact_ref TEXT,
          inline_audit TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE (session_id, activity_id, revision),
          CHECK (
            (artifact_write_status = 'available' AND artifact_ref IS NOT NULL AND inline_audit IS NULL) OR
            (artifact_write_status = 'degraded_unavailable' AND artifact_ref IS NULL AND inline_audit IS NOT NULL)
          )
        )
      `)
      yield* tx.run(
        `CREATE INDEX session_context_selection_activity_idx ON session_context_selection(session_id, activity_id, created_at)`,
      )
      yield* tx.run(`
        CREATE TRIGGER session_context_selection_immutable
        BEFORE UPDATE ON session_context_selection
        BEGIN
          SELECT RAISE(ABORT, 'session_context_selection is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TABLE session_context_selection_input (
          selection_id TEXT NOT NULL REFERENCES session_context_selection(selection_id) ON DELETE CASCADE,
          input_id TEXT NOT NULL REFERENCES session_input(id),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          PRIMARY KEY (selection_id, input_id),
          UNIQUE (input_id),
          UNIQUE (selection_id, ordinal)
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_context_selection_input_immutable
        BEFORE UPDATE ON session_context_selection_input
        BEGIN
          SELECT RAISE(ABORT, 'session_context_selection_input is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TABLE session_context_validation (
          validation_id TEXT PRIMARY KEY,
          selection_id TEXT NOT NULL REFERENCES session_context_selection(selection_id) ON DELETE CASCADE,
          provider_turn_seq INTEGER NOT NULL CHECK (provider_turn_seq >= 0),
          authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 0),
          egress_epoch INTEGER NOT NULL CHECK (egress_epoch >= 0),
          observed_location_mutation_epoch INTEGER NOT NULL CHECK (observed_location_mutation_epoch >= 0),
          selected_source_fingerprint TEXT NOT NULL,
          validated_at INTEGER NOT NULL,
          valid_until INTEGER NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('valid', 'invalidated', 'denied', 'timeout')),
          reason_code TEXT NOT NULL,
          CHECK (outcome != 'valid' OR valid_until > validated_at)
        )
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX session_context_validation_observation_idx ON session_context_validation(selection_id, provider_turn_seq, validated_at)`,
      )
      yield* tx.run(
        `CREATE INDEX session_context_validation_lookup_idx ON session_context_validation(selection_id, provider_turn_seq, validated_at)`,
      )
      yield* tx.run(`
        CREATE TRIGGER session_context_validation_immutable
        BEFORE UPDATE ON session_context_validation
        BEGIN
          SELECT RAISE(ABORT, 'session_context_validation is append-only');
        END
      `)
      yield* tx.run(`
        CREATE TABLE session_provider_attempt (
          attempt_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          activity_id TEXT NOT NULL REFERENCES session_activity(activity_id) ON DELETE CASCADE,
          provider_turn_seq INTEGER NOT NULL CHECK (provider_turn_seq >= 0),
          selection_id TEXT NOT NULL REFERENCES session_context_selection(selection_id),
          projection_hash TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          parent_attempt_id TEXT REFERENCES session_provider_attempt(attempt_id),
          idempotency_key TEXT,
          state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatching', 'streaming', 'settled', 'failed', 'indeterminate_after_crash', 'resolved_abandoned', 'resolved_settled', 'resolved_replayed')),
          created_at INTEGER NOT NULL,
          first_event_at INTEGER,
          settled_at INTEGER,
          error_code TEXT,
          UNIQUE (session_id, provider_turn_seq)
        )
      `)
      yield* tx.run(
        `CREATE INDEX session_provider_attempt_activity_idx ON session_provider_attempt(session_id, activity_id, state)`,
      )
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_legal_update
        BEFORE UPDATE ON session_provider_attempt
        WHEN NEW.attempt_id != OLD.attempt_id
          OR NEW.session_id != OLD.session_id
          OR NEW.activity_id != OLD.activity_id
          OR NEW.provider_turn_seq != OLD.provider_turn_seq
          OR NEW.selection_id != OLD.selection_id
          OR NEW.projection_hash != OLD.projection_hash
          OR NEW.request_hash != OLD.request_hash
          OR NEW.provider_id != OLD.provider_id
          OR NEW.parent_attempt_id IS NOT OLD.parent_attempt_id
          OR NEW.idempotency_key IS NOT OLD.idempotency_key
          OR NEW.created_at != OLD.created_at
          OR (NEW.first_event_at IS NOT OLD.first_event_at AND NOT (OLD.state = 'dispatching' AND NEW.state = 'streaming' AND OLD.first_event_at IS NULL AND NEW.first_event_at IS NOT NULL))
          OR (NEW.error_code IS NOT OLD.error_code AND NEW.state NOT IN ('failed', 'indeterminate_after_crash'))
          OR NOT (
            (OLD.state = 'prepared' AND NEW.state = 'dispatching' AND NEW.first_event_at IS NULL AND NEW.settled_at IS NULL) OR
            (OLD.state = 'dispatching' AND NEW.state = 'streaming' AND NEW.first_event_at IS NOT NULL AND NEW.settled_at IS NULL) OR
            (OLD.state IN ('dispatching', 'streaming') AND NEW.state IN ('settled', 'failed') AND NEW.settled_at IS NOT NULL) OR
            (OLD.state IN ('dispatching', 'streaming') AND NEW.state = 'indeterminate_after_crash' AND NEW.settled_at IS NULL) OR
            (OLD.state = 'indeterminate_after_crash' AND NEW.state IN ('resolved_abandoned', 'resolved_settled', 'resolved_replayed') AND NEW.settled_at IS NOT NULL)
          )
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_provider_attempt transition');
        END
      `)
      yield* tx.run(`
        CREATE TABLE session_provider_attempt_resolution (
          resolution_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL UNIQUE REFERENCES session_provider_attempt(attempt_id),
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
        CREATE TRIGGER session_provider_attempt_resolution_immutable
        BEFORE UPDATE ON session_provider_attempt_resolution
        BEGIN
          SELECT RAISE(ABORT, 'session_provider_attempt_resolution is append-only');
        END
      `)
      yield* tx.run(`
        CREATE TABLE context_artifact (
          artifact_id TEXT PRIMARY KEY,
          security_namespace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          selection_id TEXT NOT NULL,
          artifact_ref TEXT NOT NULL,
          schema_version INTEGER NOT NULL CHECK (schema_version > 0),
          content_hash TEXT NOT NULL,
          authorization_fingerprint TEXT NOT NULL,
          encryption_key_id TEXT NOT NULL,
          iv BLOB,
          ciphertext BLOB,
          auth_tag BLOB,
          original_size INTEGER NOT NULL CHECK (original_size >= 0),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          deleted_at INTEGER,
          delete_reason TEXT,
          UNIQUE (security_namespace_id, session_id, selection_id, content_hash),
          CHECK (
            (deleted_at IS NULL AND delete_reason IS NULL AND iv IS NOT NULL AND ciphertext IS NOT NULL AND auth_tag IS NOT NULL) OR
            (deleted_at IS NOT NULL AND delete_reason IS NOT NULL AND iv IS NULL AND ciphertext IS NULL AND auth_tag IS NULL)
          )
        )
      `)
      yield* tx.run(
        `CREATE INDEX context_artifact_session_retention_idx ON context_artifact(security_namespace_id, session_id, expires_at)`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
