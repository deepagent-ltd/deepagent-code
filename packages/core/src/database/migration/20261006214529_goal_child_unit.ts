import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261006214529_goal_child_unit",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`goal_child_unit\` (
          \`unit_id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`permit_id\` text NOT NULL,
          \`role_key\` text NOT NULL,
          \`parent_session_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`binding\` text NOT NULL,
          \`binding_hash\` text NOT NULL,
          \`state\` text NOT NULL,
          \`creation_receipt\` text,
          \`inputs\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_goal_child_unit_goal_id_goal_control_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal_control\`(\`goal_id\`),
          CONSTRAINT \`fk_goal_child_unit_permit_id_goal_tick_permit_permit_id_fk\` FOREIGN KEY (\`permit_id\`) REFERENCES \`goal_tick_permit\`(\`permit_id\`),
          CONSTRAINT "goal_child_unit_state_check" CHECK("state" IN ('reserved','admitted','result_recorded','cancelled_before_dispatch','recovery_required')),
          CONSTRAINT "goal_child_unit_binding_check" CHECK(json_valid("binding") AND json_type("binding") = 'object'),
          CONSTRAINT "goal_child_unit_binding_hash_check" CHECK(length("binding_hash") = 64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "goal_child_unit_inputs_check" CHECK(json_valid("inputs") AND json_type("inputs") = 'array' AND json_array_length("inputs") <= 3),
          CONSTRAINT "goal_child_unit_creation_check" CHECK("creation_receipt" IS NULL OR (json_valid("creation_receipt") AND json_type("creation_receipt") = 'object'))
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`goal_child_unit_role_idx\` ON \`goal_child_unit\` (\`permit_id\`,\`role_key\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`goal_child_unit_session_idx\` ON \`goal_child_unit\` (\`child_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`goal_child_unit_goal_idx\` ON \`goal_child_unit\` (\`goal_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
