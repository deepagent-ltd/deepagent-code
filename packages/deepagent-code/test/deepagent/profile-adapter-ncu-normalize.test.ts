import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { writeFile, mkdtemp, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"
import { NcuAdapter, ncuMapping, parseNcuCsv, installedNcuProbe } from "@/profile/adapters/ncu"

// Representative ncu --csv fixture (real column order from NVIDIA Nsight Compute CLI).
// Columns: ID, Process ID, Process Name, Host Name, Kernel Name, Kernel Time,
//          Context, Stream, Section Name, Metric Name, Metric Unit, Metric Value
// Kernel names that contain C++ template/argument commas MUST be quoted in CSV.
// Real ncu --csv output quotes any field containing commas.
const NCU_FIXTURE_CSV = `"ID","Process ID","Process Name","Host Name","Kernel Name","Kernel Time","Context","Stream","Section Name","Metric Name","Metric Unit","Metric Value"
0,12345,./matmul,localhost,"void matmul_kernel<float>(float* A, float* B, float* C, int N)",1000000,1,7,"GPU Speed Of Light Throughput",sm__throughput.avg.pct_of_peak_sustained_elapsed,%,85.5
0,12345,./matmul,localhost,"void matmul_kernel<float>(float* A, float* B, float* C, int N)",1000000,1,7,"Memory Workload Analysis",gpu__compute_memory_throughput.avg.pct_of_peak_sustained_elapsed,%,72.3
0,12345,./matmul,localhost,"void matmul_kernel<float>(float* A, float* B, float* C, int N)",1000000,1,7,"Memory Workload Analysis",gpu__dram_throughput.avg.pct_of_peak_sustained_elapsed,%,68.1
0,12345,./matmul,localhost,"void matmul_kernel<float>(float* A, float* B, float* C, int N)",1000000,1,7,"Memory Workload Analysis",lts__throughput.avg.pct_of_peak_sustained_elapsed,%,75.4
0,12345,./matmul,localhost,"void matmul_kernel<float>(float* A, float* B, float* C, int N)",1000000,1,7,Occupancy,sm__warps_active.avg.pct_of_peak_sustained_active,%,55.2
0,12345,./matmul,localhost,"void matmul_kernel<float>(float* A, float* B, float* C, int N)",1000000,1,7,"Compute Workload Analysis",sm__pipe_fma_cycles_active.avg.pct_of_peak_sustained_active,%,60.8
0,12345,./matmul,localhost,"void matmul_kernel<float>(float* A, float* B, float* C, int N)",1000000,1,7,"GPU Speed Of Light Throughput",gpu__time_duration.sum,ns,1000000
1,12345,./matmul,localhost,vectorAdd_kernel,500000,1,7,"GPU Speed Of Light Throughput",sm__throughput.avg.pct_of_peak_sustained_elapsed,%,45.2
1,12345,./matmul,localhost,vectorAdd_kernel,500000,1,7,"Memory Workload Analysis",gpu__compute_memory_throughput.avg.pct_of_peak_sustained_elapsed,%,88.9
1,12345,./matmul,localhost,vectorAdd_kernel,500000,1,7,"Memory Workload Analysis",gpu__dram_throughput.avg.pct_of_peak_sustained_elapsed,%,82.1
1,12345,./matmul,localhost,vectorAdd_kernel,500000,1,7,"Memory Workload Analysis",lts__throughput.avg.pct_of_peak_sustained_elapsed,%,85.0
1,12345,./matmul,localhost,vectorAdd_kernel,500000,1,7,Occupancy,sm__warps_active.avg.pct_of_peak_sustained_active,%,72.5
1,12345,./matmul,localhost,vectorAdd_kernel,500000,1,7,"Compute Workload Analysis",sm__pipe_fma_cycles_active.avg.pct_of_peak_sustained_active,%,40.1
1,12345,./matmul,localhost,vectorAdd_kernel,500000,1,7,"GPU Speed Of Light Throughput",gpu__time_duration.sum,ns,500000
`

let tmpDir: string
let fixturePath: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "deepagent-test-ncu-"))
  fixturePath = join(tmpDir, "ncu-fixture.csv")
  await writeFile(fixturePath, NCU_FIXTURE_CSV, "utf8")
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("ncu adapter — CSV parsing", () => {
  it("parseNcuCsv extracts kernel metrics correctly", () => {
    const kernelMap = parseNcuCsv(NCU_FIXTURE_CSV)
    expect(kernelMap.size).toBe(2)
    const matmul = kernelMap.get("void matmul_kernel<float>(float* A, float* B, float* C, int N)")
    expect(matmul).toBeDefined()
    expect(matmul!.get("sm__throughput.avg.pct_of_peak_sustained_elapsed")).toBeCloseTo(85.5, 3)
    expect(matmul!.get("gpu__dram_throughput.avg.pct_of_peak_sustained_elapsed")).toBeCloseTo(68.1, 3)
    expect(matmul!.get("sm__warps_active.avg.pct_of_peak_sustained_active")).toBeCloseTo(55.2, 3)
    expect(matmul!.get("gpu__time_duration.sum")).toBe(1000000)
  })
})

describe("ncu adapter — mapping validation", () => {
  it("ncuMapping passes Vocabulary.validateMapping (anti-套壳 gate)", () => {
    const result = Vocabulary.validateMapping(ncuMapping)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it("mapping declares salu_busy_pct as null (ncu has no scalar ALU metric)", () => {
    const saluEntry = ncuMapping.entries.find((e) => e.neutral === "salu_busy_pct")
    expect(saluEntry).toBeDefined()
    expect(saluEntry!.native).toBeNull()
    expect((saluEntry as any).reason).toBe("metric_not_in_this_profiler")
  })

  it("mapping marks compute_bound as derived with formula", () => {
    const entry = ncuMapping.entries.find((e) => e.neutral === "compute_bound")
    expect(entry).toBeDefined()
    expect((entry as any).derived).toBe(true)
    expect((entry as any).formula).toContain("compute_throughput_pct")
  })

  it("mapping marks valu_utilization_pct as approximate", () => {
    const entry = ncuMapping.entries.find((e) => e.neutral === "valu_utilization_pct")
    expect(entry).toBeDefined()
    expect((entry as any).semantic).toBe("approximate")
  })
})

describe("ncu adapter — parse→normalize pipeline", () => {
  it("parse() reads CSV and returns a RawProfile with kernel hotspots", async () => {
    const adapter = new NcuAdapter(installedNcuProbe(["ncu"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)

    expect(raw.adapterId).toBe("ncu")
    expect(raw.domain).toBe("gpu_kernel")
    expect(raw.vendor).toBe("nvidia")
    expect(raw.hotspots.length).toBe(2)
    // Stage 2 preserves native names.
    expect(Object.keys(raw.hotspots[0]!.nativeMetrics)).toContain("sm__throughput.avg.pct_of_peak_sustained_elapsed")
    expect(Object.keys(raw.hotspots[0]!.nativeMetrics)).not.toContain("compute_throughput_pct")
  })

  it("normalize() maps to neutral metrics — no native names leak", async () => {
    const adapter = new NcuAdapter(installedNcuProbe(["ncu"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    expect(np.adapterId).toBe("ncu")
    expect(np.domain).toBe("gpu_kernel")
    // Neutral names present.
    expect(np.summary["compute_throughput_pct"]).toBeDefined()
    expect(np.summary["memory_throughput_pct"]).toBeDefined()
    expect(np.summary["dram_bandwidth_pct"]).toBeDefined()
    expect(np.summary["l2_throughput_pct"]).toBeDefined()
    expect(np.summary["occupancy_pct"]).toBeDefined()
    expect(np.summary["valu_utilization_pct"]).toBeDefined()
    expect(np.summary["salu_busy_pct"]).toBeDefined()
    expect(np.summary["compute_bound"]).toBeDefined()
    // No native names.
    expect(np.summary["sm__throughput.avg.pct_of_peak_sustained_elapsed"]).toBeUndefined()
  })

  it("normalize() produces correct values (compute_throughput_pct = 85.5)", async () => {
    const adapter = new NcuAdapter(installedNcuProbe(["ncu"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const ct = np.summary["compute_throughput_pct"]!
    expect(PAP.isPresent(ct)).toBe(true)
    if (PAP.isPresent(ct)) {
      expect(ct.value).toBeCloseTo(85.5, 3)
      expect(ct.unit).toBe("pct")
      expect(ct.provenance.semantic).toBe("exact")
    }
  })

  it("normalize() marks salu_busy_pct as missing with correct reason", async () => {
    const adapter = new NcuAdapter(installedNcuProbe(["ncu"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const salu = np.summary["salu_busy_pct"]!
    expect(PAP.isMissing(salu)).toBe(true)
    if (PAP.isMissing(salu)) {
      expect(salu.reason).toBe("metric_not_in_this_profiler")
    }
  })

  it("normalize() marks valu_utilization_pct as approximate", async () => {
    const adapter = new NcuAdapter(installedNcuProbe(["ncu"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const valu = np.summary["valu_utilization_pct"]!
    expect(PAP.isPresent(valu)).toBe(true)
    if (PAP.isPresent(valu)) {
      expect(valu.provenance.semantic).toBe("approximate")
    }
  })

  it("normalize() compute_bound is derived=true with formula", async () => {
    const adapter = new NcuAdapter(installedNcuProbe(["ncu"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const cb = np.summary["compute_bound"]!
    expect(PAP.isPresent(cb)).toBe(true)
    if (PAP.isPresent(cb)) {
      // matmul: compute=85.5 > memory=72.3 → compute-bound=true
      expect(cb.value).toBe(true)
      expect(cb.provenance.derived).toBe(true)
      expect(cb.provenance.formula).toBeDefined()
    }
  })

  it("normalize() duration_ns matches native value (1000000 ns)", async () => {
    const adapter = new NcuAdapter(installedNcuProbe(["ncu"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const dur = np.summary["duration_ns"]!
    expect(PAP.isPresent(dur)).toBe(true)
    if (PAP.isPresent(dur)) {
      expect(dur.value).toBe(1000000)
      expect(dur.unit).toBe("ns")
    }
    expect(np.duration_ns).toBe(1000000)
  })

  it("normalize() hotspots carry correct kernel names and per-kernel metrics", async () => {
    const adapter = new NcuAdapter(installedNcuProbe(["ncu"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    expect(np.hotspots.length).toBe(2)
    const matmulHotspot = np.hotspots.find((h) => h.kernel?.includes("matmul"))
    expect(matmulHotspot).toBeDefined()
    expect(matmulHotspot!.metrics["compute_throughput_pct"]).toBeDefined()
    expect(matmulHotspot!.metrics["salu_busy_pct"]).toBeDefined()
    // salu_busy_pct is missing in hotspot too.
    expect(PAP.isMissing(matmulHotspot!.metrics["salu_busy_pct"]!)).toBe(true)

    // vectorAdd is memory-bound (compute=45.2 < memory=88.9).
    const vecAddHotspot = np.hotspots.find((h) => h.kernel?.includes("vectorAdd"))
    expect(vecAddHotspot).toBeDefined()
    const vecCb = vecAddHotspot!.metrics["compute_bound"]!
    if (PAP.isPresent(vecCb)) {
      expect(vecCb.value).toBe(false) // memory-bound
    }
  })

  it("NormalizedProfile passes PAP.validateProfile structural check", async () => {
    const adapter = new NcuAdapter(installedNcuProbe(["ncu"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const structural = PAP.validateProfile(np)
    expect(structural.errors).toEqual([])
    expect(structural.ok).toBe(true)
  })

  it("NormalizedProfile passes Vocabulary.validateProfile conformance check", async () => {
    const adapter = new NcuAdapter(installedNcuProbe(["ncu"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const conformance = Vocabulary.validateProfile(np)
    expect(conformance.errors).toEqual([])
  })
})
