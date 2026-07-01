import * as Log from "@deepagent-code/core/util/log"
import { which } from "@deepagent-code/core/util/which"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"
import { RuntimeBase } from "@/runtime/base"

const log = Log.create({ service: "profile.ncu" })

// —— binary probe (injectable, mirrors DebugAdapter.BinaryProbe) ——————————————

export interface NcuBinaryProbe {
  readonly locate: (command: string) => string | null
}

export const defaultNcuProbe: NcuBinaryProbe = { locate: (cmd) => which(cmd) }
export const installedNcuProbe = (installed: Iterable<string>): NcuBinaryProbe => {
  const set = new Set(installed)
  return { locate: (cmd) => (set.has(cmd) ? `/usr/local/bin/${cmd}` : null) }
}
export const missingNcuProbe: NcuBinaryProbe = { locate: () => null }

// —— mapping ————————————————————————————————————————————————————————————————

/**
 * ncu native metric names (from ncu --csv output).
 * See §P1A-V 表1 and NVIDIA Nsight Compute Profiling Guide.
 */
const N = {
  computeThroughput: "sm__throughput.avg.pct_of_peak_sustained_elapsed",
  memoryThroughput: "gpu__compute_memory_throughput.avg.pct_of_peak_sustained_elapsed",
  dramBandwidth: "gpu__dram_throughput.avg.pct_of_peak_sustained_elapsed",
  l2Throughput: "lts__throughput.avg.pct_of_peak_sustained_elapsed",
  occupancy: "sm__warps_active.avg.pct_of_peak_sustained_active",
  // sm__pipe_fma_cycles_active is an approximation of vector ALU utilization (ncu has
  // no single exact equivalent to rocprof VALUUtilization).
  valuUtilization: "sm__pipe_fma_cycles_active.avg.pct_of_peak_sustained_active",
  duration: "gpu__time_duration.sum",
} as const

const AVAILABLE = Object.values(N) as string[]

export const ncuMapping: PAP.MetricMapping = {
  adapterId: "ncu",
  domain: "gpu_kernel",
  availableMetrics: AVAILABLE,
  entries: [
    { neutral: "compute_throughput_pct", native: N.computeThroughput, semantic: "exact" },
    { neutral: "memory_throughput_pct", native: N.memoryThroughput, semantic: "exact" },
    { neutral: "dram_bandwidth_pct", native: N.dramBandwidth, semantic: "exact" },
    { neutral: "l2_throughput_pct", native: N.l2Throughput, semantic: "exact" },
    { neutral: "occupancy_pct", native: N.occupancy, semantic: "exact" },
    // sm__pipe_fma_cycles_active is approximate for valu_utilization: it measures FMA pipe
    // activity, not all vector ALU paths. §P1A-V 映射原则 2.
    { neutral: "valu_utilization_pct", native: N.valuUtilization, semantic: "approximate" },
    // ncu has NO direct scalar ALU busy metric — salu_busy_pct is AMD-native. §P1A-V 表1.
    { neutral: "salu_busy_pct", native: null, reason: "metric_not_in_this_profiler", detail: "ncu has no scalar ALU busy metric; SALUBusy is AMD-native" },
    { neutral: "duration_ns", native: N.duration, semantic: "exact" },
    // compute_bound is PAP-derived: compute throughput > memory throughput by threshold.
    {
      neutral: "compute_bound",
      native: [N.computeThroughput, N.memoryThroughput],
      semantic: "exact",
      derived: true,
      formula: "compute_throughput_pct > memory_throughput_pct",
    },
  ],
}

// validate at module load (registration-time anti-套壳 gate)
const _mappingValidation = Vocabulary.validateMapping(ncuMapping)
if (!_mappingValidation.ok) {
  log.warn("ncu mapping validation failed at load time", { issues: _mappingValidation.issues })
}

// —— CSV parsing helpers ————————————————————————————————————————————————————

/**
 * Parse ncu --csv output. Each row is one metric for one kernel invocation.
 * Columns (in order): ID, Process ID, Process Name, Host Name, Kernel Name,
 * Kernel Time, Context, Stream, Section Name, Metric Name, Metric Unit, Metric Value.
 * Returns a map: kernelName → { metricName → value }.
 */
export function parseNcuCsv(csv: string): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>()
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('"ID"') && !l.startsWith("ID,"))
  for (const line of lines) {
    const cols = splitCsvRow(line)
    if (cols.length < 12) continue
    // columns: ID, PID, ProcName, Host, KernelName, KernelTime, Ctx, Stream, Section, MetricName, MetricUnit, MetricValue
    const kernelName = cols[4]?.trim().replace(/^"|"$/g, "") ?? ""
    const metricName = cols[9]?.trim().replace(/^"|"$/g, "") ?? ""
    const metricValue = parseFloat(cols[11]?.trim().replace(/^"|"$/g, "") ?? "NaN")
    if (!kernelName || !metricName || isNaN(metricValue)) continue
    if (!result.has(kernelName)) result.set(kernelName, new Map())
    result.get(kernelName)!.set(metricName, metricValue)
  }
  return result
}

/** Minimal CSV row splitter (handles quoted fields). */
function splitCsvRow(row: string): string[] {
  const cols: string[] = []
  let cur = ""
  let inQuote = false
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!
    if (ch === '"') { inQuote = !inQuote }
    else if (ch === "," && !inQuote) { cols.push(cur); cur = "" }
    else { cur += ch }
  }
  cols.push(cur)
  return cols
}

// —— adapter ————————————————————————————————————————————————————————————————

export class NcuAdapter implements PAP.ProfileAdapter {
  readonly id = "ncu"
  readonly vendor = "nvidia" as const
  readonly domain = "gpu_kernel" as const
  readonly privileges: readonly RuntimeBase.PrivilegeSpec[] = [
    { kind: "gpu_performance_counter", reason: "ncu needs GPU hardware performance counters (requires NVIDIA driver permission or admin)" },
  ]
  readonly mapping = ncuMapping

  constructor(private readonly probe: NcuBinaryProbe = defaultNcuProbe) {}

  async collect(target: PAP.ProfileTarget): Promise<PAP.NativeReportRef> {
    const bin = this.probe.locate("ncu")
    if (!bin) {
      const msg = "ncu (NVIDIA Nsight Compute) is not installed or not on PATH. Install it via the NVIDIA CUDA Toolkit."
      log.info(msg)
      return Promise.reject(new Error(msg))
    }
    const outPath = `/tmp/deepagent-ncu-${Date.now()}`
    const args = [
      "--set", "full",
      "--target-processes", "all",
      "-o", outPath,
      "--",
      target.command,
      ...(target.args ?? []),
    ]
    log.info("ncu collect", { command: bin, args })
    // Build the export command for re-deriving a CSV view.
    const exportCommand = `${bin} --import ${outPath}.ncu-rep --csv`

    const { Process } = await import("@/util/process")
    const result = await Process.run([bin, ...args], { cwd: target.cwd, nothrow: true })
    if (result.code !== 0) {
      const msg = `ncu exited with code ${result.code}: ${result.stderr.toString().trim()}`
      log.warn(msg)
      return Promise.reject(new Error(msg))
    }
    return {
      path: `${outPath}.ncu-rep`,
      format: "ncu-rep",
      exportCommand,
    }
  }

  async parse(report: PAP.NativeReportRef): Promise<PAP.RawProfile> {
    // Re-export to CSV via `ncu --import ... --csv`, or read if already CSV.
    let csvText: string
    if (report.format === "csv") {
      const fs = await import("fs/promises")
      csvText = await fs.readFile(report.path, "utf8")
    } else {
      const bin = this.probe.locate("ncu")
      if (!bin) {
        return Promise.reject(new Error("ncu binary required to parse .ncu-rep; not found on PATH"))
      }
      const { Process } = await import("@/util/process")
      const result = await Process.run([bin, "--import", report.path, "--csv"], { nothrow: true })
      if (result.code !== 0) {
        return Promise.reject(new Error(`ncu --import failed (code ${result.code}): ${result.stderr.toString().trim()}`))
      }
      csvText = result.stdout.toString()
    }

    const kernelMap = parseNcuCsv(csvText)
    const hotspots: PAP.RawHotspot[] = []
    for (const [kernelName, metrics] of kernelMap) {
      const nativeMetrics: Record<string, number | string> = {}
      for (const [k, v] of metrics) nativeMetrics[k] = v
      hotspots.push({
        name: kernelName,
        kind: "kernel",
        nativeMetrics,
        // self_pct derived from sm__throughput or left undefined here (normalize stage fills it)
      })
    }

    // Build a summary from the first (or aggregated) kernel's metrics.
    const firstKernel = hotspots[0]
    const nativeSummary: Record<string, number | string> = firstKernel
      ? { ...firstKernel.nativeMetrics }
      : {}

    return {
      adapterId: this.id,
      vendor: this.vendor,
      domain: this.domain,
      target: { command: report.path },
      nativeSummary,
      hotspots,
      availableMetrics: AVAILABLE,
      raw_report_ref: report,
    }
  }

  normalize(raw: PAP.RawProfile): PAP.NormalizedProfile {
    const summary: Record<string, PAP.MetricValue> = {}

    const getNative = (bag: Record<string, number | string>, key: string): number | undefined => {
      const v = bag[key]
      if (v === undefined || v === "") return undefined
      const n = Number(v)
      return isNaN(n) ? undefined : n
    }

    // Compute top-level summary from nativeSummary (first kernel or aggregated).
    const ns = raw.nativeSummary
    const computePct = getNative(ns, N.computeThroughput)
    const memPct = getNative(ns, N.memoryThroughput)
    const dramPct = getNative(ns, N.dramBandwidth)
    const l2Pct = getNative(ns, N.l2Throughput)
    const occPct = getNative(ns, N.occupancy)
    const valuPct = getNative(ns, N.valuUtilization)
    const durationRaw = getNative(ns, N.duration)

    summary["compute_throughput_pct"] = computePct !== undefined
      ? PAP.present(computePct, "pct", { nativeMetric: N.computeThroughput, semantic: "exact" })
      : PAP.missing("not_collected")

    summary["memory_throughput_pct"] = memPct !== undefined
      ? PAP.present(memPct, "pct", { nativeMetric: N.memoryThroughput, semantic: "exact" })
      : PAP.missing("not_collected")

    summary["dram_bandwidth_pct"] = dramPct !== undefined
      ? PAP.present(dramPct, "pct", { nativeMetric: N.dramBandwidth, semantic: "exact" })
      : PAP.missing("not_collected")

    summary["l2_throughput_pct"] = l2Pct !== undefined
      ? PAP.present(l2Pct, "pct", { nativeMetric: N.l2Throughput, semantic: "exact" })
      : PAP.missing("not_collected")

    summary["occupancy_pct"] = occPct !== undefined
      ? PAP.present(occPct, "pct", { nativeMetric: N.occupancy, semantic: "exact" })
      : PAP.missing("not_collected")

    summary["valu_utilization_pct"] = valuPct !== undefined
      ? PAP.present(valuPct, "pct", {
          nativeMetric: N.valuUtilization,
          semantic: "approximate", // FMA pipe ≠ all vector ALU paths
        })
      : PAP.missing("not_collected")

    // salu_busy_pct: ncu has no scalar ALU busy metric — honest null.
    summary["salu_busy_pct"] = PAP.missing("metric_not_in_this_profiler", "ncu has no scalar ALU busy metric; SALUBusy is AMD-native")

    // duration_ns: ncu reports in nanoseconds (gpu__time_duration.sum unit = ns).
    summary["duration_ns"] = durationRaw !== undefined
      ? PAP.present(durationRaw, "ns", { nativeMetric: N.duration, semantic: "exact" })
      : PAP.missing("not_collected")

    // compute_bound: PAP-derived boolean — compute throughput strictly exceeds memory.
    if (computePct !== undefined && memPct !== undefined) {
      summary["compute_bound"] = PAP.present(computePct > memPct, "bool", {
        nativeMetric: [N.computeThroughput, N.memoryThroughput],
        semantic: "exact",
        derived: true,
        formula: "compute_throughput_pct > memory_throughput_pct",
      })
    } else {
      summary["compute_bound"] = PAP.missing("not_collected", "compute or memory throughput metrics missing")
    }

    // self_pct is a TIME share, so derive it from each kernel's duration relative
    // to the sum of all kernel durations — NOT from compute throughput (which is a
    // rate, not a time, and would mis-rank hotspots and mislabel the number).
    // When durations are unavailable we leave self_pct at 0 (honest: "unranked")
    // rather than substituting an unrelated metric.
    const kernelDurations = raw.hotspots.map((h) => getNative(h.nativeMetrics, N.duration))
    const totalDurationNs = kernelDurations.reduce<number>((sum, d) => sum + (d ?? 0), 0)

    // Per-kernel hotspots.
    const hotspots: PAP.Hotspot[] = raw.hotspots.map((h, i) => {
      const nm = h.nativeMetrics
      const cPct = getNative(nm, N.computeThroughput)
      const mPct = getNative(nm, N.memoryThroughput)
      const dur = getNative(nm, N.duration)
      const durForSelf = kernelDurations[i]
      const selfPct =
        h.self_pct ?? (totalDurationNs > 0 && durForSelf !== undefined ? (durForSelf / totalDurationNs) * 100 : 0)
      const metrics: Record<string, PAP.MetricValue> = {
        compute_throughput_pct: cPct !== undefined
          ? PAP.present(cPct, "pct", { nativeMetric: N.computeThroughput, semantic: "exact" })
          : PAP.missing("not_collected"),
        memory_throughput_pct: mPct !== undefined
          ? PAP.present(mPct, "pct", { nativeMetric: N.memoryThroughput, semantic: "exact" })
          : PAP.missing("not_collected"),
        dram_bandwidth_pct: (() => {
          const v = getNative(nm, N.dramBandwidth)
          return v !== undefined ? PAP.present(v, "pct", { nativeMetric: N.dramBandwidth, semantic: "exact" }) : PAP.missing("not_collected")
        })(),
        l2_throughput_pct: (() => {
          const v = getNative(nm, N.l2Throughput)
          return v !== undefined ? PAP.present(v, "pct", { nativeMetric: N.l2Throughput, semantic: "exact" }) : PAP.missing("not_collected")
        })(),
        occupancy_pct: (() => {
          const v = getNative(nm, N.occupancy)
          return v !== undefined ? PAP.present(v, "pct", { nativeMetric: N.occupancy, semantic: "exact" }) : PAP.missing("not_collected")
        })(),
        valu_utilization_pct: (() => {
          const v = getNative(nm, N.valuUtilization)
          return v !== undefined ? PAP.present(v, "pct", { nativeMetric: N.valuUtilization, semantic: "approximate" }) : PAP.missing("not_collected")
        })(),
        salu_busy_pct: PAP.missing("metric_not_in_this_profiler", "ncu has no scalar ALU busy metric"),
        duration_ns: dur !== undefined
          ? PAP.present(dur, "ns", { nativeMetric: N.duration, semantic: "exact" })
          : PAP.missing("not_collected"),
        compute_bound: (cPct !== undefined && mPct !== undefined)
          ? PAP.present(cPct > mPct, "bool", {
              nativeMetric: [N.computeThroughput, N.memoryThroughput],
              semantic: "exact",
              derived: true,
              formula: "compute_throughput_pct > memory_throughput_pct",
            })
          : PAP.missing("not_collected", "compute or memory throughput missing"),
      }
      return {
        kernel: h.name,
        file_line: h.file_line,
        self_pct: selfPct,
        total_pct: h.total_pct,
        metrics,
      }
    })

    return {
      domain: this.domain,
      vendor: this.vendor,
      adapterId: this.id,
      target: raw.target,
      duration_ns: durationRaw ?? null,
      hotspots,
      summary,
      raw_report_ref: raw.raw_report_ref,
    }
  }
}

export const makeNcuAdapter = (probe: NcuBinaryProbe = defaultNcuProbe): PAP.ProfileAdapter =>
  new NcuAdapter(probe)
