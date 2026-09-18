/**
 * P0-4: durable command side-effect receipts.
 *
 * command() previously executed `!`-shell template blocks and the
 * command.execute.before plugin trigger BEFORE any durable record existed — a crash
 * in between left no evidence the OS/plugin effect had run, so a retry blindly
 * re-executed it. This table turns every write-class command side effect into a
 * receipted operation: an intent row is committed first (status pending), the effect
 * executes, then the outcome settles (settled_ok | settled_error). A crash between
 * intent and settle leaves the pending row as a queryable UNKNOWN outcome that
 * retries quarantine (status unknown) instead of re-executing.
 *
 * Identity: (operation_key, attempt). operation_key is a deterministic hash of the
 * session + command identity + effect payload, so a duplicate delivery of the same
 * command reuses the settled outcome without re-execution. `attempt` is the explicit
 * force re-run dimension: forcing bumps the attempt and starts a fresh receipted
 * execution while the prior attempt rows stay as append-only audit.
 */
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918130000_command_side_effect_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`command_side_effect_receipt\` (
          \`operation_key\` text NOT NULL,
          \`attempt\` integer NOT NULL,
          \`session_id\` text NOT NULL,
          \`kind\` text NOT NULL CHECK (kind IN ('shell', 'plugin_hook')),
          \`status\` text NOT NULL CHECK (status IN ('pending', 'unknown', 'settled_ok', 'settled_error')),
          \`effect_payload\` text NOT NULL,
          \`output\` text,
          \`error\` text,
          \`exit_code\` integer,
          \`owner_token\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_settled\` integer,
          PRIMARY KEY (\`operation_key\`, \`attempt\`)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`command_side_effect_receipt_session_idx\` ON \`command_side_effect_receipt\` (\`session_id\`, \`time_created\`);`,
      )
      yield* tx.run(`
        CREATE TRIGGER command_side_effect_receipt_insert_guard
        BEFORE INSERT ON command_side_effect_receipt
        WHEN length(trim(NEW.operation_key)) = 0
          OR NEW.attempt < 1
          OR length(trim(NEW.session_id)) = 0
          OR NEW.kind NOT IN ('shell', 'plugin_hook')
          OR NEW.status NOT IN ('pending')
          OR length(trim(NEW.effect_payload)) = 0
          OR length(trim(NEW.owner_token)) = 0
        BEGIN
          SELECT RAISE(ABORT, 'invalid command side effect receipt');
        END
      `)
      // Identity columns and time_created are immutable; settlement is monotonic:
      // pending may become unknown (quarantine) or settled_*, unknown may still
      // settle (the original executor records its outcome), settled is terminal.
      yield* tx.run(`
        CREATE TRIGGER command_side_effect_receipt_update_guard
        BEFORE UPDATE ON command_side_effect_receipt
        WHEN NEW.operation_key != OLD.operation_key
          OR NEW.attempt != OLD.attempt
          OR NEW.session_id != OLD.session_id
          OR NEW.kind != OLD.kind
          OR NEW.effect_payload != OLD.effect_payload
          OR NEW.owner_token != OLD.owner_token
          OR NEW.time_created != OLD.time_created
          OR NEW.status NOT IN ('unknown', 'settled_ok', 'settled_error')
          OR (OLD.status IN ('settled_ok', 'settled_error') AND NEW.status != OLD.status)
        BEGIN
          SELECT RAISE(ABORT, 'command side effect receipt identity is immutable and settlement is terminal');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER command_side_effect_receipt_delete_guard
        BEFORE DELETE ON command_side_effect_receipt
        BEGIN
          SELECT RAISE(ABORT, 'command side effect receipt is append only');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
