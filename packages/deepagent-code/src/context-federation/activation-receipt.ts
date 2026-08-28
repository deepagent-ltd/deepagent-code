export * as ContextActivationReceipt from "./activation-receipt"

import { ContextFederationRollout } from "@deepagent-code/core/context-federation/rollout"
import { CanonicalJson } from "@deepagent-code/core/util/canonical-json"
import { Hash } from "@deepagent-code/core/util/hash"

export type Capability = "context_projection_v2" | "context_query_tools_v2"

export type RuntimeFallbackReason =
  | "context_selection_unavailable"
  | "context_projection_empty"
  | "provider_attempt_prepare_failed"
  | "context_tools_suppressed"

export type FallbackReason = ContextFederationRollout.BlockReason | RuntimeFallbackReason

export type Receipt = {
  readonly schemaVersion: 1
  readonly recordedAt: number
  readonly readinessAgeMs: number
  readonly readinessExpiresInMs: number
  readonly outcome: "active" | "shadow_only" | "fallback" | "not_requested"
  readonly enabledCapabilities: readonly Capability[]
  readonly fallbackReasons: readonly FallbackReason[]
  readonly decision: ContextFederationRollout.Decision
  readonly selection?: {
    readonly selectionId: string
    readonly projectionHash: string
  }
}

export type ProviderDispatchGate = {
  readonly allowed: boolean
  readonly reason?: "readiness_expired" | "projection_not_enabled" | "tools_not_enabled"
}

const runtimeFallbackReasons = new Set<RuntimeFallbackReason>([
  "context_selection_unavailable",
  "context_projection_empty",
  "provider_attempt_prepare_failed",
  "context_tools_suppressed",
])

export function closeModelFacingOwners(
  decision: ContextFederationRollout.ProjectDecision,
): ContextFederationRollout.ProjectDecision
export function closeModelFacingOwners(decision: ContextFederationRollout.Decision): ContextFederationRollout.Decision
export function closeModelFacingOwners(decision: ContextFederationRollout.Decision): ContextFederationRollout.Decision {
  const reason = "data_readiness_expired" as const
  const modelFacingOwners = ["contextProjectionV2", "contextQueryToolsV2", "coreV2ExecutionOwner"] as const
  return {
    ...decision,
    enabled: {
      ...decision.enabled,
      contextProjectionV2: false,
      contextQueryToolsV2: false,
      coreV2ExecutionOwner: false,
    },
    blocked: modelFacingOwners.reduce(
      (acc, stage) =>
        decision.enabled[stage] ? { ...acc, [stage]: [...(decision.blocked[stage] ?? []), reason] } : acc,
      decision.blocked,
    ),
  }
}

/**
 * Re-check model-facing federation capabilities immediately before provider dispatch.
 * The readiness snapshot is intentionally evaluated with an explicit timestamp so the
 * exact expiry boundary is deterministic and cannot be treated as active by a stale turn.
 */
export function providerDispatchGate(input: {
  readonly readiness: ContextFederationRollout.DerivedContextDataReadiness
  readonly decision: ContextFederationRollout.Decision
  readonly projectionEnabled: boolean
  readonly toolsEnabled: boolean
  readonly now: number
}): ProviderDispatchGate {
  if (
    input.readiness.expiresAt <= input.now &&
    (input.projectionEnabled || input.toolsEnabled || input.decision.enabled.coreV2ExecutionOwner)
  ) {
    return { allowed: false, reason: "readiness_expired" }
  }
  if (input.projectionEnabled && !input.decision.enabled.contextProjectionV2) {
    return { allowed: false, reason: "projection_not_enabled" }
  }
  if (input.toolsEnabled && !input.decision.enabled.contextQueryToolsV2) {
    return { allowed: false, reason: "tools_not_enabled" }
  }
  return { allowed: true }
}

export function make(input: {
  readonly readiness: ContextFederationRollout.DerivedContextDataReadiness
  readonly decision: ContextFederationRollout.Decision
  readonly recordedAt: number
  readonly projectionEnabled: boolean
  readonly toolsEnabled: boolean
  readonly fallbackReasons?: readonly RuntimeFallbackReason[]
  readonly selection?: {
    readonly selectionId: string
    readonly projectionHash: string
  }
}): Receipt {
  const readinessExpired = input.readiness.expiresAt <= input.recordedAt
  const decision = readinessExpired ? closeModelFacingOwners(input.decision) : input.decision
  const projectionEnabled = !readinessExpired && input.projectionEnabled && decision.enabled.contextProjectionV2
  const toolsEnabled = !readinessExpired && input.toolsEnabled && decision.enabled.contextQueryToolsV2
  const enabledCapabilities = [
    ...(projectionEnabled ? (["context_projection_v2"] as const) : []),
    ...(toolsEnabled ? (["context_query_tools_v2"] as const) : []),
  ]
  const fallbackReasons = [
    ...new Set([
      ...(decision.blocked.contextProjectionV2 ?? []),
      ...(decision.blocked.contextQueryToolsV2 ?? []),
      ...(input.fallbackReasons ?? []),
    ]),
  ]
  const contextRequested = decision.requested.contextProjectionV2 || decision.requested.contextQueryToolsV2
  const outcome =
    enabledCapabilities.length > 0
      ? ("active" as const)
      : readinessExpired && contextRequested
        ? ("fallback" as const)
        : input.selection && decision.enabled.contextFederationShadow
          ? ("shadow_only" as const)
          : contextRequested
            ? ("fallback" as const)
            : ("not_requested" as const)

  return {
    schemaVersion: 1,
    recordedAt: input.recordedAt,
    readinessAgeMs: Math.max(0, input.recordedAt - input.readiness.observedAt),
    readinessExpiresInMs: input.readiness.expiresAt - input.recordedAt,
    outcome,
    enabledCapabilities,
    fallbackReasons,
    decision,
    ...(input.selection ? { selection: input.selection } : {}),
  }
}

export function fingerprint(input: {
  readonly eligibility: ContextFederationRollout.ProjectDecision
  readonly readiness: ContextFederationRollout.DerivedContextDataReadiness
  readonly activation: Receipt
}) {
  return Hash.sha256(CanonicalJson.stringify(input))
}

export function integrityError(input: {
  readonly eligibility: ContextFederationRollout.ProjectDecision
  readonly readiness: ContextFederationRollout.DerivedContextDataReadiness
  readonly activation: Receipt
  readonly activationFingerprint: string
  readonly selection?: Receipt["selection"]
}) {
  if (
    input.activationFingerprint !==
    fingerprint({ eligibility: input.eligibility, readiness: input.readiness, activation: input.activation })
  ) {
    return "context activation fingerprint mismatch"
  }

  const activation = make({
    readiness: input.readiness,
    decision: ContextFederationRollout.activate(input.eligibility, input.readiness, input.activation.recordedAt),
    recordedAt: input.activation.recordedAt,
    projectionEnabled: input.activation.enabledCapabilities.includes("context_projection_v2"),
    toolsEnabled: input.activation.enabledCapabilities.includes("context_query_tools_v2"),
    fallbackReasons: input.activation.fallbackReasons.filter((reason): reason is RuntimeFallbackReason =>
      runtimeFallbackReasons.has(reason as RuntimeFallbackReason),
    ),
    ...(input.selection ? { selection: input.selection } : {}),
  })
  if (CanonicalJson.stringify(activation) !== CanonicalJson.stringify(input.activation)) {
    return "context activation does not match its eligibility, readiness, capabilities, or selection"
  }

  const fallbackReasons = new Set(input.activation.fallbackReasons)
  if (
    input.activation.decision.enabled.contextProjectionV2 &&
    !input.activation.enabledCapabilities.includes("context_projection_v2") &&
    !["context_selection_unavailable", "context_projection_empty", "provider_attempt_prepare_failed"].some((reason) =>
      fallbackReasons.has(reason as RuntimeFallbackReason),
    )
  ) {
    return "enabled context projection was omitted without a durable fallback reason"
  }
  if (
    input.activation.decision.enabled.contextQueryToolsV2 &&
    !input.activation.enabledCapabilities.includes("context_query_tools_v2") &&
    !fallbackReasons.has("context_tools_suppressed")
  ) {
    return "enabled context query tools were omitted without a durable fallback reason"
  }
}
