import { describe, expect, test } from "bun:test"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import {
  acceptsSessionPlanUpdate,
  hasSessionPlanIdentityConflict,
  sessionPlanCursor,
  type SessionPlan,
} from "./global-sync/types"
import { syncRetainedSessionPlanSnapshots } from "./server-sync"

const sessionPlan = (overrides: Partial<SessionPlan> = {}): SessionPlan => ({
  plan_id: "plan-1",
  plan_version: 3,
  goal: "ship",
  assumptions: [],
  active_step_id: "a",
  steps: [],
  done: 0,
  total: 0,
  ...overrides,
})

describe("session plan cursor and identity admission", () => {
  test("rejects a lower live version and a different live plan identity", () => {
    const current = sessionPlan()
    expect(acceptsSessionPlanUpdate(current, sessionPlan({ plan_version: 2 }), { source: "event" })).toBe(false)
    expect(
      acceptsSessionPlanUpdate(current, sessionPlan({ plan_id: "plan-2", plan_version: 1 }), { source: "event" }),
    ).toBe(false)
  })

  test("allows a reconnect snapshot to calibrate a new plan identity", () => {
    const current = sessionPlan()
    const options = { source: "snapshot" as const, snapshotBaseline: sessionPlanCursor(current) }
    expect(acceptsSessionPlanUpdate(current, sessionPlan({ plan_id: "plan-2", plan_version: 1 }), options)).toBe(true)
    expect(acceptsSessionPlanUpdate(current, undefined, options)).toBe(true)
  })

  test("does not let an older same-identity snapshot roll back a live event", () => {
    const baseline = sessionPlan({ plan_version: 3 })
    const current = sessionPlan({ plan_version: 12 })
    const options = { source: "snapshot" as const, snapshotBaseline: sessionPlanCursor(baseline) }
    expect(acceptsSessionPlanUpdate(current, sessionPlan({ plan_version: 11 }), options)).toBe(false)
    expect(acceptsSessionPlanUpdate(current, sessionPlan({ plan_version: 12 }), options)).toBe(true)
  })

  test("does not let a stale snapshot clear or replace a live cursor that changed after request start", () => {
    const baseline = sessionPlan({ plan_version: 3 })
    const current = sessionPlan({ plan_id: "plan-2", plan_version: 1 })
    const options = { source: "snapshot" as const, snapshotBaseline: sessionPlanCursor(baseline) }
    expect(acceptsSessionPlanUpdate(current, undefined, options)).toBe(false)
    expect(acceptsSessionPlanUpdate(current, baseline, options)).toBe(false)
  })

  test("accepts the first live event and same-identity forward cursor", () => {
    expect(acceptsSessionPlanUpdate(undefined, sessionPlan({ plan_version: 0 }), { source: "event" })).toBe(true)
    expect(acceptsSessionPlanUpdate(sessionPlan(), sessionPlan({ plan_version: 4 }), { source: "event" })).toBe(true)
  })
})

// Fix-C §7.7: A live event with a different plan_id is an identity conflict. The admission gate
// must detect it so the caller (server-sync.tsx) can trigger a snapshot recalibration.
describe("session plan identity conflict detection", () => {
  test("detects identity conflict when live event has a different plan_id", () => {
    const current = sessionPlan({ plan_id: "plan-1" })
    const incoming = sessionPlan({ plan_id: "plan-2", plan_version: 1 })
    expect(hasSessionPlanIdentityConflict(current, incoming)).toBe(true)
  })

  test("no conflict when plan_id is the same (even with a higher version)", () => {
    const current = sessionPlan({ plan_id: "plan-1", plan_version: 3 })
    const incoming = sessionPlan({ plan_id: "plan-1", plan_version: 4 })
    expect(hasSessionPlanIdentityConflict(current, incoming)).toBe(false)
  })

  test("no conflict when current is undefined (first event)", () => {
    expect(hasSessionPlanIdentityConflict(undefined, sessionPlan())).toBe(false)
  })

  test("no conflict when incoming is undefined", () => {
    expect(hasSessionPlanIdentityConflict(sessionPlan(), undefined)).toBe(false)
  })

  // This test documents the recalibration contract: a different-identity live event is REJECTED
  // by acceptsSessionPlanUpdate (snapshotCanRecalibrate is false for event source), but the
  // caller (server-sync.tsx) must trigger recalibrateSessionPlan when hasSessionPlanIdentityConflict
  // returns true. The snapshot recalibration is what authorises the identity transition.
  test("different-identity live event is rejected by admission but triggers recalibration via conflict flag", () => {
    const current = sessionPlan({ plan_id: "plan-1" })
    const incoming = sessionPlan({ plan_id: "plan-2", plan_version: 1 })
    // Admission rejects the different-identity live event (no snapshot baseline provided)
    expect(acceptsSessionPlanUpdate(current, incoming, { source: "event" })).toBe(false)
    // But the conflict flag is set so the caller knows to fetch a fresh snapshot
    expect(hasSessionPlanIdentityConflict(current, incoming)).toBe(true)
  })
})

describe("session plan reconnect snapshots", () => {
  test("requests authority snapshots for retained sessions that already have plans", async () => {
    const calls: Array<{ directory: string; sessionID: string }> = []

    await syncRetainedSessionPlanSnapshots({
      stores: {
        "/workspace/a": { session: [{ id: "session-a" }, { id: "session-without-plan" }] },
        "/workspace/b": { session: [{ id: "session-b" }] },
      },
      plans: {
        "session-a": sessionPlan({ plan_id: "plan-a" }),
        "session-b": sessionPlan({ plan_id: "plan-b" }),
      },
      sync: async (directory, sessionID) => {
        calls.push({ directory, sessionID })
      },
    })

    expect(calls).toEqual([
      { directory: "/workspace/a", sessionID: "session-a" },
      { directory: "/workspace/b", sessionID: "session-b" },
    ])
  })
})

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessionsWithFallback", () => {
  test("uses limited roots query when supported", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 10,
      list: async (query) => {
        calls.push(query)
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", roots: true, limit: 10 }])
  })

  test("falls back to full roots query on limited-query failure", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 25,
      list: async (query) => {
        calls.push(query)
        if (query.limit) throw new Error("unsupported")
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(false)
    expect(calls).toEqual([
      { directory: "dir", roots: true, limit: 25 },
      { directory: "dir", roots: true },
    ])
  })
})

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})
