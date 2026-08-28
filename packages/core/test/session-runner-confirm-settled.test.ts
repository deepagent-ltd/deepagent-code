import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SessionProviderRecovery } from "../src/session/runner/recovery"
import type { RecoveryEvidence } from "../src/contract/recovery-command"
import { testEffect } from "./lib/effect"

const it = testEffect(SessionProviderRecovery.layer)

const H64 = (c: string) => c.repeat(64)

const identity = (overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {}): SessionProviderRecovery.AttemptIdentity => ({
  sessionId: "ses_confirm",
  attemptId: "att_confirm",
  activityId: "act_confirm",
  providerTurnSeq: 2,
  selectionId: "sel_2",
  projectionHash: H64("p"),
  requestHash: H64("r"),
  providerId: "provider-test",
  idempotencyKey: "idem-1",
  ...overrides,
})

const user = { type: "user" as const, id: "operator" }

// A valid frozen RecoveryEvidence, all hash-addressed / typed (no free-text body).
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

const confirmInput = (overrides: Partial<SessionProviderRecovery.ConfirmSettledInput> = {}): SessionProviderRecovery.ConfirmSettledInput => ({
  actor: user,
  requestHash: H64("r"),
  attemptIdentity: identity(),
  evidence: evidence(),
  ...overrides,
})

// Record the terminal receipt payload hash for the attempt (the "terminal row").
const recordTerminal = (
  service: SessionProviderRecovery.Interface,
  requestHash = H64("r"),
  payloadHash = H64("term"),
) =>
  service.evidence.recordStatus({
    evidenceRef: "ev_terminal",
    status: "settled",
    providerId: "provider-test",
    requestHash,
    payloadHash,
  })

describe("SessionProviderRecovery.confirmSettled (C1B-08)", () => {
  it.effect("all three facts match (request hash + idempotency + terminal payload) -> settled", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* recordTerminal(service)
      const outcome = yield* service.confirmSettled(confirmInput())
      expect(outcome.status).toBe("settled")
      // The verdict persists in the evidence store as a typed settled record.
      const stored = yield* service.evidence.getStatus((outcome as { evidenceRef: string }).evidenceRef)
      expect(stored).toMatchObject({ status: "settled", requestHash: H64("r"), payloadHash: H64("term") })
    }))

  it.effect("free text alone is refused (typed, no mutation)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* recordTerminal(service)
      const denied = yield* service
        .confirmSettled(confirmInput({ evidence: { note: "trust me" } }))
        .pipe(Effect.flip)
      expect(denied).toMatchObject({ _tag: "SessionProviderRecovery.TextIsNotEvidenceError", reason: "text_is_not_evidence" })
    }))

  it.effect("a non-matching request hash is refused", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* recordTerminal(service)
      const denied = yield* service
        .confirmSettled(confirmInput({ evidence: evidence({ responseFingerprint: "a".repeat(64) }) }))
        .pipe(Effect.flip)
      expect(denied).toMatchObject({
        _tag: "SessionProviderRecovery.EvidenceBindingError",
        reason: "request_hash_mismatch",
      })
    }))

  it.effect("a non-matching idempotency key is refused", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* recordTerminal(service)
      const denied = yield* service
        .confirmSettled(confirmInput({ evidence: evidence({ idempotencyKey: "idem-different" }) }))
        .pipe(Effect.flip)
      expect(denied).toMatchObject({
        _tag: "SessionProviderRecovery.EvidenceBindingError",
        reason: "idempotency_key_mismatch",
      })
    }))

  it.effect("a non-matching terminal payload hash is refused", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* recordTerminal(service)
      const denied = yield* service
        .confirmSettled(confirmInput({ evidence: evidence({ payloadHash: "b".repeat(64) }) }))
        .pipe(Effect.flip)
      expect(denied).toMatchObject({
        _tag: "SessionProviderRecovery.EvidenceBindingError",
        reason: "terminal_payload_hash_mismatch",
      })
    }))

  it.effect("a CAS-lost / already-settled verdict is a typed existing (idempotent)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* recordTerminal(service)
      const first = yield* service.confirmSettled(confirmInput())
      const second = yield* service.confirmSettled(confirmInput())
      expect(first.status).toBe("settled")
      expect(second.status).toBe("existing")
      expect((second as { evidenceRef: string }).evidenceRef).toBe((first as { evidenceRef: string }).evidenceRef)
      // One settled terminal row only.
      expect(yield* service.evidence.getStatus((first as { evidenceRef: string }).evidenceRef)).toMatchObject({
        status: "settled",
      })
    }))
})
