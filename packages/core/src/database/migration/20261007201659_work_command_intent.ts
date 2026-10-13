import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261007201659_work_command_intent",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE \`work_command_intent\` (
	\`command_id\` text PRIMARY KEY,
	\`admission_id\` text NOT NULL,
	\`instance_id\` text NOT NULL,
	\`work_id\` text NOT NULL,
	\`root_work_id\` text NOT NULL,
	\`session_id\` text NOT NULL,
	\`input_id\` text NOT NULL,
	\`activity_id\` text NOT NULL,
	\`provider_receipt_id\` text NOT NULL,
	\`provider_attempt_id\` text NOT NULL,
	\`tool_call_id\` text NOT NULL,
	\`owner_token\` text NOT NULL,
	\`session_claim_token\` integer NOT NULL,
	\`binding_hash\` text NOT NULL,
	\`control_revision\` integer NOT NULL,
	\`recipe_id\` text NOT NULL,
	\`recipe_revision\` integer NOT NULL,
	\`recipe_hash\` text NOT NULL,
	\`request_hash\` text NOT NULL,
	\`helper_hash\` text NOT NULL,
	\`runtime_hash\` text NOT NULL,
	\`workspace_basename\` text NOT NULL,
	\`state\` text NOT NULL,
	\`outcome\` text,
	\`revision\` integer NOT NULL,
	\`reserved_bytes\` integer NOT NULL,
	\`observed_retained_bytes\` integer NOT NULL,
	\`record\` text NOT NULL,
	\`record_hash\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	\`prepared_at\` integer,
	\`dispatched_at\` integer,
	\`terminal_at\` integer,
	\`released_at\` integer,
	\`deadline\` integer NOT NULL,
	CONSTRAINT \`fk_work_command_intent_instance_id_work_command_meter_instance_id_fk\` FOREIGN KEY (\`instance_id\`) REFERENCES \`work_command_meter\`(\`instance_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT \`fk_work_command_intent_admission_id_session_v2_tool_effect_admission_admission_id_fk\` FOREIGN KEY (\`admission_id\`) REFERENCES \`session_v2_tool_effect_admission\`(\`admission_id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "work_command_intent_command_id_text_check" CHECK(typeof("command_id")='text' AND length(CAST("command_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("command_id",char(0))=0),
	CONSTRAINT "work_command_intent_admission_id_text_check" CHECK(typeof("admission_id")='text' AND length(CAST("admission_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("admission_id",char(0))=0),
	CONSTRAINT "work_command_intent_instance_id_text_check" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
	CONSTRAINT "work_command_intent_work_id_text_check" CHECK(typeof("work_id")='text' AND length(CAST("work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("work_id",char(0))=0),
	CONSTRAINT "work_command_intent_root_work_id_text_check" CHECK(typeof("root_work_id")='text' AND length(CAST("root_work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("root_work_id",char(0))=0),
	CONSTRAINT "work_command_intent_session_id_text_check" CHECK(typeof("session_id")='text' AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("session_id",char(0))=0),
	CONSTRAINT "work_command_intent_input_id_text_check" CHECK(typeof("input_id")='text' AND length(CAST("input_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("input_id",char(0))=0),
	CONSTRAINT "work_command_intent_activity_id_text_check" CHECK(typeof("activity_id")='text' AND length(CAST("activity_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("activity_id",char(0))=0),
	CONSTRAINT "work_command_intent_provider_receipt_id_text_check" CHECK(typeof("provider_receipt_id")='text' AND length(CAST("provider_receipt_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("provider_receipt_id",char(0))=0),
	CONSTRAINT "work_command_intent_provider_attempt_id_text_check" CHECK(typeof("provider_attempt_id")='text' AND length(CAST("provider_attempt_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("provider_attempt_id",char(0))=0),
	CONSTRAINT "work_command_intent_tool_call_id_text_check" CHECK(typeof("tool_call_id")='text' AND length(CAST("tool_call_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("tool_call_id",char(0))=0),
	CONSTRAINT "work_command_intent_owner_token_text_check" CHECK(typeof("owner_token")='text' AND length(CAST("owner_token" AS BLOB)) BETWEEN 1 AND 512 AND instr("owner_token",char(0))=0),
	CONSTRAINT "work_command_intent_recipe_id_text_check" CHECK(typeof("recipe_id")='text' AND length(CAST("recipe_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("recipe_id",char(0))=0),
	CONSTRAINT "work_command_intent_binding_hash_hash_check" CHECK(typeof("binding_hash")='text' AND length(CAST("binding_hash" AS BLOB))=64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_command_intent_recipe_hash_hash_check" CHECK(typeof("recipe_hash")='text' AND length(CAST("recipe_hash" AS BLOB))=64 AND "recipe_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_command_intent_request_hash_hash_check" CHECK(typeof("request_hash")='text' AND length(CAST("request_hash" AS BLOB))=64 AND "request_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_command_intent_helper_hash_hash_check" CHECK(typeof("helper_hash")='text' AND length(CAST("helper_hash" AS BLOB))=64 AND "helper_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_command_intent_runtime_hash_hash_check" CHECK(typeof("runtime_hash")='text' AND length(CAST("runtime_hash" AS BLOB))=64 AND "runtime_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_command_intent_record_hash_hash_check" CHECK(typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_command_intent_session_claim_token_integer_check" CHECK(typeof("session_claim_token")='integer' AND "session_claim_token" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_command_intent_control_revision_integer_check" CHECK(typeof("control_revision")='integer' AND "control_revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_command_intent_recipe_revision_integer_check" CHECK(typeof("recipe_revision")='integer' AND "recipe_revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_command_intent_revision_integer_check" CHECK(typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_command_intent_created_at_integer_check" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_command_intent_updated_at_integer_check" CHECK(typeof("updated_at")='integer' AND "updated_at" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_command_intent_deadline_integer_check" CHECK(typeof("deadline")='integer' AND "deadline" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_command_intent_reserved_bytes_bytes_check" CHECK(typeof("reserved_bytes")='integer' AND "reserved_bytes" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "work_command_intent_observed_retained_bytes_bytes_check" CHECK(typeof("observed_retained_bytes")='integer' AND "observed_retained_bytes" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "work_command_intent_prepared_at_time_check" CHECK("prepared_at" IS NULL OR (typeof("prepared_at")='integer' AND "prepared_at" BETWEEN "created_at" AND "updated_at")),
	CONSTRAINT "work_command_intent_dispatched_at_time_check" CHECK("dispatched_at" IS NULL OR (typeof("dispatched_at")='integer' AND "dispatched_at" BETWEEN "created_at" AND "updated_at")),
	CONSTRAINT "work_command_intent_terminal_at_time_check" CHECK("terminal_at" IS NULL OR (typeof("terminal_at")='integer' AND "terminal_at" BETWEEN "created_at" AND "updated_at")),
	CONSTRAINT "work_command_intent_released_at_time_check" CHECK("released_at" IS NULL OR (typeof("released_at")='integer' AND "released_at" BETWEEN "created_at" AND "updated_at")),
	CONSTRAINT "work_command_intent_basename_check" CHECK(typeof("workspace_basename")='text' AND length(CAST("workspace_basename" AS BLOB))=36 AND substr("workspace_basename",1,4)='cmd_' AND substr("workspace_basename",5) NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_command_intent_time_check" CHECK("updated_at">="created_at" AND "deadline">"created_at" AND ("dispatched_at" IS NULL OR ("prepared_at" IS NOT NULL AND "dispatched_at">="prepared_at")) AND ("terminal_at" IS NULL OR "terminal_at">=coalesce("dispatched_at","prepared_at","created_at"))),
	CONSTRAINT "work_command_intent_state_check" CHECK("state" IN ('reserved','prepared','dispatching','settled','unknown') AND (("state"='settled' AND "terminal_at" IS NOT NULL AND "outcome" IS NOT NULL AND "outcome" IN ('exited','cancelled','refused_before_dispatch')) OR ("state"<>'settled' AND "outcome" IS NULL AND "terminal_at" IS NULL)) AND ("state"<>'reserved' OR ("prepared_at" IS NULL AND "dispatched_at" IS NULL)) AND ("state"<>'prepared' OR ("prepared_at" IS NOT NULL AND "dispatched_at" IS NULL)) AND ("state" NOT IN ('dispatching','unknown') OR "dispatched_at" IS NOT NULL) AND ("state"<>'settled' OR ("outcome"='refused_before_dispatch' AND "dispatched_at" IS NULL) OR ("outcome" IN ('exited','cancelled') AND "dispatched_at" IS NOT NULL))),
	CONSTRAINT "work_command_intent_custody_check" CHECK(("released_at" IS NULL AND "reserved_bytes">0) OR ("released_at" IS NOT NULL AND "state"='settled' AND "reserved_bytes"=0 AND "observed_retained_bytes"=0)),
	CONSTRAINT "work_command_intent_record_check" CHECK(typeof("record")='text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 32768 AND instr("record",char(0))=0 AND json_valid("record") AND json_type("record") IS 'object' AND json_type("record",'$.version') IS 'integer' AND json_extract("record",'$.version') IS 1),
	CONSTRAINT "work_command_intent_command_id_mirror_check" CHECK(json_type("record",'$.commandID') IS 'text' AND json_extract("record",'$.commandID') IS "command_id"),
	CONSTRAINT "work_command_intent_admission_id_mirror_check" CHECK(json_type("record",'$.admissionID') IS 'text' AND json_extract("record",'$.admissionID') IS "admission_id"),
	CONSTRAINT "work_command_intent_instance_id_mirror_check" CHECK(json_type("record",'$.instanceID') IS 'text' AND json_extract("record",'$.instanceID') IS "instance_id"),
	CONSTRAINT "work_command_intent_work_id_mirror_check" CHECK(json_type("record",'$.workID') IS 'text' AND json_extract("record",'$.workID') IS "work_id"),
	CONSTRAINT "work_command_intent_root_work_id_mirror_check" CHECK(json_type("record",'$.rootWorkID') IS 'text' AND json_extract("record",'$.rootWorkID') IS "root_work_id"),
	CONSTRAINT "work_command_intent_session_id_mirror_check" CHECK(json_type("record",'$.sessionID') IS 'text' AND json_extract("record",'$.sessionID') IS "session_id"),
	CONSTRAINT "work_command_intent_input_id_mirror_check" CHECK(json_type("record",'$.inputID') IS 'text' AND json_extract("record",'$.inputID') IS "input_id"),
	CONSTRAINT "work_command_intent_activity_id_mirror_check" CHECK(json_type("record",'$.activityID') IS 'text' AND json_extract("record",'$.activityID') IS "activity_id"),
	CONSTRAINT "work_command_intent_provider_receipt_id_mirror_check" CHECK(json_type("record",'$.providerReceiptID') IS 'text' AND json_extract("record",'$.providerReceiptID') IS "provider_receipt_id"),
	CONSTRAINT "work_command_intent_provider_attempt_id_mirror_check" CHECK(json_type("record",'$.providerAttemptID') IS 'text' AND json_extract("record",'$.providerAttemptID') IS "provider_attempt_id"),
	CONSTRAINT "work_command_intent_tool_call_id_mirror_check" CHECK(json_type("record",'$.toolCallID') IS 'text' AND json_extract("record",'$.toolCallID') IS "tool_call_id"),
	CONSTRAINT "work_command_intent_owner_token_mirror_check" CHECK(json_type("record",'$.ownerToken') IS 'text' AND json_extract("record",'$.ownerToken') IS "owner_token"),
	CONSTRAINT "work_command_intent_binding_hash_mirror_check" CHECK(json_type("record",'$.bindingHash') IS 'text' AND json_extract("record",'$.bindingHash') IS "binding_hash"),
	CONSTRAINT "work_command_intent_recipe_id_mirror_check" CHECK(json_type("record",'$.recipeID') IS 'text' AND json_extract("record",'$.recipeID') IS "recipe_id"),
	CONSTRAINT "work_command_intent_recipe_hash_mirror_check" CHECK(json_type("record",'$.recipeHash') IS 'text' AND json_extract("record",'$.recipeHash') IS "recipe_hash"),
	CONSTRAINT "work_command_intent_request_hash_mirror_check" CHECK(json_type("record",'$.requestHash') IS 'text' AND json_extract("record",'$.requestHash') IS "request_hash"),
	CONSTRAINT "work_command_intent_helper_hash_mirror_check" CHECK(json_type("record",'$.helperHash') IS 'text' AND json_extract("record",'$.helperHash') IS "helper_hash"),
	CONSTRAINT "work_command_intent_runtime_hash_mirror_check" CHECK(json_type("record",'$.runtimeHash') IS 'text' AND json_extract("record",'$.runtimeHash') IS "runtime_hash"),
	CONSTRAINT "work_command_intent_workspace_basename_mirror_check" CHECK(json_type("record",'$.workspaceBasename') IS 'text' AND json_extract("record",'$.workspaceBasename') IS "workspace_basename"),
	CONSTRAINT "work_command_intent_state_mirror_check" CHECK(json_type("record",'$.state') IS 'text' AND json_extract("record",'$.state') IS "state"),
	CONSTRAINT "work_command_intent_session_claim_token_mirror_check" CHECK(json_type("record",'$.sessionClaimToken') IS 'integer' AND json_extract("record",'$.sessionClaimToken') IS "session_claim_token"),
	CONSTRAINT "work_command_intent_control_revision_mirror_check" CHECK(json_type("record",'$.controlRevision') IS 'integer' AND json_extract("record",'$.controlRevision') IS "control_revision"),
	CONSTRAINT "work_command_intent_recipe_revision_mirror_check" CHECK(json_type("record",'$.recipeRevision') IS 'integer' AND json_extract("record",'$.recipeRevision') IS "recipe_revision"),
	CONSTRAINT "work_command_intent_revision_mirror_check" CHECK(json_type("record",'$.revision') IS 'integer' AND json_extract("record",'$.revision') IS "revision"),
	CONSTRAINT "work_command_intent_deadline_mirror_check" CHECK(json_type("record",'$.deadline') IS 'integer' AND json_extract("record",'$.deadline') IS "deadline"),
	CONSTRAINT "work_command_intent_reserved_bytes_mirror_check" CHECK(json_type("record",'$.reservedBytes') IS 'integer' AND json_extract("record",'$.reservedBytes') IS "reserved_bytes"),
	CONSTRAINT "work_command_intent_observed_retained_bytes_mirror_check" CHECK(json_type("record",'$.observedRetainedBytes') IS 'integer' AND json_extract("record",'$.observedRetainedBytes') IS "observed_retained_bytes"),
	CONSTRAINT "work_command_intent_created_at_mirror_check" CHECK(json_type("record",'$.createdAt') IS 'integer' AND json_extract("record",'$.createdAt') IS "created_at"),
	CONSTRAINT "work_command_intent_updated_at_mirror_check" CHECK(json_type("record",'$.updatedAt') IS 'integer' AND json_extract("record",'$.updatedAt') IS "updated_at"),
	CONSTRAINT "work_command_intent_prepared_at_mirror_check" CHECK(("prepared_at" IS NULL AND json_type("record",'$.preparedAt') IS 'null') OR ("prepared_at" IS NOT NULL AND json_type("record",'$.preparedAt') IS 'integer' AND json_extract("record",'$.preparedAt') IS "prepared_at")),
	CONSTRAINT "work_command_intent_dispatched_at_mirror_check" CHECK(("dispatched_at" IS NULL AND json_type("record",'$.dispatchedAt') IS 'null') OR ("dispatched_at" IS NOT NULL AND json_type("record",'$.dispatchedAt') IS 'integer' AND json_extract("record",'$.dispatchedAt') IS "dispatched_at")),
	CONSTRAINT "work_command_intent_terminal_at_mirror_check" CHECK(("terminal_at" IS NULL AND json_type("record",'$.terminalAt') IS 'null') OR ("terminal_at" IS NOT NULL AND json_type("record",'$.terminalAt') IS 'integer' AND json_extract("record",'$.terminalAt') IS "terminal_at")),
	CONSTRAINT "work_command_intent_released_at_mirror_check" CHECK(("released_at" IS NULL AND json_type("record",'$.releasedAt') IS 'null') OR ("released_at" IS NOT NULL AND json_type("record",'$.releasedAt') IS 'integer' AND json_extract("record",'$.releasedAt') IS "released_at")),
	CONSTRAINT "work_command_intent_outcome_mirror_check" CHECK(("outcome" IS NULL AND json_type("record",'$.outcome') IS 'null') OR ("outcome" IS NOT NULL AND json_type("record",'$.outcome') IS 'text' AND json_extract("record",'$.outcome') IS "outcome")),
	CONSTRAINT "work_command_intent_workspace_check" CHECK("prepared_at" IS NULL OR (json_type("record",'$.workspaceIdentity') IS 'object' AND json_type("record",'$.snapshotHash') IS 'text')),
	CONSTRAINT "work_command_intent_stop_check" CHECK((json_type("record",'$.stopConfirmed') IS 'true' OR json_type("record",'$.stopConfirmed') IS 'false') AND ("state"<>'settled' OR json_type("record",'$.stopConfirmed') IS 'true'))
);`)
      yield* tx.run(`CREATE TABLE \`work_command_meter\` (
	\`instance_id\` text PRIMARY KEY,
	\`custody_count\` integer NOT NULL,
	\`retained_bytes\` integer NOT NULL,
	\`audit_count\` integer NOT NULL,
	\`revision\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT "work_command_meter_instance_check" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
	CONSTRAINT "work_command_meter_count_check" CHECK(typeof("custody_count")='integer' AND "custody_count" BETWEEN 0 AND 8 AND typeof("audit_count")='integer' AND "audit_count" BETWEEN 0 AND 10000 AND "custody_count"<="audit_count"),
	CONSTRAINT "work_command_meter_bytes_check" CHECK(typeof("retained_bytes")='integer' AND "retained_bytes" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "work_command_meter_time_check" CHECK(typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991 AND typeof("updated_at")='integer' AND "updated_at" BETWEEN 1 AND 9007199254740991)
);`)
      yield* tx.run(`ALTER TABLE \`session_v2_tool_effect\` ADD COLUMN \`known_command_proof\` text CONSTRAINT session_v2_tool_effect_known_command_proof_check CHECK("known_command_proof" IS NULL OR CASE WHEN typeof("known_command_proof") = 'text' AND length(CAST("known_command_proof" AS BLOB)) BETWEEN 1 AND 16384 AND instr("known_command_proof", char(0)) = 0 AND json_valid("known_command_proof") THEN coalesce(json_type("known_command_proof") = 'object' AND json_type("known_command_proof", '$.version') = 'integer' AND json_extract("known_command_proof", '$.version') = 1 AND "tool_name" = 'managed_command' AND "effect_kind" = 'mutating' AND "state" = 'settled' AND "error_code" IS NULL AND "known_read_proof" IS NULL AND "known_write_proof" IS NULL, 0) ELSE 0 END);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_command_intent_admission_idx\` ON \`work_command_intent\` (\`admission_id\`);`)
      yield* tx.run(`CREATE INDEX \`work_command_intent_custody_idx\` ON \`work_command_intent\` (\`instance_id\`,\`released_at\`,\`command_id\`);`)
      yield* tx.run(`CREATE INDEX \`work_command_intent_work_idx\` ON \`work_command_intent\` (\`work_id\`,\`created_at\`,\`command_id\`);`)
      yield* tx.run(`CREATE TRIGGER work_command_intent_binding_insert BEFORE INSERT ON work_command_intent
BEGIN
 SELECT CASE WHEN NEW.state<>'reserved' OR NEW.revision<>1 OR NEW.released_at IS NOT NULL
  OR NEW.observed_retained_bytes<>0 OR NEW.prepared_at IS NOT NULL OR NEW.dispatched_at IS NOT NULL
  OR NEW.terminal_at IS NOT NULL OR json_type(NEW.record,'$.workspaceIdentity') IS NOT 'null'
  OR json_type(NEW.record,'$.snapshotHash') IS NOT 'null'
  OR json_type(NEW.record,'$.processIncarnation') IS NOT 'null' OR json_type(NEW.record,'$.processID') IS NOT 'null'
  OR json_type(NEW.record,'$.stdout') IS NOT 'null' OR json_type(NEW.record,'$.stderr') IS NOT 'null'
  OR json_type(NEW.record,'$.outputs') IS NOT 'array' OR json_array_length(NEW.record,'$.outputs')<>0
  OR json_type(NEW.record,'$.stopConfirmed') IS NOT 'false'
  OR NEW.reserved_bytes>102825984
  OR NOT EXISTS (
   SELECT 1 FROM work_execution w JOIN session s ON s.id=w.session_id
    JOIN session_v2_tool_effect_admission a ON a.admission_id=NEW.admission_id
    JOIN session_v2_provider_turn_receipt r ON r.receipt_id=a.receipt_id
   WHERE w.work_id=NEW.work_id AND w.root_work_id=NEW.root_work_id AND w.session_id=NEW.session_id
    AND w.input_id=NEW.input_id AND w.binding_hash=NEW.binding_hash AND w.control_revision=NEW.control_revision
    AND w.binding_version=2 AND w.admission_state='ready' AND w.control_state='active' AND w.outcome='pending'
    AND json_extract(w.binding,'$.profile.id') IS 'project_work_v1'
    AND json_extract(w.binding,'$.projectScope.helperHash') IS NEW.helper_hash
    AND s.execution_claim_token IS NEW.session_claim_token
    AND a.session_id=NEW.session_id AND a.receipt_id=NEW.provider_receipt_id
    AND a.provider_attempt_id=NEW.provider_attempt_id AND a.tool_call_id=NEW.tool_call_id
    AND a.tool_name='managed_command' AND a.effect_kind='mutating' AND a.owner_token=NEW.owner_token
    AND r.session_id=NEW.session_id AND r.provider_attempt_id=NEW.provider_attempt_id
    AND r.activity_id=NEW.activity_id AND r.owner_token=NEW.owner_token
    AND EXISTS (SELECT 1 FROM json_each(w.binding,'$.toolPolicy.commandRecipes') recipe
     WHERE json_extract(recipe.value,'$.logicalID') IS NEW.recipe_id
      AND json_extract(recipe.value,'$.revision') IS NEW.recipe_revision
      AND json_extract(recipe.value,'$.executable.sha256') IS NEW.runtime_hash)
    AND EXISTS (SELECT 1 FROM json_each(w.binding,'$.toolPolicy.capabilities') capability
     WHERE json_extract(capability.value,'$.toolID') IS 'managed_command'
      AND EXISTS (SELECT 1 FROM json_each(capability.value,'$.operations') operation WHERE operation.value='run'))
  ) THEN RAISE(ABORT,'work_command_intent_binding_conflict') END;
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM work_command_meter m WHERE m.instance_id=NEW.instance_id
   AND m.custody_count BETWEEN 1 AND 8 AND m.audit_count BETWEEN 1 AND 10000
   AND m.retained_bytes BETWEEN NEW.reserved_bytes AND 822607872
 ) THEN RAISE(ABORT,'work_command_intent_capacity') END;
END;`)
      yield* tx.run(`CREATE TRIGGER work_command_intent_identity_update BEFORE UPDATE ON work_command_intent
WHEN NEW.command_id IS NOT OLD.command_id OR NEW.admission_id IS NOT OLD.admission_id
 OR NEW.instance_id IS NOT OLD.instance_id OR NEW.work_id IS NOT OLD.work_id
 OR NEW.root_work_id IS NOT OLD.root_work_id OR NEW.session_id IS NOT OLD.session_id
 OR NEW.input_id IS NOT OLD.input_id OR NEW.activity_id IS NOT OLD.activity_id
 OR NEW.provider_receipt_id IS NOT OLD.provider_receipt_id OR NEW.provider_attempt_id IS NOT OLD.provider_attempt_id
 OR NEW.tool_call_id IS NOT OLD.tool_call_id OR NEW.owner_token IS NOT OLD.owner_token
 OR NEW.session_claim_token IS NOT OLD.session_claim_token OR NEW.binding_hash IS NOT OLD.binding_hash
 OR NEW.control_revision IS NOT OLD.control_revision OR NEW.recipe_id IS NOT OLD.recipe_id
 OR NEW.recipe_revision IS NOT OLD.recipe_revision OR NEW.recipe_hash IS NOT OLD.recipe_hash
 OR NEW.request_hash IS NOT OLD.request_hash OR NEW.helper_hash IS NOT OLD.helper_hash
 OR NEW.runtime_hash IS NOT OLD.runtime_hash OR NEW.workspace_basename IS NOT OLD.workspace_basename
 OR NEW.created_at IS NOT OLD.created_at OR NEW.deadline IS NOT OLD.deadline
 OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR OLD.released_at IS NOT NULL
 OR (NEW.released_at IS NULL AND NEW.reserved_bytes IS NOT OLD.reserved_bytes)
 OR (OLD.prepared_at IS NOT NULL AND NEW.prepared_at IS NOT OLD.prepared_at)
 OR (OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at)
 OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS NOT OLD.terminal_at)
 OR (json_type(OLD.record,'$.workspaceIdentity') IS NOT 'null' AND json_extract(NEW.record,'$.workspaceIdentity') IS NOT json_extract(OLD.record,'$.workspaceIdentity'))
 OR (json_type(OLD.record,'$.snapshotHash') IS NOT 'null' AND json_extract(NEW.record,'$.snapshotHash') IS NOT json_extract(OLD.record,'$.snapshotHash'))
 OR (json_type(OLD.record,'$.processIncarnation') IS NOT 'null' AND json_extract(NEW.record,'$.processIncarnation') IS NOT json_extract(OLD.record,'$.processIncarnation'))
 OR (json_type(OLD.record,'$.processID') IS NOT 'null' AND json_extract(NEW.record,'$.processID') IS NOT json_extract(OLD.record,'$.processID'))
 OR (OLD.state='settled' AND (NEW.outcome IS NOT OLD.outcome
  OR json_extract(NEW.record,'$.exitCode') IS NOT json_extract(OLD.record,'$.exitCode')
  OR json_extract(NEW.record,'$.signal') IS NOT json_extract(OLD.record,'$.signal')
  OR json_extract(NEW.record,'$.stdout') IS NOT json_extract(OLD.record,'$.stdout')
  OR json_extract(NEW.record,'$.stderr') IS NOT json_extract(OLD.record,'$.stderr')
  OR json_extract(NEW.record,'$.outputs') IS NOT json_extract(OLD.record,'$.outputs')))
BEGIN SELECT RAISE(ABORT,'work_command_intent_identity_immutable'); END;`)
      yield* tx.run(`CREATE TRIGGER work_command_intent_phase_update BEFORE UPDATE ON work_command_intent
WHEN NOT (
 (OLD.state='reserved' AND NEW.state IN ('reserved','prepared','settled'))
 OR (OLD.state='prepared' AND NEW.state IN ('prepared','dispatching','settled'))
 OR (OLD.state='dispatching' AND NEW.state IN ('dispatching','settled','unknown'))
 OR (OLD.state='unknown' AND NEW.state='unknown')
 OR (OLD.state='settled' AND NEW.state='settled')
) OR (OLD.state IN ('reserved','prepared') AND NEW.state='settled' AND NEW.outcome<>'refused_before_dispatch')
 OR (NEW.state='settled' AND NEW.outcome IN ('exited','cancelled') AND
  (json_type(NEW.record,'$.stdout') IS NOT 'object' OR json_type(NEW.record,'$.stderr') IS NOT 'object'
   OR json_type(NEW.record,'$.stdout.complete') IS NOT 'true' OR json_type(NEW.record,'$.stderr.complete') IS NOT 'true'))
 OR (NEW.state IN ('dispatching','unknown') AND json_type(NEW.record,'$.processIncarnation') IS NOT 'text')
 OR (NEW.released_at IS NOT NULL AND NEW.released_at<NEW.terminal_at)
BEGIN SELECT RAISE(ABORT,'work_command_intent_phase_conflict'); END;`)
      yield* tx.run(`CREATE TRIGGER work_command_intent_delete BEFORE DELETE ON work_command_intent
BEGIN SELECT RAISE(ABORT,'work_command_intent_audit_immutable'); END;`)
      yield* tx.run(`CREATE TRIGGER work_command_meter_update BEFORE UPDATE ON work_command_meter
WHEN NEW.instance_id IS NOT OLD.instance_id OR NEW.revision<>OLD.revision+1
 OR NEW.updated_at<OLD.updated_at OR NEW.audit_count<OLD.audit_count OR NEW.audit_count>OLD.audit_count+1
BEGIN SELECT RAISE(ABORT,'work_command_meter_conflict'); END;`)
      yield* tx.run(`CREATE TRIGGER work_command_meter_delete BEFORE DELETE ON work_command_meter
BEGIN SELECT RAISE(ABORT,'work_command_meter_immutable'); END;`)
    })
  },
} satisfies DatabaseMigration.Migration
