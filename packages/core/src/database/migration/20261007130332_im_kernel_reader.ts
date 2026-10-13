import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007130332_im_kernel_reader",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`im_kernel_reader_message\` (
          \`reader_key\` text NOT NULL,
          \`effect_key\` text NOT NULL,
          \`binding_key\` text NOT NULL,
          \`projection_key\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`sequence\` text NOT NULL,
          \`delivery_cursor\` text NOT NULL,
          \`sender_id\` text NOT NULL,
          \`target_id\` text NOT NULL,
          \`body_hash\` text NOT NULL,
          \`immutable_hash\` text NOT NULL,
          \`storage_state\` text NOT NULL,
          \`metadata\` text NOT NULL,
          \`message_time\` integer NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`conversation_type\` integer NOT NULL,
          \`owns_message\` integer NOT NULL,
          \`body_bytes\` integer NOT NULL,
          \`version\` integer NOT NULL,
          \`local_revision\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`accounted_records\` integer NOT NULL,
          \`accounted_bytes\` integer NOT NULL,
          \`local_message_id\` text,
          CONSTRAINT \`im_kernel_reader_message_pk\` PRIMARY KEY(\`reader_key\`, \`effect_key\`),
          CONSTRAINT \`fk_im_kernel_reader_message_local_message_id_im_messages_id_fk\` FOREIGN KEY (\`local_message_id\`) REFERENCES \`im_messages\`(\`id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT \`fk_im_kernel_reader_message_reader_key_binding_key_projection_key_im_kernel_reader_projection_reader_key_binding_key_projection_key_fk\` FOREIGN KEY (\`reader_key\`,\`binding_key\`,\`projection_key\`) REFERENCES \`im_kernel_reader_projection\`(\`reader_key\`,\`binding_key\`,\`projection_key\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT "im_kernel_reader_message_version_check" CHECK(typeof("version") = 'integer' AND "version" BETWEEN 1 AND 1),
          CONSTRAINT "im_kernel_reader_message_time_check" CHECK(typeof("local_revision") = 'integer' AND "local_revision" BETWEEN 1 AND 9007199254740991 AND typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND typeof("updated_at") = 'integer' AND "updated_at" BETWEEN 0 AND 9007199254740991 AND "updated_at" >= "created_at"),
          CONSTRAINT "im_kernel_reader_message_accounting_check" CHECK(typeof("accounted_records") = 'integer' AND "accounted_records" BETWEEN 1 AND 3 AND typeof("accounted_bytes") = 'integer' AND "accounted_bytes" BETWEEN 1024 AND 268435456),
          CONSTRAINT "im_kernel_reader_message_identity_check" CHECK((typeof("reader_key") = 'text' AND length(CAST("reader_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("reader_key", char(0)) = 0 AND length("reader_key") = 64 AND length(CAST("reader_key" AS BLOB)) = 64 AND "reader_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("effect_key") = 'text' AND length(CAST("effect_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("effect_key", char(0)) = 0 AND length("effect_key") = 64 AND length(CAST("effect_key" AS BLOB)) = 64 AND "effect_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("binding_key") = 'text' AND length(CAST("binding_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("binding_key", char(0)) = 0 AND length("binding_key") = 64 AND length(CAST("binding_key" AS BLOB)) = 64 AND "binding_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("projection_key") = 'text' AND length(CAST("projection_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("projection_key", char(0)) = 0 AND length("projection_key") = 64 AND length(CAST("projection_key" AS BLOB)) = 64 AND "projection_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("body_hash") = 'text' AND length(CAST("body_hash" AS BLOB)) BETWEEN 1 AND 64 AND instr("body_hash", char(0)) = 0 AND length("body_hash") = 64 AND length(CAST("body_hash" AS BLOB)) = 64 AND "body_hash" NOT GLOB '*[^0-9a-f]*') AND (typeof("immutable_hash") = 'text' AND length(CAST("immutable_hash" AS BLOB)) BETWEEN 1 AND 64 AND instr("immutable_hash", char(0)) = 0 AND length("immutable_hash") = 64 AND length(CAST("immutable_hash" AS BLOB)) = 64 AND "immutable_hash" NOT GLOB '*[^0-9a-f]*') AND (typeof("message_id") = 'text' AND length(CAST("message_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("message_id", char(0)) = 0) AND (typeof("sender_id") = 'text' AND length(CAST("sender_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("sender_id", char(0)) = 0) AND (typeof("target_id") = 'text' AND length(CAST("target_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("target_id", char(0)) = 0) AND ("local_message_id" IS NULL OR typeof("local_message_id") = 'text' AND length(CAST("local_message_id" AS BLOB)) BETWEEN 1 AND 128 AND instr("local_message_id", char(0)) = 0)),
          CONSTRAINT "im_kernel_reader_message_sequence_check" CHECK(typeof("sequence") = 'text' AND length(CAST("sequence" AS BLOB)) BETWEEN 1 AND 19 AND instr("sequence", char(0)) = 0 AND length("sequence") = length(CAST("sequence" AS BLOB)) AND "sequence" NOT GLOB '*[^0-9]*' AND ("sequence" = '0' OR substr("sequence", 1, 1) BETWEEN '1' AND '9') AND (length("sequence") < 19 OR "sequence" COLLATE BINARY <= '9223372036854775807') AND ("sequence" <> '0') AND typeof("delivery_cursor") = 'text' AND length(CAST("delivery_cursor" AS BLOB)) BETWEEN 1 AND 19 AND instr("delivery_cursor", char(0)) = 0 AND length("delivery_cursor") = length(CAST("delivery_cursor" AS BLOB)) AND "delivery_cursor" NOT GLOB '*[^0-9]*' AND ("delivery_cursor" = '0' OR substr("delivery_cursor", 1, 1) BETWEEN '1' AND '9') AND (length("delivery_cursor") < 19 OR "delivery_cursor" COLLATE BINARY <= '9223372036854775807') AND ("delivery_cursor" <> '0')),
          CONSTRAINT "im_kernel_reader_message_message_time_check" CHECK(typeof("message_time") = 'integer' AND "message_time" BETWEEN 0 AND 9007199254740991 AND typeof("expires_at") = 'integer' AND "expires_at" BETWEEN 0 AND 9007199254740991 AND "expires_at" > "message_time"),
          CONSTRAINT "im_kernel_reader_message_body_check" CHECK(typeof("conversation_type") = 'integer' AND "conversation_type" BETWEEN 1 AND 2 AND typeof("owns_message") = 'integer' AND "owns_message" BETWEEN 0 AND 1 AND typeof("body_bytes") = 'integer' AND "body_bytes" BETWEEN 0 AND 65536 AND "accounted_records" = 1 + "owns_message"),
          CONSTRAINT "im_kernel_reader_message_metadata_check" CHECK(CASE WHEN typeof("metadata") = 'text' AND length(CAST("metadata" AS BLOB)) BETWEEN 1 AND 2048 AND instr("metadata", char(0)) = 0 AND json_valid("metadata") THEN coalesce(json_type("metadata") = 'object' AND json_type("metadata", '$.version') = 'integer' AND json_extract("metadata", '$.version') = 1, 0) ELSE 0 END),
          CONSTRAINT "im_kernel_reader_message_storage_check" CHECK(("storage_state" = 'present' AND "local_message_id" IS NOT NULL) OR ("storage_state" IN ('expired','redacted') AND "local_message_id" IS NULL AND "body_bytes" = 0 AND "owns_message" = 0))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`im_kernel_reader_meter\` (
          \`id\` integer PRIMARY KEY,
          \`version\` integer NOT NULL,
          \`instance_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`used_records\` integer NOT NULL,
          \`used_bytes\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT "im_kernel_reader_meter_singleton_check" CHECK(typeof("id") = 'integer' AND "id" BETWEEN 1 AND 1 AND typeof("version") = 'integer' AND "version" BETWEEN 1 AND 1 AND typeof("instance_id") = 'text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 36 AND instr("instance_id", char(0)) = 0 AND length("instance_id") = 36 AND substr("instance_id", 9, 1) = '-' AND substr("instance_id", 14, 1) = '-' AND substr("instance_id", 19, 1) = '-' AND substr("instance_id", 24, 1) = '-' AND length(replace("instance_id", '-', '')) = 32 AND replace("instance_id", '-', '') NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "im_kernel_reader_meter_quota_check" CHECK(typeof("revision") = 'integer' AND "revision" BETWEEN 1 AND 9007199254740991 AND typeof("used_records") = 'integer' AND "used_records" BETWEEN 1 AND 100000 AND typeof("used_bytes") = 'integer' AND "used_bytes" BETWEEN 1024 AND 268435456),
          CONSTRAINT "im_kernel_reader_meter_time_check" CHECK(typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND typeof("updated_at") = 'integer' AND "updated_at" BETWEEN 0 AND 9007199254740991 AND "updated_at" >= "created_at")
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`im_kernel_reader_projection\` (
          \`reader_key\` text NOT NULL,
          \`binding_key\` text NOT NULL,
          \`projection_key\` text,
          \`version\` integer NOT NULL,
          \`local_revision\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`accounted_records\` integer NOT NULL,
          \`accounted_bytes\` integer NOT NULL,
          \`visibility\` text NOT NULL,
          \`metadata\` text NOT NULL,
          \`metadata_hash\` text NOT NULL,
          \`newer_after\` text NOT NULL,
          \`last_server_now\` integer NOT NULL,
          \`observed_at\` integer NOT NULL,
          \`history_complete\` integer NOT NULL,
          \`owned_group_bytes\` integer NOT NULL,
          \`target_id\` text,
          \`server_revision\` text,
          \`cursor\` text,
          \`read_ordinal\` text,
          \`admitted_ordinal\` text,
          \`live_unread\` text,
          \`stored_unread\` text,
          \`older_before\` text,
          \`scan_revision\` text,
          \`conversation_type\` integer,
          \`local_group_id\` text,
          \`next_expiry_at\` integer,
          CONSTRAINT \`im_kernel_reader_projection_pk\` PRIMARY KEY(\`reader_key\`, \`binding_key\`),
          CONSTRAINT \`fk_im_kernel_reader_projection_local_group_id_im_groups_id_fk\` FOREIGN KEY (\`local_group_id\`) REFERENCES \`im_groups\`(\`id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT \`fk_im_kernel_reader_projection_reader_key_im_kernel_reader_scope_reader_key_fk\` FOREIGN KEY (\`reader_key\`) REFERENCES \`im_kernel_reader_scope\`(\`reader_key\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT "im_kernel_reader_projection_version_check" CHECK(typeof("version") = 'integer' AND "version" BETWEEN 1 AND 1),
          CONSTRAINT "im_kernel_reader_projection_time_check" CHECK(typeof("local_revision") = 'integer' AND "local_revision" BETWEEN 1 AND 9007199254740991 AND typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND typeof("updated_at") = 'integer' AND "updated_at" BETWEEN 0 AND 9007199254740991 AND "updated_at" >= "created_at"),
          CONSTRAINT "im_kernel_reader_projection_accounting_check" CHECK(typeof("accounted_records") = 'integer' AND "accounted_records" BETWEEN 1 AND 3 AND typeof("accounted_bytes") = 'integer' AND "accounted_bytes" BETWEEN 1024 AND 268435456),
          CONSTRAINT "im_kernel_reader_projection_identity_check" CHECK((typeof("reader_key") = 'text' AND length(CAST("reader_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("reader_key", char(0)) = 0 AND length("reader_key") = 64 AND length(CAST("reader_key" AS BLOB)) = 64 AND "reader_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("binding_key") = 'text' AND length(CAST("binding_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("binding_key", char(0)) = 0 AND length("binding_key") = 64 AND length(CAST("binding_key" AS BLOB)) = 64 AND "binding_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("metadata_hash") = 'text' AND length(CAST("metadata_hash" AS BLOB)) BETWEEN 1 AND 64 AND instr("metadata_hash", char(0)) = 0 AND length("metadata_hash") = 64 AND length(CAST("metadata_hash" AS BLOB)) = 64 AND "metadata_hash" NOT GLOB '*[^0-9a-f]*') AND ("projection_key" IS NULL OR typeof("projection_key") = 'text' AND length(CAST("projection_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("projection_key", char(0)) = 0 AND length("projection_key") = 64 AND length(CAST("projection_key" AS BLOB)) = 64 AND "projection_key" NOT GLOB '*[^0-9a-f]*') AND ("target_id" IS NULL OR typeof("target_id") = 'text' AND length(CAST("target_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("target_id", char(0)) = 0) AND ("local_group_id" IS NULL OR typeof("local_group_id") = 'text' AND length(CAST("local_group_id" AS BLOB)) BETWEEN 1 AND 128 AND instr("local_group_id", char(0)) = 0)),
          CONSTRAINT "im_kernel_reader_projection_metadata_check" CHECK(CASE WHEN typeof("metadata") = 'text' AND length(CAST("metadata" AS BLOB)) BETWEEN 1 AND 4096 AND instr("metadata", char(0)) = 0 AND json_valid("metadata") THEN coalesce(json_type("metadata") = 'object' AND json_type("metadata", '$.version') = 'integer' AND json_extract("metadata", '$.version') = 1, 0) ELSE 0 END),
          CONSTRAINT "im_kernel_reader_projection_decimals_check" CHECK((typeof("newer_after") = 'text' AND length(CAST("newer_after" AS BLOB)) BETWEEN 1 AND 19 AND instr("newer_after", char(0)) = 0 AND length("newer_after") = length(CAST("newer_after" AS BLOB)) AND "newer_after" NOT GLOB '*[^0-9]*' AND ("newer_after" = '0' OR substr("newer_after", 1, 1) BETWEEN '1' AND '9') AND (length("newer_after") < 19 OR "newer_after" COLLATE BINARY <= '9223372036854775807') AND (1)) AND ("server_revision" IS NULL OR typeof("server_revision") = 'text' AND length(CAST("server_revision" AS BLOB)) BETWEEN 1 AND 19 AND instr("server_revision", char(0)) = 0 AND length("server_revision") = length(CAST("server_revision" AS BLOB)) AND "server_revision" NOT GLOB '*[^0-9]*' AND ("server_revision" = '0' OR substr("server_revision", 1, 1) BETWEEN '1' AND '9') AND (length("server_revision") < 19 OR "server_revision" COLLATE BINARY <= '9223372036854775807') AND ("server_revision" <> '0')) AND ("cursor" IS NULL OR typeof("cursor") = 'text' AND length(CAST("cursor" AS BLOB)) BETWEEN 1 AND 19 AND instr("cursor", char(0)) = 0 AND length("cursor") = length(CAST("cursor" AS BLOB)) AND "cursor" NOT GLOB '*[^0-9]*' AND ("cursor" = '0' OR substr("cursor", 1, 1) BETWEEN '1' AND '9') AND (length("cursor") < 19 OR "cursor" COLLATE BINARY <= '9223372036854775807') AND (1)) AND ("read_ordinal" IS NULL OR typeof("read_ordinal") = 'text' AND length(CAST("read_ordinal" AS BLOB)) BETWEEN 1 AND 19 AND instr("read_ordinal", char(0)) = 0 AND length("read_ordinal") = length(CAST("read_ordinal" AS BLOB)) AND "read_ordinal" NOT GLOB '*[^0-9]*' AND ("read_ordinal" = '0' OR substr("read_ordinal", 1, 1) BETWEEN '1' AND '9') AND (length("read_ordinal") < 19 OR "read_ordinal" COLLATE BINARY <= '9223372036854775807') AND (1)) AND ("admitted_ordinal" IS NULL OR typeof("admitted_ordinal") = 'text' AND length(CAST("admitted_ordinal" AS BLOB)) BETWEEN 1 AND 19 AND instr("admitted_ordinal", char(0)) = 0 AND length("admitted_ordinal") = length(CAST("admitted_ordinal" AS BLOB)) AND "admitted_ordinal" NOT GLOB '*[^0-9]*' AND ("admitted_ordinal" = '0' OR substr("admitted_ordinal", 1, 1) BETWEEN '1' AND '9') AND (length("admitted_ordinal") < 19 OR "admitted_ordinal" COLLATE BINARY <= '9223372036854775807') AND (1)) AND ("live_unread" IS NULL OR typeof("live_unread") = 'text' AND length(CAST("live_unread" AS BLOB)) BETWEEN 1 AND 19 AND instr("live_unread", char(0)) = 0 AND length("live_unread") = length(CAST("live_unread" AS BLOB)) AND "live_unread" NOT GLOB '*[^0-9]*' AND ("live_unread" = '0' OR substr("live_unread", 1, 1) BETWEEN '1' AND '9') AND (length("live_unread") < 19 OR "live_unread" COLLATE BINARY <= '9223372036854775807') AND (1)) AND ("stored_unread" IS NULL OR typeof("stored_unread") = 'text' AND length(CAST("stored_unread" AS BLOB)) BETWEEN 1 AND 19 AND instr("stored_unread", char(0)) = 0 AND length("stored_unread") = length(CAST("stored_unread" AS BLOB)) AND "stored_unread" NOT GLOB '*[^0-9]*' AND ("stored_unread" = '0' OR substr("stored_unread", 1, 1) BETWEEN '1' AND '9') AND (length("stored_unread") < 19 OR "stored_unread" COLLATE BINARY <= '9223372036854775807') AND (1)) AND ("older_before" IS NULL OR typeof("older_before") = 'text' AND length(CAST("older_before" AS BLOB)) BETWEEN 1 AND 19 AND instr("older_before", char(0)) = 0 AND length("older_before") = length(CAST("older_before" AS BLOB)) AND "older_before" NOT GLOB '*[^0-9]*' AND ("older_before" = '0' OR substr("older_before", 1, 1) BETWEEN '1' AND '9') AND (length("older_before") < 19 OR "older_before" COLLATE BINARY <= '9223372036854775807') AND (1)) AND ("scan_revision" IS NULL OR typeof("scan_revision") = 'text' AND length(CAST("scan_revision" AS BLOB)) BETWEEN 1 AND 19 AND instr("scan_revision", char(0)) = 0 AND length("scan_revision") = length(CAST("scan_revision" AS BLOB)) AND "scan_revision" NOT GLOB '*[^0-9]*' AND ("scan_revision" = '0' OR substr("scan_revision", 1, 1) BETWEEN '1' AND '9') AND (length("scan_revision") < 19 OR "scan_revision" COLLATE BINARY <= '9223372036854775807') AND ("scan_revision" <> '0'))),
          CONSTRAINT "im_kernel_reader_projection_observation_check" CHECK(typeof("last_server_now") = 'integer' AND "last_server_now" BETWEEN 0 AND 9007199254740991 AND typeof("observed_at") = 'integer' AND "observed_at" BETWEEN 0 AND 9007199254740991 AND typeof("history_complete") = 'integer' AND "history_complete" BETWEEN 0 AND 1 AND typeof("owned_group_bytes") = 'integer' AND "owned_group_bytes" BETWEEN 0 AND 268435456 AND ("next_expiry_at" IS NULL OR typeof("next_expiry_at") = 'integer' AND "next_expiry_at" BETWEEN 0 AND 9007199254740991) AND ("conversation_type" IS NULL OR typeof("conversation_type") = 'integer' AND "conversation_type" BETWEEN 1 AND 2)),
          CONSTRAINT "im_kernel_reader_projection_owned_group_check" CHECK(("local_group_id" IS NULL AND "owned_group_bytes" = 0 AND "accounted_records" = 1) OR ("local_group_id" IS NOT NULL AND "owned_group_bytes" >= 1024 AND "accounted_records" = 3)),
          CONSTRAINT "im_kernel_reader_projection_visibility_check" CHECK("visibility" IN ('pending','visible','revoked') AND ("visibility" = 'pending' OR ("projection_key" IS NOT NULL AND "server_revision" IS NOT NULL AND "cursor" IS NOT NULL)) AND ("visibility" <> 'pending' OR ("projection_key" IS NULL AND "server_revision" IS NULL AND "cursor" IS NULL AND "conversation_type" IS NOT NULL AND "target_id" IS NOT NULL AND "read_ordinal" IS NULL AND "admitted_ordinal" IS NULL AND "live_unread" IS NULL AND "stored_unread" IS NULL AND "scan_revision" IS NULL AND "next_expiry_at" IS NULL AND "newer_after" = '0' AND "older_before" IS NULL AND "history_complete" = 0)) AND ("visibility" <> 'revoked' OR ("read_ordinal" IS NULL AND "admitted_ordinal" IS NULL AND "live_unread" IS NULL AND "stored_unread" IS NULL)) AND ("visibility" <> 'visible' OR ("conversation_type" IS NOT NULL AND "target_id" IS NOT NULL AND "read_ordinal" IS NOT NULL AND "admitted_ordinal" IS NOT NULL AND "live_unread" IS NOT NULL AND "stored_unread" IS NOT NULL AND (length("read_ordinal") < length("admitted_ordinal") OR (length("read_ordinal") = length("admitted_ordinal") AND "read_ordinal" COLLATE BINARY <= "admitted_ordinal" COLLATE BINARY)) AND (length("live_unread") < length("stored_unread") OR (length("live_unread") = length("stored_unread") AND "live_unread" COLLATE BINARY <= "stored_unread" COLLATE BINARY)) AND (length("stored_unread") < length("admitted_ordinal") OR (length("stored_unread") = length("admitted_ordinal") AND "stored_unread" COLLATE BINARY <= "admitted_ordinal" COLLATE BINARY)))))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`im_kernel_reader_read_intent\` (
          \`action_id\` text PRIMARY KEY,
          \`reader_key\` text NOT NULL,
          \`binding_key\` text NOT NULL,
          \`projection_key\` text NOT NULL,
          \`phase\` text NOT NULL,
          \`original_projection_revision\` text NOT NULL,
          \`original_target_admitted\` text NOT NULL,
          \`cut_revision\` text NOT NULL,
          \`through_ordinal\` text NOT NULL,
          \`request_hash\` text NOT NULL,
          \`request\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`local_revision\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`accounted_records\` integer NOT NULL,
          \`accounted_bytes\` integer NOT NULL,
          \`result\` text,
          \`dispatched_at\` integer,
          \`settled_at\` integer,
          \`runtime_incarnation\` text,
          CONSTRAINT \`fk_im_kernel_reader_read_intent_reader_key_binding_key_projection_key_im_kernel_reader_projection_reader_key_binding_key_projection_key_fk\` FOREIGN KEY (\`reader_key\`,\`binding_key\`,\`projection_key\`) REFERENCES \`im_kernel_reader_projection\`(\`reader_key\`,\`binding_key\`,\`projection_key\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT "im_kernel_reader_read_intent_version_check" CHECK(typeof("version") = 'integer' AND "version" BETWEEN 1 AND 1),
          CONSTRAINT "im_kernel_reader_read_intent_time_check" CHECK(typeof("local_revision") = 'integer' AND "local_revision" BETWEEN 1 AND 9007199254740991 AND typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND typeof("updated_at") = 'integer' AND "updated_at" BETWEEN 0 AND 9007199254740991 AND "updated_at" >= "created_at"),
          CONSTRAINT "im_kernel_reader_read_intent_accounting_check" CHECK(typeof("accounted_records") = 'integer' AND "accounted_records" BETWEEN 1 AND 3 AND typeof("accounted_bytes") = 'integer' AND "accounted_bytes" BETWEEN 1024 AND 268435456),
          CONSTRAINT "im_kernel_reader_read_intent_identity_check" CHECK((typeof("action_id") = 'text' AND length(CAST("action_id" AS BLOB)) BETWEEN 1 AND 128 AND instr("action_id", char(0)) = 0) AND ("action_id" NOT GLOB '*[^A-Za-z0-9_-]*') AND (typeof("reader_key") = 'text' AND length(CAST("reader_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("reader_key", char(0)) = 0 AND length("reader_key") = 64 AND length(CAST("reader_key" AS BLOB)) = 64 AND "reader_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("binding_key") = 'text' AND length(CAST("binding_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("binding_key", char(0)) = 0 AND length("binding_key") = 64 AND length(CAST("binding_key" AS BLOB)) = 64 AND "binding_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("projection_key") = 'text' AND length(CAST("projection_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("projection_key", char(0)) = 0 AND length("projection_key") = 64 AND length(CAST("projection_key" AS BLOB)) = 64 AND "projection_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("request_hash") = 'text' AND length(CAST("request_hash" AS BLOB)) BETWEEN 1 AND 64 AND instr("request_hash", char(0)) = 0 AND length("request_hash") = 64 AND length(CAST("request_hash" AS BLOB)) = 64 AND "request_hash" NOT GLOB '*[^0-9a-f]*') AND ("runtime_incarnation" IS NULL OR typeof("runtime_incarnation") = 'text' AND length(CAST("runtime_incarnation" AS BLOB)) BETWEEN 1 AND 36 AND instr("runtime_incarnation", char(0)) = 0 AND length("runtime_incarnation") = 36 AND substr("runtime_incarnation", 9, 1) = '-' AND substr("runtime_incarnation", 14, 1) = '-' AND substr("runtime_incarnation", 19, 1) = '-' AND substr("runtime_incarnation", 24, 1) = '-' AND length(replace("runtime_incarnation", '-', '')) = 32 AND replace("runtime_incarnation", '-', '') NOT GLOB '*[^0-9a-f]*')),
          CONSTRAINT "im_kernel_reader_read_intent_cut_check" CHECK(typeof("original_projection_revision") = 'text' AND length(CAST("original_projection_revision" AS BLOB)) BETWEEN 1 AND 19 AND instr("original_projection_revision", char(0)) = 0 AND length("original_projection_revision") = length(CAST("original_projection_revision" AS BLOB)) AND "original_projection_revision" NOT GLOB '*[^0-9]*' AND ("original_projection_revision" = '0' OR substr("original_projection_revision", 1, 1) BETWEEN '1' AND '9') AND (length("original_projection_revision") < 19 OR "original_projection_revision" COLLATE BINARY <= '9223372036854775807') AND ("original_projection_revision" <> '0') AND typeof("original_target_admitted") = 'text' AND length(CAST("original_target_admitted" AS BLOB)) BETWEEN 1 AND 19 AND instr("original_target_admitted", char(0)) = 0 AND length("original_target_admitted") = length(CAST("original_target_admitted" AS BLOB)) AND "original_target_admitted" NOT GLOB '*[^0-9]*' AND ("original_target_admitted" = '0' OR substr("original_target_admitted", 1, 1) BETWEEN '1' AND '9') AND (length("original_target_admitted") < 19 OR "original_target_admitted" COLLATE BINARY <= '9223372036854775807') AND (1) AND typeof("cut_revision") = 'text' AND length(CAST("cut_revision" AS BLOB)) BETWEEN 1 AND 19 AND instr("cut_revision", char(0)) = 0 AND length("cut_revision") = length(CAST("cut_revision" AS BLOB)) AND "cut_revision" NOT GLOB '*[^0-9]*' AND ("cut_revision" = '0' OR substr("cut_revision", 1, 1) BETWEEN '1' AND '9') AND (length("cut_revision") < 19 OR "cut_revision" COLLATE BINARY <= '9223372036854775807') AND ("cut_revision" <> '0') AND typeof("through_ordinal") = 'text' AND length(CAST("through_ordinal" AS BLOB)) BETWEEN 1 AND 19 AND instr("through_ordinal", char(0)) = 0 AND length("through_ordinal") = length(CAST("through_ordinal" AS BLOB)) AND "through_ordinal" NOT GLOB '*[^0-9]*' AND ("through_ordinal" = '0' OR substr("through_ordinal", 1, 1) BETWEEN '1' AND '9') AND (length("through_ordinal") < 19 OR "through_ordinal" COLLATE BINARY <= '9223372036854775807') AND (1) AND (length("through_ordinal") < length("original_target_admitted") OR (length("through_ordinal") = length("original_target_admitted") AND "through_ordinal" COLLATE BINARY <= "original_target_admitted" COLLATE BINARY))),
          CONSTRAINT "im_kernel_reader_read_intent_request_check" CHECK(CASE WHEN typeof("request") = 'text' AND length(CAST("request" AS BLOB)) BETWEEN 1 AND 4096 AND instr("request", char(0)) = 0 AND json_valid("request") THEN coalesce(json_type("request") = 'object' AND json_type("request", '$.version') = 'integer' AND json_extract("request", '$.version') = 1, 0) ELSE 0 END AND ("result" IS NULL OR CASE WHEN typeof("result") = 'text' AND length(CAST("result" AS BLOB)) BETWEEN 1 AND 4096 AND instr("result", char(0)) = 0 AND json_valid("result") THEN coalesce(json_type("result") = 'object' AND json_type("result", '$.version') = 'integer' AND json_extract("result", '$.version') = 1, 0) ELSE 0 END) AND "accounted_records" = 1),
          CONSTRAINT "im_kernel_reader_read_intent_dispatch_time_check" CHECK(("dispatched_at" IS NULL OR (typeof("dispatched_at") = 'integer' AND "dispatched_at" BETWEEN 0 AND 9007199254740991 AND "dispatched_at" >= "created_at" AND "dispatched_at" <= "updated_at")) AND ("settled_at" IS NULL OR (typeof("settled_at") = 'integer' AND "settled_at" BETWEEN 0 AND 9007199254740991 AND "settled_at" >= "created_at" AND "settled_at" <= "updated_at" AND ("dispatched_at" IS NULL OR "settled_at" >= "dispatched_at")))),
          CONSTRAINT "im_kernel_reader_read_intent_phase_check" CHECK(("phase" = 'prepared' AND "dispatched_at" IS NULL AND "settled_at" IS NULL AND "runtime_incarnation" IS NULL AND "result" IS NULL) OR ("phase" IN ('dispatched','unknown') AND "dispatched_at" IS NOT NULL AND "settled_at" IS NULL AND "runtime_incarnation" IS NOT NULL AND "result" IS NULL) OR ("phase" = 'confirmed' AND "dispatched_at" IS NOT NULL AND "settled_at" IS NOT NULL AND "runtime_incarnation" IS NOT NULL AND "result" IS NOT NULL) OR ("phase" = 'cancelled' AND "settled_at" IS NOT NULL))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`im_kernel_reader_scope\` (
          \`reader_key\` text PRIMARY KEY,
          \`meter_id\` integer DEFAULT 1 NOT NULL,
          \`version\` integer NOT NULL,
          \`local_revision\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`accounted_records\` integer NOT NULL,
          \`accounted_bytes\` integer NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`scope_key\` text NOT NULL,
          \`binding\` text NOT NULL,
          \`binding_hash\` text NOT NULL,
          \`phase\` text NOT NULL,
          \`completed_after\` text NOT NULL,
          \`continuation\` text NOT NULL,
          \`fixed_limit\` integer NOT NULL,
          \`window_after\` text,
          \`window_upper\` text,
          \`scan_cursor\` text,
          \`scan_projection_key\` text,
          \`page_token\` text,
          \`blocked_code\` text,
          CONSTRAINT \`fk_im_kernel_reader_scope_meter_id_im_kernel_reader_meter_id_fk\` FOREIGN KEY (\`meter_id\`) REFERENCES \`im_kernel_reader_meter\`(\`id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT "im_kernel_reader_scope_version_check" CHECK(typeof("version") = 'integer' AND "version" BETWEEN 1 AND 1),
          CONSTRAINT "im_kernel_reader_scope_time_check" CHECK(typeof("local_revision") = 'integer' AND "local_revision" BETWEEN 1 AND 9007199254740991 AND typeof("created_at") = 'integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND typeof("updated_at") = 'integer' AND "updated_at" BETWEEN 0 AND 9007199254740991 AND "updated_at" >= "created_at"),
          CONSTRAINT "im_kernel_reader_scope_accounting_check" CHECK(typeof("accounted_records") = 'integer' AND "accounted_records" BETWEEN 1 AND 3 AND typeof("accounted_bytes") = 'integer' AND "accounted_bytes" BETWEEN 1024 AND 268435456),
          CONSTRAINT "im_kernel_reader_scope_identity_check" CHECK((typeof("reader_key") = 'text' AND length(CAST("reader_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("reader_key", char(0)) = 0 AND length("reader_key") = 64 AND length(CAST("reader_key" AS BLOB)) = 64 AND "reader_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("scope_key") = 'text' AND length(CAST("scope_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("scope_key", char(0)) = 0 AND length("scope_key") = 64 AND length(CAST("scope_key" AS BLOB)) = 64 AND "scope_key" NOT GLOB '*[^0-9a-f]*') AND (typeof("binding_hash") = 'text' AND length(CAST("binding_hash" AS BLOB)) BETWEEN 1 AND 64 AND instr("binding_hash", char(0)) = 0 AND length("binding_hash") = 64 AND length(CAST("binding_hash" AS BLOB)) = 64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*') AND (typeof("workspace_id") = 'text' AND length(CAST("workspace_id" AS BLOB)) BETWEEN 1 AND 4096 AND instr("workspace_id", char(0)) = 0) AND (typeof("meter_id") = 'integer' AND "meter_id" BETWEEN 1 AND 1)),
          CONSTRAINT "im_kernel_reader_scope_binding_check" CHECK(CASE WHEN typeof("binding") = 'text' AND length(CAST("binding" AS BLOB)) BETWEEN 1 AND 8192 AND instr("binding", char(0)) = 0 AND json_valid("binding") THEN coalesce(json_type("binding") = 'object' AND json_type("binding", '$.version') = 'integer' AND json_extract("binding", '$.version') = 1, 0) ELSE 0 END AND coalesce(json_extract("binding", '$.workspaceID') = "workspace_id" AND json_extract("binding", '$.scopeKey') = "scope_key", 0)),
          CONSTRAINT "im_kernel_reader_scope_continuation_check" CHECK(CASE WHEN typeof("continuation") = 'text' AND length(CAST("continuation" AS BLOB)) BETWEEN 1 AND 8192 AND instr("continuation", char(0)) = 0 AND json_valid("continuation") THEN coalesce(json_type("continuation") = 'object' AND json_type("continuation", '$.version') = 'integer' AND json_extract("continuation", '$.version') = 1, 0) ELSE 0 END AND coalesce(json_type("continuation", '$.projections') = 'array' AND json_array_length("continuation", '$.projections') BETWEEN 0 AND 32, 0)),
          CONSTRAINT "im_kernel_reader_scope_cursor_check" CHECK((typeof("completed_after") = 'text' AND length(CAST("completed_after" AS BLOB)) BETWEEN 1 AND 19 AND instr("completed_after", char(0)) = 0 AND length("completed_after") = length(CAST("completed_after" AS BLOB)) AND "completed_after" NOT GLOB '*[^0-9]*' AND ("completed_after" = '0' OR substr("completed_after", 1, 1) BETWEEN '1' AND '9') AND (length("completed_after") < 19 OR "completed_after" COLLATE BINARY <= '9223372036854775807') AND (1)) AND ("window_after" IS NULL OR typeof("window_after") = 'text' AND length(CAST("window_after" AS BLOB)) BETWEEN 1 AND 19 AND instr("window_after", char(0)) = 0 AND length("window_after") = length(CAST("window_after" AS BLOB)) AND "window_after" NOT GLOB '*[^0-9]*' AND ("window_after" = '0' OR substr("window_after", 1, 1) BETWEEN '1' AND '9') AND (length("window_after") < 19 OR "window_after" COLLATE BINARY <= '9223372036854775807') AND (1)) AND ("window_upper" IS NULL OR typeof("window_upper") = 'text' AND length(CAST("window_upper" AS BLOB)) BETWEEN 1 AND 19 AND instr("window_upper", char(0)) = 0 AND length("window_upper") = length(CAST("window_upper" AS BLOB)) AND "window_upper" NOT GLOB '*[^0-9]*' AND ("window_upper" = '0' OR substr("window_upper", 1, 1) BETWEEN '1' AND '9') AND (length("window_upper") < 19 OR "window_upper" COLLATE BINARY <= '9223372036854775807') AND (1)) AND ("scan_cursor" IS NULL OR typeof("scan_cursor") = 'text' AND length(CAST("scan_cursor" AS BLOB)) BETWEEN 1 AND 19 AND instr("scan_cursor", char(0)) = 0 AND length("scan_cursor") = length(CAST("scan_cursor" AS BLOB)) AND "scan_cursor" NOT GLOB '*[^0-9]*' AND ("scan_cursor" = '0' OR substr("scan_cursor", 1, 1) BETWEEN '1' AND '9') AND (length("scan_cursor") < 19 OR "scan_cursor" COLLATE BINARY <= '9223372036854775807') AND (1)) AND ("scan_projection_key" IS NULL OR typeof("scan_projection_key") = 'text' AND length(CAST("scan_projection_key" AS BLOB)) BETWEEN 1 AND 64 AND instr("scan_projection_key", char(0)) = 0 AND length("scan_projection_key") = 64 AND length(CAST("scan_projection_key" AS BLOB)) = 64 AND "scan_projection_key" NOT GLOB '*[^0-9a-f]*')),
          CONSTRAINT "im_kernel_reader_scope_window_check" CHECK(("window_after" IS NULL AND "window_upper" IS NULL AND "scan_cursor" IS NULL AND "scan_projection_key" IS NULL AND "page_token" IS NULL) OR ("window_after" IS NOT NULL AND "window_upper" IS NOT NULL AND "scan_cursor" IS NOT NULL AND (length("window_after") < length("scan_cursor") OR (length("window_after") = length("scan_cursor") AND "window_after" COLLATE BINARY <= "scan_cursor" COLLATE BINARY)) AND (length("scan_cursor") < length("window_upper") OR (length("scan_cursor") = length("window_upper") AND "scan_cursor" COLLATE BINARY <= "window_upper" COLLATE BINARY)))),
          CONSTRAINT "im_kernel_reader_scope_phase_check" CHECK("phase" IN ('idle','partial','blocked','purging') AND ("phase" <> 'idle' OR ("window_after" IS NULL AND "page_token" IS NULL AND json_array_length("continuation", '$.projections') = 0)) AND ("phase" <> 'partial' OR "window_after" IS NOT NULL)),
          CONSTRAINT "im_kernel_reader_scope_page_check" CHECK(typeof("fixed_limit") = 'integer' AND "fixed_limit" BETWEEN 1 AND 32 AND ("page_token" IS NULL OR typeof("page_token") = 'text' AND length(CAST("page_token" AS BLOB)) BETWEEN 1 AND 1024 AND instr("page_token", char(0)) = 0) AND ("blocked_code" IS NULL OR "blocked_code" IN ('stale','unavailable','capacity','invalid','collision')) AND "accounted_records" = 1)
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_kernel_reader_message_original_idx\` ON \`im_kernel_reader_message\` (\`reader_key\`,\`projection_key\`,\`message_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_kernel_reader_message_cursor_idx\` ON \`im_kernel_reader_message\` (\`reader_key\`,\`projection_key\`,\`delivery_cursor\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_kernel_reader_message_local_idx\` ON \`im_kernel_reader_message\` (\`local_message_id\`);`)
      yield* tx.run(`CREATE INDEX \`im_kernel_reader_message_page_idx\` ON \`im_kernel_reader_message\` (\`reader_key\`,\`projection_key\`,length("delivery_cursor"),\`delivery_cursor\`,\`effect_key\`);`)
      yield* tx.run(`CREATE INDEX \`im_kernel_reader_message_expiry_idx\` ON \`im_kernel_reader_message\` (\`expires_at\`,\`reader_key\`,\`effect_key\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_kernel_reader_meter_instance_idx\` ON \`im_kernel_reader_meter\` (\`instance_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_kernel_reader_projection_exact_idx\` ON \`im_kernel_reader_projection\` (\`reader_key\`,\`binding_key\`,\`projection_key\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_kernel_reader_projection_server_idx\` ON \`im_kernel_reader_projection\` (\`reader_key\`,\`projection_key\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_kernel_reader_projection_group_idx\` ON \`im_kernel_reader_projection\` (\`local_group_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_kernel_reader_projection_target_idx\` ON \`im_kernel_reader_projection\` (\`reader_key\`,\`conversation_type\`,\`target_id\`) WHERE "im_kernel_reader_projection"."target_id" IS NOT NULL;`)
      yield* tx.run(`CREATE INDEX \`im_kernel_reader_projection_cursor_idx\` ON \`im_kernel_reader_projection\` (\`reader_key\`,length("cursor"),\`cursor\`,\`projection_key\`);`)
      yield* tx.run(`CREATE INDEX \`im_kernel_reader_projection_expiry_idx\` ON \`im_kernel_reader_projection\` (\`reader_key\`,\`next_expiry_at\`,\`projection_key\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_kernel_reader_read_intent_pending_idx\` ON \`im_kernel_reader_read_intent\` (\`reader_key\`,\`projection_key\`) WHERE "im_kernel_reader_read_intent"."phase" IN ('prepared','dispatched','unknown');`)
      yield* tx.run(`CREATE INDEX \`im_kernel_reader_read_intent_phase_idx\` ON \`im_kernel_reader_read_intent\` (\`reader_key\`,\`phase\`,\`action_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`im_kernel_reader_scope_binding_idx\` ON \`im_kernel_reader_scope\` (\`binding_hash\`);`)
      yield* tx.run(`CREATE INDEX \`im_kernel_reader_scope_workspace_idx\` ON \`im_kernel_reader_scope\` (\`workspace_id\`,\`reader_key\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
