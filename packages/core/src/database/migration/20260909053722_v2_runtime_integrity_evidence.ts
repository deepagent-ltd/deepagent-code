import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// RI-24 — the digest-only runtime evidence bundle is retained beside the
// provider receipt. The application computes and validates the content hash;
// SQLite enforces that a bundle can only be attached once, after a terminal
// provider state, and can never be replaced by a later retry.
export default {
  id: "20260909053722_v2_runtime_integrity_evidence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE session_v2_provider_turn_receipt ADD COLUMN integrity_evidence TEXT
        CHECK (
          integrity_evidence IS NULL OR (
            json_valid(integrity_evidence) = 1 AND
            json_type(integrity_evidence) = 'object' AND
            json_extract(integrity_evidence, '$.schemaVersion') = 'runtime-integrity-evidence.v1'
          )
        )
      `)
      yield* tx.run(`
        ALTER TABLE session_v2_provider_turn_receipt ADD COLUMN integrity_evidence_hash TEXT
        CHECK (
          integrity_evidence_hash IS NULL OR (
            length(integrity_evidence_hash) = 64 AND
            integrity_evidence_hash NOT GLOB '*[^0-9a-f]*'
          )
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_turn_receipt_integrity_evidence_immutable
        BEFORE UPDATE OF integrity_evidence, integrity_evidence_hash ON session_v2_provider_turn_receipt
        WHEN NOT (
          OLD.integrity_evidence_hash IS NULL
          AND NEW.integrity_evidence_hash IS NOT NULL
          AND NEW.integrity_evidence IS NOT NULL
          AND OLD.state IN ('settled', 'failed', 'indeterminate_after_crash')
          AND NEW.state = OLD.state
          AND json_valid(NEW.integrity_evidence) = 1
          AND json_type(NEW.integrity_evidence) = 'object'
          AND json_extract(NEW.integrity_evidence, '$.schemaVersion') = 'runtime-integrity-evidence.v1'
        ) AND NOT (
          OLD.integrity_evidence_hash IS NEW.integrity_evidence_hash
          AND OLD.integrity_evidence IS NEW.integrity_evidence
        )
        BEGIN
          SELECT RAISE(ABORT, 'runtime integrity evidence is terminal and immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
