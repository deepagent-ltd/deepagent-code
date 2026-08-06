import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806051000_session_prompt_intent",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_intent (
          intent_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
          source TEXT NOT NULL CHECK (source IN ('composer', 'intelligence', 'followup', 'rewrite')),
          state TEXT NOT NULL CHECK (state IN ('preparing', 'admitting', 'admitted', 'canceled', 'superseded', 'failed')),
          selected_variant TEXT CHECK (selected_variant IN ('original', 'rewritten')),
          selected_payload_hash TEXT,
          delivery TEXT CHECK (delivery IN ('turn', 'steer', 'queue', 'goal_steer')),
          admitted_message_id TEXT,
          correlation_id TEXT,
          owner_token TEXT,
          lease_expires_at INTEGER,
          version INTEGER NOT NULL DEFAULT 0,
          time_created INTEGER NOT NULL,
          time_selected INTEGER,
          time_admitted INTEGER,
          time_updated INTEGER NOT NULL,
          UNIQUE (session_id, intent_id)
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_intent_session_state_idx
        ON session_intent (session_id, state, time_created)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
