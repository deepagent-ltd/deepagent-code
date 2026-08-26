import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260709000000_add_session_preview",
  up(tx) {
    return Effect.gen(function* () {
      if (
        (yield* tx.all<{ name: string }>(`PRAGMA table_info(\`session\`)`)).some((column) => column.name === "preview")
      )
        return
      yield* tx.run(`ALTER TABLE \`session\` ADD \`preview\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
