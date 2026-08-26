/**
 * P1H (S1-v3.7): Profile HTTP handler — PAP profiling routes.
 *
 * Maintains a process-scoped in-memory run store (Map<runId, ProfileRunEntry>).
 * POST /profile/run fires the run asynchronously and returns the runId.
 * GET  /profile/result / hotspots poll the run store and read the artifact.
 * GET  /profile/runs lists recent entries.
 *
 * R0 gate (V3.7 review P0-2 fix): the HTTP path enforces the SAME R0 gate as the
 * profile tool — privilege fail-closed via RuntimeBase.gate BEFORE the run starts.
 * A human hitting /profile/run has already initiated the action, so approval is
 * recorded (not re-prompted) but the privilege probe still hard-blocks unsupported
 * platforms. Each run writes to a runId-scoped artifact dir (P0-3 fix) so historical
 * runs never overwrite each other.
 */
import * as InstanceState from "@/effect/instance-state"
import { ProfileService } from "@/profile/service"
import { ProfileAdapterRegistry } from "@/profile/adapters/index"
import { RuntimeBase } from "@/runtime/base"
import { autoSelectAdapterId } from "@/tool/profile"
import * as Log from "@deepagent-code/core/util/log"
import { Effect, Layer } from "effect"
import fsNode from "fs/promises"
import path from "path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

const log = Log.create({ service: "profile.handler" })

// ── In-memory run store ───────────────────────────────────────────────────────

const MAX_RUN_HISTORY = 20

export interface ProfileRunEntry {
  readonly runId: string
  readonly adapterId: string
  readonly program: string
  status: "running" | "done" | "error"
  artifactPath?: string
  error?: string
  readonly startedAt: number
}

/** Process-scoped run store. Lives as long as the server process. */
const runStore = new Map<string, ProfileRunEntry>()
/** Insertion-order list of runIds (capped at MAX_RUN_HISTORY). */
const runOrder: string[] = []

function storeRun(entry: ProfileRunEntry): void {
  runStore.set(entry.runId, entry)
  runOrder.push(entry.runId)
  // Evict oldest entry when we exceed the cap.
  if (runOrder.length > MAX_RUN_HISTORY) {
    const oldest = runOrder.shift()!
    runStore.delete(oldest)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read and parse PROFILE_RESULT.json from disk. Returns null on any error. */
async function readArtifact(artifactPath: string): Promise<ProfileService.ProfileArtifact | null> {
  try {
    const raw = await fsNode.readFile(artifactPath, "utf8")
    return JSON.parse(raw) as ProfileService.ProfileArtifact
  } catch {
    return null
  }
}

/** Format a PAP.Hotspot into the frontend-friendly shape. */
function formatHotspot(h: {
  symbol?: string | null
  kernel?: string | null
  file_line?: { file: string; line: number } | null
  self_pct: number
  cumul_pct?: number
  calls?: number
  metrics?: Record<string, unknown>
}) {
  const name = h.kernel ?? h.symbol ?? "(unknown)"
  const fileLine = h.file_line ? `${h.file_line.file}:${h.file_line.line}` : ""
  const selfPct = h.self_pct
  const cumulPct = typeof h.cumul_pct === "number" ? h.cumul_pct : selfPct
  const calls = typeof h.calls === "number" ? h.calls : -1
  return { name, fileLine, selfPct, cumulPct, calls }
}

// ── Handler group ─────────────────────────────────────────────────────────────

export const profileHandlers = HttpApiBuilder.group(InstanceHttpApi, "profile", (handlers) =>
  Effect.gen(function* () {
    const base = yield* RuntimeBase.Service

    // ── run ──────────────────────────────────────────────────────────────────
    const run = Effect.fn("ProfileHttpApi.run")(function* (ctx: {
      payload: {
        program: string
        profiler?: string | undefined
        args?: readonly string[] | undefined
        cwd?: string | undefined
      }
    }) {
      const instance = yield* InstanceState.context
      const { program, profiler, args, cwd } = ctx.payload

      const adapterId = autoSelectAdapterId(profiler)
      // Use Node.js crypto for a collision-safe id without adding a dependency.
      const runId = crypto.randomUUID()

      log.info("profile run start", { runId, adapterId, program })

      const entry: ProfileRunEntry = {
        runId,
        adapterId,
        program,
        status: "running",
        startedAt: Date.now(),
      }
      storeRun(entry)

      const registry = ProfileAdapterRegistry.make()
      const resolution = registry.resolveById(adapterId)

      if (!resolution.available) {
        entry.status = "error"
        entry.error = resolution.message
        log.warn("profile adapter not available", { runId, adapterId, message: resolution.message })
        return { runId, status: "error" as const, error: resolution.message }
      }

      const adapter = resolution.adapter

      // V3.7 review P0-2: enforce the R0 privilege gate BEFORE running. Fail-closed:
      // if the adapter's declared privileges (gpu counters / perf_event_paranoid / rocm)
      // are not satisfied on this platform, reject rather than silently degrade. A human
      // initiating the run via HTTP counts as approval (recorded, not re-prompted).
      const gateError = yield* base
        .gate({
          sessionKey: `profile-http:${runId}`,
          privileges: adapter.privileges,
          requestApproval: () => Effect.void,
        })
        .pipe(
          Effect.as<string | undefined>(undefined),
          Effect.catch((e) => Effect.succeed(`privilege gate failed: ${String(e)}`)),
        )
      if (gateError) {
        entry.status = "error"
        entry.error = gateError
        log.warn("profile privilege gate failed", { runId, adapterId, error: gateError })
        return { runId, status: "error" as const, error: gateError }
      }

      const resolvedCwd = cwd ?? instance.directory
      // V3.7 review P1-6: pass args structurally so the adapter can build argv
      // correctly (program + args must NOT be concatenated into one token).
      const structuredArgs: string[] | undefined = args && args.length > 0 ? args.slice() : undefined
      const target = {
        command: program,
        args: structuredArgs,
        cwd: resolvedCwd,
        focus: undefined,
        domain: undefined,
        metrics: undefined,
      }

      // V3.7 review P0-3: write to a runId-scoped dir so historical runs are not
      // overwritten by a shared PROFILE_RESULT.json.
      const artifactDir = path.join(instance.directory, ".deepagent", "profiles", runId)

      // Start async run; handler returns immediately.
      void ProfileService.run(adapter, target, { artifactDir })
        .then((result) => {
          entry.status = "done"
          entry.artifactPath = result.artifactPath
          log.info("profile run done", { runId, artifactPath: result.artifactPath })
        })
        .catch((err: unknown) => {
          entry.status = "error"
          entry.error = err instanceof Error ? err.message : String(err)
          log.warn("profile run failed", { runId, error: entry.error })
        })

      return { runId, status: "running" as const }
    })

    // ── result ────────────────────────────────────────────────────────────────
    const result = Effect.fn("ProfileHttpApi.result")(function* (ctx: {
      query: { runId: string }
    }) {
      const entry = runStore.get(ctx.query.runId)
      if (!entry) {
        return { status: "error" as const, error: "runId not found" }
      }
      if (entry.status === "running") {
        return { status: "running" as const }
      }
      if (entry.status === "error") {
        return { status: "error" as const, error: entry.error ?? "unknown error" }
      }
      // Done — read and return the artifact. Use Effect.promise so errors become
      // defects (no error channel) — matches the handler's expected error type.
      if (!entry.artifactPath) {
        return { status: "error" as const, error: "artifact path missing" }
      }
      const artifact = yield* Effect.promise(() => readArtifact(entry.artifactPath!))
      if (!artifact) {
        return { status: "error" as const, error: "artifact unreadable" }
      }
      return { status: "done" as const, ...artifact }
    })

    // ── hotspots ──────────────────────────────────────────────────────────────
    const hotspots = Effect.fn("ProfileHttpApi.hotspots")(function* (ctx: {
      query: { runId: string; limit?: number | undefined }
    }) {
      const entry = runStore.get(ctx.query.runId)
      if (!entry || entry.status !== "done" || !entry.artifactPath) return []

      const artifact = yield* Effect.promise(() => readArtifact(entry.artifactPath!))
      if (!artifact) return []

      const limit = ctx.query.limit ?? 10
      const sorted = [...artifact.profile.hotspots]
        .sort((a, b) => b.self_pct - a.self_pct)
        .slice(0, limit)
      return sorted.map(formatHotspot)
    })

    // ── runs ──────────────────────────────────────────────────────────────────
    const runs = Effect.fn("ProfileHttpApi.runs")(function* () {
      // Return newest first.
      const recent = [...runOrder].reverse().slice(0, MAX_RUN_HISTORY)
      return recent.map((id) => {
        const e = runStore.get(id)!
        return {
          runId: e.runId,
          status: e.status as "running" | "done" | "error",
          ...(e.artifactPath ? { artifactPath: e.artifactPath } : {}),
          ...(e.error ? { error: e.error } : {}),
        }
      })
    })

    return handlers
      .handle("run", run)
      .handle("result", result)
      .handle("hotspots", hotspots)
      .handle("runs", runs)
  }),
).pipe(Layer.provide(RuntimeBase.layer))
