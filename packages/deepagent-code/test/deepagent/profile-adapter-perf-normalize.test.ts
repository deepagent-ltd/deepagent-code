import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { writeFile, mkdtemp, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"
import { PerfAdapter, perfMapping, parsePerfReport, parsePerfStat, parsePerfMultiSection, installedPerfProbe } from "@/profile/adapters/perf"

// Representative perf multi-section fixture.
// Section perf_report: `perf report --stdio -n` format.
// Section perf_stat: `perf stat` format.
const PERF_FIXTURE = `=== SECTION: perf_report ===
# Overhead  Command  Shared Object  Symbol
    62.50%  bench    bench          [.] compute_kernel
    20.00%  bench    libc.so        [.] memcpy
     5.30%  bench    bench          [.] io_thread_main
     3.20%  bench    [kernel]       [k] copy_user_generic_string
     2.10%  bench    bench          [.] sort_inplace
=== SECTION: perf_stat ===
 Performance counter stats for './bench':

       2,000,000      cycles                    #    1.500 GHz
       1,000,000      instructions              #    0.50  insn per cycle
          50,000      cache-misses              #   50.000 % of all cache refs
         100,000      cache-references
          10,000      branch-misses             #    5.000 % of all branches
         200,000      branches

       0.001334 seconds time elapsed
`

let tmpDir: string
let fixturePath: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "deepagent-test-perf-"))
  fixturePath = join(tmpDir, "perf-fixture.txt")
  await writeFile(fixturePath, PERF_FIXTURE, "utf8")
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe("perf adapter — text parsing", () => {
  it("parsePerfReport extracts symbol rows from perf report --stdio", () => {
    const { reportRows } = parsePerfMultiSection(PERF_FIXTURE)
    expect(reportRows.length).toBe(5)
    expect(reportRows[0]!.symbol).toBe("compute_kernel")
    expect(reportRows[0]!.overheadPct).toBeCloseTo(62.5, 3)
    expect(reportRows[1]!.symbol).toBe("memcpy")
    expect(reportRows[1]!.overheadPct).toBeCloseTo(20.0, 3)
  })

  it("parsePerfStat extracts event counts from perf stat", () => {
    const { statCounts } = parsePerfMultiSection(PERF_FIXTURE)
    expect(statCounts.get("cycles")).toBe(2000000)
    expect(statCounts.get("instructions")).toBe(1000000)
    expect(statCounts.get("cache-misses")).toBe(50000)
    expect(statCounts.get("cache-references")).toBe(100000)
    expect(statCounts.get("branch-misses")).toBe(10000)
    expect(statCounts.get("branches")).toBe(200000)
  })
})

describe("perf adapter — mapping validation", () => {
  it("perfMapping passes Vocabulary.validateMapping (anti-套壳 gate)", () => {
    const result = Vocabulary.validateMapping(perfMapping)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it("mapping covers all cpu_sampling metrics (memory_bound_pct/dram_bound_pct excluded — cpu_hotspot only)", () => {
    const result = Vocabulary.validateMapping(perfMapping)
    const samplingMetrics = Vocabulary.metricsForDomain("cpu_sampling").map((m) => m.name)
    // All cpu_sampling domain metrics should be covered.
    for (const m of samplingMetrics) {
      expect(result.present.concat(result.missing)).toContain(m)
    }
    // cpu_sampling does NOT include memory_bound_pct or dram_bound_pct.
    expect(samplingMetrics).not.toContain("memory_bound_pct")
    expect(samplingMetrics).not.toContain("dram_bound_pct")
  })

  it("mapping marks ipc as derived with formula", () => {
    const entry = perfMapping.entries.find((e) => e.neutral === "ipc")
    expect(entry).toBeDefined()
    expect((entry as any).derived).toBe(true)
    expect((entry as any).formula).toBe("instructions / cycles")
  })

  it("mapping marks cpi as NOT derived (vocab: derived:false)", () => {
    const entry = perfMapping.entries.find((e) => e.neutral === "cpi")
    expect(entry).toBeDefined()
    expect((entry as any).derived).toBeFalsy()
    expect((entry as any).native).toContain("cycles")
    expect((entry as any).native).toContain("instructions")
  })
})

describe("perf adapter — parse→normalize pipeline", () => {
  it("parse() reads fixture and returns RawProfile with symbol hotspots", async () => {
    const adapter = new PerfAdapter(installedPerfProbe(["perf"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)

    expect(raw.adapterId).toBe("perf")
    expect(raw.domain).toBe("cpu_sampling")
    expect(raw.vendor).toBe("cpu_generic")
    expect(raw.hotspots.length).toBe(5)
    // Stage 2 preserves native names.
    expect(Object.keys(raw.nativeSummary)).toContain("cycles")
    expect(Object.keys(raw.nativeSummary)).toContain("instructions")
    // No neutral names in stage 2.
    expect(Object.keys(raw.nativeSummary)).not.toContain("ipc")
  })

  it("normalize() hotspots map overhead% to self_pct", async () => {
    const adapter = new PerfAdapter(installedPerfProbe(["perf"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    expect(np.hotspots.length).toBe(5)
    const compute = np.hotspots.find((h) => h.symbol === "compute_kernel")!
    expect(compute.self_pct).toBeCloseTo(62.5, 3)
    const selfPct = compute.metrics["self_pct"]!
    expect(PAP.isPresent(selfPct)).toBe(true)
    if (PAP.isPresent(selfPct)) {
      expect(selfPct.value).toBeCloseTo(62.5, 3)
      expect(selfPct.unit).toBe("pct")
      expect(selfPct.provenance.semantic).toBe("exact")
    }
  })

  it("normalize() summary: cpi = cycles / instructions = 2.0", async () => {
    const adapter = new PerfAdapter(installedPerfProbe(["perf"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    // cycles=2,000,000; instructions=1,000,000 → cpi=2.0
    const cpi = np.summary["cpi"]!
    expect(PAP.isPresent(cpi)).toBe(true)
    if (PAP.isPresent(cpi)) {
      expect(cpi.value).toBeCloseTo(2.0, 5)
      expect(cpi.unit).toBe("ratio")
      // cpi is computed from cycles/instructions but vocab says derived:false.
      expect(cpi.provenance.nativeMetric).toContain("cycles")
    }
  })

  it("normalize() summary: ipc = instructions / cycles = 0.5 (derived, with formula)", async () => {
    const adapter = new PerfAdapter(installedPerfProbe(["perf"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    // ipc = 1,000,000 / 2,000,000 = 0.5
    const ipc = np.summary["ipc"]!
    expect(PAP.isPresent(ipc)).toBe(true)
    if (PAP.isPresent(ipc)) {
      expect(ipc.value).toBeCloseTo(0.5, 5)
      expect(ipc.unit).toBe("ratio")
      expect(ipc.provenance.derived).toBe(true)
      expect(ipc.provenance.formula).toBe("instructions / cycles")
    }
  })

  it("normalize() summary: cache_miss_rate = cache-misses / cache-references = 0.5", async () => {
    const adapter = new PerfAdapter(installedPerfProbe(["perf"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    // cache-misses=50,000; cache-references=100,000 → miss_rate=0.5
    const cmr = np.summary["cache_miss_rate"]!
    expect(PAP.isPresent(cmr)).toBe(true)
    if (PAP.isPresent(cmr)) {
      expect(cmr.value).toBeCloseTo(0.5, 5)
      expect(cmr.unit).toBe("ratio")
    }
  })

  it("normalize() summary: branch_misprediction_pct = branch-misses/branches*100 = 5%", async () => {
    const adapter = new PerfAdapter(installedPerfProbe(["perf"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    // branch-misses=10,000; branches=200,000 → 5%
    const bmp = np.summary["branch_misprediction_pct"]!
    expect(PAP.isPresent(bmp)).toBe(true)
    if (PAP.isPresent(bmp)) {
      expect(bmp.value).toBeCloseTo(5.0, 5)
      expect(bmp.unit).toBe("pct")
    }
  })

  it("normalize() per-symbol cpi/ipc are honestly null (require perf annotate)", async () => {
    const adapter = new PerfAdapter(installedPerfProbe(["perf"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const compute = np.hotspots.find((h) => h.symbol === "compute_kernel")!
    const perSymCpi = compute.metrics["cpi"]!
    expect(PAP.isMissing(perSymCpi)).toBe(true)
    if (PAP.isMissing(perSymCpi)) {
      expect(perSymCpi.reason).toBe("not_collected")
    }
    const perSymIpc = compute.metrics["ipc"]!
    expect(PAP.isMissing(perSymIpc)).toBe(true)
  })

  it("normalize() no native metric names leak", async () => {
    const adapter = new PerfAdapter(installedPerfProbe(["perf"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    expect(np.summary["cycles"]).toBeUndefined()
    expect(np.summary["instructions"]).toBeUndefined()
    expect(np.summary["cache-misses"]).toBeUndefined()
    expect(np.summary["overhead"]).toBeUndefined()
  })

  it("NormalizedProfile passes PAP.validateProfile structural check", async () => {
    const adapter = new PerfAdapter(installedPerfProbe(["perf"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const structural = PAP.validateProfile(np)
    expect(structural.errors).toEqual([])
    expect(structural.ok).toBe(true)
  })

  it("NormalizedProfile passes Vocabulary.validateProfile conformance check", async () => {
    const adapter = new PerfAdapter(installedPerfProbe(["perf"]))
    const ref: PAP.NativeReportRef = { path: fixturePath, format: "text" }
    const raw = await adapter.parse(ref)
    const np = adapter.normalize(raw)

    const conformance = Vocabulary.validateProfile(np)
    expect(conformance.errors).toEqual([])
  })
})
