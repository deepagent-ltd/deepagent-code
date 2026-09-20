import { flipFlagValueOn } from "./flip-flag"

/**
 * Mechanism beacon — ablation-correctness instrumentation.
 *
 * The ablation matrix is only meaningful if each mechanism's state is OBSERVABLE: "flag is set" is
 * not evidence that the mechanism ran, and "mechanism is off" is not evidence that it stayed out of
 * the way. This module makes both facts explicit in the run log:
 *
 *   [beacon] startup mechanisms=<json>            — resolved on/off + source, emitted once
 *   [beacon] engage mechanism=<name> detail=<...> — emitted on real use (bounded per mechanism)
 *   [beacon] summary mechanisms=<json>            — engagement counts, emitted on drain end/exit
 *
 * Everything goes to stderr with a stable prefix, so the pier adapter's captured transcript
 * (deepagent.txt) carries the evidence next to the trajectory. Counters are process-local.
 */

/** One ablable mechanism: the env key that gates it, the default when unset, and a stable id. */
export type MechanismSpec = {
  readonly id: string
  readonly env: string
  readonly unsetDefault: boolean
  /** Where the mechanism actually acts — printed in the startup beacon for auditability. */
  readonly site: string
}

/** The ablable set. Mirrors the production gates (core RuntimeFeatures + app RuntimeFlags). */
export const MECHANISMS: readonly MechanismSpec[] = [
  {
    id: "context_federation",
    env: "DEEPAGENT_CODE_CONTEXT_FEDERATION_PRODUCTION",
    unsetDefault: true,
    site: "core/session/runner/canonical-turn.ts productionAdaptersEnabled",
  },
  {
    id: "learning",
    env: "DEEPAGENT_DURABLE_LEARNING",
    unsetDefault: true,
    site: "core/deepagent/durable-learning.ts admit",
  },
  {
    id: "learning_ledger",
    env: "DEEPAGENT_CODE_EXPERIMENTAL_CONTEXT_LEDGER",
    unsetDefault: true,
    site: "app runtime-flags -> learning ledger",
  },
  {
    id: "strict_plan_gate",
    env: "DEEPAGENT_CODE_STRICT_PLAN_GATE",
    unsetDefault: true,
    site: "core/system-context plan gate decide + app V2PlanGate",
  },
  {
    id: "event_admission",
    env: "DEEPAGENT_CODE_EVENT_V2_ADMISSION",
    unsetDefault: true,
    site: "core/deepagent/event-admission.ts admit",
  },
  {
    id: "im_single_write",
    env: "DEEPAGENT_CODE_EVENT_V2_IM_SINGLE_WRITE",
    unsetDefault: true,
    site: "core/deepagent/im-single-write.ts",
  },
  {
    id: "v2_execution_owner",
    env: "DEEPAGENT_CODE_CORE_V2_EXECUTION_OWNER",
    unsetDefault: true,
    site: "app session/prompt.ts promptV2 owner fork",
  },
  {
    id: "v2_only",
    env: "DEEPAGENT_CODE_CORE_V2_ONLY",
    unsetDefault: false,
    site: "app coreV2Only profile (hardcoded true in production)",
  },
]

/** Resolved state of one mechanism: the raw env value, the boolean, and where the value came from. */
export type MechanismState = {
  readonly id: string
  readonly env: string
  readonly raw: string | undefined
  readonly enabled: boolean
  /** "env" when the operator set it, "default" when the unset default applied. */
  readonly source: "env" | "default"
  readonly site: string
}

/** Resolve every mechanism. */
export function mechanismStates(env: Readonly<Record<string, string | undefined>> = process.env): MechanismState[] {
  return MECHANISMS.map((spec) => {
    const raw = env[spec.env]
    const defined = raw !== undefined && raw !== ""
    const enabled = flipFlagValueOn(raw, spec.unsetDefault)
    return { id: spec.id, env: spec.env, raw, enabled, source: defined ? "env" : "default", site: spec.site }
  })
}

const counts = new Map<string, number>()
const details = new Map<string, string>()
const MAX_ENGAGE_LOGS = 5
let engagedLogged = 0

/** Emit the resolved mechanism state once at process start. */
export function emitStartupBeacon(env: Readonly<Record<string, string | undefined>> = process.env): void {
  const states = mechanismStates(env)
  const summary = Object.fromEntries(
    states.map((state) => [state.id, `${state.enabled ? "ON" : "OFF"}/${state.source}`]),
  )
  process.stderr.write(`[beacon] startup ${JSON.stringify(summary)}\n`)
}

/**
 * Record that a mechanism actually did work. Proves engagement (not merely enablement): a flag set
 * with zero engagements is a mechanism that never reached the task.
 */
export function recordEngagement(mechanism: string, detail?: string): void {
  counts.set(mechanism, (counts.get(mechanism) ?? 0) + 1)
  if (detail !== undefined) details.set(mechanism, detail)
  if (engagedLogged < MAX_ENGAGE_LOGS) {
    engagedLogged++
    process.stderr.write(`[beacon] engage mechanism=${mechanism}${detail ? ` detail=${detail}` : ""}\n`)
  }
}

/** Emit engagement counts. Called at drain end and on process exit. */
export function emitSummaryBeacon(): void {
  const summary = Object.fromEntries(
    [...counts.entries()].map(([id, count]) => [id, { count, last: details.get(id) ?? null }]),
  )
  process.stderr.write(`[beacon] summary ${JSON.stringify(summary)}\n`)
}

/** Test/inspection accessor. */
export const engagementCounts = (): ReadonlyMap<string, number> => counts
