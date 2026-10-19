import * as Log from "@deepagent-code/core/util/log"
import { which } from "@deepagent-code/core/util/which"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"
import { RuntimeBase } from "@/runtime/base"
import { Global } from "@deepagent-code/core/global"
import path from "node:path"

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
  file_line?: PAP.FileLine
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
  let firstEvent: string | undefined
  let currentEvent: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const event = line.match(/^# Samples: .* of event '([^']+)'/)
    if (event) {
      currentEvent = event[1]
      firstEvent ??= currentEvent
      continue
    }
    // Different sampled events have independent percentage denominators.
    if (currentEvent !== firstEvent) continue
    const fields = line.split("\t").map((value) => value.trim())
    if (fields.length >= 5 && /^\d+(?:\.\d+)?%$/.test(fields[0]!)) {
      const source = fields[4]!.match(/^(?!\?\?)(.+):([1-9]\d*)$/)
      rows.push({
        symbol: fields[3]!.replace(/^\[.\]\s+/, ""),
        object: fields[2],
        overheadPct: Number.parseFloat(fields[0]!),
        ...(source ? { file_line: { file: source[1]!, line: Number(source[2]) } } : {}),
      })
      continue
    }
    const m = line.match(/^\s+([\d.]+)%\s+(?:([\d.]+)%\s+)?(?:\d+\s+)?\S+\s+(\S+)\s+\[.\]\s+(.+)$/)
    if (!m) continue
    const overheadPct = parseFloat(m[2] ?? m[1]!)
    const object = m[3]!
    const symbol = m[4]!.trim()
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
  let counters: string[] | undefined
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^#\s+PID\s+TID(?:\s+(.+))?$/)
    if (header) {
      counters = header[1]?.trim().split(/\s+/) ?? []
      continue
    }
    if (counters) {
      const fields = line.trim().split(/\s+/)
      if (fields.length !== counters.length + 2 || !fields.every((value) => /^\d+$/.test(value))) continue
      counters.forEach((counter, index) => {
        const event = counter.replace(/:.*$/, "")
        result.set(event, (result.get(event) ?? 0) + Number(fields[index + 2]))
      })
      continue
    }
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
    {
      kind: "perf_event_paranoid",
      reason: "Linux perf requires perf_event_paranoid <= 2 for CPU sampling",
      maxParanoid: 2,
    },
  ]
  readonly mapping = perfMapping

  constructor(private readonly probe: PerfBinaryProbe = defaultPerfProbe) {}

  async collect(target: PAP.ProfileTarget): Promise<PAP.NativeReportRef> {
    const bin = this.probe.locate("perf")
    if (!bin) {
      const msg =
        "perf (Linux perf_events) is not installed or not on PATH. Install linux-perf or linux-tools-$(uname -r)."
      log.info(msg)
      return Promise.reject(new Error(msg))
    }
    const { Process } = await import("@/util/process")
    // Probe only a fixed no-op. Never replay the user's program after a failed collection.
    const events = "cycles,instructions,cache-misses,cache-references,branch-misses,branches"
    const fs = await import("node:fs/promises")
    const probeDirectory = await fs.mkdtemp(path.join(Global.Path.tmp, "profile-perf-probe-"))
    const capability = await Process.run(
      [bin, "record", "-s", "-g", "-e", events, "-o", path.join(probeDirectory, "perf.data"), "--", "/usr/bin/true"],
      { nothrow: true },
    ).finally(() => fs.rm(probeDirectory, { recursive: true, force: true }))
    const selected = capability.code === 0 ? events : "cpu-clock:u"
    if (capability.code !== 0) log.info("perf hardware events unavailable; collecting user CPU-clock samples")
    const outPath = path.join(Global.Path.tmp, `profile-perf-${Date.now()}.data`)
    const args = [
      "record",
      "-s", // real per-thread event counts, read back with perf report -T
      "-g", // call graph
      "-e",
      selected,
      "-o",
      outPath,
      "--",
      target.command,
      ...(target.args ?? []),
    ]
    log.info("perf collect", { command: bin, args })
    const exportCommand = `${bin} report --stdio -n -i ${outPath}`

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
      const reportResult = await Process.run(
        [
          bin,
          "report",
          "--stdio",
          "--no-children",
          "--call-graph",
          "none",
          "--fields",
          "overhead,comm,dso,symbol,srcline",
          "--sort",
          "comm,dso,symbol,srcline",
          "--full-source-path",
          "-t",
          "\t",
          "-i",
          report.path,
        ],
        { nothrow: true },
      )
      if (reportResult.code !== 0)
        throw new Error(`perf report exited with code ${reportResult.code}: ${reportResult.stderr}`)
      // Only read the original record. perf stat -i does not read a perf.data file.
      const statResult = await Process.run(
        [bin, "report", "--stdio", "-T", "--no-children", "--call-graph", "none", "-i", report.path],
        { nothrow: true },
      )
      text = [
        "=== SECTION: perf_report ===",
        reportResult.stdout.toString(),
        "=== SECTION: perf_stat ===",
        statResult.code === 0 ? statResult.stdout.toString() : "",
      ].join("\n")
    } else {
      return Promise.reject(new Error(`perf adapter cannot parse format: ${report.format}`))
    }

    const { reportRows, statCounts } = parsePerfMultiSection(text)
    if (reportRows.length === 0) throw new Error("perf report contains no sampled hotspots")

    const hotspots: PAP.RawHotspot[] = reportRows.map((r) => ({
      name: r.symbol,
      kind: "symbol" as const,
      file_line: r.file_line,
      self_pct: r.overheadPct,
      nativeMetrics: {
        [N.overhead]: r.overheadPct,
        // Per-symbol cycles/instructions not available from `perf report --stdio` without -g parsing.
        // They come from `perf stat` aggregate only.
      },
    }))

    // Pull aggregate event counts from perf stat into nativeSummary.
    const nativeSummary: Record<string, number | string> = {}
    const samplingEvent = text.match(/^# Samples: .* of event '([^']+)'/m)?.[1]
    if (samplingEvent) nativeSummary.sampling_event = samplingEvent
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
      availableMetrics: [N.overhead, ...statCounts.keys()],
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
    const missingCounter = PAP.missing(
      "not_collected",
      typeof ns.sampling_event === "string" && ns.sampling_event.startsWith("cpu-clock")
        ? "This run has CPU-clock software samples; hardware counter values were not recorded."
        : "No per-thread hardware counter values were recorded; sample periods are not counter totals.",
    )

    // cpi = cycles / instructions (computed, but vocab says derived:false).
    const cpiVal =
      cycles !== undefined && instructions !== undefined && instructions > 0 ? cycles / instructions : undefined

    // ipc = instructions / cycles (PAP-derived, vocab says derived:true).
    const ipcVal = instructions !== undefined && cycles !== undefined && cycles > 0 ? instructions / cycles : undefined

    // cache_miss_rate = cache-misses / cache-references (ratio 0–1).
    const cacheMissRate =
      cacheMisses !== undefined && cacheRefs !== undefined && cacheRefs > 0 ? cacheMisses / cacheRefs : undefined

    // branch_misprediction_pct = branch-misses / branches * 100.
    const branchMispredPct =
      branchMisses !== undefined && branches !== undefined && branches > 0 ? (branchMisses / branches) * 100 : undefined

    const summary: Record<string, PAP.MetricValue> = {
      self_pct: PAP.missing("not_applicable_to_domain", "top-level self_pct is per-symbol, not aggregated"),

      cpi:
        cpiVal !== undefined
          ? PAP.present(cpiVal, "ratio", {
              nativeMetric: [N.cycles, N.instructions],
              semantic: "exact",
              // cpi is not marked derived in vocab, but we compute it from primitives.
              formula: "cycles / instructions",
            })
          : missingCounter,

      ipc:
        ipcVal !== undefined
          ? PAP.present(ipcVal, "ratio", {
              nativeMetric: [N.instructions, N.cycles],
              semantic: "exact",
              derived: true,
              formula: "instructions / cycles",
            })
          : missingCounter,

      clockticks:
        cycles !== undefined
          ? PAP.present(cycles, "count", { nativeMetric: N.cycles, semantic: "exact" })
          : missingCounter,

      instructions_retired:
        instructions !== undefined
          ? PAP.present(instructions, "count", { nativeMetric: N.instructions, semantic: "exact" })
          : missingCounter,

      cache_miss_rate:
        cacheMissRate !== undefined
          ? PAP.present(cacheMissRate, "ratio", {
              nativeMetric: [N.cacheMisses, N.cacheReferences],
              semantic: "exact",
              formula: "cache-misses / cache-references",
            })
          : missingCounter,

      branch_misprediction_pct:
        branchMispredPct !== undefined
          ? PAP.present(branchMispredPct, "pct", {
              nativeMetric: [N.branchMisses, N.branches],
              semantic: "exact",
              formula: "(branch-misses / branches) * 100",
            })
          : missingCounter,
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
          branch_misprediction_pct: PAP.missing(
            "not_collected",
            "per-symbol branch misprediction requires `perf annotate`",
          ),
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

export const makePerfAdapter = (probe: PerfBinaryProbe = defaultPerfProbe): PAP.ProfileAdapter => new PerfAdapter(probe)
