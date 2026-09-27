import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923183309_v2_session_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`v2_authority\` integer DEFAULT false NOT NULL;`)
      // Historical native V2 creation facts establish authority. A shared V1 row alone does not.
      yield* tx.run(`
        UPDATE session SET v2_authority = 1
        WHERE EXISTS (
          SELECT 1 FROM event
          WHERE event.aggregate_id = session.id AND event.type = 'session.created.2'
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
