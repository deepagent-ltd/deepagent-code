export * as ContextFederationRollout from "./rollout"

import { Hash } from "../util/hash"

export type Requested = {
  readonly contextFederationShadow: boolean
  readonly locationIndexesV2Shadow: boolean
  readonly contextProjectionV2: boolean
  readonly contextQueryToolsV2: boolean
  readonly coreV2ExecutionOwner: boolean
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

export function projectBucket(projectScopeKey: string): number {
  return Number.parseInt(Hash.sha256(`context-federation-rollout/v1:${projectScopeKey}`).slice(0, 8), 16) % 100
}

export function resolveProject(decision: Decision, projectScopeKey: string, policy: ProjectPolicy): ProjectDecision {
  const percentage = Number.isFinite(policy.percentage) ? Math.max(0, Math.min(100, policy.percentage)) : 0
  const bucket = projectBucket(projectScopeKey)
  const selected = policy.stage === "all" ||
    (policy.stage === "internal" && policy.internalProjectScopeKeys.includes(projectScopeKey)) ||
    (policy.stage === "percentage" &&
      (policy.internalProjectScopeKeys.includes(projectScopeKey) || bucket < percentage))
  const disableModelOwners = policy.killSwitch || !selected
  const reason: BlockReason = policy.killSwitch
    ? "context_federation_kill_switch"
    : "project_rollout_not_selected"
  const blocked = disableModelOwners
    ? (["contextProjectionV2", "contextQueryToolsV2", "coreV2ExecutionOwner"] as const).reduce(
        (result, stage) => decision.enabled[stage]
          ? { ...result, [stage]: [...(decision.blocked[stage] ?? []), reason] }
          : result,
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
