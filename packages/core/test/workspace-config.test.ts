import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { WorkspaceConfig } from "@deepagent-code/core/deepagent/workspace-config"
import { Database } from "@deepagent-code/core/database/database"
import { testEffect } from "./lib/effect"

// V4.0 — per-workspace config store. Verifies defaulting (absent/partial row → lenient defaults),
// upsert/merge, and isolation. Four subsystems (retention/quiet-hours/rate-limits/trusted-sources)
// read the resolved view.

let clock = 0
const now = () => clock
const setNow = (t: number) => {
  clock = t
}

const database = Database.layerFromPath(":memory:")
const it = testEffect(WorkspaceConfig.layerWith({ now }).pipe(Layer.provideMerge(database)))

describe("WorkspaceConfig", () => {
  it.effect("absent row → defaults (30d retention, no quiet hours, only first-party sources trusted)", () =>
    Effect.gen(function* () {
      const cfg = yield* WorkspaceConfig.Service
      const r = yield* cfg.get("wrk_never_written")
      expect(r.retentionDays).toBe(WorkspaceConfig.DEFAULT_RETENTION_DAYS)
      expect(r.quietHours).toBeUndefined()
      expect(r.trustedSources).toEqual(WorkspaceConfig.DEFAULT_TRUSTED_SOURCES)
      expect(r.rateLimits).toEqual({})
    }),
  )

  it.effect("§E1 fail-closed default: DEFAULT_TRUSTED_SOURCES is first-party only (im/system/schedule)", () =>
    Effect.gen(function* () {
      // the trust boundary is opt-IN: external webhook sources (git/ci/pr/monitor) are NOT trusted by
      // default and must be explicitly vouched for per-workspace.
      expect(WorkspaceConfig.DEFAULT_TRUSTED_SOURCES).toEqual(["im", "system", "schedule"])
      const cfg = yield* WorkspaceConfig.Service
      const r = yield* cfg.get("wrk_default_trust")
      // an unconfigured workspace does NOT trust "git" (an external webhook) at L1.
      expect(r.trustedSources.includes("git")).toBe(false)
      expect(r.trustedSources.includes("ci")).toBe(false)
      expect(r.trustedSources.includes("im")).toBe(true)
    }),
  )

  it.effect("set + get round-trips a full config", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_1", {
        retentionDays: 7,
        quietHours: { startHour: 22, endHour: 6, tzOffsetMinutes: 480 },
        rateLimits: { eventPublishPerMinute: 500, agentExecConcurrent: 3 },
        trustedSources: ["im", "system"],
      })
      const r = yield* cfg.get("wrk_1")
      expect(r.retentionDays).toBe(7)
      expect(r.quietHours).toEqual({ startHour: 22, endHour: 6, tzOffsetMinutes: 480 })
      expect(r.rateLimits.eventPublishPerMinute).toBe(500)
      expect(r.rateLimits.agentExecConcurrent).toBe(3)
      expect(r.trustedSources).toEqual(["im", "system"])
    }),
  )

  it.effect("set merges a partial patch over the existing config", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_2", { retentionDays: 14 })
      yield* cfg.set("wrk_2", { quietHours: { startHour: 20, endHour: 8, tzOffsetMinutes: 0 } })
      const r = yield* cfg.get("wrk_2")
      expect(r.retentionDays).toBe(14) // preserved across the second patch
      expect(r.quietHours?.startHour).toBe(20)
    }),
  )

  it.effect("a non-positive retentionDays falls back to the default (never zero-retention)", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_3", { retentionDays: 0 })
      const r = yield* cfg.get("wrk_3")
      expect(r.retentionDays).toBe(WorkspaceConfig.DEFAULT_RETENTION_DAYS)
    }),
  )

  it.effect("an empty trustedSources list falls back to defaults (never trust-nothing lockout)", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_4", { trustedSources: [] })
      const r = yield* cfg.get("wrk_4")
      expect(r.trustedSources).toEqual(WorkspaceConfig.DEFAULT_TRUSTED_SOURCES)
    }),
  )

  it.effect("workspace isolation: one workspace's config never bleeds into another", () =>
    Effect.gen(function* () {
      setNow(1_000)
      const cfg = yield* WorkspaceConfig.Service
      yield* cfg.set("wrk_a", { retentionDays: 3 })
      const b = yield* cfg.get("wrk_b")
      expect(b.retentionDays).toBe(WorkspaceConfig.DEFAULT_RETENTION_DAYS) // unaffected
    }),
  )
})

// §E4 — quiet-hours schema range validation. startHour/endHour must be a valid hour-of-day [0,23]. An
// out-of-range endHour (e.g. 24) would make the quiet window never exit (isWithinQuietHours compares
// against hour-of-day in [0,24)), deferring low/normal pushes into the digest indefinitely, so the
// schema must reject it at decode time rather than silently accepting the misconfig.
describe("QuietHoursConfig hour-of-day range", () => {
  const decode = Schema.decodeUnknownSync(WorkspaceConfig.QuietHoursConfig)
  const rejects = (input: unknown) => expect(() => decode(input)).toThrow()

  test("rejects endHour: 24 (never-exit quiet window)", () => {
    rejects({ startHour: 22, endHour: 24, tzOffsetMinutes: 0 })
  })

  test("rejects startHour: -1 (below range)", () => {
    rejects({ startHour: -1, endHour: 6, tzOffsetMinutes: 0 })
  })

  test("rejects startHour: 24 (above range)", () => {
    rejects({ startHour: 24, endHour: 6, tzOffsetMinutes: 0 })
  })

  test("accepts boundary values 0 and 23", () => {
    expect(decode({ startHour: 0, endHour: 23, tzOffsetMinutes: 0 })).toEqual({
      startHour: 0,
      endHour: 23,
      tzOffsetMinutes: 0,
    })
    expect(decode({ startHour: 23, endHour: 0, tzOffsetMinutes: 480 })).toEqual({
      startHour: 23,
      endHour: 0,
      tzOffsetMinutes: 480,
    })
  })
})
