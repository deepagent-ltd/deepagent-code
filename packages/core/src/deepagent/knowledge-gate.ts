import * as Ablation from "./ablation"
import type { AblationRunner } from "./ablation"

export * as DeepAgentKnowledgeGate from "./knowledge-gate"

// V3 knowledge-snapshot ship gate (docs/30 §7). The release-path entry point that turns the
// ablation regression rule into a hard gate: a knowledge snapshot may ship to durable/active
// ONLY if MAX (with knowledge) does not regress vs HIGH (zero durable knowledge) on the
// held-out task set. On failure it names the offending tasks and refuses to ship.

export type ShipDecision = {
  readonly snapshotId: string
  readonly ship: boolean
  readonly reason: string
  readonly offenders: readonly string[]
  readonly perGroup: { readonly gen: number; readonly high: number; readonly max: number }
}

export const evaluateSnapshot = (
  snapshotId: string,
  heldOutTasks: readonly string[],
  runner: AblationRunner,
  options: { tolerance?: number; repeats?: number } = {},
): ShipDecision => {
  if (heldOutTasks.length === 0) {
    return {
      snapshotId,
      ship: false,
      reason: "no held-out tasks: cannot prove non-regression",
      offenders: [],
      perGroup: { gen: 0, high: 0, max: 0 },
    }
  }
  const report = Ablation.run(heldOutTasks, snapshotId, runner, options.repeats ?? 1)
  const verdict = Ablation.gate(report, options.tolerance ?? 0)
  return {
    snapshotId,
    ship: verdict.pass,
    reason: verdict.pass
      ? "MAX did not regress vs HIGH on any held-out task"
      : `MAX regressed vs HIGH on ${verdict.offenders.length} task(s); snapshot blocked`,
    offenders: verdict.offenders,
    perGroup: report.perGroup,
  }
}

// Release manifest for the control plane / CI. ship=false MUST block promotion to active.
export const formatGateManifest = (decision: ShipDecision): Record<string, unknown> => ({
  schema_version: "knowledge_snapshot_ship_gate.v1",
  snapshot_id: decision.snapshotId,
  ship: decision.ship,
  reason: decision.reason,
  offenders: decision.offenders,
  per_group: decision.perGroup,
  rule: "knowledge snapshot ships only if MAX never regresses vs HIGH on held-out tasks (docs/30 §7)",
  enforcement: "blocking",
})
