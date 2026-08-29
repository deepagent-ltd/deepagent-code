import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SessionProviderRecovery } from "../src/session/runner/recovery"
import { testEffect } from "./lib/effect"

const it = testEffect(SessionProviderRecovery.layer)

const H64 = (c: string) => c.repeat(64)

const identity = (overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {}): SessionProviderRecovery.AttemptIdentity => ({
  sessionId: "ses_abandon",
  attemptId: "att_abandon",
  activityId: "act_abandon",
  providerTurnSeq: 1,
  selectionId: "sel_1",
  projectionHash: H64("p"),
  requestHash: H64("r"),
  providerId: "provider-test",
  ...overrides,
})

const user = { type: "user" as const, id: "operator" }

const abandonInput = (overrides: Partial<SessionProviderRecovery.AbandonExactInput> = {}): SessionProviderRecovery.AbandonExactInput => ({
  actor: user,
  requestHash: H64("r"),
  attemptIdentity: identity(),
  reasonCode: "network_unknown",
  ...overrides,
})

describe("SessionProviderRecovery.abandonExact (C1B-04)", () => {
  it.effect("records the abandon decision + terminal receipt in one transaction", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const outcome = yield* service.abandonExact(abandonInput())
      expect(outcome.status).toBe("abandoned")
      // Terminal receipt marks the attempt/context as abandoned.
      const abandon = yield* service.queryAbandon(identity())
      expect(abandon).toMatchObject({ decision: "abandoned", terminal: "abandoned", reasonCode: "network_unknown" })
      // The command authorizing the abandon is stored (same transaction).
      const command = yield* service.getCommand((outcome as { commandId: string }).commandId)
      expect(command?.attemptIdentity.attemptId).toBe("att_abandon")
      // Exact retry never duplicates: the slot holds one record.
      const list = yield* service.queryCommand({ requestHash: H64("r"), attemptIdentity: identity() })
      expect(list.command?.attemptIdentity.attemptId).toBe("att_abandon")
    }))

  it.effect("a CAS-lost abandon (attempt already resolved differently) is a typed conflict, no double effect", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* service.abandonExact(abandonInput())
      // A different payload for the SAME attempt: typed conflict, never a second terminal.
      const replay = yield* service.abandonExact(abandonInput({ requestHash: "x".repeat(64) }))
      expect(replay.status).toBe("conflict")
      expect(replay).toMatchObject({ reason: "abandon_mismatch" })
      // The original terminal is intact — no double effect.
      const abandon = yield* service.queryAbandon(identity())
      expect(abandon?.requestHash).toBe(H64("r"))
    }))

  it.effect("an exact-retry abandon is idempotent (typed existing), no second terminal row", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const first = yield* service.abandonExact(abandonInput())
      const second = yield* service.abandonExact(abandonInput())
      expect(first.status).toBe("abandoned")
      expect(second.status).toBe("existing")
      expect((second as { commandId: string }).commandId).toBe((first as { commandId: string }).commandId)
      // One terminal row for the attempt.
      expect(yield* service.queryAbandon(identity())).toMatchObject({ requestHash: H64("r") })
    }))

  it.effect("a settled/terminal evidence blocks abandon (query-command-first refusal)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      yield* service.evidence.recordStatus({ evidenceRef: "ev_settled", status: "settled", requestHash: H64("r") })
      const denied = yield* service.abandonExact(abandonInput()).pipe(Effect.flip)
      expect(denied).toMatchObject({
        _tag: "SessionProviderRecovery.RefuseAbandonWithTerminalEvidenceError",
        evidenceRef: "ev_settled",
      })
      // No abandon was recorded (nothing was half-applied).
      expect(yield* service.queryAbandon(identity())).toBeUndefined()
      const q = yield* service.queryCommand({ requestHash: H64("r"), attemptIdentity: identity() })
      expect(q.command).toBeUndefined()
    }))

  it.effect("a crash mid-abandon commits nothing (same-transaction or nothing)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const crashed = yield* service.abandonExact(abandonInput({ fault: { at: "after_command_stage" } })).pipe(Effect.flip)
      expect(crashed).toMatchObject({ _tag: "SessionProviderRecovery.RecoveryTransactionAbortedError" })
      // State unchanged: no abandon record, no command.
      expect(yield* service.queryAbandon(identity())).toBeUndefined()
      const q = yield* service.queryCommand({ requestHash: H64("r"), attemptIdentity: identity() })
      expect(q.command).toBeUndefined()
    }))

  it.effect("a system actor is never permitted to abandon (no mutation)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const denied = yield* service
        .abandonExact(abandonInput({ actor: { type: "system", id: "kernel" } }))
        .pipe(Effect.flip)
      expect(denied).toMatchObject({ _tag: "SessionProviderRecovery.PermissionDeniedError" })
      expect(yield* service.queryAbandon(identity())).toBeUndefined()
    }))

  it.effect("history/context remains readable after abandon", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const outcome = yield* service.abandonExact(abandonInput())
      // The command/evidence store is still readable.
      expect(yield* service.getCommand((outcome as { commandId: string }).commandId)).toBeDefined()
      // The classifier still produces a descriptor (context not corrupted).
      const descriptor = service.classify({
        attempt: identity(),
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
      expect(descriptor.descriptorKind).toBe("resolvable_exact")
    }))
})
