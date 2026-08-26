import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// provider lifecycle gap C: durable per-turn stage evidence.
// One row per (session_id, activity_id), upserted forward-only as a provider turn
// crosses each boundary (claim -> snapshot -> history -> request -> dispatch -> settle).
// It exists so a turn stuck between "legacy activity claimed" and "provider receipt
// created" can be attributed post-hoc; it is observability evidence, NOT an authority.
export default {
  id: "20260820120000_session_turn_stage_evidence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_turn_stage_evidence (
          session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          activity_id TEXT NOT NULL,
          stage       TEXT NOT NULL CHECK (stage IN (
            'activity_claimed',
            'snapshot_started',
            'snapshot_finished',
            'snapshot_degraded',
            'history_loaded',
            'request_prepared',
            'provider_dispatch_started',
            'terminal_settled'
          )),
          details     TEXT,       -- JSON stage attribution (e.g. degraded reason, budget numbers)
          stage_at    INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (session_id, activity_id)
        )
      `)
      yield* tx.run(
        `CREATE INDEX session_turn_stage_evidence_session_idx
           ON session_turn_stage_evidence(session_id, updated_at)`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
