import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260922182048_v2_task_call_admission",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_v2_task_call_admission\` (
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`tool_call_id\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_session_v2_task_call_admission_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_v2_task_call_admission_tool_call_idx\` ON \`session_v2_task_call_admission\` (\`tool_call_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_v2_task_call_admission_batch_idx\` ON \`session_v2_task_call_admission\` (\`session_id\`,\`assistant_message_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
