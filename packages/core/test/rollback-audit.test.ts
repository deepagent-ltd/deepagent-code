import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { RollbackAudit } from "@deepagent-code/core/deepagent/rollback-audit"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "./lib/effect"

// V4.0 §D2/§F — the Rollback audit recorder. Verifies recording a rollback appends an audit row (with the
// SessionRevert outcome), that count() (the rollback_total backing) reflects it, and that both are
// workspace-scoped + windowed. Mirrors the HumanTakeover recorder test.

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

const database = Database.layerFromPath(":memory:")
const it = testEffect(RollbackAudit.layerWith({ now }).pipe(Layer.provideMerge(database)))

describe("RollbackAudit (§D2/§F)", () => {
  it.effect("recording a rollback increments rollback_total (count) and preserves outcome", () =>
    Effect.gen(function* () {
      const svc = yield* RollbackAudit.Service
      setNow(1_000)
      // baseline: no rollbacks ⇒ 0.
      expect(yield* svc.count({ workspaceID: "wrk_1", from: 0, to: 2_000 })).toBe(0)
      const rec = yield* svc.record({
        workspaceID: "wrk_1",
        sessionID: "ses_a",
        actorID: "human_1",
        reason: "bad diff",
        outcome: "reverted",
      })
      expect(rec.id.startsWith("rbk_")).toBe(true)
      expect(rec.workspaceID).toBe("wrk_1")
      expect(rec.sessionID).toBe("ses_a")
      expect(rec.outcome).toBe("reverted")
      expect(rec.createdAt).toBe(1_000)
      // count now reflects the recorded rollback.
      expect(yield* svc.count({ workspaceID: "wrk_1", from: 0, to: 2_000 })).toBe(1)
    }),
  )

  it.effect("a noop rollback is still recorded as an audit fact", () =>
    Effect.gen(function* () {
      const svc = yield* RollbackAudit.Service
      setNow(2_000)
      const rec = yield* svc.record({ workspaceID: "wrk_noop", sessionID: "ses_x", actorID: "h1", outcome: "noop" })
      expect(rec.outcome).toBe("noop")
      expect(yield* svc.count({ workspaceID: "wrk_noop", from: 0, to: 10_000 })).toBe(1)
    }),
  )

  it.effect("count is workspace-scoped (no cross-tenant leak) and windowed", () =>
    Effect.gen(function* () {
      const svc = yield* RollbackAudit.Service
      setNow(5_000)
      yield* svc.record({ workspaceID: "wrk_a", sessionID: "ses_1", actorID: "h1", outcome: "reverted" })
      yield* svc.record({ workspaceID: "wrk_a", sessionID: "ses_2", actorID: "h1", outcome: "noop" })
      yield* svc.record({ workspaceID: "wrk_b", sessionID: "ses_3", actorID: "h2", outcome: "reverted" })
      expect(yield* svc.count({ workspaceID: "wrk_a", from: 0, to: 10_000 })).toBe(2)
      expect(yield* svc.count({ workspaceID: "wrk_b", from: 0, to: 10_000 })).toBe(1)
      // a window that excludes the rollbacks (created at 5_000) counts 0.
      expect(yield* svc.count({ workspaceID: "wrk_a", from: 6_000, to: 10_000 })).toBe(0)
    }),
  )

  it.effect("list returns a workspace's rollbacks newest-first", () =>
    Effect.gen(function* () {
      const svc = yield* RollbackAudit.Service
      setNow(3_000)
      yield* svc.record({ workspaceID: "wrk_list", sessionID: "ses_1", actorID: "h1", reason: "first", outcome: "reverted" })
      setNow(3_500)
      yield* svc.record({ workspaceID: "wrk_list", sessionID: "ses_2", actorID: "h1", reason: "second", outcome: "noop" })
      const rows = yield* svc.list({ workspaceID: "wrk_list", from: 0, to: 10_000 })
      expect(rows.length).toBe(2)
      expect(rows[0].reason).toBe("second") // newest first
      expect(rows[1].reason).toBe("first")
    }),
  )
})
