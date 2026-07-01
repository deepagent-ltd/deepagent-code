import { describe, it, expect } from "bun:test"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"

// P1A acceptance (b): two adapters from different vendors both normalize to the
// SAME neutral hotspot[] shape and comparable, vendor-neutral metrics. If this
// holds, PAP is not a 套壳 — a consumer can rank/compare without knowing the vendor.

// --- ncu-like (NVIDIA, gpu_kernel) -----------------------------------------
const ncuLike: PAP.ProfileAdapter = {
  id: "ncu-like",
  vendor: "nvidia",
  domain: "gpu_kernel",
  privileges: [{ kind: "gpu_performance_counter", reason: "ncu needs GPU counters" }],
  mapping: {
    adapterId: "ncu-like",
    domain: "gpu_kernel",
    entries: [
      { neutral: "compute_throughput_pct", native: "sm__throughput.avg.pct_of_peak_sustained_elapsed", semantic: "exact" },
      { neutral: "memory_throughput_pct", native: "gpu__compute_memory_throughput.avg.pct_of_peak_sustained_elapsed", semantic: "exact" },
      { neutral: "dram_bandwidth_pct", native: "gpu__dram_throughput.avg.pct_of_peak_sustained_elapsed", semantic: "exact" },
      { neutral: "l2_throughput_pct", native: "lts__throughput.avg.pct_of_peak_sustained_elapsed", semantic: "exact" },
      { neutral: "occupancy_pct", native: "sm__warps_active.avg.pct_of_peak_sustained_active", semantic: "exact" },
      { neutral: "valu_utilization_pct", native: "sm__pipe_fma_cycles_active.avg.pct_of_peak_sustained_elapsed", semantic: "approximate" },
      { neutral: "salu_busy_pct", native: null, reason: "metric_not_in_this_profiler" },
      { neutral: "duration_ns", native: "gpu__time_duration.sum", semantic: "exact" },
      { neutral: "compute_bound", native: ["sm__throughput...", "gpu__compute_memory_throughput..."], semantic: "exact", derived: true, formula: "compute>memory+10" },
    ],
  },
  async collect() {
    return { path: "/tmp/r.ncu-rep", format: "ncu-rep" as const }
  },
  async parse(ref) {
    return {
      adapterId: "ncu-like",
      vendor: "nvidia",
      domain: "gpu_kernel",
      target: { command: "matmul" },
      nativeSummary: {},
      hotspots: [{ name: "sgemm_kernel", kind: "kernel", total_pct: 80, self_pct: 80, nativeMetrics: {} }],
      raw_report_ref: ref,
    }
  },
  normalize(raw) {
    return {
      domain: "gpu_kernel",
      vendor: "nvidia",
      adapterId: "ncu-like",
      target: raw.target,
      duration_ns: 900_000,
      hotspots: [
        {
          kernel: "sgemm_kernel",
          self_pct: 80,
          total_pct: 80,
          metrics: {
            compute_throughput_pct: PAP.present(72, "pct", { nativeMetric: "sm__throughput", semantic: "exact" }),
            occupancy_pct: PAP.present(55, "pct", { nativeMetric: "sm__warps_active", semantic: "exact" }),
            salu_busy_pct: PAP.missing("metric_not_in_this_profiler"),
          },
        },
      ],
      summary: { occupancy_pct: PAP.present(55, "pct", { nativeMetric: "sm__warps_active", semantic: "exact" }) },
      raw_report_ref: raw.raw_report_ref,
    }
  },
}

// --- rocprof-like (AMD, gpu_kernel) ----------------------------------------
const rocprofLike: PAP.ProfileAdapter = {
  id: "rocprof-like",
  vendor: "amd",
  domain: "gpu_kernel",
  privileges: [{ kind: "rocm_profiling", reason: "rocprof needs ROCm profiling access" }],
  mapping: {
    adapterId: "rocprof-like",
    domain: "gpu_kernel",
    entries: [
      { neutral: "compute_throughput_pct", native: "GPUBusy", semantic: "approximate" },
      { neutral: "memory_throughput_pct", native: "MemUnitBusy", semantic: "exact" },
      { neutral: "dram_bandwidth_pct", native: ["FetchSize", "WriteSize"], semantic: "approximate" },
      // AMD L2CacheHit is a hit-RATE, neutral l2_throughput_pct is THROUGHPUT — explicitly approximate.
      { neutral: "l2_throughput_pct", native: "L2CacheHit", semantic: "approximate" },
      { neutral: "occupancy_pct", native: "Wavefronts", semantic: "approximate" },
      { neutral: "valu_utilization_pct", native: "VALUUtilization", semantic: "exact" },
      { neutral: "salu_busy_pct", native: "SALUBusy", semantic: "exact" },
      { neutral: "duration_ns", native: "rocpd.kernel.ts", semantic: "exact" },
      { neutral: "compute_bound", native: ["GPUBusy", "MemUnitBusy"], semantic: "approximate", derived: true, formula: "GPUBusy>MemUnitBusy+10" },
    ],
  },
  async collect() {
    return { path: "/tmp/r.rocpd", format: "rocpd" as const }
  },
  async parse(ref) {
    return {
      adapterId: "rocprof-like",
      vendor: "amd",
      domain: "gpu_kernel",
      target: { command: "matmul" },
      nativeSummary: {},
      hotspots: [{ name: "Cijk_gemm", kind: "kernel", total_pct: 78, self_pct: 78, nativeMetrics: {} }],
      raw_report_ref: ref,
    }
  },
  normalize(raw) {
    return {
      domain: "gpu_kernel",
      vendor: "amd",
      adapterId: "rocprof-like",
      target: raw.target,
      duration_ns: 1_050_000,
      hotspots: [
        {
          kernel: "Cijk_gemm",
          self_pct: 78,
          total_pct: 78,
          metrics: {
            // GPUBusy → compute_throughput_pct is approximate (semantic flagged honestly).
            compute_throughput_pct: PAP.present(68, "pct", { nativeMetric: "GPUBusy", semantic: "approximate" }),
            occupancy_pct: PAP.present(60, "pct", { nativeMetric: "Wavefronts", semantic: "approximate" }),
            salu_busy_pct: PAP.present(12, "pct", { nativeMetric: "SALUBusy", semantic: "exact" }),
          },
        },
      ],
      summary: { occupancy_pct: PAP.present(60, "pct", { nativeMetric: "Wavefronts", semantic: "approximate" }) },
      raw_report_ref: raw.raw_report_ref,
    }
  },
}

const run = async (a: PAP.ProfileAdapter) => a.normalize(await a.parse(await a.collect({ command: "matmul" })))

describe("PAP cross-vendor comparability", () => {
  it("both vendors normalize to a valid, vocabulary-conformant profile", async () => {
    for (const a of [ncuLike, rocprofLike]) {
      const np = await run(a)
      expect(PAP.validateProfile(np).errors).toEqual([])
      expect(Vocabulary.validateProfile(np).errors).toEqual([])
    }
  })

  it("produces the SAME neutral hotspot[] shape and comparable metric keys", async () => {
    const nv = await run(ncuLike)
    const amd = await run(rocprofLike)

    // Same neutral structure: one kernel hotspot each, identified by `kernel`, with self_pct.
    expect(nv.hotspots[0]!.kernel).toBeDefined()
    expect(amd.hotspots[0]!.kernel).toBeDefined()
    expect(typeof nv.hotspots[0]!.self_pct).toBe("number")
    expect(typeof amd.hotspots[0]!.self_pct).toBe("number")

    // Comparable metric: occupancy_pct exists on both, same neutral key + unit, comparable values.
    const nvOcc = nv.hotspots[0]!.metrics["occupancy_pct"]!
    const amdOcc = amd.hotspots[0]!.metrics["occupancy_pct"]!
    expect(PAP.isPresent(nvOcc) && PAP.isPresent(amdOcc)).toBe(true)
    if (PAP.isPresent(nvOcc) && PAP.isPresent(amdOcc)) {
      expect(nvOcc.unit).toBe(amdOcc.unit)
      // A vendor-agnostic consumer can compare them directly.
      expect(amdOcc.value as number).toBeGreaterThan(nvOcc.value as number)
    }

    // duration_ns is normalized to the same unit (ns) across vendors → comparable.
    expect(typeof nv.duration_ns).toBe("number")
    expect(typeof amd.duration_ns).toBe("number")
  })

  it("flags semantic differences explicitly (AMD GPUBusy→compute is approximate)", async () => {
    const amd = await run(rocprofLike)
    const ct = amd.hotspots[0]!.metrics["compute_throughput_pct"]!
    expect(PAP.isPresent(ct)).toBe(true)
    if (PAP.isPresent(ct)) expect(ct.provenance.semantic).toBe("approximate")
  })

  it("both mappings pass registration validation", () => {
    expect(Vocabulary.validateMapping(ncuLike.mapping).ok).toBe(true)
    expect(Vocabulary.validateMapping(rocprofLike.mapping).ok).toBe(true)
  })
})
