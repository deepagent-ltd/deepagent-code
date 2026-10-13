PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_work_command_intent` (
	`command_id` text PRIMARY KEY,
	`admission_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`work_id` text NOT NULL,
	`root_work_id` text NOT NULL,
	`session_id` text NOT NULL,
	`input_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`provider_receipt_id` text NOT NULL,
	`provider_attempt_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`owner_token` text NOT NULL,
	`session_claim_token` integer NOT NULL,
	`binding_hash` text NOT NULL,
	`control_revision` integer NOT NULL,
	`recipe_id` text NOT NULL,
	`recipe_revision` integer NOT NULL,
	`recipe_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`helper_hash` text NOT NULL,
	`runtime_hash` text NOT NULL,
	`workspace_basename` text NOT NULL,
	`state` text NOT NULL,
	`outcome` text,
	`revision` integer NOT NULL,
	`reserved_bytes` integer NOT NULL,
	`observed_retained_bytes` integer NOT NULL,
	`record` text NOT NULL,
	`record_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`prepared_at` integer,
	`dispatched_at` integer,
	`terminal_at` integer,
	`released_at` integer,
	`deadline` integer NOT NULL,
	CONSTRAINT `fk_work_command_intent_instance_id_work_command_meter_instance_id_fk` FOREIGN KEY (`instance_id`) REFERENCES `work_command_meter`(`instance_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_work_command_intent_admission_id_session_v2_tool_effect_admission_admission_id_fk` FOREIGN KEY (`admission_id`) REFERENCES `session_v2_tool_effect_admission`(`admission_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
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
	CONSTRAINT "work_command_intent_record_check" CHECK(typeof("record")='text' AND length(CAST("record" AS BLOB)) BETWEEN 1 AND 32768 AND instr("record",char(0))=0 AND json_valid("record") AND json_type("record") IS 'object' AND json_type("record",'$.version') IS 'integer'
    AND (json_extract("record",'$.version') IS 1 OR (json_extract("record",'$.version') IS 2
      AND json_type("record",'$.target') IS 'text' AND json_extract("record",'$.target') IN ('win32-x64','win32-arm64')
      AND (json_type("record",'$.workspaceIdentity') IS 'null' OR (json_type("record",'$.workspaceIdentity') IS 'object'
    AND json_type("record",'$.workspaceIdentity.kind') IS 'text' AND json_extract("record",'$.workspaceIdentity.kind') IS 'windows'
    AND json_type("record",'$.workspaceIdentity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.workspaceIdentity.volumeSerial'))=16 AND json_extract("record",'$.workspaceIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.workspaceIdentity.fileID') IS 'text'
    AND length(json_extract("record",'$.workspaceIdentity.fileID'))=32 AND json_extract("record",'$.workspaceIdentity.fileID') NOT GLOB '*[^0-9a-f]*'))
      AND json_type("record",'$.outputs') IS 'array' AND json_array_length("record",'$.outputs')<=32
      AND (json_array_length("record",'$.outputs')<=0 OR (json_type("record",'$.outputs[0].identity') IS 'object'
    AND json_type("record",'$.outputs[0].identity.kind') IS 'text' AND json_extract("record",'$.outputs[0].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[0].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[0].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[0].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[0].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[0].identity.fileID'))=32 AND json_extract("record",'$.outputs[0].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=1 OR (json_type("record",'$.outputs[1].identity') IS 'object'
    AND json_type("record",'$.outputs[1].identity.kind') IS 'text' AND json_extract("record",'$.outputs[1].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[1].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[1].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[1].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[1].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[1].identity.fileID'))=32 AND json_extract("record",'$.outputs[1].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=2 OR (json_type("record",'$.outputs[2].identity') IS 'object'
    AND json_type("record",'$.outputs[2].identity.kind') IS 'text' AND json_extract("record",'$.outputs[2].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[2].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[2].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[2].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[2].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[2].identity.fileID'))=32 AND json_extract("record",'$.outputs[2].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=3 OR (json_type("record",'$.outputs[3].identity') IS 'object'
    AND json_type("record",'$.outputs[3].identity.kind') IS 'text' AND json_extract("record",'$.outputs[3].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[3].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[3].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[3].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[3].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[3].identity.fileID'))=32 AND json_extract("record",'$.outputs[3].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=4 OR (json_type("record",'$.outputs[4].identity') IS 'object'
    AND json_type("record",'$.outputs[4].identity.kind') IS 'text' AND json_extract("record",'$.outputs[4].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[4].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[4].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[4].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[4].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[4].identity.fileID'))=32 AND json_extract("record",'$.outputs[4].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=5 OR (json_type("record",'$.outputs[5].identity') IS 'object'
    AND json_type("record",'$.outputs[5].identity.kind') IS 'text' AND json_extract("record",'$.outputs[5].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[5].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[5].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[5].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[5].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[5].identity.fileID'))=32 AND json_extract("record",'$.outputs[5].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=6 OR (json_type("record",'$.outputs[6].identity') IS 'object'
    AND json_type("record",'$.outputs[6].identity.kind') IS 'text' AND json_extract("record",'$.outputs[6].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[6].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[6].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[6].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[6].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[6].identity.fileID'))=32 AND json_extract("record",'$.outputs[6].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=7 OR (json_type("record",'$.outputs[7].identity') IS 'object'
    AND json_type("record",'$.outputs[7].identity.kind') IS 'text' AND json_extract("record",'$.outputs[7].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[7].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[7].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[7].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[7].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[7].identity.fileID'))=32 AND json_extract("record",'$.outputs[7].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=8 OR (json_type("record",'$.outputs[8].identity') IS 'object'
    AND json_type("record",'$.outputs[8].identity.kind') IS 'text' AND json_extract("record",'$.outputs[8].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[8].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[8].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[8].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[8].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[8].identity.fileID'))=32 AND json_extract("record",'$.outputs[8].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=9 OR (json_type("record",'$.outputs[9].identity') IS 'object'
    AND json_type("record",'$.outputs[9].identity.kind') IS 'text' AND json_extract("record",'$.outputs[9].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[9].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[9].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[9].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[9].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[9].identity.fileID'))=32 AND json_extract("record",'$.outputs[9].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=10 OR (json_type("record",'$.outputs[10].identity') IS 'object'
    AND json_type("record",'$.outputs[10].identity.kind') IS 'text' AND json_extract("record",'$.outputs[10].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[10].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[10].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[10].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[10].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[10].identity.fileID'))=32 AND json_extract("record",'$.outputs[10].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=11 OR (json_type("record",'$.outputs[11].identity') IS 'object'
    AND json_type("record",'$.outputs[11].identity.kind') IS 'text' AND json_extract("record",'$.outputs[11].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[11].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[11].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[11].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[11].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[11].identity.fileID'))=32 AND json_extract("record",'$.outputs[11].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=12 OR (json_type("record",'$.outputs[12].identity') IS 'object'
    AND json_type("record",'$.outputs[12].identity.kind') IS 'text' AND json_extract("record",'$.outputs[12].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[12].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[12].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[12].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[12].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[12].identity.fileID'))=32 AND json_extract("record",'$.outputs[12].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=13 OR (json_type("record",'$.outputs[13].identity') IS 'object'
    AND json_type("record",'$.outputs[13].identity.kind') IS 'text' AND json_extract("record",'$.outputs[13].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[13].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[13].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[13].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[13].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[13].identity.fileID'))=32 AND json_extract("record",'$.outputs[13].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=14 OR (json_type("record",'$.outputs[14].identity') IS 'object'
    AND json_type("record",'$.outputs[14].identity.kind') IS 'text' AND json_extract("record",'$.outputs[14].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[14].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[14].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[14].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[14].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[14].identity.fileID'))=32 AND json_extract("record",'$.outputs[14].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=15 OR (json_type("record",'$.outputs[15].identity') IS 'object'
    AND json_type("record",'$.outputs[15].identity.kind') IS 'text' AND json_extract("record",'$.outputs[15].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[15].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[15].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[15].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[15].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[15].identity.fileID'))=32 AND json_extract("record",'$.outputs[15].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=16 OR (json_type("record",'$.outputs[16].identity') IS 'object'
    AND json_type("record",'$.outputs[16].identity.kind') IS 'text' AND json_extract("record",'$.outputs[16].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[16].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[16].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[16].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[16].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[16].identity.fileID'))=32 AND json_extract("record",'$.outputs[16].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=17 OR (json_type("record",'$.outputs[17].identity') IS 'object'
    AND json_type("record",'$.outputs[17].identity.kind') IS 'text' AND json_extract("record",'$.outputs[17].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[17].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[17].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[17].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[17].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[17].identity.fileID'))=32 AND json_extract("record",'$.outputs[17].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=18 OR (json_type("record",'$.outputs[18].identity') IS 'object'
    AND json_type("record",'$.outputs[18].identity.kind') IS 'text' AND json_extract("record",'$.outputs[18].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[18].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[18].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[18].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[18].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[18].identity.fileID'))=32 AND json_extract("record",'$.outputs[18].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=19 OR (json_type("record",'$.outputs[19].identity') IS 'object'
    AND json_type("record",'$.outputs[19].identity.kind') IS 'text' AND json_extract("record",'$.outputs[19].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[19].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[19].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[19].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[19].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[19].identity.fileID'))=32 AND json_extract("record",'$.outputs[19].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=20 OR (json_type("record",'$.outputs[20].identity') IS 'object'
    AND json_type("record",'$.outputs[20].identity.kind') IS 'text' AND json_extract("record",'$.outputs[20].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[20].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[20].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[20].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[20].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[20].identity.fileID'))=32 AND json_extract("record",'$.outputs[20].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=21 OR (json_type("record",'$.outputs[21].identity') IS 'object'
    AND json_type("record",'$.outputs[21].identity.kind') IS 'text' AND json_extract("record",'$.outputs[21].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[21].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[21].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[21].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[21].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[21].identity.fileID'))=32 AND json_extract("record",'$.outputs[21].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=22 OR (json_type("record",'$.outputs[22].identity') IS 'object'
    AND json_type("record",'$.outputs[22].identity.kind') IS 'text' AND json_extract("record",'$.outputs[22].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[22].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[22].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[22].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[22].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[22].identity.fileID'))=32 AND json_extract("record",'$.outputs[22].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=23 OR (json_type("record",'$.outputs[23].identity') IS 'object'
    AND json_type("record",'$.outputs[23].identity.kind') IS 'text' AND json_extract("record",'$.outputs[23].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[23].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[23].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[23].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[23].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[23].identity.fileID'))=32 AND json_extract("record",'$.outputs[23].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=24 OR (json_type("record",'$.outputs[24].identity') IS 'object'
    AND json_type("record",'$.outputs[24].identity.kind') IS 'text' AND json_extract("record",'$.outputs[24].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[24].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[24].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[24].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[24].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[24].identity.fileID'))=32 AND json_extract("record",'$.outputs[24].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=25 OR (json_type("record",'$.outputs[25].identity') IS 'object'
    AND json_type("record",'$.outputs[25].identity.kind') IS 'text' AND json_extract("record",'$.outputs[25].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[25].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[25].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[25].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[25].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[25].identity.fileID'))=32 AND json_extract("record",'$.outputs[25].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=26 OR (json_type("record",'$.outputs[26].identity') IS 'object'
    AND json_type("record",'$.outputs[26].identity.kind') IS 'text' AND json_extract("record",'$.outputs[26].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[26].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[26].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[26].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[26].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[26].identity.fileID'))=32 AND json_extract("record",'$.outputs[26].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=27 OR (json_type("record",'$.outputs[27].identity') IS 'object'
    AND json_type("record",'$.outputs[27].identity.kind') IS 'text' AND json_extract("record",'$.outputs[27].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[27].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[27].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[27].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[27].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[27].identity.fileID'))=32 AND json_extract("record",'$.outputs[27].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=28 OR (json_type("record",'$.outputs[28].identity') IS 'object'
    AND json_type("record",'$.outputs[28].identity.kind') IS 'text' AND json_extract("record",'$.outputs[28].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[28].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[28].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[28].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[28].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[28].identity.fileID'))=32 AND json_extract("record",'$.outputs[28].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=29 OR (json_type("record",'$.outputs[29].identity') IS 'object'
    AND json_type("record",'$.outputs[29].identity.kind') IS 'text' AND json_extract("record",'$.outputs[29].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[29].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[29].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[29].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[29].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[29].identity.fileID'))=32 AND json_extract("record",'$.outputs[29].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=30 OR (json_type("record",'$.outputs[30].identity') IS 'object'
    AND json_type("record",'$.outputs[30].identity.kind') IS 'text' AND json_extract("record",'$.outputs[30].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[30].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[30].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[30].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[30].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[30].identity.fileID'))=32 AND json_extract("record",'$.outputs[30].identity.fileID') NOT GLOB '*[^0-9a-f]*')) AND (json_array_length("record",'$.outputs')<=31 OR (json_type("record",'$.outputs[31].identity') IS 'object'
    AND json_type("record",'$.outputs[31].identity.kind') IS 'text' AND json_extract("record",'$.outputs[31].identity.kind') IS 'windows'
    AND json_type("record",'$.outputs[31].identity.volumeSerial') IS 'text'
    AND length(json_extract("record",'$.outputs[31].identity.volumeSerial'))=16 AND json_extract("record",'$.outputs[31].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("record",'$.outputs[31].identity.fileID') IS 'text'
    AND length(json_extract("record",'$.outputs[31].identity.fileID'))=32 AND json_extract("record",'$.outputs[31].identity.fileID') NOT GLOB '*[^0-9a-f]*'))))),
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
);
--> statement-breakpoint
INSERT INTO `__new_work_command_intent`(`command_id`, `admission_id`, `instance_id`, `work_id`, `root_work_id`, `session_id`, `input_id`, `activity_id`, `provider_receipt_id`, `provider_attempt_id`, `tool_call_id`, `owner_token`, `session_claim_token`, `binding_hash`, `control_revision`, `recipe_id`, `recipe_revision`, `recipe_hash`, `request_hash`, `helper_hash`, `runtime_hash`, `workspace_basename`, `state`, `outcome`, `revision`, `reserved_bytes`, `observed_retained_bytes`, `record`, `record_hash`, `created_at`, `updated_at`, `prepared_at`, `dispatched_at`, `terminal_at`, `released_at`, `deadline`) SELECT `command_id`, `admission_id`, `instance_id`, `work_id`, `root_work_id`, `session_id`, `input_id`, `activity_id`, `provider_receipt_id`, `provider_attempt_id`, `tool_call_id`, `owner_token`, `session_claim_token`, `binding_hash`, `control_revision`, `recipe_id`, `recipe_revision`, `recipe_hash`, `request_hash`, `helper_hash`, `runtime_hash`, `workspace_basename`, `state`, `outcome`, `revision`, `reserved_bytes`, `observed_retained_bytes`, `record`, `record_hash`, `created_at`, `updated_at`, `prepared_at`, `dispatched_at`, `terminal_at`, `released_at`, `deadline` FROM `work_command_intent`;--> statement-breakpoint
DROP TABLE `work_command_intent`;--> statement-breakpoint
ALTER TABLE `__new_work_command_intent` RENAME TO `work_command_intent`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_work_storage_cleanup` (
	`admission_id` text PRIMARY KEY,
	`instance_id` text NOT NULL,
	`work_id` text NOT NULL,
	`kind` text NOT NULL,
	`custody_id` text NOT NULL,
	`manifest` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`manifest_mac` text NOT NULL,
	`phase` text NOT NULL,
	`revision` integer NOT NULL,
	`journal` text,
	`journal_hash` text,
	`journal_mac` text,
	`cleanup_id` text,
	`request_hash` text,
	`proof` text,
	`proof_hash` text,
	`proof_mac` text,
	`released_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_work_storage_cleanup_admission_id_session_v2_tool_effect_admission_admission_id_fk` FOREIGN KEY (`admission_id`) REFERENCES `session_v2_tool_effect_admission`(`admission_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT `fk_work_storage_cleanup_work_id_work_execution_work_id_fk` FOREIGN KEY (`work_id`) REFERENCES `work_execution`(`work_id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "work_storage_cleanup_admission_id_text" CHECK(typeof("admission_id")='text' AND length(CAST("admission_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("admission_id",char(0))=0),
	CONSTRAINT "work_storage_cleanup_instance_id_text" CHECK(typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0),
	CONSTRAINT "work_storage_cleanup_work_id_text" CHECK(typeof("work_id")='text' AND length(CAST("work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("work_id",char(0))=0),
	CONSTRAINT "work_storage_cleanup_custody_id_text" CHECK(typeof("custody_id")='text' AND length(CAST("custody_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("custody_id",char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_hash_digest" CHECK(typeof("manifest_hash")='text' AND length(CAST("manifest_hash" AS BLOB))=64 AND "manifest_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_storage_cleanup_manifest_mac_digest" CHECK(typeof("manifest_mac")='text' AND length(CAST("manifest_mac" AS BLOB))=64 AND "manifest_mac" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "work_storage_cleanup_journal_hash_optional_digest" CHECK("journal_hash" IS NULL OR (typeof("journal_hash")='text' AND length(CAST("journal_hash" AS BLOB))=64 AND "journal_hash" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "work_storage_cleanup_journal_mac_optional_digest" CHECK("journal_mac" IS NULL OR (typeof("journal_mac")='text' AND length(CAST("journal_mac" AS BLOB))=64 AND "journal_mac" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "work_storage_cleanup_request_hash_optional_digest" CHECK("request_hash" IS NULL OR (typeof("request_hash")='text' AND length(CAST("request_hash" AS BLOB))=64 AND "request_hash" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "work_storage_cleanup_proof_hash_optional_digest" CHECK("proof_hash" IS NULL OR (typeof("proof_hash")='text' AND length(CAST("proof_hash" AS BLOB))=64 AND "proof_hash" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "work_storage_cleanup_proof_mac_optional_digest" CHECK("proof_mac" IS NULL OR (typeof("proof_mac")='text' AND length(CAST("proof_mac" AS BLOB))=64 AND "proof_mac" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "work_storage_cleanup_revision_integer" CHECK(typeof("revision")='integer' AND "revision" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_storage_cleanup_created_at_integer" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_storage_cleanup_updated_at_integer" CHECK(typeof("updated_at")='integer' AND "updated_at" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_storage_cleanup_cleanup_id_bound" CHECK("cleanup_id" IS NULL OR (typeof("cleanup_id")='text' AND length(CAST("cleanup_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("cleanup_id",char(0))=0)),
	CONSTRAINT "work_storage_cleanup_release_integer" CHECK(typeof("released_bytes")='integer' AND "released_bytes" BETWEEN 0 AND 9007199254740991 AND "updated_at">="created_at"),
	CONSTRAINT "work_storage_cleanup_manifest_mirror" CHECK(typeof("manifest")='text' AND length(CAST("manifest" AS BLOB)) BETWEEN 1 AND 65536 AND json_valid("manifest")
    AND json_type("manifest",'$.version') IS 'integer'
    AND (json_extract("manifest",'$.version') IS 1 OR (json_extract("manifest",'$.version') IS 2
      AND "kind"='command' AND json_extract("manifest",'$.captureKind') IS 'native_live'
      AND json_type("manifest",'$.target') IS 'text' AND json_extract("manifest",'$.target') IN ('win32-x64','win32-arm64')
      AND (json_type("manifest",'$.security') IS 'object'
    AND json_type("manifest",'$.security.leaseSetHash') IS 'text' AND length(json_extract("manifest",'$.security.leaseSetHash'))=64
    AND json_extract("manifest",'$.security.leaseSetHash') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.security.appContainerSID') IS 'text' AND length(json_extract("manifest",'$.security.appContainerSID'))<=184
    AND json_extract("manifest",'$.security.appContainerSID') LIKE 'S-1-15-2-%'
    AND json_type("manifest",'$.security.restrictionSID') IS 'text' AND length(json_extract("manifest",'$.security.restrictionSID'))<=184
    AND json_extract("manifest",'$.security.restrictionSID') LIKE 'S-1-15-3-%')
      AND (json_type("manifest",'$.projectIdentity') IS 'object'
    AND json_type("manifest",'$.projectIdentity.kind') IS 'text' AND json_extract("manifest",'$.projectIdentity.kind') IS 'windows'
    AND json_type("manifest",'$.projectIdentity.volumeSerial') IS 'text'
    AND length(json_extract("manifest",'$.projectIdentity.volumeSerial'))=16 AND json_extract("manifest",'$.projectIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.projectIdentity.fileID') IS 'text'
    AND length(json_extract("manifest",'$.projectIdentity.fileID'))=32 AND json_extract("manifest",'$.projectIdentity.fileID') NOT GLOB '*[^0-9a-f]*') AND (json_type("manifest",'$.dataIdentity') IS 'object'
    AND json_type("manifest",'$.dataIdentity.kind') IS 'text' AND json_extract("manifest",'$.dataIdentity.kind') IS 'windows'
    AND json_type("manifest",'$.dataIdentity.volumeSerial') IS 'text'
    AND length(json_extract("manifest",'$.dataIdentity.volumeSerial'))=16 AND json_extract("manifest",'$.dataIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.dataIdentity.fileID') IS 'text'
    AND length(json_extract("manifest",'$.dataIdentity.fileID'))=32 AND json_extract("manifest",'$.dataIdentity.fileID') NOT GLOB '*[^0-9a-f]*') AND (json_type("manifest",'$.baseIdentity') IS 'object'
    AND json_type("manifest",'$.baseIdentity.kind') IS 'text' AND json_extract("manifest",'$.baseIdentity.kind') IS 'windows'
    AND json_type("manifest",'$.baseIdentity.volumeSerial') IS 'text'
    AND length(json_extract("manifest",'$.baseIdentity.volumeSerial'))=16 AND json_extract("manifest",'$.baseIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.baseIdentity.fileID') IS 'text'
    AND length(json_extract("manifest",'$.baseIdentity.fileID'))=32 AND json_extract("manifest",'$.baseIdentity.fileID') NOT GLOB '*[^0-9a-f]*') AND (json_type("manifest",'$.containerIdentity') IS 'object'
    AND json_type("manifest",'$.containerIdentity.kind') IS 'text' AND json_extract("manifest",'$.containerIdentity.kind') IS 'windows'
    AND json_type("manifest",'$.containerIdentity.volumeSerial') IS 'text'
    AND length(json_extract("manifest",'$.containerIdentity.volumeSerial'))=16 AND json_extract("manifest",'$.containerIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.containerIdentity.fileID') IS 'text'
    AND length(json_extract("manifest",'$.containerIdentity.fileID'))=32 AND json_extract("manifest",'$.containerIdentity.fileID') NOT GLOB '*[^0-9a-f]*')))
    AND json_type("manifest",'$.admissionID') IS 'text' AND json_extract("manifest",'$.admissionID') IS "admission_id"
    AND json_type("manifest",'$.instanceID') IS 'text' AND json_extract("manifest",'$.instanceID') IS "instance_id"
    AND json_type("manifest",'$.workID') IS 'text' AND json_extract("manifest",'$.workID') IS "work_id"
    AND json_type("manifest",'$.kind') IS 'text' AND json_extract("manifest",'$.kind') IS "kind"
    AND json_type("manifest",'$.custodyID') IS 'text' AND json_extract("manifest",'$.custodyID') IS "custody_id"
    AND json_type("manifest",'$.createdAt') IS 'integer' AND json_extract("manifest",'$.createdAt') IS "created_at"),
	CONSTRAINT "work_storage_cleanup_manifest_admissionID_bound" CHECK(json_type("manifest",'$.admissionID') IS 'text'
      AND length(CAST(json_extract("manifest",'$.admissionID') AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract("manifest",'$.admissionID'),char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_instanceID_bound" CHECK(json_type("manifest",'$.instanceID') IS 'text'
      AND length(CAST(json_extract("manifest",'$.instanceID') AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract("manifest",'$.instanceID'),char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_workID_bound" CHECK(json_type("manifest",'$.workID') IS 'text'
      AND length(CAST(json_extract("manifest",'$.workID') AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract("manifest",'$.workID'),char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_rootWorkID_bound" CHECK(json_type("manifest",'$.rootWorkID') IS 'text'
      AND length(CAST(json_extract("manifest",'$.rootWorkID') AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract("manifest",'$.rootWorkID'),char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_sessionID_bound" CHECK(json_type("manifest",'$.sessionID') IS 'text'
      AND length(CAST(json_extract("manifest",'$.sessionID') AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract("manifest",'$.sessionID'),char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_inputID_bound" CHECK(json_type("manifest",'$.inputID') IS 'text'
      AND length(CAST(json_extract("manifest",'$.inputID') AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract("manifest",'$.inputID'),char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_activityID_bound" CHECK(json_type("manifest",'$.activityID') IS 'text'
      AND length(CAST(json_extract("manifest",'$.activityID') AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract("manifest",'$.activityID'),char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_providerReceiptID_bound" CHECK(json_type("manifest",'$.providerReceiptID') IS 'text'
      AND length(CAST(json_extract("manifest",'$.providerReceiptID') AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract("manifest",'$.providerReceiptID'),char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_providerAttemptID_bound" CHECK(json_type("manifest",'$.providerAttemptID') IS 'text'
      AND length(CAST(json_extract("manifest",'$.providerAttemptID') AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract("manifest",'$.providerAttemptID'),char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_toolCallID_bound" CHECK(json_type("manifest",'$.toolCallID') IS 'text'
      AND length(CAST(json_extract("manifest",'$.toolCallID') AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract("manifest",'$.toolCallID'),char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_ownerToken_bound" CHECK(json_type("manifest",'$.ownerToken') IS 'text'
      AND length(CAST(json_extract("manifest",'$.ownerToken') AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract("manifest",'$.ownerToken'),char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_custodyID_bound" CHECK(json_type("manifest",'$.custodyID') IS 'text'
      AND length(CAST(json_extract("manifest",'$.custodyID') AS BLOB)) BETWEEN 1 AND 512
      AND instr(json_extract("manifest",'$.custodyID'),char(0))=0),
	CONSTRAINT "work_storage_cleanup_manifest_createdAt_count" CHECK(json_type("manifest",'$.createdAt') IS 'integer'
      AND json_extract("manifest",'$.createdAt') BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_storage_cleanup_manifest_sessionClaimToken_count" CHECK(json_type("manifest",'$.sessionClaimToken') IS 'integer'
      AND json_extract("manifest",'$.sessionClaimToken') BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_storage_cleanup_manifest_controlRevision_count" CHECK(json_type("manifest",'$.controlRevision') IS 'integer'
      AND json_extract("manifest",'$.controlRevision') BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "work_storage_cleanup_manifest_inventory" CHECK(json_type("manifest",'$.files') IS 'array' AND json_array_length("manifest",'$.files')<=288
    AND json_type("manifest",'$.directories') IS 'array' AND json_array_length("manifest",'$.directories') BETWEEN 1 AND 4610
    AND json_type("manifest",'$.captureKind') IS 'text' AND json_extract("manifest",'$.captureKind') IN ('native_live','known_empty_legacy')
    AND (json_extract("manifest",'$.captureKind')!='known_empty_legacy' OR ("kind"='write' AND json_array_length("manifest",'$.files')=0))),
	CONSTRAINT "work_storage_cleanup_phase" CHECK("kind" IN ('write','command') AND "phase" IN ('retained','cleanup_pending','cleanup_recovery','cleanup_verified','released')),
	CONSTRAINT "work_storage_cleanup_journal_shape" CHECK(("phase"='retained' AND "journal" IS NULL AND "journal_hash" IS NULL AND "journal_mac" IS NULL AND "cleanup_id" IS NULL AND "request_hash" IS NULL AND "proof" IS NULL AND "proof_hash" IS NULL AND "proof_mac" IS NULL AND "released_bytes"=0)
    OR ("phase"!='retained' AND typeof("journal")='text' AND length(CAST("journal" AS BLOB)) BETWEEN 1 AND 131072 AND json_valid("journal")
      AND "journal_hash" IS NOT NULL AND "journal_mac" IS NOT NULL AND typeof("cleanup_id")='text' AND length(CAST("cleanup_id" AS BLOB)) BETWEEN 1 AND 512 AND "request_hash" IS NOT NULL
      AND json_type("journal",'$.version') IS 'integer' AND json_extract("journal",'$.version') IS json_extract("manifest",'$.version')
      AND (json_extract("manifest",'$.version') IS 1 OR (json_type("journal",'$.target') IS 'text' AND json_extract("journal",'$.target') IS json_extract("manifest",'$.target')
    AND (json_type("journal",'$.security') IS 'object'
    AND json_type("journal",'$.security.leaseSetHash') IS 'text' AND length(json_extract("journal",'$.security.leaseSetHash'))=64
    AND json_extract("journal",'$.security.leaseSetHash') NOT GLOB '*[^0-9a-f]*'
    AND json_type("journal",'$.security.appContainerSID') IS 'text' AND length(json_extract("journal",'$.security.appContainerSID'))<=184
    AND json_extract("journal",'$.security.appContainerSID') LIKE 'S-1-15-2-%'
    AND json_type("journal",'$.security.restrictionSID') IS 'text' AND length(json_extract("journal",'$.security.restrictionSID'))<=184
    AND json_extract("journal",'$.security.restrictionSID') LIKE 'S-1-15-3-%') AND json_extract("journal",'$.security.leaseSetHash') IS json_extract("manifest",'$.security.leaseSetHash') AND json_extract("journal",'$.security.appContainerSID') IS json_extract("manifest",'$.security.appContainerSID') AND json_extract("journal",'$.security.restrictionSID') IS json_extract("manifest",'$.security.restrictionSID')))
      AND json_type("journal",'$.cleanupID') IS 'text' AND json_extract("journal",'$.cleanupID') IS "cleanup_id"
      AND json_type("journal",'$.request.admissionID') IS 'text' AND json_extract("journal",'$.request.admissionID') IS "admission_id"
      AND json_type("journal",'$.requestHash') IS 'text' AND json_extract("journal",'$.requestHash') IS "request_hash"
      AND json_type("journal",'$.manifestHash') IS 'text' AND json_extract("journal",'$.manifestHash') IS "manifest_hash"
      AND json_type("journal",'$.instanceID') IS 'text' AND json_extract("journal",'$.instanceID') IS "instance_id")),
	CONSTRAINT "work_storage_cleanup_proof_shape" CHECK(("phase" IN ('retained','cleanup_pending','cleanup_recovery') AND "proof" IS NULL AND "proof_hash" IS NULL AND "proof_mac" IS NULL AND "released_bytes"=0)
    OR ("phase" IN ('cleanup_verified','released') AND typeof("proof")='text' AND length(CAST("proof" AS BLOB)) BETWEEN 1 AND 16384 AND json_valid("proof") AND "proof_hash" IS NOT NULL AND "proof_mac" IS NOT NULL
      AND json_type("proof",'$.version') IS 'integer' AND json_extract("proof",'$.version') IS json_extract("manifest",'$.version')
      AND (json_extract("manifest",'$.version') IS 1 OR ((json_type("proof",'$.target') IS 'text' AND json_extract("proof",'$.target') IS json_extract("manifest",'$.target')
    AND (json_type("proof",'$.security') IS 'object'
    AND json_type("proof",'$.security.leaseSetHash') IS 'text' AND length(json_extract("proof",'$.security.leaseSetHash'))=64
    AND json_extract("proof",'$.security.leaseSetHash') NOT GLOB '*[^0-9a-f]*'
    AND json_type("proof",'$.security.appContainerSID') IS 'text' AND length(json_extract("proof",'$.security.appContainerSID'))<=184
    AND json_extract("proof",'$.security.appContainerSID') LIKE 'S-1-15-2-%'
    AND json_type("proof",'$.security.restrictionSID') IS 'text' AND length(json_extract("proof",'$.security.restrictionSID'))<=184
    AND json_extract("proof",'$.security.restrictionSID') LIKE 'S-1-15-3-%') AND json_extract("proof",'$.security.leaseSetHash') IS json_extract("manifest",'$.security.leaseSetHash') AND json_extract("proof",'$.security.appContainerSID') IS json_extract("manifest",'$.security.appContainerSID') AND json_extract("proof",'$.security.restrictionSID') IS json_extract("manifest",'$.security.restrictionSID'))
        AND (json_type("proof",'$.dataIdentity') IS 'object'
    AND json_type("proof",'$.dataIdentity.kind') IS 'text' AND json_extract("proof",'$.dataIdentity.kind') IS 'windows'
    AND json_type("proof",'$.dataIdentity.volumeSerial') IS 'text'
    AND length(json_extract("proof",'$.dataIdentity.volumeSerial'))=16 AND json_extract("proof",'$.dataIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("proof",'$.dataIdentity.fileID') IS 'text'
    AND length(json_extract("proof",'$.dataIdentity.fileID'))=32 AND json_extract("proof",'$.dataIdentity.fileID') NOT GLOB '*[^0-9a-f]*') AND (json_type("proof",'$.baseIdentity') IS 'object'
    AND json_type("proof",'$.baseIdentity.kind') IS 'text' AND json_extract("proof",'$.baseIdentity.kind') IS 'windows'
    AND json_type("proof",'$.baseIdentity.volumeSerial') IS 'text'
    AND length(json_extract("proof",'$.baseIdentity.volumeSerial'))=16 AND json_extract("proof",'$.baseIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("proof",'$.baseIdentity.fileID') IS 'text'
    AND length(json_extract("proof",'$.baseIdentity.fileID'))=32 AND json_extract("proof",'$.baseIdentity.fileID') NOT GLOB '*[^0-9a-f]*') AND (json_type("proof",'$.containerIdentity') IS 'object'
    AND json_type("proof",'$.containerIdentity.kind') IS 'text' AND json_extract("proof",'$.containerIdentity.kind') IS 'windows'
    AND json_type("proof",'$.containerIdentity.volumeSerial') IS 'text'
    AND length(json_extract("proof",'$.containerIdentity.volumeSerial'))=16 AND json_extract("proof",'$.containerIdentity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("proof",'$.containerIdentity.fileID') IS 'text'
    AND length(json_extract("proof",'$.containerIdentity.fileID'))=32 AND json_extract("proof",'$.containerIdentity.fileID') NOT GLOB '*[^0-9a-f]*')
        AND json_type("proof",'$.aclRestoreHash') IS 'text' AND length(json_extract("proof",'$.aclRestoreHash'))=64
        AND json_extract("proof",'$.aclRestoreHash') NOT GLOB '*[^0-9a-f]*'
        AND json_type("proof",'$.jobRetired') IS 'true' AND json_type("proof",'$.appContainerRetired') IS 'true'
        AND json_type("proof",'$.aclRestored') IS 'true'))
      AND json_type("proof",'$.cleanupID') IS 'text' AND json_extract("proof",'$.cleanupID') IS "cleanup_id"
      AND json_type("proof",'$.manifestHash') IS 'text' AND json_extract("proof",'$.manifestHash') IS "manifest_hash"
      AND json_type("proof",'$.state') IS 'text' AND json_extract("proof",'$.state') IS 'empty_verified'))
);
--> statement-breakpoint
INSERT INTO `__new_work_storage_cleanup`(`admission_id`, `instance_id`, `work_id`, `kind`, `custody_id`, `manifest`, `manifest_hash`, `manifest_mac`, `phase`, `revision`, `journal`, `journal_hash`, `journal_mac`, `cleanup_id`, `request_hash`, `proof`, `proof_hash`, `proof_mac`, `released_bytes`, `created_at`, `updated_at`) SELECT `admission_id`, `instance_id`, `work_id`, `kind`, `custody_id`, `manifest`, `manifest_hash`, `manifest_mac`, `phase`, `revision`, `journal`, `journal_hash`, `journal_mac`, `cleanup_id`, `request_hash`, `proof`, `proof_hash`, `proof_mac`, `released_bytes`, `created_at`, `updated_at` FROM `work_storage_cleanup`;--> statement-breakpoint
DROP TABLE `work_storage_cleanup`;--> statement-breakpoint
ALTER TABLE `__new_work_storage_cleanup` RENAME TO `work_storage_cleanup`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `work_command_intent_admission_idx` ON `work_command_intent` (`admission_id`);--> statement-breakpoint
CREATE INDEX `work_command_intent_custody_idx` ON `work_command_intent` (`instance_id`,`released_at`,`command_id`);--> statement-breakpoint
CREATE INDEX `work_command_intent_work_idx` ON `work_command_intent` (`work_id`,`created_at`,`command_id`);--> statement-breakpoint
CREATE INDEX `work_storage_cleanup_instance_idx` ON `work_storage_cleanup` (`instance_id`,`phase`,`created_at`);--> statement-breakpoint
CREATE INDEX `work_storage_cleanup_work_idx` ON `work_storage_cleanup` (`work_id`,`admission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_storage_cleanup_command_idx` ON `work_storage_cleanup` (`cleanup_id`);