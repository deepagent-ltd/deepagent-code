import { RuntimeBase } from "@/runtime/base"
import type { LSPResolve } from "@/lsp/resolve"

/**
 * P1A (S1-v3.5): PAP — the Profile Adapter Protocol.
 *
 * Unlike DAP (debug), profilers have NO common protocol: ncu emits `.ncu-rep`,
 * nsys emits a SQLite `.nsys-rep`, rocprof emits rocpd/CSV, VTune a private DB,
 * perf a `perf.data`. PAP is the layer we invent to unify them. Its soul is the
 * vendor-neutral metric vocabulary (see `./vocabulary`): ncu's `sm__throughput`,
 * rocprof's `GPUBusy` and VTune's `CPI Rate` must collapse onto ONE neutral name,
 * otherwise PAP is just a thin wrapper ("套壳").
 *
 * The protocol is three stages every adapter implements:
 *   1. collect    — build the CLI, run the program under the profiler, produce a
 *                   native report (done inside R0 worktree isolation + privilege gate).
 *   2. parse      — read the native report (CSV/JSON/SQLite) into an intermediate
 *                   `RawProfile` that still carries NATIVE metric names.
 *   3. normalize  — map native metric names onto the neutral vocabulary, producing a
 *                   vendor-agnostic `NormalizedProfile`.
 *
 * This module is PURE protocol + types — it spawns nothing and runs no profiler.
 * R0 (`RuntimeBase`) supplies privileges, isolation, and the output budget; adapters
 * declare privileges with `RuntimeBase.PrivilegeSpec` and may carry a default
 * `RuntimeBase.ResourceBudget` so large native reports spill to an artifact.
 */
export namespace PAP {
  // —— enums ————————————————————————————————————————————————————————————————

  export type Vendor = "nvidia" | "amd" | "intel" | "cpu_generic"

  /**
   * The profiling domain. GPU splits into per-kernel (ncu/rocprof: a single
   * kernel's compute/memory/occupancy) vs timeline (nsys: system timeline / API /
   * transfers). CPU splits into sampling (perf) vs hotspot/µarch (VTune). A neutral
   * metric only applies to the domains where it is meaningful — we never cross-fill
   * a metric into a domain that cannot produce it.
   */
  export type Domain = "gpu_kernel" | "gpu_timeline" | "cpu_sampling" | "cpu_hotspot"

  /**
   * Normalized unit. §P1A-V "单位归一": bandwidth → `pct` or `gb_s` (explicit), all
   * durations → `ns`, all ratios/percent → `pct` on a 0–100 scale, raw counts →
   * `count`, dimensionless ratios (cpi/ipc/miss-rate) → `ratio`, booleans → `bool`.
   */
  export type MetricUnit = "pct" | "gb_s" | "ns" | "count" | "ratio" | "bool"

  /**
   * Relationship between the native metric and the neutral metric it maps to.
   * `exact` = same quantity; `approximate` = related but NOT identical (e.g. AMD
   * `L2CacheHit` hit-rate → `l2_throughput_pct` throughput — §P1A-V 映射原则 2).
   * Derivation is tracked separately via `derived`.
   */
  export type Semantic = "exact" | "approximate"

  /**
   * Why a neutral metric has no value. §P1A-V 映射原则 5: missing is honest — a
   * metric the machine/arch/profiler cannot produce is `null` + a reason, NEVER
   * back-filled from a different metric and never fabricated. The listed literals
   * are the canonical reasons; the open `string` tail allows adapter-specific notes.
   */
  export type MissingReason =
    | "not_supported_on_arch"
    | "metric_not_in_this_profiler"
    | "not_collected"
    | "not_applicable_to_domain"
    | (string & {})

  // —— metric values ——————————————————————————————————————————————————————————

  /** Where a normalized value came from — kept for auditability (§P1A-V 映射原则 3). */
  export interface MetricProvenance {
    /** The native metric name(s) this value was derived/mapped from. */
    nativeMetric: string | readonly string[]
    /** `exact` or `approximate` (semantic difference made explicit). */
    semantic: Semantic
    /** True when PAP computed this from other native metrics (e.g. `ipc`, `compute_bound`). */
    derived?: boolean
    /** For derived metrics: the formula/source, so the value can be audited. */
    formula?: string
    /** When the native value was bytes/counts, the conversion applied to reach `unit`. */
    conversion?: string
  }

  /** A metric that has a real value. */
  export interface MetricPresent {
    readonly value: number | boolean
    readonly unit: MetricUnit
    readonly provenance: MetricProvenance
  }

  /** A metric with no value — honest null + machine-readable reason, never fabricated. */
  export interface MetricMissing {
    readonly value: null
    readonly reason: MissingReason
    /** Optional human-readable detail. */
    readonly detail?: string
  }

  export type MetricValue = MetricPresent | MetricMissing

  export const isPresent = (m: MetricValue): m is MetricPresent => m.value !== null
  export const isMissing = (m: MetricValue): m is MetricMissing => m.value === null

  /** Construct a present metric value with provenance. */
  export const present = (value: number | boolean, unit: MetricUnit, provenance: MetricProvenance): MetricPresent => ({
    value,
    unit,
    provenance,
  })

  /** Construct an honest missing value (`null` + reason). Use this; never invent a number. */
  export const missing = (reason: MissingReason, detail?: string): MetricMissing => ({
    value: null,
    reason,
    ...(detail !== undefined ? { detail } : {}),
  })

  // —— hotspots & profile ——————————————————————————————————————————————————————

  /** A resolved source coordinate. Shape matches `LSPResolve.Candidate.{file,position}`. */
  export interface FileLine {
    file: string
    /** 1-based line for human display (LSP positions are 0-based; back-fill converts). */
    line: number
  }

  /**
   * One hotspot: a GPU `kernel` or a CPU `symbol`/function, with its share of time
   * and its neutral metrics. `file_line` is OPTIONAL and back-fillable: P3A passes
   * the kernel/symbol name through `LSPResolve.resolveSymbol` (a `Candidate.file` +
   * `position.line`) to fill it. P1A only leaves the field + this note; it does not
   * wire LSP. Until back-filled it is `undefined` (not attempted) or `null` (attempted,
   * unresolved).
   */
  export interface Hotspot {
    /** CPU/function hotspot identity. At least one of `symbol`/`kernel` is set. */
    symbol?: string
    /** GPU kernel hotspot identity. */
    kernel?: string
    /** Source coordinate; back-filled via {@link LSPResolve.resolveSymbol} by P3A. */
    file_line?: FileLine | null
    /** Self time as a percent of total (0–100). */
    self_pct: number
    /** Inclusive/total time percent (0–100), when the profiler distinguishes it. */
    total_pct?: number
    /** Neutral-vocabulary metrics for this hotspot: neutral name → value (present or null). */
    metrics: Record<string, MetricValue>
  }

  /**
   * Back-fill helper for P3A: convert an `LSPResolve.Candidate` (0-based LSP position)
   * into a hotspot `FileLine` (1-based display line). P1A defines the seam; P3A calls
   * `LSPResolve.resolveSymbol(kernel|symbol)` and feeds the candidate here. This is the
   * only point that couples PAP to LSP, and it is pure (no LSP wiring in this module).
   */
  export const fileLineFromCandidate = (c: LSPResolve.Candidate): FileLine => ({
    file: c.file,
    line: c.position.line + 1,
  })

  /** Reference to the native report on disk — spilled to an L5 artifact, never inlined. */
  export interface NativeReportRef {
    /** Absolute path to the native report (`.ncu-rep`/`.nsys-rep`/rocpd/CSV/…). */
    path: string
    format: "csv" | "json" | "sqlite" | "ncu-rep" | "nsys-rep" | "rocpd" | "perf-data" | "text"
    /** Byte size, for the R0 output budget / artifact routing. */
    bytes?: number
    /** Native exporter command that can re-derive a human view (e.g. `nsys stats …`). */
    exportCommand?: string
  }

  /** What to profile. `focus` (symbol/kernel) drives `LSPResolve` back-fill in P3A. */
  export interface ProfileTarget {
    /** Command/test/executable to profile. */
    command: string
    args?: readonly string[]
    cwd?: string
    /** Symbol/kernel name to focus on (resolved via LSP for hotspot back-fill). */
    focus?: string
    /** Requested domain; an adapter may pin its own. */
    domain?: Domain
    /** Requested neutral metric names (PAP vocabulary); empty → adapter default set. */
    metrics?: readonly string[]
  }

  /**
   * Stage-2 output: the parsed native report. Still carries NATIVE metric names —
   * normalization to the neutral vocabulary happens in stage 3. `availableMetrics`
   * is the existence-check input (§P1A-V 映射原则 1): the metrics this machine's
   * profiler actually exposed, used to trim "theoretical" mappings to "machine-available".
   */
  export interface RawHotspot {
    name: string
    kind: "kernel" | "symbol"
    file_line?: FileLine | null
    self_pct?: number
    total_pct?: number
    /** Native metric name → raw value, as the profiler exported it. */
    nativeMetrics: Record<string, number | string>
  }

  export interface RawProfile {
    adapterId: string
    vendor: Vendor
    domain: Domain
    target: ProfileTarget
    /** Top-level native metrics (roofline/occupancy summary), native names preserved. */
    nativeSummary: Record<string, number | string>
    hotspots: RawHotspot[]
    raw_report_ref: NativeReportRef
    /** Native metrics actually available on this machine (existence-check input). */
    availableMetrics?: readonly string[]
  }

  /**
   * Stage-3 output: the vendor-agnostic profile handed to the Agent / evidence layer.
   * Every metric key is a NEUTRAL vocabulary name; no native vendor names leak here.
   * Native report stays out of context — only `raw_report_ref` points to the artifact.
   */
  export interface NormalizedProfile {
    domain: Domain
    vendor: Vendor
    adapterId: string
    target: ProfileTarget
    /** Wall/kernel duration normalized to ns; `null` when the profiler did not report it. */
    duration_ns?: number | null
    hotspots: Hotspot[]
    /** Top-level neutral metrics (roofline/occupancy/etc.): neutral name → value. */
    summary: Record<string, MetricValue>
    raw_report_ref: NativeReportRef
  }

  // —— neutral→native mapping (validated at adapter registration) ——————————————

  /** A neutral metric this adapter CAN produce, and how. */
  export interface MetricMapPresent {
    neutral: string
    native: string | readonly string[]
    semantic: Semantic
    /** True for PAP-computed metrics (`ipc`/`compute_bound`); requires `formula`. */
    derived?: boolean
    formula?: string
    conversion?: string
  }

  /** A neutral metric this adapter CANNOT produce — declared null + reason at register time. */
  export interface MetricMapMissing {
    neutral: string
    native: null
    reason: MissingReason
    detail?: string
  }

  export type MetricMapEntry = MetricMapPresent | MetricMapMissing

  export const isMappingPresent = (e: MetricMapEntry): e is MetricMapPresent => e.native !== null
  export const isMappingMissing = (e: MetricMapEntry): e is MetricMapMissing => e.native === null

  /**
   * An adapter's declared mapping from the neutral vocabulary onto its native metrics.
   * Validated at registration by `Vocabulary.validateMapping` for completeness +
   * existence + derived/missing honesty.
   */
  export interface MetricMapping {
    adapterId: string
    domain: Domain
    /** Native metrics actually available on this machine (existence check). */
    availableMetrics?: readonly string[]
    entries: readonly MetricMapEntry[]
  }

  // —— the adapter contract ——————————————————————————————————————————————————

  /**
   * The PAP three-stage contract. Adding a new profiler = implement these three
   * stages + fill `mapping`; nothing above this layer changes. Stages return
   * `Promise` (matching the §P1A interface sketch) because the actual collect/parse
   * are process/IO bound in P2A; `normalize` is pure but stays async-shaped for
   * symmetry. Control-plane only: collect builds a CLI and runs the vendor tool —
   * PAP never reimplements a profiler.
   */
  export interface ProfileAdapter {
    readonly id: string // "ncu" | "nsys" | "rocprof" | "vtune" | "perf"
    readonly vendor: Vendor
    readonly domain: Domain
    /** Privileges this adapter needs; R0 gates them fail-closed. */
    readonly privileges: readonly RuntimeBase.PrivilegeSpec[]
    /** Neutral→native mapping; validated at registration (anti-套壳 completeness). */
    readonly mapping: MetricMapping
    /** Default output budget; large native reports spill to an artifact (R0). */
    readonly defaultBudget?: RuntimeBase.ResourceBudget

    /** Stage 1 — build CLI, run program under profiler, produce native report. */
    collect(target: ProfileTarget): Promise<NativeReportRef>
    /** Stage 2 — read native report (CSV/JSON/SQLite) into intermediate structure. */
    parse(report: NativeReportRef): Promise<RawProfile>
    /** Stage 3 — map native metric names onto the neutral vocabulary. */
    normalize(raw: RawProfile): NormalizedProfile
  }

  // —— profile structural validation ——————————————————————————————————————————

  export interface ValidationResult {
    ok: boolean
    errors: string[]
    warnings: string[]
  }

  /**
   * Validate that a `NormalizedProfile` is well-formed: required fields present,
   * each hotspot identified (symbol|kernel) with a numeric `self_pct`, and every
   * metric value is either a proper present-with-provenance value or an honest
   * null-with-reason. Vocabulary conformance (neutral names + domain applicability)
   * is checked by `Vocabulary.validateProfile`; this is the structural gate.
   */
  export const validateProfile = (np: NormalizedProfile): ValidationResult => {
    const errors: string[] = []
    const warnings: string[] = []
    const domains: readonly Domain[] = ["gpu_kernel", "gpu_timeline", "cpu_sampling", "cpu_hotspot"]

    if (!np.adapterId) errors.push("missing adapterId")
    if (!domains.includes(np.domain)) errors.push(`invalid domain: ${String(np.domain)}`)
    if (!np.target || !np.target.command) errors.push("missing target.command")
    if (!np.raw_report_ref || !np.raw_report_ref.path) errors.push("missing raw_report_ref.path")
    if (np.duration_ns !== undefined && np.duration_ns !== null && !(np.duration_ns >= 0))
      errors.push("duration_ns must be >= 0 or null")

    if (!Array.isArray(np.hotspots)) {
      errors.push("hotspots must be an array")
    } else {
      np.hotspots.forEach((h, i) => {
        if (!h.symbol && !h.kernel) errors.push(`hotspot[${i}] has neither symbol nor kernel`)
        if (typeof h.self_pct !== "number") errors.push(`hotspot[${i}].self_pct must be a number`)
        if (h.file_line !== undefined && h.file_line !== null) {
          if (!h.file_line.file || typeof h.file_line.line !== "number")
            errors.push(`hotspot[${i}].file_line must be {file,line} or null`)
        }
        validateMetricBag(h.metrics, `hotspot[${i}].metrics`, errors, warnings)
      })
    }

    validateMetricBag(np.summary, "summary", errors, warnings)
    return { ok: errors.length === 0, errors, warnings }
  }

  const validateMetricBag = (
    bag: Record<string, MetricValue> | undefined,
    where: string,
    errors: string[],
    warnings: string[],
  ): void => {
    if (!bag || typeof bag !== "object") {
      errors.push(`${where} must be an object`)
      return
    }
    for (const [name, m] of Object.entries(bag)) {
      if (m == null || typeof m !== "object") {
        errors.push(`${where}.${name} is not a MetricValue`)
        continue
      }
      if (isMissing(m)) {
        if (!m.reason) errors.push(`${where}.${name} is null but has no reason (must be honest, not fabricated)`)
        continue
      }
      // present
      if (m.unit === undefined) errors.push(`${where}.${name} present value missing unit`)
      if (!m.provenance || !m.provenance.nativeMetric) errors.push(`${where}.${name} present value missing provenance`)
      else {
        if (m.provenance.derived && !m.provenance.formula)
          errors.push(`${where}.${name} is derived but records no formula`)
        if (m.provenance.semantic === "approximate")
          warnings.push(`${where}.${name} mapped with approximate semantics`)
      }
    }
  }
}
