import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// RISK-001: claim/lease columns for durable event retry delivery. `dueRetries()` was an unlocked
// global scan — two processes (Desktop + CLI daemon, or an upgrade overlap) could pick up the same
// pending row and execute its side effects twice. A claimant now atomically stamps a token + lease;
// rows whose lease expired become eligible for re-claim. Nullable so pre-existing rows stay valid.
export default {
  id: "20260815120000_event_delivery_claim_lease",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE deepagent_event_delivery ADD COLUMN claim_token TEXT`)
      yield* tx.run(`ALTER TABLE deepagent_event_delivery ADD COLUMN claimant_id TEXT`)
      yield* tx.run(`ALTER TABLE deepagent_event_delivery ADD COLUMN claimed_at INTEGER`)
      yield* tx.run(`ALTER TABLE deepagent_event_delivery ADD COLUMN lease_expires_at INTEGER`)
      yield* tx.run(`
        CREATE INDEX deepagent_event_delivery_claim_idx
        ON deepagent_event_delivery (subscription_group, status, next_attempt_at)
      `)
    })
  },
} satisfies DatabaseMigration.Migration
