import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
import type { DatabaseMigration } from "../database/migration"

// C5-07 — HIGH/CRITICAL (and throttled-normal) DURABLE SPOOL. Design authority:
// docs/core-v2.0-beta/design.md §8.6 ("high/critical 不丢失，但可以 durable 排队、延迟执行或升级人工，
// 不能无限并发") + §8.4 (priority/backpressure -> durable task admission).
//
// This is the durable queue for work the router SPOOLS rather than admits immediately: high/critical
// events (never merge, never drop) and normal events that exceed their per-consumer rate (throttled —
// NEVER silently dropped). The spool is drained in priority order (critical > high > normal > low) under
// a bounded per-session concurrency cap, with claim/lease + bounded retry + DLQ so a crash resumes the
// drain and an event is never lost (at-least-once).
//
// A separate queue is used rather than riding the C5-06 consumer delivery ledger so this lane does not
// re-invoke or mutate the E3 delivery contract; both are durable at-least-once ledgers with claim/lease
// fencing. Wiring it into the shared migration registry is the main agent's / database hotspot's job.

export type EventSpoolStatus = "pending" | "claimed" | "resolved" | "dead"
export type EventSpoolPriority = "low" | "normal" | "high" | "critical"

/** The durable high/critical + throttled spool. One row per spooled bounded work envelope identity. */
export const DeepAgentEventSpoolTable = sqliteTable("deepagent_event_spool", {
  // The envelope's stable identity (`event://<eventId>`). An envelope is spooled AT MOST ONCE.
  event_ref: text().primaryKey(),
  // The target session (caller's SessionV2.ID) the work drains into.
  session_id: text().notNull(),
  // Byte-stable digest of the bounded work envelope (binds the spooled work, never double-processed).
  envelope_digest: text().notNull(),
  envelope_json: text().notNull(),
  priority: text().$type<EventSpoolPriority>().notNull(),
  status: text().$type<EventSpoolStatus>().notNull(),
  attempts: integer().notNull(),
  claim_token: text(),
  claimant_id: text(),
  claimed_at: integer(),
  lease_expires_at: integer(),
  next_attempt_at: integer(),
  last_error: text(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
})

/**
 * The migration that creates the spool. Defined HERE (the event hotspot) so the spool tests can create
 * it with `DatabaseMigration.applyOnly`. Wiring into the shared migration registry is the main agent's /
 * database hotspot's job (worklist §2).
 */
export const eventSpoolMigration: DatabaseMigration.Migration = {
  id: "20260828220000_deepagent_event_spool",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_event_spool\` (
          \`event_ref\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`envelope_digest\` text NOT NULL,
          \`envelope_json\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`status\` text NOT NULL,
          \`attempts\` integer NOT NULL,
          \`claim_token\` text,
          \`claimant_id\` text,
          \`claimed_at\` integer,
          \`lease_expires_at\` integer,
          \`next_attempt_at\` integer,
          \`last_error\` text,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`deepagent_event_spool_status_check\` CHECK(\`status\` IN ('pending', 'claimed', 'resolved', 'dead')),
          CONSTRAINT \`deepagent_event_spool_priority_check\` CHECK(\`priority\` IN ('low', 'normal', 'high', 'critical')),
          CONSTRAINT \`deepagent_event_spool_digest_check\` CHECK(length(\`envelope_digest\`) = 64),
          CONSTRAINT \`deepagent_event_spool_attempt_check\` CHECK(\`attempts\` >= 0)
        );
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_event_spool_drain_idx\` ON \`deepagent_event_spool\`(\`status\`, \`priority\`, \`created_at\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_event_spool_lease_idx\` ON \`deepagent_event_spool\`(\`status\`, \`lease_expires_at\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_event_spool_session_idx\` ON \`deepagent_event_spool\`(\`session_id\`, \`status\`);
      `)
    })
  },
}
