import { describe, it, expect } from "bun:test"
import { PAP } from "@/profile/pap"
import { buildProfileOutput, renderHotspot } from "../../src/tool/profile"

// P3A profile tool — symbol/focus back-fill behaviour.
// Tests that:
//   (a) the focus symbol is starred (*) in the hotspot table,
//   (b) file_line from a resolved LSP candidate is shown in the focus line,
//   (c) non-focus hotspots are NOT starred,
//   (d) when the symbol is not resolved, the output says "symbol not found via LSP".

function makeHotspot(name: string, selfPct: number, fileLine?: PAP.FileLine): PAP.Hotspot {
  return {
    symbol: name,
    file_line: fileLine,
    self_pct: selfPct,
    metrics: {
      self_pct: PAP.present(selfPct, "pct", { nativeMetric: "overhead", semantic: "exact" }),
      cpi: PAP.present(2.1, "ratio", { nativeMetric: ["cycles", "instructions"], semantic: "exact" }),
      ipc: PAP.present(0.48, "ratio", {
        nativeMetric: ["instructions", "cycles"],
        semantic: "exact",
        derived: true,
        formula: "instructions / cycles",
      }),
      clockticks: PAP.missing("not_collected"),
      instructions_retired: PAP.missing("not_collected"),
      cache_miss_rate: PAP.missing("not_collected"),
      branch_misprediction_pct: PAP.missing("not_collected"),
    },
  }
}

const fakeNativeRef: PAP.NativeReportRef = {
  path: "/tmp/profile.perf.data",
  format: "perf-data",
  bytes: 4096,
}

function makeNormalizedProfile(hotspots: PAP.Hotspot[]): PAP.NormalizedProfile {
  return {
    domain: "cpu_sampling",
    vendor: "cpu_generic",
    adapterId: "perf",
    target: { command: "python train.py" },
    duration_ns: 1_500_000_000,
    hotspots,
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
    raw_report_ref: fakeNativeRef,
  }
}

describe("P3A profile tool — symbol focus back-fill", () => {
  it("(a) focused hotspot is starred (*) in output", () => {
    const hotspots = [
      makeHotspot("train_step", 38.0),
      makeHotspot("matmul", 22.0),
      makeHotspot("io_thread", 10.0),
    ]
    const normalized = makeNormalizedProfile(hotspots)
    const output = buildProfileOutput({
      adapterId: "perf",
      target: "python train.py",
      normalized,
      focus: "train_step",
      focusFileLine: null, // not resolved yet
    })

    // The focus hotspot TABLE line must start with "* "
    // (skip the "focus: train_step (...)" header line — look for hotspot table rows only)
    const lines = output.split("\n")
    const hotspotTableLine = lines.find((l) => (l.startsWith("* ") || l.startsWith("  ")) && l.includes("train_step"))
    expect(hotspotTableLine).toBeDefined()
    expect(hotspotTableLine!.startsWith("* ")).toBe(true)

    // Non-focus hotspots must start with "  " (two spaces, not "*")
    const matmulLine = lines.find((l) => l.includes("matmul"))
    expect(matmulLine).toBeDefined()
    expect(matmulLine!.startsWith("  ")).toBe(true)
    expect(matmulLine!.startsWith("* ")).toBe(false)
  })

  it("(b) file_line is shown in the focus header line when LSP resolved it", () => {
    const resolvedFileLine: PAP.FileLine = { file: "src/model.py", line: 42 }

    // Simulate what P3A does: back-fill file_line on the matching hotspot, then build output.
    const hotspots = [
      makeHotspot("train_step", 38.0, resolvedFileLine), // file_line already back-filled
      makeHotspot("matmul", 22.0),
    ]
    const normalized = makeNormalizedProfile(hotspots)
    const output = buildProfileOutput({
      adapterId: "perf",
      target: "python train.py",
      normalized,
      focus: "train_step",
      focusFileLine: resolvedFileLine,
    })

    // Header should say "focus: train_step (src/model.py:42)"
    expect(output).toContain("focus: train_step (src/model.py:42)")
  })

  it("(c) non-focus hotspots are never starred", () => {
    const hotspots = [
      makeHotspot("train_step", 38.0),
      makeHotspot("matmul", 22.0),
      makeHotspot("io_thread", 10.0),
    ]
    const normalized = makeNormalizedProfile(hotspots)
    const output = buildProfileOutput({
      adapterId: "perf",
      target: "python train.py",
      normalized,
      focus: "train_step",
      focusFileLine: null,
    })

    const lines = output.split("\n").filter((l) => l.startsWith("  ") || l.startsWith("* "))
    for (const line of lines) {
      if (line.includes("matmul") || line.includes("io_thread")) {
        expect(line.startsWith("* ")).toBe(false)
      }
    }
  })

  it("(d) 'symbol not found via LSP' shown when resolveSymbol returns not_found", () => {
    const hotspots = [makeHotspot("train_step", 38.0)]
    const normalized = makeNormalizedProfile(hotspots)
    const output = buildProfileOutput({
      adapterId: "perf",
      target: "python train.py",
      normalized,
      focus: "train_step",
      focusFileLine: null, // LSP returned not_found → null
    })

    expect(output).toContain("(symbol not found via LSP)")
  })

  it("(e) no focus → no star markers and no focus header line", () => {
    const hotspots = [makeHotspot("train_step", 38.0), makeHotspot("matmul", 22.0)]
    const normalized = makeNormalizedProfile(hotspots)
    const output = buildProfileOutput({
      adapterId: "perf",
      target: "python train.py",
      normalized,
      // no focus
    })

    expect(output).not.toContain("focus:")
    const lines = output.split("\n")
    for (const line of lines) {
      expect(line.startsWith("* ")).toBe(false)
    }
  })

  it("renderHotspot starred vs unstarred smoke test", () => {
    const h = makeHotspot("compute_fn", 55.3, { file: "src/gpu.py", line: 10 })
    const starred = renderHotspot(h, true)
    const normal = renderHotspot(h, false)
    expect(starred.startsWith("* ")).toBe(true)
    expect(normal.startsWith("  ")).toBe(true)
    expect(starred).toContain("compute_fn")
    expect(starred).toContain("55.3%")
    // cpi present in the hotspot
    expect(starred).toContain("cpi:")
  })
})
