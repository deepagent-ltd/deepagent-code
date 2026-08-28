import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { writeFile, mkdtemp, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"
import { NsysAdapter, nsysMapping, parseNsysMultiSectionCsv, parseGpukernsum, installedNsysProbe } from "@/profile/adapters/nsys"

// Representative nsys stats CSV fixture in our multi-section format.
// Each section matches what `nsys stats --report <X> --format csv` emits.
const NSYS_FIXTURE = `=== REPORT: gpukernsum ===
Time (%),Total Time (ns),Instances,Average (ns),Minimum (ns),Maximum (ns),Name
62.5,1250000,100,12500,10000,20000,void matmul_kernel<float>(float*,float*,float*,int)
15.3,306000,50,6120,5000,8000,void vectorAdd_kernel(float*,float*,float*,int)
10.2,204000,200,1020,800,1500,void transpose_kernel(float*,float*,int)
=== REPORT: gpumemtimesum ===
Time (%),Total Time (ns),Count,Average (ns),Minimum (ns),Maximum (ns),Operation
8.5,170000,200,850,600,1200,CUDA Memcpy HtoD
3.5,70000,100,700,500,900,CUDA Memcpy DtoH
=== REPORT: cudaapisum ===
Time (%),Total Time (ns),Num Calls,Average (ns),Minimum (ns),Maximum (ns),Name
3.2,64000,1000,64,50,200,cudaLaunchKernel
0.8,16000,400,40,30,80,cudaMemcpy
`

let tmpDir: string
let fixturePath: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "deepagent-test-nsys-"))
  fixturePath = join(tmpDir, "nsys-fixture.txt")
  await writeFile(fixturePath, NSYS_FIXTURE, "utf8")
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("nsys adapter — CSV parsing", () => {
  it("parseNsysMultiSectionCsv parses all three report sections", () => {
    const { kernels, memOps, apiCalls } = parseNsysMultiSectionCsv(NSYS_FIXTURE)
    expect(kernels.length).toBe(3)
    expect(memOps.length).toBe(2)
    expect(apiCalls.length).toBe(2)
  })

  it("gpukernsum: top kernel timePct is correct", () => {
    const { kernels } = parseNsysMultiSectionCsv(NSYS_FIXTURE)
    expect(kernels[0]!.name).toContain("matmul_kernel")
    expect(kernels[0]!.timePct).toBeCloseTo(62.5, 3)
    expect(kernels[0]!.totalTimeNs).toBe(1250000)
  })

  it("gpumemtimesum: memory copy total percent is aggregated", () => {
    const { memOps } = parseNsysMultiSectionCsv(NSYS_FIXTURE)
    const totalPct = memOps.reduce((s, r) => s + r.timePct, 0)
    expect(totalPct).toBeCloseTo(12.0, 3)
  })

  it("cudaapisum: API overhead percent is aggregated", () => {
    const { apiCalls } = parseNsysMultiSectionCsv(NSYS_FIXTURE)
    const totalPct = apiCalls.reduce((s, r) => s + r.timePct, 0)
    expect(totalPct).toBeCloseTo(4.0, 3)
  })
})

describe("nsys adapter — mapping validation", () => {
  it("nsysMapping passes Vocabulary.validateMapping", () => {
    const result = Vocabulary.validateMapping(nsysMapping)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it("mapping covers all three gpu_timeline metrics (api_overhead honestly null)", () => {
    const result = Vocabulary.validateMapping(nsysMapping)
    expect(result.present).toContain("kernel_total_pct")
    expect(result.present).toContain("mem_copy_pct")
    // api_overhead_pct is declared null+reason (no valid GPU-total denominator from nsys stats),
    // so it is covered via the `missing` set, not `present`. §P1A-V 映射原则 5.
    expect(result.missing).toContain("api_overhead_pct")
  })
})

describe("nsys adapter — parse→normalize pipeline", () => {
  it("parse() returns RawProfile with hotspots from gpukernsum", async () => {
    const adapter = new NsysAdapter(installedNsysProbe(["nsys"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)

    expect(raw.adapterId).toBe("nsys")
    expect(raw.domain).toBe("gpu_timeline")
    expect(raw.vendor).toBe("nvidia")
    expect(raw.hotspots.length).toBe(3)
    // Stage 2 carries native keys + raw ns totals used to derive GPU-time shares.
    expect(Object.keys(raw.nativeSummary)).toContain("kernel_time_pct")
    expect(Object.keys(raw.nativeSummary)).toContain("mem_copy_time_pct")
    expect(Object.keys(raw.nativeSummary)).toContain("kernel_ns_total")
    expect(Object.keys(raw.nativeSummary)).toContain("mem_ns_total")
    expect(Object.keys(raw.nativeSummary)).toContain("api_ns_total")
  })

  it("normalize() produces neutral metrics with correct values", async () => {
    const adapter = new NsysAdapter(installedNsysProbe(["nsys"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    expect(np.adapterId).toBe("nsys")
    expect(np.domain).toBe("gpu_timeline")

    // kernel_total_pct = kernel_ns / (kernel_ns + mem_ns) — the share of GPU-side
    // time spent in compute kernels. kernelNs=1,760,000, memNs=240,000 → 88.0%.
    const kPct = np.summary["kernel_total_pct"]!
    expect(PAP.isPresent(kPct)).toBe(true)
    if (PAP.isPresent(kPct)) {
      expect(kPct.value).toBeCloseTo(88.0, 3)
      expect(kPct.unit).toBe("pct")
      expect(kPct.provenance.semantic).toBe("exact")
    }

    // mem_copy_pct = mem_ns / (kernel_ns + mem_ns) = 240,000 / 2,000,000 = 12.0%.
    const mPct = np.summary["mem_copy_pct"]!
    expect(PAP.isPresent(mPct)).toBe(true)
    if (PAP.isPresent(mPct)) {
      expect(mPct.value).toBeCloseTo(12.0, 3)
    }

    // api_overhead_pct is honestly null — nsys stats gives no valid GPU/wall-total
    // denominator, so we never fabricate a "share of total" percentage.
    const aPct = np.summary["api_overhead_pct"]!
    expect(PAP.isMissing(aPct)).toBe(true)
    if (PAP.isMissing(aPct)) {
      expect(aPct.reason).toBeTruthy()
    }
  })

  it("normalize() hotspots carry kernel names and kernel_total_pct", async () => {
    const adapter = new NsysAdapter(installedNsysProbe(["nsys"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    expect(np.hotspots.length).toBe(3)
    const matmulHotspot = np.hotspots.find((h) => h.kernel?.includes("matmul"))
    expect(matmulHotspot).toBeDefined()
    const kPct = matmulHotspot!.metrics["kernel_total_pct"]!
    expect(PAP.isPresent(kPct)).toBe(true)
    if (PAP.isPresent(kPct)) {
      expect(kPct.value).toBeCloseTo(62.5, 3)
    }
  })

  it("normalize() no native metric names leak into NormalizedProfile", async () => {
    const adapter = new NsysAdapter(installedNsysProbe(["nsys"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    // Native key "kernel_time_pct" should not appear in summary.
    expect(np.summary["kernel_time_pct"]).toBeUndefined()
    expect(np.summary["mem_copy_time_pct"]).toBeUndefined()
  })

  it("NormalizedProfile passes PAP.validateProfile structural check", async () => {
    const adapter = new NsysAdapter(installedNsysProbe(["nsys"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const structural = PAP.validateProfile(np)
    expect(structural.errors).toEqual([])
    expect(structural.ok).toBe(true)
  })

  it("NormalizedProfile passes Vocabulary.validateProfile conformance check", async () => {
    const adapter = new NsysAdapter(installedNsysProbe(["nsys"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const conformance = Vocabulary.validateProfile(np)
    expect(conformance.errors).toEqual([])
  })
})
