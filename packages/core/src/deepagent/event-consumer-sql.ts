import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
import type { DatabaseMigration } from "../database/migration"

// C5-06 — CONSUMER durable delivery ledger. Design authority: docs/core-v2.0-beta/design.md §8.6
// (consumer group 在 producer 之前 durable register; claim token/lease fencing; retry 有界; DLQ 不递归;
// retention 不删除 pending delivery).
//
// This is the durable CONSUMER-side substrate that sits alongside the cross-aggregate outbox
// (`deepagent_event_outbox`, C5-02). Unlike the outbox — whose claim/lease belongs to the PUBLISHER
// (enqueue -> claimDue -> dispatch -> markPublished/markFailed) — these tables hold the per-consumer
// delivery state: a durable consumer registration (a consumer is keyed by `consumer_key` + a frozen
// `delivery_contract_version`) and one delivery row per (outbox event, consumer) with its own
// claim/lease, retry counter, DLQ terminal state and retention bookkeeping.
//
// Two tables:
//   1. `deepagent_event_consumer` — durable registration. Idempotent; a re-registration with the SAME
//      contract version refreshes the row, a different version is a typed conflict (fail-closed).
//   2. `deepagent_event_consumer_delivery` — the delivery ledger, keyed by (outbox_id, consumer_key).
//      `status` drives the consumer retry loop: pending -> claimed (in-flight under a lease) ->
//      resolved (acked) | dead (DLQ, terminal). Pending rows are NEVER swept; resolved rows older than
//      the retention window are the ONLY rows a sweep deletes.

export type EventConsumerDeliveryStatus = "pending" | "claimed" | "resolved" | "dead"

/** Durable consumer registration. A consumer is identified by key + delivery contract version. */
export const DeepAgentEventConsumerTable = sqliteTable("deepagent_event_consumer", {
  consumer_key: text().primaryKey(),
  delivery_contract_version: text().notNull(),
  registered_at: integer().notNull(),
  updated_at: integer().notNull(),
})

/** Per-(outbox event, consumer) delivery tracker: claim/lease + retry counter + DLQ/retention state. */
export const DeepAgentEventConsumerDeliveryTable = sqliteTable(
  "deepagent_event_consumer_delivery",
  {
    outbox_id: text().notNull(),
    consumer_key: text().notNull(),
    // pending -> claimed -> resolved | dead. `pending` rows with next_attempt_at <= now (or NULL, a
    // freshly scheduled delivery) are claimable; `claimed` rows with an expired lease are revived.
    status: text().$type<EventConsumerDeliveryStatus>().notNull(),
    // Number of FAILURES recorded so far. Incremented on nack ONLY — a claim does not bump it, so a
    // crash mid-process (claim written, no nack) resumes at the same attempt count (§8.6).
    attempts: integer().notNull(),
    last_error: text(),
    // retry backoff gate: a failed delivery is eligible for re-claim when next_attempt_at <= now.
    next_attempt_at: integer(),
    // consumer claim/lease fencing (mirrors the outbox publisher's claim, see event-outbox-sql.ts).
    claim_token: text(),
    claimant_id: text(),
    claimed_at: integer(),
    lease_expires_at: integer(),
    // set when the delivery is committed (acked) — the retention sweep keys off this.
    resolved_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.outbox_id, table.consumer_key] }),
    // retry/claim scan: which deliveries are due for a consumer.
    index("deepagent_event_cdelivery_due_idx").on(table.consumer_key, table.status, table.next_attempt_at),
    // lease revival scan for a consumer (claim fencing: expired leases re-open the row).
    index("deepagent_event_cdelivery_lease_idx").on(table.consumer_key, table.status, table.lease_expires_at),
    // retention sweep: resolved rows by resolved_at.
    index("deepagent_event_cdelivery_resolved_idx").on(table.resolved_at),
    check(
      "deepagent_event_cdelivery_status_check",
      sql`${table.status} IN ('pending', 'claimed', 'resolved', 'dead')`,
    ),
    check("deepagent_event_cdelivery_attempt_check", sql`${table.attempts} >= 0`),
  ],
)

/**
 * Idempotent migrations that create the consumer delivery substrate. Defined HERE (the event hotspot)
 * so the event layer owns its own schema (same pattern as `eventOutboxMigration`). Wiring these into
 * the shared migration registry is the main agent's / database hotspot's job (worklist §2 — the event
 * owner defines its `*.sql.ts` tables; `database/migration.gen` is not an event-owned hotspot).
 */
export const eventConsumerMigrations: ReadonlyArray<DatabaseMigration.Migration> = [
  {
    id: "20260828090000_deepagent_event_consumer",
    up(tx) {
      return Effect.gen(function* () {
        yield* tx.run(`
          CREATE TABLE IF NOT EXISTS \`deepagent_event_consumer\` (
            \`consumer_key\` text PRIMARY KEY,
            \`delivery_contract_version\` text NOT NULL,
            \`registered_at\` integer NOT NULL,
            \`updated_at\` integer NOT NULL
          );
        `)
      })
    },
  },
  {
    id: "20260828090001_deepagent_event_consumer_delivery",
    up(tx) {
      return Effect.gen(function* () {
        yield* tx.run(`
          CREATE TABLE IF NOT EXISTS \`deepagent_event_consumer_delivery\` (
            \`outbox_id\` text NOT NULL,
            \`consumer_key\` text NOT NULL,
            \`status\` text NOT NULL,
            \`attempts\` integer NOT NULL,
            \`last_error\` text,
            \`next_attempt_at\` integer,
            \`claim_token\` text,
            \`claimant_id\` text,
            \`claimed_at\` integer,
            \`lease_expires_at\` integer,
            \`resolved_at\` integer,
            \`created_at\` integer NOT NULL,
            \`updated_at\` integer NOT NULL,
            CONSTRAINT \`deepagent_event_cdelivery_pk\` PRIMARY KEY(\`outbox_id\`, \`consumer_key\`),
            CONSTRAINT \`deepagent_event_cdelivery_status_check\` CHECK(\`status\` IN ('pending', 'claimed', 'resolved', 'dead')),
            CONSTRAINT \`deepagent_event_cdelivery_attempt_check\` CHECK(\`attempts\` >= 0)
          );
        `)
        yield* tx.run(`
          CREATE INDEX IF NOT EXISTS \`deepagent_event_cdelivery_due_idx\` ON \`deepagent_event_consumer_delivery\`(\`consumer_key\`, \`status\`, \`next_attempt_at\`);
        `)
        yield* tx.run(`
          CREATE INDEX IF NOT EXISTS \`deepagent_event_cdelivery_lease_idx\` ON \`deepagent_event_consumer_delivery\`(\`consumer_key\`, \`status\`, \`lease_expires_at\`);
        `)
        yield* tx.run(`
          CREATE INDEX IF NOT EXISTS \`deepagent_event_cdelivery_resolved_idx\` ON \`deepagent_event_consumer_delivery\`(\`resolved_at\`);
        `)
      })
    },
  },
]
