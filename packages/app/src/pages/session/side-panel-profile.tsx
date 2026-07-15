/**
 * SidePanelProfile — V3.7 Phase 4.4 PAP 性能剖析可视化面板
 *
 * 挂载到右侧工作面板 "profile" 模式。
 * 结构：RunBar → HotspotTable → MetricCards → DiffBadge
 *
 * 数据来源：
 *   - GET /profile/runs      — 历史运行列表
 *   - POST /profile/run      — 启动新运行（fire-and-forget）
 *   - GET /profile/hotspots  — 热点函数列表
 *   - GET /profile/result    — 完整 PROFILE_RESULT.json
 */
import {
  For,
  Match,
  Show,
  Switch,
  batch,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js"
import { IconButton } from "@deepagent-code/ui/icon-button"
import { Icon } from "@deepagent-code/ui/icon"
import { useServerSDK } from "@/context/server-sdk"
import { useFile } from "@/context/file"

// ── Types ────────────────────────────────────────────────────────────────────

interface RunEntry {
  runId: string
  status: "running" | "done" | "error"
  artifactPath?: string
  error?: string
}

interface ProfileHotspot {
  name: string
  fileLine: string
  selfPct: number
  cumulPct: number
  calls: number
}

interface MetricValue {
  value: number | boolean | string | null
  unit?: string
}

interface HotspotDiff {
  name: string
  status: "improved" | "worsened" | "unchanged" | "added" | "removed"
  self_pct_delta?: number
}

interface ProfileArtifact {
  evidence_kind: "profile"
  generated_at: string
  profile: {
    domain: string
    vendor: string
    adapterId: string
    summary: Record<string, MetricValue>
  }
  roofline?: { bound: string; detail: string }
  diff?: { hotspots: HotspotDiff[]; comparable: boolean; note?: string }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Format self% as a narrow bar indicator. */
function pctBar(pct: number): string {
  const filled = Math.round(pct / 10)
  return "█".repeat(filled) + "░".repeat(10 - filled)
}

const METRIC_KEYS_GPU = ["occupancy_pct", "compute_throughput_pct", "memory_throughput_pct", "dram_bandwidth_pct"]
const METRIC_KEYS_CPU = ["ipc", "cpi", "cache_miss_rate", "branch_misprediction_pct"]

function pickMetricKeys(domain: string): string[] {
  if (domain === "gpu_kernel" || domain === "gpu_timeline") return METRIC_KEYS_GPU
  return METRIC_KEYS_CPU
}

function formatMetricValue(v: MetricValue | undefined): string {
  if (!v) return "—"
  const val = v.value
  if (val === null || val === undefined) return "—"
  if (typeof val === "boolean") return val ? "true" : "false"
  if (typeof val === "string") return val
  // Numeric
  const unit = v.unit ?? ""
  return unit === "pct" || unit === "%" ? `${Number(val).toFixed(1)}%` : Number(val).toFixed(2)
}

function labelForKey(key: string): string {
  const labels: Record<string, string> = {
    occupancy_pct: "占用率",
    compute_throughput_pct: "算力利用",
    memory_throughput_pct: "内存带宽",
    dram_bandwidth_pct: "DRAM带宽",
    ipc: "IPC",
    cpi: "CPI",
    cache_miss_rate: "Cache缺失率",
    branch_misprediction_pct: "分支预测失败率",
  }
  return labels[key] ?? key
}

// ── MetricCards ───────────────────────────────────────────────────────────────

const MetricCards: Component<{
  summary: Record<string, MetricValue>
  domain: string
}> = (props) => {
  const keys = () => pickMetricKeys(props.domain).filter((k) => props.summary[k] !== undefined)
  return (
    <div class="flex flex-wrap gap-2 px-3 py-2">
      <For each={keys()}>
        {(key) => (
          <div class="flex flex-col gap-0.5 min-w-[7rem] rounded-md bg-surface-base px-3 py-2">
            <span class="text-10-regular text-text-weaker truncate">{labelForKey(key)}</span>
            <span class="text-14-medium text-text-strong font-mono">
              {formatMetricValue(props.summary[key])}
            </span>
          </div>
        )}
      </For>
    </div>
  )
}

// ── DiffBadge ─────────────────────────────────────────────────────────────────

const DiffBadge: Component<{ diff: ProfileArtifact["diff"] }> = (props) => {
  const improved = () => props.diff?.hotspots.filter((h) => h.status === "improved").length ?? 0
  const worsened = () => props.diff?.hotspots.filter((h) => h.status === "worsened").length ?? 0

  return (
    <Show when={props.diff && props.diff.comparable}>
      <div class="flex items-center gap-2 px-3 py-1.5 bg-surface-base mx-3 mb-2 rounded-md">
        <span class="text-11-regular text-text-weak">与上次对比</span>
        <Show when={improved() > 0}>
          <span class="text-11-medium text-green-400">▲ {improved()} 优化</span>
        </Show>
        <Show when={worsened() > 0}>
          <span class="text-11-medium text-red-400">▼ {worsened()} 劣化</span>
        </Show>
        <Show when={improved() === 0 && worsened() === 0}>
          <span class="text-11-regular text-text-weaker">无变化</span>
        </Show>
      </div>
    </Show>
  )
}

// ── HotspotTable ─────────────────────────────────────────────────────────────

const HotspotTable: Component<{
  hotspots: ProfileHotspot[]
  diff?: HotspotDiff[]
  onNavigate?: (fileLine: string) => void
}> = (props) => {
  const diffMap = () => {
    const m = new Map<string, HotspotDiff>()
    for (const d of (props.diff ?? [])) m.set(d.name, d)
    return m
  }

  return (
    <div class="overflow-x-auto">
      <table class="w-full text-11-regular border-collapse">
        <thead>
          <tr class="text-text-weaker text-left border-b border-border-weaker-base">
            <th class="px-3 py-1.5 font-medium">函数名</th>
            <th class="px-2 py-1.5 font-medium">文件:行</th>
            <th class="px-2 py-1.5 font-medium text-right">自占%</th>
            <th class="px-2 py-1.5 font-medium text-right">累积%</th>
            <th class="px-2 py-1.5 font-medium text-right">调用次数</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.hotspots}>
            {(row, idx) => {
              const d = () => diffMap().get(row.name)
              const diffClass = () => {
                const status = d()?.status
                if (status === "improved") return "text-green-400"
                if (status === "worsened") return "text-red-400"
                return ""
              }
              return (
                <tr
                  class="border-b border-border-weaker-base hover:bg-surface-base"
                  classList={{ "bg-surface-base-active": idx() === 0 }}
                >
                  <td class="px-3 py-1 max-w-[10rem]">
                    <span class={`text-12-regular text-text-strong truncate block ${diffClass()}`}>
                      {row.name}
                    </span>
                    <span class="text-10-regular text-text-weaker font-mono">{pctBar(row.selfPct)}</span>
                  </td>
                  <td class="px-2 py-1 max-w-[8rem]">
                    <Show when={row.fileLine}>
                      <button
                        type="button"
                        class="text-11-regular text-blue-400 hover:underline truncate max-w-full block text-left"
                        onClick={() => props.onNavigate?.(row.fileLine)}
                        title={row.fileLine}
                      >
                        {row.fileLine}
                      </button>
                    </Show>
                  </td>
                  <td class="px-2 py-1 text-right text-12-medium text-text-strong font-mono">
                    {row.selfPct.toFixed(1)}%
                  </td>
                  <td class="px-2 py-1 text-right text-12-regular text-text font-mono">
                    {row.cumulPct.toFixed(1)}%
                  </td>
                  <td class="px-2 py-1 text-right text-12-regular text-text font-mono">
                    {row.calls >= 0 ? row.calls.toLocaleString() : "—"}
                  </td>
                </tr>
              )
            }}
          </For>
        </tbody>
      </table>
    </div>
  )
}

// ── RunBar ────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000

// ── SidePanelProfile (main export) ───────────────────────────────────────────

export const SidePanelProfile: Component<{ onClose: () => void }> = (props) => {
  const sdk = useServerSDK()
  const file = useFile()

  // ── signals ──────────────────────────────────────────────────────────────
  const [runs, setRuns] = createSignal<RunEntry[]>([])
  const [selectedRunId, setSelectedRunId] = createSignal<string | undefined>(undefined)
  const [hotspots, setHotspots] = createSignal<ProfileHotspot[]>([])
  const [artifact, setArtifact] = createSignal<ProfileArtifact | undefined>(undefined)
  const [program, setProgram] = createSignal("")
  const [profiler, setProfiler] = createSignal("")
  const [launching, setLaunching] = createSignal(false)
  const [loadingHotspots, setLoadingHotspots] = createSignal(false)
  const [error, setError] = createSignal<string | undefined>(undefined)

  let pollTimer: ReturnType<typeof setInterval> | undefined

  // ── load run list ─────────────────────────────────────────────────────────
  const loadRuns = async () => {
    try {
      const res = await (sdk.client.profile.runs() as Promise<{ data?: unknown }>)
      const data = (res as any)?.data as RunEntry[] | undefined
      if (Array.isArray(data)) {
        setRuns(data)
        // Auto-select most recent done run on initial load
        if (!selectedRunId()) {
          const done = data.find((r) => r.status === "done")
          if (done) void selectRun(done.runId)
        }
      }
    } catch {
      // tolerate network errors
    }
  }

  // ── poll running run ──────────────────────────────────────────────────────
  const pollSelectedRun = async () => {
    const runId = selectedRunId()
    if (!runId) return
    const current = runs().find((r) => r.runId === runId)
    if (!current || current.status !== "running") return

    try {
      const res = await (sdk.client.profile.result({ runId }) as Promise<{ data?: unknown }>)
      const data = (res as any)?.data as { status?: string; error?: string } | undefined
      if (data?.status === "done") {
        // Refresh the run list and load hotspots
        await loadRuns()
        await loadHotspots(runId)
        await loadArtifact(runId)
      } else if (data?.status === "error") {
        setError(data.error ?? "run failed")
        setRuns((prev) => prev.map((r) => r.runId === runId ? { ...r, status: "error", error: data.error } : r))
      }
    } catch {
      // tolerate
    }
  }

  // ── load hotspots ─────────────────────────────────────────────────────────
  const loadHotspots = async (runId: string) => {
    setLoadingHotspots(true)
    setError(undefined)
    try {
      const res = await (sdk.client.profile.hotspots({ runId, limit: 15 }) as Promise<{ data?: unknown }>)
      const data = (res as any)?.data as ProfileHotspot[] | undefined
      setHotspots(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : "load hotspots failed")
    } finally {
      setLoadingHotspots(false)
    }
  }

  // ── load artifact (full result for MetricCards + DiffBadge) ──────────────
  const loadArtifact = async (runId: string) => {
    try {
      const res = await (sdk.client.profile.result({ runId }) as Promise<{ data?: unknown }>)
      const data = (res as any)?.data as (ProfileArtifact & { status?: string }) | undefined
      if (data?.status === "done" || data?.evidence_kind === "profile") {
        setArtifact(data as ProfileArtifact)
      }
    } catch {
      // tolerate
    }
  }

  // ── select run ────────────────────────────────────────────────────────────
  const selectRun = async (runId: string) => {
    setSelectedRunId(runId)
    setHotspots([])
    setArtifact(undefined)
    setError(undefined)
    const entry = runs().find((r) => r.runId === runId)
    if (entry?.status === "done") {
      await loadHotspots(runId)
      await loadArtifact(runId)
    } else if (entry?.status === "error") {
      setError(entry.error ?? "run failed")
    }
    // If running, pollTimer will pick it up
  }

  // ── launch new run ────────────────────────────────────────────────────────
  const launchRun = async () => {
    const prog = program().trim()
    if (!prog) return
    setLaunching(true)
    setError(undefined)
    try {
      const res = await (sdk.client.profile.run({
        program: prog,
        ...(profiler().trim() ? { profiler: profiler().trim() } : {}),
      }) as Promise<{ data?: unknown }>)
      const data = (res as any)?.data as RunEntry | undefined
      if (data?.runId) {
        await loadRuns()
        setSelectedRunId(data.runId)
        setHotspots([])
        setArtifact(undefined)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "launch failed")
    } finally {
      setLaunching(false)
    }
  }

  // ── navigate to file:line ─────────────────────────────────────────────────
  const handleNavigate = (fileLine: string) => {
    const colon = fileLine.lastIndexOf(":")
    if (colon < 0) return
    const path = fileLine.slice(0, colon)
    void file.load(path)
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  onMount(() => {
    void loadRuns()
    pollTimer = setInterval(() => { void pollSelectedRun() }, POLL_INTERVAL_MS)
  })

  onCleanup(() => {
    if (pollTimer !== undefined) clearInterval(pollTimer)
  })

  // ── derived ───────────────────────────────────────────────────────────────
  const selectedRun = () => runs().find((r) => r.runId === selectedRunId())
  const isRunning = () => selectedRun()?.status === "running"
  const summary = () => artifact()?.profile.summary ?? {}
  const domain = () => artifact()?.profile.domain ?? "cpu_hotspot"
  const diff = () => artifact()?.diff
  const roofline = () => artifact()?.roofline

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div class="h-full w-full min-w-0 flex flex-col overflow-hidden bg-background-base">
      {/* ── Header ── */}
      <div class="shrink-0 sticky top-0 z-10 h-10 flex items-center justify-between px-3 bg-background-base border-b border-border-weaker-base">
        <span class="text-12-medium text-text flex items-center gap-1.5">
          <Icon name="profile" size="small" class="text-icon-base" />
          性能剖析
        </span>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="h-7 w-7 rounded-md"
          onClick={props.onClose}
          aria-label="关闭"
        />
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto">
        {/* ── RunBar ── */}
        <div class="px-3 py-2 border-b border-border-weaker-base space-y-2">
          <div class="flex items-center gap-2">
            <input
              type="text"
              class="flex-1 min-w-0 bg-surface-base rounded px-2 py-1 text-12-regular text-text-strong outline-none border border-border-weaker-base focus:border-border-base placeholder:text-text-weaker"
              placeholder="命令（如 python train.py）"
              value={program()}
              onInput={(e) => setProgram(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void launchRun() }}
              aria-label="剖析命令"
            />
            <button
              type="button"
              disabled={launching() || !program().trim()}
              class="shrink-0 h-7 px-2 rounded text-11-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              onClick={launchRun}
            >
              {launching() ? "…" : "运行"}
            </button>
          </div>
          <div class="flex items-center gap-2">
            <input
              type="text"
              class="w-24 bg-surface-base rounded px-2 py-1 text-12-regular text-text outline-none border border-border-weaker-base focus:border-border-base placeholder:text-text-weaker"
              placeholder="profiler"
              value={profiler()}
              onInput={(e) => setProfiler(e.currentTarget.value)}
              aria-label="Profiler (可选: ncu/nsys/rocprof/vtune/perf)"
              title="Profiler ID：ncu / nsys / rocprof / vtune / perf（留空自动选择）"
            />
            <Show when={runs().length > 0}>
              <select
                class="flex-1 min-w-0 bg-surface-base rounded px-2 py-1 text-12-regular text-text outline-none border border-border-weaker-base"
                value={selectedRunId() ?? ""}
                onChange={(e) => { if (e.currentTarget.value) void selectRun(e.currentTarget.value) }}
                aria-label="历史运行"
              >
                <option value="" disabled>选择历史运行</option>
                <For each={runs()}>
                  {(r) => (
                    <option value={r.runId}>
                      {r.runId.slice(0, 8)}… [{r.status}]
                    </option>
                  )}
                </For>
              </select>
            </Show>
          </div>
        </div>

        {/* ── Status / Error ── */}
        <Show when={isRunning()}>
          <div class="px-3 py-2 flex items-center gap-2 text-12-regular text-blue-400">
            <span class="animate-pulse">●</span> 剖析中…
          </div>
        </Show>
        <Show when={error()}>
          <div class="px-3 py-2 text-12-regular text-red-400 bg-red-950/20 mx-3 my-1 rounded">
            {error()}
          </div>
        </Show>

        {/* ── Roofline badge ── */}
        <Show when={roofline()}>
          {(rf) => (
            <div class="mx-3 mt-2 px-2 py-1 rounded bg-surface-base text-11-regular text-text-weak" title={rf().detail}>
              <span class="font-medium text-text">{rf().bound}</span>
              <span class="ml-1 text-text-weaker">— {rf().detail.slice(0, 80)}{rf().detail.length > 80 ? "…" : ""}</span>
            </div>
          )}
        </Show>

        {/* ── MetricCards ── */}
        <Show when={Object.keys(summary()).length > 0}>
          <div class="mt-1 mb-0.5">
            <div class="px-3 pt-2 pb-0 text-11-medium text-text-weaker uppercase tracking-wide">指标</div>
            <MetricCards summary={summary()} domain={domain()} />
          </div>
        </Show>

        {/* ── DiffBadge ── */}
        <Show when={diff()}>
          {(d) => <DiffBadge diff={d()} />}
        </Show>

        {/* ── HotspotTable ── */}
        <Show when={hotspots().length > 0 || loadingHotspots()}>
          <div class="mt-1">
            <div class="px-3 py-2 text-11-medium text-text-weaker uppercase tracking-wide">热点函数</div>
            <Switch>
              <Match when={loadingHotspots()}>
                <div class="px-3 py-2 text-12-regular text-text-weak">加载中…</div>
              </Match>
              <Match when={true}>
                <HotspotTable
                  hotspots={hotspots()}
                  diff={diff()?.hotspots}
                  onNavigate={handleNavigate}
                />
              </Match>
            </Switch>
          </div>
        </Show>

        {/* ── Empty state ── */}
        <Show when={!isRunning() && hotspots().length === 0 && !loadingHotspots() && !error()}>
          <div class="flex-1 py-16 flex items-center justify-center">
            <div class="text-center text-12-regular text-text-weak space-y-1">
              <div>输入命令并点击运行以启动性能剖析</div>
              <div class="text-11-regular text-text-weaker">profiler 留空将自动选择（CUDA→ncu, CPU→perf）</div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}
