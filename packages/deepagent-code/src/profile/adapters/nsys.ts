import * as Log from "@deepagent-code/core/util/log"
import { which } from "@deepagent-code/core/util/which"
import { PAP } from "@/profile/pap"
import { Vocabulary } from "@/profile/vocabulary"
import { RuntimeBase } from "@/runtime/base"

const log = Log.create({ service: "profile.nsys" })

// —— binary probe ————————————————————————————————————————————————————————————

export interface NsysBinaryProbe {
  readonly locate: (command: string) => string | null
}

export const defaultNsysProbe: NsysBinaryProbe = { locate: (cmd) => which(cmd) }
export const installedNsysProbe = (installed: Iterable<string>): NsysBinaryProbe => {
  const set = new Set(installed)
  return { locate: (cmd) => (set.has(cmd) ? `/usr/local/bin/${cmd}` : null) }
}
export const missingNsysProbe: NsysBinaryProbe = { locate: () => null }

// —— mapping ————————————————————————————————————————————————————————————————

/**
 * nsys native metric names as used in the RawProfile nativeSummary.
 * nsys exports three separate CSV reports; we aggregate them into one flat
 * nativeSummary with synthetic neutral-ish keys before normalization.
 *
 * §P1A-V 表2: gpu_timeline domain has kernel_total_pct, mem_copy_pct, api_overhead_pct.
 */
const N = {
  // gpukernsum report: top kernel time percent
  kernelTimePct: "kernel_time_pct",
  // gpumemtimesum report: memory copy time percent
  memCopyTimePct: "mem_copy_time_pct",
  // cudaapisum report: CUDA API overhead percent
  apiOverheadPct: "api_overhead_pct",
} as const

const AVAILABLE = Object.values(N) as string[]

export const nsysMapping: PAP.MetricMapping = {
  adapterId: "nsys",
  domain: "gpu_timeline",
  availableMetrics: AVAILABLE,
  entries: [
    { neutral: "kernel_total_pct", native: N.kernelTimePct, semantic: "exact" },
    { neutral: "mem_copy_pct", native: N.memCopyTimePct, semantic: "exact" },
    // nsys stats exposes API time only as a per-report internal percentage, with no
    // GPU/wall-total denominator we can access — so we honestly declare it null rather
    // than fabricate a "share of total" number. §P1A-V 映射原则 5.
    {
      neutral: "api_overhead_pct",
      native: null,
      reason: "not_collected",
      detail: "nsys stats reports API time only as a per-report normalized percentage; no valid GPU/wall-total denominator",
    },
  ],
}

const _mappingValidation = Vocabulary.validateMapping(nsysMapping)
if (!_mappingValidation.ok) {
  log.warn("nsys mapping validation failed at load time", { issues: _mappingValidation.issues })
}

// —— CSV parsing helpers ————————————————————————————————————————————————————

/**
 * Simplified CSV row splitter (handles quoted fields).
 */
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

export interface NsysKernelRow {
  name: string
  timePct: number
  totalTimeNs: number
  instances: number
}

export interface NsysMemRow {
  operation: string
  timePct: number
  totalTimeNs: number
}

export interface NsysApiRow {
  name: string
  timePct: number
  totalTimeNs: number
}

/**
 * Parse `nsys stats --report gpukernsum --format csv` output.
 * Columns: Time (%), Total Time (ns), Instances, Average (ns), Minimum (ns), Maximum (ns), Name
 */
export function parseGpukernsum(csv: string): NsysKernelRow[] {
  const rows: NsysKernelRow[] = []
  const lines = csv.split(/\r?\n/).filter((l) => l.trim())
  let headerIdx = -1
  const headers: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.toLowerCase().includes("time (%)") || line.toLowerCase().includes("time(%)")) {
      headerIdx = i
      headers.push(...splitCsvRow(line).map(cleanField).map((h) => h.toLowerCase()))
      break
    }
  }
  if (headerIdx < 0) return rows
  const timeIdx = headers.findIndex((h) => h.includes("time") && h.includes("%"))
  const totalIdx = headers.findIndex((h) => h.includes("total") && h.includes("time"))
  const instIdx = headers.findIndex((h) => h.includes("instance"))
  const nameIdx = headers.length - 1 // Name is last column

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = splitCsvRow(lines[i]!).map(cleanField)
    if (cols.length < 2) continue
    const timePct = parseFloat(cols[timeIdx >= 0 ? timeIdx : 0] ?? "0")
    const totalTimeNs = parseFloat((cols[totalIdx >= 0 ? totalIdx : 1] ?? "0").replace(/,/g, ""))
    const instances = parseInt(cols[instIdx >= 0 ? instIdx : 2] ?? "1", 10)
    const name = cols[nameIdx] ?? cols[cols.length - 1] ?? ""
    if (!name || isNaN(timePct)) continue
    rows.push({ name, timePct, totalTimeNs, instances })
  }
  return rows
}

/**
 * Parse `nsys stats --report gpumemtimesum --format csv` output.
 * Columns: Time (%), Total Time (ns), Count, Average (ns), Minimum (ns), Maximum (ns), Operation
 */
export function parseGpumemtimesum(csv: string): NsysMemRow[] {
  const rows: NsysMemRow[] = []
  const lines = csv.split(/\r?\n/).filter((l) => l.trim())
  let headerIdx = -1
  const headers: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.toLowerCase().includes("time (%)") || line.toLowerCase().includes("time(%)")) {
      headerIdx = i
      headers.push(...splitCsvRow(line).map(cleanField).map((h) => h.toLowerCase()))
      break
    }
  }
  if (headerIdx < 0) return rows
  const timeIdx = headers.findIndex((h) => h.includes("time") && h.includes("%"))
  const totalIdx = headers.findIndex((h) => h.includes("total") && h.includes("time"))
  const nameIdx = headers.length - 1

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = splitCsvRow(lines[i]!).map(cleanField)
    if (cols.length < 2) continue
    const timePct = parseFloat(cols[timeIdx >= 0 ? timeIdx : 0] ?? "0")
    const totalTimeNs = parseFloat((cols[totalIdx >= 0 ? totalIdx : 1] ?? "0").replace(/,/g, ""))
    const operation = cols[nameIdx] ?? cols[cols.length - 1] ?? ""
    if (!operation || isNaN(timePct)) continue
    rows.push({ operation, timePct, totalTimeNs })
  }
  return rows
}

/**
 * Parse `nsys stats --report cudaapisum --format csv` output.
 * Columns: Time (%), Total Time (ns), Num Calls, Average (ns), Minimum (ns), Maximum (ns), Name
 */
export function parseCudaapisum(csv: string): NsysApiRow[] {
  const rows: NsysApiRow[] = []
  const lines = csv.split(/\r?\n/).filter((l) => l.trim())
  let headerIdx = -1
  const headers: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.toLowerCase().includes("time (%)") || line.toLowerCase().includes("time(%)")) {
      headerIdx = i
      headers.push(...splitCsvRow(line).map(cleanField).map((h) => h.toLowerCase()))
      break
    }
  }
  if (headerIdx < 0) return rows
  const timeIdx = headers.findIndex((h) => h.includes("time") && h.includes("%"))
  const totalIdx = headers.findIndex((h) => h.includes("total") && h.includes("time"))
  const nameIdx = headers.length - 1

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = splitCsvRow(lines[i]!).map(cleanField)
    if (cols.length < 2) continue
    const timePct = parseFloat(cols[timeIdx >= 0 ? timeIdx : 0] ?? "0")
    const totalTimeNs = parseFloat((cols[totalIdx >= 0 ? totalIdx : 1] ?? "0").replace(/,/g, ""))
    const name = cols[nameIdx] ?? cols[cols.length - 1] ?? ""
    if (!name || isNaN(timePct)) continue
    rows.push({ name, timePct, totalTimeNs })
  }
  return rows
}

/**
 * Multi-section fixture format for tests:
 * Sections are delimited by lines like "=== REPORT: gpukernsum ===" etc.
 * Used by parse() and directly in tests.
 */
export function parseNsysMultiSectionCsv(text: string): {
  kernels: NsysKernelRow[]
  memOps: NsysMemRow[]
  apiCalls: NsysApiRow[]
} {
  const sections = new Map<string, string>()
  let currentSection = ""
  let buf: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^===\s*REPORT:\s*(\w+)\s*===/)
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
    kernels: parseGpukernsum(sections.get("gpukernsum") ?? ""),
    memOps: parseGpumemtimesum(sections.get("gpumemtimesum") ?? ""),
    apiCalls: parseCudaapisum(sections.get("cudaapisum") ?? ""),
  }
}

// —— adapter ————————————————————————————————————————————————————————————————

export class NsysAdapter implements PAP.ProfileAdapter {
  readonly id = "nsys"
  readonly vendor = "nvidia" as const
  readonly domain = "gpu_timeline" as const
  readonly privileges: readonly RuntimeBase.PrivilegeSpec[] = [
    { kind: "gpu_performance_counter", reason: "nsys needs GPU performance counter access for kernel tracing" },
  ]
  readonly mapping = nsysMapping

  constructor(private readonly probe: NsysBinaryProbe = defaultNsysProbe) {}

  async collect(target: PAP.ProfileTarget): Promise<PAP.NativeReportRef> {
    const bin = this.probe.locate("nsys")
    if (!bin) {
      const msg = "nsys (NVIDIA Nsight Systems) is not installed or not on PATH. Install it via the NVIDIA CUDA Toolkit."
      log.info(msg)
      return Promise.reject(new Error(msg))
    }
    const outPath = `/tmp/deepagent-nsys-${Date.now()}`
    const args = [
      "profile",
      "-o", outPath,
      "--force-overwrite", "true",
      "--",
      target.command,
      ...(target.args ?? []),
    ]
    log.info("nsys collect", { command: bin, args })
    const exportCommand = `${bin} stats --report gpukernsum,gpumemtimesum,cudaapisum --format csv -o stdout ${outPath}.nsys-rep`

    const { Process } = await import("@/util/process")
    const result = await Process.run([bin, ...args], { cwd: target.cwd, nothrow: true })
    if (result.code !== 0) {
      const msg = `nsys exited with code ${result.code}: ${result.stderr.toString().trim()}`
      log.warn(msg)
      return Promise.reject(new Error(msg))
    }
    return {
      path: `${outPath}.nsys-rep`,
      format: "nsys-rep",
      exportCommand,
    }
  }

  async parse(report: PAP.NativeReportRef): Promise<PAP.RawProfile> {
    let text: string
    if (report.format === "csv" || report.format === "text") {
      const fs = await import("fs/promises")
      text = await fs.readFile(report.path, "utf8")
    } else {
      // nsys-rep: need nsys stats to export CSV
      const bin = this.probe.locate("nsys")
      if (!bin) {
        return Promise.reject(new Error("nsys binary required to parse .nsys-rep; not found on PATH"))
      }
      const { Process } = await import("@/util/process")
      // Run each report type and concatenate with section headers for our multi-section parser.
      const sections: string[] = []
      for (const report_type of ["gpukernsum", "gpumemtimesum", "cudaapisum"]) {
        const r = await Process.run([bin, "stats", "--report", report_type, "--format", "csv", "-o", "stdout", report.path], { nothrow: true })
        sections.push(`=== REPORT: ${report_type} ===\n${r.stdout.toString()}`)
      }
      text = sections.join("\n")
    }

    const { kernels, memOps, apiCalls } = parseNsysMultiSectionCsv(text)

    // Build hotspots from kernel table.
    const hotspots: PAP.RawHotspot[] = kernels.map((k) => ({
      name: k.name,
      kind: "kernel" as const,
      self_pct: k.timePct,
      total_pct: k.timePct,
      nativeMetrics: {
        [N.kernelTimePct]: k.timePct,
        total_time_ns: k.totalTimeNs,
        instances: k.instances,
      },
    }))

    // Summary aggregates top-level metrics.
    //
    // The per-report `Time (%)` columns are each normalized WITHIN their own report
    // (kernels sum to ~100%, mem ops sum to ~100%, api calls sum to ~100%), so summing
    // them across reports is meaningless — it made api_overhead_pct≈100% unconditionally
    // and forced roofline to call almost everything "latency-bound". Instead we derive
    // real GPU-time shares from the nanosecond totals nsys reports per row.
    const kernelNs = kernels.reduce((s, r) => s + (Number.isFinite(r.totalTimeNs) ? r.totalTimeNs : 0), 0)
    const memNs = memOps.reduce((s, r) => s + (Number.isFinite(r.totalTimeNs) ? r.totalTimeNs : 0), 0)
    const apiNs = apiCalls.reduce((s, r) => s + (Number.isFinite(r.totalTimeNs) ? r.totalTimeNs : 0), 0)
    // GPU-side wall time = time spent in kernels + memory copies. This is the correct
    // denominator for the compute-vs-transfer split that roofline consumes.
    const gpuNs = kernelNs + memNs
    const kernelTotalPct = gpuNs > 0 ? (kernelNs / gpuNs) * 100 : kernels.length > 0 ? kernels[0]!.timePct : 0
    const memCopyPct = gpuNs > 0 ? (memNs / gpuNs) * 100 : 0

    const nativeSummary: Record<string, number | string> = {
      [N.kernelTimePct]: kernelTotalPct,
      [N.memCopyTimePct]: memCopyPct,
      // api_overhead is host-side CUDA/HIP runtime time that overlaps GPU work; there is
      // no correct "share of GPU total" denominator available from these three reports,
      // so we keep the raw ns for provenance and let normalize() report it as honest null.
      kernel_ns_total: kernelNs,
      mem_ns_total: memNs,
      api_ns_total: apiNs,
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
    const kernelPct = getNative(ns, N.kernelTimePct)
    const memCopyPct = getNative(ns, N.memCopyTimePct)

    const summary: Record<string, PAP.MetricValue> = {
      kernel_total_pct: kernelPct !== undefined
        ? PAP.present(kernelPct, "pct", {
            nativeMetric: N.kernelTimePct,
            semantic: "exact",
            derived: true,
            formula: "kernel_ns_total / (kernel_ns_total + mem_ns_total) * 100",
          })
        : PAP.missing("not_collected"),
      mem_copy_pct: memCopyPct !== undefined
        ? PAP.present(memCopyPct, "pct", {
            nativeMetric: N.memCopyTimePct,
            semantic: "exact",
            derived: true,
            formula: "mem_ns_total / (kernel_ns_total + mem_ns_total) * 100",
          })
        : PAP.missing("not_collected"),
      // Host-side CUDA/HIP API time overlaps GPU execution and nsys reports it only as a
      // per-report internal percentage, not as a share of any GPU/wall total we can access
      // here. Reporting a number would be fabricated; honest null + reason instead.
      api_overhead_pct: PAP.missing(
        "not_collected",
        "api_overhead needs total wall time as denominator; nsys stats reports only per-report normalized percentages",
      ),
    }

    const hotspots: PAP.Hotspot[] = raw.hotspots.map((h) => {
      const kPct = h.self_pct ?? getNative(h.nativeMetrics as Record<string, number | string>, N.kernelTimePct) ?? 0
      return {
        kernel: h.name,
        file_line: h.file_line,
        self_pct: kPct,
        total_pct: h.total_pct,
        metrics: {
          kernel_total_pct: PAP.present(kPct, "pct", { nativeMetric: N.kernelTimePct, semantic: "exact" }),
          mem_copy_pct: PAP.missing("not_applicable_to_domain", "per-kernel mem copy not available in nsys gpukernsum"),
          api_overhead_pct: PAP.missing("not_applicable_to_domain", "per-kernel API overhead not in gpukernsum"),
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

export const makeNsysAdapter = (probe: NsysBinaryProbe = defaultNsysProbe): PAP.ProfileAdapter =>
  new NsysAdapter(probe)
