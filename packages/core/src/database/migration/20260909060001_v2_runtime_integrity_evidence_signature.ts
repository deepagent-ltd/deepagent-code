import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// RI-24 — signatures are an append-only attachment to the receipt-bound
// evidence. Verification happens at the service boundary; this trigger keeps
// a valid signature from being replaced or attached before evidence exists.
export default {
  id: "20260909060001_v2_runtime_integrity_evidence_signature",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE session_v2_provider_turn_receipt ADD COLUMN integrity_evidence_signature TEXT
        CHECK (
          integrity_evidence_signature IS NULL OR (
            json_valid(integrity_evidence_signature) = 1 AND
            json_type(integrity_evidence_signature) = 'object' AND
            json_extract(integrity_evidence_signature, '$.schemaVersion') = 'runtime-integrity-evidence-signature.v1' AND
            json_extract(integrity_evidence_signature, '$.algorithm') = 'ed25519'
          )
        )
      `)
      yield* tx.run(`
        CREATE TRIGGER session_v2_provider_turn_receipt_integrity_evidence_signature_immutable
        BEFORE UPDATE OF integrity_evidence_signature ON session_v2_provider_turn_receipt
        WHEN NOT (
          OLD.integrity_evidence_signature IS NULL
          AND NEW.integrity_evidence_signature IS NOT NULL
          AND OLD.integrity_evidence_hash IS NOT NULL
          AND json_valid(NEW.integrity_evidence_signature) = 1
          AND json_extract(NEW.integrity_evidence_signature, '$.schemaVersion') = 'runtime-integrity-evidence-signature.v1'
          AND json_extract(NEW.integrity_evidence_signature, '$.algorithm') = 'ed25519'
          AND json_extract(NEW.integrity_evidence_signature, '$.evidenceDigest') = OLD.integrity_evidence_hash
        ) AND NOT (
          OLD.integrity_evidence_signature IS NEW.integrity_evidence_signature
        )
        BEGIN
          SELECT RAISE(ABORT, 'runtime integrity evidence signature is immutable');
        END
      `)
    })
  },
} satisfies DatabaseMigration.Migration
