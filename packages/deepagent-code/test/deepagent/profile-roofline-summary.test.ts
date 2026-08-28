import { describe, it, expect } from "bun:test"
import { PAP } from "@/profile/pap"
import { ProfileService } from "@/profile/service"

// P4A (S1-v3.5): ProfileService.roofline classifies a NormalizedProfile into
// compute/memory/latency/balanced using only neutral vocabulary metrics.
// Works for BOTH GPU (gpu_kernel, gpu_timeline) and CPU (cpu_sampling, cpu_hotspot)
// profiles — the neutral vocabulary is the unifying layer.

// ——— helpers ————————————————————————————————————————————————————————————————

function makeSummary(metrics: Record<string, number | null>): Record<string, PAP.MetricValue> {
  const bag: Record<string, PAP.MetricValue> = {}
  for (const [key, val] of Object.entries(metrics)) {
    if (val === null) {
      bag[key] = PAP.missing("not_collected")
    } else {
      // provenance just needs to satisfy structural validation; exact native name
      // doesn't matter for roofline classification.
      bag[key] = PAP.present(val, "pct", { nativeMetric: key, semantic: "exact" })
    }
  }
  return bag
}

function makeSummaryRatio(metrics: Record<string, number | null>): Record<string, PAP.MetricValue> {
  const bag: Record<string, PAP.MetricValue> = {}
  for (const [key, val] of Object.entries(metrics)) {
    if (val === null) {
      bag[key] = PAP.missing("not_collected")
    } else {
      bag[key] = PAP.present(val, "ratio", { nativeMetric: key, semantic: "exact" })
    }
  }
  return bag
}

function fakeGpuKernelProfile(summary: Record<string, PAP.MetricValue>): PAP.NormalizedProfile {
  return {
    domain: "gpu_kernel",
    vendor: "nvidia",
    adapterId: "fake-ncu",
    target: { command: "bench" },
    duration_ns: 10_000,
    hotspots: [],
    summary,
    raw_report_ref: { path: "/tmp/bench.ncu-rep", format: "ncu-rep" },
  }
}

function fakeGpuTimelineProfile(summary: Record<string, PAP.MetricValue>): PAP.NormalizedProfile {
  return {
    domain: "gpu_timeline",
    vendor: "nvidia",
    adapterId: "fake-nsys",
    target: { command: "bench" },
    duration_ns: 100_000,
    hotspots: [],
    summary,
    raw_report_ref: { path: "/tmp/bench.nsys-rep", format: "nsys-rep" },
  }
}

function fakeCpuProfile(
  domain: PAP.Domain,
  summary: Record<string, PAP.MetricValue>,
): PAP.NormalizedProfile {
  return {
    domain,
    vendor: "cpu_generic",
    adapterId: "fake-perf",
    target: { command: "bench" },
    duration_ns: 2_000_000,
    hotspots: [],
    summary,
    raw_report_ref: { path: "/tmp/bench.perf.data", format: "perf-data" },
  }
}

// ——— GPU kernel scenarios ——————————————————————————————————————————————————

describe("ProfileService.roofline — GPU kernel", () => {
  it("compute-bound: high compute throughput, moderate memory throughput, good occupancy", () => {
    const profile = fakeGpuKernelProfile(makeSummary({
      compute_throughput_pct: 87,
      memory_throughput_pct: 42,
      dram_bandwidth_pct: 38,
      occupancy_pct: 75,
    }))
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("compute")
    expect(r.derived).toBe(true)
    expect(r.detail).toContain("compute-bound")
    expect(r.detail).toContain("compute_throughput_pct=87.0%")
    expect(r.detail).toContain("memory_throughput_pct=42.0%")
  })

  it("memory-bound: high DRAM bandwidth utilization", () => {
    const profile = fakeGpuKernelProfile(makeSummary({
      compute_throughput_pct: 30,
      memory_throughput_pct: 60,
      dram_bandwidth_pct: 91,
      occupancy_pct: 70,
    }))
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("memory")
    expect(r.derived).toBe(true)
    expect(r.detail).toContain("memory-bound")
    expect(r.detail).toContain("dram_bandwidth_pct=91.0%")
  })

  it("memory-bound: high memory throughput even without DRAM metric", () => {
    const profile = fakeGpuKernelProfile(makeSummary({
      compute_throughput_pct: 40,
      memory_throughput_pct: 82,
      dram_bandwidth_pct: null,  // not available on this profiler
      occupancy_pct: 65,
    }))
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("memory")
    expect(r.detail).toContain("memory-bound")
  })

  it("latency-bound: low occupancy regardless of compute/memory metrics", () => {
    const profile = fakeGpuKernelProfile(makeSummary({
      compute_throughput_pct: 65,
      memory_throughput_pct: 55,
      dram_bandwidth_pct: 50,
      occupancy_pct: 28,
    }))
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("latency")
    expect(r.derived).toBe(true)
    expect(r.detail).toContain("latency-bound")
    expect(r.detail).toContain("occupancy_pct=28.0%")
  })

  it("balanced: no metric exceeds thresholds", () => {
    const profile = fakeGpuKernelProfile(makeSummary({
      compute_throughput_pct: 45,
      memory_throughput_pct: 48,
      dram_bandwidth_pct: 40,
      occupancy_pct: 60,
    }))
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("balanced")
    expect(r.derived).toBe(true)
    expect(r.detail).toContain("balanced")
  })

  it("still classifies when some metrics are null (not_collected)", () => {
    // Only compute_throughput_pct present, others missing
    const summary: Record<string, PAP.MetricValue> = {
      compute_throughput_pct: PAP.present(88, "pct", { nativeMetric: "sm__throughput", semantic: "exact" }),
      memory_throughput_pct: PAP.missing("not_collected"),
      dram_bandwidth_pct: PAP.missing("not_collected"),
      occupancy_pct: PAP.missing("not_collected"),
    }
    const profile = fakeGpuKernelProfile(summary)
    const r = ProfileService.roofline(profile)
    // With only compute_throughput_pct=88 and no occupancy to disqualify it,
    // should classify as compute-bound
    expect(r.bound).toBe("compute")
    expect(r.derived).toBe(true)
  })
})

// ——— GPU timeline scenarios ——————————————————————————————————————————————————

describe("ProfileService.roofline — GPU timeline", () => {
  it("memory-bound: high memory copy percent", () => {
    const profile = fakeGpuTimelineProfile(makeSummary({
      kernel_total_pct: 30,
      mem_copy_pct: 55,
      api_overhead_pct: 15,
    }))
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("memory")
    expect(r.detail).toContain("mem_copy_pct=55.0%")
  })

  it("compute-bound: high kernel total percent", () => {
    const profile = fakeGpuTimelineProfile(makeSummary({
      kernel_total_pct: 85,
      mem_copy_pct: 10,
      api_overhead_pct: 5,
    }))
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("compute")
    expect(r.detail).toContain("kernel_total_pct=85.0%")
  })

  it("latency-bound: high API overhead", () => {
    const profile = fakeGpuTimelineProfile(makeSummary({
      kernel_total_pct: 20,
      mem_copy_pct: 15,
      api_overhead_pct: 60,
    }))
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("latency")
    expect(r.detail).toContain("api_overhead_pct=60.0%")
  })

  it("balanced: no dominant factor", () => {
    const profile = fakeGpuTimelineProfile(makeSummary({
      kernel_total_pct: 40,
      mem_copy_pct: 20,
      api_overhead_pct: 15,
    }))
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("balanced")
  })
})

// ——— CPU scenarios ———————————————————————————————————————————————————————————

describe("ProfileService.roofline — CPU (cpu_sampling)", () => {
  it("compute-bound: high IPC, low cache miss rate", () => {
    // IPC is a ratio, not pct — use separate helper
    const summary: Record<string, PAP.MetricValue> = {
      ipc: PAP.present(2.8, "ratio", { nativeMetric: "ipc", semantic: "exact", derived: true, formula: "instructions/cycles" }),
      cache_miss_rate: PAP.present(0.02, "ratio", { nativeMetric: "cache_miss_rate", semantic: "exact" }),
      branch_misprediction_pct: PAP.present(2.0, "pct", { nativeMetric: "branch_misprediction_pct", semantic: "exact" }),
    }
    const profile = fakeCpuProfile("cpu_sampling", summary)
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("compute")
    expect(r.derived).toBe(true)
    expect(r.detail).toContain("compute-bound")
    expect(r.detail).toContain("ipc=2.80")
  })

  it("memory-bound: high cache miss rate", () => {
    const summary: Record<string, PAP.MetricValue> = {
      ipc: PAP.present(0.5, "ratio", { nativeMetric: "ipc", semantic: "exact", derived: true, formula: "instructions/cycles" }),
      cache_miss_rate: PAP.present(0.25, "ratio", { nativeMetric: "cache_miss_rate", semantic: "exact" }),
      branch_misprediction_pct: PAP.present(3.0, "pct", { nativeMetric: "branch_misprediction_pct", semantic: "exact" }),
    }
    const profile = fakeCpuProfile("cpu_sampling", summary)
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("memory")
    expect(r.derived).toBe(true)
    expect(r.detail).toContain("memory-bound")
    expect(r.detail).toContain("cache_miss_rate=25.0%")
  })

  it("latency-bound: high branch misprediction rate", () => {
    const summary: Record<string, PAP.MetricValue> = {
      ipc: PAP.present(1.0, "ratio", { nativeMetric: "ipc", semantic: "exact", derived: true, formula: "instructions/cycles" }),
      cache_miss_rate: PAP.present(0.03, "ratio", { nativeMetric: "cache_miss_rate", semantic: "exact" }),
      branch_misprediction_pct: PAP.present(18.0, "pct", { nativeMetric: "branch_misprediction_pct", semantic: "exact" }),
    }
    const profile = fakeCpuProfile("cpu_sampling", summary)
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("latency")
    expect(r.derived).toBe(true)
    expect(r.detail).toContain("latency-bound")
    expect(r.detail).toContain("branch_misprediction_pct=18.0%")
  })

  it("balanced: all metrics moderate", () => {
    const summary: Record<string, PAP.MetricValue> = {
      ipc: PAP.present(1.5, "ratio", { nativeMetric: "ipc", semantic: "exact", derived: true, formula: "instructions/cycles" }),
      cache_miss_rate: PAP.present(0.04, "ratio", { nativeMetric: "cache_miss_rate", semantic: "exact" }),
      branch_misprediction_pct: PAP.present(4.0, "pct", { nativeMetric: "branch_misprediction_pct", semantic: "exact" }),
    }
    const profile = fakeCpuProfile("cpu_sampling", summary)
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("balanced")
    expect(r.derived).toBe(true)
    expect(r.detail).toContain("balanced")
  })

  it("classifies cpu_hotspot domain the same way as cpu_sampling", () => {
    const summary: Record<string, PAP.MetricValue> = {
      ipc: PAP.present(0.3, "ratio", { nativeMetric: "ipc", semantic: "exact", derived: true, formula: "instructions/cycles" }),
      cache_miss_rate: PAP.present(0.30, "ratio", { nativeMetric: "cache_miss_rate", semantic: "exact" }),
      memory_bound_pct: PAP.present(55, "pct", { nativeMetric: "memory_bound_pct", semantic: "exact" }),
    }
    const profile = fakeCpuProfile("cpu_hotspot", summary)
    const r = ProfileService.roofline(profile)
    expect(r.bound).toBe("memory")
    expect(r.detail).toContain("memory-bound")
  })
})
