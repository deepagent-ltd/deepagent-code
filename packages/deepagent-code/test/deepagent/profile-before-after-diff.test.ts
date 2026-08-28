import { describe, it, expect } from "bun:test"
import { PAP } from "@/profile/pap"
import { ProfileService } from "@/profile/service"

// P4A (S1-v3.5): ProfileService.diff shows which hotspots improved/worsened
// between two profiling runs. Also validates cross-vendor diff capability: since
// both profiles use the neutral vocabulary, NVIDIA and AMD results are comparable.

// ——— helpers ————————————————————————————————————————————————————————————————

function makeHotspot(
  name: string,
  isKernel: boolean,
  selfPct: number,
  metrics: Record<string, number>,
): PAP.Hotspot {
  const bag: Record<string, PAP.MetricValue> = {}
  for (const [k, v] of Object.entries(metrics)) {
    bag[k] = PAP.present(v, "pct", { nativeMetric: k, semantic: "exact" })
  }
  return {
    ...(isKernel ? { kernel: name } : { symbol: name }),
    self_pct: selfPct,
    metrics: bag,
  }
}

function makeProfile(
  vendor: PAP.Vendor,
  domain: PAP.Domain,
  hotspots: PAP.Hotspot[],
  summary?: Record<string, PAP.MetricValue>,
): PAP.NormalizedProfile {
  return {
    domain,
    vendor,
    adapterId: vendor === "nvidia" ? "fake-ncu" : vendor === "amd" ? "fake-rocprof" : "fake-perf",
    target: { command: "bench" },
    duration_ns: 100_000,
    hotspots,
    summary: summary ?? {},
    raw_report_ref: { path: "/tmp/bench.rep", format: vendor === "nvidia" ? "ncu-rep" : vendor === "amd" ? "rocpd" : "perf-data" },
  }
}

// ——— same-vendor diff ————————————————————————————————————————————————————————

describe("ProfileService.diff — before/after optimization (same vendor)", () => {
  // Before: matmul_kernel hogs 72% and is memory-bound (DRAM=91%),
  //         reduce_kernel is 20%.
  const before = makeProfile("nvidia", "gpu_kernel", [
    makeHotspot("matmul_kernel", true, 72.5, {
      compute_throughput_pct: 30,
      dram_bandwidth_pct: 91,
      occupancy_pct: 65,
    }),
    makeHotspot("reduce_kernel", true, 20.1, {
      compute_throughput_pct: 50,
      dram_bandwidth_pct: 55,
      occupancy_pct: 70,
    }),
  ])

  // After optimisation: matmul_kernel now 40% (improved), reduce_kernel 25% (worsened slightly),
  // new vector_kernel 15% (added). old_helper_kernel (removed).
  const after = makeProfile("nvidia", "gpu_kernel", [
    makeHotspot("matmul_kernel", true, 40.0, {
      compute_throughput_pct: 82,
      dram_bandwidth_pct: 45,
      occupancy_pct: 80,
    }),
    makeHotspot("reduce_kernel", true, 25.0, {
      compute_throughput_pct: 48,
      dram_bandwidth_pct: 58,
      occupancy_pct: 68,
    }),
    makeHotspot("vector_kernel", true, 15.0, {
      compute_throughput_pct: 75,
      dram_bandwidth_pct: 40,
      occupancy_pct: 78,
    }),
  ])

  it("improved hotspot is correctly identified", () => {
    const d = ProfileService.diff(before, after)
    const matmul = d.hotspots.find((h) => h.name === "matmul_kernel")
    expect(matmul).toBeDefined()
    expect(matmul!.status).toBe("improved")
    expect(matmul!.self_pct_before).toBe(72.5)
    expect(matmul!.self_pct_after).toBe(40.0)
    expect(matmul!.self_pct_delta).toBeCloseTo(-32.5, 5)
  })

  it("worsened hotspot is correctly identified", () => {
    const d = ProfileService.diff(before, after)
    const reduce = d.hotspots.find((h) => h.name === "reduce_kernel")
    expect(reduce).toBeDefined()
    expect(reduce!.status).toBe("worsened")
    expect(reduce!.self_pct_before).toBe(20.1)
    expect(reduce!.self_pct_after).toBe(25.0)
    expect(reduce!.self_pct_delta).toBeCloseTo(4.9, 2)
  })

  it("added hotspot (new in after) is detected", () => {
    const d = ProfileService.diff(before, after)
    const added = d.hotspots.find((h) => h.name === "vector_kernel")
    expect(added).toBeDefined()
    expect(added!.status).toBe("added")
    expect(added!.self_pct_after).toBe(15.0)
    expect(added!.self_pct_before).toBeUndefined()
  })

  it("removed hotspot (in before, absent in after) is detected", () => {
    // Add a hotspot only in "before" to verify removal detection
    const beforeWithExtra = makeProfile("nvidia", "gpu_kernel", [
      ...before.hotspots,
      makeHotspot("old_helper_kernel", true, 5.0, { compute_throughput_pct: 20 }),
    ])
    const d = ProfileService.diff(beforeWithExtra, after)
    const removed = d.hotspots.find((h) => h.name === "old_helper_kernel")
    expect(removed).toBeDefined()
    expect(removed!.status).toBe("removed")
    expect(removed!.self_pct_before).toBe(5.0)
    expect(removed!.self_pct_after).toBeUndefined()
  })

  it("per-metric deltas show how metrics changed (e.g. DRAM bandwidth improved)", () => {
    const d = ProfileService.diff(before, after)
    const matmul = d.hotspots.find((h) => h.name === "matmul_kernel")!
    const dramDiff = matmul.metrics_diff["dram_bandwidth_pct"]
    expect(dramDiff).toBeDefined()
    expect(dramDiff!.before).toBe(91)
    expect(dramDiff!.after).toBe(45)
    expect(dramDiff!.delta).toBeCloseTo(-46, 5)  // negative = bandwidth pressure reduced
  })

  it("improved hotspots sort before worsened in the result", () => {
    const d = ProfileService.diff(before, after)
    const statuses = d.hotspots.map((h) => h.status)
    const firstWorsened = statuses.indexOf("worsened")
    const lastImproved = statuses.lastIndexOf("improved")
    // All improved must come before any worsened
    expect(lastImproved).toBeLessThan(firstWorsened)
  })

  it("cross_vendor is false for same-vendor comparison", () => {
    const d = ProfileService.diff(before, after)
    expect(d.cross_vendor).toBe(false)
    expect(d.vendor_a).toBe("nvidia")
    expect(d.vendor_b).toBe("nvidia")
  })
})

// ——— cross-vendor diff ——————————————————————————————————————————————————————

describe("ProfileService.diff — cross-vendor (NVIDIA ncu vs AMD rocprof)", () => {
  // Same program profiled on NVIDIA (before migration) and AMD (after migration).
  // Shared neutral metrics are comparable; vendor-specific metrics will have delta=null.
  const nvidiaProd = makeProfile("nvidia", "gpu_kernel", [
    makeHotspot("matmul_kernel", true, 68.0, {
      compute_throughput_pct: 85,
      dram_bandwidth_pct: 35,
      occupancy_pct: 72,
      // salu_busy_pct NOT present (ncu doesn't have it)
    }),
  ])

  const amdProd = makeProfile("amd", "gpu_kernel", [
    makeHotspot("matmul_kernel", true, 71.0, {
      compute_throughput_pct: 78,
      dram_bandwidth_pct: 40,
      occupancy_pct: 68,
      salu_busy_pct: 22,  // AMD-native metric, missing on NVIDIA side
    }),
  ])

  it("cross_vendor flag is set and a note is included", () => {
    const d = ProfileService.diff(nvidiaProd, amdProd)
    expect(d.cross_vendor).toBe(true)
    expect(d.vendor_a).toBe("nvidia")
    expect(d.vendor_b).toBe("amd")
    expect(d.note).toBeDefined()
    expect(d.note).toContain("nvidia")
    expect(d.note).toContain("amd")
  })

  it("shared neutral metrics (compute_throughput_pct) produce a real delta", () => {
    const d = ProfileService.diff(nvidiaProd, amdProd)
    const matmul = d.hotspots.find((h) => h.name === "matmul_kernel")!
    const computeDiff = matmul.metrics_diff["compute_throughput_pct"]
    expect(computeDiff).toBeDefined()
    expect(computeDiff!.before).toBe(85)
    expect(computeDiff!.after).toBe(78)
    expect(computeDiff!.delta).toBeCloseTo(-7, 5)
  })

  it("AMD-only metric (salu_busy_pct) has delta=null (honest gap, not fabricated)", () => {
    const d = ProfileService.diff(nvidiaProd, amdProd)
    const matmul = d.hotspots.find((h) => h.name === "matmul_kernel")!
    // salu_busy_pct is present in AMD but missing from NVIDIA side
    const saluDiff = matmul.metrics_diff["salu_busy_pct"]
    if (saluDiff) {
      // If the key appears, delta must be null since one side is missing
      expect(saluDiff.delta).toBeNull()
      expect(saluDiff.before).toBeNull()  // NVIDIA didn't report it
    }
    // It's also acceptable for the key to be absent from NVIDIA's metrics bag
    // Either way, no fabricated value is present
  })

  it("summary diff is also populated for cross-vendor comparison", () => {
    const nvidiaWithSummary = {
      ...nvidiaProd,
      summary: { compute_throughput_pct: PAP.present(85, "pct", { nativeMetric: "sm__throughput", semantic: "exact" }) },
    }
    const amdWithSummary = {
      ...amdProd,
      summary: { compute_throughput_pct: PAP.present(78, "pct", { nativeMetric: "GPUBusy", semantic: "approximate" }) },
    }
    const d = ProfileService.diff(nvidiaWithSummary, amdWithSummary)
    expect(d.summary_diff["compute_throughput_pct"]).toBeDefined()
    expect(d.summary_diff["compute_throughput_pct"]!.before).toBe(85)
    expect(d.summary_diff["compute_throughput_pct"]!.after).toBe(78)
    expect(d.summary_diff["compute_throughput_pct"]!.delta).toBeCloseTo(-7, 5)
  })
})

// ——— CPU before/after diff ——————————————————————————————————————————————————

describe("ProfileService.diff — CPU before/after", () => {
  const before = makeProfile("cpu_generic", "cpu_sampling", [
    makeHotspot("compress_block", false, 45.0, { ipc: 0.8, cache_miss_rate: 0.22 }),
    makeHotspot("hash_compute", false, 30.0, { ipc: 2.1, cache_miss_rate: 0.03 }),
  ])

  const after = makeProfile("cpu_generic", "cpu_sampling", [
    // compress_block now much faster due to cache-friendly access
    makeHotspot("compress_block", false, 18.0, { ipc: 1.9, cache_miss_rate: 0.04 }),
    makeHotspot("hash_compute", false, 32.0, { ipc: 2.0, cache_miss_rate: 0.03 }),
  ])

  it("CPU hotspot improvement after cache-friendly rewrite is detected", () => {
    const d = ProfileService.diff(before, after)
    const compress = d.hotspots.find((h) => h.name === "compress_block")!
    expect(compress.status).toBe("improved")
    expect(compress.self_pct_delta).toBeCloseTo(-27, 1)
  })

  it("CPU metric delta shows cache_miss_rate improved", () => {
    const d = ProfileService.diff(before, after)
    const compress = d.hotspots.find((h) => h.name === "compress_block")!
    const missDiff = compress.metrics_diff["cache_miss_rate"]
    expect(missDiff).toBeDefined()
    expect(missDiff!.before).toBe(0.22)
    expect(missDiff!.after).toBe(0.04)
    expect(missDiff!.delta).toBeCloseTo(-0.18, 5)
  })

  it("diff result has correct vendor/domain metadata", () => {
    const d = ProfileService.diff(before, after)
    expect(d.cross_vendor).toBe(false)
    expect(d.vendor_a).toBe("cpu_generic")
    expect(d.vendor_b).toBe("cpu_generic")
    expect(d.domain_a).toBe("cpu_sampling")
    expect(d.domain_b).toBe("cpu_sampling")
  })
})
