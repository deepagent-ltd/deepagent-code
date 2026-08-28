import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SessionProviderRecovery } from "../src/session/runner/recovery"
import { testEffect } from "./lib/effect"

const it = testEffect(SessionProviderRecovery.layer)

const H64 = (c: string) => c.repeat(64)
const key = (byte = 7) => new Uint8Array(32).fill(byte)

const identity = (overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {}): SessionProviderRecovery.AttemptIdentity => ({
  sessionId: "ses_export",
  attemptId: "att_export",
  activityId: "act_export",
  providerTurnSeq: 2,
  selectionId: "sel_2",
  projectionHash: H64("p"),
  requestHash: H64("r"),
  providerId: "provider-test",
  ...overrides,
})

const user = { type: "user" as const, id: "operator" }

const classifyInput = (attempt: SessionProviderRecovery.AttemptIdentity): SessionProviderRecovery.ClassifyInput => ({
  attempt,
  attemptState: "indeterminate_after_crash",
  expectedAttemptState: "indeterminate_after_crash",
  ownerToken: "owner",
  expectedVersion: 2,
  baseline: { baselineHash: H64("b"), verified: true, state: "present" },
  historyVerified: true,
  providerLookupComplete: true,
  placementUnresolved: false,
  permissionIncomplete: false,
  workspaceConflict: false,
})

const exportInput = (overrides: Partial<SessionProviderRecovery.ExportRecoveryEvidenceInput> = {}): SessionProviderRecovery.ExportRecoveryEvidenceInput => ({
  actor: user,
  sessionId: "ses_export",
  attemptIdentity: identity(),
  requestHash: H64("r"),
  classifyInput: classifyInput(identity()),
  encryptionKey: key(7),
  keyId: "k1",
  ...overrides,
})

describe("SessionProviderRecovery.exportRecoveryEvidence (C1B-09)", () => {
  it.effect("exports a complete + DEFAULT-REDACTED manifest (credential never leaks)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* service.evidence.recordStatus({
        evidenceRef: "ev_1",
        status: "settled",
        requestHash: H64("r"),
        payloadHash: H64("term"),
      })
      const outcome = yield* service.exportRecoveryEvidence(
        exportInput({
          // A credential-like payload lives in the evidence set (encrypted body); it must NOT
          // be present anywhere in the manifest.
          attemptIdentity: identity({ providerId: "sk-secret-credential-1234" }),
          classifyInput: classifyInput(identity({ providerId: "sk-secret-credential-1234" })),
        }),
      )
      expect(outcome.manifest).toMatchObject({
        schemaVersion: "recovery-export-manifest.v1",
        redacted: true,
        target: { sessionId: "ses_export", attemptIds: ["att_export"] },
        permission: { unlockActorType: "user", unlockActorId: "operator", unlockSessionId: "ses_export", crossSessionDenied: true },
      })
      expect(outcome.contentHash).toMatch(/^[0-9a-f]{64}$/)
      const manifestText = JSON.stringify(outcome.manifest)
      expect(manifestText).not.toContain("sk-secret-credential-1234")
      // The summary is hash/size/type/reason only — no payload body.
      for (const item of outcome.manifest.summary) {
        expect(Object.keys(item).sort()).toEqual(["kind", "reason", "ref", "sha256", "size"])
      }
    }))

  it.effect("same-session unlock returns the payload and its content hash", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* service.evidence.recordStatus({ evidenceRef: "ev_1", status: "settled", requestHash: H64("r"), payloadHash: H64("term") })
      const outcome = yield* service.exportRecoveryEvidence(exportInput())
      const unlocked = yield* service.unlockRecoveryEvidence({
        actor: user,
        sessionId: "ses_export",
        exportId: outcome.exportId,
        encryptionKey: key(7),
      })
      expect(unlocked.contentHash).toBe(outcome.contentHash)
      expect(unlocked.manifest.exportId).toBe(outcome.exportId)
      // The payload is the evidence set (descriptor + command + evidence) — verifiable.
      expect(unlocked.payload).toContain("recovery-descriptor.v1")
    }))

  it.effect("a cross-session unlock is refused (typed)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const outcome = yield* service.exportRecoveryEvidence(exportInput())
      const denied = yield* service
        .unlockRecoveryEvidence({ actor: user, sessionId: "ses_other", exportId: outcome.exportId, encryptionKey: key(7) })
        .pipe(Effect.flip)
      expect(denied).toMatchObject({
        _tag: "SessionProviderRecovery.ExportCrossSessionDeniedError",
        requestedSessionId: "ses_other",
        ownerSessionId: "ses_export",
      })
    }))

  it.effect("expiry is enforced (bounded default 7 days; a long-past unlock is refused)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const outcome = yield* service.exportRecoveryEvidence(exportInput({ now: 1000, ttlMs: 5000 }))
      expect(outcome.manifest.expiresAt).toBe(6000)
      const denied = yield* service
        .unlockRecoveryEvidence({ actor: user, sessionId: "ses_export", exportId: outcome.exportId, encryptionKey: key(7), now: 7000 })
        .pipe(Effect.flip)
      expect(denied).toMatchObject({ _tag: "SessionProviderRecovery.ExportExpiredError", expiredAt: 6000 })
    }))

  it.effect("a tampered artifact/export is a typed mismatch, never silently opened", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const outcome = yield* service.exportRecoveryEvidence(exportInput())
      // Unlock with the WRONG key: the AES-256-GCM auth tag no longer matches (tampered / wrong key).
      const denied = yield* service
        .unlockRecoveryEvidence({ actor: user, sessionId: "ses_export", exportId: outcome.exportId, encryptionKey: key(42) })
        .pipe(Effect.flip)
      expect(denied).toMatchObject({ _tag: "SessionProviderRecovery.ExportTamperError", exportId: outcome.exportId })
    }))

  it.effect("contentHash is stable for the same evidence; exportId is random per export", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* service.evidence.recordStatus({ evidenceRef: "ev_1", status: "settled", requestHash: H64("r"), payloadHash: H64("term") })
      const a = yield* service.exportRecoveryEvidence(exportInput())
      const b = yield* service.exportRecoveryEvidence(exportInput())
      // The evidence set is identical -> the content hash is stable and auditable.
      expect(a.contentHash).toBe(b.contentHash)
      // Each export is a distinct artifact with its own random id.
      expect(a.exportId).not.toBe(b.exportId)
      expect(a.artifactRef).not.toBe(b.artifactRef)
    }))
})
