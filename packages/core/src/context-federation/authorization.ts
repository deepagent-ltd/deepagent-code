export * as ContextAuthorization from "./authorization"

import { Schema } from "effect"
import { Hash } from "../util/hash"
import { GraphKind } from "./contract"
import { ContextRef, LocationKey, ProjectScopeKey, SecurityNamespaceID, type ContextScopeBinding } from "./reference"

export const Sensitivity = Schema.Literals(["public", "source_code", "pii", "secret_adjacent", "secret"])
export type Sensitivity = typeof Sensitivity.Type

export type Principal = {
  readonly securityNamespaceId: SecurityNamespaceID
  readonly principalId: string
  readonly authorizationEpoch: number
  readonly locationKeys: readonly LocationKey[]
  readonly projectScopeKeys: readonly ProjectScopeKey[]
  readonly sessionIds: readonly string[]
  readonly subjectIds: readonly string[]
  readonly allowBuiltin: boolean
}

export type EgressPolicy = {
  readonly policyId: string
  readonly epoch: number
  readonly graphs: readonly (typeof GraphKind.Type)[]
  readonly sensitivities: readonly Sensitivity[]
}

export type DenyReason =
  | "security_namespace_mismatch"
  | "location_scope_denied"
  | "project_scope_denied"
  | "session_scope_denied"
  | "subject_scope_denied"
  | "builtin_scope_denied"
  | "provider_egress_denied"

export type Decision =
  | { readonly allowed: true; readonly authorizationEpoch: number; readonly egressEpoch: number }
  | { readonly allowed: false; readonly reason: DenyReason }

export function authorize(input: {
  readonly ref: ContextRef
  readonly principal: Principal
  readonly egress: EgressPolicy
  readonly sensitivity: Sensitivity
}): Decision {
  const scopeReason = authorizeBinding(input.ref.binding, input.principal)
  if (scopeReason) return { allowed: false, reason: scopeReason }
  if (!input.egress.graphs.includes(input.ref.graph) || !input.egress.sensitivities.includes(input.sensitivity)) {
    return { allowed: false, reason: "provider_egress_denied" }
  }
  return {
    allowed: true,
    authorizationEpoch: input.principal.authorizationEpoch,
    egressEpoch: input.egress.epoch,
  }
}

export function authorizeScope(ref: ContextRef, principal: Principal) {
  const reason = authorizeBinding(ref.binding, principal)
  return reason ? ({ allowed: false, reason } as const) : ({ allowed: true } as const)
}

export function fingerprint(principal: Principal, egress: EgressPolicy) {
  return Hash.sha256(
    JSON.stringify({
      securityNamespaceId: principal.securityNamespaceId,
      principalId: principal.principalId,
      authorizationEpoch: principal.authorizationEpoch,
      locationKeys: principal.locationKeys.toSorted(),
      projectScopeKeys: principal.projectScopeKeys.toSorted(),
      sessionIds: principal.sessionIds.toSorted(),
      subjectIds: principal.subjectIds.toSorted(),
      allowBuiltin: principal.allowBuiltin,
      egress: {
        policyId: egress.policyId,
        epoch: egress.epoch,
        graphs: egress.graphs.toSorted(),
        sensitivities: egress.sensitivities.toSorted(),
      },
    }),
  )
}

function authorizeBinding(binding: ContextScopeBinding, principal: Principal): DenyReason | undefined {
  if (binding.scope === "builtin") return principal.allowBuiltin ? undefined : "builtin_scope_denied"
  if (binding.securityNamespaceId !== principal.securityNamespaceId) return "security_namespace_mismatch"
  if (binding.scope === "location") {
    if (!principal.locationKeys.includes(binding.locationKey)) return "location_scope_denied"
    if (!principal.projectScopeKeys.includes(binding.projectScopeKey)) return "project_scope_denied"
    return
  }
  if (binding.scope === "project") {
    return principal.projectScopeKeys.includes(binding.projectScopeKey) ? undefined : "project_scope_denied"
  }
  if (binding.scope === "session") {
    if (!principal.projectScopeKeys.includes(binding.projectScopeKey)) return "project_scope_denied"
    return principal.sessionIds.includes(binding.sessionId) ? undefined : "session_scope_denied"
  }
  return principal.subjectIds.includes(binding.subjectId) ? undefined : "subject_scope_denied"
}
