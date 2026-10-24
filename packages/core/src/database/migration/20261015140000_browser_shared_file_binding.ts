import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

type Tx = Parameters<DatabaseMigration.Migration["up"]>[0]
const grantColumns = ["grant_id", "instance_id", "control_id", "request_id", "command_hash", "scope_hash", "control_epoch", "policy_revision", "direction", "expires_at", "record", "record_hash", "created_at"]
const artifactColumns = ["artifact_id", "instance_id", "grant_id", "grant_hash", "action_id", "control_id", "scope_hash", "ordinal", "state", "revision", "reserved_bytes", "record", "record_hash", "created_at", "updated_at", "released_at"]
const indexes = ["browser_file_grant_request_idx", "browser_file_grant_control_idx", "browser_file_artifact_action_ordinal_idx", "browser_file_artifact_grant_idx", "browser_file_artifact_control_idx", "browser_file_artifact_custody_idx"]

export default {
  id: "20261015140000_browser_shared_file_binding",
  up(tx) {
    return Effect.gen(function* () {
      if ((yield* tx.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys !== 1 ||
        (yield* tx.get<{ defer_foreign_keys: number }>("PRAGMA defer_foreign_keys"))?.defer_foreign_keys !== 0)
        return yield* Effect.fail(new Error("Browser file binding migration requires immediate foreign keys"))
      const incoming = yield* tx.all<{ name: string; target_table: string; source: string; target: string; on_delete: string; on_update: string }>(sql`
        SELECT m.name, f."table" AS target_table, f."from" AS source, f."to" AS target, f.on_delete, f.on_update
        FROM sqlite_master m, pragma_foreign_key_list(m.name) f
        WHERE m.type='table' AND f."table" IN ('browser_file_grant','browser_file_artifact')`)
      if (incoming.some((entry) => entry.name !== "browser_file_artifact" || entry.target_table !== "browser_file_grant" ||
        entry.source !== "grant_id" || entry.target !== "grant_id" || entry.on_delete !== "RESTRICT" || entry.on_update !== "RESTRICT"))
        return yield* Effect.fail(new Error("Browser file binding has unknown incoming references"))
      const retained = yield* tx.all<{ sql: string }>(sql`SELECT sql FROM sqlite_master
        WHERE tbl_name IN ('browser_file_grant','browser_file_artifact') AND type IN ('index','trigger') AND sql IS NOT NULL
        AND name NOT IN (${sql.join(indexes.map((name) => sql`${name}`), sql`,`)}) ORDER BY type,name`)
      yield* tx.run(`
        CREATE TABLE \`__new_browser_file_grant\` (
        	\`grant_id\` text PRIMARY KEY,
        	\`instance_id\` text NOT NULL,
        	\`binding_version\` integer DEFAULT 1 NOT NULL,
        	\`control_id\` text,
        	\`shared_resource_id\` text,
        	\`shared_lease_id\` text,
        	\`request_id\` text NOT NULL,
        	\`command_hash\` text NOT NULL,
        	\`scope_hash\` text NOT NULL,
        	\`control_epoch\` integer,
        	\`policy_revision\` integer,
        	\`direction\` text NOT NULL,
        	\`expires_at\` integer NOT NULL,
        	\`record\` text NOT NULL,
        	\`record_hash\` text NOT NULL,
        	\`created_at\` integer NOT NULL,
        	CONSTRAINT \`fk_browser_file_grant_instance_id_browser_file_capacity_instance_id_fk\` FOREIGN KEY (\`instance_id\`) REFERENCES \`browser_file_capacity\`(\`instance_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT \`fk_browser_file_grant_control_id_browser_control_control_id_fk\` FOREIGN KEY (\`control_id\`) REFERENCES \`browser_control\`(\`control_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT \`fk_browser_file_grant_shared_resource_id_browser_shared_resource_resource_id_fk\` FOREIGN KEY (\`shared_resource_id\`) REFERENCES \`browser_shared_resource\`(\`resource_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT \`fk_browser_file_grant_shared_lease_id_browser_shared_lease_lease_id_fk\` FOREIGN KEY (\`shared_lease_id\`) REFERENCES \`browser_shared_lease\`(\`lease_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT "browser_file_grant_binding_check" CHECK(typeof("binding_version")='integer' AND (("binding_version"=1 AND "control_id" IS NOT NULL AND "control_epoch" IS NOT NULL AND "policy_revision" IS NOT NULL AND "shared_resource_id" IS NULL AND "shared_lease_id" IS NULL) OR ("binding_version"=2 AND "control_id" IS NULL AND "control_epoch" IS NULL AND "policy_revision" IS NULL AND "shared_resource_id" IS NOT NULL AND "shared_lease_id" IS NOT NULL))),
        	CONSTRAINT "browser_file_grant_grant_id_text_check" CHECK(typeof("grant_id")='text' AND length(CAST("grant_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("grant_id",char(0))=0),
        	CONSTRAINT "browser_file_grant_instance_id_text_check" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
        	CONSTRAINT "browser_file_grant_request_id_text_check" CHECK(typeof("request_id")='text' AND length(CAST("request_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("request_id",char(0))=0),
        	CONSTRAINT "browser_file_grant_control_id_text_check" CHECK("control_id" IS NULL OR (typeof("control_id")='text' AND length(CAST("control_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("control_id",char(0))=0)),
        	CONSTRAINT "browser_file_grant_shared_resource_id_text_check" CHECK("shared_resource_id" IS NULL OR (typeof("shared_resource_id")='text' AND length(CAST("shared_resource_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("shared_resource_id",char(0))=0)),
        	CONSTRAINT "browser_file_grant_shared_lease_id_text_check" CHECK("shared_lease_id" IS NULL OR (typeof("shared_lease_id")='text' AND length(CAST("shared_lease_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("shared_lease_id",char(0))=0)),
        	CONSTRAINT "browser_file_grant_command_hash_digest_check" CHECK(typeof("command_hash")='text' AND length(CAST("command_hash" AS BLOB))=64 AND "command_hash" NOT GLOB '*[^0-9a-f]*'),
        	CONSTRAINT "browser_file_grant_scope_hash_digest_check" CHECK(typeof("scope_hash")='text' AND length(CAST("scope_hash" AS BLOB))=64 AND "scope_hash" NOT GLOB '*[^0-9a-f]*'),
        	CONSTRAINT "browser_file_grant_record_hash_digest_check" CHECK(typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
        	CONSTRAINT "browser_file_grant_expires_at_integer_check" CHECK(typeof("expires_at")='integer' AND "expires_at" BETWEEN 1 AND 9007199254740991),
        	CONSTRAINT "browser_file_grant_created_at_integer_check" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991),
        	CONSTRAINT "browser_file_grant_control_epoch_integer_check" CHECK("control_epoch" IS NULL OR (typeof("control_epoch")='integer' AND "control_epoch" BETWEEN 1 AND 9007199254740991)),
        	CONSTRAINT "browser_file_grant_policy_revision_integer_check" CHECK("policy_revision" IS NULL OR (typeof("policy_revision")='integer' AND "policy_revision" BETWEEN 1 AND 9007199254740991)),
        	CONSTRAINT "browser_file_grant_direction_check" CHECK("direction" IN ('upload','download')),
        	CONSTRAINT "browser_file_grant_time_check" CHECK("expires_at">"created_at"),
        	CONSTRAINT "browser_file_grant_record_check" CHECK(typeof("record")='text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 8192 AND json_valid("record") AND json_type("record") IS 'object' AND json_type("record",'$.version') IS 'integer' AND json_extract("record",'$.version') IS "binding_version"),
        	CONSTRAINT "browser_file_grant_grant_id_mirror_check" CHECK(json_type("record",'$.grantID') IS 'text' AND json_extract("record",'$.grantID') IS "grant_id"),
        	CONSTRAINT "browser_file_grant_instance_id_mirror_check" CHECK(json_type("record",'$.instanceID') IS 'text' AND json_extract("record",'$.instanceID') IS "instance_id"),
        	CONSTRAINT "browser_file_grant_command_hash_mirror_check" CHECK(json_type("record",'$.commandHash') IS 'text' AND json_extract("record",'$.commandHash') IS "command_hash"),
        	CONSTRAINT "browser_file_grant_scope_hash_mirror_check" CHECK(json_type("record",'$.scopeHash') IS 'text' AND json_extract("record",'$.scopeHash') IS "scope_hash"),
        	CONSTRAINT "browser_file_grant_control_id_mirror_check" CHECK("binding_version"<>1 OR (json_type("record",'$.controlID') IS 'text' AND json_extract("record",'$.controlID') IS "control_id")),
        	CONSTRAINT "browser_file_grant_control_epoch_mirror_check" CHECK("binding_version"<>1 OR (json_type("record",'$.controlEpoch') IS 'integer' AND json_extract("record",'$.controlEpoch') IS "control_epoch")),
        	CONSTRAINT "browser_file_grant_policy_revision_mirror_check" CHECK("binding_version"<>1 OR (json_type("record",'$.policyRevision') IS 'integer' AND json_extract("record",'$.policyRevision') IS "policy_revision")),
        	CONSTRAINT "browser_file_grant_expires_at_mirror_check" CHECK(json_type("record",'$.expiresAt') IS 'integer' AND json_extract("record",'$.expiresAt') IS "expires_at"),
        	CONSTRAINT "browser_file_grant_created_at_mirror_check" CHECK(json_type("record",'$.createdAt') IS 'integer' AND json_extract("record",'$.createdAt') IS "created_at"),
        	CONSTRAINT "browser_file_grant_request_mirror_check" CHECK(json_type("record",'$.command.requestID') IS 'text' AND json_extract("record",'$.command.requestID') IS "request_id" AND json_type("record",'$.preview.direction') IS 'text' AND json_extract("record",'$.preview.direction') IS "direction"),
        	CONSTRAINT "browser_file_grant_shared_mirror_check" CHECK("binding_version"<>2 OR (json_type("record",'$.binding') IS 'object' AND json_extract("record",'$.binding.kind') IS 'shared-v2' AND json_type("record",'$.binding.resourceID') IS 'text' AND json_extract("record",'$.binding.resourceID') IS "shared_resource_id" AND json_type("record",'$.binding.leaseID') IS 'text' AND json_extract("record",'$.binding.leaseID') IS "shared_lease_id" AND json_type("record",'$.binding.scopeHash') IS 'text' AND json_extract("record",'$.binding.scopeHash') IS "scope_hash" AND json_type("record",'$.bindingHash') IS 'text' AND length(CAST(json_extract("record",'$.bindingHash') AS BLOB))=64 AND json_extract("record",'$.bindingHash') NOT GLOB '*[^0-9a-f]*'))
        );
      `)
      yield* copyAndVerify(tx, "browser_file_grant", grantColumns)
      yield* tx.run(`
        CREATE TABLE \`__new_browser_file_artifact\` (
        	\`artifact_id\` text PRIMARY KEY,
        	\`instance_id\` text NOT NULL,
        	\`grant_id\` text NOT NULL,
        	\`grant_hash\` text NOT NULL,
        	\`binding_version\` integer DEFAULT 1 NOT NULL,
        	\`action_id\` text,
        	\`control_id\` text,
        	\`shared_resource_id\` text,
        	\`shared_lease_id\` text,
        	\`shared_action_id\` text,
        	\`scope_hash\` text NOT NULL,
        	\`ordinal\` integer NOT NULL,
        	\`state\` text NOT NULL,
        	\`revision\` integer NOT NULL,
        	\`reserved_bytes\` integer NOT NULL,
        	\`record\` text NOT NULL,
        	\`record_hash\` text NOT NULL,
        	\`created_at\` integer NOT NULL,
        	\`updated_at\` integer NOT NULL,
        	\`released_at\` integer,
        	CONSTRAINT \`fk_browser_file_artifact_instance_id_browser_file_capacity_instance_id_fk\` FOREIGN KEY (\`instance_id\`) REFERENCES \`browser_file_capacity\`(\`instance_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT \`fk_browser_file_artifact_grant_id_browser_file_grant_grant_id_fk\` FOREIGN KEY (\`grant_id\`) REFERENCES \`__new_browser_file_grant\`(\`grant_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT \`fk_browser_file_artifact_action_id_browser_action_action_id_fk\` FOREIGN KEY (\`action_id\`) REFERENCES \`browser_action\`(\`action_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT \`fk_browser_file_artifact_control_id_browser_control_control_id_fk\` FOREIGN KEY (\`control_id\`) REFERENCES \`browser_control\`(\`control_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT \`fk_browser_file_artifact_shared_resource_id_browser_shared_resource_resource_id_fk\` FOREIGN KEY (\`shared_resource_id\`) REFERENCES \`browser_shared_resource\`(\`resource_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT \`fk_browser_file_artifact_shared_lease_id_browser_shared_lease_lease_id_fk\` FOREIGN KEY (\`shared_lease_id\`) REFERENCES \`browser_shared_lease\`(\`lease_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT \`fk_browser_file_artifact_shared_action_id_browser_shared_action_action_id_fk\` FOREIGN KEY (\`shared_action_id\`) REFERENCES \`browser_shared_action\`(\`action_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT "browser_file_artifact_binding_check" CHECK(typeof("binding_version")='integer' AND (("binding_version"=1 AND "control_id" IS NOT NULL AND "action_id" IS NOT NULL AND "shared_resource_id" IS NULL AND "shared_lease_id" IS NULL AND "shared_action_id" IS NULL) OR ("binding_version"=2 AND "control_id" IS NULL AND "action_id" IS NULL AND "shared_resource_id" IS NOT NULL AND "shared_lease_id" IS NOT NULL AND "shared_action_id" IS NOT NULL))),
        	CONSTRAINT "browser_file_artifact_artifact_id_text_check" CHECK(typeof("artifact_id")='text' AND length(CAST("artifact_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("artifact_id",char(0))=0),
        	CONSTRAINT "browser_file_artifact_instance_id_text_check" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
        	CONSTRAINT "browser_file_artifact_grant_id_text_check" CHECK(typeof("grant_id")='text' AND length(CAST("grant_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("grant_id",char(0))=0),
        	CONSTRAINT "browser_file_artifact_action_id_text_check" CHECK("action_id" IS NULL OR (typeof("action_id")='text' AND length(CAST("action_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("action_id",char(0))=0)),
        	CONSTRAINT "browser_file_artifact_control_id_text_check" CHECK("control_id" IS NULL OR (typeof("control_id")='text' AND length(CAST("control_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("control_id",char(0))=0)),
        	CONSTRAINT "browser_file_artifact_shared_resource_id_text_check" CHECK("shared_resource_id" IS NULL OR (typeof("shared_resource_id")='text' AND length(CAST("shared_resource_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("shared_resource_id",char(0))=0)),
        	CONSTRAINT "browser_file_artifact_shared_lease_id_text_check" CHECK("shared_lease_id" IS NULL OR (typeof("shared_lease_id")='text' AND length(CAST("shared_lease_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("shared_lease_id",char(0))=0)),
        	CONSTRAINT "browser_file_artifact_shared_action_id_text_check" CHECK("shared_action_id" IS NULL OR (typeof("shared_action_id")='text' AND length(CAST("shared_action_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("shared_action_id",char(0))=0)),
        	CONSTRAINT "browser_file_artifact_grant_hash_digest_check" CHECK(typeof("grant_hash")='text' AND length(CAST("grant_hash" AS BLOB))=64 AND "grant_hash" NOT GLOB '*[^0-9a-f]*'),
        	CONSTRAINT "browser_file_artifact_scope_hash_digest_check" CHECK(typeof("scope_hash")='text' AND length(CAST("scope_hash" AS BLOB))=64 AND "scope_hash" NOT GLOB '*[^0-9a-f]*'),
        	CONSTRAINT "browser_file_artifact_record_hash_digest_check" CHECK(typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
        	CONSTRAINT "browser_file_artifact_revision_integer_check" CHECK(typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991),
        	CONSTRAINT "browser_file_artifact_created_at_integer_check" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991),
        	CONSTRAINT "browser_file_artifact_updated_at_integer_check" CHECK(typeof("updated_at")='integer' AND "updated_at" BETWEEN 1 AND 9007199254740991),
        	CONSTRAINT "browser_file_artifact_ordinal_check" CHECK(typeof("ordinal")='integer' AND "ordinal" BETWEEN 0 AND 3),
        	CONSTRAINT "browser_file_artifact_reserved_check" CHECK(typeof("reserved_bytes")='integer' AND "reserved_bytes" BETWEEN 0 AND 1073741824),
        	CONSTRAINT "browser_file_artifact_state_check" CHECK("state" IN ('reserved','staged','selected','published','refused','unknown')),
        	CONSTRAINT "browser_file_artifact_time_check" CHECK("updated_at">="created_at" AND ("released_at" IS NULL OR (typeof("released_at")='integer' AND "released_at" BETWEEN "created_at" AND "updated_at"))),
        	CONSTRAINT "browser_file_artifact_release_check" CHECK(("released_at" IS NULL AND "reserved_bytes">0) OR ("released_at" IS NOT NULL AND "state" IN ('selected','published','refused') AND "reserved_bytes"=0)),
        	CONSTRAINT "browser_file_artifact_record_check" CHECK(typeof("record")='text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 8192 AND json_valid("record") AND json_type("record") IS 'object' AND json_type("record",'$.version') IS 'integer' AND json_extract("record",'$.version') IS "binding_version"),
        	CONSTRAINT "browser_file_artifact_artifact_id_mirror_check" CHECK(json_type("record",'$.artifactID') IS 'text' AND json_extract("record",'$.artifactID') IS "artifact_id"),
        	CONSTRAINT "browser_file_artifact_instance_id_mirror_check" CHECK(json_type("record",'$.instanceID') IS 'text' AND json_extract("record",'$.instanceID') IS "instance_id"),
        	CONSTRAINT "browser_file_artifact_grant_id_mirror_check" CHECK(json_type("record",'$.grantID') IS 'text' AND json_extract("record",'$.grantID') IS "grant_id"),
        	CONSTRAINT "browser_file_artifact_grant_hash_mirror_check" CHECK(json_type("record",'$.grantHash') IS 'text' AND json_extract("record",'$.grantHash') IS "grant_hash"),
        	CONSTRAINT "browser_file_artifact_scope_hash_mirror_check" CHECK(json_type("record",'$.scopeHash') IS 'text' AND json_extract("record",'$.scopeHash') IS "scope_hash"),
        	CONSTRAINT "browser_file_artifact_state_mirror_check" CHECK(json_type("record",'$.state') IS 'text' AND json_extract("record",'$.state') IS "state"),
        	CONSTRAINT "browser_file_artifact_action_id_mirror_check" CHECK("binding_version"<>1 OR (json_type("record",'$.actionID') IS 'text' AND json_extract("record",'$.actionID') IS "action_id")),
        	CONSTRAINT "browser_file_artifact_control_id_mirror_check" CHECK("binding_version"<>1 OR (json_type("record",'$.controlID') IS 'text' AND json_extract("record",'$.controlID') IS "control_id")),
        	CONSTRAINT "browser_file_artifact_shared_mirror_check" CHECK("binding_version"<>2 OR (json_type("record",'$.binding') IS 'object' AND json_extract("record",'$.binding.kind') IS 'shared-v2' AND json_type("record",'$.binding.resourceID') IS 'text' AND json_extract("record",'$.binding.resourceID') IS "shared_resource_id" AND json_type("record",'$.binding.leaseID') IS 'text' AND json_extract("record",'$.binding.leaseID') IS "shared_lease_id" AND json_type("record",'$.binding.scopeHash') IS 'text' AND json_extract("record",'$.binding.scopeHash') IS "scope_hash" AND json_type("record",'$.actionID') IS 'text' AND json_extract("record",'$.actionID') IS "shared_action_id" AND json_type("record",'$.bindingHash') IS 'text' AND length(CAST(json_extract("record",'$.bindingHash') AS BLOB))=64 AND json_extract("record",'$.bindingHash') NOT GLOB '*[^0-9a-f]*')),
        	CONSTRAINT "browser_file_artifact_ordinal_mirror_check" CHECK(json_type("record",'$.ordinal') IS 'integer' AND json_extract("record",'$.ordinal') IS "ordinal"),
        	CONSTRAINT "browser_file_artifact_revision_mirror_check" CHECK(json_type("record",'$.revision') IS 'integer' AND json_extract("record",'$.revision') IS "revision"),
        	CONSTRAINT "browser_file_artifact_reserved_bytes_mirror_check" CHECK(json_type("record",'$.reservedBytes') IS 'integer' AND json_extract("record",'$.reservedBytes') IS "reserved_bytes"),
        	CONSTRAINT "browser_file_artifact_created_at_mirror_check" CHECK(json_type("record",'$.createdAt') IS 'integer' AND json_extract("record",'$.createdAt') IS "created_at"),
        	CONSTRAINT "browser_file_artifact_updated_at_mirror_check" CHECK(json_type("record",'$.updatedAt') IS 'integer' AND json_extract("record",'$.updatedAt') IS "updated_at"),
        	CONSTRAINT "browser_file_artifact_release_mirror_check" CHECK(("released_at" IS NULL AND json_type("record",'$.releasedAt') IS 'null') OR ("released_at" IS NOT NULL AND json_type("record",'$.releasedAt') IS 'integer' AND json_extract("record",'$.releasedAt') IS "released_at"))
        );
      `)
      yield* copyAndVerify(tx, "browser_file_artifact", artifactColumns)
      // Both copies are checked before either original table is dropped. The temporary
      // child references the temporary parent, so immediate FK enforcement stays ON.
      yield* tx.run("DROP TABLE browser_file_artifact")
      yield* tx.run("DROP TABLE browser_file_grant")
      yield* tx.run("ALTER TABLE __new_browser_file_grant RENAME TO browser_file_grant")
      yield* tx.run("ALTER TABLE __new_browser_file_artifact RENAME TO browser_file_artifact")
      yield* tx.run(`
        CREATE UNIQUE INDEX \`browser_file_artifact_action_ordinal_idx\` ON \`browser_file_artifact\` (\`action_id\`,\`ordinal\`);
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX \`browser_file_artifact_shared_action_ordinal_idx\` ON \`browser_file_artifact\` (\`shared_action_id\`,\`ordinal\`) WHERE "browser_file_artifact"."binding_version"=2;
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX \`browser_file_artifact_grant_idx\` ON \`browser_file_artifact\` (\`grant_id\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`browser_file_artifact_control_idx\` ON \`browser_file_artifact\` (\`control_id\`,\`created_at\`,\`artifact_id\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`browser_file_artifact_shared_idx\` ON \`browser_file_artifact\` (\`shared_resource_id\`,\`created_at\`,\`artifact_id\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`browser_file_artifact_custody_idx\` ON \`browser_file_artifact\` (\`instance_id\`,\`released_at\`,\`artifact_id\`);
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX \`browser_file_grant_request_idx\` ON \`browser_file_grant\` (\`control_id\`,\`request_id\`);
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX \`browser_file_grant_shared_request_idx\` ON \`browser_file_grant\` (\`shared_resource_id\`,\`request_id\`) WHERE "browser_file_grant"."binding_version"=2;
      `)
      yield* tx.run(`
        CREATE INDEX \`browser_file_grant_control_idx\` ON \`browser_file_grant\` (\`control_id\`,\`created_at\`,\`grant_id\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`browser_file_grant_shared_idx\` ON \`browser_file_grant\` (\`shared_resource_id\`,\`created_at\`,\`grant_id\`);
      `)
      yield* Effect.forEach(retained, (entry) => tx.run(entry.sql), { discard: true })
      if ((yield* tx.all("PRAGMA foreign_key_check")).length)
        return yield* Effect.fail(new Error("Browser file binding changed foreign key integrity"))
    })
  },
} satisfies DatabaseMigration.Migration

function copyAndVerify(tx: Tx, table: string, columns: readonly string[]) {
  return Effect.gen(function* () {
    const actual = yield* tx.all<{ name: string }>(sql`PRAGMA table_info(${sql.identifier(table)})`)
    if (actual.length !== columns.length || actual.some((column) => !columns.includes(column.name)))
      return yield* Effect.fail(new Error("Browser file binding has unknown source columns"))
    const fields = sql.join(columns.map((column) => sql.identifier(column)), sql`,`)
    const old = sql.identifier(table)
    const fresh = sql.identifier(`__new_${table}`)
    yield* tx.run(sql`INSERT INTO ${fresh} (${fields}) SELECT ${fields} FROM ${old}`)
    // SQL copies the original JSON and hash as text; no parsing or canonicalization.
    const changed = yield* tx.get(sql`SELECT 1 AS changed WHERE
      EXISTS(SELECT ${fields} FROM ${old} EXCEPT SELECT ${fields} FROM ${fresh}) OR
      EXISTS(SELECT ${fields} FROM ${fresh} EXCEPT SELECT ${fields} FROM ${old})`)
    if (changed) return yield* Effect.fail(new Error("Browser file binding changed original bytes"))
  })
}
