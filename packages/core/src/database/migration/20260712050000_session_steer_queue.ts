import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// V4.1 §S1.1: durable mid-turn steer queue. A separate, plain (non-event-sourced) buffer for user
// messages that arrive while a session is busy. The live turn loop (SessionPrompt.runLoop) drains it
// at each model-request boundary and persists each steer as an ordinary tail user message.
// Consume-once is enforced by `consumed_seq` (NULL == pending); `seq` is the per-session monotonic
// admission order used to drain in send-order.
export default {
  id: "20260712050000_session_steer_queue",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_steer\` (
          \`seq\` integer PRIMARY KEY AUTOINCREMENT,
          \`id\` text NOT NULL UNIQUE,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`consumed_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_steer_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_steer_session_pending_seq_idx\` ON \`session_steer\` (\`session_id\`,\`consumed_seq\`,\`seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
