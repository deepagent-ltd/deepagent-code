import * as Log from "@deepagent-code/core/util/log"
import { which } from "@deepagent-code/core/util/which"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"
import { RuntimeBase } from "@/runtime/base"

const log = Log.create({ service: "profile.rocprof" })

// —— binary probe ————————————————————————————————————————————————————————————

export interface RocprofBinaryProbe {
  readonly locate: (command: string) => string | null
}

export const defaultRocprofProbe: RocprofBinaryProbe = { locate: (cmd) => which(cmd) }
export const installedRocprofProbe = (installed: Iterable<string>): RocprofBinaryProbe => {
  const set = new Set(installed)
  return { locate: (cmd) => (set.has(cmd) ? `/usr/local/bin/${cmd}` : null) }
}
export const missingRocprofProbe: RocprofBinaryProbe = { locate: () => null }

// —— mapping ————————————————————————————————————————————————————————————————

/**
 * AMD rocprofv3 native metric names.
 * See §P1A-V 表1 and AMD ROCprofiler-SDK docs.
 */
const N = {
  gpuBusy: "GPUBusy",
  memUnitBusy: "MemUnitBusy",
  // L2CacheHit is a hit-rate (%), NOT throughput — semantic:"approximate" when mapped to
  // l2_throughput_pct. §P1A-V 映射原则 2.
  l2CacheHit: "L2CacheHit",
  wavefronts: "Wavefronts",
  valuUtilization: "VALUUtilization",
  saluBusy: "SALUBusy",
  beginNs: "BeginNs",
  endNs: "EndNs",
} as const

const AVAILABLE = Object.values(N) as string[]

export const rocprofMapping: PAP.MetricMapping = {
  adapterId: "rocprof",
  domain: "gpu_kernel",
  availableMetrics: AVAILABLE,
  entries: [
    // GPUBusy is GPU-wide busy percent, not SM compute throughput — approximate mapping.
    { neutral: "compute_throughput_pct", native: N.gpuBusy, semantic: "approximate" },
    // MemUnitBusy ≈ memory unit utilization — maps to memory_throughput_pct (approximate).
    { neutral: "memory_throughput_pct", native: N.memUnitBusy, semantic: "approximate" },
    // rocprof lacks a direct DRAM bandwidth % metric; MemUnitBusy is the closest proxy.
    { neutral: "dram_bandwidth_pct", native: N.memUnitBusy, semantic: "approximate" },
    // L2CacheHit is hit-rate, NOT throughput. §P1A-V 表1 footnote: semantic:"approximate".
    { neutral: "l2_throughput_pct", native: N.l2CacheHit, semantic: "approximate" },
    // Wavefronts / theoretical_max gives occupancy — approximate (needs theoretical max).
    { neutral: "occupancy_pct", native: N.wavefronts, semantic: "approximate" },
    // VALUUtilization is the vector ALU utilization — direct rocprof native metric.
    { neutral: "valu_utilization_pct", native: N.valuUtilization, semantic: "exact" },
    // SALUBusy is AMD-native; ncu has no equivalent.
    { neutral: "salu_busy_pct", native: N.saluBusy, semantic: "exact" },
    // duration_ns: kernel wall time = EndNs - BeginNs.
    { neutral: "duration_ns", native: [N.beginNs, N.endNs], semantic: "exact" },
    // compute_bound: PAP-derived — GPUBusy > MemUnitBusy.
    {
      neutral: "compute_bound",
      native: [N.gpuBusy, N.memUnitBusy],
      semantic: "approximate", // both inputs are approximate mappings
      derived: true,
      formula: "GPUBusy > MemUnitBusy",
    },
  ],
}

const _mappingValidation = Vocabulary.validateMapping(rocprofMapping)
if (!_mappingValidation.ok) {
  log.warn("rocprof mapping validation failed at load time", { issues: _mappingValidation.issues })
}

// —— CSV parsing helpers ————————————————————————————————————————————————————

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

function cleanField(s: string): string {
  return s.trim().replace(/^"|"$/g, "")
}

export interface RocprofKernelRow {
  kernelName: string
  gpuId: number
  metrics: Record<string, number>
}

/**
 * Parse rocprofv3 CSV output.
 * Canonical columns include: Kernel_Name, gpu-id, GPUBusy, MemUnitBusy,
 * VALUUtilization, SALUBusy, Wavefronts, L2CacheHit, BeginNs, EndNs.
 */
export function parseRocprofCsv(csv: string): RocprofKernelRow[] {
  const rows: RocprofKernelRow[] = []
  const lines = csv.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return rows

  // Find header line.
  let headerIdx = 0
  let headers: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const fields = splitCsvRow(lines[i]!).map(cleanField)
    // Detect header by presence of "Kernel_Name" or "kernel_name".
    if (fields.some((f) => f.toLowerCase() === "kernel_name")) {
      headerIdx = i
      headers = fields
      break
    }
  }
  if (!headers.length) return rows

  const idxKernelName = headers.findIndex((h) => h.toLowerCase() === "kernel_name")
  const idxGpuId = headers.findIndex((h) => h.toLowerCase() === "gpu-id")

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = splitCsvRow(lines[i]!).map(cleanField)
    if (cols.length < headers.length) continue
    const kernelName = cols[idxKernelName >= 0 ? idxKernelName : 0] ?? ""
    if (!kernelName) continue
    const gpuId = parseInt(cols[idxGpuId >= 0 ? idxGpuId : 1] ?? "0", 10)
    const metrics: Record<string, number> = {}
    for (let j = 0; j < headers.length; j++) {
      const h = headers[j]!
      const v = parseFloat(cols[j] ?? "NaN")
      if (!isNaN(v)) metrics[h] = v
    }
    rows.push({ kernelName, gpuId, metrics })
  }
  return rows
}

// —— adapter ————————————————————————————————————————————————————————————————

/**
 * Theoretical maximum wavefronts per CU (depends on GPU architecture).
 * Without querying the device, we use a reasonable default for modern AMD GPUs.
 * Adapters should query `rocminfo` at registration for the real value.
 */
const DEFAULT_MAX_WAVEFRONTS_PER_CU = 40

export class RocprofAdapter implements PAP.ProfileAdapter {
  readonly id = "rocprof"
  readonly vendor = "amd" as const
  readonly domain = "gpu_kernel" as const
  readonly privileges: readonly RuntimeBase.PrivilegeSpec[] = [
    { kind: "rocm_profiling", reason: "rocprofv3 requires ROCm profiling access (rocm-smi permissions or root)" },
  ]
  readonly mapping = rocprofMapping

  constructor(
    private readonly probe: RocprofBinaryProbe = defaultRocprofProbe,
    /** Theoretical max wavefronts per CU for occupancy calculation. */
    private readonly maxWavefrontsPerCu: number = DEFAULT_MAX_WAVEFRONTS_PER_CU,
  ) {}

  async collect(target: PAP.ProfileTarget): Promise<PAP.NativeReportRef> {
    const bin = this.probe.locate("rocprofv3")
    if (!bin) {
      const msg = "rocprofv3 (AMD ROCprofiler-SDK) is not installed or not on PATH. Install via ROCm: `sudo apt install rocprofiler-sdk`."
      log.info(msg)
      return Promise.reject(new Error(msg))
    }
    const outDir = `/tmp/deepagent-rocprof-${Date.now()}`
    const metrics = [
      "GPUBusy", "MemUnitBusy", "VALUUtilization", "SALUBusy", "Wavefronts",
      "L2CacheHit",
    ]
    const args = [
      "--kernel-trace",
      "--hip-trace",
      "--output-format", "csv",
      "--output-directory", outDir,
      "-M", metrics.join(","),
      "--",
      target.command,
      ...(target.args ?? []),
    ]
    log.info("rocprofv3 collect", { command: bin, args })

    const { Process } = await import("@/util/process")
    const result = await Process.run([bin, ...args], { cwd: target.cwd, nothrow: true })
    if (result.code !== 0) {
      const msg = `rocprofv3 exited with code ${result.code}: ${result.stderr.toString().trim()}`
      log.warn(msg)
      return Promise.reject(new Error(msg))
    }
    return {
      path: `${outDir}/results.csv`,
      format: "csv",
    }
  }

  async parse(report: PAP.NativeReportRef): Promise<PAP.RawProfile> {
    const fs = await import("fs/promises")
    const text = await fs.readFile(report.path, "utf8")
    const rows = parseRocprofCsv(text)

    const hotspots: PAP.RawHotspot[] = rows.map((r) => ({
      name: r.kernelName,
      kind: "kernel" as const,
      nativeMetrics: r.metrics as Record<string, number | string>,
    }))

    // nativeSummary: aggregate across all kernels (take first as representative).
    const nativeSummary: Record<string, number | string> =
      rows.length > 0 ? { ...rows[0]!.metrics } : {}

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
    const getNative = (bag: Record<string, number | string>, key: string): number | undefined => {
      const v = bag[key]
      if (v === undefined || v === "") return undefined
      const n = Number(v)
      return isNaN(n) ? undefined : n
    }

    const normKernel = (nm: Record<string, number | string>): Record<string, PAP.MetricValue> => {
      const gpuBusy = getNative(nm, N.gpuBusy)
      const memUnitBusy = getNative(nm, N.memUnitBusy)
      const l2CacheHit = getNative(nm, N.l2CacheHit)
      const wavefronts = getNative(nm, N.wavefronts)
      const valuUtil = getNative(nm, N.valuUtilization)
      const saluBusy = getNative(nm, N.saluBusy)
      const beginNs = getNative(nm, N.beginNs)
      const endNs = getNative(nm, N.endNs)

      // Occupancy: Wavefronts / theoretical_max_per_CU → [0,100]%.
      // This is an approximation without knowing the exact CU count and hardware limit.
      const occupancyPct =
        wavefronts !== undefined
          ? Math.min(100, (wavefronts / this.maxWavefrontsPerCu) * 100)
          : undefined

      const durNs = beginNs !== undefined && endNs !== undefined ? endNs - beginNs : undefined

      return {
        // GPUBusy → compute_throughput_pct: approximate (GPU-wide busy ≠ SM compute throughput).
        compute_throughput_pct: gpuBusy !== undefined
          ? PAP.present(gpuBusy, "pct", { nativeMetric: N.gpuBusy, semantic: "approximate" })
          : PAP.missing("not_collected"),

        // MemUnitBusy → memory_throughput_pct: approximate.
        memory_throughput_pct: memUnitBusy !== undefined
          ? PAP.present(memUnitBusy, "pct", { nativeMetric: N.memUnitBusy, semantic: "approximate" })
          : PAP.missing("not_collected"),

        // MemUnitBusy → dram_bandwidth_pct: approximate (same metric, different intent).
        dram_bandwidth_pct: memUnitBusy !== undefined
          ? PAP.present(memUnitBusy, "pct", { nativeMetric: N.memUnitBusy, semantic: "approximate" })
          : PAP.missing("not_collected"),

        // L2CacheHit is a hit-rate (%), NOT throughput. Semantically approximate.
        l2_throughput_pct: l2CacheHit !== undefined
          ? PAP.present(l2CacheHit, "pct", { nativeMetric: N.l2CacheHit, semantic: "approximate" })
          : PAP.missing("not_collected"),

        // Wavefronts / theoretical max → occupancy %.
        occupancy_pct: occupancyPct !== undefined
          ? PAP.present(occupancyPct, "pct", {
              nativeMetric: N.wavefronts,
              semantic: "approximate",
              derived: false,
              conversion: `wavefronts / ${this.maxWavefrontsPerCu} * 100`,
            })
          : PAP.missing("not_collected"),

        // VALUUtilization is exact.
        valu_utilization_pct: valuUtil !== undefined
          ? PAP.present(valuUtil, "pct", { nativeMetric: N.valuUtilization, semantic: "exact" })
          : PAP.missing("not_collected"),

        // SALUBusy is AMD-native; has no ncu equivalent.
        salu_busy_pct: saluBusy !== undefined
          ? PAP.present(saluBusy, "pct", { nativeMetric: N.saluBusy, semantic: "exact" })
          : PAP.missing("not_collected"),

        // duration_ns = EndNs - BeginNs.
        duration_ns: durNs !== undefined
          ? PAP.present(durNs, "ns", {
              nativeMetric: [N.beginNs, N.endNs],
              semantic: "exact",
              conversion: "EndNs - BeginNs",
            })
          : PAP.missing("not_collected"),

        // compute_bound: PAP-derived from GPUBusy > MemUnitBusy (both approximate).
        compute_bound: gpuBusy !== undefined && memUnitBusy !== undefined
          ? PAP.present(gpuBusy > memUnitBusy, "bool", {
              nativeMetric: [N.gpuBusy, N.memUnitBusy],
              semantic: "approximate",
              derived: true,
              formula: "GPUBusy > MemUnitBusy",
            })
          : PAP.missing("not_collected", "GPUBusy or MemUnitBusy metrics missing"),
      }
    }

    const summaryMetrics = normKernel(raw.nativeSummary)

    // self_pct is a TIME share. Derive it from each kernel's (EndNs − BeginNs)
    // duration relative to the sum across kernels. Kernels missing timestamps
    // contribute 0 and stay unranked (honest) — the previous `? 0 : 0` dead ternary
    // pinned every AMD kernel to 0, collapsing sort order and defeating diff.
    const durations = raw.hotspots.map((h) => {
      const nm = h.nativeMetrics as Record<string, number | string>
      const beginNs = Number(nm[N.beginNs] ?? NaN)
      const endNs = Number(nm[N.endNs] ?? NaN)
      return isNaN(beginNs) || isNaN(endNs) ? undefined : endNs - beginNs
    })
    const totalDurationNs = durations.reduce<number>((sum, d) => sum + (d ?? 0), 0)

    const hotspots: PAP.Hotspot[] = raw.hotspots.map((h, i) => {
      const nm = h.nativeMetrics as Record<string, number | string>
      const dur = durations[i]
      const selfPct = h.self_pct ?? (totalDurationNs > 0 && dur !== undefined ? (dur / totalDurationNs) * 100 : 0)
      return {
        kernel: h.name,
        file_line: h.file_line,
        self_pct: selfPct,
        total_pct: h.total_pct,
        metrics: normKernel(nm),
      }
    })

    const durNs = (() => {
      const begin = Number(raw.nativeSummary[N.beginNs] ?? NaN)
      const end = Number(raw.nativeSummary[N.endNs] ?? NaN)
      return isNaN(begin) || isNaN(end) ? null : end - begin
    })()

    return {
      domain: this.domain,
      vendor: this.vendor,
      adapterId: this.id,
      target: raw.target,
      duration_ns: durNs,
      hotspots,
      summary: summaryMetrics,
      raw_report_ref: raw.raw_report_ref,
    }
  }
}

export const makeRocprofAdapter = (
  probe: RocprofBinaryProbe = defaultRocprofProbe,
  maxWavefrontsPerCu?: number,
): PAP.ProfileAdapter => new RocprofAdapter(probe, maxWavefrontsPerCu)
