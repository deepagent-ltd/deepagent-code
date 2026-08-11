import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810140000_bug_012_compaction_cas",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN source_window_id TEXT")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN source_effective_history_hash TEXT")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN source_message_count INTEGER")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN source_projection_version INTEGER")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN context_ledger_required INTEGER NOT NULL DEFAULT 0")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN ledger_mirrored_at INTEGER")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN bridge_carried_at INTEGER")
      yield* tx.run("ALTER TABLE compaction_run ADD COLUMN continuation_wakeup_at INTEGER")
      yield* tx.run("ALTER TABLE part ADD COLUMN provenance TEXT")
      yield* tx.run("DROP INDEX IF EXISTS compaction_run_session_active_idx")
      yield* tx.run(`
        CREATE UNIQUE INDEX compaction_run_session_active_idx
        ON compaction_run (session_id)
        WHERE state IN ('requested', 'summarizing')
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_run_source_binding_validate
        BEFORE INSERT ON compaction_run
        WHEN NEW.source_window_id IS NULL OR NEW.source_effective_history_hash IS NULL OR
          NEW.source_message_count IS NULL OR NEW.source_projection_version IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'compaction_run_source_binding_incomplete');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER compaction_run_source_binding_immutable
        BEFORE UPDATE OF source_window_id, source_effective_history_hash, source_message_count,
          source_projection_version ON compaction_run
        WHEN OLD.source_window_id IS NOT NULL AND (
          NEW.source_window_id IS NOT OLD.source_window_id OR
          NEW.source_effective_history_hash IS NOT OLD.source_effective_history_hash OR
          NEW.source_message_count IS NOT OLD.source_message_count OR
          NEW.source_projection_version IS NOT OLD.source_projection_version
        )
        BEGIN
          SELECT RAISE(ABORT, 'compaction_run_source_binding_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER part_provenance_validate
        BEFORE INSERT ON part
        WHEN NEW.provenance IS NOT NULL AND (
          json_valid(NEW.provenance) = 0 OR
          json_extract(NEW.provenance, '$.source') NOT IN ('compaction_marker', 'compaction_replay', 'compaction_continue') OR
          typeof(json_extract(NEW.provenance, '$.owner_session_id')) != 'text' OR
          typeof(json_extract(NEW.provenance, '$.owner_prompt_epoch')) != 'integer' OR
          typeof(json_extract(NEW.provenance, '$.owner_run_id')) != 'text' OR
          json_extract(NEW.provenance, '$.durable') != 1
        )
        BEGIN
          SELECT RAISE(ABORT, 'part_provenance_invalid');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER part_provenance_immutable
        BEFORE UPDATE OF provenance ON part
        WHEN OLD.provenance IS NOT NULL AND NEW.provenance IS NOT OLD.provenance
        BEGIN
          SELECT RAISE(ABORT, 'part_provenance_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER part_provenance_validate_update
        BEFORE UPDATE OF provenance ON part
        WHEN NEW.provenance IS NOT NULL AND (
          json_valid(NEW.provenance) = 0 OR
          json_extract(NEW.provenance, '$.source') NOT IN ('compaction_marker', 'compaction_replay', 'compaction_continue') OR
          typeof(json_extract(NEW.provenance, '$.owner_session_id')) != 'text' OR
          typeof(json_extract(NEW.provenance, '$.owner_prompt_epoch')) != 'integer' OR
          typeof(json_extract(NEW.provenance, '$.owner_run_id')) != 'text' OR
          json_extract(NEW.provenance, '$.durable') != 1
        )
        BEGIN
          SELECT RAISE(ABORT, 'part_provenance_invalid');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
