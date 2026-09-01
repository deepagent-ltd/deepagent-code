import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// W2 — durable C1B recovery surfaces (design §W2 "恢复持久化").
//
// Three tables back the recovery descriptor / command / evidence-export objects so a
// kill-9 restart re-derives the same recovery inventory from the same rows:
//   - session_provider_recovery_descriptor: one row per five-class descriptor
//     (content-addressed by the descriptor digest; append-only, idempotent on retry);
//   - recovery_command: one row per content-addressed command in the single-writer
//     attempt slot (state text + expected owner token + result hash for the CAS);
//   - recovery_evidence_export: one row per evidence export (manifest hash + state).
//
// The Drizzle schema (`recovery-store.sql.ts`) is aligned through the generated
// `schema-checkpoint` migration so drizzle-kit stays in sync without re-emitting DDL.

const migrationID = "20260830000000_session_provider_recovery"

export default {
  id: migrationID,
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_provider_recovery_descriptor (
          descriptor_id text PRIMARY KEY,
          session_id text NOT NULL,
          activity_id text NOT NULL,
          turn_id text NOT NULL,
          kind text NOT NULL,
          payload text NOT NULL,
          content_hash text NOT NULL,
          created_at integer NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_provider_recovery_descriptor_session_idx
        ON session_provider_recovery_descriptor (session_id, created_at)
      `)
      yield* tx.run(`
        CREATE INDEX session_provider_recovery_descriptor_attempt_idx
        ON session_provider_recovery_descriptor (session_id, activity_id, turn_id)
      `)
      yield* tx.run(`
        CREATE TABLE recovery_command (
          command_id text PRIMARY KEY,
          descriptor_id text
            REFERENCES session_provider_recovery_descriptor (descriptor_id) ON DELETE CASCADE,
          attempt text NOT NULL,
          state text NOT NULL,
          expected_owner_token text,
          result_hash text,
          actor_type text,
          actor_id text,
          created_at integer NOT NULL,
          updated_at integer NOT NULL
        )
      `)
      yield* tx.run(`
        CREATE TABLE recovery_evidence_export (
          export_id text PRIMARY KEY,
          descriptor_id text
            REFERENCES session_provider_recovery_descriptor (descriptor_id) ON DELETE SET NULL,
          manifest_hash text NOT NULL,
          state text NOT NULL,
          created_at integer NOT NULL,
          payload text NOT NULL
        )
      `)
    })
  },
} satisfies DatabaseMigration.Migration
