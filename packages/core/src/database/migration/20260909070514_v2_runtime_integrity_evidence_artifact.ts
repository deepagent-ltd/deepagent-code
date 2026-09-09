import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260909070514_v2_runtime_integrity_evidence_artifact",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`runtime_integrity_evidence_artifact\` (
          \`artifact_id\` text PRIMARY KEY CHECK(length(\`artifact_id\`) = 68 AND substr(\`artifact_id\`, 1, 4) = 'rie_' AND substr(\`artifact_id\`, 5) NOT GLOB '*[^0-9a-f]*'),
          \`receipt_id\` text NOT NULL UNIQUE CHECK(length(trim(\`receipt_id\`)) > 0),
          \`session_id\` text NOT NULL CHECK(length(trim(\`session_id\`)) > 0),
          \`attempt_id\` text NOT NULL CHECK(length(trim(\`attempt_id\`)) > 0),
          \`evidence_hash\` text NOT NULL CHECK(length(\`evidence_hash\`) = 64 AND \`evidence_hash\` NOT GLOB '*[^0-9a-f]*'),
          \`evidence\` text NOT NULL CHECK(json_valid(\`evidence\`) = 1 AND json_type(\`evidence\`) = 'object' AND json_extract(\`evidence\`, '$.schemaVersion') = 'runtime-integrity-evidence.v1'),
          \`signature\` text CHECK(\`signature\` IS NULL OR (json_valid(\`signature\`) = 1 AND json_type(\`signature\`) = 'object' AND json_extract(\`signature\`, '$.schemaVersion') = 'runtime-integrity-evidence-signature.v1' AND json_extract(\`signature\`, '$.algorithm') = 'ed25519' AND json_extract(\`signature\`, '$.evidenceDigest') = \`evidence_hash\`)),
          \`created_at\` integer NOT NULL,
          \`signed_at\` integer CHECK((\`signature\` IS NULL AND \`signed_at\` IS NULL) OR (\`signature\` IS NOT NULL AND \`signed_at\` IS NOT NULL))
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`runtime_integrity_evidence_artifact_hash_idx\` ON \`runtime_integrity_evidence_artifact\` (\`evidence_hash\`);`)
      yield* tx.run(`CREATE INDEX \`runtime_integrity_evidence_artifact_session_idx\` ON \`runtime_integrity_evidence_artifact\` (\`session_id\`,\`created_at\`);`)
      yield* tx.run(`
        CREATE TRIGGER runtime_integrity_evidence_artifact_immutable
        BEFORE UPDATE OF artifact_id, receipt_id, session_id, attempt_id, evidence_hash, evidence, signature, created_at, signed_at
        ON runtime_integrity_evidence_artifact
        WHEN NOT (
          OLD.artifact_id = NEW.artifact_id AND
          OLD.receipt_id = NEW.receipt_id AND
          OLD.session_id = NEW.session_id AND
          OLD.attempt_id = NEW.attempt_id AND
          OLD.evidence_hash = NEW.evidence_hash AND
          OLD.evidence IS NEW.evidence AND
          OLD.created_at = NEW.created_at AND
          OLD.signature IS NULL AND NEW.signature IS NOT NULL AND
          NEW.signed_at IS NOT NULL AND
          json_valid(NEW.signature) = 1 AND
          json_extract(NEW.signature, '$.schemaVersion') = 'runtime-integrity-evidence-signature.v1' AND
          json_extract(NEW.signature, '$.algorithm') = 'ed25519' AND
          json_extract(NEW.signature, '$.evidenceDigest') = NEW.evidence_hash
        ) AND NOT (
          OLD.artifact_id IS NEW.artifact_id AND
          OLD.receipt_id IS NEW.receipt_id AND
          OLD.session_id IS NEW.session_id AND
          OLD.attempt_id IS NEW.attempt_id AND
          OLD.evidence_hash IS NEW.evidence_hash AND
          OLD.evidence IS NEW.evidence AND
          OLD.signature IS NEW.signature AND
          OLD.created_at IS NEW.created_at AND
          OLD.signed_at IS NEW.signed_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'runtime integrity evidence artifact is immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
