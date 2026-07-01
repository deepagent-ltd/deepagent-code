import * as Log from "@deepagent-code/core/util/log"
import { which } from "@deepagent-code/core/util/which"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"
import { RuntimeBase } from "@/runtime/base"

const log = Log.create({ service: "profile.vtune" })

// —— binary probe ————————————————————————————————————————————————————————————

export interface VtuneBinaryProbe {
  readonly locate: (command: string) => string | null
}

export const defaultVtuneProbe: VtuneBinaryProbe = { locate: (cmd) => which(cmd) }
export const installedVtuneProbe = (installed: Iterable<string>): VtuneBinaryProbe => {
  const set = new Set(installed)
  return { locate: (cmd) => (set.has(cmd) ? `/opt/intel/oneapi/vtune/latest/bin64/${cmd}` : null) }
}
export const missingVtuneProbe: VtuneBinaryProbe = { locate: () => null }

// —— mapping ————————————————————————————————————————————————————————————————

/**
 * Intel VTune native metric / CSV column names.
 * See §P1A-V 表3 and Intel VTune CPU Metrics Reference.
 * Column names match `vtune -report hotspots -format=csv` output.
 */
const N = {
  cpuTimeSelf: "CPU Time:Self",
  cpiRate: "CPI Rate",
  clockticks: "Clockticks",
  instructionsRetired: "Instructions Retired",
  memoryBound: "Memory Bound",
  dramBound: "DRAM Bound",
  // VTune "Bad Speculation" metric = branch misprediction pipeline slots %.
  badSpeculation: "Bad Speculation",
  // VTune has multiple cache miss columns; "LLC Miss Count" is the primary one.
  llcMissCount: "LLC Miss Count",
  llcMissRatio: "LLC Miss Ratio",
  // Function name column
  functionName: "Function",
  // Module/CPU time (total) for hotspot
  cpuTimeTotal: "CPU Time",
} as const

const AVAILABLE = Object.values(N) as string[]

export const vtuneMapping: PAP.MetricMapping = {
  adapterId: "vtune",
  domain: "cpu_hotspot",
  availableMetrics: AVAILABLE,
  entries: [
    { neutral: "self_pct", native: N.cpuTimeSelf, semantic: "exact" },
    // CPI Rate is a direct VTune metric (not derived).
    { neutral: "cpi", native: N.cpiRate, semantic: "exact" },
    // ipc = 1 / CPI Rate — PAP-derived, §P1A-V 表3.
    {
      neutral: "ipc",
      native: N.cpiRate,
      semantic: "exact",
      derived: true,
      formula: "1 / CPI Rate",
    },
    { neutral: "clockticks", native: N.clockticks, semantic: "exact" },
    { neutral: "instructions_retired", native: N.instructionsRetired, semantic: "exact" },
    { neutral: "memory_bound_pct", native: N.memoryBound, semantic: "exact" },
    { neutral: "dram_bound_pct", native: N.dramBound, semantic: "exact" },
    // LLC Miss Ratio is the cache miss rate (misses / references). Approximate because
    // VTune uses LLC misses, not all-level misses. We use exact here as it's the canonical
    // VTune cache miss rate metric.
    { neutral: "cache_miss_rate", native: N.llcMissRatio, semantic: "exact" },
    // Bad Speculation = branch misprediction rate in VTune topdown.
    { neutral: "branch_misprediction_pct", native: N.badSpeculation, semantic: "exact" },
  ],
}

const _mappingValidation = Vocabulary.validateMapping(vtuneMapping)
if (!_mappingValidation.ok) {
  log.warn("vtune mapping validation failed at load time", { issues: _mappingValidation.issues })
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

/**
 * Parse a percent string like "85.5%" or "85.5" → 85.5.
 */
function parsePct(s: string): number {
  const cleaned = cleanField(s).replace(/%$/, "").replace(/,/g, "")
  return parseFloat(cleaned)
}

export interface VtuneHotspotRow {
  functionName: string
  cpuTimePct: number
  cpuTimeSelfPct: number
  cpiRate: number
  clockticks: number
  instructionsRetired: number
  memoryBound: number
  dramBound: number
  llcMissRatio: number
  badSpeculation: number
  /** Raw fields map for any additional metrics. */
  raw: Record<string, string>
}

/**
 * Parse `vtune -report hotspots -format=csv` output.
 * Column names match VTune's CPU Metrics hotspot report.
 */
export function parseVtuneCsv(csv: string): VtuneHotspotRow[] {
  const rows: VtuneHotspotRow[] = []
  const lines = csv.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return rows

  // Find header line (first non-empty, non-comment line).
  let headerIdx = -1
  let headers: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.startsWith("#") || line.startsWith("//")) continue
    const fields = splitCsvRow(line).map(cleanField)
    // Detect by presence of "Function" column.
    if (fields.some((f) => f.toLowerCase() === "function" || f.toLowerCase() === "function (full)")) {
      headerIdx = i
      headers = fields
      break
    }
  }
  if (headerIdx < 0 || !headers.length) return rows

  const idx = (name: string): number => {
    const lower = name.toLowerCase()
    return headers.findIndex((h) => h.toLowerCase() === lower || h.toLowerCase().includes(lower.replace(/ /g, "")))
  }

  const iFn = idx("function")
  const iTotal = idx("cpu time")
  const iSelf = idx("cpu time:self")
  const iCpi = idx("cpi rate")
  const iClocks = idx("clockticks")
  const iInstr = idx("instructions retired")
  const iMemBound = idx("memory bound")
  const iDramBound = idx("dram bound")
  const iLlcMissRatio = idx("llc miss ratio")
  const iBadSpec = idx("bad speculation")

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = splitCsvRow(lines[i]!).map(cleanField)
    if (cols.length < 2) continue
    const functionName = cols[iFn >= 0 ? iFn : 0] ?? ""
    if (!functionName) continue

    const raw: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) {
      raw[headers[j]!] = cols[j] ?? ""
    }

    rows.push({
      functionName,
      cpuTimePct: parsePct(cols[iTotal >= 0 ? iTotal : 1] ?? "0"),
      cpuTimeSelfPct: parsePct(cols[iSelf >= 0 ? iSelf : 2] ?? "0"),
      cpiRate: parseFloat(cleanField(cols[iCpi >= 0 ? iCpi : 3] ?? "0")),
      clockticks: parseFloat((cols[iClocks >= 0 ? iClocks : 4] ?? "0").replace(/,/g, "")),
      instructionsRetired: parseFloat((cols[iInstr >= 0 ? iInstr : 5] ?? "0").replace(/,/g, "")),
      memoryBound: parsePct(cols[iMemBound >= 0 ? iMemBound : 6] ?? "0"),
      dramBound: parsePct(cols[iDramBound >= 0 ? iDramBound : 7] ?? "0"),
      llcMissRatio: parsePct(cols[iLlcMissRatio >= 0 ? iLlcMissRatio : 8] ?? "0"),
      badSpeculation: parsePct(cols[iBadSpec >= 0 ? iBadSpec : 9] ?? "0"),
      raw,
    })
  }
  return rows
}

// —— adapter ————————————————————————————————————————————————————————————————

export class VtuneAdapter implements PAP.ProfileAdapter {
  readonly id = "vtune"
  readonly vendor = "intel" as const
  readonly domain = "cpu_hotspot" as const
  readonly privileges: readonly RuntimeBase.PrivilegeSpec[] = []
  readonly mapping = vtuneMapping

  constructor(private readonly probe: VtuneBinaryProbe = defaultVtuneProbe) {}

  async collect(target: PAP.ProfileTarget): Promise<PAP.NativeReportRef> {
    const bin = this.probe.locate("vtune")
    if (!bin) {
      const msg = "vtune (Intel VTune Profiler) is not installed or not on PATH. Install Intel oneAPI Base Toolkit."
      log.info(msg)
      return Promise.reject(new Error(msg))
    }
    const resultDir = `/tmp/deepagent-vtune-${Date.now()}`
    const args = [
      "-collect", "hotspots",
      "-knob", "sampling-mode=hw",
      "-result-dir", resultDir,
      "--",
      target.command,
      ...(target.args ?? []),
    ]
    log.info("vtune collect", { command: bin, args })
    const exportCommand = `${bin} -report hotspots -result-dir ${resultDir} -format csv -report-output ${resultDir}/hotspots.csv`

    const { Process } = await import("@/util/process")
    const result = await Process.run([bin, ...args], { cwd: target.cwd, nothrow: true })
    if (result.code !== 0) {
      const msg = `vtune exited with code ${result.code}: ${result.stderr.toString().trim()}`
      log.warn(msg)
      return Promise.reject(new Error(msg))
    }
    return {
      path: resultDir,
      format: "csv",
      exportCommand,
    }
  }

  async parse(report: PAP.NativeReportRef): Promise<PAP.RawProfile> {
    let csvText: string
    if (report.format === "csv") {
      const fs = await import("fs/promises")
      // report.path may be a directory (vtune result dir) or a CSV file.
      let filePath = report.path
      try {
        const stat = await fs.stat(filePath)
        if (stat.isDirectory()) {
          filePath = `${filePath}/hotspots.csv`
        }
      } catch {
        // path might be a direct CSV file
      }
      csvText = await fs.readFile(filePath, "utf8")
    } else {
      return Promise.reject(new Error(`vtune adapter cannot parse format: ${report.format}`))
    }

    const rows = parseVtuneCsv(csvText)
    const hotspots: PAP.RawHotspot[] = rows.map((r) => ({
      name: r.functionName,
      kind: "symbol" as const,
      self_pct: r.cpuTimeSelfPct,
      total_pct: r.cpuTimePct,
      nativeMetrics: {
        [N.cpuTimeTotal]: r.cpuTimePct,
        [N.cpuTimeSelf]: r.cpuTimeSelfPct,
        [N.cpiRate]: r.cpiRate,
        [N.clockticks]: r.clockticks,
        [N.instructionsRetired]: r.instructionsRetired,
        [N.memoryBound]: r.memoryBound,
        [N.dramBound]: r.dramBound,
        [N.llcMissRatio]: r.llcMissRatio,
        [N.badSpeculation]: r.badSpeculation,
      },
    }))

    // nativeSummary: aggregate (first row as representative, or rolled up top-level).
    const nativeSummary: Record<string, number | string> =
      rows.length > 0
        ? {
            [N.cpuTimeSelf]: rows[0]!.cpuTimeSelfPct,
            [N.cpiRate]: rows[0]!.cpiRate,
            [N.clockticks]: rows.reduce((s, r) => s + r.clockticks, 0),
            [N.instructionsRetired]: rows.reduce((s, r) => s + r.instructionsRetired, 0),
            [N.memoryBound]: rows[0]!.memoryBound,
            [N.dramBound]: rows[0]!.dramBound,
            [N.llcMissRatio]: rows[0]!.llcMissRatio,
            [N.badSpeculation]: rows[0]!.badSpeculation,
          }
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
    const getNative = (bag: Record<string, number | string>, key: string): number | undefined => {
      const v = bag[key]
      if (v === undefined || v === "") return undefined
      const n = Number(v)
      return isNaN(n) ? undefined : n
    }

    const normFn = (nm: Record<string, number | string>): Record<string, PAP.MetricValue> => {
      const selfPct = getNative(nm, N.cpuTimeSelf)
      const cpiRate = getNative(nm, N.cpiRate)
      const clocks = getNative(nm, N.clockticks)
      const instr = getNative(nm, N.instructionsRetired)
      const memBound = getNative(nm, N.memoryBound)
      const dramBound = getNative(nm, N.dramBound)
      const llcRatio = getNative(nm, N.llcMissRatio)
      const badSpec = getNative(nm, N.badSpeculation)

      return {
        self_pct: selfPct !== undefined
          ? PAP.present(selfPct, "pct", { nativeMetric: N.cpuTimeSelf, semantic: "exact" })
          : PAP.missing("not_collected"),

        cpi: cpiRate !== undefined
          ? PAP.present(cpiRate, "ratio", { nativeMetric: N.cpiRate, semantic: "exact" })
          : PAP.missing("not_collected"),

        // ipc = 1 / CPI Rate — PAP-derived.
        ipc: cpiRate !== undefined && cpiRate > 0
          ? PAP.present(1 / cpiRate, "ratio", {
              nativeMetric: N.cpiRate,
              semantic: "exact",
              derived: true,
              formula: "1 / CPI Rate",
            })
          : PAP.missing("not_collected"),

        clockticks: clocks !== undefined
          ? PAP.present(clocks, "count", { nativeMetric: N.clockticks, semantic: "exact" })
          : PAP.missing("not_collected"),

        instructions_retired: instr !== undefined
          ? PAP.present(instr, "count", { nativeMetric: N.instructionsRetired, semantic: "exact" })
          : PAP.missing("not_collected"),

        memory_bound_pct: memBound !== undefined
          ? PAP.present(memBound, "pct", { nativeMetric: N.memoryBound, semantic: "exact" })
          : PAP.missing("not_collected"),

        dram_bound_pct: dramBound !== undefined
          ? PAP.present(dramBound, "pct", { nativeMetric: N.dramBound, semantic: "exact" })
          : PAP.missing("not_collected"),

        // LLC Miss Ratio → cache_miss_rate (ratio 0–1 or already 0–100 depending on VTune version).
        // VTune reports LLC Miss Ratio as 0–100%, we normalize to 0–1 ratio.
        cache_miss_rate: llcRatio !== undefined
          ? PAP.present(llcRatio > 1 ? llcRatio / 100 : llcRatio, "ratio", {
              nativeMetric: N.llcMissRatio,
              semantic: "exact",
              ...(llcRatio > 1 ? { conversion: "LLC Miss Ratio / 100" } : {}),
            })
          : PAP.missing("not_collected"),

        branch_misprediction_pct: badSpec !== undefined
          ? PAP.present(badSpec, "pct", { nativeMetric: N.badSpeculation, semantic: "exact" })
          : PAP.missing("not_collected"),
      }
    }

    const hotspots: PAP.Hotspot[] = raw.hotspots.map((h) => ({
      symbol: h.name,
      file_line: h.file_line,
      self_pct: h.self_pct ?? 0,
      total_pct: h.total_pct,
      metrics: normFn(h.nativeMetrics as Record<string, number | string>),
    }))

    return {
      domain: this.domain,
      vendor: this.vendor,
      adapterId: this.id,
      target: raw.target,
      duration_ns: null,
      hotspots,
      summary: normFn(raw.nativeSummary),
      raw_report_ref: raw.raw_report_ref,
    }
  }
}

export const makeVtuneAdapter = (probe: VtuneBinaryProbe = defaultVtuneProbe): PAP.ProfileAdapter =>
  new VtuneAdapter(probe)
