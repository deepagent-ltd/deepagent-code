import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008014344_event_investigation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`event_validation_investigation_receipt\` (
          \`receipt_id\` text PRIMARY KEY,
          \`instance_id\` text NOT NULL,
          \`rule_id\` text NOT NULL,
          \`project_key\` text NOT NULL,
          \`security_namespace_id\` text NOT NULL,
          \`content_revision\` integer NOT NULL,
          \`content_hash\` text NOT NULL,
          \`recipe_hash\` text NOT NULL,
          \`failure_key\` text NOT NULL,
          \`run_id\` text NOT NULL,
          \`grant_epoch\` integer NOT NULL,
          \`authority_hash\` text NOT NULL,
          \`work_id\` text NOT NULL,
          \`root_work_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`input_id\` text NOT NULL,
          \`source_request_id\` text NOT NULL,
          \`binding_hash\` text NOT NULL,
          \`deadline\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          \`record\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`record_bytes\` integer NOT NULL,
          CONSTRAINT \`fk_event_validation_investigation_receipt_rule_id_instance_id_project_key_event_validation_rule_rule_id_instance_id_project_key_fk\` FOREIGN KEY (\`rule_id\`,\`instance_id\`,\`project_key\`) REFERENCES \`event_validation_rule\`(\`rule_id\`,\`instance_id\`,\`project_key\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT \`fk_event_validation_investigation_receipt_run_id_rule_id_instance_id_project_key_event_validation_run_run_id_rule_id_instance_id_project_key_fk\` FOREIGN KEY (\`run_id\`,\`rule_id\`,\`instance_id\`,\`project_key\`) REFERENCES \`event_validation_run\`(\`run_id\`,\`rule_id\`,\`instance_id\`,\`project_key\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT \`fk_event_validation_investigation_receipt_security_namespace_id_context_security_namespace_id_fk\` FOREIGN KEY (\`security_namespace_id\`) REFERENCES \`context_security_namespace\`(\`id\`) ON UPDATE RESTRICT ON DELETE RESTRICT,
          CONSTRAINT "event_investigation_receipt_ids" CHECK(typeof("receipt_id")='text' AND length(CAST("receipt_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("receipt_id",char(0))=0 AND typeof("instance_id")='text' AND length(CAST("instance_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("instance_id",char(0))=0 AND typeof("rule_id")='text' AND length(CAST("rule_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("rule_id",char(0))=0 AND typeof("security_namespace_id")='text' AND length(CAST("security_namespace_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("security_namespace_id",char(0))=0 AND typeof("run_id")='text' AND length(CAST("run_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("run_id",char(0))=0 AND typeof("work_id")='text' AND length(CAST("work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("work_id",char(0))=0 AND typeof("root_work_id")='text' AND length(CAST("root_work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("root_work_id",char(0))=0 AND typeof("session_id")='text' AND length(CAST("session_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("session_id",char(0))=0 AND typeof("input_id")='text' AND length(CAST("input_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("input_id",char(0))=0 AND typeof("source_request_id")='text' AND length(CAST("source_request_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("source_request_id",char(0))=0 AND "root_work_id"="work_id" AND "source_request_id"="failure_key"),
          CONSTRAINT "event_investigation_receipt_hashes" CHECK(typeof("project_key")='text' AND length(CAST("project_key" AS BLOB))=64 AND length("project_key")=64 AND "project_key" NOT GLOB '*[^0-9a-f]*' AND typeof("content_hash")='text' AND length(CAST("content_hash" AS BLOB))=64 AND length("content_hash")=64 AND "content_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("recipe_hash")='text' AND length(CAST("recipe_hash" AS BLOB))=64 AND length("recipe_hash")=64 AND "recipe_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("failure_key")='text' AND length(CAST("failure_key" AS BLOB))=64 AND length("failure_key")=64 AND "failure_key" NOT GLOB '*[^0-9a-f]*' AND typeof("authority_hash")='text' AND length(CAST("authority_hash" AS BLOB))=64 AND length("authority_hash")=64 AND "authority_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("binding_hash")='text' AND length(CAST("binding_hash" AS BLOB))=64 AND length("binding_hash")=64 AND "binding_hash" NOT GLOB '*[^0-9a-f]*' AND typeof("record_hash")='text' AND length(CAST("record_hash" AS BLOB))=64 AND length("record_hash")=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "event_investigation_receipt_counters" CHECK(typeof("content_revision")='integer' AND "content_revision" BETWEEN 1 AND 9007199254740991 AND typeof("grant_epoch")='integer' AND "grant_epoch" BETWEEN 1 AND 9007199254740991 AND typeof("deadline")='integer' AND "deadline" BETWEEN 1 AND 9007199254740991 AND typeof("created_at")='integer' AND "created_at" BETWEEN 1 AND 9007199254740991 AND "deadline">"created_at" AND typeof("record_bytes")='integer' AND "record_bytes" BETWEEN 2 AND 262144 AND "record_bytes"=length(CAST("record" AS BLOB))),
          CONSTRAINT "event_investigation_receipt_record" CHECK(CASE WHEN typeof("record")='text' AND length(CAST("record" AS BLOB)) BETWEEN 2 AND 262144 AND instr("record",char(0))=0 AND json_valid("record") THEN coalesce(json_type("record")='object' AND json_type("record",'$.version')='integer' AND json_extract("record",'$.version')=1 AND (json_type("record",'$.receiptID')='text' AND json_extract("record",'$.receiptID') IS "receipt_id") AND (json_type("record",'$.instanceID')='text' AND json_extract("record",'$.instanceID') IS "instance_id") AND (json_type("record",'$.ruleID')='text' AND json_extract("record",'$.ruleID') IS "rule_id") AND (json_type("record",'$.projectKey')='text' AND json_extract("record",'$.projectKey') IS "project_key") AND (json_type("record",'$.securityNamespaceID')='text' AND json_extract("record",'$.securityNamespaceID') IS "security_namespace_id") AND (json_type("record",'$.contentRevision')='integer' AND json_extract("record",'$.contentRevision') IS "content_revision") AND (json_type("record",'$.contentHash')='text' AND json_extract("record",'$.contentHash') IS "content_hash") AND (json_type("record",'$.recipeHash')='text' AND json_extract("record",'$.recipeHash') IS "recipe_hash") AND (json_type("record",'$.failureKey')='text' AND json_extract("record",'$.failureKey') IS "failure_key") AND (json_type("record",'$.runID')='text' AND json_extract("record",'$.runID') IS "run_id") AND (json_type("record",'$.grantEpoch')='integer' AND json_extract("record",'$.grantEpoch') IS "grant_epoch") AND (json_type("record",'$.authorityHash')='text' AND json_extract("record",'$.authorityHash') IS "authority_hash") AND (json_type("record",'$.workID')='text' AND json_extract("record",'$.workID') IS "work_id") AND (json_type("record",'$.rootWorkID')='text' AND json_extract("record",'$.rootWorkID') IS "root_work_id") AND (json_type("record",'$.sessionID')='text' AND json_extract("record",'$.sessionID') IS "session_id") AND (json_type("record",'$.inputID')='text' AND json_extract("record",'$.inputID') IS "input_id") AND (json_type("record",'$.sourceRequestID')='text' AND json_extract("record",'$.sourceRequestID') IS "source_request_id") AND (json_type("record",'$.bindingHash')='text' AND json_extract("record",'$.bindingHash') IS "binding_hash") AND (json_type("record",'$.deadline')='integer' AND json_extract("record",'$.deadline') IS "deadline") AND (json_type("record",'$.createdAt')='integer' AND json_extract("record",'$.createdAt') IS "created_at"),0) ELSE 0 END)
        );
      `)
      yield* tx.run(`ALTER TABLE \`event_validation_rule\` ADD \`investigation_epoch\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_investigation_receipt_failure_idx\` ON \`event_validation_investigation_receipt\` (\`failure_key\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_investigation_receipt_content_idx\` ON \`event_validation_investigation_receipt\` (\`instance_id\`,\`rule_id\`,\`content_revision\`,\`content_hash\`,\`recipe_hash\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_investigation_receipt_work_idx\` ON \`event_validation_investigation_receipt\` (\`work_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_investigation_receipt_session_idx\` ON \`event_validation_investigation_receipt\` (\`session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_investigation_receipt_input_idx\` ON \`event_validation_investigation_receipt\` (\`input_id\`);`)
      yield* tx.run(`CREATE INDEX \`event_investigation_receipt_instance_idx\` ON \`event_validation_investigation_receipt\` (\`instance_id\`,\`created_at\`,\`receipt_id\`);`)
      yield* tx.run(`CREATE INDEX \`event_investigation_receipt_scope_idx\` ON \`event_validation_investigation_receipt\` (\`security_namespace_id\`,\`project_key\`,\`created_at\`,\`receipt_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_validation_run_lineage_idx\` ON \`event_validation_run\` (\`run_id\`,\`rule_id\`,\`instance_id\`,\`project_key\`);`)
      yield* tx.run(`
        CREATE TRIGGER event_validation_rule_investigation_insert_guard BEFORE INSERT ON event_validation_rule
         WHEN NOT coalesce((typeof(NEW.investigation_epoch)='integer' AND NEW.investigation_epoch BETWEEN 0 AND 9007199254740991
         AND ((json_type(NEW.record,'$.investigationAuthority') IS NULL AND NEW.investigation_epoch=0)
         OR (json_type(NEW.record,'$.investigationAuthority')='object'
          AND json_type(NEW.record,'$.investigationAuthority.version')='integer' AND json_extract(NEW.record,'$.investigationAuthority.version')=1
          AND json_type(NEW.record,'$.investigationAuthority.epoch')='integer' AND json_extract(NEW.record,'$.investigationAuthority.epoch')=NEW.investigation_epoch
          AND NEW.investigation_epoch>0 AND json_type(NEW.record,'$.investigationAuthority.updatedAt')='integer'
          AND json_extract(NEW.record,'$.investigationAuthority.updatedAt') BETWEEN NEW.created_at AND NEW.updated_at
          AND ((json_extract(NEW.record,'$.investigationAuthority.state')='disabled' AND json_type(NEW.record,'$.investigationAuthority.grant')='null')
           OR (json_extract(NEW.record,'$.investigationAuthority.state')='enabled' AND json_type(NEW.record,'$.investigationAuthority.grant')='object'
            AND length(CAST(json_extract(NEW.record,'$.investigationAuthority.grant') AS BLOB))<=32768
            AND json_type(NEW.record,'$.investigationAuthority.grant.version')='integer' AND json_extract(NEW.record,'$.investigationAuthority.grant.version')=1
            AND json_type(NEW.record,'$.investigationAuthority.grant.epoch')='integer' AND json_extract(NEW.record,'$.investigationAuthority.grant.epoch')=NEW.investigation_epoch
            AND json_extract(NEW.record,'$.investigationAuthority.grant.ruleID')=NEW.rule_id
            AND json_extract(NEW.record,'$.investigationAuthority.grant.principal.instanceID')=NEW.instance_id
            AND json_type(NEW.record,'$.investigationAuthority.grant.createdAt')='integer'
            AND json_type(NEW.record,'$.investigationAuthority.grant.expiresAt')='integer'
            AND json_extract(NEW.record,'$.investigationAuthority.grant.expiresAt')>json_extract(NEW.record,'$.investigationAuthority.grant.createdAt'))))) AND NEW.investigation_epoch=0 AND json_type(NEW.record,'$.investigationAuthority') IS NULL),0)
         BEGIN SELECT RAISE(ABORT,'validation_investigation_initial_state'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_rule_investigation_update_guard BEFORE UPDATE ON event_validation_rule
         WHEN NOT coalesce((typeof(NEW.investigation_epoch)='integer' AND NEW.investigation_epoch BETWEEN 0 AND 9007199254740991
         AND ((json_type(NEW.record,'$.investigationAuthority') IS NULL AND NEW.investigation_epoch=0)
         OR (json_type(NEW.record,'$.investigationAuthority')='object'
          AND json_type(NEW.record,'$.investigationAuthority.version')='integer' AND json_extract(NEW.record,'$.investigationAuthority.version')=1
          AND json_type(NEW.record,'$.investigationAuthority.epoch')='integer' AND json_extract(NEW.record,'$.investigationAuthority.epoch')=NEW.investigation_epoch
          AND NEW.investigation_epoch>0 AND json_type(NEW.record,'$.investigationAuthority.updatedAt')='integer'
          AND json_extract(NEW.record,'$.investigationAuthority.updatedAt') BETWEEN NEW.created_at AND NEW.updated_at
          AND ((json_extract(NEW.record,'$.investigationAuthority.state')='disabled' AND json_type(NEW.record,'$.investigationAuthority.grant')='null')
           OR (json_extract(NEW.record,'$.investigationAuthority.state')='enabled' AND json_type(NEW.record,'$.investigationAuthority.grant')='object'
            AND length(CAST(json_extract(NEW.record,'$.investigationAuthority.grant') AS BLOB))<=32768
            AND json_type(NEW.record,'$.investigationAuthority.grant.version')='integer' AND json_extract(NEW.record,'$.investigationAuthority.grant.version')=1
            AND json_type(NEW.record,'$.investigationAuthority.grant.epoch')='integer' AND json_extract(NEW.record,'$.investigationAuthority.grant.epoch')=NEW.investigation_epoch
            AND json_extract(NEW.record,'$.investigationAuthority.grant.ruleID')=NEW.rule_id
            AND json_extract(NEW.record,'$.investigationAuthority.grant.principal.instanceID')=NEW.instance_id
            AND json_type(NEW.record,'$.investigationAuthority.grant.createdAt')='integer'
            AND json_type(NEW.record,'$.investigationAuthority.grant.expiresAt')='integer'
            AND json_extract(NEW.record,'$.investigationAuthority.grant.expiresAt')>json_extract(NEW.record,'$.investigationAuthority.grant.createdAt')))))
         AND (NEW.investigation_epoch=OLD.investigation_epoch OR NEW.investigation_epoch=OLD.investigation_epoch+1)
         AND (OLD.investigation_epoch=0 OR json_type(NEW.record,'$.investigationAuthority')='object')
         AND (NEW.config_hash IS NOT OLD.config_hash OR json_extract(NEW.record,'$.configuration') IS json_extract(OLD.record,'$.configuration'))
         AND ((NEW.investigation_epoch=OLD.investigation_epoch
           AND json_extract(NEW.record,'$.investigationAuthority') IS json_extract(OLD.record,'$.investigationAuthority'))
         OR (NEW.investigation_epoch=OLD.investigation_epoch+1
           AND ((NEW.rule_id IS OLD.rule_id AND NEW.instance_id IS OLD.instance_id AND NEW.project_key IS OLD.project_key
         AND NEW.revision IS OLD.revision AND NEW.state IS OLD.state AND NEW.operator_id IS OLD.operator_id
         AND NEW.operator_revision IS OLD.operator_revision AND NEW.config_hash IS OLD.config_hash
         AND NEW.content_revision IS OLD.content_revision AND NEW.content_hash IS OLD.content_hash AND NEW.run_count IS OLD.run_count
         AND NEW.pending_first_at IS OLD.pending_first_at AND NEW.pending_last_at IS OLD.pending_last_at AND NEW.due_at IS OLD.due_at
         AND NEW.current_run_id IS OLD.current_run_id AND NEW.last_reason IS OLD.last_reason AND NEW.created_at IS OLD.created_at
         AND json_remove(NEW.record,'$.investigationAuthority','$.updatedAt') IS json_remove(OLD.record,'$.investigationAuthority','$.updatedAt')) OR (OLD.investigation_epoch>0 AND (NEW.config_hash IS NOT OLD.config_hash OR NEW.operator_revision IS NOT OLD.operator_revision
         OR (NEW.state IS NOT OLD.state AND NEW.state<>'enabled'))
             AND json_extract(NEW.record,'$.investigationAuthority.state')='disabled' AND json_type(NEW.record,'$.investigationAuthority.grant')='null'))))
         AND (OLD.investigation_epoch=0 OR NOT (NEW.config_hash IS NOT OLD.config_hash OR NEW.operator_revision IS NOT OLD.operator_revision
         OR (NEW.state IS NOT OLD.state AND NEW.state<>'enabled'))
          OR (NEW.investigation_epoch=OLD.investigation_epoch+1 AND json_extract(NEW.record,'$.investigationAuthority.state')='disabled'
           AND json_type(NEW.record,'$.investigationAuthority.grant')='null'))),0)
         BEGIN SELECT RAISE(ABORT,'validation_investigation_transition'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_validation_command_investigation_insert_guard BEFORE INSERT ON event_validation_command
         WHEN NOT coalesce((json_type(NEW.receipt,'$.investigation') IS NULL OR (NEW.action='update'
          AND json_type(NEW.receipt,'$.investigation')='object' AND json_type(NEW.receipt,'$.investigation.version')='integer'
          AND json_extract(NEW.receipt,'$.investigation.version')=1 AND json_extract(NEW.receipt,'$.investigation.operation') IN ('enable','disable')
          AND json_type(NEW.receipt,'$.investigation.epoch')='integer' AND json_extract(NEW.receipt,'$.investigation.epoch') BETWEEN 1 AND 9007199254740991)),0)
         BEGIN SELECT RAISE(ABORT,'validation_investigation_command'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_investigation_receipt_insert_guard BEFORE INSERT ON event_validation_investigation_receipt
         WHEN NOT coalesce((EXISTS(SELECT 1 FROM event_validation_rule v JOIN event_validation_run r
          ON r.rule_id=v.rule_id AND r.instance_id=v.instance_id AND r.project_key=v.project_key
          JOIN context_security_namespace n ON n.id=NEW.security_namespace_id AND n.retired_at IS NULL
          WHERE v.rule_id=NEW.rule_id AND v.instance_id=NEW.instance_id AND v.project_key=NEW.project_key AND r.run_id=NEW.run_id
           AND v.state='enabled' AND v.investigation_epoch=NEW.grant_epoch
           AND json_extract(v.record,'$.investigationAuthority.state')='enabled'
           AND json_extract(v.record,'$.investigationAuthority.grant') IS json_extract(NEW.record,'$.grant')
           AND json_extract(v.record,'$.configuration.scope.securityNamespaceID')=NEW.security_namespace_id
           AND v.current_run_id=r.run_id AND v.revision=r.rule_revision AND v.content_revision=r.content_revision AND v.content_hash=r.content_hash
           AND r.content_revision=NEW.content_revision AND r.content_hash=NEW.content_hash AND r.recipe_hash=NEW.recipe_hash
           AND r.state='settled' AND r.outcome='failed' AND r.cancel_requested=0 AND r.released_at IS NOT NULL AND r.retained_bytes=0
           AND json_type(r.record,'$.resultCurrent')='true' AND json_type(r.record,'$.result.stopConfirmed')='true'
           AND json_type(r.record,'$.result.stdout.complete')='true' AND json_type(r.record,'$.result.stderr.complete')='true'
           AND json_type(r.record,'$.snapshotHash')='text' AND json_type(r.record,'$.processIncarnation')='text'
           AND json_type(NEW.record,'$.evidence')='object' AND json_type(NEW.record,'$.evidence.version')='integer' AND json_extract(NEW.record,'$.evidence.version')=1
           AND json_extract(NEW.record,'$.evidence.instanceID')=r.instance_id AND json_extract(NEW.record,'$.evidence.ruleID')=r.rule_id
           AND json_extract(NEW.record,'$.evidence.runID')=r.run_id AND json_extract(NEW.record,'$.evidence.ruleRevision')=r.rule_revision
           AND json_extract(NEW.record,'$.evidence.contentRevision')=r.content_revision AND json_extract(NEW.record,'$.evidence.contentHash')=r.content_hash
           AND json_extract(NEW.record,'$.evidence.recipeHash')=r.recipe_hash AND json_extract(NEW.record,'$.evidence.configHash')=v.config_hash
           AND json_extract(NEW.record,'$.evidence.configHash') IS json_extract(r.record,'$.configHash')
           AND json_extract(NEW.record,'$.evidence.snapshotHash') IS json_extract(r.record,'$.snapshotHash')
           AND json_extract(NEW.record,'$.evidence.processIncarnation') IS json_extract(r.record,'$.processIncarnation')
           AND json_extract(NEW.record,'$.evidence.content') IS json_extract(r.record,'$.content')
           AND json_type(NEW.record,'$.evidence.testRunID') IN ('text','null')
           AND json_type(NEW.record,'$.evidence.previewBuildID') IN ('text','null')
           AND json_type(NEW.record,'$.evidence.result.exitCode') IN ('integer','null')
           AND json_type(NEW.record,'$.evidence.result.signal') IN ('text','null')
           AND json_type(NEW.record,'$.evidence.result.endedAt')='integer'
           AND json_extract(r.record,'$.result.endedAt') BETWEEN coalesce(r.started_at,r.created_at) AND r.terminal_at
           AND json_extract(NEW.record,'$.evidence.testRunID') IS json_extract(r.record,'$.testRunID')
           AND json_extract(NEW.record,'$.evidence.previewBuildID') IS json_extract(r.record,'$.previewBuildID')
           AND json_extract(NEW.record,'$.evidence.result.outcome')='failed'
           AND json_type(NEW.record,'$.evidence.result.stopConfirmed')='true'
           AND json_type(NEW.record,'$.evidence.result.stdout.complete')='true' AND json_type(NEW.record,'$.evidence.result.stderr.complete')='true'
           AND json_extract(NEW.record,'$.evidence.result.exitCode') IS json_extract(r.record,'$.result.exitCode')
           AND json_extract(NEW.record,'$.evidence.result.signal') IS json_extract(r.record,'$.result.signal')
           AND json_extract(NEW.record,'$.evidence.result.endedAt') IS json_extract(r.record,'$.result.endedAt')
           AND json_extract(NEW.record,'$.evidence.result.stdout.sha256') IS json_extract(r.record,'$.result.stdout.sha256')
           AND json_extract(NEW.record,'$.evidence.result.stdout.bytes') IS json_extract(r.record,'$.result.stdout.bytes')
           AND json_extract(NEW.record,'$.evidence.result.stdout.capturedBytes') IS json_extract(r.record,'$.result.stdout.capturedBytes')
           AND json_extract(NEW.record,'$.evidence.result.stdout.truncated') IS json_extract(r.record,'$.result.stdout.truncated')
           AND json_type(NEW.record,'$.evidence.result.stdout.excerptTruncated') IN ('true','false')
           AND json_extract(NEW.record,'$.evidence.result.stdout.excerptTruncated') IS json_extract(r.record,'$.result.stdout.excerptTruncated')
           AND json_type(NEW.record,'$.evidence.result.stderr.excerptTruncated') IN ('true','false')
           AND json_extract(NEW.record,'$.evidence.result.stderr.excerptTruncated') IS json_extract(r.record,'$.result.stderr.excerptTruncated')
           AND json_extract(NEW.record,'$.evidence.result.stderr.sha256') IS json_extract(r.record,'$.result.stderr.sha256')
           AND json_extract(NEW.record,'$.evidence.result.stderr.bytes') IS json_extract(r.record,'$.result.stderr.bytes')
           AND json_extract(NEW.record,'$.evidence.result.stderr.capturedBytes') IS json_extract(r.record,'$.result.stderr.capturedBytes')
           AND json_extract(NEW.record,'$.evidence.result.stderr.truncated') IS json_extract(r.record,'$.result.stderr.truncated')
           AND NEW.created_at>=r.terminal_at AND NEW.deadline<=json_extract(NEW.record,'$.grant.expiresAt')
           AND NEW.deadline<=json_extract(v.record,'$.configuration.expiresAt'))),0)
         BEGIN SELECT RAISE(ABORT,'validation_investigation_source'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_investigation_receipt_capacity_guard BEFORE INSERT ON event_validation_investigation_receipt
         WHEN (SELECT count(*) FROM event_validation_investigation_receipt WHERE instance_id=NEW.instance_id)>=10000
         OR (SELECT coalesce(sum(record_bytes),0) FROM event_validation_investigation_receipt WHERE instance_id=NEW.instance_id)+NEW.record_bytes>268435456
         BEGIN SELECT RAISE(ABORT,'validation_investigation_capacity'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_investigation_receipt_update_guard BEFORE UPDATE ON event_validation_investigation_receipt
         BEGIN SELECT RAISE(ABORT,'validation_investigation_retained'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_investigation_receipt_delete_guard BEFORE DELETE ON event_validation_investigation_receipt
         BEGIN SELECT RAISE(ABORT,'validation_investigation_retained'); END;
      `)
      yield* tx.run(`
        CREATE TRIGGER event_investigation_receipt_payload_guard BEFORE INSERT ON event_validation_investigation_receipt
         WHEN NOT coalesce((json_type(NEW.record,'$.grant')='object' AND json_type(NEW.record,'$.evidence')='object'
         AND length(CAST(json_extract(NEW.record,'$.grant') AS BLOB))<=32768
         AND length(CAST(json_extract(NEW.record,'$.evidence') AS BLOB))<=65536
         AND json_type(NEW.record,'$.auditedText')='text' AND length(CAST(json_extract(NEW.record,'$.auditedText') AS BLOB))<=65536
         AND json_type(NEW.record,'$.auditedTextBytes')='integer'
         AND json_extract(NEW.record,'$.auditedTextBytes')=length(CAST(json_extract(NEW.record,'$.auditedText') AS BLOB))
         AND json_type(NEW.record,'$.grantHash')='text' AND length(CAST(json_extract(NEW.record,'$.grantHash') AS BLOB))=64 AND length(json_extract(NEW.record,'$.grantHash'))=64 AND json_extract(NEW.record,'$.grantHash') NOT GLOB '*[^0-9a-f]*'
         AND json_type(NEW.record,'$.evidenceHash')='text' AND length(CAST(json_extract(NEW.record,'$.evidenceHash') AS BLOB))=64 AND length(json_extract(NEW.record,'$.evidenceHash'))=64 AND json_extract(NEW.record,'$.evidenceHash') NOT GLOB '*[^0-9a-f]*'
         AND json_type(NEW.record,'$.auditedTextHash')='text' AND length(CAST(json_extract(NEW.record,'$.auditedTextHash') AS BLOB))=64 AND length(json_extract(NEW.record,'$.auditedTextHash'))=64 AND json_extract(NEW.record,'$.auditedTextHash') NOT GLOB '*[^0-9a-f]*'
         AND json_type(NEW.record,'$.evidence.scopeHash')='text' AND length(CAST(json_extract(NEW.record,'$.evidence.scopeHash') AS BLOB))=64 AND length(json_extract(NEW.record,'$.evidence.scopeHash'))=64 AND json_extract(NEW.record,'$.evidence.scopeHash') NOT GLOB '*[^0-9a-f]*'
         AND json_type(NEW.record,'$.evidence.resultHash')='text' AND length(CAST(json_extract(NEW.record,'$.evidence.resultHash') AS BLOB))=64 AND length(json_extract(NEW.record,'$.evidence.resultHash'))=64 AND json_extract(NEW.record,'$.evidence.resultHash') NOT GLOB '*[^0-9a-f]*'),0)
         BEGIN SELECT RAISE(ABORT,'validation_investigation_payload'); END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
