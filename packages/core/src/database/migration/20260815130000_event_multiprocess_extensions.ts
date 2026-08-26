import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// RISK-006: multi-process extensions for the EventV2 bus.
//
//   1. `deepagent_consumer_group.workspace_id` — durable consumer groups had no tenant field, so a
//      group registry could not express which workspace a group consumes for. Default '' keeps
//      pre-existing (global/unscoped) registrations valid.
//   2. `deepagent_event_delivery.priority` — denormalized event priority so `dueRetries`/`claimDue`
//      can order high-priority work first WITHOUT joining the event table. Nullable: pre-existing
//      rows read as NULL and are treated as "normal" by the ordering.
//   3. `deepagent_rate_limit_bucket` — durable fixed-window buckets for the tryPublish rate gate.
//      Previously the limiter was an in-process Map, so N cooperating processes each enforced their
//      own 1000/min/workspace quota (×N total). The bucket now lives in the shared DB and is
//      updated inside an immediate transaction, so all processes enforce ONE combined quota.
export default {
  id: "20260815130000_event_multiprocess_extensions",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE deepagent_consumer_group ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`)
      yield* tx.run(`ALTER TABLE deepagent_event_delivery ADD COLUMN priority TEXT`)
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS deepagent_rate_limit_bucket (
          workspace_id TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          count INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, window_start)
        )
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS deepagent_consumer_group_workspace_idx
        ON deepagent_consumer_group (workspace_id)
      `)
      // sweepPublishLimiter prunes elapsed windows by window_start alone (cross-workspace).
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS deepagent_rate_limit_bucket_window_idx
        ON deepagent_rate_limit_bucket (window_start)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
