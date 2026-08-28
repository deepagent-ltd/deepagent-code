import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ContractDigest } from "../src/contract/digest"
import { SessionProviderRecovery } from "../src/session/runner/recovery"
import type { BaselineEvidence, BaselineFragment } from "../src/session/runner/recovery-store"
import { testEffect } from "./lib/effect"

const it = testEffect(SessionProviderRecovery.layer)

const H64 = (c: string) => c.repeat(64)

const identity = (overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {}): SessionProviderRecovery.AttemptIdentity => ({
  sessionId: "ses_repair",
  attemptId: "att_repair",
  activityId: "act_repair",
  providerTurnSeq: 1,
  selectionId: "sel_1",
  projectionHash: H64("p"),
  requestHash: H64("r"),
  providerId: "provider-test",
  ...overrides,
})

const admin = { type: "administrator" as const, id: "maintainer" }
const user = { type: "user" as const, id: "operator" }
const baselineRef = "baseline:block-42"

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

const repairInput = (
  overrides: Partial<SessionProviderRecovery.RepairBaselineAndAbandonInput> = {},
): SessionProviderRecovery.RepairBaselineAndAbandonInput => {
  const base = validBaseline()
  return {
    actor: admin,
    requestHash: H64("r"),
    attemptIdentity: identity(),
    baselineRef,
    evidence: base.evidence,
    fragments: base.fragments,
    reasonCode: "network_unknown",
    ...overrides,
  }
}

describe("SessionProviderRecovery.repairBaselineAndAbandon (C1B-06)", () => {
  it.effect("repairs the baseline rows and abandons the attempt atomically", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const outcome = yield* service.repairBaselineAndAbandon(repairInput())
      expect(outcome.status).toBe("complete")
      const baseline = yield* service.queryBaseline(baselineRef)
      expect(baseline?.evidence.baselineHash).toBe(validBaseline().baselineHash)
      const abandon = yield* service.queryAbandon(identity())
      expect(abandon).toMatchObject({ decision: "abandoned", terminal: "abandoned" })
    }))

  it.effect("verify-fail leaves no repair and no abandon", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const base = validBaseline()
      const refused = yield* service
        .repairBaselineAndAbandon(repairInput({ evidence: { ...base.evidence, baselineHash: "" } }))
        .pipe(Effect.flip)
      expect(refused).toMatchObject({
        _tag: "SessionProviderRecovery.BaselineVerifyRefusedError",
        reason: "baseline_missing_hash_provenance",
      })
      expect(yield* service.queryBaseline(baselineRef)).toBeUndefined()
      expect(yield* service.queryAbandon(identity())).toBeUndefined()
    }))

  it.effect("CAS-lost legally-different baseline is never clobbered", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const a = validBaseline()
      yield* service.repairBaselineAndAbandon(repairInput())
      // A DIFFERENT provenance/committed set for the same baseline slot. It passes
      // C1B-05 (so repair is attempted) but the CAS sees legally-different data.
      const conflictingFragments: BaselineFragment[] = [
        { ref: "z", content: "gamma", hash: H64("z"), parentHash: "x".repeat(64) },
      ]
      const conflictingHash = ContractDigest.contentDigest({
        fragments: conflictingFragments.map((f) => ({ ref: f.ref, content: f.content })),
      })
      const conflicting: BaselineEvidence = {
        baselineHash: conflictingHash,
        provenance: { source: "snapshot:different", committedAt: 1_800_000_000_000, parentHash: "x".repeat(64) },
      }
      const conflictingInput = repairInput({ evidence: conflicting, fragments: conflictingFragments })
      const outcome = yield* service.repairBaselineAndAbandon(conflictingInput)
      expect(outcome.status).toBe("conflict")
      expect(outcome).toMatchObject({ reason: "repair_conflict" })
      // The legally-different data (a) survives intact.
      expect(yield* service.queryBaseline(baselineRef)).toMatchObject({ evidence: { baselineHash: a.baselineHash } })
    }))

  it.effect("a crash between the repair stage and the abandon stage rolls back both", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const crashed = yield* service
        .repairBaselineAndAbandon(repairInput({ fault: { at: "after_repair_stage" } }))
        .pipe(Effect.flip)
      expect(crashed).toMatchObject({ _tag: "SessionProviderRecovery.RecoveryTransactionAbortedError" })
      // No torn third state: neither the baseline nor the abandon was committed.
      expect(yield* service.queryBaseline(baselineRef)).toBeUndefined()
      expect(yield* service.queryAbandon(identity())).toBeUndefined()
    }))

  it.effect("a double-apply is idempotent (typed existing), no double repair", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const first = yield* service.repairBaselineAndAbandon(repairInput())
      const second = yield* service.repairBaselineAndAbandon(repairInput())
      expect(first.status).toBe("complete")
      expect(second.status).toBe("existing")
      expect(yield* service.queryBaseline(baselineRef)).toBeDefined()
      expect(yield* service.queryAbandon(identity())).toBeDefined()
    }))

  it.effect("a user without the administrator permission is typed-denied with no mutation", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const denied = yield* service.repairBaselineAndAbandon(repairInput({ actor: user })).pipe(Effect.flip)
      expect(denied).toMatchObject({ _tag: "SessionProviderRecovery.PermissionDeniedError" })
      expect(yield* service.queryBaseline(baselineRef)).toBeUndefined()
      expect(yield* service.queryAbandon(identity())).toBeUndefined()
    }))
})
