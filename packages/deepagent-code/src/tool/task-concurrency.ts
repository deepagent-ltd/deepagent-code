export * as TaskConcurrency from "./task-concurrency"

import { Effect, Semaphore } from "effect"
import { Orchestration } from "@deepagent-code/core/deepagent/orchestration"

/**
 * §5a — CODE-LAYER concurrency ceiling for `task`-type tool calls.
 *
 * When the primary agent fans out to multiple subagents in a SINGLE assistant message, the AI SDK
 * invokes each `task` tool-call's `execute` concurrently with NO built-in limit. This module is the
 * runtime hard cap: the number of subagents a single parent session runs in parallel is bounded by a
 * per-parent-session semaphore whose width = `resolveCaps(caps).maxConcurrency` (default 4,
 * CONFIGURABLE + lenient — a runaway guard, not a tight leash). The clamp is enforced in CODE, not
 * merely suggested in the prompt, so it holds regardless of what the model tries to do.
 *
 * Two nested gates apply, and BOTH permits must be held, so the stricter (min) wins:
 *   1. per-parent-session gate  — width = orchestration caps.maxConcurrency (spans ALL subagents)
 *   2. per-(session, agentType) — width = that agent's `limits.maxConcurrency` when set (§C.3 limits
 *      consumption). Unset ⇒ no extra gate (lenient: the agent adds no limit of its own).
 * Acquisition order is always session-first then agent-type, uniformly, so no lock cycle forms.
 *
 * Scope note: only `task`-type dispatch routes through here. Ordinary tools (read/edit/bash/…) never
 * touch this limiter and run fully unbounded as before.
 *
 * These are process-local, in-memory registries keyed by session id. Entries are reference-counted
 * and dropped when no holder/waiter remains (same lifecycle as KeyedMutex). A semaphore's width is
 * fixed at creation; if a live session's resolved width changes (e.g. a config edit mid-session)
 * while permits are still held, the existing semaphore is reused for correctness and the new width
 * takes effect once the session drains — acceptable for a lenient runaway guard.
 */

type Entry = { readonly semaphore: Semaphore.Semaphore; readonly width: number; users: number }

const sessionLimiters = new Map<string, Entry>()
const agentLimiters = new Map<string, Entry>()

/** Resolve, borrow (creating if needed), run `effect` holding one permit, then release + gc. */
const withOnePermit = <A, E, R>(
  registry: Map<string, Entry>,
  key: string,
  width: number,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const current = registry.get(key)
    // Reuse a live entry (permits in flight); only mint a fresh semaphore when there is none, or the
    // resolved width changed AND nothing is currently borrowing it.
    const entry =
      current && (current.width === width || current.users > 0)
        ? current
        : { semaphore: Semaphore.makeUnsafe(width), width, users: 0 }
    if (entry !== current) registry.set(key, entry)
    entry.users++
    return entry.semaphore.withPermits(1)(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          entry.users--
          if (entry.users === 0 && registry.get(key) === entry) registry.delete(key)
        }),
      ),
    )
  })

/**
 * Run a `task`-type subagent dispatch under the parent-session concurrency cap (and, when the agent
 * declares one, its own tighter `maxConcurrency`). The effective parallelism is
 * `min(resolveCaps(caps).maxConcurrency, agentMaxConcurrency ?? ∞)`.
 */
export const withTaskSlot = <A, E, R>(input: {
  readonly parentSessionID: string
  readonly subagentType: string
  /** The agent's own `limits.maxConcurrency`, if declared. Unset/<=0 ⇒ no per-agent gate. */
  readonly agentMaxConcurrency?: number
  readonly caps?: Orchestration.OrchestrationCaps
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> => {
  const { maxConcurrency } = Orchestration.resolveCaps(input.caps)
  const agentLimit =
    input.agentMaxConcurrency != null && Number.isFinite(input.agentMaxConcurrency) && input.agentMaxConcurrency > 0
      ? Math.floor(input.agentMaxConcurrency)
      : undefined
  // The per-agent gate is only meaningful when it is at least as strict as the session cap; a looser
  // agent limit would never bind, so skip it (min semantics — never loosen the session cap).
  const inner =
    agentLimit != null
      ? withOnePermit(
          agentLimiters,
          `${input.parentSessionID}:${input.subagentType}`,
          Math.min(agentLimit, maxConcurrency),
          input.effect,
        )
      : input.effect
  return withOnePermit(sessionLimiters, input.parentSessionID, maxConcurrency, inner)
}

/** Test/diagnostic helper: number of live per-session limiter entries. */
export const activeSessionLimiters = (): number => sessionLimiters.size
