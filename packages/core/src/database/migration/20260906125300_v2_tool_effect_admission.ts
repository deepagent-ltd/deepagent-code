import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260906125300_v2_tool_effect_admission",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_v2_tool_effect_admission\` (
          \`admission_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`provider_attempt_id\` text NOT NULL,
          \`receipt_id\` text NOT NULL,
          \`tool_call_id\` text NOT NULL,
          \`tool_name\` text NOT NULL,
          \`effect_kind\` text NOT NULL,
          \`owner_token\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_v2_tool_effect_admission_call_idx\` ON \`session_v2_tool_effect_admission\` (\`receipt_id\`,\`tool_call_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_v2_tool_effect_admission_session_idx\` ON \`session_v2_tool_effect_admission\` (\`session_id\`,\`time_created\`);`)
      yield* tx.run(`
        INSERT INTO session_v2_tool_effect_admission (
          admission_id, session_id, provider_attempt_id, receipt_id, tool_call_id,
          tool_name, effect_kind, owner_token, time_created
        )
        SELECT
          'admission_' || effect_id, session_id, provider_attempt_id, receipt_id, tool_call_id,
          tool_name, effect_kind, owner_token, time_created
        FROM session_v2_tool_effect
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_tool_effect_admission_insert_guard
        BEFORE INSERT ON session_v2_tool_effect_admission
        WHEN length(trim(NEW.admission_id)) = 0
          OR length(trim(NEW.session_id)) = 0
          OR length(trim(NEW.provider_attempt_id)) = 0
          OR length(trim(NEW.receipt_id)) = 0
          OR length(trim(NEW.tool_call_id)) = 0
          OR length(trim(NEW.tool_name)) = 0
          OR NEW.effect_kind NOT IN ('mutating', 'read_only')
          OR length(trim(NEW.owner_token)) = 0
        BEGIN
          SELECT RAISE(ABORT, 'invalid v2 tool effect admission');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_tool_effect_admission_update_guard
        BEFORE UPDATE ON session_v2_tool_effect_admission
        BEGIN
          SELECT RAISE(ABORT, 'v2 tool effect admission is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_tool_effect_admission_delete_guard
        BEFORE DELETE ON session_v2_tool_effect_admission
        BEGIN
          SELECT RAISE(ABORT, 'v2 tool effect admission is append only');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_tool_effect_requires_admission
        BEFORE INSERT ON session_v2_tool_effect
        WHEN NOT EXISTS (
          SELECT 1
          FROM session_v2_tool_effect_admission admission
          WHERE admission.receipt_id = NEW.receipt_id
            AND admission.tool_call_id = NEW.tool_call_id
            AND admission.session_id = NEW.session_id
            AND admission.provider_attempt_id = NEW.provider_attempt_id
            AND admission.tool_name = NEW.tool_name
            AND admission.effect_kind = NEW.effect_kind
            AND admission.owner_token = NEW.owner_token
        )
        BEGIN
          SELECT RAISE(ABORT, 'v2 tool effect admission missing or divergent');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
