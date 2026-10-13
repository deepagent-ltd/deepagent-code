import { Effect } from "effect"
import { getTableColumns, sql } from "drizzle-orm"
import { EventWorkCommandTable, EventWorkNodeAuthorityTable, EventWorkReceiptTable, EventWorkRuleTable } from "../../deepagent/event-work-rule.sql"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010132509_event_work_single_authority",
  up(tx) {
    return Effect.gen(function* () {
      if ((yield* tx.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys !== 1 ||
        (yield* tx.get<{ defer_foreign_keys: number }>("PRAGMA defer_foreign_keys"))?.defer_foreign_keys !== 0 ||
        (yield* tx.get("SELECT * FROM pragma_foreign_key_check LIMIT 1")))
        return yield* Effect.die("Event Work migration requires intact non-deferred FK-on storage")
      yield* tx.run(`
        CREATE TABLE \`event_work_command\` (
          \`command_id\` text PRIMARY KEY,
          \`instance_id\` text NOT NULL,
          \`operator_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`rule_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`record\` text NOT NULL,
          \`record_bytes\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_event_work_command_rule_id_event_work_rule_rule_id_fk\` FOREIGN KEY (\`rule_id\`) REFERENCES \`event_work_rule\`(\`rule_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT "event_work_command_record" CHECK(typeof("record_bytes")='integer' AND "record_bytes" BETWEEN 2 AND 131072 AND "record_bytes"=length(CAST("record" AS BLOB)) AND CASE WHEN typeof("record")='text' AND instr("record",char(0))=0 AND json_valid("record") THEN coalesce(json_type("record")='object' AND json_extract("record",'$.version')=1,0) ELSE 0 END),
          CONSTRAINT "event_work_command_action" CHECK("action" IN ('create','enable','pause','revoke') AND "created_at">0),
          CONSTRAINT "event_work_command_hash" CHECK(typeof("request_hash")='text' AND length("request_hash")=64 AND length(CAST("request_hash" AS BLOB))=64 AND "request_hash" NOT GLOB '*[^0-9a-f]*')
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_work_node_authority\` (
          \`authority_id\` text PRIMARY KEY,
          \`receipt_id\` text NOT NULL,
          \`node_id\` text NOT NULL,
          \`work_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`record\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`record_bytes\` integer NOT NULL,
          CONSTRAINT \`fk_event_work_node_authority_receipt_id_event_work_receipt_receipt_id_fk\` FOREIGN KEY (\`receipt_id\`) REFERENCES \`event_work_receipt\`(\`receipt_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT "event_work_node_record" CHECK(typeof("record_bytes")='integer' AND "record_bytes" BETWEEN 2 AND 131072 AND "record_bytes"=length(CAST("record" AS BLOB)) AND CASE WHEN typeof("record")='text' AND instr("record",char(0))=0 AND json_valid("record") THEN coalesce(json_type("record")='object' AND json_extract("record",'$.version')=1,0) ELSE 0 END),
          CONSTRAINT "event_work_node_state" CHECK("state" IN ('pending','bound','terminal')),
          CONSTRAINT "event_work_node_hash" CHECK(typeof("record_hash")='text' AND length("record_hash")=64 AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*')
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_work_receipt\` (
          \`receipt_id\` text PRIMARY KEY,
          \`rule_id\` text NOT NULL,
          \`instance_id\` text NOT NULL,
          \`occurrence_key\` text NOT NULL,
          \`event_id\` text NOT NULL,
          \`work_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`input_id\` text NOT NULL,
          \`phase\` text NOT NULL,
          \`binding_hash\` text,
          \`record\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`record_bytes\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT \`fk_event_work_receipt_rule_id_event_work_rule_rule_id_fk\` FOREIGN KEY (\`rule_id\`) REFERENCES \`event_work_rule\`(\`rule_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT "event_work_receipt_record" CHECK(typeof("record_bytes")='integer' AND "record_bytes" BETWEEN 2 AND 131072 AND "record_bytes"=length(CAST("record" AS BLOB)) AND CASE WHEN typeof("record")='text' AND instr("record",char(0))=0 AND json_valid("record") THEN coalesce(json_type("record")='object' AND json_extract("record",'$.version')=1,0) ELSE 0 END),
          CONSTRAINT "event_work_receipt_phase" CHECK("phase" IN ('observed','reserved','ready') AND (("phase"='observed' AND "binding_hash" IS NULL) OR ("phase"<>'observed' AND typeof("binding_hash")='text' AND length("binding_hash")=64 AND length(CAST("binding_hash" AS BLOB))=64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'))),
          CONSTRAINT "event_work_receipt_hashes" CHECK(typeof("occurrence_key")='text' AND length("occurrence_key")=64 AND length(CAST("occurrence_key" AS BLOB))=64 AND "occurrence_key" NOT GLOB '*[^0-9a-f]*' AND typeof("record_hash")='text' AND length("record_hash")=64 AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "event_work_receipt_mirrors" CHECK(json_extract("record",'$.receiptID') IS "receipt_id" AND json_extract("record",'$.ruleID') IS "rule_id" AND json_extract("record",'$.instanceID') IS "instance_id" AND json_extract("record",'$.eventID') IS "event_id" AND json_extract("record",'$.workID') IS "work_id" AND json_extract("record",'$.sessionID') IS "session_id" AND json_extract("record",'$.inputID') IS "input_id")
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_work_rule\` (
          \`rule_id\` text PRIMARY KEY,
          \`instance_id\` text NOT NULL,
          \`operator_id\` text NOT NULL,
          \`source_session_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`epoch\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`record\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`record_bytes\` integer NOT NULL,
          CONSTRAINT "event_work_rule_record" CHECK(typeof("record_bytes")='integer' AND "record_bytes" BETWEEN 2 AND 131072 AND "record_bytes"=length(CAST("record" AS BLOB)) AND CASE WHEN typeof("record")='text' AND instr("record",char(0))=0 AND json_valid("record") THEN coalesce(json_type("record")='object' AND json_extract("record",'$.version')=1,0) ELSE 0 END),
          CONSTRAINT "event_work_rule_revision" CHECK("revision">0 AND "epoch">0 AND "state" IN ('disabled','enabled','paused','revoked')),
          CONSTRAINT "event_work_rule_hash" CHECK(typeof("record_hash")='text' AND length("record_hash")=64 AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "event_work_rule_mirrors" CHECK(json_extract("record",'$.ruleID') IS "rule_id" AND json_extract("record",'$.instanceID') IS "instance_id" AND json_extract("record",'$.operatorID') IS "operator_id" AND json_extract("record",'$.origin.sourceSessionID') IS "source_session_id" AND json_extract("record",'$.revision') IS "revision" AND json_extract("record",'$.epoch') IS "epoch" AND json_extract("record",'$.state') IS "state")
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_work_command_request_idx\` ON \`event_work_command\` (\`instance_id\`,\`operator_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_work_node_slot_idx\` ON \`event_work_node_authority\` (\`receipt_id\`,\`node_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_work_node_work_idx\` ON \`event_work_node_authority\` (\`work_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_work_receipt_occurrence_idx\` ON \`event_work_receipt\` (\`instance_id\`,\`rule_id\`,\`occurrence_key\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_work_receipt_event_idx\` ON \`event_work_receipt\` (\`event_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_work_receipt_work_idx\` ON \`event_work_receipt\` (\`work_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_work_receipt_session_idx\` ON \`event_work_receipt\` (\`session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_work_receipt_input_idx\` ON \`event_work_receipt\` (\`input_id\`);`)
      yield* tx.run(`CREATE INDEX \`event_work_receipt_due_idx\` ON \`event_work_receipt\` (\`phase\`,\`created_at\`,\`receipt_id\`);`)
      yield* tx.run(`CREATE INDEX \`event_work_rule_source_idx\` ON \`event_work_rule\` (\`source_session_id\`,\`state\`);`)
      // Independent hard storage boundary. Count every table row and every actual persisted
      // UTF8 field/integer, including record/header copies. No caller can undercharge a row.
      const tables = [EventWorkRuleTable, EventWorkCommandTable, EventWorkReceiptTable, EventWorkNodeAuthorityTable]
      const names = ["event_work_rule", "event_work_command", "event_work_receipt", "event_work_node_authority"]
      const totals = names.map((name, index) => {
        const bytes = Object.values(getTableColumns(tables[index])).map((column) => column.dataType === "number"
          ? `CASE WHEN "${column.name}" IS NULL THEN 0 ELSE 8 END`
          : `coalesce(length(CAST("${column.name}" AS BLOB)),0)`).join("+")
        return `SELECT count(*) records,coalesce(sum(${bytes}),0) bytes FROM "${name}"`
      }).join(" UNION ALL ")
      for (const name of names) {
        for (const operation of ["INSERT", "UPDATE"]) {
          yield* tx.run(sql.raw(`CREATE TRIGGER "${name}_capacity_${operation.toLowerCase()}" AFTER ${operation} ON "${name}"
            BEGIN SELECT CASE WHEN (SELECT sum(records)>10000 OR sum(bytes)>268435456 FROM (${totals}))
              THEN RAISE(ABORT,'event_work_capacity_exceeded') END; END`))
        }
      }
      if (yield* tx.get("SELECT * FROM pragma_foreign_key_check LIMIT 1"))
        return yield* Effect.die("Event Work migration violates original foreign keys")
    })
  },
} satisfies DatabaseMigration.Migration
