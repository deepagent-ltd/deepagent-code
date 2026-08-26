import { describe, it, expect, afterAll } from "bun:test"
import os from "os"
import path from "path"
import * as fs from "fs/promises"
import { PAP } from "@/profile/pap"
import { ProfileService } from "@/profile/service"

// P4A (S1-v3.5): ProfileService.run writes a PROFILE_RESULT.json evidence
// artifact (evidence_kind:"profile") and returns the NormalizedProfile + path.
// This test uses a fake in-memory adapter — no process spawning needed.

// ——— fake adapter (same pattern as pap-protocol-three-stage.test.ts) ————————

class FakeGpuAdapter implements PAP.ProfileAdapter {
  readonly id = "fake-ncu"
  readonly vendor = "nvidia" as const
  readonly domain = "gpu_kernel" as const
  readonly privileges = [{ kind: "gpu_performance_counter" as const, reason: "test" }]
  readonly mapping: PAP.MetricMapping = {
    adapterId: "fake-ncu",
    domain: "gpu_kernel",
    availableMetrics: ["sm__throughput", "gpu__dram_throughput", "sm__warps_active", "gpu__time_duration"],
    entries: [
      { neutral: "compute_throughput_pct", native: "sm__throughput", semantic: "exact" },
      { neutral: "memory_throughput_pct", native: "sm__throughput", semantic: "approximate" },
      { neutral: "dram_bandwidth_pct", native: "gpu__dram_throughput", semantic: "exact" },
      { neutral: "l2_throughput_pct", native: null, reason: "not_collected" },
      { neutral: "occupancy_pct", native: "sm__warps_active", semantic: "exact" },
      { neutral: "valu_utilization_pct", native: null, reason: "not_collected" },
      { neutral: "salu_busy_pct", native: null, reason: "metric_not_in_this_profiler", detail: "ncu has no SALU metric" },
      { neutral: "duration_ns", native: "gpu__time_duration", semantic: "exact" },
      {
        neutral: "compute_bound",
        native: ["sm__throughput", "gpu__dram_throughput"],
        semantic: "exact",
        derived: true,
        formula: "compute_throughput_pct > memory_throughput_pct",
      },
    ],
  }

  async collect(target: PAP.ProfileTarget): Promise<PAP.NativeReportRef> {
    return { path: `/tmp/fake-${target.command}.ncu-rep`, format: "ncu-rep", bytes: 1024 }
  }

  async parse(report: PAP.NativeReportRef): Promise<PAP.RawProfile> {
    return {
      adapterId: this.id,
      vendor: this.vendor,
      domain: this.domain,
      target: { command: "test-app" },
      nativeSummary: {
        sm__throughput: 87,
        gpu__dram_throughput: 42,
        sm__warps_active: 75,
        gpu__time_duration: 50_000,
      },
      hotspots: [
        {
          name: "matmul_kernel",
          kind: "kernel",
          self_pct: 72.5,
          nativeMetrics: { sm__throughput: 87, gpu__dram_throughput: 42, gpu__time_duration: 36_000 },
        },
        {
          name: "reduce_kernel",
          kind: "kernel",
          self_pct: 20.1,
          nativeMetrics: { sm__throughput: 45, gpu__dram_throughput: 91, gpu__time_duration: 10_000 },
        },
      ],
      availableMetrics: this.mapping.availableMetrics,
      raw_report_ref: report,
    }
  }

  normalize(raw: PAP.RawProfile): PAP.NormalizedProfile {
    const toMetrics = (nm: Record<string, number | string>) => {
      const get = (k: string) => { const v = nm[k]; return v !== undefined ? Number(v) : undefined }
      const compute = get("sm__throughput")
      const dram = get("gpu__dram_throughput")
      const occ = get("sm__warps_active")
      const dur = get("gpu__time_duration")
      return {
        compute_throughput_pct: compute !== undefined ? PAP.present(compute, "pct", { nativeMetric: "sm__throughput", semantic: "exact" }) : PAP.missing("not_collected"),
        memory_throughput_pct: compute !== undefined ? PAP.present(compute, "pct", { nativeMetric: "sm__throughput", semantic: "approximate" }) : PAP.missing("not_collected"),
        dram_bandwidth_pct: dram !== undefined ? PAP.present(dram, "pct", { nativeMetric: "gpu__dram_throughput", semantic: "exact" }) : PAP.missing("not_collected"),
        l2_throughput_pct: PAP.missing("not_collected"),
        occupancy_pct: occ !== undefined ? PAP.present(occ, "pct", { nativeMetric: "sm__warps_active", semantic: "exact" }) : PAP.missing("not_collected"),
        valu_utilization_pct: PAP.missing("not_collected"),
        salu_busy_pct: PAP.missing("metric_not_in_this_profiler", "ncu has no SALU metric"),
        duration_ns: dur !== undefined ? PAP.present(dur, "ns", { nativeMetric: "gpu__time_duration", semantic: "exact" }) : PAP.missing("not_collected"),
        compute_bound: (compute !== undefined && dram !== undefined) ? PAP.present(compute > dram, "bool", {
          nativeMetric: ["sm__throughput", "gpu__dram_throughput"], semantic: "exact", derived: true,
          formula: "compute_throughput_pct > memory_throughput_pct",
        }) : PAP.missing("not_collected", "metrics missing"),
      }
    }

    const ns = raw.nativeSummary
    return {
      domain: this.domain,
      vendor: this.vendor,
      adapterId: this.id,
      target: raw.target,
      duration_ns: 50_000,
      hotspots: raw.hotspots.map((h) => ({
        kernel: h.name,
        self_pct: h.self_pct ?? 0,
        metrics: toMetrics(h.nativeMetrics),
      })),
      summary: toMetrics(ns),
      raw_report_ref: raw.raw_report_ref,
    }
  }
}

// ——— tests ——————————————————————————————————————————————————————————————————

describe("P4A profile evidence artifact", () => {
  const artifactDir = path.join(os.tmpdir(), `deepagent-p4a-test-${Date.now()}`)
  afterAll(async () => { await fs.rm(artifactDir, { recursive: true, force: true }).catch(() => {}) })

  it("ProfileService.run returns a valid NormalizedProfile", async () => {
    const adapter = new FakeGpuAdapter()
    const result = await ProfileService.run(adapter, { command: "test-app" }, { artifactDir })
    const { profile } = result

    expect(profile.adapterId).toBe("fake-ncu")
    expect(profile.domain).toBe("gpu_kernel")
    expect(profile.vendor).toBe("nvidia")
    expect(profile.hotspots.length).toBe(2)
    expect(profile.hotspots[0]!.kernel).toBe("matmul_kernel")
    expect(profile.hotspots[0]!.self_pct).toBe(72.5)
  })

  it("ProfileService.run returns an artifactPath pointing to PROFILE_RESULT.json", async () => {
    const adapter = new FakeGpuAdapter()
    const result = await ProfileService.run(adapter, { command: "test-app" }, { artifactDir })
    expect(result.artifactPath).toBe(path.join(artifactDir, "PROFILE_RESULT.json"))
  })

  it("PROFILE_RESULT.json has evidence_kind:profile and correct shape", async () => {
    const adapter = new FakeGpuAdapter()
    await ProfileService.run(adapter, { command: "test-app" }, { artifactDir })

    const raw = await fs.readFile(path.join(artifactDir, "PROFILE_RESULT.json"), "utf8")
    const artifact = JSON.parse(raw) as ProfileService.ProfileArtifact

    expect(artifact.evidence_kind).toBe("profile")
    expect(typeof artifact.generated_at).toBe("string")
    expect(artifact.profile.adapterId).toBe("fake-ncu")
    expect(artifact.roofline).toBeDefined()
    expect(["compute", "memory", "latency", "balanced"]).toContain(artifact.roofline.bound)
    expect(artifact.roofline.derived).toBe(true)
    expect(typeof artifact.roofline.detail).toBe("string")
    expect(artifact.roofline.detail.length).toBeGreaterThan(0)
  })

  it("PROFILE_RESULT.json hotspots contain neutral metric names (no native leak)", async () => {
    const adapter = new FakeGpuAdapter()
    await ProfileService.run(adapter, { command: "test-app" }, { artifactDir })

    const raw = await fs.readFile(path.join(artifactDir, "PROFILE_RESULT.json"), "utf8")
    const artifact = JSON.parse(raw) as ProfileService.ProfileArtifact
    const hotspot = artifact.profile.hotspots[0]!
    const metricKeys = Object.keys(hotspot.metrics)

    // Must have neutral names
    expect(metricKeys).toContain("compute_throughput_pct")
    expect(metricKeys).toContain("occupancy_pct")
    // Must NOT have native names
    expect(metricKeys).not.toContain("sm__throughput")
    expect(metricKeys).not.toContain("gpu__dram_throughput")
  })

  it("raw_report_ref stays as a path reference, not inlined into the artifact", async () => {
    const adapter = new FakeGpuAdapter()
    await ProfileService.run(adapter, { command: "test-app" }, { artifactDir })

    const raw = await fs.readFile(path.join(artifactDir, "PROFILE_RESULT.json"), "utf8")
    const artifact = JSON.parse(raw) as ProfileService.ProfileArtifact

    // Native report is a ref, not an inline blob
    expect(artifact.profile.raw_report_ref.path).toBeTruthy()
    expect(artifact.profile.raw_report_ref.format).toBe("ncu-rep")
    // The artifact JSON should not contain the raw report bytes inline
    // (size sanity: no huge embedded blob)
    expect(raw.length).toBeLessThan(100_000)
  })
})
