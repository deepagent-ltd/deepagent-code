import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260823090000_v2_owner_authorization",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS session_v2_owner_authorization (
          authorization_id TEXT PRIMARY KEY NOT NULL,
          campaign_id TEXT NOT NULL,
          subject_commit TEXT NOT NULL,
          subject_tree TEXT NOT NULL,
          schema_digest TEXT NOT NULL,
          build_id TEXT NOT NULL,
          package_digest TEXT NOT NULL,
          valid_from INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          signature_digest TEXT NOT NULL,
          authorization_digest TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          revoked_at INTEGER
        )
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS session_v2_owner_authorization_campaign_idx
        ON session_v2_owner_authorization (campaign_id)
      `)
      yield* tx.run(`
        CREATE INDEX IF NOT EXISTS session_v2_owner_authorization_active_idx
        ON session_v2_owner_authorization (status, expires_at, campaign_id)
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_v2_owner_authorization_insert_guard
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
          OR length(NEW.signature_digest) != 64
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
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_v2_owner_authorization_update_guard
        BEFORE UPDATE ON session_v2_owner_authorization
        WHEN NEW.authorization_id != OLD.authorization_id
          OR NEW.campaign_id != OLD.campaign_id
          OR NEW.subject_commit != OLD.subject_commit
          OR NEW.subject_tree != OLD.subject_tree
          OR NEW.schema_digest != OLD.schema_digest
          OR NEW.build_id != OLD.build_id
          OR NEW.package_digest != OLD.package_digest
          OR NEW.valid_from != OLD.valid_from
          OR NEW.expires_at != OLD.expires_at
          OR NEW.signature_digest != OLD.signature_digest
          OR NEW.authorization_digest != OLD.authorization_digest
          OR NEW.created_at != OLD.created_at
          OR NOT (OLD.status = 'active' AND NEW.status = 'revoked')
          OR NEW.revoked_at IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'v2 owner authorization is immutable');
        END
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS session_v2_owner_authorization_delete_guard
        BEFORE DELETE ON session_v2_owner_authorization
        BEGIN
          SELECT RAISE(ABORT, 'v2 owner authorization is append only');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
