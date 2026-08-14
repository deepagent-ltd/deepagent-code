import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"
import { Hash } from "../../util/hash"

const migrationID = "20260812130000_legacy_activity_lifecycle_expand"
const classifierVersion = "legacy-terminal-state-v1"

export default {
  id: migrationID,
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE session_intent
        ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'legacy'
        CHECK (execution_mode IN ('legacy','run_now','deferred'))
      `)
      yield* tx.run(`
        ALTER TABLE session_intent
        ADD COLUMN execution_state TEXT NOT NULL DEFAULT 'legacy'
        CHECK (execution_state IN ('legacy','pending','claimed','absorbed','canceled'))
      `)
      yield* tx.run(`ALTER TABLE session_intent ADD COLUMN execution_claim_id TEXT`)
      yield* tx.run(`ALTER TABLE session_intent ADD COLUMN execution_claimed_at INTEGER`)
      yield* tx.run(`
        CREATE TRIGGER session_intent_execution_validate_insert
        BEFORE INSERT ON session_intent
        WHEN NOT (
          (NEW.execution_mode = 'legacy' AND NEW.execution_state = 'legacy'
            AND NEW.execution_claim_id IS NULL AND NEW.execution_claimed_at IS NULL) OR
          (NEW.execution_mode IN ('run_now','deferred') AND NEW.execution_state = 'pending'
            AND NEW.execution_claim_id IS NULL AND NEW.execution_claimed_at IS NULL) OR
          (NEW.execution_mode IN ('run_now','deferred') AND NEW.execution_state = 'claimed'
            AND NEW.execution_claim_id IS NOT NULL AND NEW.execution_claimed_at IS NOT NULL) OR
          (NEW.execution_mode = 'deferred' AND NEW.execution_state = 'absorbed'
            AND NEW.execution_claim_id IS NOT NULL AND NEW.execution_claimed_at IS NOT NULL) OR
          (NEW.execution_mode IN ('run_now','deferred') AND NEW.execution_state = 'canceled'
            AND NEW.execution_claim_id IS NULL AND NEW.execution_claimed_at IS NULL)
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid session intent execution identity');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_intent_execution_validate_update
        BEFORE UPDATE ON session_intent
        WHEN NOT (
          (NEW.execution_mode = 'legacy' AND NEW.execution_state = 'legacy'
            AND NEW.execution_claim_id IS NULL AND NEW.execution_claimed_at IS NULL) OR
          (NEW.execution_mode IN ('run_now','deferred') AND NEW.execution_state = 'pending'
            AND NEW.execution_claim_id IS NULL AND NEW.execution_claimed_at IS NULL) OR
          (NEW.execution_mode IN ('run_now','deferred') AND NEW.execution_state = 'claimed'
            AND NEW.execution_claim_id IS NOT NULL AND NEW.execution_claimed_at IS NOT NULL) OR
          (NEW.execution_mode = 'deferred' AND NEW.execution_state = 'absorbed'
            AND NEW.execution_claim_id IS NOT NULL AND NEW.execution_claimed_at IS NOT NULL) OR
          (NEW.execution_mode IN ('run_now','deferred') AND NEW.execution_state = 'canceled'
            AND NEW.execution_claim_id IS NULL AND NEW.execution_claimed_at IS NULL)
        ) OR NOT (
          (NEW.execution_mode = OLD.execution_mode AND NEW.execution_state = OLD.execution_state
            AND NEW.execution_claim_id IS OLD.execution_claim_id
            AND NEW.execution_claimed_at IS OLD.execution_claimed_at) OR
          (OLD.execution_state = 'pending' AND NEW.execution_mode = OLD.execution_mode
            AND NEW.execution_state IN ('claimed','absorbed','canceled')) OR
          (OLD.execution_mode = 'legacy' AND OLD.execution_state = 'legacy'
            AND NEW.execution_mode IN ('run_now','deferred')
            AND NEW.execution_state IN ('pending','claimed','absorbed','canceled'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'illegal session intent execution transition');
        END
      `)

      yield* tx.run(`
        ALTER TABLE session_activity_admission
        ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'legacy'
        CHECK (execution_mode IN ('legacy','run_now','deferred'))
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_admission_execution_mode_validate_insert
        BEFORE INSERT ON session_activity_admission
        BEGIN
          SELECT CASE WHEN NEW.source_kind = 'legacy_intent' AND NOT EXISTS (
            SELECT 1 FROM session_intent intent
            WHERE intent.intent_id = NEW.legacy_intent_id
              AND intent.session_id = NEW.session_id
              AND intent.execution_mode = NEW.execution_mode
          ) THEN RAISE(ABORT, 'legacy activity admission execution mode mismatch') END;
          SELECT CASE WHEN NEW.source_kind = 'session_input' AND NEW.execution_mode != 'legacy'
            THEN RAISE(ABORT, 'v2 activity admission cannot use legacy execution modes') END;
        END
      `)

      yield* tx.run(`DROP TRIGGER session_legacy_activity_admission_validate_insert`)
      yield* tx.run(`DROP TRIGGER session_legacy_activity_admission_immutable`)
      yield* tx.run(`ALTER TABLE session_legacy_activity_admission RENAME TO session_legacy_activity_admission_old`)
      yield* tx.run(`
        CREATE TABLE session_legacy_activity_admission (
          activity_id TEXT NOT NULL REFERENCES session_legacy_activity(activity_id) ON DELETE CASCADE,
          admission_id TEXT NOT NULL UNIQUE REFERENCES session_activity_admission(admission_id),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          role TEXT NOT NULL CHECK (role IN ('trigger', 'steer', 'deferred_context')),
          attached_at INTEGER NOT NULL,
          PRIMARY KEY (activity_id, admission_id),
          UNIQUE (activity_id, ordinal),
          CHECK (
            (role = 'trigger' AND ordinal = 0) OR
            (role IN ('steer', 'deferred_context') AND ordinal > 0)
          )
        )
      `)
      yield* tx.run(`
        INSERT INTO session_legacy_activity_admission (
          activity_id, admission_id, ordinal, role, attached_at
        )
        SELECT activity_id, admission_id, ordinal, role, attached_at
        FROM session_legacy_activity_admission_old
      `)
      yield* tx.run(`DROP TABLE session_legacy_activity_admission_old`)
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
          SELECT CASE WHEN NEW.role = 'deferred_context' AND NOT EXISTS (
            SELECT 1
            FROM session_legacy_activity activity
            JOIN session_activity_admission admission ON admission.admission_id = NEW.admission_id
            JOIN session_intent intent ON intent.intent_id = admission.legacy_intent_id
            JOIN session_activity_admission trigger_admission
              ON trigger_admission.admission_id = activity.trigger_admission_id
            JOIN session_intent trigger_intent ON trigger_intent.intent_id = trigger_admission.legacy_intent_id
            WHERE activity.activity_id = NEW.activity_id
              AND activity.state = 'active'
              AND admission.session_id = activity.session_id
              AND admission.source_kind = 'legacy_intent'
              AND admission.execution_mode = 'deferred'
              AND intent.execution_mode = 'deferred'
              AND intent.execution_state = 'absorbed'
              AND intent.execution_claim_id IS NOT NULL
              AND intent.execution_claimed_at IS NOT NULL
              AND intent.execution_claim_id = trigger_intent.execution_claim_id
              AND intent.mutation_epoch = trigger_intent.mutation_epoch
          ) THEN RAISE(ABORT, 'legacy deferred context admission is not bound to active run') END;
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
        ALTER TABLE session_activity_progress
        ADD COLUMN input_membership_ordinal INTEGER NOT NULL DEFAULT 0
        CHECK (input_membership_ordinal >= 0)
      `)
      yield* tx.run(`
        DROP TRIGGER session_activity_progress_legal_update
      `)
      yield* tx.run(`
        CREATE TRIGGER session_activity_progress_legal_update
        BEFORE UPDATE ON session_activity_progress
        WHEN NEW.activity_id != OLD.activity_id
          OR NEW.revision != OLD.revision
          OR NEW.assistant_message_id != OLD.assistant_message_id
          OR NEW.provider_receipt_id != OLD.provider_receipt_id
          OR NEW.input_membership_ordinal != OLD.input_membership_ordinal
          OR NEW.created_at != OLD.created_at
          OR OLD.state != 'provisional'
          OR NEW.state NOT IN ('progress', 'final', 'interrupted', 'recovery_required')
          OR NEW.settled_at IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_activity_progress transition');
        END
      `)

      yield* tx.run(`
        CREATE TABLE session_legacy_activity_run (
          run_id TEXT PRIMARY KEY,
          activity_id TEXT NOT NULL REFERENCES session_legacy_activity(activity_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          mutation_epoch INTEGER NOT NULL CHECK (mutation_epoch >= 0),
          generation INTEGER NOT NULL CHECK (generation >= 0),
          owner_token TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN (
            'running','finalizing','completed','failed','interrupted','recovery_required'
          )),
          started_at INTEGER NOT NULL,
          terminal_at INTEGER,
          terminal_reason TEXT,
          CHECK (
            (state IN ('running','finalizing') AND terminal_at IS NULL AND terminal_reason IS NULL) OR
            (state IN ('completed','failed','interrupted','recovery_required') AND
              terminal_at IS NOT NULL AND terminal_reason IS NOT NULL)
          )
        )
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_legacy_activity_run_generation_idx
        ON session_legacy_activity_run(session_id, mutation_epoch, generation)
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_legacy_activity_live_run_idx
        ON session_legacy_activity_run(activity_id)
        WHERE state IN ('running','finalizing')
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_run_validate_insert
        BEFORE INSERT ON session_legacy_activity_run
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1
            FROM session_legacy_activity activity
            JOIN session_activity_admission admission
              ON admission.admission_id = activity.trigger_admission_id
            JOIN session_intent intent ON intent.intent_id = admission.legacy_intent_id
            WHERE activity.activity_id = NEW.activity_id
              AND activity.session_id = NEW.session_id
              AND activity.state = 'active'
              AND activity.owner_token = NEW.owner_token
              AND intent.session_id = NEW.session_id
              AND intent.mutation_epoch = NEW.mutation_epoch
              AND intent.execution_state = 'claimed'
              AND intent.execution_claim_id = NEW.run_id
          ) THEN RAISE(ABORT, 'legacy activity run identity mismatch') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_run_legal_update
        BEFORE UPDATE ON session_legacy_activity_run
        WHEN NEW.run_id != OLD.run_id
          OR NEW.activity_id != OLD.activity_id
          OR NEW.session_id != OLD.session_id
          OR NEW.mutation_epoch != OLD.mutation_epoch
          OR NEW.generation != OLD.generation
          OR NEW.owner_token != OLD.owner_token
          OR NEW.started_at != OLD.started_at
          OR OLD.state NOT IN ('running','finalizing')
          OR (OLD.state = 'running' AND NEW.state NOT IN (
            'finalizing','completed','failed','interrupted','recovery_required'
          ))
          OR (OLD.state = 'finalizing' AND NEW.state NOT IN (
            'running','completed','failed','interrupted','recovery_required'
          ))
          OR (NEW.state IN ('running','finalizing') AND
            (NEW.terminal_at IS NOT NULL OR NEW.terminal_reason IS NOT NULL))
          OR (NEW.state IN ('completed','failed','interrupted','recovery_required') AND
            (NEW.terminal_at IS NULL OR NEW.terminal_reason IS NULL))
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_legacy_activity_run transition');
        END
      `)

      yield* tx.run(`
        CREATE TABLE session_legacy_activity_terminal (
          activity_id TEXT PRIMARY KEY REFERENCES session_legacy_activity(activity_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          mutation_epoch INTEGER NOT NULL CHECK (mutation_epoch >= 0),
          state TEXT NOT NULL CHECK (state IN ('settled','failed','interrupted','recovery_required')),
          reason_code TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN (
            'provider_final','host_stop','cancel','compaction','restart_recovery',
            'same_process_recovery','migration_repair','migration_backfill'
          )),
          operation_id TEXT NOT NULL,
          run_id TEXT REFERENCES session_legacy_activity_run(run_id),
          assistant_message_id TEXT,
          progress_revision INTEGER,
          membership_ordinal INTEGER NOT NULL CHECK (membership_ordinal >= 0),
          owner_token TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          CHECK (
            (assistant_message_id IS NULL AND progress_revision IS NULL) OR
            (assistant_message_id IS NOT NULL AND progress_revision IS NOT NULL)
          ),
          CHECK (
            (source IN ('provider_final','host_stop','cancel','compaction') AND run_id IS NOT NULL) OR
            source IN ('restart_recovery','same_process_recovery','migration_repair','migration_backfill')
          )
        )
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_legacy_activity_terminal_operation_idx
        ON session_legacy_activity_terminal(operation_id)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_terminal_validate_insert
        BEFORE INSERT ON session_legacy_activity_terminal
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
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
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_terminal_immutable_update
        BEFORE UPDATE ON session_legacy_activity_terminal
        BEGIN
          SELECT RAISE(ABORT, 'session_legacy_activity_terminal is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_terminal_immutable_delete
        BEFORE DELETE ON session_legacy_activity_terminal
        WHEN EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
        BEGIN
          SELECT RAISE(ABORT, 'session_legacy_activity_terminal is immutable');
        END
      `)

      yield* tx.run(`
        CREATE TABLE session_legacy_activity_migration_receipt (
          receipt_id TEXT PRIMARY KEY,
          batch_id TEXT NOT NULL,
          activity_id TEXT NOT NULL REFERENCES session_legacy_activity(activity_id) ON DELETE CASCADE,
          classifier_version TEXT NOT NULL,
          before_state TEXT NOT NULL CHECK (before_state IN (
            'active','settled','failed','interrupted','recovery_required'
          )),
          after_state TEXT NOT NULL CHECK (after_state IN (
            'settled','failed','interrupted','recovery_required'
          )),
          evidence_hash TEXT NOT NULL,
          terminal_operation_id TEXT NOT NULL
            REFERENCES session_legacy_activity_terminal(operation_id) ON DELETE CASCADE,
          error_code TEXT,
          created_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_legacy_activity_migration_batch_idx
        ON session_legacy_activity_migration_receipt(batch_id, activity_id)
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX session_legacy_activity_migration_terminal_idx
        ON session_legacy_activity_migration_receipt(terminal_operation_id)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_migration_receipt_immutable_update
        BEFORE UPDATE ON session_legacy_activity_migration_receipt
        BEGIN
          SELECT RAISE(ABORT, 'session_legacy_activity_migration_receipt is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_legacy_activity_migration_receipt_immutable_delete
        BEFORE DELETE ON session_legacy_activity_migration_receipt
        WHEN EXISTS (
          SELECT 1
          FROM session_legacy_activity activity
          JOIN session ON session.id = activity.session_id
          WHERE activity.activity_id = OLD.activity_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'session_legacy_activity_migration_receipt is immutable');
        END
      `)

      const terminalRows = yield* tx.all<{
        activity_id: string
        session_id: string
        state: "settled" | "failed" | "interrupted" | "recovery_required"
        terminal_reason: string
        settled_at: number
        owner_token: string
        mutation_epoch: number
        membership_ordinal: number
      }>(`
        SELECT
          activity.activity_id,
          activity.session_id,
          activity.state,
          activity.terminal_reason,
          activity.settled_at,
          activity.owner_token,
          intent.mutation_epoch,
          COALESCE(MAX(membership.ordinal), 0) AS membership_ordinal
        FROM session_legacy_activity activity
        JOIN session_activity_admission admission
          ON admission.admission_id = activity.trigger_admission_id
        JOIN session_intent intent ON intent.intent_id = admission.legacy_intent_id
        LEFT JOIN session_legacy_activity_admission membership
          ON membership.activity_id = activity.activity_id
        WHERE activity.state != 'active'
        GROUP BY activity.activity_id
      `)
      yield* Effect.forEach(
        terminalRows,
        (row) => {
          const operationID = Hash.sha256(`legacy-activity-terminal-backfill:v1:${row.activity_id}`)
          const receiptID = Hash.sha256(`legacy-activity-migration-receipt:v1:${row.activity_id}`)
          const evidenceHash = Hash.sha256(
            JSON.stringify({
              activityID: row.activity_id,
              sessionID: row.session_id,
              mutationEpoch: row.mutation_epoch,
              state: row.state,
              reason: row.terminal_reason,
              settledAt: row.settled_at,
              ownerToken: row.owner_token,
              membershipOrdinal: row.membership_ordinal,
            }),
          )
          return Effect.gen(function* () {
            yield* tx.run(sql`
              INSERT INTO session_legacy_activity_terminal (
                activity_id, session_id, mutation_epoch, state, reason_code, source,
                operation_id, run_id, assistant_message_id, progress_revision,
                membership_ordinal, owner_token, created_at
              ) VALUES (
                ${row.activity_id}, ${row.session_id}, ${row.mutation_epoch},
                ${row.state}, ${row.terminal_reason}, 'migration_backfill',
                ${operationID}, NULL, NULL, NULL, ${row.membership_ordinal},
                ${row.owner_token}, ${row.settled_at}
              )
            `)
            yield* tx.run(sql`
              INSERT INTO session_legacy_activity_migration_receipt (
                receipt_id, batch_id, activity_id, classifier_version, before_state, after_state,
                evidence_hash, terminal_operation_id, error_code, created_at
              ) VALUES (
                ${receiptID}, ${migrationID}, ${row.activity_id}, ${classifierVersion},
                ${row.state}, ${row.state}, ${evidenceHash}, ${operationID}, NULL, ${row.settled_at}
              )
            `)
          })
        },
        { discard: true },
      )
    })
  },
} satisfies DatabaseMigration.Migration
