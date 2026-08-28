import { describe, it, expect } from "bun:test"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"

// P1A: the registration-time mapping validator accepts a complete mapping and
// flags incomplete / invalid ones. This is the anti-套壳 gate.

const completeGpuKernelMapping = (): PAP.MetricMapping => ({
  adapterId: "ncu-like",
  domain: "gpu_kernel",
  availableMetrics: [
    "sm__throughput.avg.pct_of_peak_sustained_elapsed",
    "gpu__compute_memory_throughput.avg.pct_of_peak_sustained_elapsed",
    "gpu__dram_throughput.avg.pct_of_peak_sustained_elapsed",
    "lts__throughput.avg.pct_of_peak_sustained_elapsed",
    "sm__warps_active.avg.pct_of_peak_sustained_active",
    "sm__pipe_fma_cycles_active.avg.pct_of_peak_sustained_elapsed",
    "gpu__time_duration.sum",
  ],
  entries: [
    { neutral: "compute_throughput_pct", native: "sm__throughput.avg.pct_of_peak_sustained_elapsed", semantic: "exact" },
    { neutral: "memory_throughput_pct", native: "gpu__compute_memory_throughput.avg.pct_of_peak_sustained_elapsed", semantic: "exact" },
    { neutral: "dram_bandwidth_pct", native: "gpu__dram_throughput.avg.pct_of_peak_sustained_elapsed", semantic: "exact" },
    { neutral: "l2_throughput_pct", native: "lts__throughput.avg.pct_of_peak_sustained_elapsed", semantic: "exact" },
    { neutral: "occupancy_pct", native: "sm__warps_active.avg.pct_of_peak_sustained_active", semantic: "exact" },
    { neutral: "valu_utilization_pct", native: "sm__pipe_fma_cycles_active.avg.pct_of_peak_sustained_elapsed", semantic: "approximate" },
    // ncu has no scalar-ALU counter → honest null, not fabricated.
    { neutral: "salu_busy_pct", native: null, reason: "metric_not_in_this_profiler", detail: "ncu has no SALU counter" },
    { neutral: "duration_ns", native: "gpu__time_duration.sum", semantic: "exact" },
    {
      neutral: "compute_bound",
      native: ["sm__throughput.avg.pct_of_peak_sustained_elapsed", "gpu__compute_memory_throughput.avg.pct_of_peak_sustained_elapsed"],
      semantic: "exact",
      derived: true,
      formula: "compute_throughput_pct > memory_throughput_pct + 10",
    },
  ],
})

describe("PAP mapping completeness validation", () => {
  it("accepts a complete, honest gpu_kernel mapping", () => {
    const v = Vocabulary.validateMapping(completeGpuKernelMapping())
    expect(v.issues).toEqual([])
    expect(v.ok).toBe(true)
    expect(v.present).toContain("compute_throughput_pct")
    expect(v.missing).toContain("salu_busy_pct")
  })

  it("flags missing coverage when an applicable metric is omitted", () => {
    const m = completeGpuKernelMapping()
    m.entries = m.entries.filter((e) => e.neutral !== "occupancy_pct")
    const v = Vocabulary.validateMapping(m)
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.kind === "missing_coverage" && i.metric === "occupancy_pct")).toBe(true)
  })

  it("flags a derived metric mapped without a formula (auditability)", () => {
    const m = completeGpuKernelMapping()
    m.entries = m.entries.map((e) =>
      e.neutral === "compute_bound" && PAP.isMappingPresent(e) ? { ...e, formula: undefined } : e,
    )
    const v = Vocabulary.validateMapping(m)
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.kind === "derived_without_formula")).toBe(true)
  })

  it("flags a null mapping with no reason (honesty requires a reason)", () => {
    const m = completeGpuKernelMapping()
    m.entries = m.entries.map((e) =>
      e.neutral === "salu_busy_pct" ? ({ neutral: "salu_busy_pct", native: null, reason: "" } as PAP.MetricMapEntry) : e,
    )
    const v = Vocabulary.validateMapping(m)
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.kind === "null_without_reason")).toBe(true)
  })

  it("flags a metric not applicable to the declared domain", () => {
    const m = completeGpuKernelMapping()
    m.entries = [...m.entries, { neutral: "cpi", native: "CPI Rate", semantic: "exact" }]
    const v = Vocabulary.validateMapping(m)
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.kind === "not_applicable_to_domain" && i.metric === "cpi")).toBe(true)
  })

  it("flags an unknown (fabricated) neutral metric name", () => {
    const m = completeGpuKernelMapping()
    m.entries = [...m.entries, { neutral: "made_up_metric", native: "foo", semantic: "exact" }]
    const v = Vocabulary.validateMapping(m)
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.kind === "unknown_metric")).toBe(true)
  })

  it("flags a mapped native metric not available on this machine (existence check)", () => {
    const m = completeGpuKernelMapping()
    m.availableMetrics = m.availableMetrics!.filter((n) => n !== "gpu__time_duration.sum")
    const v = Vocabulary.validateMapping(m)
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.kind === "native_not_available" && i.metric === "duration_ns")).toBe(true)
  })
})
