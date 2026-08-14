import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812184453_charming_anthem",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`task_structured_finalizer_response\` (
          \`run_id\` text NOT NULL,
          \`attempt\` integer NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`owner_token\` text NOT NULL,
          \`claim_generation\` integer NOT NULL,
          \`expected_version\` integer NOT NULL,
          \`source_message_id\` text NOT NULL,
          \`request_message_id\` text NOT NULL,
          \`response_message_id\` text NOT NULL,
          \`response_message_json\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`task_structured_finalizer_response_pk\` PRIMARY KEY(\`run_id\`, \`attempt\`),
          CONSTRAINT \`fk_task_structured_finalizer_response_run_id_task_run_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`task_run\`(\`run_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`learning_job\` ADD \`expected_result_ref\` text;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`task_structured_finalizer_response_message_idx\` ON \`task_structured_finalizer_response\` (\`response_message_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
