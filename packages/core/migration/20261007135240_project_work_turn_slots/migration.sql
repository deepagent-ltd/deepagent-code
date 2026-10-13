-- Additive upgrade preserves original rows, CHECKs, triggers and signed records.
ALTER TABLE session_v2_tool_effect ADD COLUMN known_read_proof TEXT
 CONSTRAINT session_v2_tool_effect_known_read_proof_check CHECK(known_read_proof IS NULL OR CASE
 WHEN typeof(known_read_proof)='text' AND length(CAST(known_read_proof AS BLOB)) BETWEEN 1 AND 16384
 AND instr(known_read_proof,char(0))=0 AND json_valid(known_read_proof)
 THEN coalesce(json_type(known_read_proof)='object' AND json_type(known_read_proof,'$.version')='integer'
 AND json_extract(known_read_proof,'$.version')=1 AND effect_kind='read_only' AND state='settled' AND error_code IS NULL,0)
 ELSE 0 END);
--> statement-breakpoint
ALTER TABLE work_execution ADD COLUMN binding_version INTEGER NOT NULL DEFAULT 1
 CONSTRAINT work_execution_binding_version_check CHECK(typeof(binding_version)='integer' AND binding_version IN (1,2)
 AND json_type(binding,'$.schemaVersion') IS 'text'
 AND ((binding_version=1 AND json_extract(binding,'$.schemaVersion') IS 'work-execution.v1')
 OR (binding_version=2 AND json_extract(binding,'$.schemaVersion') IS 'work-execution.v2'
 AND length(CAST(binding AS BLOB)) BETWEEN 1 AND 65536)));
--> statement-breakpoint
ALTER TABLE work_count_acquisition ADD COLUMN root_work_id TEXT;
--> statement-breakpoint
ALTER TABLE work_count_acquisition ADD COLUMN activity_id TEXT;
--> statement-breakpoint
ALTER TABLE work_count_acquisition ADD COLUMN provider_turn_seq INTEGER;
--> statement-breakpoint
ALTER TABLE work_count_acquisition ADD COLUMN turn_key TEXT;
--> statement-breakpoint
ALTER TABLE work_count_acquisition ADD COLUMN slot_version INTEGER NOT NULL DEFAULT 1
 CONSTRAINT work_count_acquisition_slot_version_check CHECK(typeof(slot_version)='integer' AND slot_version IN (1,2)
 AND json_type(record,'$.version') IS 'integer'
 AND ((slot_version=1 AND json_extract(record,'$.version') IS 1
 AND root_work_id IS NULL AND activity_id IS NULL AND provider_turn_seq IS NULL AND turn_key IS NULL)
 OR (slot_version=2 AND json_extract(record,'$.version') IS 2
 AND root_work_id IS NOT NULL AND typeof(root_work_id)='text' AND length(CAST(root_work_id AS BLOB)) BETWEEN 1 AND 512
 AND activity_id IS NOT NULL AND typeof(activity_id)='text' AND length(CAST(activity_id AS BLOB)) BETWEEN 1 AND 512
 AND provider_turn_seq IS NOT NULL AND typeof(provider_turn_seq)='integer' AND provider_turn_seq BETWEEN 1 AND 9007199254740991
 AND turn_key IS NOT NULL AND typeof(turn_key)='text' AND length(CAST(turn_key AS BLOB))=64 AND turn_key NOT GLOB '*[^0-9a-f]*'
 AND json_type(record,'$.binding.rootWorkID') IS 'text' AND json_extract(record,'$.binding.rootWorkID') IS root_work_id
 AND json_type(record,'$.binding.turn.activityID') IS 'text' AND json_extract(record,'$.binding.turn.activityID') IS activity_id
 AND json_type(record,'$.binding.turn.providerTurnSeq') IS 'integer' AND json_extract(record,'$.binding.turn.providerTurnSeq') IS provider_turn_seq
 AND json_type(record,'$.binding.turn.key') IS 'text' AND json_extract(record,'$.binding.turn.key') IS turn_key)));
--> statement-breakpoint
DROP INDEX work_count_acquisition_work_idx;
--> statement-breakpoint
DROP INDEX work_count_acquisition_input_idx;
--> statement-breakpoint
CREATE UNIQUE INDEX work_count_acquisition_v1_work_idx ON work_count_acquisition(work_id) WHERE slot_version=1;
--> statement-breakpoint
CREATE UNIQUE INDEX work_count_acquisition_v1_input_idx ON work_count_acquisition(work_id,input_id) WHERE slot_version=1;
--> statement-breakpoint
CREATE UNIQUE INDEX work_count_acquisition_v2_turn_idx ON work_count_acquisition(work_id,activity_id,provider_turn_seq) WHERE slot_version=2;
--> statement-breakpoint
CREATE UNIQUE INDEX work_count_acquisition_v2_key_idx ON work_count_acquisition(work_id,turn_key) WHERE slot_version=2;
--> statement-breakpoint
CREATE UNIQUE INDEX work_count_acquisition_v2_receipt_idx ON work_count_acquisition(provider_receipt_id) WHERE slot_version=2;
--> statement-breakpoint
CREATE UNIQUE INDEX work_count_acquisition_v2_attempt_idx ON work_count_acquisition(provider_attempt_id) WHERE slot_version=2;
--> statement-breakpoint
CREATE INDEX work_count_acquisition_v2_root_state_idx ON work_count_acquisition(root_work_id,state);
--> statement-breakpoint
CREATE TRIGGER work_count_version_insert BEFORE INSERT ON work_count_acquisition BEGIN
 SELECT RAISE(ABORT,'work_count_version_conflict') WHERE
  EXISTS(SELECT 1 FROM work_count_acquisition c WHERE c.work_id=NEW.work_id AND c.slot_version<>NEW.slot_version)
  OR (NEW.slot_version=2 AND NOT EXISTS(SELECT 1 FROM work_execution w
      JOIN session_v2_provider_turn_receipt r ON r.receipt_id=NEW.provider_receipt_id
      JOIN session_provider_attempt p ON p.attempt_id=NEW.provider_attempt_id
      JOIN session_context_selection s ON s.selection_id=p.selection_id
      WHERE w.work_id=NEW.work_id AND w.binding_version=2 AND w.root_work_id=NEW.root_work_id
      AND w.session_id=NEW.session_id AND w.input_id=NEW.input_id
      AND r.session_id=NEW.session_id AND r.activity_id=NEW.activity_id AND r.provider_turn_seq=NEW.provider_turn_seq
      AND r.provider_attempt_id=NEW.provider_attempt_id AND r.user_message_id=NEW.input_id
      AND p.session_id=NEW.session_id AND p.activity_id=NEW.activity_id AND p.provider_turn_seq=NEW.provider_turn_seq
      AND s.session_id=NEW.session_id AND s.activity_id=NEW.activity_id AND s.trigger_input_id=NEW.input_id
      AND s.selection_id=json_extract(NEW.record,'$.binding.turn.contextSelectionID')
      AND s.projection_hash=json_extract(NEW.record,'$.binding.turn.contextProjectionHash')))
  OR (NEW.slot_version=1 AND EXISTS(SELECT 1 FROM work_execution w WHERE w.work_id=NEW.work_id AND w.binding_version<>1));
END;
--> statement-breakpoint
CREATE TRIGGER work_count_version_update BEFORE UPDATE ON work_count_acquisition BEGIN
 SELECT RAISE(ABORT,'work_count_identity_immutable') WHERE
  NEW.acquisition_id IS NOT OLD.acquisition_id OR NEW.work_id IS NOT OLD.work_id OR NEW.slot_version IS NOT OLD.slot_version
  OR (OLD.slot_version=2 AND (NEW.root_work_id IS NOT OLD.root_work_id OR NEW.activity_id IS NOT OLD.activity_id
    OR NEW.provider_turn_seq IS NOT OLD.provider_turn_seq OR NEW.turn_key IS NOT OLD.turn_key
    OR NEW.input_id IS NOT OLD.input_id OR NEW.session_id IS NOT OLD.session_id
    OR NEW.provider_receipt_id IS NOT OLD.provider_receipt_id OR NEW.provider_attempt_id IS NOT OLD.provider_attempt_id
    OR NEW.binding_hash IS NOT OLD.binding_hash OR NEW.approval_id IS NOT OLD.approval_id OR NEW.approval_revision IS NOT OLD.approval_revision
    OR json_extract(NEW.record,'$.binding') IS NOT json_extract(OLD.record,'$.binding')));
END;
--> statement-breakpoint
CREATE TRIGGER work_binding_version_immutable BEFORE UPDATE ON work_execution BEGIN
 SELECT RAISE(ABORT,'work_binding_version_immutable') WHERE NEW.binding_version IS NOT OLD.binding_version
  OR (OLD.binding_version=2 AND (NEW.binding IS NOT OLD.binding OR NEW.binding_hash IS NOT OLD.binding_hash
    OR NEW.work_id IS NOT OLD.work_id OR NEW.root_work_id IS NOT OLD.root_work_id OR NEW.parent_work_id IS NOT OLD.parent_work_id
    OR NEW.session_id IS NOT OLD.session_id OR NEW.input_id IS NOT OLD.input_id
    OR NEW.security_namespace_id IS NOT OLD.security_namespace_id OR NEW.agent_id IS NOT OLD.agent_id
    OR NEW.source_kind IS NOT OLD.source_kind OR NEW.authority_id IS NOT OLD.authority_id
    OR NEW.source_request_id IS NOT OLD.source_request_id));
END;
