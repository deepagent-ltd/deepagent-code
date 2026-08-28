import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260726073000_context_links",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE context_link_batch (
          batch_id TEXT PRIMARY KEY,
          security_namespace_id TEXT NOT NULL,
          project_scope_key TEXT NOT NULL,
          producer_id TEXT NOT NULL,
          projection_kind TEXT NOT NULL CHECK (projection_kind IN ('code', 'repo_documents')),
          source_snapshot_revision TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('staged', 'active', 'superseded')),
          created_at INTEGER NOT NULL,
          activated_at INTEGER,
          superseded_at INTEGER,
          UNIQUE (security_namespace_id, project_scope_key, producer_id, projection_kind, source_snapshot_revision),
          CHECK (
            (state = 'staged' AND activated_at IS NULL AND superseded_at IS NULL) OR
            (state = 'active' AND activated_at IS NOT NULL AND superseded_at IS NULL) OR
            (state = 'superseded' AND activated_at IS NOT NULL AND superseded_at IS NOT NULL)
          )
        )
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX context_link_batch_active_idx ON context_link_batch(security_namespace_id, project_scope_key, producer_id, projection_kind) WHERE state = 'active'`,
      )
      yield* tx.run(`
        CREATE TRIGGER context_link_batch_legal_update
        BEFORE UPDATE ON context_link_batch
        WHEN NEW.batch_id != OLD.batch_id
          OR NEW.security_namespace_id != OLD.security_namespace_id
          OR NEW.project_scope_key != OLD.project_scope_key
          OR NEW.producer_id != OLD.producer_id
          OR NEW.projection_kind != OLD.projection_kind
          OR NEW.source_snapshot_revision != OLD.source_snapshot_revision
          OR NEW.created_at != OLD.created_at
          OR NOT (
            (OLD.state = 'staged' AND NEW.state = 'active' AND NEW.activated_at IS NOT NULL AND NEW.superseded_at IS NULL) OR
            (OLD.state = 'active' AND NEW.state = 'superseded' AND NEW.activated_at = OLD.activated_at AND NEW.superseded_at IS NOT NULL)
          )
        BEGIN
          SELECT RAISE(ABORT, 'illegal context_link_batch transition');
        END
      `)
      yield* tx.run(`
        CREATE TABLE context_link (
          link_id TEXT PRIMARY KEY,
          security_namespace_id TEXT NOT NULL,
          project_scope_key TEXT NOT NULL,
          access_fingerprint TEXT NOT NULL,
          access_constraints TEXT NOT NULL,
          from_ref_hash TEXT NOT NULL,
          to_ref_hash TEXT NOT NULL,
          from_ref TEXT NOT NULL,
          to_ref TEXT NOT NULL,
          relation TEXT NOT NULL CHECK (relation IN ('references', 'implements', 'validated_by', 'derived_from', 'supports', 'conflicts_with', 'supersedes', 'depends_on', 'produced_by', 'observed_in')),
          evidence_refs TEXT NOT NULL,
          producer_kind TEXT NOT NULL CHECK (producer_kind IN ('projection', 'runner', 'model', 'reviewed_promotion', 'human')),
          producer_id TEXT NOT NULL,
          batch_id TEXT REFERENCES context_link_batch(batch_id) ON DELETE CASCADE,
          source TEXT NOT NULL CHECK (source IN ('parser', 'runner', 'model', 'human')),
          created_by TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('candidate', 'active', 'broken', 'revoked')),
          confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          valid_until INTEGER,
          CHECK ((producer_kind = 'projection' AND batch_id IS NOT NULL AND source = 'parser') OR (producer_kind != 'projection' AND batch_id IS NULL)),
          CHECK ((producer_kind = 'model' AND state IN ('candidate', 'broken', 'revoked')) OR (producer_kind != 'model' AND state IN ('active', 'broken', 'revoked')))
        )
      `)
      yield* tx.run(
        `CREATE INDEX context_link_from_partition_idx ON context_link(security_namespace_id, project_scope_key, from_ref_hash, state)`,
      )
      yield* tx.run(
        `CREATE INDEX context_link_to_partition_idx ON context_link(security_namespace_id, project_scope_key, to_ref_hash, state)`,
      )
      yield* tx.run(
        `CREATE INDEX context_link_access_partition_idx ON context_link(security_namespace_id, project_scope_key, access_fingerprint)`,
      )
      yield* tx.run(`
        CREATE TRIGGER context_link_legal_update
        BEFORE UPDATE ON context_link
        WHEN NEW.link_id != OLD.link_id
          OR NEW.security_namespace_id != OLD.security_namespace_id
          OR NEW.project_scope_key != OLD.project_scope_key
          OR NEW.access_fingerprint != OLD.access_fingerprint
          OR NEW.access_constraints != OLD.access_constraints
          OR NEW.from_ref_hash != OLD.from_ref_hash
          OR NEW.to_ref_hash != OLD.to_ref_hash
          OR NEW.from_ref != OLD.from_ref
          OR NEW.to_ref != OLD.to_ref
          OR NEW.relation != OLD.relation
          OR NEW.evidence_refs != OLD.evidence_refs
          OR NEW.producer_kind != OLD.producer_kind
          OR NEW.producer_id != OLD.producer_id
          OR NEW.batch_id IS NOT OLD.batch_id
          OR NEW.source != OLD.source
          OR NEW.created_by != OLD.created_by
          OR NEW.confidence != OLD.confidence
          OR NEW.created_at != OLD.created_at
          OR NEW.valid_until IS NOT OLD.valid_until
          OR NEW.updated_at <= OLD.updated_at
          OR OLD.state NOT IN ('active', 'candidate')
          OR NEW.state NOT IN ('broken', 'revoked')
        BEGIN
          SELECT RAISE(ABORT, 'illegal context_link transition');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
