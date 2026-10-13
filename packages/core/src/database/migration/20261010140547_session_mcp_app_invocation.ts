import { Effect } from "effect"
import { getTableColumns, sql } from "drizzle-orm"
import { McpAppEffectTable, McpAppInvocationTable } from "../../session/mcp-app-invocation.sql"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010140547_session_mcp_app_invocation",
  up(tx) {
    return Effect.gen(function* () {
      if ((yield* tx.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys !== 1 ||
        (yield* tx.get<{ defer_foreign_keys: number }>("PRAGMA defer_foreign_keys"))?.defer_foreign_keys !== 0 ||
        (yield* tx.get("SELECT * FROM pragma_foreign_key_check LIMIT 1")))
        return yield* Effect.die("MCP Apps migration requires intact non-deferred FK-on storage")
      yield* tx.run(`
        CREATE TABLE \`session_mcp_app_effect\` (
          \`invocation_id\` text PRIMARY KEY,
          \`state\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`owner_nonce\` text,
          \`session_claim_token\` integer,
          \`permission\` text,
          \`reserved_bytes\` integer DEFAULT 0 NOT NULL,
          \`dispatched_at\` integer,
          \`terminal_at\` integer,
          \`result\` text,
          \`result_hash\` text,
          \`result_bytes\` integer DEFAULT 0 NOT NULL,
          \`result_retired_at\` integer,
          \`error_code\` text,
          CONSTRAINT \`fk_session_mcp_app_effect_invocation_id_session_mcp_app_invocation_invocation_id_fk\` FOREIGN KEY (\`invocation_id\`) REFERENCES \`session_mcp_app_invocation\`(\`invocation_id\`) ON DELETE RESTRICT,
          CONSTRAINT "session_mcp_app_effect_state_check" CHECK("state" IN ('queued','awaiting_permission','dispatching','settled','failed','cancelled_before_dispatch','unknown') AND "revision">0 AND "reserved_bytes" BETWEEN 0 AND 8388608 AND "result_bytes" BETWEEN 0 AND 8388608),
          CONSTRAINT "session_mcp_app_effect_dispatch_check" CHECK(("state" IN ('queued','awaiting_permission','cancelled_before_dispatch') AND "dispatched_at" IS NULL AND "owner_nonce" IS NULL AND "session_claim_token" IS NULL) OR ("state" IN ('dispatching','settled','failed','unknown') AND "dispatched_at" IS NOT NULL AND "owner_nonce" IS NOT NULL AND "session_claim_token">0)),
          CONSTRAINT "session_mcp_app_effect_result_check" CHECK(("result" IS NULL AND "result_bytes"=0) OR ("result" IS NOT NULL AND json_valid("result") AND json_type("result")='object' AND length(CAST("result" AS BLOB))="result_bytes" AND length("result_hash")=64 AND "state" IN ('settled','failed') AND "result_retired_at" IS NULL)),
          CONSTRAINT "session_mcp_app_effect_custody_check" CHECK(("state" IN ('queued','awaiting_permission','cancelled_before_dispatch') AND "reserved_bytes"=0 AND "result_hash" IS NULL AND "result_retired_at" IS NULL) OR ("state"='dispatching' AND "reserved_bytes"=8388608 AND "result_hash" IS NULL AND "result_retired_at" IS NULL) OR ("state"='unknown' AND "reserved_bytes"=8388608 AND "result" IS NULL AND "result_hash" IS NULL AND "result_retired_at" IS NULL) OR ("state" IN ('settled','failed') AND "reserved_bytes"=0 AND ("result_hash" IS NULL OR length("result_hash")=64) AND ("result_retired_at" IS NULL OR ("result" IS NULL AND "result_hash" IS NOT NULL)))),
          CONSTRAINT "session_mcp_app_effect_permission_check" CHECK("permission" IS NULL OR (json_valid("permission") AND json_type("permission")='object' AND length(CAST("permission" AS BLOB)) BETWEEN 1 AND 4096)),
          CONSTRAINT "session_mcp_app_effect_terminal_check" CHECK(("state" IN ('queued','awaiting_permission','dispatching') AND "terminal_at" IS NULL) OR ("state" IN ('settled','failed','cancelled_before_dispatch','unknown') AND "terminal_at" IS NOT NULL))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_mcp_app_invocation\` (
          \`invocation_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`view_id\` text NOT NULL,
          \`rpc_id\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`source_kind\` text NOT NULL,
          \`source\` text NOT NULL,
          \`source_hash\` text NOT NULL,
          \`input_hash\` text NOT NULL,
          \`arguments\` text,
          \`arguments_bytes\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`arguments_retired_at\` integer,
          CONSTRAINT \`fk_session_mcp_app_invocation_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT "session_mcp_app_invocation_source_check" CHECK("source_kind"='mcp_app' AND json_valid("source") AND length(CAST("source" AS BLOB)) BETWEEN 1 AND 16384 AND json_extract("source", '$.kind')='mcp_app' AND json_extract("source", '$.sessionID')="session_id" AND json_extract("source", '$.viewID')="view_id" AND length("source_hash")=64 AND length("input_hash")=64 AND "expires_at">"created_at" AND "expires_at"<=json_extract("source", '$.expiresAt') AND "admitted_seq">=0),
          CONSTRAINT "session_mcp_app_invocation_body_check" CHECK(("arguments" IS NOT NULL AND json_valid("arguments") AND json_type("arguments")='object' AND length(CAST("arguments" AS BLOB))="arguments_bytes" AND "arguments_bytes" BETWEEN 2 AND 32768 AND "arguments_retired_at" IS NULL) OR ("arguments" IS NULL AND "arguments_bytes"=0 AND "arguments_retired_at" IS NOT NULL))
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_mcp_app_effect_pending_idx\` ON \`session_mcp_app_effect\` (\`state\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_mcp_app_invocation_rpc_idx\` ON \`session_mcp_app_invocation\` (\`view_id\`,\`rpc_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_mcp_app_invocation_session_idx\` ON \`session_mcp_app_invocation\` (\`session_id\`,\`admitted_seq\`);`)
      yield* tx.run(`CREATE TRIGGER session_mcp_app_invocation_initial BEFORE INSERT ON session_mcp_app_invocation
        WHEN NEW.arguments IS NULL OR NEW.arguments_retired_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'mcp_app_initial_body_required'); END`)
      const identities = ["invocation_id", "session_id", "view_id", "rpc_id", "admitted_seq", "source_kind", "source",
        "source_hash", "input_hash", "created_at", "expires_at"]
      yield* tx.run(sql.raw(`CREATE TRIGGER session_mcp_app_invocation_identity BEFORE UPDATE ON session_mcp_app_invocation
        WHEN ${identities.map((field) => `NEW."${field}" IS NOT OLD."${field}"`).join(" OR ")}
        BEGIN SELECT RAISE(ABORT,'mcp_app_identity_immutable'); END`))
      yield* tx.run(`CREATE TRIGGER session_mcp_app_invocation_retirement BEFORE UPDATE ON session_mcp_app_invocation
        WHEN (NEW.arguments IS NOT OLD.arguments OR NEW.arguments_bytes IS NOT OLD.arguments_bytes OR
          NEW.arguments_retired_at IS NOT OLD.arguments_retired_at) AND NOT (
          OLD.arguments IS NOT NULL AND OLD.arguments_retired_at IS NULL AND NEW.arguments IS NULL AND
          NEW.arguments_bytes=0 AND NEW.arguments_retired_at IS NOT NULL AND EXISTS (
            SELECT 1 FROM session_mcp_app_effect e WHERE e.invocation_id=OLD.invocation_id AND
              e.state IN ('settled','failed','cancelled_before_dispatch') AND e.terminal_at IS NOT NULL AND
              e.terminal_at+86400000<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AND
              NEW.arguments_retired_at>=e.terminal_at+86400000))
        BEGIN SELECT RAISE(ABORT,'mcp_app_argument_retirement_refused'); END`)
      yield* tx.run(`CREATE TRIGGER session_mcp_app_effect_initial BEFORE INSERT ON session_mcp_app_effect
        WHEN NEW.state IS NOT 'queued' OR NEW.revision IS NOT 1 OR NEW.owner_nonce IS NOT NULL OR
          NEW.session_claim_token IS NOT NULL OR NEW.permission IS NOT NULL OR NEW.reserved_bytes IS NOT 0 OR
          NEW.dispatched_at IS NOT NULL OR NEW.terminal_at IS NOT NULL OR NEW.result IS NOT NULL OR
          NEW.result_hash IS NOT NULL OR NEW.result_bytes IS NOT 0 OR NEW.result_retired_at IS NOT NULL OR NEW.error_code IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'mcp_app_initial_state_required'); END`)
      const terminal = ["state", "revision", "owner_nonce", "session_claim_token", "permission", "reserved_bytes",
        "dispatched_at", "terminal_at", "result_hash", "error_code"]
      yield* tx.run(sql.raw(`CREATE TRIGGER session_mcp_app_effect_transition BEFORE UPDATE ON session_mcp_app_effect
        WHEN NEW.invocation_id IS NOT OLD.invocation_id OR
          (OLD.state IN ('settled','failed','cancelled_before_dispatch','unknown') AND
            (${terminal.map((field) => `NEW."${field}" IS NOT OLD."${field}"`).join(" OR ")})) OR
          (OLD.state IN ('queued','awaiting_permission','dispatching') AND
            (NEW.revision IS NOT OLD.revision+1 OR NOT (
              (OLD.state='queued' AND NEW.state IN ('awaiting_permission','dispatching','cancelled_before_dispatch')) OR
              (OLD.state='awaiting_permission' AND NEW.state IN ('dispatching','cancelled_before_dispatch')) OR
              (OLD.state='dispatching' AND NEW.state IN ('settled','failed','unknown'))))) OR
          (OLD.dispatched_at IS NOT NULL AND (NEW.dispatched_at IS NOT OLD.dispatched_at OR
            NEW.owner_nonce IS NOT OLD.owner_nonce OR NEW.session_claim_token IS NOT OLD.session_claim_token OR
            NEW.permission IS NOT OLD.permission))
        BEGIN SELECT RAISE(ABORT,'mcp_app_effect_transition_refused'); END`))
      yield* tx.run(`CREATE TRIGGER session_mcp_app_effect_retirement BEFORE UPDATE ON session_mcp_app_effect
        WHEN (NEW.result IS NOT OLD.result OR NEW.result_hash IS NOT OLD.result_hash OR
          NEW.result_bytes IS NOT OLD.result_bytes OR NEW.result_retired_at IS NOT OLD.result_retired_at) AND NOT (
          (OLD.state='dispatching' AND NEW.state IN ('settled','failed') AND OLD.result IS NULL AND
            OLD.result_hash IS NULL AND OLD.result_retired_at IS NULL AND NEW.result_retired_at IS NULL) OR
          (OLD.state IN ('settled','failed') AND NEW.state=OLD.state AND OLD.result IS NOT NULL AND
            OLD.result_retired_at IS NULL AND NEW.result IS NULL AND NEW.result_bytes=0 AND
            NEW.result_hash=OLD.result_hash AND NEW.result_retired_at IS NOT NULL AND OLD.terminal_at IS NOT NULL AND
            OLD.terminal_at+86400000<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AND
            NEW.result_retired_at>=OLD.terminal_at+86400000))
        BEGIN SELECT RAISE(ABORT,'mcp_app_result_retirement_refused'); END`)
      const tables = [McpAppInvocationTable, McpAppEffectTable]
      const names = ["session_mcp_app_invocation", "session_mcp_app_effect"]
      const totals = names.map((name, index) => {
        const bytes = Object.values(getTableColumns(tables[index])).map((column) => column.dataType === "number"
          ? `CASE WHEN "${column.name}" IS NULL THEN 0 ELSE 8 END`
          : `coalesce(length(CAST("${column.name}" AS BLOB)),0)`).join("+")
        return `SELECT coalesce(sum(${bytes}${index === 1 ? "+reserved_bytes" : ""}),0) bytes FROM "${name}"`
      }).join(" UNION ALL ")
      yield* Effect.forEach(names, (name) => Effect.gen(function* () {
        yield* tx.run(sql.raw(`CREATE TRIGGER "${name}_no_delete" BEFORE DELETE ON "${name}"
          BEGIN SELECT RAISE(ABORT,'mcp_app_receipt_retained'); END`))
        yield* Effect.forEach(["INSERT", "UPDATE"], (operation) => tx.run(sql.raw(
          `CREATE TRIGGER "${name}_capacity_${operation.toLowerCase()}" AFTER ${operation} ON "${name}"
            BEGIN SELECT CASE WHEN
              (SELECT sum(bytes)>67108864 FROM (${totals})) OR
              (SELECT count(*)>100000 FROM session_mcp_app_invocation) OR
              (SELECT count(*)>64 FROM session_mcp_app_effect WHERE state IN ('queued','awaiting_permission','dispatching','unknown')) OR
              EXISTS (SELECT 1 FROM session_mcp_app_effect e JOIN session_mcp_app_invocation i ON i.invocation_id=e.invocation_id
                WHERE e.state IN ('queued','awaiting_permission','dispatching','unknown') GROUP BY i.session_id HAVING count(*)>8)
              THEN RAISE(ABORT,'mcp_app_capacity_exceeded') END; END`)), { discard: true })
      }), { discard: true })
      if (yield* tx.get("SELECT * FROM pragma_foreign_key_check LIMIT 1"))
        return yield* Effect.die("MCP Apps migration violates original foreign keys")
    })
  },
} satisfies DatabaseMigration.Migration
