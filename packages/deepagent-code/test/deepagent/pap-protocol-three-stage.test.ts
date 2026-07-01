import { describe, it, expect } from "bun:test"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"

// P1A: a fake in-memory adapter implementing collect→parse→normalize produces a
// valid NormalizedProfile. No process spawning — the "native report" is in-memory.

// A complete cpu_sampling mapping (perf-like): every domain-applicable metric is
// either mapped present or honestly declared null.
const perfLikeMapping = (): PAP.MetricMapping => ({
  adapterId: "fake-perf",
  domain: "cpu_sampling",
  availableMetrics: ["overhead", "cycles", "instructions", "cache-misses", "cache-references", "branch-misses", "branches"],
  entries: [
    { neutral: "self_pct", native: "overhead", semantic: "exact" },
    { neutral: "cpi", native: ["cycles", "instructions"], semantic: "exact", derived: false },
    { neutral: "ipc", native: ["instructions", "cycles"], semantic: "exact", derived: true, formula: "instructions / cycles" },
    { neutral: "clockticks", native: "cycles", semantic: "exact" },
    { neutral: "instructions_retired", native: "instructions", semantic: "exact" },
    { neutral: "cache_miss_rate", native: ["cache-misses", "cache-references"], semantic: "exact" },
    { neutral: "branch_misprediction_pct", native: ["branch-misses", "branches"], semantic: "exact" },
  ],
})

class FakePerfAdapter implements PAP.ProfileAdapter {
  readonly id = "fake-perf"
  readonly vendor = "cpu_generic" as const
  readonly domain = "cpu_sampling" as const
  readonly privileges = [{ kind: "perf_event_paranoid" as const, reason: "perf needs perf_event_paranoid", maxParanoid: 2 }]
  readonly mapping = perfLikeMapping()

  async collect(target: PAP.ProfileTarget): Promise<PAP.NativeReportRef> {
    return { path: `/tmp/${target.command}.perf.data`, format: "perf-data", bytes: 4096, exportCommand: "perf script" }
  }

  async parse(report: PAP.NativeReportRef): Promise<PAP.RawProfile> {
    return {
      adapterId: this.id,
      vendor: this.vendor,
      domain: this.domain,
      target: { command: "bench" },
      nativeSummary: {},
      availableMetrics: this.mapping.availableMetrics!,
      hotspots: [
        { name: "compute", kind: "symbol", self_pct: 62.5, nativeMetrics: { overhead: 62.5, cycles: 2000, instructions: 1000 } },
        { name: "io_wait", kind: "symbol", self_pct: 20.0, nativeMetrics: { overhead: 20.0, cycles: 800, instructions: 200 } },
      ],
      raw_report_ref: report,
    }
  }

  normalize(raw: PAP.RawProfile): PAP.NormalizedProfile {
    const hotspots: PAP.Hotspot[] = raw.hotspots.map((h) => {
      const cycles = Number(h.nativeMetrics["cycles"] ?? 0)
      const instructions = Number(h.nativeMetrics["instructions"] ?? 0)
      return {
        symbol: h.name,
        file_line: undefined, // P3A back-fills via LSPResolve
        self_pct: h.self_pct ?? 0,
        metrics: {
          self_pct: PAP.present(h.self_pct ?? 0, "pct", { nativeMetric: "overhead", semantic: "exact" }),
          cpi: PAP.present(cycles / instructions, "ratio", { nativeMetric: ["cycles", "instructions"], semantic: "exact" }),
          ipc: PAP.present(instructions / cycles, "ratio", {
            nativeMetric: ["instructions", "cycles"],
            semantic: "exact",
            derived: true,
            formula: "instructions / cycles",
          }),
          clockticks: PAP.present(cycles, "count", { nativeMetric: "cycles", semantic: "exact" }),
          instructions_retired: PAP.present(instructions, "count", { nativeMetric: "instructions", semantic: "exact" }),
          cache_miss_rate: PAP.missing("not_collected", "cache events not requested in this run"),
          branch_misprediction_pct: PAP.missing("not_collected"),
        },
      }
    })
    return {
      domain: this.domain,
      vendor: this.vendor,
      adapterId: this.id,
      target: raw.target,
      duration_ns: 1_500_000,
      hotspots,
      summary: {
        self_pct: PAP.present(100, "pct", { nativeMetric: "overhead", semantic: "exact" }),
      },
      raw_report_ref: raw.raw_report_ref,
    }
  }
}

describe("PAP three-stage protocol", () => {
  it("collect → parse → normalize yields a structurally valid NormalizedProfile", async () => {
    const adapter = new FakePerfAdapter()
    const ref = await adapter.collect({ command: "bench" })
    expect(ref.format).toBe("perf-data")

    const raw = await adapter.parse(ref)
    expect(raw.hotspots.length).toBe(2)
    // stage-2 still carries native names
    expect(Object.keys(raw.hotspots[0]!.nativeMetrics)).toContain("cycles")

    const np = adapter.normalize(raw)
    const structural = PAP.validateProfile(np)
    expect(structural.errors).toEqual([])
    expect(structural.ok).toBe(true)

    const conformance = Vocabulary.validateProfile(np)
    expect(conformance.errors).toEqual([])

    // neutral names only — no native leak
    expect(Object.keys(np.hotspots[0]!.metrics)).toContain("ipc")
    expect(Object.keys(np.hotspots[0]!.metrics)).not.toContain("cycles")
  })

  it("the adapter's mapping passes registration-time validation", () => {
    const v = Vocabulary.validateMapping(new FakePerfAdapter().mapping)
    expect(v.issues).toEqual([])
    expect(v.ok).toBe(true)
    expect(v.present).toContain("ipc")
  })

  it("native report stays a ref (spills to artifact), not inlined", async () => {
    const adapter = new FakePerfAdapter()
    const np = adapter.normalize(await adapter.parse(await adapter.collect({ command: "bench" })))
    expect(np.raw_report_ref.path).toContain(".perf.data")
    expect(np.raw_report_ref.bytes).toBeGreaterThan(0)
  })
})
