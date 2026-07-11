import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

/**
 * Migration: DeepAgent Scheduler (V4.0 §A4)
 *
 * Creates `deepagent_schedule` — the DURABLE schedule store. Unlike BackgroundJob
 * (explicitly non-durable, loses live jobs on restart), the V4.0 Scheduler must
 * survive process restarts: a delayed event scheduled before a crash still fires
 * after recovery, and periodic scans resume on cadence. One row per schedule;
 * `kind` distinguishes delay / periodic / condition triggers. The tick loop
 * (deepagent-code) scans due rows and publishes their templated event via the
 * Event Bus.
 */
export default {
  id: "20260711010000_deepagent_scheduler",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_schedule\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`workspace_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`status\` text NOT NULL,
          \`event_template\` text NOT NULL,
          \`fire_at\` integer,
          \`interval_ms\` integer,
          \`condition\` text,
          \`last_fired_at\` integer,
          \`created_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL
        );
      `)

      // tick scan: active schedules whose next fire/check time has elapsed, oldest first.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_schedule_due_idx\`
        ON \`deepagent_schedule\` (\`status\`, \`fire_at\`);
      `)
      // per-workspace listing + retention.
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_schedule_workspace_idx\`
        ON \`deepagent_schedule\` (\`workspace_id\`, \`status\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
