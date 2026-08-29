
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Idempotent recovery terminal insertion. SessionPromptIntent.recoverActiveActivities can run
// twice for one activity (same-process reconciliation + restart recovery); the validate
// trigger's identity check rejects the second insert once the first pass committed
// (e.g. recovery_required), failing the recovery transaction with a constraint error. A
// terminal row for the same activity IS the recovery's idempotency key, so the dedicated
// recovery passes skip their identity checks when that row already exists.
const migrationID = "20260826090000_recovery_terminal_idempotent_trigger"

export default {
  id: migrationID,
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("DROP TRIGGER IF EXISTS session_legacy_activity_terminal_validate_insert")
      yield* tx.run(sql`
        CREATE TRIGGER session_legacy_activity_terminal_validate_insert
        BEFORE INSERT ON session_legacy_activity_terminal
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM session_legacy_activity_terminal existing WHERE existing.activity_id = NEW.activity_id
          ) AND NOT EXISTS (
            SELECT 1
            FROM session_legacy_activity activity
            JOIN session_activity_admission admission
              ON admission.admission_id = activity.trigger_admission_id
            JOIN session_intent intent ON intent.intent_id = admission.legacy_intent_id
            WHERE activity.activity_id = NEW.activity_id
              AND activity.session_id = NEW.session_id
              AND activity.state = NEW.state
              AND activity.owner_token = NEW.owner_token
              AND intent.mutation_epoch = NEW.mutation_epoch
          ) THEN RAISE(ABORT, 'legacy activity terminal identity mismatch') END;
          SELECT CASE WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM session_legacy_activity_run run
            WHERE run.run_id = NEW.run_id
              AND run.activity_id = NEW.activity_id
              AND run.session_id = NEW.session_id
              AND run.mutation_epoch = NEW.mutation_epoch
              AND run.owner_token = NEW.owner_token
              AND (
                (NEW.state = 'settled' AND run.state = 'completed') OR
                (NEW.state = 'failed' AND run.state = 'failed') OR
                (NEW.state = 'interrupted' AND run.state = 'interrupted') OR
                (NEW.state = 'recovery_required' AND run.state = 'recovery_required')
              )
          ) THEN RAISE(ABORT, 'legacy activity terminal run mismatch') END;
          SELECT CASE WHEN NEW.assistant_message_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM session_activity_progress progress
            WHERE progress.activity_id = NEW.activity_id
              AND progress.revision = NEW.progress_revision
              AND progress.assistant_message_id = NEW.assistant_message_id
              AND progress.input_membership_ordinal = NEW.membership_ordinal
              AND progress.state != 'provisional'
          ) THEN RAISE(ABORT, 'legacy activity terminal progress mismatch') END;
        END
      ` as never)
    })
  },
} satisfies DatabaseMigration.Migration
