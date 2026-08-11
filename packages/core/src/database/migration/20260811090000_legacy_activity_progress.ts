import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260811090000_legacy_activity_progress",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_activity_admission (
          admission_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          source_kind TEXT NOT NULL CHECK (source_kind IN ('legacy_intent', 'session_input')),
          legacy_intent_id TEXT UNIQUE REFERENCES session_intent(intent_id),
          session_input_id TEXT UNIQUE REFERENCES session_input(id),
          admitted_message_id TEXT NOT NULL,
          delivery TEXT NOT NULL CHECK (delivery IN ('turn', 'steer', 'queue', 'goal_steer')),
          payload_fingerprint_kind TEXT NOT NULL CHECK (payload_fingerprint_kind IN ('payload_hash', 'source_identity')),
          payload_fingerprint TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          CHECK (
            (source_kind = 'legacy_intent' AND legacy_intent_id IS NOT NULL AND session_input_id IS NULL) OR
            (source_kind = 'session_input' AND session_input_id IS NOT NULL AND legacy_intent_id IS NULL)
          )
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_admission_validate_insert
        BEFORE INSERT ON session_activity_admission
        BEGIN
          SELECT CASE WHEN NEW.source_kind = 'legacy_intent' AND NOT EXISTS (
            SELECT 1 FROM session_intent
            WHERE intent_id = NEW.legacy_intent_id
              AND session_id = NEW.session_id
              AND admitted_message_id = NEW.admitted_message_id
              AND delivery = NEW.delivery
              AND NEW.payload_fingerprint_kind = 'payload_hash'
              AND selected_payload_hash = NEW.payload_fingerprint
              AND state = 'admitted'
          ) THEN RAISE(ABORT, 'legacy activity admission does not match admitted intent') END;
          SELECT CASE WHEN NEW.source_kind = 'session_input' AND NOT EXISTS (
            SELECT 1 FROM session_input
            WHERE id = NEW.session_input_id
              AND session_id = NEW.session_id
              AND id = NEW.admitted_message_id
              AND delivery = NEW.delivery
          ) THEN RAISE(ABORT, 'v2 activity admission does not match session input') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_admission_immutable
        BEFORE UPDATE ON session_activity_admission
        BEGIN
          SELECT RAISE(ABORT, 'session_activity_admission is immutable');
        END
      `)
      yield* tx.run(`
        INSERT INTO session_activity_admission (
          admission_id, session_id, source_kind, session_input_id, admitted_message_id,
          delivery, payload_fingerprint_kind, payload_fingerprint, created_at
        )
        SELECT
          'v2:' || input.id,
          input.session_id,
          'session_input',
          input.id,
          input.id,
          input.delivery,
          'source_identity',
          'session-input:' || input.id,
          input.time_created
        FROM session_input input
        WHERE EXISTS (
          SELECT 1 FROM session_activity activity WHERE activity.trigger_input_id = input.id
        )
      `)
      yield* tx.run(`
        CREATE TABLE session_legacy_activity (
          activity_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          trigger_admission_id TEXT NOT NULL UNIQUE REFERENCES session_activity_admission(admission_id),
          state TEXT NOT NULL CHECK (state IN ('active', 'settled', 'failed', 'interrupted', 'recovery_required')),
          terminal_reason TEXT,
          created_at INTEGER NOT NULL,
          settled_at INTEGER,
          UNIQUE (session_id, ordinal),
          CHECK (
            (state = 'active' AND settled_at IS NULL AND terminal_reason IS NULL) OR
            (state != 'active' AND settled_at IS NOT NULL AND terminal_reason IS NOT NULL)
          )
        )
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_legacy_activity_active_idx
        ON session_legacy_activity(session_id)
        WHERE state = 'active'
      `)
      yield* tx.run(`
        CREATE TABLE session_legacy_activity_admission (
          activity_id TEXT NOT NULL REFERENCES session_legacy_activity(activity_id) ON DELETE CASCADE,
          admission_id TEXT NOT NULL UNIQUE REFERENCES session_activity_admission(admission_id),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          role TEXT NOT NULL CHECK (role IN ('trigger', 'steer')),
          attached_at INTEGER NOT NULL,
          PRIMARY KEY (activity_id, admission_id),
          UNIQUE (activity_id, ordinal),
          CHECK ((role = 'trigger' AND ordinal = 0) OR (role = 'steer' AND ordinal > 0))
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_admission_validate_insert
        BEFORE INSERT ON session_legacy_activity_admission
        BEGIN
          SELECT CASE WHEN NEW.role = 'trigger' AND NOT EXISTS (
            SELECT 1 FROM session_legacy_activity activity
            WHERE activity.activity_id = NEW.activity_id
              AND activity.trigger_admission_id = NEW.admission_id
          ) THEN RAISE(ABORT, 'legacy activity trigger admission mismatch') END;
          SELECT CASE WHEN NEW.role = 'steer' AND NOT EXISTS (
            SELECT 1
            FROM session_legacy_activity activity
            JOIN session_activity_admission admission ON admission.admission_id = NEW.admission_id
            WHERE activity.activity_id = NEW.activity_id
              AND activity.state = 'active'
              AND admission.session_id = activity.session_id
              AND admission.source_kind = 'legacy_intent'
              AND admission.delivery = 'steer'
          ) THEN RAISE(ABORT, 'legacy steer admission is not owned by active activity') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_admission_immutable
        BEFORE UPDATE ON session_legacy_activity_admission
        BEGIN
          SELECT RAISE(ABORT, 'session_legacy_activity_admission is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_legal_update
        BEFORE UPDATE ON session_legacy_activity
        WHEN NEW.activity_id != OLD.activity_id
          OR NEW.session_id != OLD.session_id
          OR NEW.ordinal != OLD.ordinal
          OR NEW.trigger_admission_id != OLD.trigger_admission_id
          OR NEW.created_at != OLD.created_at
          OR OLD.state != 'active'
          OR NEW.state NOT IN ('settled', 'failed', 'interrupted', 'recovery_required')
          OR NEW.settled_at IS NULL
          OR NEW.terminal_reason IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_legacy_activity transition');
        END
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
    })
  },
} satisfies DatabaseMigration.Migration
