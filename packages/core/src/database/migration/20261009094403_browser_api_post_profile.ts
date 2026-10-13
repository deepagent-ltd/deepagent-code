import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261009094403_browser_api_post_profile",
  up(tx) {
    return Effect.gen(function* () {
      if ((yield* tx.get<{ foreign_keys: number }>("PRAGMA foreign_keys"))?.foreign_keys !== 1 ||
        (yield* tx.get<{ defer_foreign_keys: number }>("PRAGMA defer_foreign_keys"))?.defer_foreign_keys !== 0)
        return yield* Effect.fail(new Error("Browser API post profile migration requires immediate foreign keys"))
      const incoming = yield* tx.all<{ name: string; source: string; target: string; on_delete: string; on_update: string }>(sql`
        SELECT m.name, f."from" AS source, f."to" AS target, f.on_delete, f.on_update
        FROM sqlite_master m, pragma_foreign_key_list(m.name) f
        WHERE m.type='table' AND f."table"='browser_control'`)
      if (incoming.some((entry) => !["browser_file_grant", "browser_file_artifact"].includes(entry.name) ||
        entry.source !== "control_id" || entry.target !== "control_id" ||
        entry.on_delete !== "RESTRICT" || entry.on_update !== "RESTRICT"))
        return yield* Effect.fail(new Error("Browser control has unknown incoming reference actions"))
      const retained = yield* tx.all<{ sql: string }>(sql`SELECT sql FROM sqlite_master
        WHERE tbl_name='browser_control' AND type IN ('index','trigger') AND sql IS NOT NULL
          AND name NOT IN ('browser_control_request_idx','browser_control_resource_idx','browser_control_state_idx')
        ORDER BY type,name`)
      // Deferral preserves populated RESTRICT children during the checked parent rebuild.
      // FK enforcement remains enabled throughout; no cascading reference is accepted.
      yield* tx.run("PRAGMA defer_foreign_keys=ON")
      yield* tx.run(`
        CREATE TABLE \`__new_browser_control\` (
          \`control_id\` text PRIMARY KEY,
          \`request_id\` text NOT NULL,
          \`request_digest\` text NOT NULL,
          \`principal\` text NOT NULL,
          \`security_namespace_id\` text NOT NULL,
          \`location_key\` text NOT NULL,
          \`project_scope_key\` text NOT NULL,
          \`namespace_binding_hash\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`host_id\` text NOT NULL,
          \`host_incarnation\` text NOT NULL,
          \`resource_id\` text NOT NULL,
          \`credential_binding\` text NOT NULL,
          \`profile\` text NOT NULL,
          \`origin\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`epoch\` integer NOT NULL,
          \`policy_revision\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`record\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT "browser_control_state_check" CHECK("state" IN ('creating','active','cancel_requested','stopped','unknown')),
          CONSTRAINT "browser_control_profile_check" CHECK("profile" IN ('managed-loopback-preview-v1','managed-loopback-interaction-v1','managed-public-readonly-v1','managed-loopback-exchange-v1','managed-public-interaction-v1','managed-public-api-v1')),
          CONSTRAINT "browser_control_revision_check" CHECK("revision" > 0 AND "epoch" > 0 AND "policy_revision" > 0),
          CONSTRAINT "browser_control_time_check" CHECK("updated_at" >= "created_at" AND "expires_at" > "created_at"),
          CONSTRAINT "browser_control_record_check" CHECK(typeof("record") = 'text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 16384 AND json_valid("record")),
          CONSTRAINT "browser_control_control_id_text_check" CHECK(typeof("control_id") = 'text' AND length(CAST("control_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_request_id_text_check" CHECK(typeof("request_id") = 'text' AND length(CAST("request_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_principal_text_check" CHECK(typeof("principal") = 'text' AND length(CAST("principal" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_security_namespace_id_text_check" CHECK(typeof("security_namespace_id") = 'text' AND length(CAST("security_namespace_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_location_key_text_check" CHECK(typeof("location_key") = 'text' AND length(CAST("location_key" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_project_scope_key_text_check" CHECK(typeof("project_scope_key") = 'text' AND length(CAST("project_scope_key" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_session_id_text_check" CHECK(typeof("session_id") = 'text' AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_project_id_text_check" CHECK(typeof("project_id") = 'text' AND length(CAST("project_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_host_id_text_check" CHECK(typeof("host_id") = 'text' AND length(CAST("host_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_host_incarnation_text_check" CHECK(typeof("host_incarnation") = 'text' AND length(CAST("host_incarnation" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_resource_id_text_check" CHECK(typeof("resource_id") = 'text' AND length(CAST("resource_id" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_profile_text_check" CHECK(typeof("profile") = 'text' AND length(CAST("profile" AS BLOB)) BETWEEN 1 AND 512),
          CONSTRAINT "browser_control_directory_text_check" CHECK(typeof("directory") = 'text' AND length(CAST("directory" AS BLOB)) BETWEEN 1 AND 2048),
          CONSTRAINT "browser_control_origin_text_check" CHECK(typeof("origin") = 'text' AND length(CAST("origin" AS BLOB)) BETWEEN 1 AND 2048),
          CONSTRAINT "browser_control_revision_integer_check" CHECK(typeof("revision") = 'integer' AND "revision" >= 0 AND "revision" <= 9007199254740991),
          CONSTRAINT "browser_control_epoch_integer_check" CHECK(typeof("epoch") = 'integer' AND "epoch" >= 0 AND "epoch" <= 9007199254740991),
          CONSTRAINT "browser_control_policy_revision_integer_check" CHECK(typeof("policy_revision") = 'integer' AND "policy_revision" >= 0 AND "policy_revision" <= 9007199254740991),
          CONSTRAINT "browser_control_expires_at_integer_check" CHECK(typeof("expires_at") = 'integer' AND "expires_at" >= 0 AND "expires_at" <= 9007199254740991),
          CONSTRAINT "browser_control_created_at_integer_check" CHECK(typeof("created_at") = 'integer' AND "created_at" >= 0 AND "created_at" <= 9007199254740991),
          CONSTRAINT "browser_control_updated_at_integer_check" CHECK(typeof("updated_at") = 'integer' AND "updated_at" >= 0 AND "updated_at" <= 9007199254740991),
          CONSTRAINT "browser_control_request_digest_digest_check" CHECK(typeof("request_digest") = 'text' AND length(CAST("request_digest" AS BLOB)) = 64 AND "request_digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "browser_control_record_hash_digest_check" CHECK(typeof("record_hash") = 'text' AND length(CAST("record_hash" AS BLOB)) = 64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "browser_control_namespace_binding_hash_digest_check" CHECK(typeof("namespace_binding_hash") = 'text' AND length(CAST("namespace_binding_hash" AS BLOB)) = 64 AND "namespace_binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "browser_control_credential_binding_digest_check" CHECK(typeof("credential_binding") = 'text' AND length(CAST("credential_binding" AS BLOB)) = 64 AND "credential_binding" NOT GLOB '*[^0-9a-f]*')
        );
      `)
      yield* tx.run(`INSERT INTO \`__new_browser_control\`(\`control_id\`, \`request_id\`, \`request_digest\`, \`principal\`, \`security_namespace_id\`, \`location_key\`, \`project_scope_key\`, \`namespace_binding_hash\`, \`session_id\`, \`project_id\`, \`directory\`, \`host_id\`, \`host_incarnation\`, \`resource_id\`, \`credential_binding\`, \`profile\`, \`origin\`, \`revision\`, \`epoch\`, \`policy_revision\`, \`state\`, \`expires_at\`, \`record\`, \`record_hash\`, \`created_at\`, \`updated_at\`) SELECT \`control_id\`, \`request_id\`, \`request_digest\`, \`principal\`, \`security_namespace_id\`, \`location_key\`, \`project_scope_key\`, \`namespace_binding_hash\`, \`session_id\`, \`project_id\`, \`directory\`, \`host_id\`, \`host_incarnation\`, \`resource_id\`, \`credential_binding\`, \`profile\`, \`origin\`, \`revision\`, \`epoch\`, \`policy_revision\`, \`state\`, \`expires_at\`, \`record\`, \`record_hash\`, \`created_at\`, \`updated_at\` FROM \`browser_control\`;`)
      yield* tx.run(`DROP TABLE \`browser_control\`;`)
      yield* tx.run(`ALTER TABLE \`__new_browser_control\` RENAME TO \`browser_control\`;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`browser_control_request_idx\` ON \`browser_control\` (\`principal\`,\`session_id\`,\`request_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`browser_control_resource_idx\` ON \`browser_control\` (\`host_incarnation\`,\`resource_id\`);`)
      yield* tx.run(`CREATE INDEX \`browser_control_state_idx\` ON \`browser_control\` (\`host_incarnation\`,\`state\`);`)
      yield* Effect.forEach(retained, (entry) => tx.run(entry.sql), { discard: true })
      if ((yield* tx.all("PRAGMA foreign_key_check")).length)
        return yield* Effect.fail(new Error("Browser API post profile migration changed foreign key integrity"))
      // DROP/recreate leaves a deferred deletion counter even after a clean FK readback.
      // Clear that counter only after the complete integrity gate, before journal writes.
      yield* tx.run("PRAGMA defer_foreign_keys=OFF")
    })
  },
} satisfies DatabaseMigration.Migration
