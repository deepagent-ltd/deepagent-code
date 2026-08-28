import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813041100_learning_lifecycle_trigger_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TRIGGER learning_lifecycle_trigger_identity_immutable
        BEFORE UPDATE ON learning_lifecycle_trigger_receipt
        WHEN NEW.receipt_id != OLD.receipt_id
          OR NEW.trigger != OLD.trigger
          OR NEW.boundary_key != OLD.boundary_key
          OR NEW.session_id != OLD.session_id
          OR NEW.run_id != OLD.run_id
          OR NEW.source_admission_hash != OLD.source_admission_hash
          OR NEW.source_terminal_hash != OLD.source_terminal_hash
          OR NEW.artifact_path != OLD.artifact_path
          OR NEW.artifact_hash != OLD.artifact_hash
          OR NEW.artifact_json != OLD.artifact_json
          OR NEW.admission_fingerprint != OLD.admission_fingerprint
          OR NEW.admission_json != OLD.admission_json
          OR NEW.created_at != OLD.created_at
        BEGIN SELECT RAISE(ABORT, 'learning_lifecycle_trigger_identity_immutable'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_lifecycle_trigger_transition_guard
        BEFORE UPDATE OF state ON learning_lifecycle_trigger_receipt
        WHEN NOT (OLD.state = 'prepared' AND NEW.state = 'admitted')
        BEGIN SELECT RAISE(ABORT, 'learning_lifecycle_trigger_transition_invalid'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER learning_lifecycle_trigger_terminal_immutable
        BEFORE UPDATE ON learning_lifecycle_trigger_receipt
        WHEN OLD.state = 'admitted'
        BEGIN SELECT RAISE(ABORT, 'learning_lifecycle_trigger_terminal_immutable'); END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
