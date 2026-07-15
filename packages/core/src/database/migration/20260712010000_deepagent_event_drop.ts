import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: DeepAgent event-drop log (§A4 event_dropped as a persisted metric)
 *
 * Creates `deepagent_event_drop`, an append-only audit log of events the §A4 router SHED under
 * backpressure. Until now a drop was LOG-ONLY (event-dispatcher.ts) — unqueryable, unlike the DLQ which
 * is real SQL. This table lets Observability aggregate `event_dropped_total` (by reason) exactly the way
 * it aggregates `dlq_events_total` (by dead delivery).
 *
 * DESIGN: no FK to `deepagent_event` — a drop is an audit COUNTER that must survive the retention sweep
 * of the event it references (the count is the signal). Workspace-scoped index for the windowed metric.
 */
export default {
  id: "20260712010000_deepagent_event_drop",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_event_drop\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
          \`event_id\` text NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`created_at\` integer NOT NULL
        );
      `)
      // §F1 event_dropped_total: workspace-scoped, windowed aggregation.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_event_drop_workspace_created_idx\`
        ON \`deepagent_event_drop\` (\`workspace_id\`, \`created_at\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
