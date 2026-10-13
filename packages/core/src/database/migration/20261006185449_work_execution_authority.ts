import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261006185449_work_execution_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_dispatch_reservation\` (
          \`reservation_id\` text PRIMARY KEY,
          \`work_id\` text NOT NULL,
          \`root_work_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`dispatch_key\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`receipt_id\` text NOT NULL,
          \`attempt_id\` text NOT NULL,
          \`session_claim_token\` integer NOT NULL,
          \`owner_token\` text NOT NULL,
          \`control_revision\` integer NOT NULL,
          \`context_selection_id\` text NOT NULL,
          \`context_projection_hash\` text NOT NULL,
          \`state\` text NOT NULL,
          \`input_bound\` text NOT NULL,
          \`reserved_input_tokens\` integer NOT NULL,
          \`reserved_completion_tokens\` integer NOT NULL,
          \`reserved_total_tokens\` integer NOT NULL,
          \`actual_usage\` text,
          \`charged_tokens\` integer NOT NULL,
          \`wire_hash\` text,
          \`endpoint\` text,
          \`error_code\` text,
          \`created_at\` integer NOT NULL,
          \`dispatching_at\` integer,
          \`settled_at\` integer,
          CONSTRAINT "work_dispatch_kind_check" CHECK("kind" = 'provider'),
          CONSTRAINT "work_dispatch_state_check" CHECK("state" IN ('reserved','dispatching','settled','released','unknown')),
          CONSTRAINT "work_dispatch_tokens_check" CHECK("reserved_input_tokens" >= 0 AND "reserved_completion_tokens" >= 0 AND "reserved_total_tokens" = "reserved_input_tokens" + "reserved_completion_tokens" AND "charged_tokens" >= 0),
          CONSTRAINT "work_dispatch_revision_check" CHECK("control_revision" > 0 AND "session_claim_token" > 0),
          CONSTRAINT "work_dispatch_seal_check" CHECK("state" NOT IN ('dispatching','settled','unknown') OR ("wire_hash" IS NOT NULL AND "endpoint" IS NOT NULL AND "dispatching_at" IS NOT NULL))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`work_execution\` (
          \`work_id\` text PRIMARY KEY,
          \`root_work_id\` text NOT NULL,
          \`parent_work_id\` text,
          \`session_id\` text NOT NULL,
          \`input_id\` text NOT NULL,
          \`source_kind\` text NOT NULL,
          \`authority_id\` text NOT NULL,
          \`source_request_id\` text NOT NULL,
          \`source_revision\` integer NOT NULL,
          \`source_record_hash\` text NOT NULL,
          \`route_evidence_hash\` text NOT NULL,
          \`binding_hash\` text NOT NULL,
          \`binding\` text NOT NULL,
          \`security_namespace_id\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`admission_state\` text NOT NULL,
          \`control_state\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`control_revision\` integer NOT NULL,
          \`control_receipts\` text NOT NULL,
          \`admitted_seq\` integer,
          \`loopback_http\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT "work_execution_revision_check" CHECK("source_revision" > 0 AND "control_revision" > 0),
          CONSTRAINT "work_execution_admission_check" CHECK("admission_state" IN ('reserved','ready','rejected')),
          CONSTRAINT "work_execution_control_check" CHECK("control_state" IN ('active','paused','revoked','cancelled','expired')),
          CONSTRAINT "work_execution_outcome_check" CHECK("outcome" IN ('pending','succeeded','failed','unknown')),
          CONSTRAINT "work_execution_source_check" CHECK("source_kind" IN ('server_operator','server_rule')),
          CONSTRAINT "work_execution_binding_check" CHECK(json_valid("binding") AND length("binding_hash") = 64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_execution_ready_check" CHECK("admission_state" != 'ready' OR "admitted_seq" IS NOT NULL)
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_dispatch_key_idx\` ON \`work_dispatch_reservation\` (\`work_id\`,\`kind\`,\`dispatch_key\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_dispatch_receipt_idx\` ON \`work_dispatch_reservation\` (\`receipt_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_dispatch_attempt_idx\` ON \`work_dispatch_reservation\` (\`attempt_id\`);`)
      yield* tx.run(`CREATE INDEX \`work_dispatch_root_idx\` ON \`work_dispatch_reservation\` (\`root_work_id\`,\`state\`);`)
      yield* tx.run(`CREATE INDEX \`work_dispatch_work_time_idx\` ON \`work_dispatch_reservation\` (\`work_id\`,\`created_at\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_execution_session_idx\` ON \`work_execution\` (\`session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_execution_input_idx\` ON \`work_execution\` (\`input_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_execution_request_idx\` ON \`work_execution\` (\`source_kind\`,\`authority_id\`,\`source_request_id\`);`)
      yield* tx.run(`CREATE INDEX \`work_execution_root_idx\` ON \`work_execution\` (\`root_work_id\`);`)
      yield* tx.run(`CREATE INDEX \`work_execution_hour_idx\` ON \`work_execution\` (\`security_namespace_id\`,\`agent_id\`,\`created_at\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
