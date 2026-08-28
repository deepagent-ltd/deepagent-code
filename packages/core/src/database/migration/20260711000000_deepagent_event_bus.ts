import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: DeepAgent Event Bus (V4.0 §A)
 *
 * Creates the durable substrate for the event-driven runtime:
 * - deepagent_event: append-only domain-event log. Publish writes here in a
 *   transaction BEFORE any dispatch ("事件先持久化，再分发", §设计原则1). The
 *   idempotency_key UNIQUE index enforces the §A3 幂等 contract at the storage
 *   layer — a re-publish with the same key is a no-op, not a second row.
 * - deepagent_event_delivery: per-(event, subscription group) retry/DLQ tracker.
 *   Kept separate from the immutable log so retry bookkeeping never mutates the
 *   audit record. status pending → delivered | dead; dead rows are the DLQ view.
 *
 * These sit ALONGSIDE the existing EventV2 event/event_sequence tables (the
 * per-aggregate sync substrate). This is the higher-level domain-event bus with
 * retry/DLQ/priority/dedup semantics EventV2 does not model.
 */
export default {
  id: "20260711000000_deepagent_event_bus",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_event\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`type\` text NOT NULL,
          \`source\` text NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`project_id\` text,
          \`actor_id\` text,
          \`correlation_id\` text,
          \`causation_id\` text,
          \`idempotency_key\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`payload\` text,
          \`created_at\` integer NOT NULL
        );
      `)

      // §A3 幂等: storage-enforced dedupe.
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS \`deepagent_event_idempotency_idx\`
        ON \`deepagent_event\` (\`idempotency_key\`);
      `)
      // §A4 去重窗口 + §F2 trace.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_event_type_created_idx\`
        ON \`deepagent_event\` (\`type\`, \`created_at\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_event_correlation_idx\`
        ON \`deepagent_event\` (\`correlation_id\`, \`created_at\`);
      `)
      // §A3 保留期: workspace-scoped retention sweep.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_event_workspace_created_idx\`
        ON \`deepagent_event\` (\`workspace_id\`, \`created_at\`);
      `)

      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_event_delivery\` (
          \`event_id\` text NOT NULL,
          \`subscription_group\` text NOT NULL,
          \`status\` text NOT NULL,
          \`attempts\` integer NOT NULL,
          \`last_error\` text,
          \`next_attempt_at\` integer,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          FOREIGN KEY (\`event_id\`) REFERENCES \`deepagent_event\`(\`id\`) ON DELETE CASCADE
        );
      `)

      // one delivery tracker per (event, group).
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS \`deepagent_event_delivery_unique_idx\`
        ON \`deepagent_event_delivery\` (\`event_id\`, \`subscription_group\`);
      `)
      // retry scan: pending rows whose backoff has elapsed, oldest first.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_event_delivery_due_idx\`
        ON \`deepagent_event_delivery\` (\`status\`, \`next_attempt_at\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
