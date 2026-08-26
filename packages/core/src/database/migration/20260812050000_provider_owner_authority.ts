import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260812050000_provider_owner_authority",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE session_provider_owner_lease (
          owner_token TEXT PRIMARY KEY,
          registered_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          lease_expires_at INTEGER NOT NULL,
          released_at INTEGER,
          CHECK (length(trim(owner_token)) > 0),
          CHECK (registered_at >= 0),
          CHECK (heartbeat_at >= registered_at),
          CHECK (lease_expires_at > heartbeat_at),
          CHECK (released_at IS NULL OR released_at >= registered_at)
        )
      `)
      yield* tx.run(`
        CREATE INDEX session_provider_owner_lease_expiry_idx
        ON session_provider_owner_lease(lease_expires_at, owner_token)
      `)
      yield* tx.run(`
        ALTER TABLE session_provider_attempt
        ADD COLUMN owner_token TEXT REFERENCES session_provider_owner_lease(owner_token)
      `)
      yield* tx.run(`
        CREATE INDEX session_provider_attempt_owner_state_idx
        ON session_provider_attempt(state, owner_token, created_at)
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_owner_lease_legal_update
        BEFORE UPDATE ON session_provider_owner_lease
        WHEN NEW.owner_token != OLD.owner_token
          OR NEW.registered_at != OLD.registered_at
          OR NOT (
            (
              OLD.released_at IS NULL AND NEW.released_at IS NULL
              AND NEW.heartbeat_at >= OLD.heartbeat_at
              AND NEW.heartbeat_at < OLD.lease_expires_at
              AND NEW.lease_expires_at >= OLD.lease_expires_at
              AND NEW.lease_expires_at > NEW.heartbeat_at
            ) OR (
              OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
              AND NEW.heartbeat_at = OLD.heartbeat_at
              AND NEW.lease_expires_at = OLD.lease_expires_at
            )
          )
        BEGIN
          SELECT RAISE(ABORT, 'illegal session_provider_owner_lease update');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_owner_lease_delete_guard
        BEFORE DELETE ON session_provider_owner_lease
        BEGIN
          SELECT RAISE(ABORT, 'session_provider_owner_lease is append only');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_owner_insert_guard
        BEFORE INSERT ON session_provider_attempt
        WHEN NEW.owner_token IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM session_provider_owner_lease owner
            WHERE owner.owner_token = NEW.owner_token
              AND owner.released_at IS NULL
              AND owner.lease_expires_at > NEW.created_at
          )
        BEGIN
          SELECT RAISE(ABORT, 'new provider attempt requires a live exact owner lease');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_provider_attempt_owner_immutable
        BEFORE UPDATE ON session_provider_attempt
        WHEN NEW.owner_token IS NOT OLD.owner_token
        BEGIN
          SELECT RAISE(ABORT, 'provider attempt owner is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_attempt_owner_insert_guard
        BEFORE INSERT ON session_tool_request_receipt
        WHEN NEW.owner_token IS NULL OR
          NOT EXISTS (
            SELECT 1
            FROM session_provider_owner_lease owner
            WHERE owner.owner_token = NEW.owner_token
              AND owner.released_at IS NULL
              AND owner.lease_expires_at > NEW.created_at
          ) OR
          (NEW.provider_attempt_id IS NOT NULL AND NOT EXISTS (
            SELECT 1
            FROM session_provider_attempt attempt
            WHERE attempt.attempt_id = NEW.provider_attempt_id
              AND attempt.session_id = NEW.session_id
              AND attempt.owner_token = NEW.owner_token
          ))
        BEGIN
          SELECT RAISE(ABORT, 'provider receipt requires the attempt live exact owner');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER session_tool_request_receipt_attempt_owner_update_guard
        BEFORE UPDATE ON session_tool_request_receipt
        WHEN NEW.provider_attempt_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM session_provider_attempt attempt
            WHERE attempt.attempt_id = NEW.provider_attempt_id
              AND attempt.owner_token IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM session_provider_attempt attempt
            WHERE attempt.attempt_id = NEW.provider_attempt_id
              AND attempt.session_id = NEW.session_id
              AND attempt.owner_token = NEW.owner_token
          )
        BEGIN
          SELECT RAISE(ABORT, 'provider receipt attempt owner binding mismatch');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
