import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// FEAT-007 — durable per-turn reconciliation of federated context selections. The in-memory
// knowledgeMemoryDelta was the only legacy-vs-projection evidence and evaporated on restart;
// this table persists one row per federated provider turn receipt. Forward-only: pure additive
// CREATE TABLE + indexes (hand-authored, mirroring the handoff_admission_receipt precedent —
// the table is typed in reconciliation-sql.ts but stays outside the drizzle-managed schema).
export default {
  id: "20260816081000_session_context_reconciliation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`session_context_reconciliation\` (
          \`reconciliation_id\` text PRIMARY KEY NOT NULL,
          \`session_id\` text NOT NULL REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          \`activity_id\` text NOT NULL REFERENCES \`session_activity\`(\`activity_id\`) ON DELETE CASCADE,
          \`turn_receipt_id\` text NOT NULL,
          \`selection_id\` text,
          \`legacy_refs_fingerprint\` text
          CHECK (\`legacy_refs_fingerprint\` IS NULL OR (
            length(\`legacy_refs_fingerprint\`) = 64 AND
            \`legacy_refs_fingerprint\` NOT GLOB '*[^0-9a-f]*'
          )),
          \`projection_refs_fingerprint\` text NOT NULL
          CHECK (
            length(\`projection_refs_fingerprint\`) = 64 AND
            \`projection_refs_fingerprint\` NOT GLOB '*[^0-9a-f]*'
          ),
          \`outcome\` text NOT NULL,
          \`diff_summary\` text NOT NULL
          CHECK (
            json_valid(\`diff_summary\`) = 1 AND
            json_type(\`diff_summary\`) = 'object'
          ),
          \`created_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS \`session_context_reconciliation_receipt_idx\`
        ON \`session_context_reconciliation\` (\`turn_receipt_id\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`session_context_reconciliation_session_idx\`
        ON \`session_context_reconciliation\` (\`session_id\`, \`created_at\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
