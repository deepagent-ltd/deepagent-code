import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007231920_event_validation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`event_validation_command\` (
        	\`instance_id\` text NOT NULL,
        	\`request_id\` text NOT NULL,
        	\`rule_id\` text NOT NULL,
        	\`action\` text NOT NULL,
        	\`request_hash\` text NOT NULL,
        	\`receipt\` text NOT NULL,
        	\`created_at\` integer NOT NULL,
        	CONSTRAINT \`event_validation_command_pk\` PRIMARY KEY(\`instance_id\`, \`request_id\`),
        	CONSTRAINT "event_validation_command_ids" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0 AND typeof("request_id")='text' AND length(CAST("request_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("request_id",char(0))=0 AND typeof("rule_id")='text' AND length(CAST("rule_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("rule_id",char(0))=0 AND typeof("request_hash")='text' AND length(CAST("request_hash" AS BLOB))=64 AND length("request_hash")=64 AND "request_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991),
        	CONSTRAINT "event_validation_command_action" CHECK("action" IN ('create','update','enable','pause','revoke','verify','cancel')),
        	CONSTRAINT "event_validation_command_receipt" CHECK(CASE WHEN typeof("receipt")='text' AND length(CAST("receipt" AS BLOB)) BETWEEN 2 AND 8192 AND instr("receipt",char(0))=0 AND json_valid("receipt") THEN coalesce(json_type("receipt")='object' AND json_type("receipt",'$.version')='integer' AND json_extract("receipt",'$.version')=1 AND (json_type("receipt",'$.instanceID') IN ('text') AND json_extract("receipt",'$.instanceID') IS "instance_id") AND (json_type("receipt",'$.requestID') IN ('text') AND json_extract("receipt",'$.requestID') IS "request_id") AND (json_type("receipt",'$.ruleID') IN ('text') AND json_extract("receipt",'$.ruleID') IS "rule_id") AND (json_type("receipt",'$.action') IN ('text') AND json_extract("receipt",'$.action') IS "action") AND (json_type("receipt",'$.createdAt') IN ('integer') AND json_extract("receipt",'$.createdAt') IS "created_at"),0) ELSE 0 END)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_validation_project\` (
        	\`project_key\` text PRIMARY KEY NOT NULL,
        	\`instance_id\` text NOT NULL,
        	\`active_run_id\` text,
        	\`owner_token\` text,
        	\`revision\` integer NOT NULL,
        	\`updated_at\` integer NOT NULL,
        	CONSTRAINT "event_validation_project_identity" CHECK(typeof("project_key")='text' AND length(CAST("project_key" AS BLOB))=64 AND length("project_key")=64 AND "project_key" NOT GLOB '*[^0-9a-f]*' AND typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0 AND ("active_run_id" IS NULL OR typeof("active_run_id")='text' AND length(CAST("active_run_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("active_run_id",char(0))=0) AND ("owner_token" IS NULL OR typeof("owner_token")='text' AND length(CAST("owner_token" AS BLOB)) BETWEEN 1 AND 512 AND instr("owner_token",char(0))=0)),
        	CONSTRAINT "event_validation_project_owner" CHECK(("active_run_id" IS NULL AND "owner_token" IS NULL) OR ("active_run_id" IS NOT NULL AND "owner_token" IS NOT NULL)),
        	CONSTRAINT "event_validation_project_counters" CHECK(typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991 AND typeof("updated_at")='integer' AND "updated_at" BETWEEN 1 AND 9007199254740991)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_validation_rule\` (
        	\`rule_id\` text PRIMARY KEY NOT NULL,
        	\`instance_id\` text NOT NULL,
        	\`project_key\` text NOT NULL,
        	\`revision\` integer NOT NULL,
        	\`state\` text NOT NULL,
        	\`operator_id\` text NOT NULL,
        	\`operator_revision\` integer NOT NULL,
        	\`config_hash\` text NOT NULL,
        	\`content_revision\` integer NOT NULL,
        	\`content_hash\` text,
        	\`run_count\` integer NOT NULL,
        	\`pending_first_at\` integer,
        	\`pending_last_at\` integer,
        	\`due_at\` integer,
        	\`current_run_id\` text,
        	\`last_reason\` text NOT NULL,
        	\`record\` text NOT NULL,
        	\`record_hash\` text NOT NULL,
        	\`created_at\` integer NOT NULL,
        	\`updated_at\` integer NOT NULL,
        	CONSTRAINT "event_validation_rule_ids" CHECK(typeof("rule_id")='text' AND length(CAST("rule_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("rule_id",char(0))=0 AND typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0 AND typeof("operator_id")='text' AND length(CAST("operator_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("operator_id",char(0))=0 AND typeof("project_key")='text' AND length(CAST("project_key" AS BLOB))=64 AND length("project_key")=64 AND "project_key" NOT GLOB '*[^0-9a-f]*' AND typeof("config_hash")='text' AND length(CAST("config_hash" AS BLOB))=64 AND length("config_hash")=64 AND "config_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64 AND length("record_hash")=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*' AND ("content_hash" IS NULL OR typeof("content_hash")='text' AND length(CAST("content_hash" AS BLOB))=64 AND length("content_hash")=64 AND "content_hash" NOT GLOB '*[^0-9a-f]*') AND ("current_run_id" IS NULL OR typeof("current_run_id")='text' AND length(CAST("current_run_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("current_run_id",char(0))=0)),
        	CONSTRAINT "event_validation_rule_counters" CHECK(typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991 AND typeof("operator_revision")='integer' AND "operator_revision" BETWEEN 1 AND 9007199254740991 AND typeof("content_revision")='integer' AND "content_revision" BETWEEN 0 AND 9007199254740991 AND typeof("run_count")='integer' AND "run_count" BETWEEN 0 AND 10000),
        	CONSTRAINT "event_validation_rule_state" CHECK("state" IN ('disabled','enabled','paused','revoked') AND "last_reason" IN ('disabled','paused','revoked','debouncing','unchanged','ready','running','superseded','cancelled','expired','budget_exhausted','authority_changed','native_unavailable','unknown','completed')),
        	CONSTRAINT "event_validation_rule_time" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991 AND typeof("updated_at")='integer' AND "updated_at" BETWEEN 1 AND 9007199254740991 AND "updated_at">="created_at" AND (("pending_first_at" IS NULL AND "pending_last_at" IS NULL AND "due_at" IS NULL) OR (typeof("pending_first_at")='integer' AND "pending_first_at" BETWEEN 1 AND 9007199254740991 AND typeof("pending_last_at")='integer' AND "pending_last_at" BETWEEN 1 AND 9007199254740991 AND typeof("due_at")='integer' AND "due_at" BETWEEN 1 AND 9007199254740991 AND "pending_last_at">="pending_first_at" AND "due_at">="pending_first_at" AND "due_at"<="pending_first_at"+5000))),
        	CONSTRAINT "event_validation_rule_record" CHECK(CASE WHEN typeof("record")='text' AND length(CAST("record" AS BLOB)) BETWEEN 2 AND 65536 AND instr("record",char(0))=0 AND json_valid("record") THEN coalesce(json_type("record")='object' AND json_type("record",'$.version')='integer' AND json_extract("record",'$.version')=1 AND (json_type("record",'$.ruleID') IN ('text') AND json_extract("record",'$.ruleID') IS "rule_id") AND (json_type("record",'$.instanceID') IN ('text') AND json_extract("record",'$.instanceID') IS "instance_id") AND (json_type("record",'$.projectKey') IN ('text') AND json_extract("record",'$.projectKey') IS "project_key") AND (json_type("record",'$.revision') IN ('integer') AND json_extract("record",'$.revision') IS "revision") AND (json_type("record",'$.state') IN ('text') AND json_extract("record",'$.state') IS "state") AND (json_type("record",'$.operatorID') IN ('text') AND json_extract("record",'$.operatorID') IS "operator_id") AND (json_type("record",'$.operatorRevision') IN ('integer') AND json_extract("record",'$.operatorRevision') IS "operator_revision") AND (json_type("record",'$.configHash') IN ('text') AND json_extract("record",'$.configHash') IS "config_hash") AND (json_type("record",'$.contentRevision') IN ('integer') AND json_extract("record",'$.contentRevision') IS "content_revision") AND (json_type("record",'$.contentHash') IN ('text','null') AND json_extract("record",'$.contentHash') IS "content_hash") AND (json_type("record",'$.runCount') IN ('integer') AND json_extract("record",'$.runCount') IS "run_count") AND (json_type("record",'$.pendingFirstAt') IN ('integer','null') AND json_extract("record",'$.pendingFirstAt') IS "pending_first_at") AND (json_type("record",'$.pendingLastAt') IN ('integer','null') AND json_extract("record",'$.pendingLastAt') IS "pending_last_at") AND (json_type("record",'$.dueAt') IN ('integer','null') AND json_extract("record",'$.dueAt') IS "due_at") AND (json_type("record",'$.currentRunID') IN ('text','null') AND json_extract("record",'$.currentRunID') IS "current_run_id") AND (json_type("record",'$.lastReason') IN ('text') AND json_extract("record",'$.lastReason') IS "last_reason") AND (json_type("record",'$.createdAt') IN ('integer') AND json_extract("record",'$.createdAt') IS "created_at") AND (json_type("record",'$.updatedAt') IN ('integer') AND json_extract("record",'$.updatedAt') IS "updated_at"),0) ELSE 0 END)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_validation_run\` (
        	\`run_id\` text PRIMARY KEY NOT NULL,
        	\`rule_id\` text NOT NULL,
        	\`instance_id\` text NOT NULL,
        	\`project_key\` text NOT NULL,
        	\`rule_revision\` integer NOT NULL,
        	\`content_revision\` integer NOT NULL,
        	\`content_hash\` text NOT NULL,
        	\`recipe_hash\` text NOT NULL,
        	\`state\` text NOT NULL,
        	\`outcome\` text,
        	\`owner_token\` text NOT NULL,
        	\`revision\` integer NOT NULL,
        	\`cancel_requested\` integer NOT NULL,
        	\`record\` text NOT NULL,
        	\`record_hash\` text NOT NULL,
        	\`retained_bytes\` integer NOT NULL,
        	\`released_at\` integer,
        	\`created_at\` integer NOT NULL,
        	\`started_at\` integer,
        	\`terminal_at\` integer,
        	\`deadline\` integer NOT NULL,
        	CONSTRAINT \`fk_event_validation_run_rule_id_instance_id_project_key_event_validation_rule_rule_id_instance_id_project_key_fk\` FOREIGN KEY (\`rule_id\`,\`instance_id\`,\`project_key\`) REFERENCES \`event_validation_rule\`(\`rule_id\`,\`instance_id\`,\`project_key\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
        	CONSTRAINT "event_validation_run_ids" CHECK(typeof("run_id")='text' AND length(CAST("run_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("run_id",char(0))=0 AND typeof("rule_id")='text' AND length(CAST("rule_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("rule_id",char(0))=0 AND typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0 AND typeof("owner_token")='text' AND length(CAST("owner_token" AS BLOB)) BETWEEN 1 AND 512 AND instr("owner_token",char(0))=0 AND typeof("project_key")='text' AND length(CAST("project_key" AS BLOB))=64 AND length("project_key")=64 AND "project_key" NOT GLOB '*[^0-9a-f]*' AND typeof("content_hash")='text' AND length(CAST("content_hash" AS BLOB))=64 AND length("content_hash")=64 AND "content_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("recipe_hash")='text' AND length(CAST("recipe_hash" AS BLOB))=64 AND length("recipe_hash")=64 AND "recipe_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64 AND length("record_hash")=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
        	CONSTRAINT "event_validation_run_counters" CHECK(typeof("rule_revision")='integer' AND "rule_revision" BETWEEN 1 AND 9007199254740991 AND typeof("content_revision")='integer' AND "content_revision" BETWEEN 1 AND 9007199254740991 AND typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991 AND typeof("cancel_requested")='integer' AND "cancel_requested" BETWEEN 0 AND 1 AND typeof("retained_bytes")='integer' AND "retained_bytes" BETWEEN 0 AND 9007199254740991),
        	CONSTRAINT "event_validation_run_state" CHECK("state" IN ('queued','preparing','dispatching','settled','cancelled','superseded','unknown') AND ("outcome" IS NULL OR "outcome" IN ('passed','failed','cancelled','refused'))),
        	CONSTRAINT "event_validation_run_time" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991 AND typeof("deadline")='integer' AND "deadline" BETWEEN 1 AND 9007199254740991 AND "deadline">"created_at" AND ("started_at" IS NULL OR (typeof("started_at")='integer' AND "started_at" BETWEEN 1 AND 9007199254740991 AND "started_at">="created_at")) AND ("terminal_at" IS NULL OR (typeof("terminal_at")='integer' AND "terminal_at" BETWEEN 1 AND 9007199254740991 AND "terminal_at">=coalesce("started_at","created_at"))) AND ("released_at" IS NULL OR (typeof("released_at")='integer' AND "released_at" BETWEEN 1 AND 9007199254740991 AND "released_at">="created_at" AND "retained_bytes"=0 AND "state"<>'unknown'))),
        	CONSTRAINT "event_validation_run_record" CHECK(CASE WHEN typeof("record")='text' AND length(CAST("record" AS BLOB)) BETWEEN 2 AND 262144 AND instr("record",char(0))=0 AND json_valid("record") THEN coalesce(json_type("record")='object' AND json_type("record",'$.version')='integer' AND json_extract("record",'$.version')=1 AND (json_type("record",'$.runID') IN ('text') AND json_extract("record",'$.runID') IS "run_id") AND (json_type("record",'$.ruleID') IN ('text') AND json_extract("record",'$.ruleID') IS "rule_id") AND (json_type("record",'$.instanceID') IN ('text') AND json_extract("record",'$.instanceID') IS "instance_id") AND (json_type("record",'$.projectKey') IN ('text') AND json_extract("record",'$.projectKey') IS "project_key") AND (json_type("record",'$.ruleRevision') IN ('integer') AND json_extract("record",'$.ruleRevision') IS "rule_revision") AND (json_type("record",'$.contentRevision') IN ('integer') AND json_extract("record",'$.contentRevision') IS "content_revision") AND (json_type("record",'$.contentHash') IN ('text') AND json_extract("record",'$.contentHash') IS "content_hash") AND (json_type("record",'$.recipeHash') IN ('text') AND json_extract("record",'$.recipeHash') IS "recipe_hash") AND (json_type("record",'$.state') IN ('text') AND json_extract("record",'$.state') IS "state") AND (json_type("record",'$.outcome') IN ('text','null') AND json_extract("record",'$.outcome') IS "outcome") AND (json_type("record",'$.ownerToken') IN ('text') AND json_extract("record",'$.ownerToken') IS "owner_token") AND (json_type("record",'$.revision') IN ('integer') AND json_extract("record",'$.revision') IS "revision") AND (json_type("record",'$.cancelRequested') IN ('true','false') AND json_extract("record",'$.cancelRequested') IS "cancel_requested") AND (json_type("record",'$.retainedBytes') IN ('integer') AND json_extract("record",'$.retainedBytes') IS "retained_bytes") AND (json_type("record",'$.releasedAt') IN ('integer','null') AND json_extract("record",'$.releasedAt') IS "released_at") AND (json_type("record",'$.createdAt') IN ('integer') AND json_extract("record",'$.createdAt') IS "created_at") AND (json_type("record",'$.startedAt') IN ('integer','null') AND json_extract("record",'$.startedAt') IS "started_at") AND (json_type("record",'$.terminalAt') IN ('integer','null') AND json_extract("record",'$.terminalAt') IS "terminal_at") AND (json_type("record",'$.deadline') IN ('integer') AND json_extract("record",'$.deadline') IS "deadline"),0) ELSE 0 END)
        );
      `)
      yield* tx.run(`
        CREATE INDEX \`event_validation_command_rule_idx\` ON \`event_validation_command\` (\`instance_id\`,\`rule_id\`,\`created_at\`);
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX \`event_validation_project_scope_idx\` ON \`event_validation_project\` (\`project_key\`,\`instance_id\`);
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX \`event_validation_rule_scope_idx\` ON \`event_validation_rule\` (\`rule_id\`,\`instance_id\`,\`project_key\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`event_validation_rule_instance_idx\` ON \`event_validation_rule\` (\`instance_id\`,\`rule_id\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`event_validation_rule_due_idx\` ON \`event_validation_rule\` (\`state\`,\`due_at\`,\`rule_id\`);
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX \`event_validation_run_content_idx\` ON \`event_validation_run\` (\`rule_id\`,\`rule_revision\`,\`content_revision\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`event_validation_run_custody_idx\` ON \`event_validation_run\` (\`instance_id\`,\`released_at\`,\`run_id\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`event_validation_run_state_idx\` ON \`event_validation_run\` (\`state\`,\`created_at\`,\`run_id\`);
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_command_update_guard BEFORE UPDATE ON event_validation_command BEGIN SELECT RAISE(ABORT,'validation_command_immutable'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_command_delete_guard BEFORE DELETE ON event_validation_command BEGIN SELECT RAISE(ABORT,'validation_command_retained'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_rule_delete_guard BEFORE DELETE ON event_validation_rule BEGIN SELECT RAISE(ABORT,'validation_rule_retained'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_rule_insert_guard BEFORE INSERT ON event_validation_rule WHEN NOT coalesce((
          NEW.revision=1 AND NEW.state='disabled' AND NEW.content_revision=0 AND NEW.content_hash IS NULL AND NEW.run_count=0
          AND NEW.current_run_id IS NULL AND NEW.pending_first_at IS NULL AND NEW.due_at IS NULL
          AND json_type(NEW.record,'$.approval')='null'
        ),0) BEGIN SELECT RAISE(ABORT,'validation_rule_initial_state'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_rule_update_guard BEFORE UPDATE ON event_validation_rule WHEN NOT coalesce((
          NEW.rule_id IS OLD.rule_id AND NEW.instance_id IS OLD.instance_id AND NEW.project_key IS OLD.project_key
          AND NEW.operator_id IS OLD.operator_id AND NEW.created_at IS OLD.created_at AND OLD.state<>'revoked'
          AND json_extract(NEW.record,'$.configuration.scope') IS json_extract(OLD.record,'$.configuration.scope')
          AND NEW.updated_at>=OLD.updated_at AND NEW.revision IN (OLD.revision,OLD.revision+1)
          AND NEW.content_revision IN (OLD.content_revision,OLD.content_revision+1)
          AND (NEW.revision=OLD.revision+1 OR (NEW.config_hash IS OLD.config_hash AND NEW.state IS OLD.state AND NEW.operator_revision IS OLD.operator_revision
            AND json_extract(NEW.record,'$.approval') IS json_extract(OLD.record,'$.approval') AND NEW.run_count>=OLD.run_count))
          AND (NEW.current_run_id IS OLD.current_run_id OR NEW.current_run_id IS NULL OR EXISTS (
            SELECT 1 FROM event_validation_run r WHERE r.run_id=NEW.current_run_id AND r.rule_id=NEW.rule_id
              AND r.instance_id=NEW.instance_id AND r.project_key=NEW.project_key AND r.rule_revision=NEW.revision
              AND r.content_revision=NEW.content_revision AND r.content_hash=NEW.content_hash AND r.state='settled'
              AND json_extract(r.record,'$.resultCurrent') IS 1))
        ),0) BEGIN SELECT RAISE(ABORT,'validation_rule_transition'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_project_insert_guard BEFORE INSERT ON event_validation_project WHEN NOT coalesce((
          NEW.active_run_id IS NULL AND NEW.owner_token IS NULL AND NEW.revision=1
        ),0) BEGIN SELECT RAISE(ABORT,'validation_project_initial_state'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_project_update_guard BEFORE UPDATE ON event_validation_project WHEN NOT coalesce((
          NEW.project_key IS OLD.project_key AND NEW.instance_id IS OLD.instance_id AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at
          AND ((OLD.active_run_id IS NULL AND NEW.active_run_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM event_validation_run r WHERE r.run_id=NEW.active_run_id AND r.instance_id=NEW.instance_id AND r.project_key=NEW.project_key
              AND r.owner_token=NEW.owner_token AND r.state='queued'))
            OR (OLD.active_run_id IS NOT NULL AND NEW.active_run_id IS NULL AND EXISTS (
            SELECT 1 FROM event_validation_run r WHERE r.run_id=OLD.active_run_id AND r.instance_id=OLD.instance_id AND r.project_key=OLD.project_key
              AND r.owner_token=OLD.owner_token AND r.state IN ('settled','cancelled','superseded'))))
        ),0) BEGIN SELECT RAISE(ABORT,'validation_project_transition'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_project_delete_guard BEFORE DELETE ON event_validation_project BEGIN SELECT RAISE(ABORT,'validation_project_retained'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_run_insert_guard BEFORE INSERT ON event_validation_run WHEN NOT coalesce((
          NEW.state='queued' AND NEW.revision=1 AND NEW.cancel_requested=0 AND NEW.outcome IS NULL
          AND NEW.started_at IS NULL AND NEW.terminal_at IS NULL AND NEW.released_at IS NULL AND NEW.retained_bytes=102825984
          AND json_type(NEW.record,'$.result')='null' AND json_type(NEW.record,'$.snapshotHash')='null'
          AND json_type(NEW.record,'$.processIncarnation')='null' AND json_type(NEW.record,'$.processID')='null'
          AND json_type(NEW.record,'$.workspaceIdentity')='null' AND json_type(NEW.record,'$.resultCurrent')='false'
          AND json_type(NEW.record,'$.configHash')='text' AND length(json_extract(NEW.record,'$.configHash'))=64
          AND json_extract(NEW.record,'$.configHash') NOT GLOB '*[^0-9a-f]*'
        ),0) BEGIN SELECT RAISE(ABORT,'validation_run_initial_state'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_run_identity_guard BEFORE UPDATE ON event_validation_run WHEN NOT coalesce((
          NEW.run_id IS OLD.run_id AND NEW.rule_id IS OLD.rule_id AND NEW.instance_id IS OLD.instance_id AND NEW.project_key IS OLD.project_key
          AND NEW.rule_revision IS OLD.rule_revision AND NEW.content_revision IS OLD.content_revision AND NEW.content_hash IS OLD.content_hash
          AND NEW.recipe_hash IS OLD.recipe_hash AND NEW.owner_token IS OLD.owner_token AND NEW.created_at IS OLD.created_at AND NEW.deadline IS OLD.deadline
          AND NEW.revision=OLD.revision+1 AND NEW.cancel_requested>=OLD.cancel_requested
          AND json_extract(NEW.record,'$.configHash') IS json_extract(OLD.record,'$.configHash')
          AND json_extract(NEW.record,'$.content') IS json_extract(OLD.record,'$.content')
          AND json_extract(NEW.record,'$.testRunID') IS json_extract(OLD.record,'$.testRunID')
          AND json_extract(NEW.record,'$.previewBuildID') IS json_extract(OLD.record,'$.previewBuildID')
          AND json_extract(NEW.record,'$.workspaceBasename') IS json_extract(OLD.record,'$.workspaceBasename')
          AND (json_type(OLD.record,'$.snapshotHash')='null' OR json_extract(NEW.record,'$.snapshotHash') IS json_extract(OLD.record,'$.snapshotHash'))
          AND (json_type(OLD.record,'$.processIncarnation')='null' OR json_extract(NEW.record,'$.processIncarnation') IS json_extract(OLD.record,'$.processIncarnation'))
          AND (json_type(OLD.record,'$.workspaceIdentity')='null' OR json_extract(NEW.record,'$.workspaceIdentity') IS json_extract(OLD.record,'$.workspaceIdentity'))
          AND (json_type(OLD.record,'$.processID')='null' OR json_extract(NEW.record,'$.processID') IS json_extract(OLD.record,'$.processID'))
        ),0) BEGIN SELECT RAISE(ABORT,'validation_run_identity'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_run_transition_guard BEFORE UPDATE ON event_validation_run WHEN NOT coalesce((
          (OLD.state='queued' AND NEW.state='preparing' AND NEW.retained_bytes=OLD.retained_bytes AND NEW.released_at IS NULL
            AND json_remove(NEW.record,'$.revision','$.state') IS json_remove(OLD.record,'$.revision','$.state'))
          OR (OLD.state='preparing' AND NEW.state='preparing' AND NEW.retained_bytes=OLD.retained_bytes AND NEW.released_at IS NULL
            AND json_type(OLD.record,'$.snapshotHash')='null' AND json_type(NEW.record,'$.snapshotHash')='text'
            AND length(json_extract(NEW.record,'$.snapshotHash'))=64 AND json_extract(NEW.record,'$.snapshotHash') NOT GLOB '*[^0-9a-f]*'
            AND json_type(NEW.record,'$.processIncarnation')='text' AND json_type(NEW.record,'$.workspaceIdentity')='object'
            AND json_remove(NEW.record,'$.revision','$.snapshotHash','$.processIncarnation','$.workspaceIdentity') IS
                json_remove(OLD.record,'$.revision','$.snapshotHash','$.processIncarnation','$.workspaceIdentity'))
          OR (OLD.state='preparing' AND NEW.state='dispatching' AND NEW.cancel_requested=0 AND NEW.retained_bytes=OLD.retained_bytes AND NEW.released_at IS NULL
            AND NEW.started_at IS NOT NULL AND json_type(OLD.record,'$.snapshotHash')='text' AND json_type(OLD.record,'$.processIncarnation')='text'
            AND json_type(OLD.record,'$.workspaceIdentity')='object'
            AND json_remove(NEW.record,'$.revision','$.state','$.startedAt') IS json_remove(OLD.record,'$.revision','$.state','$.startedAt'))
          OR (OLD.state IN ('queued','preparing','dispatching') AND NEW.state=OLD.state AND OLD.cancel_requested=0 AND NEW.cancel_requested=1
            AND json_remove(NEW.record,'$.revision','$.cancelRequested') IS json_remove(OLD.record,'$.revision','$.cancelRequested'))
          OR (OLD.state='dispatching' AND NEW.state='dispatching' AND json_type(OLD.record,'$.processID')='null'
            AND json_type(NEW.record,'$.processID')='integer' AND json_extract(NEW.record,'$.processID')>0
            AND json_remove(NEW.record,'$.revision','$.processID') IS json_remove(OLD.record,'$.revision','$.processID'))
          OR (OLD.state IN ('queued','preparing') AND ((NEW.state='cancelled' AND NEW.cancel_requested=1 AND NEW.outcome='cancelled')
              OR (NEW.state='superseded' AND NEW.outcome='refused'))
            AND NEW.started_at IS NULL AND NEW.terminal_at IS NOT NULL AND NEW.retained_bytes=OLD.retained_bytes AND NEW.released_at IS NULL
            AND json_type(NEW.record,'$.result')='null' AND json_type(NEW.record,'$.resultCurrent')='false' AND json_type(NEW.record,'$.processID')='null'
            AND json_remove(NEW.record,'$.revision','$.state','$.outcome','$.terminalAt') IS json_remove(OLD.record,'$.revision','$.state','$.outcome','$.terminalAt'))
          OR (OLD.state='dispatching' AND NEW.state IN ('settled','superseded') AND NEW.outcome IS NOT NULL AND NEW.terminal_at IS NOT NULL
            AND NEW.retained_bytes=OLD.retained_bytes AND NEW.released_at IS NULL AND NEW.started_at IS OLD.started_at
            AND json_type(NEW.record,'$.result')='object' AND json_extract(NEW.record,'$.result.outcome') IS NEW.outcome
            AND json_type(NEW.record,'$.result.stopConfirmed')='true'
            AND json_type(NEW.record,'$.result.stdout.complete')='true' AND json_type(NEW.record,'$.result.stderr.complete')='true'
            AND ((NEW.state='settled' AND json_type(NEW.record,'$.resultCurrent')='true') OR (NEW.state='superseded' AND json_type(NEW.record,'$.resultCurrent')='false'))
            AND json_remove(NEW.record,'$.revision','$.state','$.outcome','$.terminalAt','$.result','$.resultCurrent') IS
                json_remove(OLD.record,'$.revision','$.state','$.outcome','$.terminalAt','$.result','$.resultCurrent'))
          OR (OLD.state='dispatching' AND NEW.state='unknown' AND NEW.outcome IS NULL AND NEW.terminal_at IS NOT NULL
            AND NEW.retained_bytes=OLD.retained_bytes AND NEW.released_at IS NULL
            AND json_type(NEW.record,'$.result')='null' AND json_type(NEW.record,'$.resultCurrent')='false'
            AND json_remove(NEW.record,'$.revision','$.state','$.terminalAt') IS json_remove(OLD.record,'$.revision','$.state','$.terminalAt'))
          OR (OLD.state IN ('settled','cancelled','superseded') AND NEW.state=OLD.state AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
            AND NEW.retained_bytes=0 AND json_type(OLD.record,'$.snapshotHash')='text' AND json_type(OLD.record,'$.workspaceIdentity')='object'
            AND json_remove(NEW.record,'$.revision','$.retainedBytes','$.releasedAt') IS json_remove(OLD.record,'$.revision','$.retainedBytes','$.releasedAt'))
        ),0) BEGIN SELECT RAISE(ABORT,'validation_run_transition'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_run_delete_guard BEFORE DELETE ON event_validation_run BEGIN SELECT RAISE(ABORT,'validation_run_retained'); END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
