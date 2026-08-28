import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { SessionProviderRecovery } from "../src/session/runner/recovery"
import type { SafeBoundaryMessage } from "../src/session/runner/recovery-safe-boundary"
import { testEffect } from "./lib/effect"

const it = testEffect(SessionProviderRecovery.layer)

const H64 = (c: string) => c.repeat(64)

const identity = (overrides: Partial<SessionProviderRecovery.AttemptIdentity> = {}): SessionProviderRecovery.AttemptIdentity => ({
  sessionId: "ses_fork_source",
  attemptId: "att_fork",
  activityId: "act_fork",
  providerTurnSeq: 3,
  selectionId: "sel_3",
  projectionHash: H64("p"),
  requestHash: H64("r"),
  providerId: "provider-test",
  ...overrides,
})

const user = { type: "user" as const, id: "operator" }

// A normalized history message. `certain=false` marks an unknown-result turn; a
// user or a confirmed assistant is a checkpoint.
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

const forkInput = (overrides: Partial<SessionProviderRecovery.ForkFromSafeBoundaryInput> = {}): SessionProviderRecovery.ForkFromSafeBoundaryInput => ({
  actor: user,
  sourceSessionId: "ses_fork_source",
  requestHash: H64("r"),
  attemptIdentity: identity(),
  history: [msg("m0", 0, "user"), msg("m1", 1, "assistant")],
  ...overrides,
})

describe("SessionProviderRecovery.findSafeBoundary (C1B-07)", () => {
  it.effect("finds the boundary at the last certain checkpoint", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const safe = service.findSafeBoundary([msg("m0", 0, "user"), msg("m1", 1, "assistant")])
      expect(safe.status).toBe("found")
      if (safe.status === "found") {
        expect(safe.boundaryMessageId).toBe("m1")
        expect(safe.confirmedThrough.id).toBe("m1")
        expect(safe.firstIndeterminateIndex).toBeUndefined()
        expect(safe.excludedTurns).toEqual([])
      }
    }))

  it.effect("an unknown-result assistant turn is never a safe boundary", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const safe = service.findSafeBoundary([msg("m0", 0, "user"), msg("m1", 1, "tool", true), msg("m2", 2, "assistant", false)])
      expect(safe.status).toBe("found")
      if (safe.status === "found") {
        // The boundary is the LAST checkpoint before the indeterminate assistant (m2).
        expect(safe.boundaryMessageId).toBe("m0")
        expect(safe.firstIndeterminateIndex).toBe(2)
        expect(safe.excludedTurns.map((turn) => turn.id)).toEqual(["m2"])
      }
    }))
})

describe("SessionProviderRecovery.forkFromSafeBoundary (C1B-07)", () => {
  it.effect("the fork copies messages THROUGH the boundary and excludes unknown turns", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const outcome = yield* service.forkFromSafeBoundary(
        forkInput({
          history: [msg("m0", 0, "user"), msg("m1", 1, "assistant"), msg("m2", 2, "tool", false)],
        }),
      )
      expect(outcome.status).toBe("forked")
      if (outcome.status === "forked") {
        // The window stops at the last confirmed checkpoint (m1) — the unknown tool (m2) is NOT copied.
        expect(outcome.manifest.copiedMessageIds).toEqual(["m0", "m1"])
        expect(outcome.manifest.excludedIndeterminateTurns.map((turn) => turn.id)).toEqual(["m2"])
        expect(outcome.manifest.sourceSessionId).toBe("ses_fork_source")
        expect(outcome.manifest.boundaryMessageId).toBe("m1")
        expect(outcome.manifest.createdBy).toMatchObject({ actorType: "user", actorId: "operator" })
        expect(outcome.manifest.permission).toBe("user")
      }
    }))

  it.effect("the original session is fenced READ-ONLY after a fork (write refused typed)", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const outcome = yield* service.forkFromSafeBoundary(forkInput())
      expect(outcome.status).toBe("forked")
      expect(yield* service.isSessionReadOnly("ses_fork_source")).toBe(true)
      const denied = yield* service
        .assertSessionWritable("ses_fork_source")
        .pipe(Effect.flip)
      expect(denied).toMatchObject({ _tag: "SessionProviderRecovery.SessionReadOnlyError", reason: "fork_fence" })
      // A non-fenced session is still writable.
      yield* service.assertSessionWritable("ses_other")
    }))

  it.effect("the fork manifest is complete and its hashes are deterministic", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const history = [msg("m0", 0, "user"), msg("m1", 1, "assistant"), msg("m2", 2, "tool", false)]
      // Determinism: the same history always yields the same hashed window (pure).
      const af = service.findSafeBoundary(history)
      const bf = service.findSafeBoundary(history)
      expect(af.status).toBe("found")
      if (af.status === "found" && bf.status === "found") {
        expect(af.hashedWindow).toBe(bf.hashedWindow)
        expect(af.boundaryMessageId).toBe(bf.boundaryMessageId)
        const outcome = yield* service.forkFromSafeBoundary(forkInput({ history }))
        expect(outcome.status).toBe("forked")
        if (outcome.status === "forked") {
          // The fork manifest carries the same deterministic window hash + boundary + exclusion.
          expect(outcome.manifest.copiedWindowHash).toBe(af.hashedWindow)
          expect(outcome.manifest.boundaryMessageId).toBe(af.boundaryMessageId)
          expect(outcome.manifest.excludedIndeterminateTurns.map((turn) => turn.id)).toEqual(["m2"])
        }
      }
    }))

  it.effect("the boundary is always BEFORE the first indeterminate turn", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const history = [msg("m0", 0, "user"), msg("m1", 1, "assistant"), msg("m2", 2, "tool", true), msg("m3", 3, "assistant", false)]
      const safe = service.findSafeBoundary(history)
      expect(safe.status).toBe("found")
      if (safe.status === "found") {
        expect(safe.boundaryIndex).toBeLessThan(safe.firstIndeterminateIndex!)
      }
    }))

  it.effect("fork requires the user-grade permission; a system actor is refused", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const denied = yield* service
        .forkFromSafeBoundary(forkInput({ actor: { type: "system", id: "kernel" } }))
        .pipe(Effect.flip)
      expect(denied).toMatchObject({ _tag: "SessionProviderRecovery.PermissionDeniedError", required: "user", granted: "system" })
      // Nothing was forked / fenced.
      expect(yield* service.isSessionReadOnly("ses_fork_source")).toBe(false)
    }))

  it.effect("an exact-retry fork for the same boundary is idempotent (existing) — no second fork", () =>
    Effect.gen(function* () {
      const service = yield* SessionProviderRecovery.Service
      const first = yield* service.forkFromSafeBoundary(forkInput())
      const second = yield* service.forkFromSafeBoundary(forkInput())
      expect(first.status).toBe("forked")
      expect(second.status).toBe("existing")
      if (first.status === "forked" && second.status === "existing") {
        expect(second.forkSessionId).toBe(first.forkSessionId)
        expect(second.forkRef).toBe(first.forkRef)
        expect(second.manifest.forkSessionId).toBe(first.manifest.forkSessionId)
      }
      // Only one fork record for the source.
      expect(yield* service.queryFork("ses_fork_source")).toMatchObject({ manifest: { sourceSessionId: "ses_fork_source" } })
    }))
})
