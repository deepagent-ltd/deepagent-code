export * as WorkspaceConcurrency from "./workspace-concurrency"

import { Context, Effect, Layer } from "effect"
import { WorkspaceConfig } from "./workspace-config"
import { RateLimiter } from "./rate-limiter"

// V4.0 §E2 — the AGENT-EXECUTION CONCURRENCY gate. A per-workspace in-flight counter that caps how many
// agent runs execute at once in a workspace (default AGENT_EXEC_CONCURRENT_PER_WORKSPACE = 5, overridable
// via WorkspaceConfig.rateLimits.agentExecConcurrent). This is a CONCURRENCY cap, not a windowed rate —
// distinct from the event-publish rate limiter — so it tracks a live count that goes up on `acquire` and
// down on `release` (the caller MUST release when a run finishes, in a finalizer/ensuring).
//
// STATE: a plain in-memory Map<workspaceID, inFlight>. Reads (`depth`/`totalDepth`) are SYNCHRONOUS so a
// dispatcher's queueDepth callback can sample the live count without an Effect round-trip. `acquire` is an
// Effect because it consults WorkspaceConfig for the per-workspace cap; `release` is synchronous.
//
// LAYERING: `core`. Depends only on WorkspaceConfig. This is a reusable PRIMITIVE — it is NOT wired into
// the multi-agent runtime or the event dispatcher here; that integration is owned by the main thread.

export interface AcquireResult {
  // whether this acquire was admitted (in-flight was below the cap) and the counter incremented. When
  // false the counter is UNCHANGED — the caller must not run and must NOT call `release`.
  readonly admitted: boolean
  // the workspace's in-flight depth AFTER this acquire (== prior depth when not admitted).
  readonly depth: number
  // the resolved cap that was applied (config override or the AGENT_EXEC_CONCURRENT_PER_WORKSPACE default).
  readonly cap: number
}

export interface Interface {
  /**
   * §E2 — try to admit one agent run in `workspaceID`. Resolves the cap from
   * WorkspaceConfig.rateLimits.agentExecConcurrent (fallback AGENT_EXEC_CONCURRENT_PER_WORKSPACE); if the
   * current in-flight depth is below the cap it increments and returns `admitted: true`, otherwise it
   * leaves the counter untouched and returns `admitted: false`. The caller releases on run completion.
   */
  readonly acquire: (workspaceID: string) => Effect.Effect<AcquireResult>
  /** Release one in-flight slot for `workspaceID` (floored at 0 — a double-release can't go negative). */
  readonly release: (workspaceID: string) => void
  /** Current in-flight depth for `workspaceID` (synchronous — safe for a dispatcher queueDepth callback). */
  readonly depth: (workspaceID: string) => number
  /** Total in-flight depth across all workspaces (synchronous). */
  readonly totalDepth: () => number
}

export class Service extends Context.Service<Service, Interface>()("@deepagent-code/WorkspaceConcurrency") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* WorkspaceConfig.Service
    // in-flight run count per workspace. A key is absent (== 0) until the first admitted acquire, and is
    // deleted again when it drops back to 0 so idle workspaces don't accrue entries.
    const inFlight = new Map<string, number>()

    const depth: Interface["depth"] = (workspaceID) => inFlight.get(workspaceID) ?? 0

    const totalDepth: Interface["totalDepth"] = () => {
      let total = 0
      for (const n of inFlight.values()) total += n
      return total
    }

    const acquire: Interface["acquire"] = (workspaceID) =>
      Effect.gen(function* () {
        const resolved = yield* config.get(workspaceID)
        const cap = resolved.rateLimits.agentExecConcurrent ?? RateLimiter.AGENT_EXEC_CONCURRENT_PER_WORKSPACE
        const current = inFlight.get(workspaceID) ?? 0
        if (current >= cap) return { admitted: false, depth: current, cap }
        const next = current + 1
        inFlight.set(workspaceID, next)
        return { admitted: true, depth: next, cap }
      })

    const release: Interface["release"] = (workspaceID) => {
      const current = inFlight.get(workspaceID) ?? 0
      const next = current - 1
      if (next <= 0) inFlight.delete(workspaceID)
      else inFlight.set(workspaceID, next)
    }

    return Service.of({ acquire, release, depth, totalDepth })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(WorkspaceConfig.defaultLayer))
