import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260901181952_session_capability_load",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_capability_load\` (
          \`load_id\` text PRIMARY KEY,
          \`schema_version\` text NOT NULL,
          \`content_kind\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`activity_id\` text NOT NULL,
          \`turn_id\` text NOT NULL,
          \`catalog_snapshot_id\` text NOT NULL,
          \`pack_id\` text,
          \`capability_id\` text NOT NULL,
          \`version\` text NOT NULL,
          \`body_hash\` text NOT NULL,
          \`runtime_hash\` text NOT NULL,
          \`permission_hash\` text NOT NULL,
          \`permission_binding\` text NOT NULL,
          \`runtime_compatibility_hash\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`result_hash\` text NOT NULL,
          \`level\` text NOT NULL,
          \`body_ref\` text NOT NULL,
          \`supersedes\` text,
          \`token_count\` integer NOT NULL,
          \`byte_count\` integer NOT NULL,
          \`budget_state\` text NOT NULL,
          \`new_loads_this_turn\` integer NOT NULL,
          \`new_tokens_this_turn\` integer NOT NULL,
          \`context_epoch\` text NOT NULL,
          \`loaded_at\` integer NOT NULL,
          \`state\` text NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_capability_load_session_capability_body_idx\` ON \`session_capability_load\` (\`session_id\`,\`capability_id\`,\`body_hash\`);`)
      yield* tx.run(`CREATE INDEX \`session_capability_load_session_idx\` ON \`session_capability_load\` (\`session_id\`,\`loaded_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
