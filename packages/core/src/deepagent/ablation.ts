import type { AgentMode } from "./mode"

// V3 ablation regression gate (docs/30 §7): the executable form of the first-class rule
// "the agent system must never drag down the model". Compares GEN (raw model, no DeepAgent),
// HIGH (capability, zero durable knowledge) and MAX (with durable knowledge) on a held-out
// task set. A knowledge snapshot may NOT ship if MAX regresses vs HIGH on any task.
//
// The per-(group,task) metric runner is injected, so the gate is testable without a live
// model and can be wired to the real eval harness later.

export type AblationGroup = Extract<AgentMode, "general" | "high" | "max">

// metric: higher is better (e.g. pass rate, correctness, gflops). Deterministic per call.
export type AblationRunner = (group: AblationGroup, task: string) => number

export type PerTask = {
  readonly task: string
  readonly gen: number
  readonly high: number
  readonly max: number
  readonly deltaMaxHigh: number
  readonly deltaMaxGen: number
}

export type AblationReport = {
  readonly perTask: readonly PerTask[]
  readonly perGroup: { readonly gen: number; readonly high: number; readonly max: number }
  readonly snapshotId: string
}

export type AblationVerdict = {
  readonly pass: boolean
  // tasks where MAX < HIGH - tolerance: the misleading-knowledge surface to fix/demote.
  readonly offenders: readonly string[]
  readonly tolerance: number
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

export const run = (
  taskSet: readonly string[],
  snapshotId: string,
  runner: AblationRunner,
  repeats = 1,
): AblationReport => {
  const sample = (group: AblationGroup, task: string): number => {
    const vals: number[] = []
    for (let i = 0; i < Math.max(1, repeats); i++) vals.push(runner(group, task))
    return mean(vals)
  }
  const perTask: PerTask[] = taskSet.map((task) => {
    const gen = sample("general", task)
    const high = sample("high", task)
    const max = sample("max", task)
    return { task, gen, high, max, deltaMaxHigh: max - high, deltaMaxGen: max - gen }
  })
  return {
    perTask,
    perGroup: {
      gen: mean(perTask.map((t) => t.gen)),
      high: mean(perTask.map((t) => t.high)),
      max: mean(perTask.map((t) => t.max)),
    },
    snapshotId,
  }
}

// PASS iff MAX never regresses vs HIGH beyond tolerance on ANY task. Default tolerance 0:
// knowledge is not allowed to reduce the model's correctness at all.
// P2-I: an empty report is NOT a pass. With no tasks there is no evidence that knowledge does not
// regress the model, so a vacuous `offenders.length === 0` must not green-light a ship. The
// snapshot ship gate (knowledge-gate.ts) already refuses empty held-out sets upstream; this guard
// makes the primitive itself fail-closed so a direct caller cannot be misled.
export const gate = (report: AblationReport, tolerance = 0): AblationVerdict => {
  if (report.perTask.length === 0) return { pass: false, offenders: [], tolerance }
  const offenders = report.perTask.filter((t) => t.deltaMaxHigh < -tolerance).map((t) => t.task)
  return { pass: offenders.length === 0, offenders, tolerance }
}

export const formatManifest = (report: AblationReport, verdict: AblationVerdict): Record<string, unknown> => ({
  schema_version: "ablation_regression_gate.v1",
  snapshot_id: report.snapshotId,
  created_at: new Date().toISOString(),
  per_group: report.perGroup,
  per_task: report.perTask,
  verdict: {
    pass: verdict.pass,
    tolerance: verdict.tolerance,
    offenders: verdict.offenders,
    rule: "MAX (with knowledge) must not regress vs HIGH (zero durable knowledge) on any held-out task",
  },
})
