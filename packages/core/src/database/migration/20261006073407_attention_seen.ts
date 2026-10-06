import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261006073407_attention_seen",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`attention_seen\` (
          \`scope_key\` text NOT NULL,
          \`actor_id\` text NOT NULL,
          \`item_id\` text NOT NULL,
          \`source_revision\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`seen_at\` integer NOT NULL,
          CONSTRAINT \`attention_seen_pk\` PRIMARY KEY(\`scope_key\`, \`actor_id\`, \`item_id\`, \`source_revision\`),
          CONSTRAINT \`fk_attention_seen_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // session-sql.ts is maintained by the authoritative migration chain and
      // intentionally excluded from the generated Drizzle snapshot.
      yield* tx.run(`
        CREATE INDEX session_activity_attention_failed_idx
        ON session_activity (coalesce(settled_at, created_at) DESC, activity_id)
        WHERE state = 'failed'
      `)
    })
  },
} satisfies DatabaseMigration.Migration
