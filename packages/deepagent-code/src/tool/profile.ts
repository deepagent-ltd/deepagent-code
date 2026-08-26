import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as Log from "@deepagent-code/core/util/log"
import { LSP } from "@/lsp/lsp"
import { LSPResolve } from "@/lsp/resolve"
import { PAP } from "@/profile/pap"
import { ProfileService } from "@/profile/service"
import { ProfileAdapterRegistry } from "@/profile/adapters/index"
import { RuntimeBase } from "@/runtime/base"
import { InstanceState } from "@/effect/instance-state"
import { which } from "@deepagent-code/core/util/which"
import DESCRIPTION from "./profile.txt"

// P3A (S1-v3.5): the Agent-facing profile tool. Symbol/region-driven performance
// profiling entry point. Builds on P1A (PAP protocol), P2A (profiler adapters),
// P4A (ProfileService evidence loop), and R0 (runtime base).
//
// This tool is control-plane only. It routes through R0's fail-closed privilege gate
// + approve-once + worktree isolation (RuntimeBase.Service), then delegates the actual
// collect→parse→normalize→roofline→artifact pipeline to ProfileService.run. It never
// re-implements the pipeline inline and never bypasses the privilege gate.

const log = Log.create({ service: "tool.profile" })

const TOP_N = 10

export const Parameters = Schema.Struct({
  target: Schema.String.annotate({
    description: "The command/test/executable to profile, e.g. `python train.py` or `./bench`.",
  }),
  adapter: Schema.optional(Schema.String).annotate({
    description:
      "Profiler adapter id: ncu | nsys | rocprof | vtune | perf. Omit for auto-selection by env heuristics.",
  }),
  focus: Schema.optional(Schema.String).annotate({
    description:
      "Symbol or kernel name to highlight, e.g. `train_step` or `compute_kernel`. Resolved via LSP to back-fill file:line.",
  }),
  domain: Schema.optional(
    Schema.Literals(["gpu_kernel", "gpu_timeline", "cpu_sampling", "cpu_hotspot"]),
  ).annotate({
    description: "Profiling domain. Inferred from adapter when omitted.",
  }),
  metrics: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Neutral PAP metric names to request, e.g. ['cpi','ipc']. Leave empty for adapter default set.",
  }),
  compare_to: Schema.optional(Schema.String).annotate({
    description:
      "Absolute path to a previous PROFILE_RESULT.json. When given, the tool produces a before/after diff (improved/worsened hotspots) against the new run.",
  }),
})

export type ProfileParams = Schema.Schema.Type<typeof Parameters>

/**
 * Shared metadata shape — both the "not available" and "success" branches must
 * return a structurally compatible object so TypeScript can unify the union.
 */
export interface ProfileMetadata {
  adapterId: string
  available: boolean
  message?: string
  domain?: PAP.Domain
  vendor?: PAP.Vendor
  hotspots?: PAP.Hotspot[]
  summary?: Record<string, PAP.MetricValue>
  raw_report_ref?: PAP.NativeReportRef
  truncated?: boolean
  focus?: string | null
  focusFileLine?: PAP.FileLine | null
  /** Path to the written PROFILE_RESULT.json evidence artifact (P4A closed loop). */
  artifactPath?: string
  /** Roofline / bottleneck classification derived from the neutral metrics. */
  roofline?: ProfileService.RooflineResult
  /** Before/after diff when `compare_to` was provided. */
  diff?: ProfileService.DiffResult
  /** True when the fail-closed privilege gate refused the run (missing GPU/perf/ROCm privilege). */
  privilege_blocked?: boolean
}

/**
 * Auto-select adapter id from environment heuristics.
 * Explicit `adapter` param always overrides. Pure — testable without Effect.
 */
export function autoSelectAdapterId(explicitAdapter?: string): string {
  if (explicitAdapter) return explicitAdapter
  if (process.env["CUDA_VISIBLE_DEVICES"] !== undefined) return "ncu"
  if (process.env["ROCM_HOME"] !== undefined || process.env["HIP_VISIBLE_DEVICES"] !== undefined) return "rocprof"
  if (process.env["VTUNE_PROFILING_DIR"] !== undefined || which("vtune") !== null) return "vtune"
  return "perf"
}

/** Render one hotspot line. Exported for unit tests. */
export function renderHotspot(h: PAP.Hotspot, isFocused: boolean): string {
  const name = h.kernel ?? h.symbol ?? "?"
  const loc = h.file_line ? `${h.file_line.file}:${h.file_line.line}` : ""
  const metricParts: string[] = [`self: ${h.self_pct.toFixed(1)}%`]

  const cpi = h.metrics["cpi"]
  if (cpi && PAP.isPresent(cpi)) metricParts.push(`  cpi: ${Number(cpi.value).toFixed(1)}`)
  const ipc = h.metrics["ipc"]
  if (ipc && PAP.isPresent(ipc)) metricParts.push(`  ipc: ${Number(ipc.value).toFixed(2)}`)

  const focusMarker = isFocused ? "* " : "  "
  const nameCol = name.padEnd(20)
  const locCol = loc ? `${loc.padEnd(30)}` : "".padEnd(30)
  return `${focusMarker}${nameCol} ${locCol} ${metricParts.join("")}`
}

/** Render summary key=value pairs. Exported for unit tests. */
export function renderSummary(summary: Record<string, PAP.MetricValue>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(summary)) {
    if (PAP.isPresent(v)) {
      const val = typeof v.value === "boolean" ? String(v.value) : Number(v.value).toFixed(2)
      parts.push(`${k}=${val}`)
    }
  }
  return parts.join("  ")
}

/**
 * Build the formatted profile output from a NormalizedProfile. Exported for tests.
 * focus/focusFileLine control highlighting; adapterId/target go into the header.
 */
export function buildProfileOutput(params: {
  adapterId: string
  target: string
  normalized: PAP.NormalizedProfile
  focus?: string
  focusFileLine?: PAP.FileLine | null
  /** Absolute path to the written PROFILE_RESULT.json evidence artifact. */
  artifactPath?: string
}): string {
  const { adapterId, target, normalized, focus, focusFileLine, artifactPath } = params
  const sorted = [...normalized.hotspots].sort((a, b) => b.self_pct - a.self_pct).slice(0, TOP_N)

  const lines: string[] = []
  lines.push(`profile: ${adapterId} ${normalized.domain} on \`${target}\``)
  if (focus) {
    const loc = focusFileLine ? `${focusFileLine.file}:${focusFileLine.line}` : "(symbol not found via LSP)"
    lines.push(`focus: ${focus} (${loc})`)
  }
  lines.push("top hotspots:")
  for (const h of sorted) {
    const isFocused = !!(focus && (h.kernel === focus || h.symbol === focus))
    lines.push(renderHotspot(h, isFocused))
  }
  const summaryStr = renderSummary(normalized.summary)
  if (summaryStr) lines.push(`summary: ${summaryStr}`)
  // Evidence lives in the written PROFILE_RESULT.json artifact (evidence_kind:"profile").
  lines.push(
    artifactPath
      ? `evidence: PROFILE_RESULT.json written to ${artifactPath} (full report + roofline; evidence_kind:"profile")`
      : `evidence: full report in the tool result metadata (roofline + hotspots + summary)`,
  )
  return lines.join("\n")
}

export const ProfileTool = Tool.define(
  "profile",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    // R0 runtime base: fail-closed privilege gate + approve-once + worktree isolation.
    // Shared across debug/profile (one approval-state per session).
    const base = yield* RuntimeBase.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: ProfileParams, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const adapterId = autoSelectAdapterId(args.adapter)

          log.info("profile tool invoked", { adapterId, target: args.target, focus: args.focus })

          // Build adapter registry with the default binary probe.
          const registry = ProfileAdapterRegistry.make()
          const resolution = registry.resolveById(adapterId)
          if (!resolution.available) {
            const meta: ProfileMetadata = {
              adapterId,
              available: false,
              message: resolution.message,
            }
            return {
              title: `profile: ${adapterId} not available`,
              output: resolution.message,
              metadata: meta,
            }
          }

          const adapter = resolution.adapter
          const sessionKey = `profile:${ctx.sessionID}:${adapterId}`

          // Run the whole profiling operation inside an isolated worktree (R0 withIsolation):
          // the profiled program executes there and side effects are contained + auto-cleaned.
          // The evidence artifact is written to the MAIN tree (instance.directory) so it
          // survives worktree teardown and stays referenceable as PROFILE_RESULT.json.
          return yield* base
            .withIsolation({ name: `profile-${adapterId}` }, (workdir) =>
              Effect.gen(function* () {
                // R0 gate: privilege fail-closed FIRST, then approve-once-per-session.
                // Adapter-declared privileges (gpu_performance_counter / perf_event_paranoid /
                // rocm_profiling) are enforced here — no silent degradation, no elevation.
                yield* base.gate({
                  sessionKey,
                  privileges: adapter.privileges,
                  requestApproval: () =>
                    ctx.ask({
                      permission: "execute",
                      patterns: [args.target],
                      always: [],
                      metadata: { adapter: adapterId, target: args.target, isolated: workdir },
                    }),
                })

                const target: PAP.ProfileTarget = {
                  command: args.target,
                  cwd: workdir,
                  focus: args.focus,
                  domain: args.domain as PAP.Domain | undefined,
                  metrics: args.metrics,
                }

                // Delegate the full collect→parse→normalize→roofline→artifact(+diff)
                // pipeline to ProfileService.run — the single writer of PROFILE_RESULT.json.
                const runResult = yield* Effect.tryPromise({
                  try: () =>
                    ProfileService.run(adapter, target, {
                      artifactDir: instance.directory,
                      ...(args.compare_to ? { compare_to: args.compare_to } : {}),
                    }),
                  catch: (e) => new Error(`profile run failed: ${String(e)}`),
                })

                const normalized = runResult.profile

                // Focus: resolve symbol name → file:line via LSP and back-fill matching hotspot.
                let focusFileLine: PAP.FileLine | null = null
                if (args.focus) {
                  const resolved = yield* LSPResolve.resolveSymbol({ lsp, symbol: args.focus }).pipe(
                    Effect.catch(() => Effect.succeed({ type: "not_found" as const })),
                  )
                  if (resolved.type === "resolved") {
                    focusFileLine = PAP.fileLineFromCandidate(resolved.candidate)
                    for (const h of normalized.hotspots) {
                      const name = h.kernel ?? h.symbol
                      if (name === args.focus) {
                        ;(h as any).file_line = focusFileLine
                      }
                    }
                  }
                }

                const roofline = ProfileService.roofline(normalized)

                const fullOutput = buildProfileOutput({
                  adapterId,
                  target: args.target,
                  normalized,
                  focus: args.focus,
                  focusFileLine,
                  artifactPath: runResult.artifactPath,
                })
                const budgeted = RuntimeBase.applyOutputBudget(fullOutput, adapter.defaultBudget)

                const topHotspots = [...normalized.hotspots].sort((a, b) => b.self_pct - a.self_pct).slice(0, TOP_N)

                const meta: ProfileMetadata = {
                  adapterId,
                  available: true,
                  domain: normalized.domain,
                  vendor: normalized.vendor,
                  hotspots: topHotspots,
                  summary: normalized.summary,
                  raw_report_ref: normalized.raw_report_ref,
                  truncated: budgeted.truncated,
                  focus: args.focus ?? null,
                  focusFileLine,
                  artifactPath: runResult.artifactPath,
                  roofline,
                  ...(runResult.diff ? { diff: runResult.diff } : {}),
                }

                return {
                  title: `profile: ${adapterId} on ${args.target}`,
                  output: budgeted.inline,
                  metadata: meta,
                }
              }),
            )
            .pipe(
              // Fail-closed privilege gate + any collect/parse failure → graceful,
              // model-readable error (never a Die). UnsatisfiedPrivilegeError is flagged
              // so the caller can distinguish "missing GPU/perf/ROCm privilege" from a crash.
              Effect.catch((err) =>
                Effect.succeed(
                  err instanceof RuntimeBase.UnsatisfiedPrivilegeError
                    ? {
                        title: `profile: ${adapterId} privilege unavailable`,
                        output: err.message,
                        metadata: {
                          adapterId,
                          available: false,
                          privilege_blocked: true,
                          message: err.message,
                        } as ProfileMetadata,
                      }
                    : {
                        title: `profile: ${adapterId} failed`,
                        output: err instanceof Error ? err.message : String(err),
                        metadata: { adapterId, available: false, message: String(err) } as ProfileMetadata,
                      },
                ),
              ),
            )
        }),
    }
  }),
)
