import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// provider recovery: turn the fail-closed marker into an explicit recovery protocol.
// Each failure episode is immutable. A user command can abandon it, or replay it
// only when the episode failed directly from pending (no provider admission).
export default {
  id: "20260821150000_compaction_continuation_explicit_resolution",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("DROP TRIGGER IF EXISTS compaction_continuation_resolution_validate_insert")
      yield* tx.run("DROP TRIGGER IF EXISTS compaction_continuation_resolution_immutable_update")
      yield* tx.run("DROP TRIGGER IF EXISTS compaction_continuation_resolution_immutable_delete")
      yield* tx.run("ALTER TABLE compaction_continuation_resolution RENAME TO compaction_continuation_failure_legacy")
      yield* tx.run(`
        CREATE TABLE compaction_continuation_failure (
          failure_id TEXT PRIMARY KEY NOT NULL,
          run_id TEXT NOT NULL REFERENCES compaction_run(run_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          source_state TEXT NOT NULL CHECK (source_state IN ('pending', 'admitted', 'dispatching', 'unknown')),
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(run_id, ordinal)
        )
      `)
      yield* tx.run(`
        INSERT INTO compaction_continuation_failure (
          failure_id, run_id, session_id, ordinal, source_state, reason, created_at
        )
        SELECT resolution_id, run_id, session_id, 1, 'unknown', reason, created_at
        FROM compaction_continuation_failure_legacy
      `)
      yield* tx.run("DROP TABLE compaction_continuation_failure_legacy")
      yield* tx.run(`
        CREATE TABLE compaction_continuation_resolution_command (
          command_id TEXT PRIMARY KEY NOT NULL,
          request_hash TEXT NOT NULL,
          run_id TEXT NOT NULL REFERENCES compaction_run(run_id) ON DELETE CASCADE,
          result_resolution_id TEXT,
          created_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE TABLE compaction_continuation_resolution (
          resolution_id TEXT PRIMARY KEY NOT NULL,
          failure_id TEXT NOT NULL UNIQUE REFERENCES compaction_continuation_failure(failure_id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES compaction_run(run_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          decision TEXT NOT NULL CHECK (decision IN ('abandoned', 'replay')),
          actor_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          risk_acknowledged INTEGER NOT NULL CHECK (risk_acknowledged IN (0, 1)),
          source_prompt_epoch INTEGER NOT NULL CHECK (source_prompt_epoch >= 0),
          source_window_id TEXT NOT NULL,
          source_history_hash TEXT NOT NULL,
          source_mutation_epoch INTEGER NOT NULL CHECK (source_mutation_epoch >= 0),
          successor_prompt_epoch INTEGER NOT NULL CHECK (successor_prompt_epoch > 0),
          successor_window_id TEXT NOT NULL,
          successor_history_hash TEXT NOT NULL,
          successor_mutation_epoch INTEGER NOT NULL CHECK (successor_mutation_epoch > 0),
          created_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_continuation_failure_validate_insert
        BEFORE INSERT ON compaction_continuation_failure
        WHEN NOT EXISTS (
          SELECT 1 FROM compaction_run run
          WHERE run.run_id = NEW.run_id
            AND run.session_id = NEW.session_id
            AND run.continuation_state = 'failed'
            AND run.continuation_error_code = NEW.reason
            AND run.continuation_terminal_at IS NOT NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'continuation failure is not bound to failed run');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_continuation_failure_immutable
        BEFORE UPDATE ON compaction_continuation_failure
        BEGIN SELECT RAISE(ABORT, 'continuation failure is append-only'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_continuation_failure_immutable_delete
        BEFORE DELETE ON compaction_continuation_failure
        WHEN EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'continuation failure is append-only'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_continuation_resolution_validate_insert
        BEFORE INSERT ON compaction_continuation_resolution
        WHEN NOT EXISTS (
          SELECT 1
          FROM compaction_continuation_failure failure
          JOIN compaction_run run ON run.run_id = failure.run_id
          WHERE failure.failure_id = NEW.failure_id
            AND failure.run_id = NEW.run_id
            AND failure.session_id = NEW.session_id
            AND run.continuation_state = 'failed'
            AND (NEW.decision != 'abandoned' OR NEW.risk_acknowledged = 1)
            AND NEW.successor_prompt_epoch = NEW.source_prompt_epoch + 1
            AND NEW.successor_mutation_epoch = NEW.source_mutation_epoch + 1
            AND EXISTS (
              SELECT 1 FROM session_prompt_epoch source
              JOIN session ON session.id = source.session_id
              WHERE source.session_id = NEW.session_id
                AND source.epoch = NEW.source_prompt_epoch
                AND source.state = 'active'
                AND source.authority_state = 'recovery_required'
                AND source.window_id = NEW.source_window_id
                AND source.effective_history_hash = NEW.source_history_hash
                AND session.mutation_epoch = NEW.source_mutation_epoch
            )
            AND (NEW.decision != 'replay' OR failure.source_state = 'pending')
        )
        BEGIN
          SELECT RAISE(ABORT, 'continuation resolution is stale or replay is unsafe');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_continuation_resolution_immutable
        BEFORE UPDATE ON compaction_continuation_resolution
        BEGIN SELECT RAISE(ABORT, 'continuation resolution is append-only'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_continuation_resolution_immutable_delete
        BEFORE DELETE ON compaction_continuation_resolution
        WHEN EXISTS (SELECT 1 FROM session WHERE id = OLD.session_id)
        BEGIN SELECT RAISE(ABORT, 'continuation resolution is append-only'); END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_continuation_resolution_command_immutable_update
        BEFORE UPDATE ON compaction_continuation_resolution_command
        BEGIN
          SELECT CASE WHEN OLD.result_resolution_id IS NOT NULL OR
            NEW.command_id IS NOT OLD.command_id OR NEW.request_hash IS NOT OLD.request_hash OR
            NEW.run_id IS NOT OLD.run_id OR NEW.created_at IS NOT OLD.created_at OR
            NEW.result_resolution_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM compaction_continuation_resolution resolution
              WHERE resolution.resolution_id = NEW.result_resolution_id
                AND resolution.run_id = NEW.run_id
            )
          THEN RAISE(ABORT, 'continuation resolution command is immutable') END;
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_continuation_resolution_command_immutable_delete
        BEFORE DELETE ON compaction_continuation_resolution_command
        WHEN EXISTS (
          SELECT 1 FROM compaction_run run
          JOIN session ON session.id = run.session_id
          WHERE run.run_id = OLD.run_id
        )
        BEGIN SELECT RAISE(ABORT, 'continuation resolution command is immutable'); END
      `)

      yield* tx.run("DROP TRIGGER IF EXISTS compaction_run_continuation_transition")
      yield* tx.run(`
        CREATE TRIGGER compaction_run_continuation_transition
        BEFORE UPDATE OF continuation_state ON compaction_run
        WHEN OLD.continuation_state IS NOT NEW.continuation_state AND NOT (
          (OLD.continuation_state IS NULL AND NEW.continuation_state = 'pending') OR
          (OLD.continuation_state = 'pending' AND NEW.continuation_state IN ('admitted', 'failed')) OR
          (OLD.continuation_state = 'admitted' AND NEW.continuation_state IN ('pending', 'dispatching', 'failed')) OR
          (OLD.continuation_state = 'dispatching' AND NEW.continuation_state IN ('settled', 'failed', 'indeterminate')) OR
          (OLD.continuation_state = 'failed' AND NEW.continuation_state = 'pending' AND EXISTS (
            SELECT 1
            FROM compaction_continuation_failure failure
            JOIN compaction_continuation_resolution resolution
              ON resolution.failure_id = failure.failure_id
            WHERE failure.run_id = NEW.run_id
              AND resolution.run_id = NEW.run_id
              AND resolution.decision = 'replay'
              AND failure.ordinal = (
                SELECT MAX(latest.ordinal)
                FROM compaction_continuation_failure latest
                WHERE latest.run_id = NEW.run_id
              )
          ))
        )
        BEGIN
          SELECT RAISE(ABORT, 'illegal compaction continuation transition');
        END
      `)
      yield* tx.run("DROP TRIGGER IF EXISTS compaction_run_continuation_binding_validate")
      yield* tx.run(`
        CREATE TRIGGER compaction_run_continuation_binding_validate
        BEFORE UPDATE ON compaction_run
        WHEN NOT (
          (OLD.continuation_state = 'pending' AND NEW.continuation_state = 'failed') OR
          (OLD.continuation_state = 'failed' AND NEW.continuation_state = 'pending')
        ) AND (
          (NEW.continuation_state IN ('admitted', 'dispatching', 'settled', 'failed', 'indeterminate') AND
            (NEW.continuation_receipt_id IS NULL OR NEW.continuation_admitted_at IS NULL)) OR
          (NEW.continuation_state IN ('dispatching', 'settled', 'failed', 'indeterminate') AND
            NEW.continuation_dispatching_at IS NULL AND NEW.continuation_state != 'failed') OR
          (NEW.continuation_state IN ('settled', 'failed', 'indeterminate') AND NEW.continuation_terminal_at IS NULL)
        )
        BEGIN
          SELECT RAISE(ABORT, 'incomplete compaction continuation binding');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
