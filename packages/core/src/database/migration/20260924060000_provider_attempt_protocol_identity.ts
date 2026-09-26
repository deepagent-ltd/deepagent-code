import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// C2-04/O-W8-1: bind the resolved route before the prepared turn is sealed. Historical attempts
// remain NULL and cannot be silently adopted as a newly bound V2 exact retry.
export default {
  id: "20260924060000_provider_attempt_protocol_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE session_provider_attempt ADD COLUMN protocol_attempt_identity_hash TEXT
        CHECK (protocol_attempt_identity_hash IS NULL OR (
          length(protocol_attempt_identity_hash) = 64 AND
          protocol_attempt_identity_hash NOT GLOB '*[^0-9a-f]*'
        ));
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_protocol_identity_immutable
        BEFORE UPDATE OF protocol_attempt_identity_hash ON session_provider_attempt
        WHEN NEW.protocol_attempt_identity_hash IS NOT OLD.protocol_attempt_identity_hash
        BEGIN
          SELECT RAISE(ABORT, 'session_provider_attempt protocol identity is immutable');
        END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
