import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { writeFile, mkdtemp, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"
import { VtuneAdapter, vtuneMapping, parseVtuneCsv, installedVtuneProbe } from "@/profile/adapters/vtune"

// Representative `vtune -report hotspots -format=csv` fixture.
// Column names match Intel VTune CPU Metrics Reference.
const VTUNE_FIXTURE_CSV = `Function,CPU Time,CPU Time:Self,CPI Rate,Clockticks,Instructions Retired,Memory Bound,DRAM Bound,LLC Miss Ratio,Bad Speculation
compute_matrix,80.0%,75.0%,3.2,2560000,800000,40.1%,15.2%,0.08,2.1%
io_thread,12.5%,10.0%,1.8,900000,500000,18.5%,5.3%,0.03,1.2%
main,5.0%,4.0%,2.1,210000,100000,12.3%,3.1%,0.01,0.5%
sort_helper,2.5%,2.5%,4.5,562500,125000,55.2%,22.8%,0.15,3.8%
`

let tmpDir: string
let fixturePath: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "deepagent-test-vtune-"))
  fixturePath = join(tmpDir, "vtune-fixture.csv")
  await writeFile(fixturePath, VTUNE_FIXTURE_CSV, "utf8")
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("vtune adapter — CSV parsing", () => {
  it("parseVtuneCsv extracts function rows correctly", () => {
    const rows = parseVtuneCsv(VTUNE_FIXTURE_CSV)
    expect(rows.length).toBe(4)
    expect(rows[0]!.functionName).toBe("compute_matrix")
    expect(rows[0]!.cpuTimePct).toBeCloseTo(80.0, 3)
    expect(rows[0]!.cpuTimeSelfPct).toBeCloseTo(75.0, 3)
    expect(rows[0]!.cpiRate).toBeCloseTo(3.2, 3)
    expect(rows[0]!.clockticks).toBe(2560000)
    expect(rows[0]!.instructionsRetired).toBe(800000)
    expect(rows[0]!.memoryBound).toBeCloseTo(40.1, 3)
    expect(rows[0]!.dramBound).toBeCloseTo(15.2, 3)
    expect(rows[0]!.llcMissRatio).toBeCloseTo(0.08, 4)
    expect(rows[0]!.badSpeculation).toBeCloseTo(2.1, 3)
  })
})

describe("vtune adapter — mapping validation", () => {
  it("vtuneMapping passes Vocabulary.validateMapping (anti-套壳 gate)", () => {
    const result = Vocabulary.validateMapping(vtuneMapping)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it("mapping covers all cpu_hotspot metrics", () => {
    const result = Vocabulary.validateMapping(vtuneMapping)
    // cpu_hotspot domain has self_pct, cpi, ipc, clockticks, instructions_retired,
    // memory_bound_pct, dram_bound_pct, cache_miss_rate, branch_misprediction_pct
    const domainMetrics = Vocabulary.metricsForDomain("cpu_hotspot").map((m) => m.name)
    for (const m of domainMetrics) {
      expect(result.present.concat(result.missing)).toContain(m)
    }
    expect(result.missing).toHaveLength(0) // vtune covers all
  })

  it("mapping marks ipc as derived (1/CPI) with formula", () => {
    const entry = vtuneMapping.entries.find((e) => e.neutral === "ipc")
    expect(entry).toBeDefined()
    expect((entry as any).derived).toBe(true)
    expect((entry as any).formula).toContain("CPI Rate")
  })

  it("mapping marks cpi as NOT derived (VTune provides CPI Rate natively)", () => {
    const entry = vtuneMapping.entries.find((e) => e.neutral === "cpi")
    expect(entry).toBeDefined()
    expect((entry as any).derived).toBeFalsy()
    expect((entry as any).native).toBe("CPI Rate")
  })
})

describe("vtune adapter — parse→normalize pipeline", () => {
  it("parse() reads CSV and returns RawProfile with function hotspots", async () => {
    const adapter = new VtuneAdapter(installedVtuneProbe(["vtune"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)

    expect(raw.adapterId).toBe("vtune")
    expect(raw.domain).toBe("cpu_hotspot")
    expect(raw.vendor).toBe("intel")
    expect(raw.hotspots.length).toBe(4)
    // Stage 2 preserves native names.
    expect(Object.keys(raw.hotspots[0]!.nativeMetrics)).toContain("CPI Rate")
    expect(Object.keys(raw.hotspots[0]!.nativeMetrics)).not.toContain("cpi")
  })

  it("normalize() maps CPI Rate → cpi with exact provenance", async () => {
    const adapter = new VtuneAdapter(installedVtuneProbe(["vtune"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const compute = np.hotspots.find((h) => h.symbol === "compute_matrix")!
    const cpi = compute.metrics["cpi"]!
    expect(PAP.isPresent(cpi)).toBe(true)
    if (PAP.isPresent(cpi)) {
      expect(cpi.value).toBeCloseTo(3.2, 3)
      expect(cpi.unit).toBe("ratio")
      expect(cpi.provenance.semantic).toBe("exact")
      expect(cpi.provenance.nativeMetric).toBe("CPI Rate")
    }
  })

  it("normalize() ipc = 1 / CPI Rate (derived, with formula)", async () => {
    const adapter = new VtuneAdapter(installedVtuneProbe(["vtune"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const compute = np.hotspots.find((h) => h.symbol === "compute_matrix")!
    const ipc = compute.metrics["ipc"]!
    expect(PAP.isPresent(ipc)).toBe(true)
    if (PAP.isPresent(ipc)) {
      // ipc = 1 / 3.2 ≈ 0.3125
      expect(ipc.value).toBeCloseTo(1 / 3.2, 5)
      expect(ipc.unit).toBe("ratio")
      expect(ipc.provenance.derived).toBe(true)
      expect(ipc.provenance.formula).toBe("1 / CPI Rate")
    }
  })

  it("normalize() memory_bound_pct and dram_bound_pct are present (cpu_hotspot exclusive)", async () => {
    const adapter = new VtuneAdapter(installedVtuneProbe(["vtune"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const sortHotspot = np.hotspots.find((h) => h.symbol === "sort_helper")!
    const memBound = sortHotspot.metrics["memory_bound_pct"]!
    expect(PAP.isPresent(memBound)).toBe(true)
    if (PAP.isPresent(memBound)) {
      expect(memBound.value).toBeCloseTo(55.2, 3)
      expect(memBound.unit).toBe("pct")
    }

    const dramBound = sortHotspot.metrics["dram_bound_pct"]!
    expect(PAP.isPresent(dramBound)).toBe(true)
    if (PAP.isPresent(dramBound)) {
      expect(dramBound.value).toBeCloseTo(22.8, 3)
    }
  })

  it("normalize() cache_miss_rate from LLC Miss Ratio (ratio 0-1)", async () => {
    const adapter = new VtuneAdapter(installedVtuneProbe(["vtune"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const compute = np.hotspots.find((h) => h.symbol === "compute_matrix")!
    const cmr = compute.metrics["cache_miss_rate"]!
    expect(PAP.isPresent(cmr)).toBe(true)
    if (PAP.isPresent(cmr)) {
      // 0.08 is already 0-1, should stay as-is.
      expect(cmr.value).toBeCloseTo(0.08, 4)
      expect(cmr.unit).toBe("ratio")
    }
  })

  it("normalize() branch_misprediction_pct from Bad Speculation", async () => {
    const adapter = new VtuneAdapter(installedVtuneProbe(["vtune"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const compute = np.hotspots.find((h) => h.symbol === "compute_matrix")!
    const bmp = compute.metrics["branch_misprediction_pct"]!
    expect(PAP.isPresent(bmp)).toBe(true)
    if (PAP.isPresent(bmp)) {
      expect(bmp.value).toBeCloseTo(2.1, 3)
      expect(bmp.unit).toBe("pct")
    }
  })

  it("normalize() no native metric names leak", async () => {
    const adapter = new VtuneAdapter(installedVtuneProbe(["vtune"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const compute = np.hotspots[0]!
    expect(compute.metrics["CPI Rate"]).toBeUndefined()
    expect(compute.metrics["Memory Bound"]).toBeUndefined()
    expect(compute.metrics["Bad Speculation"]).toBeUndefined()
  })

  it("NormalizedProfile passes PAP.validateProfile structural check", async () => {
    const adapter = new VtuneAdapter(installedVtuneProbe(["vtune"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const structural = PAP.validateProfile(np)
    expect(structural.errors).toEqual([])
    expect(structural.ok).toBe(true)
  })

  it("NormalizedProfile passes Vocabulary.validateProfile conformance check", async () => {
    const adapter = new VtuneAdapter(installedVtuneProbe(["vtune"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "csv" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const conformance = Vocabulary.validateProfile(np)
    expect(conformance.errors).toEqual([])
  })
})
