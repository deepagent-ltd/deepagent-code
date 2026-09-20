import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260910012502_v2_compaction_request",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_v2_compaction_request\` (
          \`request_id\` text PRIMARY KEY CHECK(length(\`request_id\`) = 37 AND substr(\`request_id\`, 1, 5) = 'v2cr_' AND substr(\`request_id\`, 6) NOT GLOB '*[^0-9a-f]*'),
          \`session_id\` text NOT NULL CHECK(length(trim(\`session_id\`)) > 0),
          \`provider_id\` text NOT NULL CHECK(length(trim(\`provider_id\`)) > 0),
          \`model_id\` text NOT NULL CHECK(length(trim(\`model_id\`)) > 0),
          \`fence_message_count\` integer NOT NULL CHECK(\`fence_message_count\` >= 0),
          \`fence_last_message_id\` text NOT NULL CHECK(length(trim(\`fence_last_message_id\`)) > 0),
          \`status\` text NOT NULL CHECK(\`status\` IN ('pending', 'dispatched', 'settled', 'recovery_required', 'failed')),
          \`outcome\` text,
          \`summary_receipt_id\` text,
          \`created_at\` integer NOT NULL,
          \`settled_at\` integer CHECK((\`status\` IN ('pending', 'dispatched') AND \`settled_at\` IS NULL) OR (\`status\` IN ('settled', 'recovery_required', 'failed') AND \`settled_at\` IS NOT NULL AND \`outcome\` IS NOT NULL))
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_v2_compaction_request_session_idx\` ON \`session_v2_compaction_request\` (\`session_id\`,\`created_at\`);`)
      yield* tx.run(`CREATE INDEX \`session_v2_compaction_request_status_idx\` ON \`session_v2_compaction_request\` (\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
