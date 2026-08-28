import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// The original evidence table keyed one row per activity. Rebuild it so each provider turn gets
// an independent forward-only stage row while preserving the legacy row as a synthetic turn.
export default {
  id: "20260821110000_session_turn_stage_evidence_turn_id",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_turn_stage_evidence_turn_id_rebuilt (
          session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          activity_id TEXT NOT NULL,
          turn_id     TEXT NOT NULL,
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
          details     TEXT,
          stage_at    INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (session_id, activity_id, turn_id)
        )
      `)
      // Rows written by the published activity-level schema represent a single historical turn;
      // use activity_id as a deterministic synthetic turn ID during the one-time backfill.
      yield* tx.run(`
        INSERT INTO session_turn_stage_evidence_turn_id_rebuilt (
          session_id, activity_id, turn_id, stage, details, stage_at, updated_at
        )
        SELECT session_id, activity_id, activity_id, stage, details, stage_at, updated_at
        FROM session_turn_stage_evidence
      `)
      yield* tx.run("DROP TABLE session_turn_stage_evidence")
      yield* tx.run("ALTER TABLE session_turn_stage_evidence_turn_id_rebuilt RENAME TO session_turn_stage_evidence")
      yield* tx.run(`
        CREATE INDEX session_turn_stage_evidence_session_idx
        ON session_turn_stage_evidence(session_id, updated_at)
      `)
      yield* tx.run(`
        CREATE INDEX session_turn_stage_evidence_turn_idx
        ON session_turn_stage_evidence(session_id, activity_id, turn_id, updated_at)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
