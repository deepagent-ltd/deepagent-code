import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HumanTakeover } from "@deepagent-code/core/deepagent/human-takeover"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "./lib/effect"

// V4.0 §D2/§F — the Human Takeover recorder. Verifies recording a takeover appends an audit row, that
// count() (the human_takeover_total backing) reflects it, and that both are workspace-scoped + windowed.

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

const database = Database.layerFromPath(":memory:")
const it = testEffect(HumanTakeover.layerWith({ now }).pipe(Layer.provideMerge(database)))

describe("HumanTakeover (§D2/§F)", () => {
  it.effect("recording a takeover increments human_takeover_total (count)", () =>
    Effect.gen(function* () {
      const svc = yield* HumanTakeover.Service
      setNow(1_000)
      // baseline: no takeovers ⇒ 0.
      expect(yield* svc.count({ workspaceID: "wrk_1", from: 0, to: 2_000 })).toBe(0)
      const rec = yield* svc.record({
        workspaceID: "wrk_1",
        sessionID: "ses_a",
        agentID: "agt_a",
        actorID: "human_1",
        reason: "paused",
      })
      expect(rec.id.startsWith("tko_")).toBe(true)
      expect(rec.workspaceID).toBe("wrk_1")
      expect(rec.sessionID).toBe("ses_a")
      expect(rec.createdAt).toBe(1_000)
      // count now reflects the recorded takeover.
      expect(yield* svc.count({ workspaceID: "wrk_1", from: 0, to: 2_000 })).toBe(1)
    }),
  )

  it.effect("count is workspace-scoped (no cross-tenant leak) and windowed", () =>
    Effect.gen(function* () {
      const svc = yield* HumanTakeover.Service
      setNow(5_000)
      yield* svc.record({ workspaceID: "wrk_a", actorID: "h1", reason: "paused" })
      yield* svc.record({ workspaceID: "wrk_a", actorID: "h1", reason: "reverted" })
      yield* svc.record({ workspaceID: "wrk_b", actorID: "h2", reason: "paused" })
      expect(yield* svc.count({ workspaceID: "wrk_a", from: 0, to: 10_000 })).toBe(2)
      expect(yield* svc.count({ workspaceID: "wrk_b", from: 0, to: 10_000 })).toBe(1)
      // a window that excludes the takeovers (created at 5_000) counts 0.
      expect(yield* svc.count({ workspaceID: "wrk_a", from: 6_000, to: 10_000 })).toBe(0)
    }),
  )

  it.effect("list returns a workspace's takeovers newest-first", () =>
    Effect.gen(function* () {
      const svc = yield* HumanTakeover.Service
      setNow(3_000)
      yield* svc.record({ workspaceID: "wrk_list", actorID: "h1", reason: "first" })
      setNow(3_500)
      yield* svc.record({ workspaceID: "wrk_list", actorID: "h1", reason: "second" })
      const rows = yield* svc.list({ workspaceID: "wrk_list", from: 0, to: 10_000 })
      expect(rows.length).toBe(2)
      expect(rows[0].reason).toBe("second") // newest first
      expect(rows[1].reason).toBe("first")
    }),
  )
})
