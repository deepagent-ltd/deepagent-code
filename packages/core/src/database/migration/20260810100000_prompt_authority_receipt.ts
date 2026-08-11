import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260810100000_prompt_authority_receipt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN prompt_epoch INTEGER")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN prompt_window_id TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN effective_history_hash TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN world_state_baseline_hash TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN prompt_cache_key TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN provider_request_hash TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN response_chain_reuse_decision TEXT")
      yield* tx.run("ALTER TABLE session_tool_request_receipt ADD COLUMN response_chain_refusal_reason TEXT")
      yield* tx.run(`
        CREATE INDEX session_tool_request_receipt_prompt_window_idx
        ON session_tool_request_receipt (session_id, prompt_epoch, prompt_window_id)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
