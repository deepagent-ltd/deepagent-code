import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Owner authorizations become real Ed25519 signatures: the insert guard now requires a 128-hex
// signature (the previous 64-hex self-digest could be computed by anyone with database write
// access and was not an authorization proof). Rows are immutable, so only the insert guard
// changes; pre-existing 64-hex rows remain stored but can never verify cryptographically.
export default {
  id: "20260824100000_v2_owner_authorization_ed25519_signature",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TRIGGER IF EXISTS session_v2_owner_authorization_insert_guard`)
      yield* tx.run(`
        CREATE TRIGGER session_v2_owner_authorization_insert_guard
        BEFORE INSERT ON session_v2_owner_authorization
        WHEN length(trim(NEW.authorization_id)) = 0
          OR length(trim(NEW.campaign_id)) = 0
          OR length(NEW.subject_commit) != 40
          OR NEW.subject_commit GLOB '*[^0-9a-f]*'
          OR length(NEW.subject_tree) != 40
          OR NEW.subject_tree GLOB '*[^0-9a-f]*'
          OR length(NEW.schema_digest) != 64
          OR NEW.schema_digest GLOB '*[^0-9a-f]*'
          OR length(NEW.build_id) != 64
          OR NEW.build_id GLOB '*[^0-9a-f]*'
          OR length(NEW.package_digest) != 64
          OR NEW.package_digest GLOB '*[^0-9a-f]*'
          OR length(NEW.signature_digest) != 128
          OR NEW.signature_digest GLOB '*[^0-9a-f]*'
          OR length(NEW.authorization_digest) != 64
          OR NEW.authorization_digest GLOB '*[^0-9a-f]*'
          OR NEW.status != 'active'
          OR NEW.valid_from >= NEW.expires_at
          OR NEW.revoked_at IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'invalid v2 owner authorization');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
