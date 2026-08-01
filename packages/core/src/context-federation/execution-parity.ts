export * as ContextFederationExecutionParity from "./execution-parity"

import { Schema } from "effect"

export const Case = Schema.Literals([
  "admission_activity",
  "batched_steer_queue",
  "exact_retry_interrupt",
  "stable_prefix_runtime_tail_cache",
  "tool_registry_permissions_question",
  "attachments_location_agent_model",
  "compaction_overflow_provider_errors_tokens",
  "tool_settlement_cancellation",
  "task_goal_finalizer_im",
  "status_events_telemetry",
  "provider_contract_replay",
])
export type Case = typeof Case.Type

export const EvidenceKind = Schema.Literals([
  "shadow_snapshot",
  "recorded_provider",
  "real_session_replay",
])
export type EvidenceKind = typeof EvidenceKind.Type

export type Observation = {
  readonly case: Case
  readonly legacyRequestHash: string
  readonly coreV2RequestHash: string
  readonly legacyOutcomeHash: string
  readonly coreV2OutcomeHash: string
  readonly evidence: readonly EvidenceKind[]
}

export type Result = {
  readonly verified: boolean
  readonly missing: readonly Case[]
  readonly mismatched: readonly Case[]
  readonly duplicate: readonly Case[]
  readonly missingEvidence: readonly EvidenceKind[]
}

export function evaluate(observations: readonly Observation[]): Result {
  const counts = observations.reduce<Map<Case, number>>(
    (result, observation) => result.set(observation.case, (result.get(observation.case) ?? 0) + 1),
    new Map(),
  )
  const missing = Case.literals.filter((item) => !counts.has(item))
  const duplicate = Case.literals.filter((item) => (counts.get(item) ?? 0) > 1)
  const mismatched = observations
    .filter(
      (observation) =>
        observation.legacyRequestHash !== observation.coreV2RequestHash ||
        observation.legacyOutcomeHash !== observation.coreV2OutcomeHash,
    )
    .map((observation) => observation.case)
    .filter((item, index, items) => items.indexOf(item) === index)
    .toSorted()
  const evidence = new Set(observations.flatMap((observation) => observation.evidence))
  const missingEvidence = EvidenceKind.literals.filter((item) => !evidence.has(item))
  return {
    verified:
      missing.length === 0 &&
      duplicate.length === 0 &&
      mismatched.length === 0 &&
      missingEvidence.length === 0,
    missing,
    mismatched,
    duplicate,
    missingEvidence,
  }
}
