import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// W0.7: relax the owner authorization update guard so a signed RENEWAL can extend a migrated
// user database in place. The 20260823090000 migration shipped the strict guard (only
// active→revoked); --renew (packages/deepagent-code/script/mint-owner-campaign.ts) re-signs the
// SAME authorization_id/campaign/identity row with a fresh window, which the strict guard refused.
// This trigger is byte-identical to the relaxed guard the mint script re-creates on databases it
// touches, so a database migrated by the core chain and the mint script must never drift: both
// permit exactly (a) a signed renewal (active→active, window strictly extended, signature and
// authorization digest re-issued, revoked_at stays NULL) and (b) the active→revoked transition
// (everything else identical). The INSERT/DELETE guards are untouched (they are format/append-only
// fences and already match the mint script).
export default {
  id: "20260902100000_v2_owner_authorization_renew_guard",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        DROP TRIGGER IF EXISTS session_v2_owner_authorization_update_guard
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_owner_authorization_update_guard
        BEFORE UPDATE ON session_v2_owner_authorization
        WHEN NEW.authorization_id != OLD.authorization_id
          OR NEW.campaign_id != OLD.campaign_id
          OR NEW.subject_commit != OLD.subject_commit
          OR NEW.subject_tree != OLD.subject_tree
          OR NEW.schema_digest != OLD.schema_digest
          OR NEW.build_id != OLD.build_id
          OR NEW.package_digest != OLD.package_digest
          OR NEW.valid_from != OLD.valid_from
          OR NEW.created_at != OLD.created_at
          OR NOT (
            -- signed renewal: active→active, window strictly extended, signature re-issued
            (OLD.status = 'active' AND NEW.status = 'active'
              AND NEW.expires_at > OLD.expires_at
              AND NEW.revoked_at IS NULL AND OLD.revoked_at IS NULL
              AND NEW.signature_digest != OLD.signature_digest
              AND NEW.authorization_digest != OLD.authorization_digest)
            OR
            -- revocation: active→revoked only, everything else identical
            (OLD.status = 'active' AND NEW.status = 'revoked'
              AND NEW.expires_at = OLD.expires_at
              AND NEW.signature_digest = OLD.signature_digest
              AND NEW.authorization_digest = OLD.authorization_digest
              AND NEW.revoked_at IS NOT NULL)
          )
        BEGIN
          SELECT RAISE(ABORT, 'v2 owner authorization is immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
