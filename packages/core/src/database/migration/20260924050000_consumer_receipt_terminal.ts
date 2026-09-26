import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// W5 I4: a dead spool row is terminal, so its failure receipt must not remain retryable/pending.
// SQLite cannot widen a CHECK constraint in place. Preserve every historical row while rebuilding;
// the runtime reconciler then backfills missing receipts from durable dead spool rows.
export default {
  id: "20260924050000_consumer_receipt_terminal",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`deepagent_consumer_receipt_terminal\` (
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
          CONSTRAINT \`deepagent_consumer_receipt_status_check\` CHECK(\`status\` IN ('pending', 'done', 'dead')),
          CONSTRAINT \`deepagent_consumer_receipt_attempt_check\` CHECK(\`attempts\` >= 0)
        );
      `)
      yield* tx.run(`
        INSERT INTO \`deepagent_consumer_receipt_terminal\` (
          consumer_kind, source_event_id, status, attempts, last_error, receipt_ref,
          created_at, updated_at, resolved_at
        )
        SELECT receipt.consumer_kind, receipt.source_event_id,
          CASE WHEN receipt.consumer_kind = 'event_consumer_failure' AND receipt.status = 'pending' AND spool.status = 'dead'
            THEN 'dead' ELSE receipt.status END,
          CASE WHEN receipt.consumer_kind = 'event_consumer_failure' AND receipt.status = 'pending' AND spool.status = 'dead'
            THEN spool.attempts ELSE receipt.attempts END,
          CASE WHEN receipt.consumer_kind = 'event_consumer_failure' AND receipt.status = 'pending' AND spool.status = 'dead'
            THEN spool.last_error ELSE receipt.last_error END,
          receipt.receipt_ref, receipt.created_at,
          CASE WHEN receipt.consumer_kind = 'event_consumer_failure' AND receipt.status = 'pending' AND spool.status = 'dead'
            THEN spool.updated_at ELSE receipt.updated_at END,
          CASE WHEN receipt.consumer_kind = 'event_consumer_failure' AND receipt.status = 'pending' AND spool.status = 'dead'
            THEN spool.updated_at ELSE receipt.resolved_at END
        FROM \`deepagent_consumer_receipt\` AS receipt
        LEFT JOIN \`deepagent_event_spool\` AS spool ON spool.event_ref = receipt.source_event_id;
      `)
      yield* tx.run("DROP TABLE `deepagent_consumer_receipt`;")
      yield* tx.run("ALTER TABLE `deepagent_consumer_receipt_terminal` RENAME TO `deepagent_consumer_receipt`;")
      yield* tx.run("CREATE INDEX `deepagent_consumer_receipt_done_idx` ON `deepagent_consumer_receipt` (`consumer_kind`, `status`);")
    })
  },
} satisfies DatabaseMigration.Migration
