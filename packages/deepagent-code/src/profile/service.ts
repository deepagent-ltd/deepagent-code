import path from "path"
import * as Log from "@deepagent-code/core/util/log"
import { PAP } from "@/profile/pap"

const log = Log.create({ service: "profile.service" })

/**
 * P4A (S1-v3.5): ProfileService — the profiling evidence closed-loop.
 *
 * Orchestrates the full collect→parse→normalize pipeline over a PAP adapter and
 * writes the result as a PROFILE_RESULT.json evidence artifact
 * (`evidence_kind:"profile"`), registered in agent-gateway.ts.
 *
 * Three entry points:
 *   - `run`      — full pipeline + artifact write + optional before/after diff.
 *   - `roofline` — pure classifier: compute/memory/latency/balanced from neutral metrics.
 *   - `diff`     — structured before/after diff of two NormalizedProfiles.
 *
 * Cross-vendor note: because all metrics use the neutral vocabulary, a NVIDIA (ncu)
 * and an AMD (rocprof) profile of the same program can be compared through `diff`.
 * Granularity differs (ncu exports per-kernel counter precision, rocprof aggregates
 * some metrics differently), so some deltas will be `null` when a metric is missing
 * on one side. The `cross_vendor` flag in DiffResult signals this to callers.
 */
export namespace ProfileService {
  // —— roofline types ————————————————————————————————————————————————————————

  export type Bound = "compute" | "memory" | "latency" | "balanced"

  export interface RooflineResult {
    /** The dominant performance limiter. */
    readonly bound: Bound
    /**
     * Human-readable explanation referencing the specific metric values that drove
     * the classification (e.g. "compute-bound (compute_throughput_pct=87%,
     * memory_throughput_pct=42%)"). Derived from the neutral vocabulary — no vendor
     * names leak here.
     */
    readonly detail: string
    /** Always true: this is a PAP-derived classification, not a native metric. */
    readonly derived: true
  }

  // —— diff types ————————————————————————————————————————————————————————————

  export interface MetricDiff {
    before: number | null
    after: number | null
    /** after − before; null when either side has no value. */
    delta: number | null
  }

  export interface HotspotDiff {
    /** Identity key: `symbol` or `kernel` name. */
    name: string
    status: "improved" | "worsened" | "unchanged" | "added" | "removed"
    /** Self-time percent in the before profile (absent for "added"). */
    self_pct_before?: number
    /** Self-time percent in the after profile (absent for "removed"). */
    self_pct_after?: number
    /**
     * self_pct_after − self_pct_before. Negative = hotspot shrank (improved),
     * positive = hotspot grew (worsened). Absent when one side is missing.
     */
    self_pct_delta?: number
    /** Per-neutral-metric deltas for this hotspot. */
    metrics_diff: Record<string, MetricDiff>
  }

  export interface DiffResult {
    hotspots: HotspotDiff[]
    summary_diff: Record<string, MetricDiff>
    /**
     * True when profileA.vendor !== profileB.vendor. Cross-vendor diffs are valid
     * because both profiles use the neutral vocabulary; some metrics may be null
     * on one side when a vendor does not provide them (honest null, not fabricated).
     */
    cross_vendor: boolean
    /**
     * False when the two profiles are NOT directly comparable — currently when they
     * live in different domains (e.g. gpu_kernel vs cpu_sampling): their metric sets
     * and hotspot namespaces are disjoint, so a name-keyed diff produces spurious
     * all-added/all-removed noise. Callers must not present a `comparable:false` diff
     * as an apples-to-apples improvement/regression.
     */
    comparable: boolean
    vendor_a: string
    vendor_b: string
    domain_a: string
    domain_b: string
    /** Human-readable note, e.g. cross-vendor caveat or metric granularity difference. */
    note?: string
    /** Non-fatal caveats, e.g. "same metric mapped exact on one side, approximate on the other". */
    warnings?: string[]
  }

  // —— artifact shape ————————————————————————————————————————————————————————

  /** The shape written to PROFILE_RESULT.json (evidence_kind:"profile"). */
  export interface ProfileArtifact {
    evidence_kind: "profile"
    generated_at: string
    profile: PAP.NormalizedProfile
    roofline: RooflineResult
    diff?: DiffResult
  }

  // —— run options & result ——————————————————————————————————————————————————

  export interface RunOptions {
    /**
     * Directory where PROFILE_RESULT.json will be written. Defaults to the OS
     * temp directory when omitted (useful for tests that only check the returned
     * shape and do not need a stable path).
     */
    artifactDir?: string
    /**
     * Absolute path to a previous PROFILE_RESULT.json. When provided, `run`
     * computes a structured diff against the new profile and attaches it to both
     * the artifact and the return value.
     */
    compare_to?: string
  }

  export interface RunResult {
    profile: PAP.NormalizedProfile
    artifactPath: string
    diff?: DiffResult
  }

  // —— thresholds ————————————————————————————————————————————————————————————

  // GPU kernel thresholds (0–100 scale matching PAP unit:"pct")
  const GPU_COMPUTE_BOUND_THRESHOLD = 70
  const GPU_MEMORY_BOUND_THRESHOLD = 70
  const GPU_LATENCY_OCCUPANCY_MAX = 33

  // CPU thresholds
  const CPU_MEMORY_CACHE_MISS_THRESHOLD = 0.1    // ratio: > 10% miss rate → memory-bound
  const CPU_COMPUTE_IPC_THRESHOLD = 2.0           // ipc > 2.0 → compute-bound
  const CPU_COMPUTE_CACHE_MAX = 0.05              // cache_miss_rate < 5% (paired with high ipc)
  const CPU_LATENCY_BRANCH_THRESHOLD = 10         // branch_misprediction_pct > 10% → latency

  // GPU timeline thresholds
  const TIMELINE_MEMORY_COPY_THRESHOLD = 30       // mem_copy_pct > 30% → memory-bound
  const TIMELINE_API_OVERHEAD_THRESHOLD = 40      // api_overhead_pct > 40% → latency
  const TIMELINE_COMPUTE_KERNEL_THRESHOLD = 80    // kernel_total_pct > 80% → compute-bound

  // —— helpers ———————————————————————————————————————————————————————————————

  /** Extract a numeric value from a MetricValue, or undefined if null/missing. */
  function numericMetric(bag: Record<string, PAP.MetricValue>, key: string): number | undefined {
    const m = bag[key]
    if (!m) return undefined
    if (PAP.isMissing(m)) return undefined
    const v = m.value
    if (typeof v !== "number") return undefined
    return v
  }

  /** Hotspot identity string: symbol takes priority, then kernel. */
  function hotspotName(h: PAP.Hotspot): string {
    return h.symbol ?? h.kernel ?? "(unknown)"
  }

  // —— roofline ——————————————————————————————————————————————————————————————

  /**
   * Derive a roofline / bottleneck classification from a NormalizedProfile.
   *
   * Works for BOTH GPU (gpu_kernel, gpu_timeline) and CPU (cpu_sampling, cpu_hotspot)
   * profiles via the neutral vocabulary. GPU: uses compute_throughput_pct,
   * memory_throughput_pct, dram_bandwidth_pct, occupancy_pct. CPU: uses ipc,
   * cache_miss_rate, memory_bound_pct, branch_misprediction_pct.
   *
   * Returns `bound:"balanced"` when no metric is clearly dominant — this is
   * honest: "no single bottleneck identified from available metrics."
   */
  export const roofline = (profile: PAP.NormalizedProfile): RooflineResult => {
    const s = profile.summary
    const domain = profile.domain

    if (domain === "gpu_kernel") return rooflineGpuKernel(s)
    if (domain === "gpu_timeline") return rooflineGpuTimeline(s)
    // cpu_sampling and cpu_hotspot
    return rooflineCpu(s, profile.hotspots)
  }

  function rooflineGpuKernel(summary: Record<string, PAP.MetricValue>): RooflineResult {
    const computePct = numericMetric(summary, "compute_throughput_pct")
    const memPct = numericMetric(summary, "memory_throughput_pct")
    const dramPct = numericMetric(summary, "dram_bandwidth_pct")
    const occPct = numericMetric(summary, "occupancy_pct")

    // Priority order: latency (low occupancy) first — even a compute-heavy kernel
    // running at 20% occupancy is latency-limited. Then check compute vs memory.
    if (occPct !== undefined && occPct < GPU_LATENCY_OCCUPANCY_MAX) {
      return {
        bound: "latency",
        detail: `latency-bound (occupancy_pct=${occPct.toFixed(1)}% < ${GPU_LATENCY_OCCUPANCY_MAX}%; low occupancy indicates latency-limited execution)`,
        derived: true,
      }
    }
    if (dramPct !== undefined && dramPct >= GPU_MEMORY_BOUND_THRESHOLD) {
      const detail = buildGpuDetail({ computePct, memPct, dramPct, occPct })
      return { bound: "memory", detail: `memory-bound (${detail})`, derived: true }
    }
    if (memPct !== undefined && memPct >= GPU_MEMORY_BOUND_THRESHOLD && (computePct === undefined || computePct < GPU_COMPUTE_BOUND_THRESHOLD)) {
      const detail = buildGpuDetail({ computePct, memPct, dramPct, occPct })
      return { bound: "memory", detail: `memory-bound (${detail})`, derived: true }
    }
    if (computePct !== undefined && computePct >= GPU_COMPUTE_BOUND_THRESHOLD) {
      const detail = buildGpuDetail({ computePct, memPct, dramPct, occPct })
      return { bound: "compute", detail: `compute-bound (${detail})`, derived: true }
    }
    // No clear dominant limiter
    const detail = buildGpuDetail({ computePct, memPct, dramPct, occPct })
    return { bound: "balanced", detail: `balanced (${detail || "no dominant bottleneck from available metrics"})`, derived: true }
  }

  function buildGpuDetail(m: {
    computePct?: number
    memPct?: number
    dramPct?: number
    occPct?: number
  }): string {
    const parts: string[] = []
    if (m.computePct !== undefined) parts.push(`compute_throughput_pct=${m.computePct.toFixed(1)}%`)
    if (m.memPct !== undefined) parts.push(`memory_throughput_pct=${m.memPct.toFixed(1)}%`)
    if (m.dramPct !== undefined) parts.push(`dram_bandwidth_pct=${m.dramPct.toFixed(1)}%`)
    if (m.occPct !== undefined) parts.push(`occupancy_pct=${m.occPct.toFixed(1)}%`)
    return parts.join(", ")
  }

  function rooflineGpuTimeline(summary: Record<string, PAP.MetricValue>): RooflineResult {
    const kernelPct = numericMetric(summary, "kernel_total_pct")
    const memCopyPct = numericMetric(summary, "mem_copy_pct")
    const apiPct = numericMetric(summary, "api_overhead_pct")

    if (memCopyPct !== undefined && memCopyPct >= TIMELINE_MEMORY_COPY_THRESHOLD) {
      return {
        bound: "memory",
        detail: `memory-bound (mem_copy_pct=${memCopyPct.toFixed(1)}% indicates transfer-dominated workload)`,
        derived: true,
      }
    }
    if (apiPct !== undefined && apiPct >= TIMELINE_API_OVERHEAD_THRESHOLD) {
      return {
        bound: "latency",
        detail: `latency-bound (api_overhead_pct=${apiPct.toFixed(1)}% indicates API-call latency dominates)`,
        derived: true,
      }
    }
    if (kernelPct !== undefined && kernelPct >= TIMELINE_COMPUTE_KERNEL_THRESHOLD) {
      return {
        bound: "compute",
        detail: `compute-bound (kernel_total_pct=${kernelPct.toFixed(1)}% of GPU time in compute kernels)`,
        derived: true,
      }
    }
    const parts: string[] = []
    if (kernelPct !== undefined) parts.push(`kernel_total_pct=${kernelPct.toFixed(1)}%`)
    if (memCopyPct !== undefined) parts.push(`mem_copy_pct=${memCopyPct.toFixed(1)}%`)
    if (apiPct !== undefined) parts.push(`api_overhead_pct=${apiPct.toFixed(1)}%`)
    return {
      bound: "balanced",
      detail: `balanced (${parts.join(", ") || "no dominant bottleneck from available metrics"})`,
      derived: true,
    }
  }

  function rooflineCpu(summary: Record<string, PAP.MetricValue>, hotspots: PAP.Hotspot[]): RooflineResult {
    // Try summary first; fall back to aggregate from top hotspot
    const ipc = numericMetric(summary, "ipc") ?? (hotspots[0] ? numericMetric(hotspots[0]!.metrics, "ipc") : undefined)
    const cacheMiss = numericMetric(summary, "cache_miss_rate") ?? (hotspots[0] ? numericMetric(hotspots[0]!.metrics, "cache_miss_rate") : undefined)
    const memBound = numericMetric(summary, "memory_bound_pct")
    const dramBound = numericMetric(summary, "dram_bound_pct")
    const branchMisp = numericMetric(summary, "branch_misprediction_pct")

    // Memory-bound: high cache miss or explicit memory-bound pipeline analysis
    if (cacheMiss !== undefined && cacheMiss >= CPU_MEMORY_CACHE_MISS_THRESHOLD) {
      const parts: string[] = [`cache_miss_rate=${(cacheMiss * 100).toFixed(1)}%`]
      if (memBound !== undefined) parts.push(`memory_bound_pct=${memBound.toFixed(1)}%`)
      if (dramBound !== undefined) parts.push(`dram_bound_pct=${dramBound.toFixed(1)}%`)
      return { bound: "memory", detail: `memory-bound (${parts.join(", ")})`, derived: true }
    }
    if ((memBound !== undefined && memBound >= 40) || (dramBound !== undefined && dramBound >= 20)) {
      const parts: string[] = []
      if (memBound !== undefined) parts.push(`memory_bound_pct=${memBound.toFixed(1)}%`)
      if (dramBound !== undefined) parts.push(`dram_bound_pct=${dramBound.toFixed(1)}%`)
      return { bound: "memory", detail: `memory-bound (${parts.join(", ")})`, derived: true }
    }

    // Compute-bound: high IPC + low cache miss
    if (ipc !== undefined && ipc >= CPU_COMPUTE_IPC_THRESHOLD && (cacheMiss === undefined || cacheMiss < CPU_COMPUTE_CACHE_MAX)) {
      const parts = [`ipc=${ipc.toFixed(2)}`]
      if (cacheMiss !== undefined) parts.push(`cache_miss_rate=${(cacheMiss * 100).toFixed(1)}%`)
      return { bound: "compute", detail: `compute-bound (${parts.join(", ")})`, derived: true }
    }

    // Latency-bound: high branch misprediction (pipeline stalls) or very low IPC without clear cause
    if (branchMisp !== undefined && branchMisp >= CPU_LATENCY_BRANCH_THRESHOLD) {
      const parts = [`branch_misprediction_pct=${branchMisp.toFixed(1)}%`]
      if (ipc !== undefined) parts.push(`ipc=${ipc.toFixed(2)}`)
      return { bound: "latency", detail: `latency-bound (${parts.join(", ")}; branch mispredictions cause pipeline stalls)`, derived: true }
    }

    const parts: string[] = []
    if (ipc !== undefined) parts.push(`ipc=${ipc.toFixed(2)}`)
    if (cacheMiss !== undefined) parts.push(`cache_miss_rate=${(cacheMiss * 100).toFixed(1)}%`)
    if (branchMisp !== undefined) parts.push(`branch_misprediction_pct=${branchMisp.toFixed(1)}%`)
    return {
      bound: "balanced",
      detail: `balanced (${parts.join(", ") || "no dominant bottleneck from available metrics"})`,
      derived: true,
    }
  }

  // —— diff ——————————————————————————————————————————————————————————————————

  /**
   * Produce a structured before/after diff of two NormalizedProfiles.
   *
   * Cross-vendor: because both profiles use the neutral vocabulary, a NVIDIA (ncu)
   * and an AMD (rocprof) profile of the same program can be compared. Metric
   * values that are null on one side (due to vendor metric gaps, not fabrication)
   * produce MetricDiff.delta=null. The `cross_vendor` flag is set to make this
   * visible to the caller.
   *
   * Improvement semantics: a hotspot is "improved" when its self_pct decreased by
   * more than 1 percentage point (it consumed less time), "worsened" when it grew
   * by more than 1 percentage point, and "unchanged" otherwise. Hotspots absent
   * in profileA are "added"; absent in profileB are "removed".
   */
  export const diff = (profileA: PAP.NormalizedProfile, profileB: PAP.NormalizedProfile): DiffResult => {
    const cross_vendor = profileA.vendor !== profileB.vendor
    const comparable = profileA.domain === profileB.domain

    // Cross-domain guard: gpu_kernel vs cpu_sampling (or any domain mismatch) have
    // disjoint metric sets and hotspot namespaces. A name-keyed diff would report
    // everything as added/removed with delta=null and mislabel it "directly comparable".
    // Return early with an explicit not-comparable result rather than fabricate a diff.
    if (!comparable) {
      return {
        hotspots: [],
        summary_diff: {},
        cross_vendor,
        comparable: false,
        vendor_a: profileA.vendor,
        vendor_b: profileB.vendor,
        domain_a: profileA.domain,
        domain_b: profileB.domain,
        note:
          `not_comparable(cross-domain): '${profileA.domain}' vs '${profileB.domain}'. ` +
          `These domains have disjoint metric sets and hotspot namespaces, so a before/after ` +
          `diff is not meaningful. Profile both runs with the same adapter/domain to compare.`,
      }
    }

    // Build lookup maps keyed by hotspot name
    const mapA = new Map<string, PAP.Hotspot>()
    for (const h of profileA.hotspots) mapA.set(hotspotName(h), h)
    const mapB = new Map<string, PAP.Hotspot>()
    for (const h of profileB.hotspots) mapB.set(hotspotName(h), h)

    const hotspots: HotspotDiff[] = []

    // Hotspots in A: matched (updated) or removed
    for (const [name, ha] of mapA) {
      const hb = mapB.get(name)
      if (!hb) {
        hotspots.push({ name, status: "removed", self_pct_before: ha.self_pct, metrics_diff: {} })
        continue
      }
      const delta = hb.self_pct - ha.self_pct
      let status: HotspotDiff["status"] = "unchanged"
      if (delta < -1) status = "improved"
      else if (delta > 1) status = "worsened"

      const metrics_diff = diffMetricBags(ha.metrics, hb.metrics)
      hotspots.push({
        name,
        status,
        self_pct_before: ha.self_pct,
        self_pct_after: hb.self_pct,
        self_pct_delta: delta,
        metrics_diff,
      })
    }

    // Hotspots in B that are new
    for (const [name, hb] of mapB) {
      if (!mapA.has(name)) {
        hotspots.push({ name, status: "added", self_pct_after: hb.self_pct, metrics_diff: {} })
      }
    }

    // Sort: improved first, then unchanged, then worsened, added, removed
    const ORDER: Record<HotspotDiff["status"], number> = {
      improved: 0,
      unchanged: 1,
      worsened: 2,
      added: 3,
      removed: 4,
    }
    hotspots.sort((a, b) => ORDER[a.status] - ORDER[b.status])

    const summary_diff = diffMetricBags(profileA.summary, profileB.summary)

    // Same-domain honesty check: a shared metric mapped `exact` on one side and
    // `approximate` on the other (e.g. ncu-vs-rocprof compute_throughput_pct) means the
    // numeric delta mixes semantics. Surface it as a warning rather than silently trusting it.
    const warnings = collectSemanticWarnings(profileA, profileB)

    let note: string | undefined
    if (cross_vendor) {
      note =
        `Cross-vendor comparison (${profileA.vendor} vs ${profileB.vendor}). ` +
        `Both profiles use the neutral vocabulary so hotspot names and shared metrics are directly comparable. ` +
        `Metrics absent on one vendor (null) produce delta=null — these are honest gaps, not fabrications.`
    }

    return {
      hotspots,
      summary_diff,
      cross_vendor,
      comparable: true,
      vendor_a: profileA.vendor,
      vendor_b: profileB.vendor,
      domain_a: profileA.domain,
      domain_b: profileB.domain,
      ...(note ? { note } : {}),
      ...(warnings.length ? { warnings } : {}),
    }
  }

  /**
   * Detect shared summary metrics whose mapping semantics differ between the two
   * profiles (exact on one side, approximate on the other). The numeric delta of
   * such a metric silently mixes an exact and an approximate quantity, so callers
   * should treat it with the emitted caveat rather than as a clean measurement.
   */
  function collectSemanticWarnings(
    profileA: PAP.NormalizedProfile,
    profileB: PAP.NormalizedProfile,
  ): string[] {
    const warnings: string[] = []
    const semanticOf = (m: PAP.MetricValue | undefined): PAP.Semantic | undefined =>
      m && PAP.isPresent(m) ? m.provenance.semantic : undefined
    for (const key of Object.keys(profileA.summary)) {
      const sa = semanticOf(profileA.summary[key])
      const sb = semanticOf(profileB.summary[key])
      if (sa && sb && sa !== sb) {
        warnings.push(
          `metric '${key}' is mapped '${sa}' on ${profileA.adapterId} but '${sb}' on ${profileB.adapterId}; ` +
            `its delta mixes exact and approximate semantics (semantic_warning).`,
        )
      }
    }
    return warnings
  }

  function diffMetricBags(
    bagA: Record<string, PAP.MetricValue>,
    bagB: Record<string, PAP.MetricValue>,
  ): Record<string, MetricDiff> {
    const result: Record<string, MetricDiff> = {}
    const keys = new Set([...Object.keys(bagA), ...Object.keys(bagB)])
    for (const key of keys) {
      const a = bagA[key]
      const b = bagB[key]
      const va = a && PAP.isPresent(a) && typeof a.value === "number" ? a.value : null
      const vb = b && PAP.isPresent(b) && typeof b.value === "number" ? b.value : null
      const delta = va !== null && vb !== null ? vb - va : null
      result[key] = { before: va, after: vb, delta }
    }
    return result
  }

  // —— run ———————————————————————————————————————————————————————————————————

  /**
   * Run the full collect→parse→normalize pipeline using the given adapter, then:
   *   1. Classify the output with `roofline`.
   *   2. Optionally compute a before/after diff against `options.compare_to`.
   *   3. Write PROFILE_RESULT.json to `options.artifactDir` (defaults to OS temp).
   *
   * The written artifact is registered in agent-gateway.ts with
   * `evidence_kind:"profile"`, so it enters the document graph for plan/audit.
   */
  export const run = async (
    adapter: PAP.ProfileAdapter,
    target: PAP.ProfileTarget,
    options?: RunOptions,
  ): Promise<RunResult> => {
    log.info("ProfileService.run start", { adapter: adapter.id, target: target.command })

    // Stage 1: collect
    const reportRef = await adapter.collect(target)
    log.info("ProfileService collected", { adapter: adapter.id, path: reportRef.path })

    // Stage 2: parse
    const raw = await adapter.parse(reportRef)
    log.info("ProfileService parsed", { adapter: adapter.id, hotspots: raw.hotspots.length })

    // Stage 3: normalize
    const profile = adapter.normalize(raw)
    log.info("ProfileService normalized", { adapter: adapter.id, hotspots: profile.hotspots.length })

    // Roofline classification
    const rooflineResult = roofline(profile)
    log.info("ProfileService roofline", { bound: rooflineResult.bound })

    // Optional diff
    let diffResult: DiffResult | undefined
    if (options?.compare_to) {
      try {
        const fs = await import("fs/promises")
        const raw = await fs.readFile(options.compare_to, "utf8")
        const prev = JSON.parse(raw) as ProfileArtifact
        if (prev.profile) {
          diffResult = diff(prev.profile, profile)
          log.info("ProfileService diff computed", {
            improved: diffResult.hotspots.filter((h) => h.status === "improved").length,
            worsened: diffResult.hotspots.filter((h) => h.status === "worsened").length,
            cross_vendor: diffResult.cross_vendor,
          })
        }
      } catch (e) {
        log.warn("ProfileService: failed to load compare_to; skipping diff", { path: options.compare_to, error: String(e) })
      }
    }

    // Write artifact
    const artifactDir = options?.artifactDir ?? (await import("os")).tmpdir()
    const artifactPath = path.join(artifactDir, "PROFILE_RESULT.json")

    const artifact: ProfileArtifact = {
      evidence_kind: "profile",
      generated_at: new Date().toISOString(),
      profile,
      roofline: rooflineResult,
      ...(diffResult ? { diff: diffResult } : {}),
    }

    try {
      const fs = await import("fs/promises")
      await fs.mkdir(artifactDir, { recursive: true })
      await fs.writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8")
      log.info("ProfileService artifact written", { artifactPath })
    } catch (e) {
      log.warn("ProfileService: failed to write artifact", { artifactPath, error: String(e) })
    }

    return { profile, artifactPath, ...(diffResult ? { diff: diffResult } : {}) }
  }
}
