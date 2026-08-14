export * as ContextFederationRollout from "./rollout"

import { Hash } from "../util/hash"
import type { ProjectionSnapshotRevision } from "./reference"

export type Requested = {
  readonly contextFederationShadow: boolean
  readonly locationIndexesV2Shadow: boolean
  readonly contextProjectionV2: boolean
  readonly contextQueryToolsV2: boolean
  readonly coreV2ExecutionOwner: boolean
}

// BUG-008: derived readiness snapshot — always derived from existing identity/index/adapter/storage
// authorities; never writable independently.  Consumers call readinessFromAuthorities() to build it.
export type ReadinessState = "uninitialized" | "building" | "ready" | "degraded" | "blocked"

export type ReadinessReason =
  | "identity_unavailable"
  | "index_building"
  | "index_degraded"
  | "index_unavailable"
  | "journal_unavailable"
  | "storage_unavailable"

export type DerivedContextDataReadiness = {
  /** Stable hash of the authority evidence used to derive this snapshot. */
  readonly revision: string
  /** Overall data-plane state for the owning security namespace / project / location. */
  readonly state: ReadinessState
  /** True when a canonical Project/Location identity row has been registered. */
  readonly identityBound: boolean
  /** True when at least one index incarnation is available for the location. */
  readonly indexAvailable: boolean
  /** True when durable selection/artifact/attempt storage probe succeeded. */
  readonly storageHealthy: boolean
  /** Opaque scope and index evidence used to reconstruct why this state was derived. */
  readonly projectScopeKey?: string
  readonly locationKey?: string
  readonly indexRevision?: ProjectionSnapshotRevision
  readonly indexGeneration?: number
  readonly journalHighWater?: number
  readonly reasons: readonly ReadinessReason[]
  /** Unix ms when this snapshot was derived. */
  readonly observedAt: number
  /** Unix ms after which this snapshot must be re-derived. */
  readonly expiresAt: number
}

/**
 * Minimal safe readiness snapshot — all capabilities available, no TTL.
 * Use only in tests; production code must derive from real authorities.
 */
export const READINESS_READY_STUB: DerivedContextDataReadiness = {
  revision: Hash.sha256("context-readiness-ready-stub-v1"),
  state: "ready",
  identityBound: true,
  indexAvailable: true,
  storageHealthy: true,
  reasons: [],
  observedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
}

export type Evidence = {
  readonly coreV2ParityVerified: boolean
}

export type Stage = keyof Requested
export type BlockReason =
  | "context_federation_shadow_required"
  | "location_indexes_v2_shadow_required"
  | "context_projection_v2_required"
  | "core_v2_parity_required"
  | "project_rollout_not_selected"
  | "context_federation_kill_switch"
  | "data_readiness_identity_missing"
  | "data_readiness_expired"
  | "data_readiness_blocked"

export type Decision = {
  readonly requested: Requested
  readonly enabled: Requested
  readonly blocked: Readonly<Partial<Record<Stage, readonly BlockReason[]>>>
}

export type ProjectRolloutStage = "shadow" | "internal" | "percentage" | "all"

export type ProjectPolicy = {
  readonly stage: ProjectRolloutStage
  readonly percentage: number
  readonly internalProjectScopeKeys: readonly string[]
  readonly killSwitch: boolean
}

export type ProjectDecision = Decision & {
  readonly project: {
    readonly projectScopeKey: string
    readonly stage: ProjectRolloutStage
    readonly bucket: number
    readonly selected: boolean
    readonly killSwitch: boolean
  }
}

export type RollbackSnapshot = {
  readonly admissionIds: readonly string[]
  readonly messageIds: readonly string[]
  readonly durableAssetIds: readonly string[]
  readonly attempts: readonly {
    readonly attemptId: string
    readonly state: string
  }[]
}

export type RollbackRehearsal = {
  readonly passed: boolean
  readonly violations: readonly string[]
}

export function resolve(requested: Requested, evidence: Evidence): Decision {
  const contextProjectionReasons = [
    ...(!requested.contextFederationShadow ? (["context_federation_shadow_required"] as const) : []),
    ...(!requested.locationIndexesV2Shadow ? (["location_indexes_v2_shadow_required"] as const) : []),
  ]
  const contextProjectionV2 = requested.contextProjectionV2 && contextProjectionReasons.length === 0
  const contextQueryToolsReasons = !contextProjectionV2 ? (["context_projection_v2_required"] as const) : []
  const contextQueryToolsV2 = requested.contextQueryToolsV2 && contextQueryToolsReasons.length === 0
  const coreV2Reasons = [
    ...(!contextProjectionV2 ? (["context_projection_v2_required"] as const) : []),
    ...(!evidence.coreV2ParityVerified ? (["core_v2_parity_required"] as const) : []),
  ]

  return {
    requested,
    enabled: {
      contextFederationShadow: requested.contextFederationShadow,
      locationIndexesV2Shadow: requested.locationIndexesV2Shadow,
      contextProjectionV2,
      contextQueryToolsV2,
      coreV2ExecutionOwner: requested.coreV2ExecutionOwner && coreV2Reasons.length === 0,
    },
    blocked: {
      ...(requested.contextProjectionV2 && contextProjectionReasons.length > 0
        ? { contextProjectionV2: contextProjectionReasons }
        : {}),
      ...(requested.contextQueryToolsV2 && contextQueryToolsReasons.length > 0
        ? { contextQueryToolsV2: contextQueryToolsReasons }
        : {}),
      ...(requested.coreV2ExecutionOwner && coreV2Reasons.length > 0 ? { coreV2ExecutionOwner: coreV2Reasons } : {}),
    },
  }
}

/**
 * BUG-008: combine eligibility + readiness into a final activation decision.
 *
 * Eligibility (flags, cohort, kill-switch) is the existing `resolve()` result.
 * Readiness is derived from real identity/index/adapter/storage authorities.
 *
 * Safety policy (§6.4):
 *   - expired, identity-missing, or blocked readiness → model-facing owners fail closed
 *   - degraded readiness → shadow continues (logs degraded), projection/tools blocked
 *   - ready → use the eligibility decision unchanged
 *
 * NOTE: core V2 execution owner has its own independent parity gate and is never
 * activated by readiness alone — it must also pass `evidence.coreV2ParityVerified`.
 */
export function activate(
  eligibility: Decision,
  readiness: DerivedContextDataReadiness,
  observedAt = Date.now(),
): Decision {
  // The expiry instant is exclusive: once the TTL reaches its boundary, model-facing
  // capabilities must be blocked until a fresh readiness snapshot is derived.
  const expired = observedAt >= readiness.expiresAt
  const identityMissing = !readiness.identityBound

  // Hard safety gates: fail closed for model-facing owners.
  if (expired || identityMissing || readiness.state === "blocked") {
    const reasons: BlockReason[] = expired
      ? ["data_readiness_expired"]
      : identityMissing
        ? ["data_readiness_identity_missing"]
        : ["data_readiness_blocked"]
    const modelFacingOwners = ["contextProjectionV2", "contextQueryToolsV2", "coreV2ExecutionOwner"] as const
    return {
      ...eligibility,
      enabled: {
        ...eligibility.enabled,
        contextProjectionV2: false,
        contextQueryToolsV2: false,
        coreV2ExecutionOwner: false,
      },
      blocked: modelFacingOwners.reduce(
        (acc, stage) =>
          eligibility.enabled[stage] ? { ...acc, [stage]: [...(eligibility.blocked[stage] ?? []), ...reasons] } : acc,
        eligibility.blocked,
      ),
    }
  }

  // Any non-ready data plane keeps shadow diagnostics available but blocks context delivery.
  if (readiness.state !== "ready" || !readiness.indexAvailable || !readiness.storageHealthy) {
    return {
      ...eligibility,
      enabled: {
        ...eligibility.enabled,
        contextProjectionV2: false,
        contextQueryToolsV2: false,
        // coreV2ExecutionOwner governed by its own parity gate — leave unchanged
      },
      blocked: (["contextProjectionV2", "contextQueryToolsV2"] as const).reduce(
        (acc, stage) =>
          eligibility.enabled[stage]
            ? { ...acc, [stage]: [...(eligibility.blocked[stage] ?? []), "data_readiness_blocked"] }
            : acc,
        eligibility.blocked,
      ),
    }
  }

  // Ready: use eligibility as-is.
  return eligibility
}

export function projectBucket(projectScopeKey: string): number {
  return Number.parseInt(Hash.sha256(`context-federation-rollout/v1:${projectScopeKey}`).slice(0, 8), 16) % 100
}

export function resolveProject(decision: Decision, projectScopeKey: string, policy: ProjectPolicy): ProjectDecision {
  const percentage = Number.isFinite(policy.percentage) ? Math.max(0, Math.min(100, policy.percentage)) : 0
  const bucket = projectBucket(projectScopeKey)
  const selected =
    policy.stage === "all" ||
    (policy.stage === "internal" && policy.internalProjectScopeKeys.includes(projectScopeKey)) ||
    (policy.stage === "percentage" &&
      (policy.internalProjectScopeKeys.includes(projectScopeKey) || bucket < percentage))
  const disableModelOwners = policy.killSwitch || !selected
  const reason: BlockReason = policy.killSwitch ? "context_federation_kill_switch" : "project_rollout_not_selected"
  const blocked = disableModelOwners
    ? (["contextProjectionV2", "contextQueryToolsV2", "coreV2ExecutionOwner"] as const).reduce(
        (result, stage) =>
          decision.enabled[stage] ? { ...result, [stage]: [...(decision.blocked[stage] ?? []), reason] } : result,
        decision.blocked,
      )
    : decision.blocked

  return {
    ...decision,
    enabled: disableModelOwners
      ? {
          ...decision.enabled,
          contextProjectionV2: false,
          contextQueryToolsV2: false,
          coreV2ExecutionOwner: false,
        }
      : decision.enabled,
    blocked,
    project: {
      projectScopeKey,
      stage: policy.stage,
      bucket,
      selected,
      killSwitch: policy.killSwitch,
    },
  }
}

export function rehearseRollback(input: {
  readonly enabled: Requested
  readonly before: RollbackSnapshot
  readonly after: RollbackSnapshot
}): RollbackRehearsal {
  const violations = [
    ...(input.enabled.contextProjectionV2 ? ["context_projection_v2_still_enabled"] : []),
    ...(input.enabled.contextQueryToolsV2 ? ["context_query_tools_v2_still_enabled"] : []),
    ...(input.enabled.coreV2ExecutionOwner ? ["core_v2_execution_owner_still_enabled"] : []),
    ...preserved("admission", input.before.admissionIds, input.after.admissionIds),
    ...preserved("message", input.before.messageIds, input.after.messageIds),
    ...preserved("durable_asset", input.before.durableAssetIds, input.after.durableAssetIds),
    ...preserved(
      "provider_attempt",
      input.before.attempts.map((attempt) => attempt.attemptId),
      input.after.attempts.map((attempt) => attempt.attemptId),
    ),
    ...input.before.attempts.flatMap((attempt) => {
      if (attempt.state !== "indeterminate_after_crash") return []
      const after = input.after.attempts.find((candidate) => candidate.attemptId === attempt.attemptId)
      return after?.state === "indeterminate_after_crash" ? [] : [`indeterminate_attempt_changed:${attempt.attemptId}`]
    }),
  ]
  return { passed: violations.length === 0, violations }
}

function preserved(kind: string, before: readonly string[], after: readonly string[]) {
  const retained = new Set(after)
  return before.filter((id) => !retained.has(id)).map((id) => `${kind}_lost:${id}`)
}
