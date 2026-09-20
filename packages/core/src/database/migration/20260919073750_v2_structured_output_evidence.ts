import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Worklist #29 part 2 — the V2 structured-output evidence authority. One append-only row per
// schema-bound V2 task run: the insert guard admits only lineage-bound, V2-runtime evidence with
// hex64 hashes, the outcome vocabulary, and (for validated records) a binding to a real assistant
// session_message of the child session; update and delete are forbidden outright. The frozen V1
// task_structured_output_evidence stays untouched read-only history.
export default {
  id: "20260919073750_v2_structured_output_evidence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_v2_structured_output_evidence\` (
          \`evidence_id\` text PRIMARY KEY,
          \`run_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`output_message_id\` text,
          \`schema_name\` text NOT NULL,
          \`validation_outcome\` text NOT NULL,
          \`output_sha256\` text NOT NULL,
          \`schema_sha256\` text NOT NULL,
          \`raw_output\` text NOT NULL,
          \`owner_token\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_v2_structured_output_evidence_run_idx\` ON \`session_v2_structured_output_evidence\` (\`run_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_v2_structured_output_evidence_session_idx\` ON \`session_v2_structured_output_evidence\` (\`session_id\`,\`time_created\`);`)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_v2_structured_output_evidence_insert_guard
        BEFORE INSERT ON session_v2_structured_output_evidence
        WHEN NEW.evidence_id IS NULL
          OR length(trim(NEW.evidence_id)) = 0
          OR NEW.run_id IS NULL
          OR length(trim(NEW.run_id)) = 0
          OR NEW.session_id IS NULL
          OR length(trim(NEW.session_id)) = 0
          OR NEW.child_session_id IS NULL
          OR length(trim(NEW.child_session_id)) = 0
          OR NEW.schema_name IS NULL
          OR length(trim(NEW.schema_name)) = 0
          OR NEW.validation_outcome NOT IN ('validated', 'validation_failed', 'unvalidated')
          OR NEW.output_sha256 IS NULL
          OR length(NEW.output_sha256) != 64
          OR NEW.output_sha256 GLOB '*[^0-9a-f]*'
          OR NEW.schema_sha256 IS NULL
          OR length(NEW.schema_sha256) != 64
          OR NEW.schema_sha256 GLOB '*[^0-9a-f]*'
          OR NEW.raw_output IS NULL
          OR NEW.owner_token IS NULL
          OR length(trim(NEW.owner_token)) = 0
          OR NEW.time_created IS NULL
          OR NOT EXISTS (
            SELECT 1 FROM task_run
            WHERE task_run.run_id = NEW.run_id
              AND task_run.execution_runtime = 'v2'
              AND task_run.parent_session_id = NEW.session_id
              AND task_run.child_session_id = NEW.child_session_id
          )
          OR (
            NEW.output_message_id IS NOT NULL AND (
              length(trim(NEW.output_message_id)) = 0
              OR NOT EXISTS (
                SELECT 1 FROM session_message
                WHERE session_message.id = NEW.output_message_id
                  AND session_message.session_id = NEW.child_session_id
                  AND session_message.type = 'assistant'
              )
            )
          )
          OR (
            NEW.validation_outcome = 'validated' AND (
              NEW.output_message_id IS NULL OR length(NEW.raw_output) = 0
            )
          )
        BEGIN
          SELECT RAISE(ABORT, 'invalid v2 structured output evidence');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_v2_structured_output_evidence_update_guard
        BEFORE UPDATE ON session_v2_structured_output_evidence
        BEGIN
          SELECT RAISE(ABORT, 'v2 structured output evidence is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_v2_structured_output_evidence_delete_guard
        BEFORE DELETE ON session_v2_structured_output_evidence
        BEGIN
          SELECT RAISE(ABORT, 'v2 structured output evidence is append only');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
