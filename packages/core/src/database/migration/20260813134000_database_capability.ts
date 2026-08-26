import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260813134000_database_capability",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE database_capability (
          capability TEXT NOT NULL PRIMARY KEY,
          minimum_reader_protocol INTEGER NOT NULL CHECK (minimum_reader_protocol >= 1),
          minimum_writer_protocol INTEGER NOT NULL CHECK (minimum_writer_protocol >= minimum_reader_protocol),
          installed_at INTEGER NOT NULL
        )
      `)
      yield* tx.run(`
        INSERT INTO database_capability(
          capability, minimum_reader_protocol, minimum_writer_protocol, installed_at
        ) VALUES (
          'bounded_event_snapshot_v1', 2, 2, unixepoch('subsec') * 1000
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER database_capability_immutable_update
        BEFORE UPDATE ON database_capability
        BEGIN
          SELECT RAISE(ABORT, 'database_capability_immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER database_capability_immutable_delete
        BEFORE DELETE ON database_capability
        BEGIN
          SELECT RAISE(ABORT, 'database_capability_immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
