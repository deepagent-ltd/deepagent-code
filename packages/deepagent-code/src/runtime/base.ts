import { Context, Effect, Layer } from "effect"
import path from "path"
import { Worktree } from "@/worktree"
import { InstanceState } from "@/effect/instance-state"
import { which } from "@deepagent-code/core/util/which"
import * as Log from "@deepagent-code/core/util/log"

const log = Log.create({ service: "runtime.base" })

/**
 * R0 (S1-v3.5): the runtime common base shared by DAP (debug) and PAP (profile).
 *
 * Both runtime layers are EXECUTION-class (they actually run the user's program),
 * may need PRIVILEGES (GPU counters / perf_event_paranoid / ptrace), produce LARGE
 * structured output, run in WORKTREE ISOLATION, and back-fill SYMBOLS. None of that
 * should be written twice. This module is control-plane only — it never reimplements
 * a debugger or profiler; it gates, isolates, budgets, and routes evidence.
 *
 * The four cross-cutting concerns (§R0 设计):
 *   1. execution approval — once per session, reused for in-session sub-operations.
 *   2. privilege gate — fail-closed; declared per adapter, never silently degraded.
 *   3. worktree isolation — sessions run in a V3.3 (U3) worktree, auto-cleaned.
 *   4. resource budget — timeout + output ceiling; over-limit truncates to artifact.
 */
export namespace RuntimeBase {
  // —— privileges ——————————————————————————————————————————————————————————

  /**
   * A privilege an adapter declares it needs. The gate is FAIL-CLOSED: if the
   * environment does not satisfy a required privilege, the runtime reports
   * "needs X, currently unavailable" and refuses — it never silently degrades
   * and never attempts to elevate.
   */
  export type PrivilegeKind =
    | "gpu_performance_counter" // NVIDIA ncu / nsys GPU counters
    | "perf_event_paranoid" // Linux perf_event_paranoid <= required level
    | "ptrace" // GDB / lldb attach via ptrace_scope
    | "cap_sys_admin" // some counters require CAP_SYS_ADMIN
    | "rocm_profiling" // AMD rocprof profiling access

  export interface PrivilegeSpec {
    kind: PrivilegeKind
    /** Human-readable note shown when the privilege is missing. */
    reason: string
    /** For perf_event_paranoid: the maximum acceptable value (e.g. 2). */
    maxParanoid?: number
  }

  /** Outcome of checking one privilege against the live environment. */
  export interface PrivilegeCheck {
    kind: PrivilegeKind
    satisfied: boolean
    /** Why it is unsatisfied (only set when satisfied=false). */
    detail?: string
  }

  /**
   * Probes the environment for one privilege. Pure detection — no side effects,
   * no elevation. Probes are injected so tests can simulate any environment and
   * so platform specifics stay out of the gate logic.
   */
  export interface PrivilegeProbe {
    readonly check: (spec: PrivilegeSpec) => Effect.Effect<PrivilegeCheck>
  }

  export class UnsatisfiedPrivilegeError extends Error {
    readonly _tag = "RuntimeUnsatisfiedPrivilegeError"
    readonly checks: PrivilegeCheck[]
    constructor(checks: PrivilegeCheck[]) {
      const missing = checks.filter((c) => !c.satisfied)
      super(
        `Required runtime privilege(s) unavailable: ${missing
          .map((c) => `${c.kind}${c.detail ? ` (${c.detail})` : ""}`)
          .join(", ")}. Not degrading and not elevating — resolve the privilege and retry.`,
      )
      this.checks = checks
    }
  }

  // —— execution approval ————————————————————————————————————————————————————

  /**
   * Tracks which runtime sessions have already been approved, so the FIRST
   * start of a session asks once and every in-session sub-operation (step /
   * continue / inspect / collect) reuses that grant without re-prompting.
   * Keyed by a caller-chosen session key (e.g. a debug/profile session id).
   */
  export interface ApprovalTracker {
    readonly approved: (sessionKey: string) => boolean
    readonly markApproved: (sessionKey: string) => void
  }

  // —— resource budget ————————————————————————————————————————————————————————

  export interface ResourceBudget {
    /** Hard wall-clock ceiling for a single collect/debug operation. */
    timeoutMs: number
    /** Max bytes of output kept inline; the rest spills to an artifact. */
    maxInlineBytes: number
  }

  export const DEFAULT_BUDGET: ResourceBudget = {
    timeoutMs: 120_000,
    maxInlineBytes: 24_000,
  }

  /** Result of applying the output budget: a summary stays inline, the full body spills. */
  export interface BudgetedOutput {
    inline: string
    truncated: boolean
    /** Full byte length before truncation. */
    fullBytes: number
  }

  /**
   * Applies the output budget. Profiler reports can reach hundreds of MB, so the
   * runtime keeps only a head slice inline and signals truncation; the caller
   * writes the full body to an artifact (L5) and surfaces only the summary.
   */
  export const applyOutputBudget = (full: string, budget: ResourceBudget = DEFAULT_BUDGET): BudgetedOutput => {
    const bytes = Buffer.byteLength(full, "utf8")
    if (bytes <= budget.maxInlineBytes) return { inline: full, truncated: false, fullBytes: bytes }
    // Slice on bytes, then decode back to a clean string (drop a possibly split tail char).
    const head = Buffer.from(full, "utf8").subarray(0, budget.maxInlineBytes).toString("utf8")
    return {
      inline: `${head}\n… [truncated: ${bytes} bytes total, full report in artifact]`,
      truncated: true,
      fullBytes: bytes,
    }
  }

  // —— service ————————————————————————————————————————————————————————————————

  export interface Interface {
    /**
     * Gate a runtime EXECUTION operation: approve once per session, then enforce
     * the privilege gate fail-closed. Reuses the approval for in-session
     * sub-operations. `ask` is the tool's `ctx.ask` bridge.
     */
    readonly gate: (input: {
      sessionKey: string
      /** Privileges the chosen adapter declares it needs. */
      privileges: readonly PrivilegeSpec[]
      /** Called only on the FIRST operation of a session; should drive ctx.ask. */
      requestApproval: () => Effect.Effect<void>
    }) => Effect.Effect<void, UnsatisfiedPrivilegeError>

    /**
     * Run a runtime body inside an isolated worktree (V3.3 U3). The worktree is
     * created up-front and safe-removed on completion (clean → removed; dirty →
     * left for inspection). Falls back to the main directory for non-git
     * projects so the runtime still works, logging that isolation was skipped.
     */
    readonly withIsolation: <A, E, R>(
      input: { name?: string },
      body: (workdir: string) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>

    /** Check privileges without approving — used by tools to report capability up-front. */
    readonly checkPrivileges: (privileges: readonly PrivilegeSpec[]) => Effect.Effect<PrivilegeCheck[]>
  }

  export class Service extends Context.Service<Service, Interface>()("@deepagent-code/RuntimeBase") {}

  /** A no-op probe that reports every privilege satisfied — for tests / unprivileged dev. */
  export const allowAllProbe: PrivilegeProbe = {
    check: (spec) => Effect.succeed({ kind: spec.kind, satisfied: true }),
  }

  /** A probe that reports every privilege unavailable — for fail-closed tests. */
  export const denyAllProbe: PrivilegeProbe = {
    check: (spec) =>
      Effect.succeed({ kind: spec.kind, satisfied: false, detail: spec.reason || "not available in this environment" }),
  }

  /**
   * Build the service from an injected privilege probe. The probe is the single
   * seam for platform detection; the gate logic itself is platform-agnostic.
   */
  export const make = (probe: PrivilegeProbe): Effect.Effect<Interface, never, Worktree.Service> =>
    Effect.gen(function* () {
      const worktree = yield* Worktree.Service
      // Session approval state lives for the life of this service instance (one per
      // instance/session scope), matching "approve once per session".
      const approvals = new Set<string>()

      const checkPrivileges: Interface["checkPrivileges"] = (privileges) =>
        Effect.forEach(privileges, (spec) => probe.check(spec))

      const gate: Interface["gate"] = (input) =>
        Effect.gen(function* () {
          // 1. Privilege gate first (fail-closed) — never prompt for approval on an
          //    operation we already know cannot run.
          const checks = yield* checkPrivileges(input.privileges)
          const missing = checks.filter((c) => !c.satisfied)
          if (missing.length > 0) {
            return yield* Effect.fail(new UnsatisfiedPrivilegeError(checks))
          }
          // 2. Approval, once per session.
          if (!approvals.has(input.sessionKey)) {
            yield* input.requestApproval()
            approvals.add(input.sessionKey)
          }
        })

      const withIsolation: Interface["withIsolation"] = (input, body) =>
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          // Non-git project → worktrees unsupported; run in the main dir but say so.
          if (ctx.project.vcs !== "git") {
            log.warn("runtime isolation skipped (non-git project); running in main directory")
            return yield* body(ctx.directory)
          }
          const info = yield* worktree.create({ name: input.name }).pipe(
            Effect.catch((e) => {
              // Worktree creation failed — degrade to main dir rather than block the
              // runtime entirely, but make the loss of isolation visible.
              log.warn("runtime worktree creation failed; running in main directory", { error: String(e) })
              return Effect.succeed(undefined)
            }),
          )
          if (!info) return yield* body(ctx.directory)
          return yield* body(info.directory).pipe(
            Effect.ensuring(
              // Clean → removed; dirty → kept (force=false) so the user can inspect side effects.
              worktree.safeRemove({ directory: info.directory }).pipe(Effect.catch(() => Effect.void)),
            ),
          )
        })

      return Service.of({ gate, withIsolation, checkPrivileges })
    })

  /**
   * Default platform privilege probe. Detection only — reads procfs / device nodes /
   * env, never mutates state and never elevates. A privilege is `satisfied:true` only
   * on a POSITIVE signal; anything unverifiable stays fail-closed with an accurate reason
   * (so a fully-capable machine can actually pass the gate, but a machine we cannot verify
   * never gets a false green).
   */
  export const platformProbe: PrivilegeProbe = {
    check: (spec) =>
      Effect.gen(function* () {
        switch (spec.kind) {
          case "perf_event_paranoid": {
            const value = yield* readParanoid
            if (value === undefined)
              return { kind: spec.kind, satisfied: false, detail: "perf_event_paranoid unreadable" }
            const max = spec.maxParanoid ?? 2
            return value <= max
              ? { kind: spec.kind, satisfied: true }
              : { kind: spec.kind, satisfied: false, detail: `perf_event_paranoid=${value} > ${max}` }
          }
          case "gpu_performance_counter": {
            // Positive signal: an NVIDIA device node or the nvidia-smi tool is present.
            const ok = (yield* anyPathExists(["/dev/nvidiactl", "/dev/nvidia0"])) || which("nvidia-smi") !== null
            return ok
              ? { kind: spec.kind, satisfied: true }
              : {
                  kind: spec.kind,
                  satisfied: false,
                  detail: "no NVIDIA device node (/dev/nvidia*) or nvidia-smi found; GPU performance counters unavailable",
                }
          }
          case "rocm_profiling": {
            // Positive signal: the AMD KFD device node or a rocm-smi/rocminfo tool.
            const ok =
              (yield* anyPathExists(["/dev/kfd"])) || which("rocm-smi") !== null || which("rocminfo") !== null
            return ok
              ? { kind: spec.kind, satisfied: true }
              : {
                  kind: spec.kind,
                  satisfied: false,
                  detail: "no AMD KFD device node (/dev/kfd) or rocm-smi/rocminfo found; ROCm profiling unavailable",
                }
          }
          case "ptrace": {
            // Linux yama ptrace_scope: 0 = unrestricted, 1 = child-only (still fine for
            // launch-and-attach), 2/3 = admin/none. Absent file (non-Linux/no yama) → ptrace
            // is generally permitted for a launched child, so treat "unreadable" as satisfied.
            const scope = yield* readPtraceScope
            if (scope === undefined) return { kind: spec.kind, satisfied: true }
            return scope <= 1
              ? { kind: spec.kind, satisfied: true }
              : { kind: spec.kind, satisfied: false, detail: `yama ptrace_scope=${scope} restricts attach (need <= 1)` }
          }
          // cap_sys_admin cannot be verified without attempting a privileged op; fail closed.
          default:
            return { kind: spec.kind, satisfied: false, detail: "privilege not verifiable in this environment" }
        }
      }),
  }

  /** True if any of the given paths exists. Pure detection (fs.access), never mutates. */
  const anyPathExists = (paths: readonly string[]) =>
    Effect.promise(async () => {
      const fs = await import("fs/promises")
      for (const p of paths) {
        try {
          await fs.access(p)
          return true
        } catch {
          // not present; keep checking
        }
      }
      return false
    })

  const readPtraceScope = Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: async () => {
        const fs = await import("fs/promises")
        return await fs.readFile("/proc/sys/kernel/yama/ptrace_scope", "utf8")
      },
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (raw === undefined) return undefined
    const n = Number.parseInt(raw.trim(), 10)
    return Number.isNaN(n) ? undefined : n
  })

  const readParanoid = Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: async () => {
        const fs = await import("fs/promises")
        return await fs.readFile(path.join("/proc/sys/kernel", "perf_event_paranoid"), "utf8")
      },
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (raw === undefined) return undefined
    const n = Number.parseInt(raw.trim(), 10)
    return Number.isNaN(n) ? undefined : n
  })

  /** Default layer using the platform probe. */
  export const layer: Layer.Layer<Service, never, Worktree.Service> = Layer.effect(Service, make(platformProbe))

  /** Test layer with an injectable probe (defaults to allow-all). */
  export const testLayer = (probe: PrivilegeProbe = allowAllProbe): Layer.Layer<Service, never, Worktree.Service> =>
    Layer.effect(Service, make(probe))
}
