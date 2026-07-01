import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { writeFile, mkdtemp, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"
import { RocprofAdapter, rocprofMapping, parseRocprofCsv, installedRocprofProbe } from "@/profile/adapters/rocprof"

// Representative rocprofv3 CSV fixture.
// Columns: Kernel_Name, gpu-id, queue-id, queue-index, pid, tid, grd, wgr, lds, scr,
//          arch_vgpr, accum_vgpr, phys_vgpr, phys_sgpr, sig, obj,
//          GPUBusy, MemUnitBusy, VALUUtilization, SALUBusy, Wavefronts, L2CacheHit,
//          BeginNs, EndNs
const ROCPROF_FIXTURE_CSV = `Kernel_Name,gpu-id,queue-id,queue-index,pid,tid,grd,wgr,lds,scr,arch_vgpr,accum_vgpr,phys_vgpr,phys_sgpr,sig,obj,GPUBusy,MemUnitBusy,VALUUtilization,SALUBusy,Wavefronts,L2CacheHit,BeginNs,EndNs
rocblas_gemm_kernel,0,0,0,12345,67890,262144,256,0,0,32,0,32,16,0,0,88.5,65.3,78.2,12.5,4096,82.3,1000000,1050000
hip_vector_add,0,0,1,12345,67890,65536,64,0,0,16,0,16,8,0,0,45.2,88.9,32.1,8.3,1024,91.5,1060000,1085000
rocblas_gemm_kernel,0,0,2,12345,67890,262144,256,0,0,32,0,32,16,0,0,90.1,62.8,81.5,13.2,4096,80.1,1090000,1140000
`

let tmpDir: string
let fixturePath: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "deepagent-test-rocprof-"))
  fixturePath = join(tmpDir, "rocprof-fixture.csv")
  await writeFile(fixturePath, ROCPROF_FIXTURE_CSV, "utf8")
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("rocprof adapter — CSV parsing", () => {
  it("parseRocprofCsv extracts kernel rows correctly", () => {
    const rows = parseRocprofCsv(ROCPROF_FIXTURE_CSV)
    expect(rows.length).toBe(3)
    expect(rows[0]!.kernelName).toBe("rocblas_gemm_kernel")
    expect(rows[0]!.metrics["GPUBusy"]).toBeCloseTo(88.5, 3)
    expect(rows[0]!.metrics["MemUnitBusy"]).toBeCloseTo(65.3, 3)
    expect(rows[0]!.metrics["VALUUtilization"]).toBeCloseTo(78.2, 3)
    expect(rows[0]!.metrics["SALUBusy"]).toBeCloseTo(12.5, 3)
    expect(rows[0]!.metrics["Wavefronts"]).toBe(4096)
    expect(rows[0]!.metrics["L2CacheHit"]).toBeCloseTo(82.3, 3)
    expect(rows[0]!.metrics["BeginNs"]).toBe(1000000)
    expect(rows[0]!.metrics["EndNs"]).toBe(1050000)
  })
})

describe("rocprof adapter — mapping validation", () => {
  it("rocprofMapping passes Vocabulary.validateMapping (anti-套壳 gate)", () => {
    const result = Vocabulary.validateMapping(rocprofMapping)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it("mapping marks GPUBusy→compute_throughput_pct as approximate", () => {
    const entry = rocprofMapping.entries.find((e) => e.neutral === "compute_throughput_pct")
    expect(entry).toBeDefined()
    expect((entry as any).native).toBe("GPUBusy")
    expect((entry as any).semantic).toBe("approximate")
  })

  it("mapping marks L2CacheHit→l2_throughput_pct as approximate (hit-rate ≠ throughput)", () => {
    const entry = rocprofMapping.entries.find((e) => e.neutral === "l2_throughput_pct")
    expect(entry).toBeDefined()
    expect((entry as any).native).toBe("L2CacheHit")
    expect((entry as any).semantic).toBe("approximate")
  })

  it("mapping marks salu_busy_pct as present (AMD-native metric)", () => {
    const entry = rocprofMapping.entries.find((e) => e.neutral === "salu_busy_pct")
    expect(entry).toBeDefined()
    expect((entry as any).native).toBe("SALUBusy")
  })

  it("mapping marks compute_bound as derived with formula", () => {
    const entry = rocprofMapping.entries.find((e) => e.neutral === "compute_bound")
    expect(entry).toBeDefined()
    expect((entry as any).derived).toBe(true)
    expect((entry as any).formula).toContain("GPUBusy")
    expect((entry as any).semantic).toBe("approximate")
  })

  it("mapping declares duration_ns from BeginNs+EndNs", () => {
    const entry = rocprofMapping.entries.find((e) => e.neutral === "duration_ns")
    expect(entry).toBeDefined()
    expect((entry as any).native).toContain("BeginNs")
    expect((entry as any).native).toContain("EndNs")
  })
})

describe("rocprof adapter — parse→normalize pipeline", () => {
  it("parse() reads CSV and returns RawProfile with kernel hotspots", async () => {
    const adapter = new RocprofAdapter(installedRocprofProbe(["rocprofv3"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)

    expect(raw.adapterId).toBe("rocprof")
    expect(raw.domain).toBe("gpu_kernel")
    expect(raw.vendor).toBe("amd")
    expect(raw.hotspots.length).toBe(3)
    // Stage 2 preserves native names.
    expect(Object.keys(raw.hotspots[0]!.nativeMetrics)).toContain("GPUBusy")
    expect(Object.keys(raw.hotspots[0]!.nativeMetrics)).not.toContain("compute_throughput_pct")
  })

  it("normalize() maps GPUBusy to compute_throughput_pct with approximate provenance", async () => {
    const adapter = new RocprofAdapter(installedRocprofProbe(["rocprofv3"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const ct = np.summary["compute_throughput_pct"]!
    expect(PAP.isPresent(ct)).toBe(true)
    if (PAP.isPresent(ct)) {
      expect(ct.value).toBeCloseTo(88.5, 3)
      expect(ct.unit).toBe("pct")
      expect(ct.provenance.semantic).toBe("approximate") // GPUBusy ≠ SM compute throughput
      expect(ct.provenance.nativeMetric).toBe("GPUBusy")
    }
  })

  it("normalize() maps L2CacheHit to l2_throughput_pct as approximate", async () => {
    const adapter = new RocprofAdapter(installedRocprofProbe(["rocprofv3"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const l2 = np.summary["l2_throughput_pct"]!
    expect(PAP.isPresent(l2)).toBe(true)
    if (PAP.isPresent(l2)) {
      expect(l2.value).toBeCloseTo(82.3, 3)
      // MUST be approximate: L2CacheHit is hit-rate, not throughput.
      expect(l2.provenance.semantic).toBe("approximate")
    }
  })

  it("normalize() maps SALUBusy to salu_busy_pct with exact provenance (AMD-native)", async () => {
    const adapter = new RocprofAdapter(installedRocprofProbe(["rocprofv3"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const salu = np.summary["salu_busy_pct"]!
    expect(PAP.isPresent(salu)).toBe(true)
    if (PAP.isPresent(salu)) {
      expect(salu.value).toBeCloseTo(12.5, 3)
      expect(salu.provenance.semantic).toBe("exact")
      expect(salu.provenance.nativeMetric).toBe("SALUBusy")
    }
  })

  it("normalize() duration_ns = EndNs - BeginNs = 50000", async () => {
    const adapter = new RocprofAdapter(installedRocprofProbe(["rocprofv3"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const dur = np.summary["duration_ns"]!
    expect(PAP.isPresent(dur)).toBe(true)
    if (PAP.isPresent(dur)) {
      expect(dur.value).toBe(50000) // 1050000 - 1000000
      expect(dur.unit).toBe("ns")
    }
  })

  it("normalize() compute_bound is derived with approximate semantics", async () => {
    const adapter = new RocprofAdapter(installedRocprofProbe(["rocprofv3"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const cb = np.summary["compute_bound"]!
    expect(PAP.isPresent(cb)).toBe(true)
    if (PAP.isPresent(cb)) {
      // GPUBusy=88.5 > MemUnitBusy=65.3 → true
      expect(cb.value).toBe(true)
      expect(cb.provenance.derived).toBe(true)
      expect(cb.provenance.semantic).toBe("approximate")
      expect(cb.provenance.formula).toBeDefined()
    }
  })

  it("normalize() hotspots include salu_busy_pct (AMD-exclusive metric)", async () => {
    const adapter = new RocprofAdapter(installedRocprofProbe(["rocprofv3"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const gemm = np.hotspots.find((h) => h.kernel?.includes("gemm"))
    expect(gemm).toBeDefined()
    const saluInHotspot = gemm!.metrics["salu_busy_pct"]!
    expect(PAP.isPresent(saluInHotspot)).toBe(true)
    if (PAP.isPresent(saluInHotspot)) {
      expect(saluInHotspot.value).toBeCloseTo(12.5, 3)
    }
  })

  it("NormalizedProfile passes PAP.validateProfile structural check", async () => {
    const adapter = new RocprofAdapter(installedRocprofProbe(["rocprofv3"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const structural = PAP.validateProfile(np)
    expect(structural.errors).toEqual([])
    expect(structural.ok).toBe(true)
  })

  it("NormalizedProfile passes Vocabulary.validateProfile conformance check", async () => {
    const adapter = new RocprofAdapter(installedRocprofProbe(["rocprofv3"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const conformance = Vocabulary.validateProfile(np)
    expect(conformance.errors).toEqual([])
  })
})
