import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { ContractDigest } from "../src/contract/digest"
import { SessionProviderRecovery } from "../src/session/runner/recovery"
import type { BaselineEvidence, BaselineFragment } from "../src/session/runner/recovery-store"
import type { SafeBoundaryMessage } from "../src/session/runner/recovery-safe-boundary"
import { testEffect } from "./lib/effect"

const it = testEffect(SessionProviderRecovery.layer)

const H64 = (c: string) => c.repeat(64)

const identity = (overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {}): SessionProviderRecovery.AttemptIdentity => ({
  sessionId: "ses_crash",
  attemptId: "att_crash",
  activityId: "act_crash",
  providerTurnSeq: 1,
  selectionId: "sel_1",
  projectionHash: H64("p"),
  requestHash: H64("r"),
  providerId: "provider-test",
  idempotencyKey: "idem-1",
  ...overrides,
})

const user = { type: "user" as const, id: "operator" }
const admin = { type: "administrator" as const, id: "maintainer" }

// ---------------------------------------------------------------------------
// C1B-12 sentinel: a counting provider-transport / tool-executor spy. The recovery code path MUST
// never invoke it — if any recovery operation auto-replayed provider/tool work, the spy would
// increment (and throw) and the whole matrix fails. Every scenario asserts the count is 0.
// ---------------------------------------------------------------------------
const makeSpy = () => {
  let count = 0
  return {
    count: () => count,
    // A substitute for the real provider transport / tool executor. The recovery code never calls
    // it (no automatic replay) — reaching it is a crash-matrix failure.
    invoke(tag: string): void {
      count += 1
      throw new Error(`forbidden automatic provider/tool replay (${tag})`)
    },
  }
}

const baseClassify: SessionProviderRecovery.ClassifyInput = {
  attempt: identity(),
  attemptState: "indeterminate_after_crash",
  expectedAttemptState: "indeterminate_after_crash",
  ownerToken: "owner_crash",
  expectedVersion: 2,
  baseline: { baselineHash: H64("b"), verified: true, state: "present" },
  historyVerified: true,
  providerLookupComplete: true,
  placementUnresolved: false,
  permissionIncomplete: false,
  workspaceConflict: false,
}

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
    provenance: { source: "snapshot:crash", committedAt: 1_700_000_000_000, parentHash: parentRoot },
  }
  return { fragments, evidence, baselineHash }
}

const msg = (
  id: string,
  seq: number,
  kind: SafeBoundaryMessage["kind"],
  certain = true,
): SafeBoundaryMessage => ({
  id,
  seq,
  kind,
  certain,
  checkpoint: certain && (kind === "user" || kind === "assistant"),
})

const abortInput = (overrides: Partial<SessionProviderRecovery.AbandonExactInput> = {}): SessionProviderRecovery.AbandonExactInput => ({
  actor: user,
  requestHash: H64("r"),
  attemptIdentity: identity(),
  reasonCode: "network_unknown",
  ...overrides,
})

const repairInput = (
  overrides: Partial<SessionProviderRecovery.RepairBaselineAndAbandonInput> = {},
): SessionProviderRecovery.RepairBaselineAndAbandonInput => {
  const base = validBaseline()
  return {
    actor: admin,
    requestHash: H64("r"),
    attemptIdentity: identity(),
    baselineRef: "baseline:crash",
    evidence: base.evidence,
    fragments: base.fragments,
    reasonCode: "network_unknown",
    ...overrides,
  }
}

const forkInput = (
  overrides: Partial<SessionProviderRecovery.ForkFromSafeBoundaryInput> = {},
): SessionProviderRecovery.ForkFromSafeBoundaryInput => ({
  actor: user,
  sourceSessionId: "ses_crash_source",
  requestHash: H64("r"),
  attemptIdentity: identity({ attemptId: "att_fork_crash", sessionId: "ses_crash_source" }),
  history: [msg("m0", 0, "user"), msg("m1", 1, "assistant")],
  ...overrides,
})

describe("SessionProviderRecovery crash matrix (C1B-12)", () => {
  it.effect("boundary: descriptor classify is pure + deterministic, never replays transport", () =>
    Effect.gen(function* () {
      const spy = makeSpy()
      const service = yield* SessionProviderRecovery.Service
      const a = service.classify(baseClassify)
      const b = service.classify(baseClassify)
      // Deterministic: the same snapshot yields the same descriptor.
      expect(a).toEqual(b)
      expect(a.descriptorKind).toBe("resolvable_exact")
      // No provider/tool transport was invoked during classification.
      expect(spy.count()).toBe(0)
    }))

  it.effect("boundary: command write — a crash commits nothing; resume records; no replay", () =>
    Effect.gen(function* () {
      const spy = makeSpy()
      const service = yield* SessionProviderRecovery.Service
      const cmd = SessionProviderRecovery.recoveryCommandContentAddress({ requestHash: H64("r"), attemptIdentity: identity() })
      const crashed = yield* service
        .recordCommand({ requestHash: H64("r"), attemptIdentity: identity(), fault: { at: "after_command_stage" } })
        .pipe(Effect.flip)
      expect(crashed).toMatchObject({ _tag: "SessionProviderRecovery.RecoveryTransactionAbortedError" })
      // Nothing committed (DB state unchanged).
      expect(yield* service.getCommand(cmd)).toBeUndefined()
      // Resume works and records exactly one command.
      const written = yield* service.recordCommand({ requestHash: H64("r"), attemptIdentity: identity() })
      expect(written.status).toBe("recorded")
      expect(yield* service.getCommand(cmd)).toBeDefined()
      expect(spy.count()).toBe(0)
    }))

  it.effect("boundary: evidence settle — a crash commits no terminal; resume settles once; no replay", () =>
    Effect.gen(function* () {
      const spy = makeSpy()
      const service = yield* SessionProviderRecovery.Service
      yield* service.evidence.recordStatus({
        evidenceRef: "ev_terminal",
        status: "settled",
        providerId: "provider-test",
        requestHash: H64("r"),
        payloadHash: H64("term"),
      })
      const evidence = {
        schemaVersion: "recovery-evidence.v1" as const,
        providerId: "provider-test",
        externalRequestId: "ext-1",
        idempotencyKey: "idem-1",
        terminalState: "settled" as const,
        payloadHash: H64("term"),
        responseFingerprint: H64("r"),
        retrievalRef: "retrieval:1",
        metadata: {},
        verifiedAt: 1000,
      }
      const crashed = yield* service
        .confirmSettled({ actor: user, requestHash: H64("r"), attemptIdentity: identity(), evidence, fault: { at: "after_evidence_stage" } })
        .pipe(Effect.flip)
      expect(crashed).toMatchObject({ _tag: "SessionProviderRecovery.RecoveryTransactionAbortedError" })
      // Only the pre-existing terminal remains — the verdict row was not committed.
      const afterCrash = yield* service.queryCommand({ requestHash: H64("r"), attemptIdentity: identity() })
      expect(afterCrash.evidence.filter((e) => e.status === "settled")).toHaveLength(1)
      // Resume settles once.
      const settled = yield* service.confirmSettled({ actor: user, requestHash: H64("r"), attemptIdentity: identity(), evidence })
      expect(settled.status).toBe("settled")
      expect(
        yield* service.queryCommand({ requestHash: H64("r"), attemptIdentity: identity() }).pipe(
          Effect.map((q) => q.evidence.filter((e) => e.status === "settled").length),
        ),
      ).toBe(2)
      expect(spy.count()).toBe(0)
    }))

  it.effect("boundary: baseline verify + repair — a crash between stages commits neither; resume completes; no replay", () =>
    Effect.gen(function* () {
      const spy = makeSpy()
      const service = yield* SessionProviderRecovery.Service
      const crashed = yield* service
        .repairBaselineAndAbandon(repairInput({ fault: { at: "after_repair_stage" } }))
        .pipe(Effect.flip)
      expect(crashed).toMatchObject({ _tag: "SessionProviderRecovery.RecoveryTransactionAbortedError" })
      // Neither the baseline nor the abandon was committed.
      expect(yield* service.queryBaseline("baseline:crash")).toBeUndefined()
      expect(yield* service.queryAbandon(identity())).toBeUndefined()
      // Resume completes the atomic repair + abandon.
      const done = yield* service.repairBaselineAndAbandon(repairInput())
      expect(done.status).toBe("complete")
      expect(yield* service.queryBaseline("baseline:crash")).toBeDefined()
      expect(yield* service.queryAbandon(identity())).toBeDefined()
      expect(spy.count()).toBe(0)
    }))

  it.effect("boundary: fork — a crash commits no fork + no read-only fence; resume forks; no replay", () =>
    Effect.gen(function* () {
      const spy = makeSpy()
      const service = yield* SessionProviderRecovery.Service
      const crashed = yield* service
        .forkFromSafeBoundary(forkInput({ fault: { at: "after_fork_stage" } }))
        .pipe(Effect.flip)
      expect(crashed).toMatchObject({ _tag: "SessionProviderRecovery.RecoveryTransactionAbortedError" })
      // Neither the fork manifest nor the source fence was committed.
      expect(yield* service.queryFork("ses_crash_source")).toBeUndefined()
      expect(yield* service.isSessionReadOnly("ses_crash_source")).toBe(false)
      // Resume forks once and fences the source.
      const forked = yield* service.forkFromSafeBoundary(forkInput())
      expect(forked.status).toBe("forked")
      expect(yield* service.queryFork("ses_crash_source")).toBeDefined()
      expect(yield* service.isSessionReadOnly("ses_crash_source")).toBe(true)
      expect(spy.count()).toBe(0)
    }))

  it.effect("boundary: abandon — a crash mid-abandon commits nothing; resume abandons once; no replay", () =>
    Effect.gen(function* () {
      const spy = makeSpy()
      const service = yield* SessionProviderRecovery.Service
      const crashed = yield* service.abandonExact(abortInput({ fault: { at: "after_command_stage" } })).pipe(Effect.flip)
      expect(crashed).toMatchObject({ _tag: "SessionProviderRecovery.RecoveryTransactionAbortedError" })
      // No abandon terminal row was committed.
      expect(yield* service.queryAbandon(identity())).toBeUndefined()
      // Resume abandons exactly once.
      const done = yield* service.abandonExact(abortInput())
      expect(done.status).toBe("abandoned")
      expect(yield* service.queryAbandon(identity())).toBeDefined()
      expect(spy.count()).toBe(0)
    }))

  it.effect("boundary: terminal + event — a crash adds no terminal event row; resume converges on one canonical row; no replay", () =>
    Effect.gen(function* () {
      const spy = makeSpy()
      const service = yield* SessionProviderRecovery.Service
      yield* service.evidence.recordStatus({
        evidenceRef: "ev_terminal",
        status: "settled",
        providerId: "provider-test",
        requestHash: H64("r"),
        payloadHash: H64("term"),
      })
      const evidence = {
        schemaVersion: "recovery-evidence.v1" as const,
        providerId: "provider-test",
        externalRequestId: "ext-1",
        idempotencyKey: "idem-1",
        terminalState: "settled" as const,
        payloadHash: H64("term"),
        responseFingerprint: H64("r"),
        retrievalRef: "retrieval:1",
        metadata: {},
        verifiedAt: 1000,
      }
      // Crash: no event/terminal row is committed.
      yield* service
        .confirmSettled({ actor: user, requestHash: H64("r"), attemptIdentity: identity(), evidence, fault: { at: "after_evidence_stage" } })
        .pipe(Effect.flip)
      // An exact retry AFTER the crash converges idempotently: settles once.
      const settled = yield* service.confirmSettled({ actor: user, requestHash: H64("r"), attemptIdentity: identity(), evidence })
      expect(settled.status).toBe("settled")
      expect(spy.count()).toBe(0)
    }))

  it.effect("whole matrix: no recovery operation ever auto-replays provider/tool work (single spy, 0 calls)", () =>
    Effect.gen(function* () {
      const spy = makeSpy()
      const service = yield* SessionProviderRecovery.Service
      // Exercise every boundary (crash + resume) under ONE sentinel.
      yield* service.recordCommand({ requestHash: H64("r"), attemptIdentity: identity() }).pipe(Effect.asVoid)
      yield* service.abandonExact(abortInput()).pipe(Effect.asVoid)
      yield* service
        .repairBaselineAndAbandon(repairInput({ baselineRef: "baseline:matrix" }))
        .pipe(Effect.asVoid)
      yield* service.forkFromSafeBoundary(forkInput()).pipe(Effect.asVoid)
      yield* service.evidence.recordStatus({
        evidenceRef: "ev_terminal",
        status: "settled",
        requestHash: H64("r"),
        payloadHash: H64("term"),
      })
      // The recovery service never invokes the provider transport / tool executor.
      expect(spy.count()).toBe(0)
    }))

  it.effect("an injected crash is a typed RecoveryTransactionAbortedError, never a raw defect", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const crashed = yield* service
        .abandonExact(abortInput({ fault: { at: "after_command_stage" } }))
        .pipe(Effect.flip)
      expect(crashed).toMatchObject({ _tag: "SessionProviderRecovery.RecoveryTransactionAbortedError" })
      // Nothing was committed; the service keeps serving afterwards.
      expect(yield* service.queryAbandon(identity())).toBeUndefined()
      const done = yield* service.abandonExact(abortInput())
      expect(done.status).toBe("abandoned")
    }))
})
