import { PAP } from "./pap"

/**
 * P1A-V (S1-v3.5): the vendor-neutral metric vocabulary — PAP's soul.
 *
 * This is the contract table. Each neutral metric declares its meaning, the
 * domains it applies to, its normalized unit, and whether it is `derived` (PAP
 * computes it from native metrics rather than reading it directly). Adapters map
 * their native metric names onto these neutral names; `validateMapping` enforces,
 * at registration time, that a mapping is COMPLETE (covers every metric applicable
 * to the adapter's domain), HONEST (missing → null + reason, never fabricated),
 * EXISTENT (mapped natives are actually available on this machine), and AUDITABLE
 * (derived metrics record a formula). Without this gate PAP degrades into N
 * incomparable per-profiler wrappers ("套壳").
 *
 * Metric names and the native columns referenced in comments are taken from the
 * vendor docs cited in §P1A-V Sources (NVIDIA Nsight Compute/Systems, AMD
 * rocprofv3, Intel VTune, Linux perf).
 */
export namespace Vocabulary {
  /** Definition of one neutral metric in the vocabulary. */
  export interface MetricDef {
    /** Neutral name — the key that appears in `NormalizedProfile` metric bags. */
    name: string
    /** What the metric means (vendor-agnostic). */
    meaning: string
    /** Domains this metric is applicable to; outside these it is `not_applicable_to_domain`. */
    domains: readonly PAP.Domain[]
    /** Normalized unit. */
    unit: PAP.MetricUnit
    /** True when PAP computes it from other native metrics (not a native metric itself). */
    derived: boolean
  }

  // —— 表 1：GPU kernel 级（NVIDIA ncu ↔ AMD rocprof）————————————————————————————
  const GPU_KERNEL: readonly PAP.Domain[] = ["gpu_kernel"]

  export const TABLE_1_GPU_KERNEL: readonly MetricDef[] = [
    {
      name: "compute_throughput_pct",
      meaning: "Compute (SM/CU) throughput as a percent of peak sustained.",
      domains: GPU_KERNEL,
      unit: "pct",
      derived: false,
    }, // ncu sm__throughput.avg.pct_of_peak_sustained_elapsed ↔ rocprof GPUBusy (approx)
    {
      name: "memory_throughput_pct",
      meaning: "Memory subsystem throughput as a percent of peak sustained.",
      domains: GPU_KERNEL,
      unit: "pct",
      derived: false,
    }, // ncu gpu__compute_memory_throughput... ↔ rocprof MemUnitBusy
    {
      name: "dram_bandwidth_pct",
      meaning: "DRAM bandwidth utilization as a percent of peak.",
      domains: GPU_KERNEL,
      unit: "pct",
      derived: false,
    }, // ncu gpu__dram_throughput... ↔ rocprof MemUnitBusy / (FetchSize+WriteSize ÷ time ÷ peak)
    {
      name: "l2_throughput_pct",
      meaning: "L2 cache throughput as a percent of peak. NB: AMD L2CacheHit is hit-rate (approximate).",
      domains: GPU_KERNEL,
      unit: "pct",
      derived: false,
    }, // ncu lts__throughput... ↔ rocprof L2CacheHit (semantic: approximate)
    {
      name: "occupancy_pct",
      meaning: "Achieved occupancy: active warps/wavefronts as a percent of peak.",
      domains: GPU_KERNEL,
      unit: "pct",
      derived: false,
    }, // ncu sm__warps_active... ↔ rocprof Wavefronts / theoretical
    {
      name: "valu_utilization_pct",
      meaning: "Vector ALU utilization percent.",
      domains: GPU_KERNEL,
      unit: "pct",
      derived: false,
    }, // ncu sm__pipe_fma_cycles_active... (approx) ↔ rocprof VALUUtilization
    {
      name: "salu_busy_pct",
      meaning: "Scalar ALU busy percent (AMD-native; no direct NVIDIA counterpart).",
      domains: GPU_KERNEL,
      unit: "pct",
      derived: false,
    }, // ncu — (null) ↔ rocprof SALUBusy
    {
      name: "duration_ns",
      meaning: "Kernel execution duration, normalized to nanoseconds.",
      domains: GPU_KERNEL,
      unit: "ns",
      derived: false,
    }, // ncu gpu__time_duration.sum ↔ rocpd kernel timestamp diff
    {
      name: "compute_bound",
      meaning: "Derived: whether the kernel is compute-bound (compute throughput > memory by threshold).",
      domains: GPU_KERNEL,
      unit: "bool",
      derived: true,
    }, // PAP-derived from compute_throughput_pct vs memory_throughput_pct
  ]

  // —— 表 2：GPU timeline 级（NVIDIA nsys ↔ AMD rocprof trace）————————————————————
  const GPU_TIMELINE: readonly PAP.Domain[] = ["gpu_timeline"]

  export const TABLE_2_GPU_TIMELINE: readonly MetricDef[] = [
    {
      name: "kernel_total_pct",
      meaning: "Share of total GPU time spent in a single kernel.",
      domains: GPU_TIMELINE,
      unit: "pct",
      derived: false,
    }, // nsys gpukernsum % column ↔ rocpd kernel-table aggregation
    {
      name: "mem_copy_pct",
      meaning: "Share of time in H2D/D2H memory transfers.",
      domains: GPU_TIMELINE,
      unit: "pct",
      derived: false,
    }, // nsys gpumemtimesum ↔ rocprof --memory-copy-trace
    {
      name: "api_overhead_pct",
      meaning: "Share of time in API-call overhead (CUDA/HIP runtime).",
      domains: GPU_TIMELINE,
      unit: "pct",
      derived: false,
    }, // nsys cudaapisum ↔ rocprof --hip-trace aggregation
  ]
  // NB: the hotspot-list metric (`hotspot[].kernel`, §P1A-V 表2 first row) is structural
  // — it lives in `Hotspot.kernel`, not as a scalar metric — so it is not a MetricDef.

  // —— 表 3：CPU 级（Intel VTune ↔ Linux perf）—————————————————————————————————————
  const CPU_ALL: readonly PAP.Domain[] = ["cpu_sampling", "cpu_hotspot"]
  const CPU_HOTSPOT: readonly PAP.Domain[] = ["cpu_hotspot"]

  export const TABLE_3_CPU: readonly MetricDef[] = [
    {
      name: "self_pct",
      meaning: "Self time as a percent of total (per symbol/function).",
      domains: CPU_ALL,
      unit: "pct",
      derived: false,
    }, // VTune hotspots CPU Time % ↔ perf Overhead % (also surfaced structurally on Hotspot.self_pct)
    {
      name: "cpi",
      meaning: "Cycles per instruction.",
      domains: CPU_ALL,
      unit: "ratio",
      derived: false,
    }, // VTune CPI Rate ↔ perf cycles/instructions (derived on perf)
    {
      name: "ipc",
      meaning: "Derived: instructions per cycle (1/CPI).",
      domains: CPU_ALL,
      unit: "ratio",
      derived: true,
    }, // VTune 1/CPI Rate (derived) ↔ perf instructions/cycles
    {
      name: "clockticks",
      meaning: "Clock cycles consumed.",
      domains: CPU_ALL,
      unit: "count",
      derived: false,
    }, // VTune Clockticks ↔ perf cycles PMU event
    {
      name: "instructions_retired",
      meaning: "Retired instruction count.",
      domains: CPU_ALL,
      unit: "count",
      derived: false,
    }, // VTune Instructions Retired ↔ perf instructions PMU event
    {
      name: "memory_bound_pct",
      meaning: "Percent of pipeline slots stalled on memory (topdown µarch analysis).",
      domains: CPU_HOTSPOT,
      unit: "pct",
      derived: false,
    }, // VTune Memory Bound ↔ perf — (null unless perf stat topdown)
    {
      name: "dram_bound_pct",
      meaning: "Percent of pipeline slots bound on DRAM.",
      domains: CPU_HOTSPOT,
      unit: "pct",
      derived: false,
    }, // VTune DRAM Bound ↔ perf — (null)
    {
      name: "cache_miss_rate",
      meaning: "Cache miss rate (misses / references).",
      domains: CPU_ALL,
      unit: "ratio",
      derived: false,
    }, // VTune *Cache Miss* ↔ perf cache-misses/cache-references
    {
      name: "branch_misprediction_pct",
      meaning: "Branch misprediction rate.",
      domains: CPU_ALL,
      unit: "pct",
      derived: false,
    }, // VTune Bad Speculation ↔ perf branch-misses/branches
  ]

  /** The full vocabulary, all tables flattened. */
  export const ALL: readonly MetricDef[] = [...TABLE_1_GPU_KERNEL, ...TABLE_2_GPU_TIMELINE, ...TABLE_3_CPU]

  const BY_NAME: ReadonlyMap<string, MetricDef> = new Map(ALL.map((m) => [m.name, m]))

  export const get = (name: string): MetricDef | undefined => BY_NAME.get(name)
  export const has = (name: string): boolean => BY_NAME.has(name)

  /** Neutral metrics applicable to a domain — the completeness target for that domain. */
  export const metricsForDomain = (domain: PAP.Domain): readonly MetricDef[] =>
    ALL.filter((m) => m.domains.includes(domain))

  // —— mapping validation (run when an adapter registers) ——————————————————————

  export interface MappingIssue {
    /** Neutral metric the issue is about (or "" for mapping-wide issues). */
    metric: string
    kind:
      | "unknown_metric" // mapping references a name not in the vocabulary
      | "not_applicable_to_domain" // mapped a metric that doesn't apply to this domain
      | "missing_coverage" // an applicable metric was neither mapped nor declared null
      | "derived_without_formula" // derived metric mapped present but no formula recorded
      | "derived_mismatch" // present mapping marks derived≠vocabulary, or native metric for non-derived absent
      | "null_without_reason" // declared missing but no reason given
      | "native_not_available" // mapped native metric isn't in this machine's availableMetrics
      | "duplicate_entry" // the same neutral metric mapped twice
    detail: string
  }

  export interface MappingValidation {
    ok: boolean
    issues: MappingIssue[]
    /** Neutral metrics this adapter produces a real value for. */
    present: string[]
    /** Neutral metrics honestly declared null. */
    missing: string[]
  }

  /**
   * Validate an adapter's neutral→native mapping at registration. Enforces the five
   * §P1A-V 映射原则:
   *   1. existence — every mapped native metric must be in `availableMetrics` (when provided).
   *   2. semantic — `approximate` is allowed; only structural problems are flagged here.
   *   3. derived split — derived metrics need a formula and must match the vocabulary's
   *      `derived` flag; non-derived present mappings must name a native metric.
   *   4. unit — units come from the vocabulary def, so they are consistent by construction.
   *   5. honesty/completeness — every domain-applicable metric is either mapped present OR
   *      declared null + reason; nothing applicable may be silently omitted, and nothing
   *      may be fabricated.
   */
  export const validateMapping = (mapping: PAP.MetricMapping): MappingValidation => {
    const issues: MappingIssue[] = []
    const present: string[] = []
    const missing: string[] = []
    const seen = new Set<string>()
    const available = mapping.availableMetrics ? new Set(mapping.availableMetrics) : undefined

    for (const entry of mapping.entries) {
      const def = get(entry.neutral)
      if (!def) {
        issues.push({ metric: entry.neutral, kind: "unknown_metric", detail: `'${entry.neutral}' is not in the vocabulary` })
        continue
      }
      if (seen.has(entry.neutral)) {
        issues.push({ metric: entry.neutral, kind: "duplicate_entry", detail: `'${entry.neutral}' mapped more than once` })
        continue
      }
      seen.add(entry.neutral)

      if (!def.domains.includes(mapping.domain)) {
        issues.push({
          metric: entry.neutral,
          kind: "not_applicable_to_domain",
          detail: `'${entry.neutral}' does not apply to domain '${mapping.domain}'`,
        })
        continue
      }

      if (PAP.isMappingMissing(entry)) {
        if (!entry.reason) {
          issues.push({ metric: entry.neutral, kind: "null_without_reason", detail: `null mapping for '${entry.neutral}' has no reason` })
        } else {
          missing.push(entry.neutral)
        }
        continue
      }

      // present mapping
      if (def.derived) {
        if (!entry.derived) {
          issues.push({
            metric: entry.neutral,
            kind: "derived_mismatch",
            detail: `'${entry.neutral}' is derived in the vocabulary but the mapping doesn't mark derived:true`,
          })
        }
        if (!entry.formula) {
          issues.push({
            metric: entry.neutral,
            kind: "derived_without_formula",
            detail: `derived metric '${entry.neutral}' must record a formula (auditability)`,
          })
        }
        // derived metrics may compose multiple natives; existence-check each named one below.
      } else if (entry.derived) {
        issues.push({
          metric: entry.neutral,
          kind: "derived_mismatch",
          detail: `'${entry.neutral}' is native in the vocabulary but the mapping marks derived:true`,
        })
      }

      const natives = Array.isArray(entry.native) ? entry.native : [entry.native]
      if (natives.length === 0 || natives.some((n) => !n)) {
        issues.push({ metric: entry.neutral, kind: "derived_mismatch", detail: `'${entry.neutral}' present mapping names no native metric` })
      }
      if (available) {
        for (const n of natives) {
          if (n && !available.has(n)) {
            issues.push({
              metric: entry.neutral,
              kind: "native_not_available",
              detail: `native metric '${n}' for '${entry.neutral}' is not in this machine's availableMetrics`,
            })
          }
        }
      }
      present.push(entry.neutral)
    }

    // Completeness: every domain-applicable metric must be covered (present or null).
    for (const def of metricsForDomain(mapping.domain)) {
      if (!seen.has(def.name)) {
        issues.push({
          metric: def.name,
          kind: "missing_coverage",
          detail: `domain '${mapping.domain}' requires '${def.name}' to be mapped present or declared null+reason`,
        })
      }
    }

    return { ok: issues.length === 0, issues, present, missing }
  }

  /**
   * Vocabulary conformance check for a finished `NormalizedProfile`: every metric key
   * (in summary + hotspots) must be a known neutral name and applicable to the profile's
   * domain. Complements `PAP.validateProfile` (which checks structure/provenance).
   */
  export const validateProfile = (np: PAP.NormalizedProfile): PAP.ValidationResult => {
    const errors: string[] = []
    const warnings: string[] = []
    const checkBag = (bag: Record<string, PAP.MetricValue>, where: string) => {
      for (const name of Object.keys(bag)) {
        const def = get(name)
        if (!def) {
          errors.push(`${where}.${name} is not a vocabulary metric`)
          continue
        }
        if (!def.domains.includes(np.domain))
          warnings.push(`${where}.${name} is not applicable to domain '${np.domain}'`)
      }
    }
    checkBag(np.summary, "summary")
    np.hotspots.forEach((h, i) => checkBag(h.metrics, `hotspot[${i}].metrics`))
    return { ok: errors.length === 0, errors, warnings }
  }
}
