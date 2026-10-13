import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261006235109_goal_tick_checkpoint",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`goal_tick_checkpoint\` (
          \`permit_id\` text PRIMARY KEY,
          \`goal_id\` text NOT NULL,
          \`tick_seq\` integer NOT NULL,
          \`version\` integer NOT NULL,
          \`revision\` integer NOT NULL,
          \`binding_hash\` text NOT NULL,
          \`role_manifest_hash\` text NOT NULL,
          \`parent_checked_through_seq\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`journal\` text NOT NULL,
          \`journal_hash\` text NOT NULL,
          \`logical_bytes\` integer NOT NULL,
          \`reserved_bytes\` integer NOT NULL,
          \`error_code\` text,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_goal_tick_checkpoint_permit_id_goal_tick_permit_permit_id_fk\` FOREIGN KEY (\`permit_id\`) REFERENCES \`goal_tick_permit\`(\`permit_id\`),
          CONSTRAINT \`fk_goal_tick_checkpoint_goal_id_goal_control_goal_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`goal_control\`(\`goal_id\`),
          CONSTRAINT "goal_tick_checkpoint_identity_check" CHECK("permit_id" IS NOT NULL AND typeof("permit_id")='text' AND typeof("goal_id")='text' AND length("permit_id") BETWEEN 1 AND 512 AND length("goal_id") BETWEEN 1 AND 512),
          CONSTRAINT "goal_tick_checkpoint_version_check" CHECK(typeof("version")='integer' AND "version"=1 AND typeof("revision")='integer' AND "revision" BETWEEN 0 AND 9007199254740991 AND typeof("tick_seq")='integer' AND "tick_seq" BETWEEN 0 AND 9007199254740991 AND typeof("parent_checked_through_seq")='integer' AND "parent_checked_through_seq" BETWEEN 0 AND 9007199254740991),
          CONSTRAINT "goal_tick_checkpoint_state_check" CHECK("state" IN ('prepared','running','mirror_pending','committed','halted','recovery_required')),
          CONSTRAINT "goal_tick_checkpoint_hash_check" CHECK(length("binding_hash")=64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*' AND length("role_manifest_hash")=64 AND "role_manifest_hash" NOT GLOB '*[^0-9a-f]*' AND length("journal_hash")=64 AND "journal_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "goal_tick_checkpoint_json_check" CHECK(json_valid("journal") AND json_type("journal")='object' AND length(CAST("journal" AS BLOB))<=1048576),
          CONSTRAINT "goal_tick_checkpoint_capacity_check" CHECK(typeof("logical_bytes")='integer' AND typeof("reserved_bytes")='integer' AND "logical_bytes"=length(CAST("journal" AS BLOB)) AND "logical_bytes" BETWEEN 2 AND 1048576 AND "reserved_bytes">="logical_bytes" AND "reserved_bytes"<=1048576),
          CONSTRAINT "goal_tick_checkpoint_error_check" CHECK("error_code" IS NULL OR length("error_code")<=128),
          CONSTRAINT "goal_tick_checkpoint_time_check" CHECK(typeof("created_at")='integer' AND typeof("updated_at")='integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND "updated_at" BETWEEN "created_at" AND 9007199254740991)
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`goal_tick_checkpoint_goal_tick_idx\` ON \`goal_tick_checkpoint\` (\`goal_id\`,\`tick_seq\`);`)
      yield* tx.run(`CREATE INDEX \`goal_tick_checkpoint_state_idx\` ON \`goal_tick_checkpoint\` (\`state\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
