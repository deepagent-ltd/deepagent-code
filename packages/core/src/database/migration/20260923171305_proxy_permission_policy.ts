import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923171305_proxy_permission_policy",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`proxy_tenant\` ADD \`permission_policy\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
