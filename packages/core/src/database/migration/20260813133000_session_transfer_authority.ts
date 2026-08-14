import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813133000_session_transfer_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE event_sequence ADD COLUMN write_fence_transfer_id TEXT")
      yield* tx.run(`
        CREATE TABLE session_transfer_operation (
          transfer_id TEXT NOT NULL PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          source_workspace_id TEXT,
          target_workspace_id TEXT,
          source_owner_id TEXT,
          target_owner_id TEXT,
          source_event_seq INTEGER NOT NULL CHECK (source_event_seq >= 0),
          source_mutation_epoch INTEGER NOT NULL CHECK (source_mutation_epoch >= 0),
          snapshot_id TEXT,
          snapshot_hash TEXT,
          state TEXT NOT NULL CHECK (state IN (
            'admitted', 'source_frozen', 'target_staged', 'owner_committed', 'target_activated', 'aborted'
          )),
          request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
          error_code TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER,
          UNIQUE (session_id, request_hash)
        )
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_transfer_operation_active_idx
        ON session_transfer_operation(session_id)
        WHERE state NOT IN ('target_activated', 'aborted')
      `)
      yield* tx.run(`
        CREATE TABLE session_transfer_target_receipt (
          transfer_id TEXT NOT NULL PRIMARY KEY,
          session_id TEXT NOT NULL,
          source_snapshot_id TEXT NOT NULL,
          source_snapshot_hash TEXT NOT NULL CHECK (length(source_snapshot_hash) = 64),
          source_event_seq INTEGER NOT NULL CHECK (source_event_seq >= 0),
          target_workspace_id TEXT,
          target_owner_id TEXT,
          state TEXT NOT NULL CHECK (state IN ('staged', 'activated')),
          activated_snapshot_id TEXT,
          activated_at INTEGER,
          created_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_transfer_operation_state_guard
        BEFORE UPDATE ON session_transfer_operation
        BEGIN
          SELECT CASE
            WHEN NEW.transfer_id != OLD.transfer_id
              OR NEW.session_id != OLD.session_id
              OR NEW.request_hash != OLD.request_hash
              OR NEW.source_event_seq != OLD.source_event_seq
              OR NEW.source_mutation_epoch != OLD.source_mutation_epoch
              OR NEW.source_workspace_id IS NOT OLD.source_workspace_id
              OR NEW.target_workspace_id IS NOT OLD.target_workspace_id
              OR NEW.source_owner_id IS NOT OLD.source_owner_id
              OR NEW.target_owner_id IS NOT OLD.target_owner_id
              THEN RAISE(ABORT, 'session_transfer_identity_immutable')
            WHEN NOT (
              (OLD.state = 'admitted' AND NEW.state IN ('source_frozen', 'aborted'))
              OR (OLD.state = 'source_frozen' AND NEW.state IN ('target_staged', 'aborted'))
              OR (OLD.state = 'target_staged' AND NEW.state = 'owner_committed')
              OR (OLD.state = 'owner_committed' AND NEW.state = 'target_activated')
              OR OLD.state = NEW.state
            ) THEN RAISE(ABORT, 'session_transfer_transition_invalid')
            WHEN OLD.state IN ('target_activated', 'aborted') AND NEW.state != OLD.state
              THEN RAISE(ABORT, 'session_transfer_terminal')
            WHEN NEW.state IN ('source_frozen', 'target_staged', 'owner_committed', 'target_activated')
              AND (NEW.snapshot_id IS NULL OR length(NEW.snapshot_hash) != 64)
              THEN RAISE(ABORT, 'session_transfer_snapshot_required')
            WHEN OLD.snapshot_id IS NOT NULL
              AND (NEW.snapshot_id != OLD.snapshot_id OR NEW.snapshot_hash != OLD.snapshot_hash)
              THEN RAISE(ABORT, 'session_transfer_snapshot_immutable')
          END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER event_sequence_transfer_fence_guard
        BEFORE UPDATE OF write_fence_transfer_id ON event_sequence
        BEGIN
          SELECT CASE
            WHEN OLD.write_fence_transfer_id IS NOT NULL
              AND NEW.write_fence_transfer_id IS NOT OLD.write_fence_transfer_id
              THEN RAISE(ABORT, 'event_sequence_transfer_fence_immutable')
            WHEN NEW.write_fence_transfer_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM session_transfer_operation operation
              WHERE operation.transfer_id = NEW.write_fence_transfer_id
                AND operation.session_id = NEW.aggregate_id
                AND operation.state IN ('admitted', 'source_frozen')
            ) THEN RAISE(ABORT, 'event_sequence_transfer_fence_authority_missing')
          END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_input_transfer_fence
        BEFORE INSERT ON session_input
        WHEN EXISTS (
          SELECT 1 FROM event_sequence sequence
          WHERE sequence.aggregate_id = NEW.session_id
            AND sequence.write_fence_transfer_id IS NOT NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'session_transfer_source_frozen');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_transfer_target_receipt_state_guard
        BEFORE UPDATE ON session_transfer_target_receipt
        BEGIN
          SELECT CASE
            WHEN NEW.transfer_id != OLD.transfer_id
              OR NEW.session_id != OLD.session_id
              OR NEW.source_snapshot_id != OLD.source_snapshot_id
              OR NEW.source_snapshot_hash != OLD.source_snapshot_hash
              OR NEW.source_event_seq != OLD.source_event_seq
              OR NEW.target_workspace_id IS NOT OLD.target_workspace_id
              OR NEW.target_owner_id IS NOT OLD.target_owner_id
              THEN RAISE(ABORT, 'session_transfer_target_identity_immutable')
            WHEN OLD.state = 'activated' AND NEW.state != 'activated'
              THEN RAISE(ABORT, 'session_transfer_target_terminal')
            WHEN OLD.state = 'staged' AND NEW.state NOT IN ('staged', 'activated')
              THEN RAISE(ABORT, 'session_transfer_target_transition_invalid')
            WHEN NEW.state = 'activated'
              AND (NEW.activated_snapshot_id IS NULL OR NEW.activated_at IS NULL)
              THEN RAISE(ABORT, 'session_transfer_target_activation_incomplete')
          END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_transfer_target_receipt_immutable_delete
        BEFORE DELETE ON session_transfer_target_receipt
        WHEN EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'session_transfer_target_receipt_immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
