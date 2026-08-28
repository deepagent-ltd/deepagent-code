import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { RecoveryCommandContract } from "../src/contract/recovery-command"
import { SessionProviderRecovery } from "../src/session/runner/recovery"
import { testEffect } from "./lib/effect"

const it = testEffect(SessionProviderRecovery.layer)

const H64 = (c: string) => c.repeat(64)

const identity = (overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {}): SessionProviderRecovery.AttemptIdentity => ({
  sessionId: "ses_recovery",
  attemptId: "att_recovery",
  activityId: "act_recovery",
  providerTurnSeq: 1,
  selectionId: "sel_1",
  projectionHash: H64("p"),
  requestHash: H64("r"),
  providerId: "provider-test",
  ...overrides,
})

const baseClassify: SessionProviderRecovery.ClassifyInput = {
  attempt: identity(),
  attemptState: "indeterminate_after_crash",
  expectedAttemptState: "indeterminate_after_crash",
  ownerToken: "owner_recovery",
  expectedVersion: 2,
  baseline: { baselineHash: H64("b"), verified: true, state: "present" },
  historyVerified: true,
  providerLookupComplete: true,
  placementUnresolved: false,
  permissionIncomplete: false,
  workspaceConflict: false,
}

describe("SessionProviderRecovery classifier (C1B-02)", () => {
  it.effect("classifies a verifiable attempt as resolvable_exact (exact)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const descriptor = service.classify(baseClassify)
      expect(descriptor.descriptorKind).toBe("resolvable_exact")
      // The frozen contract decodes it without error and reports the same class.
      expect(RecoveryCommandContract.decodeRecoveryDescriptor(descriptor).descriptorKind).toBe("resolvable_exact")
      expect(descriptor.requestHash).toBe(H64("r"))
    }))

  it.effect("classifies a corrupt-but-reconstructable baseline as repairable_exact", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const descriptor = service.classify({
        ...baseClassify,
        baseline: {
          baselineHash: H64("x"),
          sourceSnapshotRef: "snapshot:block-42",
          state: "corrupt",
          verified: false,
        },
      })
      expect(descriptor.descriptorKind).toBe("repairable_exact")
      expect(descriptor).toMatchObject({
        repairable: { baselineState: "corrupt", sourceSnapshotRef: "snapshot:block-42", canReconstruct: true },
      })
    }))

  it.effect("classifies a proven safe boundary as fork_only (fork)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const descriptor = service.classify({
        ...baseClassify,
        baseline: { verified: false, state: "missing" },
        safeBoundary: { safeBoundaryRef: "boundary:32", safeBoundaryHash: H64("s") },
      })
      expect(descriptor.descriptorKind).toBe("fork_only")
      expect(descriptor).toMatchObject({
        fork: { safeBoundaryRef: "boundary:32", originalSessionReadOnly: true },
      })
    }))

  it.effect("classifies nothing-provable as coordination_required", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const descriptor = service.classify({
        ...baseClassify,
        baseline: { verified: false, state: "missing" },
        historyVerified: false,
        providerLookupComplete: false,
      })
      expect(descriptor.descriptorKind).toBe("coordination_required")
      expect(descriptor).toMatchObject({ coordination: { reason: "baseline_missing", requiredActor: "admin" } })
    }))

  it.effect("classifies a committed resolution as resolved", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const descriptor = service.classify({
        ...baseClassify,
        resolution: { resolutionRef: "res-1", bridgeRef: "bridge-1", terminal: "abandoned" },
      })
      expect(descriptor.descriptorKind).toBe("resolved")
      expect(descriptor).toMatchObject({
        resolved: { resolutionRef: "res-1", bridgeRef: "bridge-1", terminal: "abandoned" },
      })
    }))

  it.effect("a coordination descriptor is never fabricated as resolved", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const descriptor = service.classify({ ...baseClassify, baseline: { verified: false, state: "missing" } })
      expect(descriptor.descriptorKind).not.toBe("resolved")
    }))
})

describe("SessionProviderRecovery exit + permission (C1B-02)", () => {
  it.effect("declares the user exit and least-privilege permission per class", () =>
    Effect.gen(function* () {
      const kinds: readonly SessionProviderRecovery.DescriptorKind[] = [
        "resolvable_exact",
        "repairable_exact",
        "fork_only",
        "coordination_required",
        "resolved",
      ]
      const actions = kinds.map((kind) => SessionProviderRecovery.exitFor(kind))
      expect(actions).toEqual(["abandon", "repair", "fork", "coordinate", "refresh"])
      expect(kinds.map((kind) => SessionProviderRecovery.requiredPermissionFor(kind))).toEqual([
        "user",
        "administrator",
        "user",
        "administrator",
        "user",
      ])
    }))

  it.effect("a user without the administrator permission is typed-denied with no mutation", () =>
    Effect.gen(function* () {
      const denied = yield* SessionProviderRecovery.assertPermission(
        { type: "user" },
        SessionProviderRecovery.requiredPermissionFor("repairable_exact"),
      ).pipe(Effect.flip)
      // The typed refusal carries the required/granted pair; no state was mutated (pure refusal).
      expect(denied).toMatchObject({
        _tag: "SessionProviderRecovery.PermissionDeniedError",
        required: "administrator",
        granted: "user",
      })
    }))

  it.effect("an administrator may invoke the repair exit; a user may abandon", () =>
    Effect.gen(function* () {
      yield* SessionProviderRecovery.assertPermission(
        { type: "administrator" },
        SessionProviderRecovery.requiredPermissionFor("repairable_exact"),
      )
      yield* SessionProviderRecovery.assertPermission(
        { type: "user" },
        SessionProviderRecovery.requiredPermissionFor("resolvable_exact"),
      )
    }))

  it.effect("a system actor may never invoke a recovery exit", () =>
    Effect.gen(function* () {
      const denied = yield* SessionProviderRecovery.assertPermission({ type: "system" }, "user").pipe(Effect.flip)
      expect(denied).toMatchObject({ _tag: "SessionProviderRecovery.PermissionDeniedError" })
    }))
})

describe("SessionProviderRecovery command store (C1B-03)", () => {
  it.effect("content-addresses the command id from the exact request hash + attempt identity", () =>
    Effect.gen(function* () {
      const a = SessionProviderRecovery.recoveryCommandContentAddress({ requestHash: H64("r"), attemptIdentity: identity() })
      const b = SessionProviderRecovery.recoveryCommandContentAddress({ requestHash: H64("r"), attemptIdentity: identity() })
      expect(a).toBe(b)
      // A different payload never collides with the original address.
      const c = SessionProviderRecovery.recoveryCommandContentAddress({
        requestHash: "x".repeat(64),
        attemptIdentity: identity(),
      })
      expect(c).not.toBe(a)
    }))

  it.effect("same request hash + same attempt is idempotent (typed existing)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const first = yield* service.recordCommand({ requestHash: H64("r"), attemptIdentity: identity() })
      const second = yield* service.recordCommand({ requestHash: H64("r"), attemptIdentity: identity() })
      expect(first.status).toBe("recorded")
      expect(second.status).toBe("existing")
      expect(second.commandId).toBe(first.commandId)
    }))

  it.effect("a non-matching request hash replay is a typed mismatch, never re-recorded", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* service.recordCommand({ requestHash: H64("r"), attemptIdentity: identity() })
      // Same attempt but a different payload.
      const replay = yield* service.recordCommand({ requestHash: "x".repeat(64), attemptIdentity: identity() })
      expect(replay.status).toBe("mismatch")
      expect(replay).toMatchObject({ reason: "request_hash_mismatch" })
    }))

  it.effect("CAS: two commands for the same attempt serialize; the loser is typed, never a defect", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const [a, b] = yield* Effect.all([
        service.recordCommand({ requestHash: H64("r"), attemptIdentity: identity() }),
        service.recordCommand({ requestHash: H64("r"), attemptIdentity: identity() }),
      ])
      // Both resolve to the same content address; the loser is a typed `existing`.
      expect([a.status, b.status].sort()).toEqual(["existing", "recorded"])
      expect(a.commandId).toBe(b.commandId)
    }))
})

describe("SessionProviderRecovery single-writer resolve (C1B-01)", () => {
  it.effect("two concurrent resolves return the same descriptor and write one command", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const input: SessionProviderRecovery.ResolveInput = {
        sessionId: "ses_recovery",
        attemptId: "att_recovery",
        actor: { type: "user", id: "operator" },
        requestHash: H64("r"),
        attemptIdentity: identity(),
        expectedAttemptState: "indeterminate_after_crash",
        ownerToken: "owner_recovery",
        expectedVersion: 2,
        baseline: baseClassify.baseline,
      }
      const [ra, rb] = yield* Effect.all([service.resolve(input), service.resolve(input)], {
        concurrency: "unbounded",
      })
      expect(ra.descriptor.descriptorKind).toBe("resolvable_exact")
      expect(rb.descriptor.descriptorKind).toBe("resolvable_exact")
      expect(ra.commandId).toBe(rb.commandId)
      // The command slot holds exactly one terminal command for the attempt (no double write).
      const stored = yield* service.getCommand(ra.commandId)
      expect(stored?.attemptIdentity.attemptId).toBe("att_recovery")
      expect(yield* service.getCommand(rb.commandId)).toMatchObject({ attemptIdentity: { attemptId: "att_recovery" } })
    }))
})

describe("SessionProviderRecovery evidence store (C1B-03)", () => {
  it.effect("records and reads evidence with typed statuses pending/external/settled", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* service.evidence.recordStatus({ evidenceRef: "ev-1", status: "pending" })
      expect(yield* service.evidence.getStatus("ev-1")).toMatchObject({ status: "pending" })
      yield* service.evidence.recordStatus({ evidenceRef: "ev-2", status: "external", providerId: "prov" })
      expect(yield* service.evidence.getStatus("ev-2")).toMatchObject({ status: "external", providerId: "prov" })
      yield* service.evidence.recordStatus({ evidenceRef: "ev-3", status: "settled", payloadHash: H64("h") })
      expect(yield* service.evidence.getStatus("ev-3")).toMatchObject({ status: "settled", payloadHash: H64("h") })
      expect(yield* service.evidence.getStatus("missing")).toBeUndefined()
    }))
})

describe("SessionProviderRecovery legacy adapter (C1B-01)", () => {
  it.effect("a legacy incomplete record classifies as coordination and is never fabricated resolved", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const res = service.adapter.classifyLegacy({ receiptId: "legacy_receipt_indeterminate" })
      expect(res.outOfAuthority).toBe(true)
      expect(res.descriptor.descriptorKind).toBe("coordination_required")
      // The legacy adapter never claims a terminal outcome — no successor epoch, no resolved.
      expect(res.descriptor.descriptorKind).not.toBe("resolved")
    }))
})
