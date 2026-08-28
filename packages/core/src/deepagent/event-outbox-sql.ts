import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
import type { DatabaseMigration } from "../database/migration"

// C5-02 — cross-aggregate TRANSACTIONAL OUTBOX. Design authority: docs/core-v2.0-beta/design.md
// §8.3 (transaction + outbox: aggregate state and the event commit in the SAME transaction; a
// cross-aggregate publish must FIRST write a durable outbox row; the outbox publisher uses
// claim/lease + idempotency key; NO best-effort publish after state commit, and NO publish that
// rolls back committed state).
//
// This is the single durable write-ahead ledger for cross-aggregate events. Contract: an event may
// ONLY leave this database through the outbox publisher (enqueue -> claimDue -> dispatch ->
// markPublished/markFailed), so a state/publish crash loses nothing (the row committed atomically
// with the aggregate state) and never ghosts an event (only committed rows are dispatched, and an
// interrupted dispatch is re-claimed after lease expiry and re-dispatched under the same
// idempotency key).

export type EventOutboxStatus = "pending" | "publishing" | "published" | "dead"

/** The durable outbox ledger. One row per enqueued cross-aggregate event. */
export const DeepAgentEventOutboxTable = sqliteTable(
  "deepagent_event_outbox",
  {
    outbox_id: text().primaryKey(),
    event_id: text().notNull(),
    event_type: text().notNull(),
    event_kind: text().$type<"command" | "fact" | "observation">().notNull(),
    aggregate_type: text().notNull(),
    aggregate_id: text().notNull(),
    correlation_id: text().notNull(),
    idempotency_key: text().notNull(),
    // The frozen EventEnvelope JSON (C0-02 contract shape) + its byte-stable digest.
    envelope_json: text().notNull(),
    envelope_digest: text().notNull(),
    status: text().$type<EventOutboxStatus>().notNull(),
    claim_token: text(),
    claimant_id: text(),
    claimed_at: integer(),
    lease_expires_at: integer(),
    attempt_count: integer().notNull(),
    published_at: integer(),
    last_error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("deepagent_event_outbox_idem_idx").on(table.idempotency_key),
    index("deepagent_event_outbox_status_lease_idx").on(table.status, table.lease_expires_at),
    index("deepagent_event_outbox_created_idx").on(table.created_at),
    check("deepagent_event_outbox_kind_check", sql`${table.event_kind} IN ('command', 'fact', 'observation')`),
    check("deepagent_event_outbox_status_check", sql`${table.status} IN ('pending', 'publishing', 'published', 'dead')`),
    check("deepagent_event_outbox_attempt_check", sql`${table.attempt_count} >= 0`),
    check("deepagent_event_outbox_digest_check", sql`length(${table.envelope_digest}) = 64`),
    check("deepagent_event_outbox_hash_check", sql`${table.envelope_digest} NOT GLOB '*[^0-9a-f]*'`),
  ],
)

/**
 * The migration that creates the outbox ledger. It is defined HERE (the event hotspot) so the
 * event layer owns its own schema and its own tests can create it with `DatabaseMigration.applyOnly`.
 * Wiring this into the shared migration registry is the main agent's / database hotspot's job
 * (worklist §2 — `*.sql.ts` tables are the event owner's; `database/migration.gen` is not).
 */
export const eventOutboxMigration: DatabaseMigration.Migration = {
  id: "20260827000000_deepagent_event_outbox",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_event_outbox\` (
          \`outbox_id\` text PRIMARY KEY,
          \`event_id\` text NOT NULL,
          \`event_type\` text NOT NULL,
          \`event_kind\` text NOT NULL,
          \`aggregate_type\` text NOT NULL,
          \`aggregate_id\` text NOT NULL,
          \`correlation_id\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`envelope_json\` text NOT NULL,
          \`envelope_digest\` text NOT NULL,
          \`status\` text NOT NULL,
          \`claim_token\` text,
          \`claimant_id\` text,
          \`claimed_at\` integer,
          \`lease_expires_at\` integer,
          \`attempt_count\` integer NOT NULL,
          \`published_at\` integer,
          \`last_error\` text,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`deepagent_event_outbox_kind_check\` CHECK(\`event_kind\` IN ('command', 'fact', 'observation')),
          CONSTRAINT \`deepagent_event_outbox_status_check\` CHECK(\`status\` IN ('pending', 'publishing', 'published', 'dead')),
          CONSTRAINT \`deepagent_event_outbox_attempt_check\` CHECK(\`attempt_count\` >= 0),
          CONSTRAINT \`deepagent_event_outbox_digest_check\` CHECK(length(\`envelope_digest\`) = 64),
          CONSTRAINT \`deepagent_event_outbox_hash_check\` CHECK(\`envelope_digest\` NOT GLOB '*[^0-9a-f]*')
        );
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS \`deepagent_event_outbox_idem_idx\` ON \`deepagent_event_outbox\`(\`idempotency_key\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_event_outbox_status_lease_idx\` ON \`deepagent_event_outbox\`(\`status\`, \`lease_expires_at\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_event_outbox_created_idx\` ON \`deepagent_event_outbox\`(\`created_at\`);
      `)
    })
  },
}
