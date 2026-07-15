import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: agent-push digest flush marker (§B2/§E4)
 *
 * Adds `digest_flushed_at` to `im_agent_push_logs`. A `decision='digest'` push is HELD during quiet
 * hours (no im_messages row is written by agent-push); the DigestBuilder later batches the held pushes
 * into one summary per group when quiet hours end. This column is that "already flushed" marker:
 *   NULL  → held, awaiting the next quiet-hours-end digest flush.
 *   <ts>  → the epoch ms at which the DigestBuilder delivered it in a batch (never re-delivered).
 *
 * Nullable + ADD COLUMN is backward-compatible (§H): existing rows read NULL, and the digest builder
 * treats pre-migration digest rows as unflushed (they'll flush on the next pass). Guarded via a
 * table_info check because SQLite has no ADD COLUMN IF NOT EXISTS (mirrors 20260711040000).
 */
export default {
  id: "20260711090000_im_agent_push_digest_flushed",
  up(tx) {
    return Effect.gen(function* () {
      const cols = yield* tx.all<{ name: string }>(`PRAGMA table_info(\`im_agent_push_logs\`)`)
      const has = (name: string) => cols.some((c) => c.name === name)
      if (!has("digest_flushed_at")) {
        yield* tx.run(`ALTER TABLE \`im_agent_push_logs\` ADD COLUMN \`digest_flushed_at\` integer;`)
      }
      // §E4 digest scan: unflushed held-digest rows per workspace, so the builder finds pending digests
      // without a full-table scan (WHERE decision='digest' AND digest_flushed_at IS NULL).
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`idx_im_agent_push_logs_digest_pending\`
        ON \`im_agent_push_logs\` (\`workspace_id\`, \`decision\`, \`digest_flushed_at\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
