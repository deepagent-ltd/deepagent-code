CREATE TABLE `deepagent_im_single_write` (
	`im_message_id` text PRIMARY KEY,
	`event_ref` text NOT NULL,
	`owner_id` text NOT NULL,
	`generation` integer NOT NULL,
	`receipt_ref` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `im_activation` (
	`transaction_id` text PRIMARY KEY,
	`source_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`name` text NOT NULL,
	`method` text NOT NULL,
	`quote_id` text NOT NULL,
	`state` text NOT NULL,
	`charged_credits` integer,
	`credential_stored` integer NOT NULL,
	`code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "im_activation_state_check" CHECK("state" IN ('pending','unknown','succeeded','rejected')),
	CONSTRAINT "im_activation_method_check" CHECK("method" IN ('api_key','activation_code')),
	CONSTRAINT "im_activation_charge_check" CHECK(("state" IN ('pending','unknown','rejected') AND ("charged_credits" IS NULL OR "charged_credits" IN (0,1))) OR ("state" = 'succeeded' AND "charged_credits" IN (0,1)))
);
--> statement-breakpoint
CREATE TABLE `im_dac_binding` (
	`id` text PRIMARY KEY,
	`identity_key` text NOT NULL,
	`owner_id` text NOT NULL,
	`account_key` text NOT NULL,
	`executor_id` text NOT NULL,
	`conversation_key` text NOT NULL,
	`group_id` text NOT NULL,
	`project_id` text NOT NULL,
	`directory` text NOT NULL,
	`workspace_id` text,
	`current_session_id` text NOT NULL,
	`generation` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "im_dac_binding_generation_check" CHECK("generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE `im_dac_command` (
	`id` text PRIMARY KEY,
	`command_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`text` text NOT NULL,
	`model` text,
	`reference_ids` text NOT NULL,
	`references` text NOT NULL,
	`new_session` integer NOT NULL,
	`session_id` text NOT NULL,
	`input_id` text NOT NULL,
	`delivery` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`admitted_at` integer,
	CONSTRAINT `fk_im_dac_command_binding_id_im_dac_binding_id_fk` FOREIGN KEY (`binding_id`) REFERENCES `im_dac_binding`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "im_dac_command_state_check" CHECK("state" IN ('pending','admitted','rejected')),
	CONSTRAINT "im_dac_command_delivery_check" CHECK("delivery" IN ('queue','steer'))
);
--> statement-breakpoint
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
      AND json_extract("manifest",'$.captureKind') IS 'native_live'
      AND json_type("manifest",'$.target') IS 'text' AND json_extract("manifest",'$.target') IN ('win32-x64','win32-arm64')
      AND (("kind"='command' AND (json_type("manifest",'$.security') IS 'object'
    AND json_type("manifest",'$.security.leaseSetHash') IS 'text' AND length(json_extract("manifest",'$.security.leaseSetHash'))=64
    AND json_extract("manifest",'$.security.leaseSetHash') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.security.appContainerSID') IS 'text' AND length(json_extract("manifest",'$.security.appContainerSID'))<=184
    AND json_extract("manifest",'$.security.appContainerSID') LIKE 'S-1-15-2-%'
    AND json_type("manifest",'$.security.restrictionSID') IS 'text' AND length(json_extract("manifest",'$.security.restrictionSID'))<=184
    AND (json_extract("manifest",'$.security.restrictionSID') LIKE 'S-1-15-3-%' OR
      (substr(json_extract("manifest",'$.security.restrictionSID'),1,9) IS 'S-1-5-21-'
        AND substr(json_extract("manifest",'$.security.restrictionSID'),10) NOT GLOB '*[^0-9-]*' AND
        CASE WHEN json_valid('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']') THEN
          json_array_length('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']')=4
          AND
            json_type('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[0]') IS 'integer'
            AND json_extract('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[0]') BETWEEN 0 AND 4294967295 AND
            json_type('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[1]') IS 'integer'
            AND json_extract('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[1]') BETWEEN 0 AND 4294967295 AND
            json_type('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[2]') IS 'integer'
            AND json_extract('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[2]') BETWEEN 0 AND 4294967295 AND
            json_type('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[3]') IS 'integer'
            AND json_extract('['||replace(substr(json_extract("manifest",'$.security.restrictionSID'),10),'-',',')||']','$[3]') BETWEEN 0 AND 4294967295
        ELSE 0 END)))) OR ("kind"='write' AND (json_type("manifest",'$.purpose') IS 'text' AND json_extract("manifest",'$.purpose') IS 'work_write'
    AND json_type("manifest",'$.security') IS NULL AND json_type("manifest",'$.snapshotHash') IS 'null'
    AND json_type("manifest",'$.basename') IS 'text' AND length(json_extract("manifest",'$.basename'))=32
    AND json_extract("manifest",'$.basename') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.files') IS 'array' AND json_type("manifest",'$.stagePhase') IS 'text'
    AND ((json_extract("manifest",'$.stagePhase') IS 'refused_empty' AND json_array_length("manifest",'$.files')=0)
      OR (json_extract("manifest",'$.stagePhase') IN ('prepared_payload','refused_payload') AND json_array_length("manifest",'$.files')=1
        AND json_extract("manifest",'$.files[0].relative') IS 'payload' AND json_type("manifest",'$.files[0].retainedUnlinked') IS 'false'
        AND (json_type("manifest",'$.files[0].identity') IS 'object'
    AND json_type("manifest",'$.files[0].identity.kind') IS 'text' AND json_extract("manifest",'$.files[0].identity.kind') IS 'windows'
    AND json_type("manifest",'$.files[0].identity.volumeSerial') IS 'text'
    AND length(json_extract("manifest",'$.files[0].identity.volumeSerial'))=16 AND json_extract("manifest",'$.files[0].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.files[0].identity.fileID') IS 'text'
    AND length(json_extract("manifest",'$.files[0].identity.fileID'))=32 AND json_extract("manifest",'$.files[0].identity.fileID') NOT GLOB '*[^0-9a-f]*')
        AND json_type("manifest",'$.files[0].sha256') IS 'text' AND length(json_extract("manifest",'$.files[0].sha256'))=64
        AND json_extract("manifest",'$.files[0].sha256') NOT GLOB '*[^0-9a-f]*'
        AND json_type("manifest",'$.files[0].bytes') IS 'integer' AND json_extract("manifest",'$.files[0].bytes') BETWEEN 0 AND 51200
        AND json_extract("manifest",'$.files[0].identity.volumeSerial') IS json_extract("manifest",'$.projectIdentity.volumeSerial')))
    AND json_type("manifest",'$.directories') IS 'array' AND json_array_length("manifest",'$.directories')=1
    AND json_extract("manifest",'$.directories[0].relative') IS ''
    AND (json_type("manifest",'$.directories[0].identity') IS 'object'
    AND json_type("manifest",'$.directories[0].identity.kind') IS 'text' AND json_extract("manifest",'$.directories[0].identity.kind') IS 'windows'
    AND json_type("manifest",'$.directories[0].identity.volumeSerial') IS 'text'
    AND length(json_extract("manifest",'$.directories[0].identity.volumeSerial'))=16 AND json_extract("manifest",'$.directories[0].identity.volumeSerial') NOT GLOB '*[^0-9a-f]*'
    AND json_type("manifest",'$.directories[0].identity.fileID') IS 'text'
    AND length(json_extract("manifest",'$.directories[0].identity.fileID'))=32 AND json_extract("manifest",'$.directories[0].identity.fileID') NOT GLOB '*[^0-9a-f]*')
    AND json_extract("manifest",'$.directories[0].identity.fileID') IS json_extract("manifest",'$.containerIdentity.fileID')
    AND json_extract("manifest",'$.dataIdentity.volumeSerial') IS json_extract("manifest",'$.projectIdentity.volumeSerial') AND json_extract("manifest",'$.baseIdentity.volumeSerial') IS json_extract("manifest",'$.projectIdentity.volumeSerial') AND json_extract("manifest",'$.containerIdentity.volumeSerial') IS json_extract("manifest",'$.projectIdentity.volumeSerial') AND json_extract("manifest",'$.directories[0].identity.volumeSerial') IS json_extract("manifest",'$.projectIdentity.volumeSerial'))))
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
    AND ((json_extract("manifest",'$.kind') IS 'write' AND json_extract("manifest",'$.purpose') IS 'work_write'
      AND json_type("journal",'$.purpose') IS 'text' AND json_extract("journal",'$.purpose') IS 'work_write'
      AND json_type("journal",'$.security') IS NULL) OR (json_extract("manifest",'$.kind') IS 'command'
      AND (json_type("journal",'$.security') IS 'object'
    AND json_type("journal",'$.security.leaseSetHash') IS 'text' AND length(json_extract("journal",'$.security.leaseSetHash'))=64
    AND json_extract("journal",'$.security.leaseSetHash') NOT GLOB '*[^0-9a-f]*'
    AND json_type("journal",'$.security.appContainerSID') IS 'text' AND length(json_extract("journal",'$.security.appContainerSID'))<=184
    AND json_extract("journal",'$.security.appContainerSID') LIKE 'S-1-15-2-%'
    AND json_type("journal",'$.security.restrictionSID') IS 'text' AND length(json_extract("journal",'$.security.restrictionSID'))<=184
    AND (json_extract("journal",'$.security.restrictionSID') LIKE 'S-1-15-3-%' OR
      (substr(json_extract("journal",'$.security.restrictionSID'),1,9) IS 'S-1-5-21-'
        AND substr(json_extract("journal",'$.security.restrictionSID'),10) NOT GLOB '*[^0-9-]*' AND
        CASE WHEN json_valid('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']') THEN
          json_array_length('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']')=4
          AND
            json_type('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[0]') IS 'integer'
            AND json_extract('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[0]') BETWEEN 0 AND 4294967295 AND
            json_type('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[1]') IS 'integer'
            AND json_extract('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[1]') BETWEEN 0 AND 4294967295 AND
            json_type('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[2]') IS 'integer'
            AND json_extract('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[2]') BETWEEN 0 AND 4294967295 AND
            json_type('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[3]') IS 'integer'
            AND json_extract('['||replace(substr(json_extract("journal",'$.security.restrictionSID'),10),'-',',')||']','$[3]') BETWEEN 0 AND 4294967295
        ELSE 0 END))) AND json_extract("journal",'$.security.leaseSetHash') IS json_extract("manifest",'$.security.leaseSetHash') AND json_extract("journal",'$.security.appContainerSID') IS json_extract("manifest",'$.security.appContainerSID') AND json_extract("journal",'$.security.restrictionSID') IS json_extract("manifest",'$.security.restrictionSID')))))
      AND json_type("journal",'$.cleanupID') IS 'text' AND json_extract("journal",'$.cleanupID') IS "cleanup_id"
      AND json_type("journal",'$.request.admissionID') IS 'text' AND json_extract("journal",'$.request.admissionID') IS "admission_id"
      AND json_type("journal",'$.requestHash') IS 'text' AND json_extract("journal",'$.requestHash') IS "request_hash"
      AND json_type("journal",'$.manifestHash') IS 'text' AND json_extract("journal",'$.manifestHash') IS "manifest_hash"
      AND json_type("journal",'$.instanceID') IS 'text' AND json_extract("journal",'$.instanceID') IS "instance_id")),
	CONSTRAINT "work_storage_cleanup_proof_shape" CHECK(("phase" IN ('retained','cleanup_pending','cleanup_recovery') AND "proof" IS NULL AND "proof_hash" IS NULL AND "proof_mac" IS NULL AND "released_bytes"=0)
    OR ("phase" IN ('cleanup_verified','released') AND typeof("proof")='text' AND length(CAST("proof" AS BLOB)) BETWEEN 1 AND 16384 AND json_valid("proof") AND "proof_hash" IS NOT NULL AND "proof_mac" IS NOT NULL
      AND json_type("proof",'$.version') IS 'integer' AND json_extract("proof",'$.version') IS json_extract("manifest",'$.version')
      AND (json_extract("manifest",'$.version') IS 1 OR ((json_type("proof",'$.target') IS 'text' AND json_extract("proof",'$.target') IS json_extract("manifest",'$.target')
    AND ((json_extract("manifest",'$.kind') IS 'write' AND json_extract("manifest",'$.purpose') IS 'work_write'
      AND json_type("proof",'$.purpose') IS 'text' AND json_extract("proof",'$.purpose') IS 'work_write'
      AND json_type("proof",'$.security') IS NULL) OR (json_extract("manifest",'$.kind') IS 'command'
      AND (json_type("proof",'$.security') IS 'object'
    AND json_type("proof",'$.security.leaseSetHash') IS 'text' AND length(json_extract("proof",'$.security.leaseSetHash'))=64
    AND json_extract("proof",'$.security.leaseSetHash') NOT GLOB '*[^0-9a-f]*'
    AND json_type("proof",'$.security.appContainerSID') IS 'text' AND length(json_extract("proof",'$.security.appContainerSID'))<=184
    AND json_extract("proof",'$.security.appContainerSID') LIKE 'S-1-15-2-%'
    AND json_type("proof",'$.security.restrictionSID') IS 'text' AND length(json_extract("proof",'$.security.restrictionSID'))<=184
    AND (json_extract("proof",'$.security.restrictionSID') LIKE 'S-1-15-3-%' OR
      (substr(json_extract("proof",'$.security.restrictionSID'),1,9) IS 'S-1-5-21-'
        AND substr(json_extract("proof",'$.security.restrictionSID'),10) NOT GLOB '*[^0-9-]*' AND
        CASE WHEN json_valid('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']') THEN
          json_array_length('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']')=4
          AND
            json_type('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[0]') IS 'integer'
            AND json_extract('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[0]') BETWEEN 0 AND 4294967295 AND
            json_type('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[1]') IS 'integer'
            AND json_extract('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[1]') BETWEEN 0 AND 4294967295 AND
            json_type('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[2]') IS 'integer'
            AND json_extract('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[2]') BETWEEN 0 AND 4294967295 AND
            json_type('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[3]') IS 'integer'
            AND json_extract('['||replace(substr(json_extract("proof",'$.security.restrictionSID'),10),'-',',')||']','$[3]') BETWEEN 0 AND 4294967295
        ELSE 0 END))) AND json_extract("proof",'$.security.leaseSetHash') IS json_extract("manifest",'$.security.leaseSetHash') AND json_extract("proof",'$.security.appContainerSID') IS json_extract("manifest",'$.security.appContainerSID') AND json_extract("proof",'$.security.restrictionSID') IS json_extract("manifest",'$.security.restrictionSID'))))
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
        AND (("kind"='write' AND json_type("proof",'$.originalStageRemoved') IS 'true'
          AND json_type("proof",'$.retainedHandlesClosed') IS 'true') OR ("kind"='command'
          AND json_type("proof",'$.aclRestoreHash') IS 'text' AND length(json_extract("proof",'$.aclRestoreHash'))=64
          AND json_extract("proof",'$.aclRestoreHash') NOT GLOB '*[^0-9a-f]*'
          AND json_type("proof",'$.jobRetired') IS 'true' AND json_type("proof",'$.appContainerRetired') IS 'true'
          AND json_type("proof",'$.aclRestored') IS 'true'))))
      AND json_type("proof",'$.cleanupID') IS 'text' AND json_extract("proof",'$.cleanupID') IS "cleanup_id"
      AND json_type("proof",'$.manifestHash') IS 'text' AND json_extract("proof",'$.manifestHash') IS "manifest_hash"
      AND json_type("proof",'$.state') IS 'text' AND json_extract("proof",'$.state') IS 'empty_verified'))
);
--> statement-breakpoint
INSERT INTO `__new_work_storage_cleanup`(`admission_id`, `instance_id`, `work_id`, `kind`, `custody_id`, `manifest`, `manifest_hash`, `manifest_mac`, `phase`, `revision`, `journal`, `journal_hash`, `journal_mac`, `cleanup_id`, `request_hash`, `proof`, `proof_hash`, `proof_mac`, `released_bytes`, `created_at`, `updated_at`) SELECT `admission_id`, `instance_id`, `work_id`, `kind`, `custody_id`, `manifest`, `manifest_hash`, `manifest_mac`, `phase`, `revision`, `journal`, `journal_hash`, `journal_mac`, `cleanup_id`, `request_hash`, `proof`, `proof_hash`, `proof_mac`, `released_bytes`, `created_at`, `updated_at` FROM `work_storage_cleanup`;--> statement-breakpoint
DROP TABLE `work_storage_cleanup`;--> statement-breakpoint
ALTER TABLE `__new_work_storage_cleanup` RENAME TO `work_storage_cleanup`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `work_storage_cleanup_instance_idx` ON `work_storage_cleanup` (`instance_id`,`phase`,`created_at`);--> statement-breakpoint
CREATE INDEX `work_storage_cleanup_work_idx` ON `work_storage_cleanup` (`work_id`,`admission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_storage_cleanup_command_idx` ON `work_storage_cleanup` (`cleanup_id`);--> statement-breakpoint
CREATE INDEX `deepagent_im_single_write_event_idx` ON `deepagent_im_single_write` (`event_ref`);--> statement-breakpoint
CREATE INDEX `deepagent_im_single_write_owner_idx` ON `deepagent_im_single_write` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `im_activation_pending_idx` ON `im_activation` (`source_hash`) WHERE "im_activation"."state" IN ('pending','unknown') OR ("im_activation"."state" = 'succeeded' AND "im_activation"."credential_stored" = 0);--> statement-breakpoint
CREATE INDEX `im_activation_source_idx` ON `im_activation` (`source_hash`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `im_dac_binding_identity_idx` ON `im_dac_binding` (`identity_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `im_dac_command_input_idx` ON `im_dac_command` (`input_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `im_dac_command_exact_idx` ON `im_dac_command` (`binding_id`,`command_id`);--> statement-breakpoint
CREATE INDEX `im_dac_command_pending_idx` ON `im_dac_command` (`state`,`created_at`);