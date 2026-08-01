import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726080000_location_change_journal",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE location_change_event (
          event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          index_space_id TEXT NOT NULL,
          path TEXT NOT NULL,
          previous_path TEXT,
          rename_correlation_id TEXT,
          change_kind TEXT NOT NULL CHECK (change_kind IN ('create', 'update', 'delete', 'rename', 'config', 'checkout', 'overflow', 'reconcile')),
          observed_mtime_ns TEXT,
          observed_sha TEXT,
          source TEXT NOT NULL CHECK (source IN ('watcher', 'tool', 'editor', 'git', 'fresh_query', 'reconciliation')),
          observed_at INTEGER NOT NULL,
          CHECK ((change_kind = 'rename' AND previous_path IS NOT NULL AND rename_correlation_id IS NOT NULL)
            OR (change_kind <> 'rename' AND previous_path IS NULL AND rename_correlation_id IS NULL)),
          CHECK ((change_kind IN ('checkout', 'overflow', 'reconcile') AND path = '*')
            OR change_kind NOT IN ('checkout', 'overflow', 'reconcile'))
        )
      `)
      yield* tx.run("CREATE INDEX location_change_event_space_seq_idx ON location_change_event(index_space_id, event_seq)")
      yield* tx.run(`
        CREATE TABLE location_projection_registration (
          index_space_id TEXT NOT NULL,
          projection_kind TEXT NOT NULL CHECK (projection_kind IN ('code', 'repo_documents')),
          registration_epoch INTEGER NOT NULL CHECK (registration_epoch > 0),
          state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'retired')),
          consumed_event_seq INTEGER NOT NULL CHECK (consumed_event_seq >= 0),
          reconcile_required INTEGER NOT NULL CHECK (reconcile_required IN (0, 1)),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (index_space_id, projection_kind)
        )
      `)
      yield* tx.run(`
        CREATE TABLE location_projection_dirty_path (
          index_space_id TEXT NOT NULL,
          projection_kind TEXT NOT NULL CHECK (projection_kind IN ('code', 'repo_documents')),
          path TEXT NOT NULL,
          latest_event_seq INTEGER NOT NULL CHECK (latest_event_seq >= 0),
          previous_path TEXT,
          rename_correlation_id TEXT,
          change_kind TEXT NOT NULL CHECK (change_kind IN ('create', 'update', 'delete', 'rename', 'config', 'checkout', 'overflow', 'reconcile')),
          observed_mtime_ns TEXT,
          observed_sha TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (index_space_id, projection_kind, path),
          FOREIGN KEY (index_space_id, projection_kind)
            REFERENCES location_projection_registration(index_space_id, projection_kind) ON DELETE CASCADE
        )
      `)
    })
  },
} satisfies DatabaseMigration.Migration
