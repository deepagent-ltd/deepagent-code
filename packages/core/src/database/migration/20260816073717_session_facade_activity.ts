import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// FEAT-011 T1 — facade activity authority schema. Forward-only and purely additive: creates
// the new `session_facade_activity` base table and nothing else. The federation objective /
// permission child tables keep their ('legacy', 'v2') CHECKs on purpose — they are the fence
// that keeps the facade branch isolated from the objective/permission machinery (facade
// settlement is raw-SQL CAS on the base table, mirroring the legacy branch).
// The drizzle-generated CREATE TABLE/index statements below are augmented with CHECK clauses
// and lifecycle triggers that drizzle cannot express.
export default {
  id: "20260816073717_session_facade_activity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_facade_activity\` (
          \`activity_id\` text PRIMARY KEY,
          \`subkind\` text NOT NULL CHECK (\`subkind\` IN ('task', 'goal', 'panel')),
          \`parent_session_id\` text NOT NULL,
          \`owner_session_id\` text,
          \`spawn_tool_call_id\` text,
          \`objective_text\` text,
          \`budget_json\` text,
          \`state\` text NOT NULL CHECK (\`state\` IN ('active', 'settled', 'failed', 'interrupted', 'recovery_required')),
          \`reason_code\` text,
          \`source\` text,
          \`created_at\` integer NOT NULL,
          \`settled_at\` integer,
          \`mutation_epoch\` integer NOT NULL CHECK (\`mutation_epoch\` >= 0),
          CONSTRAINT \`fk_session_facade_activity_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_facade_activity_owner_session_id_session_id_fk\` FOREIGN KEY (\`owner_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CHECK (
            (\`state\` = 'active' AND \`settled_at\` IS NULL AND \`reason_code\` IS NULL) OR
            (\`state\` != 'active' AND \`settled_at\` IS NOT NULL AND \`reason_code\` IS NOT NULL)
          )
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`session_facade_activity_active_idx\` ON \`session_facade_activity\` (\`parent_session_id\`,\`subkind\`) WHERE "session_facade_activity"."state" = 'active';`)
      yield* tx.run(`CREATE INDEX \`session_facade_activity_parent_idx\` ON \`session_facade_activity\` (\`parent_session_id\`,\`state\`,\`created_at\`);`)

      // BUG-004 shape: opening a new facade activity requires settling the previous active one
      // of the same parent+subkind first — enforced by the partial unique index above plus the
      // single-shot active→terminal transition rule below (mirrors session_legacy_activity).
      yield* tx.run(`
        CREATE TRIGGER session_facade_activity_legal_update
        BEFORE UPDATE ON session_facade_activity
        WHEN NEW.activity_id != OLD.activity_id
          OR NEW.subkind != OLD.subkind
          OR NEW.parent_session_id != OLD.parent_session_id
          OR COALESCE(NEW.owner_session_id, '') != COALESCE(OLD.owner_session_id, '')
          OR COALESCE(NEW.spawn_tool_call_id, '') != COALESCE(OLD.spawn_tool_call_id, '')
          OR COALESCE(NEW.objective_text, '') != COALESCE(OLD.objective_text, '')
          OR COALESCE(NEW.budget_json, '') != COALESCE(OLD.budget_json, '')
          OR COALESCE(NEW.source, '') != COALESCE(OLD.source, '')
          OR NEW.created_at != OLD.created_at
          OR OLD.state != 'active'
          OR NEW.state NOT IN ('settled', 'failed', 'interrupted', 'recovery_required')
          OR NEW.settled_at IS NULL
          OR NEW.reason_code IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_facade_activity transition');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_facade_activity_permission_effect_terminal_guard
        BEFORE UPDATE OF state ON session_facade_activity
        WHEN NEW.state IN ('settled', 'failed', 'interrupted', 'recovery_required') AND EXISTS (
          SELECT 1
          FROM session_activity_permission_effect_dispatch dispatch
          WHERE dispatch.activity_kind = 'facade'
            AND dispatch.activity_id = OLD.activity_id
            AND (
              dispatch.state = 'started' OR
              (NEW.state IN ('settled', 'interrupted') AND dispatch.state = 'unknown')
            )
        )
        BEGIN
          SELECT RAISE(ABORT, 'activity has unresolved permission effects');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
