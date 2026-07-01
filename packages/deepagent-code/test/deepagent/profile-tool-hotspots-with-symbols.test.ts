import { describe, it, expect } from "bun:test"
import { PAP } from "@/profile/pap"
import { RuntimeBase } from "@/runtime/base"
import { buildProfileOutput } from "../../src/tool/profile"

// P3A profile tool — hotspot table with symbols, output budget.
// Tests that:
//   (a) a fake adapter producing 5 hotspots → all 5 appear in output (top-10 includes all),
//   (b) the output is correctly formatted (header, hotspot lines, summary, artifact note),
//   (c) raw report bytes are NOT inlined — only the artifact ref note appears,
//   (d) RuntimeBase.applyOutputBudget truncates correctly when output is large.

function makeMetrics(selfPct: number): Record<string, PAP.MetricValue> {
  return {
    self_pct: PAP.present(selfPct, "pct", { nativeMetric: "overhead", semantic: "exact" }),
    cpi: PAP.present(1.8, "ratio", { nativeMetric: ["cycles", "instructions"], semantic: "exact" }),
    ipc: PAP.present(0.56, "ratio", {
      nativeMetric: ["instructions", "cycles"],
      semantic: "exact",
      derived: true,
      formula: "instructions / cycles",
    }),
    clockticks: PAP.missing("not_collected"),
    instructions_retired: PAP.missing("not_collected"),
    cache_miss_rate: PAP.missing("not_collected"),
    branch_misprediction_pct: PAP.missing("not_collected"),
  }
}

function makeHotspot(symbol: string, selfPct: number): PAP.Hotspot {
  return { symbol, self_pct: selfPct, metrics: makeMetrics(selfPct) }
}

const FIVE_HOTSPOTS: PAP.Hotspot[] = [
  makeHotspot("compute_kernel", 40.0),
  makeHotspot("data_loader", 25.0),
  makeHotspot("optimizer_step", 15.0),
  makeHotspot("loss_fn", 12.0),
  makeHotspot("io_thread", 8.0),
]

const FAKE_NATIVE_REF: PAP.NativeReportRef = {
  path: "/tmp/profile_result.perf.data",
  format: "perf-data",
  bytes: 1_024_000,
  exportCommand: "perf script -i /tmp/profile_result.perf.data",
}

function makeFiveHotspotProfile(): PAP.NormalizedProfile {
  return {
    domain: "cpu_sampling",
    vendor: "cpu_generic",
    adapterId: "perf",
    target: { command: "./bench" },
    duration_ns: 2_000_000_000,
    hotspots: FIVE_HOTSPOTS,
    summary: {
      ipc: PAP.present(0.48, "ratio", {
        nativeMetric: ["instructions", "cycles"],
        semantic: "exact",
        derived: true,
        formula: "instructions / cycles",
      }),
      cache_miss_rate: PAP.present(0.12, "ratio", {
        nativeMetric: ["cache-misses", "cache-references"],
        semantic: "exact",
      }),
    },
    raw_report_ref: FAKE_NATIVE_REF,
  }
}

describe("P3A profile tool — hotspots table with 5 symbols", () => {
  it("(a) all 5 hotspots appear in output when total < top-10 limit", () => {
    const normalized = makeFiveHotspotProfile()
    const output = buildProfileOutput({
      adapterId: "perf",
      target: "./bench",
      normalized,
    })

    for (const { symbol } of FIVE_HOTSPOTS) {
      expect(output).toContain(symbol!)
    }
  })

  it("(b) output has correct structure: header / top hotspots / summary / evidence line", () => {
    const normalized = makeFiveHotspotProfile()
    const output = buildProfileOutput({
      adapterId: "perf",
      target: "./bench",
      normalized,
      artifactPath: "/tmp/run/PROFILE_RESULT.json",
    })

    expect(output).toContain("profile: perf cpu_sampling on `./bench`")
    expect(output).toContain("top hotspots:")
    expect(output).toContain("summary:")
    // Evidence line now points at the ACTUAL written artifact (P4A closed loop),
    // rather than the old note that claimed a file that was never written.
    expect(output).toContain("PROFILE_RESULT.json")
    expect(output).toContain('evidence_kind:"profile"')
  })

  it("(b) hotspots are sorted by self_pct descending", () => {
    const normalized = makeFiveHotspotProfile()
    const output = buildProfileOutput({
      adapterId: "perf",
      target: "./bench",
      normalized,
    })

    const lines = output.split("\n")
    const hotspotLines = lines.filter((l) => l.startsWith("  ") && l.includes("self:"))
    expect(hotspotLines.length).toBe(5)

    // First hotspot must be compute_kernel (40%) — highest self_pct
    expect(hotspotLines[0]).toContain("compute_kernel")
    // Last hotspot must be io_thread (8%) — lowest self_pct
    expect(hotspotLines[4]).toContain("io_thread")
  })

  it("(b) each hotspot line includes self_pct value", () => {
    const normalized = makeFiveHotspotProfile()
    const output = buildProfileOutput({
      adapterId: "perf",
      target: "./bench",
      normalized,
    })

    expect(output).toContain("40.0%")
    expect(output).toContain("25.0%")
    expect(output).toContain("15.0%")
  })

  it("(c) raw report bytes are NOT inlined in output", () => {
    const normalized = makeFiveHotspotProfile()
    const output = buildProfileOutput({
      adapterId: "perf",
      target: "./bench",
      normalized,
      artifactPath: "/tmp/run/PROFILE_RESULT.json",
    })

    // The raw report path should not appear inline.
    expect(output).not.toContain("/tmp/profile_result.perf.data")
    // The perf data bytes (1 MB worth) should not appear inline.
    expect(output).not.toContain("1024000")
    // Only the evidence artifact reference is present.
    expect(output).toContain("PROFILE_RESULT.json")
  })

  it("(d) RuntimeBase.applyOutputBudget truncates large output correctly", () => {
    // Simulate a very large output string exceeding the default budget.
    const largeOutput = "x".repeat(30_000) + "\nnote: full report in artifact (ref: PROFILE_RESULT.json)"
    const budget: RuntimeBase.ResourceBudget = { timeoutMs: 60_000, maxInlineBytes: 24_000 }
    const budgeted = RuntimeBase.applyOutputBudget(largeOutput, budget)

    expect(budgeted.truncated).toBe(true)
    expect(budgeted.fullBytes).toBeGreaterThan(24_000)
    expect(budgeted.inline).toContain("truncated")
    expect(Buffer.byteLength(budgeted.inline, "utf8")).toBeLessThanOrEqual(24_000 + 200) // slight overhead for the truncation note
  })

  it("(d) small output passes through applyOutputBudget unchanged", () => {
    const normalized = makeFiveHotspotProfile()
    const output = buildProfileOutput({
      adapterId: "perf",
      target: "./bench",
      normalized,
    })

    // A typical 5-hotspot output is well under 24 KB.
    const budgeted = RuntimeBase.applyOutputBudget(output)
    expect(budgeted.truncated).toBe(false)
    expect(budgeted.inline).toBe(output)
  })

  it("summary contains the neutral metric names (no native leak)", () => {
    const normalized = makeFiveHotspotProfile()
    const output = buildProfileOutput({
      adapterId: "perf",
      target: "./bench",
      normalized,
    })

    // ipc and cache_miss_rate are neutral names — they should appear in summary.
    expect(output).toContain("ipc=")
    expect(output).toContain("cache_miss_rate=")
    // Native perf names must not appear in the tool output.
    expect(output).not.toContain("instructions ")
    expect(output).not.toContain("cache-misses")
    expect(output).not.toContain("cache-references")
  })
})
