import { sql } from "drizzle-orm"
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Effect } from "effect"
import type { DatabaseMigration } from "../database/migration"

// C5-04 — V2 admission RECEIPT ledger. Design authority: docs/core-v2.0-beta/design.md §8.4
// ("V2 admission receipt 绑定 envelope hash" — the admission receipt binds the bounded work envelope's
// digest) + §2.3 (exact retry) + §8.5 (each node is a durable SessionV2 work admission).
//
// The admission row is the durable proof that a specific bounded EventWorkEnvelope was admitted as
// V2 durable work. It carries `envelope_digest` (the byte-stable digest of the bounded work envelope,
// NOT of the raw external payload), keyed by the envelope's stable identity (`event_ref`). That key
// gives exact-retry semantics: re-admitting the SAME envelope is a no-op (return the existing row),
// while re-admitting the SAME identity with a DIFFERENT digest is a typed refusal — a programming
// error that must never silently re-admit changed work under the same identity.
//
// This is the durable substrate that sits alongside the outbox (C5-02) and the consumer delivery
// ledger (C5-06). It is a SEPARATE ledger from the consumer delivery ledger because admission is a
// SessionV2-authority concern (which durable work reached the model's session), not a delivery
// concern (which consumer claimed the event). The EventV2 replay-owner claim (AGENTS.md "V2 Session
// Core") and clustered Session-execution ownership stay separate — this table only records the
// session admission receipt.
//
// The table is defined HERE (the event hotspot) so the event layer owns its own schema and its own
// tests can create it with `DatabaseMigration.applyOnly` (same pattern as the outbox + consumer
// ledgers). Wiring it into the shared migration registry is the main agent's / database hotspot's job.

export type EventAdmissionStatus = "admitted" | "resolved" | "refused"

/** Durable admission receipt: one row per admitted bounded work envelope identity. */
export const DeepAgentEventAdmissionTable = sqliteTable("deepagent_event_admission", {
  // The envelope's stable identity (`event://<eventId>`). One admission per envelope identity.
  event_ref: text().primaryKey(),
  // The session the work was admitted to (the caller's SessionV2.ID, stored opaquely).
  session_id: text().notNull(),
  // Byte-stable digest of the BOUNDED work envelope that binds this admission (design §8.4).
  envelope_digest: text().notNull(),
  status: text().$type<EventAdmissionStatus>().notNull(),
  // The durable SessionV2 prompt message id admitted (exact-retry anchor).
  message_id: text(),
  // The bounded work envelope JSON as admitted — the model-facing work is THIS, never the raw payload.
  envelope_json: text().notNull(),
  admitted_at: integer().notNull(),
  updated_at: integer().notNull(),
})

/**
 * The migration that creates the admission receipt ledger. Defined HERE (the event hotspot) so the
 * admission tests can create it with `DatabaseMigration.applyOnly`. Wiring into the shared migration
 * registry is the main agent's / database hotspot's job (worklist §2).
 */
export const eventAdmissionMigration: DatabaseMigration.Migration = {
  id: "20260828210000_deepagent_event_admission",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`deepagent_event_admission\` (
          \`event_ref\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`envelope_digest\` text NOT NULL,
          \`status\` text NOT NULL,
          \`message_id\` text,
          \`envelope_json\` text NOT NULL,
          \`admitted_at\` integer NOT NULL,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`deepagent_event_admission_status_check\` CHECK(\`status\` IN ('admitted', 'resolved', 'refused')),
          CONSTRAINT \`deepagent_event_admission_digest_check\` CHECK(length(\`envelope_digest\`) = 64),
          CONSTRAINT \`deepagent_event_admission_hash_check\` CHECK(\`envelope_digest\` NOT GLOB '*[^0-9a-f]*')
        );
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_event_admission_session_idx\` ON \`deepagent_event_admission\`(\`session_id\`);
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS \`deepagent_event_admission_status_idx\` ON \`deepagent_event_admission\`(\`status\`);
      `)
    })
  },
}
