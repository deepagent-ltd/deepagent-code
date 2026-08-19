import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// FEAT-007 — attribution column for the active_pack_set snapshot locked at the run entry.
// The receipt table lives outside the core drizzle schema (typed in deepagent-code only), so
// this stays a hand-authored forward-only ALTER, mirroring the released_knowledge_turn_binding
// precedent. NULL is allowed: the federation resolve result does not expose the pack snapshot
// id, so the receipt write site records NULL until it does (never blocks admission).
export default {
  id: "20260816080000_receipt_active_pack_set_attribution",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE session_tool_request_receipt ADD COLUMN context_active_pack_set_snapshot_id TEXT
        CHECK (context_active_pack_set_snapshot_id IS NULL OR context_active_pack_set_snapshot_id LIKE 'pack_snapshot:%')
      `)
      yield* tx.run(`
        CREATE INDEX session_tool_request_receipt_active_pack_set_idx
        ON session_tool_request_receipt (context_active_pack_set_snapshot_id)
        WHERE context_active_pack_set_snapshot_id IS NOT NULL
      `)
    })
  },
} satisfies DatabaseMigration.Migration
