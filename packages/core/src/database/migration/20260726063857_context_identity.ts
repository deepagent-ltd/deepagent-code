import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726063857_context_identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE context_security_namespace (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('implicit_local', 'workspace')),
          binding_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          retired_at INTEGER,
          UNIQUE (kind, binding_hash)
        )
      `)
      yield* tx.run(`
        CREATE TABLE context_project_scope_identity (
          security_namespace_id TEXT NOT NULL REFERENCES context_security_namespace(id),
          project_scope_key TEXT NOT NULL,
          project_kind TEXT NOT NULL CHECK (project_kind IN ('git', 'registered_root')),
          project_identity_hash TEXT NOT NULL,
          observed_project_id TEXT,
          created_at INTEGER NOT NULL,
          retired_at INTEGER,
          PRIMARY KEY (security_namespace_id, project_scope_key),
          UNIQUE (security_namespace_id, project_identity_hash)
        )
      `)
      yield* tx.run(`
        CREATE TABLE context_project_scope_identity_alias (
          security_namespace_id TEXT NOT NULL REFERENCES context_security_namespace(id),
          old_project_identity_hash TEXT NOT NULL,
          project_scope_key TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (security_namespace_id, old_project_identity_hash),
          FOREIGN KEY (security_namespace_id, project_scope_key)
            REFERENCES context_project_scope_identity(security_namespace_id, project_scope_key)
        )
      `)
      yield* tx.run(`
        CREATE TABLE context_location_identity (
          security_namespace_id TEXT NOT NULL REFERENCES context_security_namespace(id),
          location_key TEXT NOT NULL,
          project_scope_key TEXT NOT NULL,
          workspace_binding TEXT,
          canonical_root TEXT NOT NULL,
          observed_project_id TEXT,
          created_at INTEGER NOT NULL,
          retired_at INTEGER,
          PRIMARY KEY (security_namespace_id, location_key),
          UNIQUE (security_namespace_id, canonical_root),
          FOREIGN KEY (security_namespace_id, project_scope_key)
            REFERENCES context_project_scope_identity(security_namespace_id, project_scope_key)
        )
      `)
      yield* tx.run(`
        CREATE TABLE context_location_identity_alias (
          security_namespace_id TEXT NOT NULL REFERENCES context_security_namespace(id),
          old_canonical_root TEXT NOT NULL,
          location_key TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (security_namespace_id, old_canonical_root),
          FOREIGN KEY (security_namespace_id, location_key)
            REFERENCES context_location_identity(security_namespace_id, location_key)
        )
      `)
      yield* tx.run(`
        CREATE TABLE location_index_coordination (
          security_namespace_id TEXT NOT NULL,
          location_key TEXT NOT NULL,
          index_space_id TEXT NOT NULL,
          projection_kind TEXT NOT NULL CHECK (projection_kind IN ('code', 'repo_documents')),
          index_incarnation INTEGER NOT NULL CHECK (index_incarnation > 0),
          db_locator TEXT NOT NULL,
          owner_id TEXT,
          fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
          expires_at INTEGER,
          replacement_state TEXT NOT NULL CHECK (replacement_state IN ('ready', 'replacing')),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (index_space_id, projection_kind),
          UNIQUE (security_namespace_id, location_key, projection_kind),
          FOREIGN KEY (security_namespace_id, location_key)
            REFERENCES context_location_identity(security_namespace_id, location_key)
        )
      `)
    })
  },
} satisfies DatabaseMigration.Migration
