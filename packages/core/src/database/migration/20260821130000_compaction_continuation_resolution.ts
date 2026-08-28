import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// provider recovery: record the durable decision made when continuation recovery is
// unavailable. The state machine still fails closed, but the reason and the
// one-shot resolution receipt survive restart and can be resolved explicitly.
export default {
  id: "20260821130000_compaction_continuation_resolution",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE compaction_continuation_resolution (
          resolution_id TEXT NOT NULL PRIMARY KEY,
          run_id TEXT NOT NULL UNIQUE REFERENCES compaction_run(run_id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          outcome TEXT NOT NULL CHECK (outcome = 'failed_closed'),
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `)
      // The receipt is append-only and must be causally bound to the failed run. In
      // particular, a caller cannot manufacture a resolution for a still-recoverable
      // continuation or attach a reason different from the persisted error code.
      yield* tx.run(`
        CREATE TRIGGER compaction_continuation_resolution_validate_insert
        BEFORE INSERT ON compaction_continuation_resolution
        WHEN NOT EXISTS (
          SELECT 1
          FROM compaction_run run
          WHERE run.run_id = NEW.run_id
            AND run.session_id = NEW.session_id
            AND run.continuation_state = 'failed'
            AND run.continuation_error_code = NEW.reason
            AND run.continuation_terminal_at IS NOT NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'compaction continuation resolution is not bound to failed run');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_continuation_resolution_immutable_update
        BEFORE UPDATE ON compaction_continuation_resolution
        BEGIN
          SELECT RAISE(ABORT, 'compaction continuation resolution is append-only');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_continuation_resolution_immutable_delete
        BEFORE DELETE ON compaction_continuation_resolution
        WHEN EXISTS (
          SELECT 1
          FROM compaction_run run
          JOIN session ON session.id = run.session_id
          WHERE run.run_id = OLD.run_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'compaction continuation resolution is append-only');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
