import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810170000_part_integrity_backfill",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS session_part_integrity_quarantine (
          part_id TEXT NOT NULL PRIMARY KEY,
          message_id TEXT NOT NULL,
          part_session_id TEXT NOT NULL,
          message_session_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL
        )
      `)
      const now = Date.now()
      yield* tx.run(`
        INSERT OR IGNORE INTO session_part_integrity_quarantine
          (part_id, message_id, part_session_id, message_session_id, reason, quarantined_at)
        SELECT part.id, part.message_id, part.session_id, message.session_id,
               'part_parent_cross_session', ${now}
        FROM part
        JOIN message ON message.id = part.message_id
        WHERE part.session_id IS NOT message.session_id
      `)
      yield* tx.run(`
        UPDATE session_prompt_epoch
        SET authority_state = 'recovery_required',
            recovery_reason = 'legacy cross-session Part rows quarantined'
        WHERE state = 'active'
          AND session_id IN (
            SELECT part_session_id FROM session_part_integrity_quarantine
            UNION
            SELECT message_session_id FROM session_part_integrity_quarantine
          )
      `)
      yield* tx.run(`
        INSERT OR IGNORE INTO session_history_state
          (session_id, state, reason, time_created, time_updated)
        SELECT affected.session_id, 'recovery_required',
               'legacy cross-session Part rows quarantined', ${now}, ${now}
        FROM (
          SELECT part_session_id AS session_id FROM session_part_integrity_quarantine
          UNION
          SELECT message_session_id AS session_id FROM session_part_integrity_quarantine
        ) affected
        JOIN session ON session.id = affected.session_id
      `)
      yield* tx.run(`
        UPDATE session_history_state
        SET state = 'recovery_required',
            reason = 'legacy cross-session Part rows quarantined',
            time_updated = ${now}
        WHERE session_id IN (
          SELECT part_session_id FROM session_part_integrity_quarantine
          UNION
          SELECT message_session_id FROM session_part_integrity_quarantine
        )
      `)
    })
  },
} satisfies DatabaseMigration.Migration
