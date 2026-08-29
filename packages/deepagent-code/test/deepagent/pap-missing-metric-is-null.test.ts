import { describe, it, expect } from "bun:test"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"

// P1A acceptance (c): a metric the (fake) profiler lacks is `null` with a reason —
// never fabricated, never back-filled from a different metric.

// perf cannot produce topdown µarch metrics without `perf stat topdown`; here the
// fake perf exposes only sampling events, so memory_bound_pct / dram_bound_pct are
// honestly absent. (cpu_hotspot domain is where those apply.)
const perfLike: PAP.ProfileAdapter = {
  id: "perf-like",
  vendor: "cpu_generic",
  domain: "cpu_hotspot",
  privileges: [{ kind: "perf_event_paranoid", reason: "perf needs perf_event_paranoid", maxParanoid: 2 }],
  mapping: {
    adapterId: "perf-like",
    domain: "cpu_hotspot",
    availableMetrics: ["overhead", "cycles", "instructions", "cache-misses", "cache-references", "branch-misses", "branches"],
    entries: [
      { neutral: "self_pct", native: "overhead", semantic: "exact" },
      { neutral: "cpi", native: ["cycles", "instructions"], semantic: "exact" },
      { neutral: "ipc", native: ["instructions", "cycles"], semantic: "exact", derived: true, formula: "instructions / cycles" },
      { neutral: "clockticks", native: "cycles", semantic: "exact" },
      { neutral: "instructions_retired", native: "instructions", semantic: "exact" },
      { neutral: "cache_miss_rate", native: ["cache-misses", "cache-references"], semantic: "exact" },
      { neutral: "branch_misprediction_pct", native: ["branch-misses", "branches"], semantic: "exact" },
      // honest nulls: perf (sampling only) cannot produce topdown pipeline-slot metrics.
      { neutral: "memory_bound_pct", native: null, reason: "metric_not_in_this_profiler", detail: "needs perf stat topdown" },
      { neutral: "dram_bound_pct", native: null, reason: "metric_not_in_this_profiler" },
    ],
  },
  async collect() {
    return { path: "/tmp/perf.data", format: "perf-data" as const }
  },
  async parse(ref) {
    return {
      adapterId: "perf-like",
      vendor: "cpu_generic",
      domain: "cpu_hotspot",
      target: { command: "app" },
      nativeSummary: {},
      hotspots: [{ name: "hot_fn", kind: "symbol", self_pct: 90, nativeMetrics: { cycles: 1000, instructions: 1500 } }],
      raw_report_ref: ref,
    }
  },
  normalize(raw) {
    const h = raw.hotspots[0]!
    const cycles = Number(h.nativeMetrics["cycles"])
    const instructions = Number(h.nativeMetrics["instructions"])
    return {
      domain: "cpu_hotspot",
      vendor: "cpu_generic",
      adapterId: "perf-like",
      target: raw.target,
      hotspots: [
        {
          symbol: "hot_fn",
          self_pct: 90,
          metrics: {
            self_pct: PAP.present(90, "pct", { nativeMetric: "overhead", semantic: "exact" }),
            ipc: PAP.present(instructions / cycles, "ratio", {
              nativeMetric: ["instructions", "cycles"],
              semantic: "exact",
              derived: true,
              formula: "instructions / cycles",
            }),
            // the metrics perf can't produce: honest null + reason, NOT a fabricated number.
            memory_bound_pct: PAP.missing("metric_not_in_this_profiler", "needs perf stat topdown"),
            dram_bound_pct: PAP.missing("not_supported_on_arch"),
          },
        },
      ],
      summary: {
        memory_bound_pct: PAP.missing("metric_not_in_this_profiler"),
      },
      raw_report_ref: raw.raw_report_ref,
    }
  },
}

describe("PAP missing metric is honest null", () => {
  it("a metric the profiler lacks is null + reason, never a number", async () => {
    const np = perfLike.normalize(await perfLike.parse(await perfLike.collect({ command: "app" })))
    const mb = np.hotspots[0]!.metrics["memory_bound_pct"]!
    expect(PAP.isMissing(mb)).toBe(true)
    expect(mb.value).toBeNull()
    if (PAP.isMissing(mb)) {
      expect(mb.reason).toBe("metric_not_in_this_profiler")
      expect(mb.detail).toContain("topdown")
    }
    // ipc, in contrast, IS present (derived) — null is only for the genuinely absent.
    expect(PAP.isPresent(np.hotspots[0]!.metrics["ipc"]!)).toBe(true)
  })

  it("the profile still validates with honest nulls present", async () => {
    const np = perfLike.normalize(await perfLike.parse(await perfLike.collect({ command: "app" })))
    expect(PAP.validateProfile(np).errors).toEqual([])
    expect(Vocabulary.validateProfile(np).errors).toEqual([])
  })

  it("a null without a reason is rejected by structural validation", () => {
    const bad: PAP.NormalizedProfile = {
      domain: "cpu_hotspot",
      vendor: "cpu_generic",
      adapterId: "perf-like",
      target: { command: "app" },
      hotspots: [
        {
          symbol: "x",
          self_pct: 1,
          // a null with an empty reason = dishonest omission; must be flagged.
          metrics: { memory_bound_pct: { value: null, reason: "" } as PAP.MetricValue },
        },
      ],
      summary: {},
      raw_report_ref: { path: "/tmp/x", format: "perf-data" },
    }
    const v = PAP.validateProfile(bad)
    expect(v.ok).toBe(false)
    expect(v.errors.some((e) => e.includes("no reason"))).toBe(true)
  })

  it("the mapping with honest nulls passes registration validation", () => {
    const v = Vocabulary.validateMapping(perfLike.mapping)
    expect(v.issues).toEqual([])
    expect(v.missing).toContain("memory_bound_pct")
    expect(v.missing).toContain("dram_bound_pct")
  })
})
