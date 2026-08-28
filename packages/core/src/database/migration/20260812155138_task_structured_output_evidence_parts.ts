import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812155138_task_structured_output_evidence_parts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`task_structured_output_evidence_part\` (
          \`run_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`part_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`part_json\` text NOT NULL,
          CONSTRAINT \`task_structured_output_evidence_part_pk\` PRIMARY KEY(\`run_id\`, \`role\`, \`part_id\`),
          CONSTRAINT \`fk_task_structured_output_evidence_part_run_id_task_structured_output_evidence_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`task_structured_output_evidence\`(\`run_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`task_structured_output_evidence_part_ordinal_idx\` ON \`task_structured_output_evidence_part\` (\`run_id\`,\`role\`,\`ordinal\`);`)
      yield* tx.run(`CREATE INDEX \`task_structured_output_evidence_part_part_idx\` ON \`task_structured_output_evidence_part\` (\`part_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
