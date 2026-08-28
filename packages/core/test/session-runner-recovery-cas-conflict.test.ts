import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionProviderRecovery } from "../src/session/runner/recovery"
import type { RecoveryEvidence } from "../src/contract/recovery-command"
import { emptyRecoveryStoreState, evidenceOf, scanTerminalEvidence } from "../src/session/runner/recovery-store"
import { testEffect } from "./lib/effect"

const it = testEffect(SessionProviderRecovery.layer)

const H64 = (c: string) => c.repeat(64)

const identity = (overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {}): SessionProviderRecovery.AttemptIdentity => ({
  sessionId: "ses_cas",
  attemptId: "att_cas",
  activityId: "act_cas",
  providerTurnSeq: 2,
  selectionId: "sel_2",
  projectionHash: H64("p"),
  requestHash: H64("r"),
  providerId: "provider-test",
  idempotencyKey: "idem-1",
  ...overrides,
})

const user = { type: "user" as const, id: "operator" }

const evidence = (overrides: Partial<RecoveryEvidence> = {}): RecoveryEvidence => ({
  schemaVersion: "recovery-evidence.v1",
  providerId: "provider-test",
  externalRequestId: "ext-1",
  idempotencyKey: "idem-1",
  terminalState: "settled",
  payloadHash: H64("term"),
  responseFingerprint: H64("r"),
  retrievalRef: "retrieval:1",
  metadata: {},
  verifiedAt: 1000,
  ...overrides,
})

const confirmInput = (overrides: Partial<SessionProviderRecovery.ConfirmSettledInput> = {}) => ({
  actor: user,
  requestHash: H64("r"),
  attemptIdentity: identity(),
  evidence: evidence(),
  ...overrides,
})

const abandonInput = (
  overrides: Partial<SessionProviderRecovery.AbandonExactInput> = {},
): SessionProviderRecovery.AbandonExactInput => ({
  actor: user,
  requestHash: H64("r"),
  attemptIdentity: identity(),
  reasonCode: "network_unknown",
  ...overrides,
})

describe("SessionProviderRecovery CAS-lost / duplicate-terminal (C1B-11)", () => {
  it.effect("confirmSettled surfaces a duplicate terminal as a typed conflict naming the canonical row (never a crash)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      // Two TERMINAL (settled) rows for ONE attempt — the duplicate-terminal anomaly.
      yield* service.evidence.recordStatus({
        evidenceRef: "ev_dup_a",
        status: "settled",
        providerId: "provider-test",
        requestHash: H64("r"),
        payloadHash: H64("p1"),
      })
      yield* service.evidence.recordStatus({
        evidenceRef: "ev_dup_b",
        status: "settled",
        providerId: "provider-test",
        requestHash: H64("r"),
        payloadHash: H64("p2"),
      })
      const conflict = yield* service.confirmSettled(confirmInput()).pipe(Effect.flip)
      expect(conflict).toMatchObject({
        _tag: "SessionProviderRecovery.DuplicateTerminalConflictError",
        requestHash: H64("r"),
        evidenceRef: "ev_dup_a",
        duplicateRef: "ev_dup_b",
      })
      // The attempt was NOT settled — no second terminal row was created.
      expect(yield* service.queryCommand({ requestHash: H64("r"), attemptIdentity: identity() }).pipe(Effect.map((q) => q.evidence.length))).toBe(2)
    }))

  it.effect("abandonExact surfaces a duplicate terminal as a typed conflict, not a crash or an abandon", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* service.evidence.recordStatus({
        evidenceRef: "ev_dup_a",
        status: "settled",
        providerId: "provider-test",
        requestHash: H64("r"),
        payloadHash: H64("p1"),
      })
      yield* service.evidence.recordStatus({
        evidenceRef: "ev_dup_b",
        status: "settled",
        providerId: "provider-test",
        requestHash: H64("r"),
        payloadHash: H64("p2"),
      })
      const conflict = yield* service.abandonExact(abandonInput()).pipe(Effect.flip)
      expect(conflict).toMatchObject({
        _tag: "SessionProviderRecovery.DuplicateTerminalConflictError",
        evidenceRef: "ev_dup_a",
        duplicateRef: "ev_dup_b",
      })
      // Nothing was abandoned.
      expect(yield* service.queryAbandon(identity())).toBeUndefined()
    }))

  it.effect("a second confirm on an already-terminal attempt is an exact no-op (typed existing), never a second row", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* service.evidence.recordStatus({
        evidenceRef: "ev_terminal",
        status: "settled",
        providerId: "provider-test",
        requestHash: H64("r"),
        payloadHash: H64("term"),
      })
      const first = yield* service.confirmSettled(confirmInput())
      expect(first.status).toBe("settled")
      const countAfterFirst = yield* service
        .queryCommand({ requestHash: H64("r"), attemptIdentity: identity() })
        .pipe(Effect.map((q) => q.evidence.filter((e) => e.status === "settled").length))
      const second = yield* service.confirmSettled(confirmInput())
      expect(second.status).toBe("existing")
      expect((second as { evidenceRef: string }).evidenceRef).toBe((first as { evidenceRef: string }).evidenceRef)
      // The idempotent second confirm adds no row (no second terminal row).
      const countAfterSecond = yield* service
        .queryCommand({ requestHash: H64("r"), attemptIdentity: identity() })
        .pipe(Effect.map((q) => q.evidence.filter((e) => e.status === "settled").length))
      expect(countAfterSecond).toBe(countAfterFirst)
    }))

  it.effect("an already-abandoned exact retry is a typed existing, never a second terminal row", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const first = yield* service.abandonExact(abandonInput())
      expect(first.status).toBe("abandoned")
      const second = yield* service.abandonExact(abandonInput())
      expect(second.status).toBe("existing")
      expect((second as { commandId: string }).commandId).toBe((first as { commandId: string }).commandId)
      expect(yield* service.queryAbandon(identity())).toMatchObject({ requestHash: H64("r") })
    }))

  it.effect("evidence.recordStatus converging on the SAME identity is an idempotent no-op (no defect)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* service.evidence.recordStatus({
        evidenceRef: "ev-1",
        status: "settled",
        providerId: "provider-test",
        requestHash: H64("r"),
        payloadHash: H64("term"),
      })
      yield* service.evidence.recordStatus({
        evidenceRef: "ev-1",
        status: "settled",
        providerId: "provider-test",
        requestHash: H64("r"),
        payloadHash: H64("term"),
      })
      expect(yield* service.evidence.getStatus("ev-1")).toMatchObject({
        status: "settled",
        requestHash: H64("r"),
        payloadHash: H64("term"),
      })
    }))

  it.effect("evidence.recordStatus diverging on an existing slot is a typed conflict, never a silent overwrite", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* service.evidence.recordStatus({
        evidenceRef: "ev-1",
        status: "settled",
        providerId: "provider-test",
        requestHash: H64("r"),
        payloadHash: H64("term"),
      })
      const playBack = yield* service.evidence
        .recordStatus({ evidenceRef: "ev-1", status: "pending" })
        .pipe(Effect.flip)
      expect(playBack).toMatchObject({ _tag: "SessionProviderRecovery.MismatchError", reason: "evidence_status_divergence" })
      // The original terminal evidence is intact — no silent downgrade.
      expect(yield* service.evidence.getStatus("ev-1")).toMatchObject({ status: "settled", payloadHash: H64("term") })
    }))

  test("scanTerminalEvidence: none / single / duplicate are deterministic and never a defect", () => {
    const state = emptyRecoveryStoreState()
    expect(scanTerminalEvidence(evidenceOf(state), H64("r"))).toEqual({ status: "none" })
    const single = {
      evidenceRef: "ev-a",
      status: "settled" as const,
      requestHash: H64("r"),
      payloadHash: H64("p1"),
      recordedAt: 1,
    }
    const state1 = { ...state, evidence: new Map([["ev-a", single]]) }
    expect(scanTerminalEvidence(evidenceOf(state1), H64("r"))).toEqual({ status: "single", canonical: single })
    const dup = { ...single, evidenceRef: "ev-b", payloadHash: H64("p2"), recordedAt: 2 }
    const state2 = { ...state, evidence: new Map([["ev-a", single], ["ev-b", dup]]) }
    const scanned = scanTerminalEvidence(evidenceOf(state2), H64("r"))
    expect(scanned.status).toBe("duplicate")
    if (scanned.status === "duplicate") {
      expect(scanned.canonical.evidenceRef).toBe("ev-a")
      expect(scanned.duplicate.evidenceRef).toBe("ev-b")
    }
  })

  it.effect("a duplicate terminal never dies the whole service — subsequent recovery commands still answer", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* service.evidence.recordStatus({
        evidenceRef: "ev_dup_a",
        status: "settled",
        requestHash: H64("r"),
        payloadHash: H64("p1"),
      })
      yield* service.evidence.recordStatus({
        evidenceRef: "ev_dup_b",
        status: "settled",
        requestHash: H64("r"),
        payloadHash: H64("p2"),
      })
      // The typed conflict is returned; the service (and its store) keep serving.
      const conflict = yield* service.confirmSettled(confirmInput()).pipe(Effect.flip)
      expect(conflict).toMatchObject({ _tag: "SessionProviderRecovery.DuplicateTerminalConflictError" })
      // A distinct attempt proceeds normally.
      const other = yield* service.abandonExact(abandonInput({ requestHash: "c".repeat(64) }))
      expect(other.status).toBe("abandoned")
    }))
})
