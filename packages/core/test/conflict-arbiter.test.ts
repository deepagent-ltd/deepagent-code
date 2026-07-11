import { describe, expect, test } from "bun:test"
import { ConflictArbiter } from "@deepagent-code/core/deepagent/conflict-arbiter"
import type { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"

// ConflictArbiter is a PURE module — plain unit tests.

const claim = (over?: Partial<ConflictArbiter.Claim>): ConflictArbiter.Claim => ({
  taskID: "tsk_1",
  agentID: "agt_1",
  files: ["src/a.ts"],
  symbols: [],
  priority: "normal" as DeepAgentEvent.EventPriority,
  origin: "system",
  ...over,
})

describe("ConflictArbiter.conflicts", () => {
  test("overlapping file scopes conflict", () => {
    const a = claim({ taskID: "t1", files: ["src/a.ts", "src/b.ts"] })
    const b = claim({ taskID: "t2", files: ["src/b.ts"] })
    expect(ConflictArbiter.conflicts(a, b)).toBe(true)
  })

  test("disjoint file scopes do not conflict", () => {
    const a = claim({ taskID: "t1", files: ["src/a.ts"] })
    const b = claim({ taskID: "t2", files: ["src/c.ts"] })
    expect(ConflictArbiter.conflicts(a, b)).toBe(false)
  })

  test("an empty (broad) file scope conservatively conflicts with everything", () => {
    const a = claim({ taskID: "t1", files: [] })
    const b = claim({ taskID: "t2", files: ["src/z.ts"] })
    expect(ConflictArbiter.conflicts(a, b)).toBe(true)
  })

  test("§C3.3 semantic: same symbol conflicts even with disjoint files", () => {
    const a = claim({ taskID: "t1", files: ["src/a.ts"], symbols: ["Foo.bar"] })
    const b = claim({ taskID: "t2", files: ["src/b.ts"], symbols: ["Foo.bar"] })
    expect(ConflictArbiter.conflicts(a, b)).toBe(true)
  })

  test("a claim never conflicts with itself", () => {
    const a = claim({ taskID: "t1", files: [] })
    expect(ConflictArbiter.conflicts(a, a)).toBe(false)
  })
})

describe("ConflictArbiter.conflictGroups", () => {
  test("transitively-conflicting claims form one group; disjoint ones stay singletons", () => {
    const a = claim({ taskID: "t1", files: ["src/a.ts"] })
    const b = claim({ taskID: "t2", files: ["src/a.ts", "src/b.ts"] }) // overlaps a
    const c = claim({ taskID: "t3", files: ["src/b.ts"] }) // overlaps b → transitively with a
    const d = claim({ taskID: "t4", files: ["src/z.ts"] }) // disjoint
    const groups = ConflictArbiter.conflictGroups([a, b, c, d])
    const sizes = groups.map((g) => g.length).sort()
    expect(sizes).toEqual([1, 3])
  })
})

describe("ConflictArbiter.resolve", () => {
  test("§C3 ordering: higher priority wins", () => {
    const lo = claim({ taskID: "t1", priority: "normal" })
    const hi = claim({ taskID: "t2", priority: "critical" })
    const r = ConflictArbiter.resolve([lo, hi])
    expect(r.type).toBe("winner")
    if (r.type === "winner") {
      expect(r.winner.taskID).toBe("t2")
      expect(r.deferred.map((c) => c.taskID)).toEqual(["t1"])
    }
  })

  test("§C3 ordering: same priority → smaller diff wins", () => {
    const big = claim({ taskID: "t1", priority: "high", diffSize: 500 })
    const small = claim({ taskID: "t2", priority: "high", diffSize: 10 })
    const r = ConflictArbiter.resolve([big, small])
    expect(r.type === "winner" && r.winner.taskID).toBe("t2")
  })

  test("§C3 ordering: same priority + diff → human origin beats schedule", () => {
    const sched = claim({ taskID: "t1", priority: "high", diffSize: 10, origin: "schedule" })
    const human = claim({ taskID: "t2", priority: "high", diffSize: 10, origin: "human" })
    const r = ConflictArbiter.resolve([sched, human])
    expect(r.type === "winner" && r.winner.taskID).toBe("t2")
  })

  test("§C3 true tie on all keys → needs_human", () => {
    const a = claim({ taskID: "t1", priority: "high", diffSize: 10, origin: "system" })
    const b = claim({ taskID: "t2", priority: "high", diffSize: 10, origin: "system" })
    const r = ConflictArbiter.resolve([a, b])
    expect(r.type).toBe("needs_human")
    if (r.type === "needs_human") expect(r.claims.length).toBe(2)
  })

  test("a singleton group trivially wins with no deferred", () => {
    const r = ConflictArbiter.resolve([claim({ taskID: "solo" })])
    expect(r.type === "winner" && r.winner.taskID).toBe("solo")
    if (r.type === "winner") expect(r.deferred).toEqual([])
  })

  test("unknown diffSize loses the diff tiebreak to a known smaller one", () => {
    const unknown = claim({ taskID: "t1", priority: "high" }) // diffSize undefined = ∞
    const known = claim({ taskID: "t2", priority: "high", diffSize: 100 })
    const r = ConflictArbiter.resolve([unknown, known])
    expect(r.type === "winner" && r.winner.taskID).toBe("t2")
  })
})
