/**
 * Durable IM reply outbox.
 *
 * The V2 IM slice (durable-only migration) admits each @mention directly as durable
 * SessionV2 work (one `session_input` row per (IM message, mentioned agent), stable
 * session per (group, agent)). When that session's activity settles, the terminal
 * assistant reply must reach the IM conversation durably: no fire-and-forget publish,
 * no silent drop. This table is the append-only claim ledger that makes the
 * assistant→IM reply delivery at-least-once with retries and a dead-letter terminal
 * state, mirroring `task_notification_outbox` (L1 migration 20260803000001):
 *
 *   append (idempotent on (session_id, reply_message_id))
 *     → claim (lease + attempts CAS)
 *     → deliver (IMRepository message + WebSocket broadcast)
 *     → delivered | pending+backoff (retry) | dead (after the attempt cap, logged).
 *
 * `reply_message_id` is the terminal assistant SessionMessage id of the settled
 * activity — the natural idempotency key: a steer-coalesced activity yields exactly
 * one terminal assistant message, so re-collection after a crash is a no-op.
 */

import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918120000_im_reply_outbox",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS im_reply_outbox (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          trigger_message_id TEXT,
          reply_message_id TEXT NOT NULL,
          reply_text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
            'pending', 'delivering', 'delivered', 'dead'
          )),
          attempts INTEGER NOT NULL DEFAULT 0,
          available_at INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_expires_at INTEGER,
          last_error TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          time_delivered INTEGER,
          UNIQUE(session_id, reply_message_id)
        )
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS im_reply_outbox_due_idx
          ON im_reply_outbox (status, available_at, lease_expires_at)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
