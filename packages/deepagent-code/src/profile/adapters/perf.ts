import * as Log from "@deepagent-code/core/util/log"
import { which } from "@deepagent-code/core/util/which"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"
import { RuntimeBase } from "@/runtime/base"

const log = Log.create({ service: "profile.perf" })

// —— binary probe ————————————————————————————————————————————————————————————

export interface PerfBinaryProbe {
  readonly locate: (command: string) => string | null
}

export const defaultPerfProbe: PerfBinaryProbe = { locate: (cmd) => which(cmd) }
export const installedPerfProbe = (installed: Iterable<string>): PerfBinaryProbe => {
  const set = new Set(installed)
  return { locate: (cmd) => (set.has(cmd) ? `/usr/bin/${cmd}` : null) }
}
export const missingPerfProbe: PerfBinaryProbe = { locate: () => null }

// —— mapping ————————————————————————————————————————————————————————————————

/**
 * Linux perf native event/column names.
 * See §P1A-V 表3 and `perf list` / `perf stat` output.
 * cpu_sampling domain: NO memory_bound_pct or dram_bound_pct (those are cpu_hotspot only).
 */
const N = {
  overhead: "overhead",
  cycles: "cycles",
  instructions: "instructions",
  cacheMisses: "cache-misses",
  cacheReferences: "cache-references",
  branchMisses: "branch-misses",
  branches: "branches",
} as const

const AVAILABLE = Object.values(N) as string[]

export const perfMapping: PAP.MetricMapping = {
  adapterId: "perf",
  domain: "cpu_sampling",
  availableMetrics: AVAILABLE,
  entries: [
    { neutral: "self_pct", native: N.overhead, semantic: "exact" },
    // cpi: vocabulary says derived:false (it's a native concept), but perf computes it from
    // cycles/instructions. We map both natives; formula goes in MetricProvenance on output.
    { neutral: "cpi", native: [N.cycles, N.instructions], semantic: "exact" },
    // ipc: vocabulary says derived:true; must mark derived:true + provide formula.
    {
      neutral: "ipc",
      native: [N.instructions, N.cycles],
      semantic: "exact",
      derived: true,
      formula: "instructions / cycles",
    },
    { neutral: "clockticks", native: N.cycles, semantic: "exact" },
    { neutral: "instructions_retired", native: N.instructions, semantic: "exact" },
    { neutral: "cache_miss_rate", native: [N.cacheMisses, N.cacheReferences], semantic: "exact" },
    { neutral: "branch_misprediction_pct", native: [N.branchMisses, N.branches], semantic: "exact" },
    // memory_bound_pct and dram_bound_pct are cpu_hotspot domain only — NOT applicable to cpu_sampling.
    // (Vocabulary.metricsForDomain("cpu_sampling") does NOT include them, so we must NOT map them.)
  ],
}

const _mappingValidation = Vocabulary.validateMapping(perfMapping)
if (!_mappingValidation.ok) {
  log.warn("perf mapping validation failed at load time", { issues: _mappingValidation.issues })
}

// —— text parsing helpers ————————————————————————————————————————————————————

export interface PerfSymbolRow {
  symbol: string
  object?: string
  overheadPct: number
}

export interface PerfStatRow {
  event: string
  count: number
  unit?: string
}

/**
 * Parse `perf report --stdio -n` output.
 * Lines of interest start with a number (overhead %) followed by columns.
 * Format: "   62.50%  bench    bench          [.] compute_kernel"
 */
export function parsePerfReport(text: string): PerfSymbolRow[] {
  const rows: PerfSymbolRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s+([\d.]+)%\s+\S+\s+(\S+)\s+\[.\]\s+(.+)$/)
    if (!m) continue
    const overheadPct = parseFloat(m[1]!)
    const object = m[2]!
    const symbol = m[3]!.trim()
    if (!symbol || isNaN(overheadPct)) continue
    rows.push({ symbol, object, overheadPct })
  }
  return rows
}

/**
 * Parse `perf stat` output lines.
 * Format: "   2,000,000      cycles                    #    1.50 GHz"
 * Returns a map of event name → count.
 */
export function parsePerfStat(text: string): Map<string, number> {
  const result = new Map<string, number>()
  for (const line of text.split(/\r?\n/)) {
    // Skip comment/header lines
    if (line.trim().startsWith("#") || line.trim().startsWith("Performance")) continue
    // Match: optional leading spaces, number (with commas), whitespace, event name
    const m = line.match(/^\s*([\d,]+)\s+(\S[\w\-:]+)/)
    if (!m) continue
    const count = parseFloat(m[1]!.replace(/,/g, ""))
    const event = m[2]!.trim()
    if (!isNaN(count)) result.set(event, count)
  }
  return result
}

/**
 * Multi-section fixture format for tests.
 * Sections delimited by "=== SECTION: perf_report ===" and "=== SECTION: perf_stat ===".
 */
export function parsePerfMultiSection(text: string): {
  reportRows: PerfSymbolRow[]
  statCounts: Map<string, number>
} {
  const sections = new Map<string, string>()
  let currentSection = ""
  let buf: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^===\s*SECTION:\s*(\w+)\s*===/)
    if (m) {
      if (currentSection && buf.length) sections.set(currentSection, buf.join("\n"))
      currentSection = m[1]!
      buf = []
    } else {
      buf.push(line)
    }
  }
  if (currentSection && buf.length) sections.set(currentSection, buf.join("\n"))

  return {
    reportRows: parsePerfReport(sections.get("perf_report") ?? ""),
    statCounts: parsePerfStat(sections.get("perf_stat") ?? ""),
  }
}

// —— adapter ————————————————————————————————————————————————————————————————

export class PerfAdapter implements PAP.ProfileAdapter {
  readonly id = "perf"
  readonly vendor = "cpu_generic" as const
  readonly domain = "cpu_sampling" as const
  readonly privileges: readonly RuntimeBase.PrivilegeSpec[] = [
    { kind: "perf_event_paranoid", reason: "Linux perf requires perf_event_paranoid <= 2 for CPU sampling", maxParanoid: 2 },
  ]
  readonly mapping = perfMapping

  constructor(private readonly probe: PerfBinaryProbe = defaultPerfProbe) {}

  async collect(target: PAP.ProfileTarget): Promise<PAP.NativeReportRef> {
    const bin = this.probe.locate("perf")
    if (!bin) {
      const msg = "perf (Linux perf_events) is not installed or not on PATH. Install linux-perf or linux-tools-$(uname -r)."
      log.info(msg)
      return Promise.reject(new Error(msg))
    }
    const outPath = `/tmp/deepagent-perf-${Date.now()}.data`
    const args = [
      "record",
      "-g",                    // call graph
      "-e", "cycles,instructions,cache-misses,cache-references,branch-misses,branches",
      "-o", outPath,
      "--",
      target.command,
      ...(target.args ?? []),
    ]
    log.info("perf collect", { command: bin, args })
    const exportCommand = `${bin} report --stdio -n -i ${outPath}`

    const { Process } = await import("@/util/process")
    const result = await Process.run([bin, ...args], { cwd: target.cwd, nothrow: true })
    if (result.code !== 0) {
      const msg = `perf record exited with code ${result.code}: ${result.stderr.toString().trim()}`
      log.warn(msg)
      return Promise.reject(new Error(msg))
    }
    return {
      path: outPath,
      format: "perf-data",
      exportCommand,
    }
  }

  async parse(report: PAP.NativeReportRef): Promise<PAP.RawProfile> {
    let text: string

    if (report.format === "text") {
      // Test fixture: multi-section text already exported.
      const fs = await import("fs/promises")
      text = await fs.readFile(report.path, "utf8")
    } else if (report.format === "perf-data") {
      const bin = this.probe.locate("perf")
      if (!bin) {
        return Promise.reject(new Error("perf binary required to parse perf.data; not found on PATH"))
      }
      const { Process } = await import("@/util/process")
      // Export: `perf report --stdio -n` for symbol hotspots.
      const reportResult = await Process.run([bin, "report", "--stdio", "-n", "-i", report.path], { nothrow: true })
      // Export: `perf stat --log-fd 1 -i` for aggregate event counts.
      const statResult = await Process.run([bin, "stat", "-i", report.path], { nothrow: true })
      text = [
        "=== SECTION: perf_report ===",
        reportResult.stdout.toString(),
        "=== SECTION: perf_stat ===",
        statResult.stdout.toString() + statResult.stderr.toString(),
      ].join("\n")
    } else {
      return Promise.reject(new Error(`perf adapter cannot parse format: ${report.format}`))
    }

    const { reportRows, statCounts } = parsePerfMultiSection(text)

    const hotspots: PAP.RawHotspot[] = reportRows.map((r) => ({
      name: r.symbol,
      kind: "symbol" as const,
      self_pct: r.overheadPct,
      nativeMetrics: {
        [N.overhead]: r.overheadPct,
        // Per-symbol cycles/instructions not available from `perf report --stdio` without -g parsing.
        // They come from `perf stat` aggregate only.
      },
    }))

    // Pull aggregate event counts from perf stat into nativeSummary.
    const nativeSummary: Record<string, number | string> = {}
    for (const [event, count] of statCounts) {
      nativeSummary[event] = count
    }

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

    const ns = raw.nativeSummary
    const cycles = getNative(ns, N.cycles)
    const instructions = getNative(ns, N.instructions)
    const cacheMisses = getNative(ns, N.cacheMisses)
    const cacheRefs = getNative(ns, N.cacheReferences)
    const branchMisses = getNative(ns, N.branchMisses)
    const branches = getNative(ns, N.branches)

    // cpi = cycles / instructions (computed, but vocab says derived:false).
    const cpiVal = cycles !== undefined && instructions !== undefined && instructions > 0
      ? cycles / instructions
      : undefined

    // ipc = instructions / cycles (PAP-derived, vocab says derived:true).
    const ipcVal = instructions !== undefined && cycles !== undefined && cycles > 0
      ? instructions / cycles
      : undefined

    // cache_miss_rate = cache-misses / cache-references (ratio 0–1).
    const cacheMissRate = cacheMisses !== undefined && cacheRefs !== undefined && cacheRefs > 0
      ? cacheMisses / cacheRefs
      : undefined

    // branch_misprediction_pct = branch-misses / branches * 100.
    const branchMispredPct = branchMisses !== undefined && branches !== undefined && branches > 0
      ? (branchMisses / branches) * 100
      : undefined

    const summary: Record<string, PAP.MetricValue> = {
      self_pct: PAP.missing("not_applicable_to_domain", "top-level self_pct is per-symbol, not aggregated"),

      cpi: cpiVal !== undefined
        ? PAP.present(cpiVal, "ratio", {
            nativeMetric: [N.cycles, N.instructions],
            semantic: "exact",
            // cpi is not marked derived in vocab, but we compute it from primitives.
            formula: "cycles / instructions",
          })
        : PAP.missing("not_collected"),

      ipc: ipcVal !== undefined
        ? PAP.present(ipcVal, "ratio", {
            nativeMetric: [N.instructions, N.cycles],
            semantic: "exact",
            derived: true,
            formula: "instructions / cycles",
          })
        : PAP.missing("not_collected"),

      clockticks: cycles !== undefined
        ? PAP.present(cycles, "count", { nativeMetric: N.cycles, semantic: "exact" })
        : PAP.missing("not_collected"),

      instructions_retired: instructions !== undefined
        ? PAP.present(instructions, "count", { nativeMetric: N.instructions, semantic: "exact" })
        : PAP.missing("not_collected"),

      cache_miss_rate: cacheMissRate !== undefined
        ? PAP.present(cacheMissRate, "ratio", {
            nativeMetric: [N.cacheMisses, N.cacheReferences],
            semantic: "exact",
            formula: "cache-misses / cache-references",
          })
        : PAP.missing("not_collected"),

      branch_misprediction_pct: branchMispredPct !== undefined
        ? PAP.present(branchMispredPct, "pct", {
            nativeMetric: [N.branchMisses, N.branches],
            semantic: "exact",
            formula: "(branch-misses / branches) * 100",
          })
        : PAP.missing("not_collected"),
    }

    // Per-hotspot normalization (symbols from perf report).
    const hotspots: PAP.Hotspot[] = raw.hotspots.map((h) => {
      const overhead = getNative(h.nativeMetrics as Record<string, number | string>, N.overhead) ?? h.self_pct ?? 0
      return {
        symbol: h.name,
        file_line: h.file_line,
        self_pct: overhead,
        total_pct: h.total_pct,
        metrics: {
          self_pct: PAP.present(overhead, "pct", { nativeMetric: N.overhead, semantic: "exact" }),
          // Per-symbol cycles/instructions not available from perf report without annotation.
          cpi: PAP.missing("not_collected", "per-symbol cycles/instructions require `perf annotate`"),
          ipc: PAP.missing("not_collected", "per-symbol IPC requires `perf annotate`"),
          clockticks: PAP.missing("not_collected", "per-symbol cycle count requires `perf annotate`"),
          instructions_retired: PAP.missing("not_collected", "per-symbol instruction count requires `perf annotate`"),
          cache_miss_rate: PAP.missing("not_collected", "per-symbol cache miss rate requires `perf annotate`"),
          branch_misprediction_pct: PAP.missing("not_collected", "per-symbol branch misprediction requires `perf annotate`"),
        },
      }
    })

    return {
      domain: this.domain,
      vendor: this.vendor,
      adapterId: this.id,
      target: raw.target,
      duration_ns: null,
      hotspots,
      summary,
      raw_report_ref: raw.raw_report_ref,
    }
  }
}

export const makePerfAdapter = (probe: PerfBinaryProbe = defaultPerfProbe): PAP.ProfileAdapter =>
  new PerfAdapter(probe)
