import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008143129_work_child_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`work_child_authority\` (
          \`child_work_id\` text PRIMARY KEY NOT NULL,
          \`root_work_id\` text NOT NULL,
          \`parent_work_id\` text NOT NULL,
          \`task_run_id\` text NOT NULL,
          \`admission_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`child_input_id\` text NOT NULL,
          \`child_binding_hash\` text NOT NULL,
          \`parent_binding_hash\` text NOT NULL,
          \`root_binding_hash\` text NOT NULL,
          \`parent_revision\` integer NOT NULL,
          \`root_revision\` integer NOT NULL,
          \`record\` text NOT NULL,
          \`record_hash\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`created_at\` integer NOT NULL,
          CONSTRAINT "work_child_authority_text_check" CHECK(typeof("child_work_id")='text' AND length(CAST("child_work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("child_work_id",char(0))=0 AND typeof("root_work_id")='text' AND length(CAST("root_work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("root_work_id",char(0))=0 AND typeof("parent_work_id")='text' AND length(CAST("parent_work_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("parent_work_id",char(0))=0 AND typeof("task_run_id")='text' AND length(CAST("task_run_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("task_run_id",char(0))=0 AND typeof("admission_id")='text' AND length(CAST("admission_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("admission_id",char(0))=0 AND typeof("child_session_id")='text' AND length(CAST("child_session_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("child_session_id",char(0))=0 AND typeof("child_input_id")='text' AND length(CAST("child_input_id" AS BLOB)) BETWEEN 1 AND 512 AND instr("child_input_id",char(0))=0),
          CONSTRAINT "work_child_authority_lineage_check" CHECK("child_work_id" != "parent_work_id" AND "parent_work_id" = "root_work_id"),
          CONSTRAINT "work_child_authority_revision_check" CHECK(typeof("parent_revision")='integer' AND "parent_revision" BETWEEN 1 AND 9007199254740991 AND typeof("root_revision")='integer' AND "root_revision" BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_child_authority_time_check" CHECK(typeof("created_at")='integer' AND "created_at" BETWEEN 0 AND 9007199254740991 AND typeof("expires_at")='integer' AND "expires_at" BETWEEN 1 AND 9007199254740991 AND "expires_at">"created_at"),
          CONSTRAINT "work_child_authority_hash_check" CHECK(length("record_hash")=64 AND "record_hash" NOT GLOB '*[^0-9a-f]*' AND length("child_binding_hash")=64 AND "child_binding_hash" NOT GLOB '*[^0-9a-f]*' AND length("parent_binding_hash")=64 AND "parent_binding_hash" NOT GLOB '*[^0-9a-f]*' AND length("root_binding_hash")=64 AND "root_binding_hash" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "work_child_authority_record_check" CHECK(json_valid("record") AND length(CAST("record" AS BLOB)) BETWEEN 2 AND 196608 AND json_type("record")='object' AND json_extract("record",'$.version') IS 1 AND json_extract("record",'$.childWorkID') IS "child_work_id" AND json_extract("record",'$.rootWorkID') IS "root_work_id" AND json_extract("record",'$.parentWorkID') IS "parent_work_id" AND json_extract("record",'$.taskRunID') IS "task_run_id" AND json_extract("record",'$.admissionID') IS "admission_id" AND json_extract("record",'$.childSessionID') IS "child_session_id" AND json_extract("record",'$.childInputID') IS "child_input_id" AND json_extract("record",'$.childBindingHash') IS "child_binding_hash" AND json_extract("record",'$.parentBindingHash') IS "parent_binding_hash" AND json_extract("record",'$.rootBindingHash') IS "root_binding_hash" AND json_extract("record",'$.parentRevision') IS "parent_revision" AND json_extract("record",'$.rootRevision') IS "root_revision" AND json_extract("record",'$.expiresAt') IS "expires_at" AND json_extract("record",'$.createdAt') IS "created_at"),
          CONSTRAINT "work_child_authority_parent_check" CHECK(json_extract("record",'$.parentBinding.workID') IS "parent_work_id" AND json_extract("record",'$.rootBinding.workID') IS "root_work_id" AND json_extract("record",'$.parentBinding.rootWorkID') IS "root_work_id" AND json_extract("record",'$.rootBinding.rootWorkID') IS "root_work_id" AND json_extract("record",'$.parentBinding.sessionID') IS json_extract("record",'$.parentSessionID') AND json_extract("record",'$.rootBinding.sessionID') IS json_extract("record",'$.parentSessionID') AND json_extract("record",'$.parentBinding.inputID') IS json_extract("record",'$.triggerInputID') AND json_extract("record",'$.rootBinding.inputID') IS json_extract("record",'$.triggerInputID') AND json_extract("record",'$.parentBinding.profile.id') IS 'project_shared_root_v1' AND json_extract("record",'$.rootBinding.profile.id') IS 'project_shared_root_v1' AND json_extract("record",'$.parentBinding.schemaVersion') IS 'work-execution.v2' AND json_extract("record",'$.rootBinding.schemaVersion') IS 'work-execution.v2' AND json_type("record",'$.parentBinding.parentWorkID') IS NULL AND json_type("record",'$.rootBinding.parentWorkID') IS NULL),
          CONSTRAINT "work_child_authority_record_ids_check" CHECK(json_type("record",'$.parentSessionID') IS 'text' AND length(CAST(json_extract("record",'$.parentSessionID') AS BLOB)) BETWEEN 1 AND 512 AND instr(json_extract("record",'$.parentSessionID'),char(0))=0 AND json_type("record",'$.parentMessageID') IS 'text' AND length(CAST(json_extract("record",'$.parentMessageID') AS BLOB)) BETWEEN 1 AND 512 AND instr(json_extract("record",'$.parentMessageID'),char(0))=0 AND json_type("record",'$.toolCallID') IS 'text' AND length(CAST(json_extract("record",'$.toolCallID') AS BLOB)) BETWEEN 1 AND 512 AND instr(json_extract("record",'$.toolCallID'),char(0))=0 AND json_type("record",'$.receiptID') IS 'text' AND length(CAST(json_extract("record",'$.receiptID') AS BLOB)) BETWEEN 1 AND 512 AND instr(json_extract("record",'$.receiptID'),char(0))=0 AND json_type("record",'$.attemptID') IS 'text' AND length(CAST(json_extract("record",'$.attemptID') AS BLOB)) BETWEEN 1 AND 512 AND instr(json_extract("record",'$.attemptID'),char(0))=0 AND json_type("record",'$.ownerToken') IS 'text' AND length(CAST(json_extract("record",'$.ownerToken') AS BLOB)) BETWEEN 1 AND 512 AND instr(json_extract("record",'$.ownerToken'),char(0))=0 AND json_type("record",'$.activityID') IS 'text' AND length(CAST(json_extract("record",'$.activityID') AS BLOB)) BETWEEN 1 AND 512 AND instr(json_extract("record",'$.activityID'),char(0))=0 AND json_type("record",'$.triggerInputID') IS 'text' AND length(CAST(json_extract("record",'$.triggerInputID') AS BLOB)) BETWEEN 1 AND 512 AND instr(json_extract("record",'$.triggerInputID'),char(0))=0 AND json_type("record",'$.registrationGeneration') IS 'text' AND length(CAST(json_extract("record",'$.registrationGeneration') AS BLOB)) BETWEEN 1 AND 512 AND instr(json_extract("record",'$.registrationGeneration'),char(0))=0),
          CONSTRAINT "work_child_authority_record_counts_check" CHECK(json_type("record",'$.sessionClaimToken') IS 'integer' AND json_extract("record",'$.sessionClaimToken') BETWEEN 1 AND 9007199254740991 AND json_type("record",'$.expectedInputSeq') IS 'integer' AND json_extract("record",'$.expectedInputSeq') BETWEEN 1 AND 9007199254740991),
          CONSTRAINT "work_child_authority_ordinal_check" CHECK(json_type("record",'$.activityOrdinal') IS 'integer' AND json_extract("record",'$.activityOrdinal') BETWEEN 0 AND 9007199254740991)
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_child_authority_run_idx\` ON \`work_child_authority\` (\`task_run_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_child_authority_admission_idx\` ON \`work_child_authority\` (\`admission_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_child_authority_session_idx\` ON \`work_child_authority\` (\`child_session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`work_child_authority_input_idx\` ON \`work_child_authority\` (\`child_input_id\`);`)
      yield* tx.run(`CREATE INDEX \`work_child_authority_root_idx\` ON \`work_child_authority\` (\`root_work_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
