import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803000000_time_suspended",
  up: (tx) =>
    Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`time_suspended\` integer;`)
      yield* tx.run(
        `CREATE INDEX \`session_time_suspended_idx\` ON \`session\` (\`time_suspended\`) WHERE "session"."time_suspended" is not null;`,
      )
    }),
} satisfies DatabaseMigration.Migration
