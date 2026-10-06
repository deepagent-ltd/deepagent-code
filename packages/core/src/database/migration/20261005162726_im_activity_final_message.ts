import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// session_activity belongs to the hand-authored federation migration chain, outside Drizzle's
// schema glob. Existing settled rows intentionally keep NULL: their final message cannot be guessed.
export default {
  id: "20261005162726_im_activity_final_message",
  up(tx) {
    return Effect.gen(function* () {
      const columns = yield* tx.all<{ name: string }>("PRAGMA table_info(session_activity)")
      if (!columns.some((column) => column.name === "final_message_id"))
        yield* tx.run("ALTER TABLE session_activity ADD COLUMN final_message_id TEXT")
    })
  },
} satisfies DatabaseMigration.Migration
