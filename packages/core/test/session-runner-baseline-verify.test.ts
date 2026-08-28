import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ContractDigest } from "../src/contract/digest"
import { SessionProviderRecovery } from "../src/session/runner/recovery"
import type { BaselineEvidence, BaselineFragment } from "../src/session/runner/recovery-store"
import { testEffect } from "./lib/effect"

const it = testEffect(SessionProviderRecovery.layer)

const H64 = (c: string) => c.repeat(64)

/** Build a (fragments, evidence) pair whose verifier verdict is `verified`. */
function validBaseline() {
  const rows = [
    { ref: "s1", content: "alpha" },
    { ref: "s2", content: "beta" },
  ]
  const parentRoot = H64("root")
  const fragments: BaselineFragment[] = rows.map((row, i) => ({
    ref: row.ref,
    content: row.content,
    hash: ContractDigest.contentDigest(row),
    parentHash: i === 0 ? parentRoot : ContractDigest.contentDigest(rows[i - 1]!),
  }))
  const baselineHash = ContractDigest.contentDigest({ fragments: fragments.map((f) => ({ ref: f.ref, content: f.content })) })
  const evidence: BaselineEvidence = {
    baselineHash,
    provenance: { source: "snapshot:block-42", committedAt: 1_700_000_000_000, parentHash: parentRoot },
  }
  return { fragments, evidence, baselineHash }
}

describe("SessionProviderRecovery baseline verifier (C1B-05)", () => {
  it.effect("accepts a reconstruction whose recomputed hash exactly matches the committed hash", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const base = validBaseline()
      const verdict = service.verifyBaselineReconstruction({ reconstruction: { fragments: base.fragments }, evidence: base.evidence })
      expect(verdict.status).toBe("verified")
      expect(verdict).toMatchObject({ hash: base.baselineHash })
    }))

  it.effect("refuses a hash mismatch (committed hash !== recomputed hash)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const base = validBaseline()
      const verdict = service.verifyBaselineReconstruction({
        reconstruction: { fragments: base.fragments },
        evidence: { ...base.evidence, baselineHash: H64("other") },
      })
      expect(verdict).toMatchObject({ status: "refused", reason: "hash_mismatch" })
    }))

  it.effect("refuses a reconstruction with no committed hash", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const base = validBaseline()
      const verdict = service.verifyBaselineReconstruction({
        reconstruction: { fragments: base.fragments },
        evidence: { ...base.evidence, baselineHash: "" },
      })
      expect(verdict).toMatchObject({ status: "refused", reason: "baseline_missing_hash_provenance" })
    }))

  it.effect("refuses a broken provenance parent-hash chain (never partially rebuild)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const base = validBaseline()
      // The content hash matches but the chain root is severed.
      const broken = base.fragments.map((f, i) => (i === 0 ? { ...f, parentHash: H64("severed") } : f))
      const verdict = service.verifyBaselineReconstruction({
        reconstruction: { fragments: broken },
        evidence: base.evidence,
      })
      expect(verdict).toMatchObject({ status: "refused", reason: "provenance_chain_broken" })
    }))

  it.effect("refuses a current-state-only reconstruction (no committed hash/provenance) — history is never fabricated", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const base = validBaseline()
      // A "current rows look consistent" reconstruction with NO committed evidence.
      const verdict = service.verifyBaselineReconstruction({ reconstruction: { fragments: base.fragments } })
      expect(verdict).toMatchObject({ status: "refused", reason: "baseline_missing_hash_provenance" })
    }))
})
