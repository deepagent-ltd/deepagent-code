import { Effect } from "effect"
import { getTableColumns, sql } from "drizzle-orm"
import { EventWorkCommandTable, EventWorkNodeAuthorityTable, EventWorkReceiptTable, EventWorkRuleTable } from "../../deepagent/event-work-rule.sql"
import { EventWorkControllerTable } from "../../deepagent/event-work-controller.sql"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010144902_event_work_dag_controller",
  up(tx) {
    return Effect.gen(function* () {
      if ((yield* tx.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys !== 1 ||
        (yield* tx.get<{ defer_foreign_keys: number }>("PRAGMA defer_foreign_keys"))?.defer_foreign_keys !== 0 ||
        (yield* tx.get("SELECT * FROM pragma_foreign_key_check LIMIT 1")))
        return yield* Effect.die("Event DAG migration requires intact non-deferred FK-on storage")
      yield* tx.run(`
        CREATE TABLE \`event_work_controller\` (
          \`controller_id\` text PRIMARY KEY,
          \`receipt_id\` text NOT NULL,
          \`root_work_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`record\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`record_bytes\` integer NOT NULL,
          CONSTRAINT \`fk_event_work_controller_receipt_id_event_work_receipt_receipt_id_fk\` FOREIGN KEY (\`receipt_id\`) REFERENCES \`event_work_receipt\`(\`receipt_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT "event_work_controller_state" CHECK("revision">0 AND "state" IN ('pending','running','succeeded','failed','unknown')),
          CONSTRAINT "event_work_controller_body" CHECK(typeof("record")='text' AND instr("record",char(0))=0 AND
            typeof("record_bytes")='integer' AND "record_bytes" BETWEEN 2 AND 131072 AND
            "record_bytes"=length(CAST("record" AS BLOB)) AND CASE WHEN json_valid("record") THEN
            coalesce(json_type("record")='object' AND json_extract("record",'$.version')=1 AND
              json_extract("record",'$.controllerID') IS "controller_id" AND
              json_extract("record",'$.receiptID') IS "receipt_id" AND
              json_extract("record",'$.rootWorkID') IS "root_work_id" AND
              json_extract("record",'$.revision') IS "revision" AND
              json_extract("record",'$.state') IS "state",0) ELSE 0 END),
          CONSTRAINT "event_work_controller_hash" CHECK(typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64
            AND "record_hash" NOT GLOB '*[^0-9a-f]*')
        );
      `)
      // ADD COLUMN preserves every original trigger/index and incoming FK action. No parent
      // rebuild, implicit DELETE or foreign_keys/defer toggle is needed for a defaulted role.
      yield* tx.run(`ALTER TABLE work_execution ADD COLUMN execution_role text DEFAULT 'agent' NOT NULL
        CONSTRAINT work_execution_role_check CHECK(execution_role='agent' OR (execution_role='dag_controller'
          AND parent_work_id IS NULL AND root_work_id=work_id AND source_kind='server_rule'
          AND json_extract(binding,'$.profile.id')='event_deepseek_dag_v1'))`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_work_controller_receipt_idx\` ON \`event_work_controller\` (\`receipt_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_work_controller_root_idx\` ON \`event_work_controller\` (\`root_work_id\`);`)
      yield* tx.run(`CREATE INDEX \`event_work_controller_state_idx\` ON \`event_work_controller\` (\`state\`,\`controller_id\`);`)
      yield* tx.run(`CREATE TRIGGER work_execution_role_immutable BEFORE UPDATE ON work_execution
        WHEN NEW.execution_role IS NOT OLD.execution_role
        BEGIN SELECT RAISE(ABORT,'event_dag_role_immutable'); END`)
      const identities = ["controllerID", "receiptID", "rootWorkID", "rootSessionID", "rootInputID", "rootBindingHash", "plan", "planHash", "ruleHash", "epoch", "createdAt", "expiresAt"]
      yield* tx.run(sql.raw(`CREATE TRIGGER event_work_controller_identity BEFORE UPDATE ON event_work_controller
        WHEN NEW.controller_id IS NOT OLD.controller_id OR NEW.receipt_id IS NOT OLD.receipt_id OR NEW.root_work_id IS NOT OLD.root_work_id OR
          NEW.revision IS NOT OLD.revision+1 OR OLD.state IN ('succeeded','failed') OR
          ${identities.map((field) => `json_extract(NEW.record,'$.${field}') IS NOT json_extract(OLD.record,'$.${field}')`).join(" OR ")}
        BEGIN SELECT RAISE(ABORT,'event_dag_controller_identity'); END`))
      yield* tx.run(`CREATE TRIGGER event_work_node_header BEFORE INSERT ON event_work_node_authority
        WHEN json_extract(NEW.record,'$.kind') IS NOT 'event_dag_node_v1' OR
          json_extract(NEW.record,'$.authorityID') IS NOT NEW.authority_id OR json_extract(NEW.record,'$.receiptID') IS NOT NEW.receipt_id OR
          json_extract(NEW.record,'$.nodeID') IS NOT NEW.node_id OR json_extract(NEW.record,'$.childWorkID') IS NOT NEW.work_id OR
          json_type(NEW.record,'$.terminal') IS NOT NULL OR NEW.state IS NOT 'pending'
        BEGIN SELECT RAISE(ABORT,'event_dag_node_header'); END`)
      yield* tx.run(`CREATE TRIGGER event_work_node_identity BEFORE UPDATE ON event_work_node_authority
        WHEN NEW.authority_id IS NOT OLD.authority_id OR NEW.receipt_id IS NOT OLD.receipt_id OR NEW.node_id IS NOT OLD.node_id OR
          NEW.work_id IS NOT OLD.work_id OR json_remove(NEW.record,'$.terminal') IS NOT json_remove(OLD.record,'$.terminal') OR
          NOT ((OLD.state='pending' AND NEW.state='bound' AND NEW.record IS OLD.record) OR
            (OLD.state='bound' AND NEW.state='terminal' AND json_type(NEW.record,'$.terminal')='object'))
        BEGIN SELECT RAISE(ABORT,'event_dag_node_immutable'); END`)
      for (const name of ["event_work_controller", "event_work_node_authority"]) yield* tx.run(sql.raw(
        `CREATE TRIGGER "${name}_retained" BEFORE DELETE ON "${name}" BEGIN SELECT RAISE(ABORT,'event_dag_obligation_retained'); END`))
      const tables = [EventWorkRuleTable, EventWorkCommandTable, EventWorkReceiptTable, EventWorkNodeAuthorityTable, EventWorkControllerTable]
      const names = ["event_work_rule", "event_work_command", "event_work_receipt", "event_work_node_authority", "event_work_controller"]
      const totals = tables.map((table, index) => `SELECT count(*) records,coalesce(sum(${Object.values(getTableColumns(table)).map((column) =>
        column.dataType === "number" ? `CASE WHEN "${column.name}" IS NULL THEN 0 ELSE 8 END` : `coalesce(length(CAST("${column.name}" AS BLOB)),0)`).join("+")}),0) bytes FROM "${names[index]}"`).join(" UNION ALL ")
      if (yield* tx.get(sql.raw(`SELECT 1 invalid FROM (SELECT sum(records) records,sum(bytes) bytes FROM (${totals})) WHERE records>10000 OR bytes>268435456`)))
        return yield* Effect.die("Event DAG original authority capacity exceeded")
      for (const name of names) for (const operation of ["INSERT", "UPDATE"]) {
        yield* tx.run(sql.raw(`DROP TRIGGER IF EXISTS "${name}_capacity_${operation.toLowerCase()}"`))
        yield* tx.run(sql.raw(`CREATE TRIGGER "${name}_capacity_${operation.toLowerCase()}" AFTER ${operation} ON "${name}"
          BEGIN SELECT CASE WHEN (SELECT sum(records)>10000 OR sum(bytes)>268435456 FROM (${totals}))
            THEN RAISE(ABORT,'event_work_capacity_exceeded') END; END`))
      }
      if (yield* tx.get("SELECT * FROM pragma_foreign_key_check LIMIT 1"))
        return yield* Effect.die("Event DAG migration violates original foreign keys")
    })
  },
} satisfies DatabaseMigration.Migration
