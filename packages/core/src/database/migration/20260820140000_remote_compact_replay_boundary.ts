import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// A remote compaction blob represents history through one durable Message ID.
// Persist that boundary with the blob so ordinary Responses requests can replay
// only messages created after the compacted prefix, including after a restart.
export default {
  id: "20260820140000_remote_compact_replay_boundary",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE session_compaction_encrypted_content
        ADD COLUMN source_end_message_id TEXT
      `)
    })
  },
} satisfies DatabaseMigration.Migration
