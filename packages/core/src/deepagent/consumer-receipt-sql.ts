import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
import type { DatabaseMigration } from "../database/migration"

// C5-10 — CONSUMER side-effect receipt ledger. Design authority: docs/core-v2.0-beta/design.md §8.6
// (consumer group delivery ledger: pending/claimed/resolved/dead; pending rows are NEVER swept; retry
// 有界; E3 retry semantics). Whereas the C5-06 consumer ledger tracks DELIVERY of an event to a
// consumer, THIS ledger tracks the consumer's SIDE-EFFECT idempotency: a durable receipt per
// (consumerKind, sourceEventId) proving the consumer's external side effect has run (or is pending).
//
// The receipt is the idempotency authority for a consumer's side effect:
//   - a NEW delivery runs the side effect and records `done` (+ receiptRef);
//   - a REDELIVERY of a completed receipt returns "existing" — the side effect runs exactly ONCE;
//   - a SINK FAILURE leaves the receipt `pending` (retryable) so the E3 delivery retry can resume it;
//   - cold recovery re-reads the durable receipts (no in-memory cache) — a done receipt stays done, so
//     a restart never re-executes a completed side effect.
//
// The `consumer_kind` is the stable identity of the consumer (e.g. "goal_tick", "handoff", "panel",
// "archive", "push"); the `source_event_id` is the source event that drives the side effect. This
// ledger is defined HERE (the event hotspot) via the idempotent migration pattern; wiring it into the
// shared migration registry is the main agent's / database hotspot's job.

export type ConsumerReceiptStatus = "pending" | "done"

export const ConsumerReceiptTable = sqliteTable(
  "deepagent_consumer_receipt",
  {
    consumer_kind: text().notNull(),
    source_event_id: text().notNull(),
    // pending → done. `pending` is a NOT-YET-completed (failed / in-flight) delivery — retryable.
    status: text().$type<ConsumerReceiptStatus>().notNull(),
    // number of times the side effect has been ATTEMPTED (incremented on each run).
    attempts: integer().notNull().default(0),
    last_error: text(),
    // the durable receipt reference of the completed side effect (set once on `done`).
    receipt_ref: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    resolved_at: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.consumer_kind, table.source_event_id] }),
    index("deepagent_consumer_receipt_done_idx").on(table.consumer_kind, table.status),
  ],
)

/** Idempotent migration that creates the consumer side-effect receipt ledger. */
export const consumerReceiptMigration: DatabaseMigration.Migration = {
  id: "20260829020000_deepagent_consumer_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_consumer_receipt\` (
          \`consumer_kind\` text NOT NULL,
          \`source_event_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`attempts\` integer NOT NULL DEFAULT 0,
          \`last_error\` text,
          \`receipt_ref\` text,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          \`resolved_at\` integer,
          CONSTRAINT \`deepagent_consumer_receipt_pk\` PRIMARY KEY(\`consumer_kind\`, \`source_event_id\`),
          CONSTRAINT \`deepagent_consumer_receipt_status_check\` CHECK(\`status\` IN ('pending', 'done')),
          CONSTRAINT \`deepagent_consumer_receipt_attempt_check\` CHECK(\`attempts\` >= 0)
        );
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_consumer_receipt_done_idx\` ON \`deepagent_consumer_receipt\`(\`consumer_kind\`, \`status\`);
      `)
    })
  },
}

export * as ConsumerReceiptSql from "./consumer-receipt-sql"
