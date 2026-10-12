import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Preserve every original cut request/result. New lineage accounting and the
// physical rewrite share the migration transaction; full capacity refuses upgrade.
export default {
  id: "20261007131555_im_reader_read_cut_lineage",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`__im_reader_lineage_migration_guard\` (\`ok\` INTEGER NOT NULL CHECK(\`ok\`=1));
      `)
      yield* tx.run(`
        UPDATE im_kernel_reader_meter SET
         used_bytes=used_bytes+(SELECT coalesce(sum(length(CAST(action_id AS BLOB))+8),0) FROM im_kernel_reader_read_intent),
         revision=revision+1,updated_at=max(updated_at,CAST(unixepoch('subsec')*1000 AS INTEGER))
         WHERE id=1 AND EXISTS(SELECT 1 FROM im_kernel_reader_read_intent)
         AND revision<9007199254740991 AND used_bytes+(SELECT coalesce(sum(length(CAST(action_id AS BLOB))+8),0) FROM im_kernel_reader_read_intent)<=268435456;
      `)
      yield* tx.run(`
        INSERT INTO __im_reader_lineage_migration_guard SELECT CASE WHEN
         NOT EXISTS(SELECT 1 FROM im_kernel_reader_read_intent) OR
         (changes()=1 AND (SELECT count(*) FROM im_kernel_reader_read_intent)<=100000) THEN 1 ELSE 0 END;
      `)
      yield* tx.run(`
        CREATE TABLE \`__new_im_kernel_reader_read_intent\` (
        	\`action_id\` text PRIMARY KEY NOT NULL,
        	\`original_action_id\` text NOT NULL,
        	\`cut_index\` integer NOT NULL,
        	\`parent_action_id\` text,
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
        	CONSTRAINT \`fk_im_kernel_reader_read_intent_parent_action_id_reader_key_binding_key_projection_key_im_kernel_reader_read_intent_action_id_reader_key_binding_key_projection_key_fk\` FOREIGN KEY (\`parent_action_id\`,\`reader_key\`,\`binding_key\`,\`projection_key\`) REFERENCES \`__new_im_kernel_reader_read_intent\`(\`action_id\`,\`reader_key\`,\`binding_key\`,\`projection_key\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT "im_kernel_reader_read_intent_lineage_check" CHECK(typeof("original_action_id") = 'text' AND length(CAST("original_action_id" AS BLOB)) BETWEEN 1 AND 128 AND instr("original_action_id", char(0)) = 0 AND "original_action_id" NOT GLOB '*[^A-Za-z0-9_-]*' AND typeof("cut_index") = 'integer' AND "cut_index" BETWEEN 0 AND 31 AND (("cut_index" = 0 AND "action_id" = "original_action_id" AND "parent_action_id" IS NULL) OR ("cut_index" > 0 AND "action_id" <> "original_action_id" AND "parent_action_id" IS NOT NULL AND "parent_action_id" = "original_action_id"))),
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
        CREATE UNIQUE INDEX \`im_kernel_reader_read_intent_identity_idx\` ON \`__new_im_kernel_reader_read_intent\` (\`action_id\`,\`reader_key\`,\`binding_key\`,\`projection_key\`);
      `)
      yield* tx.run(`
        INSERT INTO \`__new_im_kernel_reader_read_intent\`(\`action_id\`, \`original_action_id\`, \`cut_index\`, \`parent_action_id\`, \`reader_key\`, \`binding_key\`, \`projection_key\`, \`phase\`, \`original_projection_revision\`, \`original_target_admitted\`, \`cut_revision\`, \`through_ordinal\`, \`request_hash\`, \`request\`, \`version\`, \`local_revision\`, \`created_at\`, \`updated_at\`, \`accounted_records\`, \`accounted_bytes\`, \`result\`, \`dispatched_at\`, \`settled_at\`, \`runtime_incarnation\`) SELECT \`action_id\`, \`action_id\`, 0, NULL, \`reader_key\`, \`binding_key\`, \`projection_key\`, \`phase\`, \`original_projection_revision\`, \`original_target_admitted\`, \`cut_revision\`, \`through_ordinal\`, \`request_hash\`, \`request\`, \`version\`, \`local_revision\`, \`created_at\`, \`updated_at\`, \`accounted_records\`, \`accounted_bytes\` + length(CAST(\`action_id\` AS BLOB)) + 8, \`result\`, \`dispatched_at\`, \`settled_at\`, \`runtime_incarnation\` FROM \`im_kernel_reader_read_intent\`;
      `)
      yield* tx.run(`
        DROP TABLE \`im_kernel_reader_read_intent\`;
      `)
      yield* tx.run(`
        ALTER TABLE \`__new_im_kernel_reader_read_intent\` RENAME TO \`im_kernel_reader_read_intent\`;
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX \`im_kernel_reader_read_intent_cut_idx\` ON \`im_kernel_reader_read_intent\` (\`reader_key\`,\`projection_key\`,\`original_action_id\`,\`cut_index\`);
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX \`im_kernel_reader_read_intent_pending_idx\` ON \`im_kernel_reader_read_intent\` (\`reader_key\`,\`projection_key\`) WHERE "im_kernel_reader_read_intent"."phase" IN ('prepared','dispatched','unknown');
      `)
      yield* tx.run(`
        CREATE INDEX \`im_kernel_reader_read_intent_phase_idx\` ON \`im_kernel_reader_read_intent\` (\`reader_key\`,\`phase\`,\`action_id\`);
      `)
      yield* tx.run(`
        CREATE TRIGGER im_reader_cut_lineage_insert BEFORE INSERT ON im_kernel_reader_read_intent
         WHEN NEW.cut_index>0 BEGIN
         SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM im_kernel_reader_read_intent root
          WHERE root.action_id=NEW.original_action_id AND root.cut_index=0 AND root.phase='confirmed'
          AND root.reader_key=NEW.reader_key AND root.binding_key=NEW.binding_key AND root.projection_key=NEW.projection_key
          AND root.original_projection_revision=NEW.original_projection_revision AND root.original_target_admitted=NEW.original_target_admitted)
         OR NOT EXISTS(SELECT 1 FROM im_kernel_reader_read_intent predecessor
          WHERE predecessor.reader_key=NEW.reader_key AND predecessor.binding_key=NEW.binding_key AND predecessor.projection_key=NEW.projection_key
          AND predecessor.original_action_id=NEW.original_action_id AND predecessor.cut_index=NEW.cut_index-1
          AND predecessor.phase='confirmed' AND predecessor.result IS NOT NULL AND predecessor.settled_at IS NOT NULL)
         THEN RAISE(ABORT,'im_reader_cut_lineage_unconfirmed') END;
         END;
      `)
      yield* tx.run(`
        CREATE TRIGGER im_reader_cut_identity_update BEFORE UPDATE ON im_kernel_reader_read_intent
         WHEN NEW.action_id IS NOT OLD.action_id OR NEW.original_action_id IS NOT OLD.original_action_id
         OR NEW.cut_index IS NOT OLD.cut_index OR NEW.parent_action_id IS NOT OLD.parent_action_id
         OR NEW.reader_key IS NOT OLD.reader_key OR NEW.binding_key IS NOT OLD.binding_key OR NEW.projection_key IS NOT OLD.projection_key
         OR NEW.original_projection_revision IS NOT OLD.original_projection_revision OR NEW.original_target_admitted IS NOT OLD.original_target_admitted
         OR NEW.cut_revision IS NOT OLD.cut_revision OR NEW.through_ordinal IS NOT OLD.through_ordinal
         OR NEW.request_hash IS NOT OLD.request_hash OR NEW.request IS NOT OLD.request OR NEW.created_at IS NOT OLD.created_at
         OR (OLD.result IS NOT NULL AND NEW.result IS NOT OLD.result)
         OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at)
         OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS NOT OLD.settled_at)
         OR (OLD.runtime_incarnation IS NOT NULL AND NEW.runtime_incarnation IS NOT OLD.runtime_incarnation)
         BEGIN SELECT RAISE(ABORT,'im_reader_cut_identity_immutable'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER im_reader_group_project_update BEFORE UPDATE OF project_id ON im_groups
         WHEN NEW.project_id IS NOT NULL AND EXISTS(SELECT 1 FROM im_kernel_reader_projection WHERE local_group_id=OLD.id)
         BEGIN SELECT RAISE(ABORT,'im_reader_group_project_binding'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER im_reader_projection_project_insert BEFORE INSERT ON im_kernel_reader_projection
         WHEN NEW.local_group_id IS NOT NULL AND EXISTS(SELECT 1 FROM im_groups WHERE id=NEW.local_group_id AND project_id IS NOT NULL)
         BEGIN SELECT RAISE(ABORT,'im_reader_group_project_binding'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER im_reader_projection_project_update BEFORE UPDATE OF local_group_id ON im_kernel_reader_projection
         WHEN NEW.local_group_id IS NOT NULL AND EXISTS(SELECT 1 FROM im_groups WHERE id=NEW.local_group_id AND project_id IS NOT NULL)
         BEGIN SELECT RAISE(ABORT,'im_reader_group_project_binding'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER im_reader_cut_phase_update BEFORE UPDATE OF phase ON im_kernel_reader_read_intent
         WHEN NOT ((OLD.phase='prepared' AND NEW.phase IN ('prepared','dispatched','cancelled'))
         OR (OLD.phase='dispatched' AND NEW.phase IN ('dispatched','unknown','confirmed'))
         OR (OLD.phase='unknown' AND NEW.phase IN ('unknown','confirmed'))
         OR (OLD.phase='confirmed' AND NEW.phase='confirmed') OR (OLD.phase='cancelled' AND NEW.phase='cancelled'))
         BEGIN SELECT RAISE(ABORT,'im_reader_cut_phase_transition'); END;
      `)
      yield* tx.run(`
        INSERT INTO __im_reader_lineage_migration_guard SELECT CASE WHEN EXISTS(SELECT 1 FROM pragma_foreign_key_check) THEN 0 ELSE 1 END;
      `)
      yield* tx.run(`
        DROP TABLE __im_reader_lineage_migration_guard;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
