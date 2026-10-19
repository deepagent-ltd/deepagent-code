import type { IMFacadeStatus } from "@/utils/im-client"
import type { IMEntitlementSchema } from "@deepagent-code/core/im/entitlement.schema"

// A connection is evidence of access, not of its duration. In particular, a
// missing date (and the activation quote's date) never means lifetime access.
export type IMEntitlementObservation =
  | { state: "unknown"; serviceConfigured: boolean }
  | { state: "inactive" }
  | {
      state: "active" | "expired" | "revoked" | "pending"
      expiresAt?: number | null
      lifetime?: boolean | null
      planID?: string | null
      authoritative?: boolean
    }

export type IMEntitlementStatus = Pick<IMFacadeStatus, "service" | "facade" | "blocked">

export function observeIMEntitlement(
  status: IMEntitlementStatus | undefined,
  activated = false,
  authority?: IMEntitlementSchema.Observation,
): IMEntitlementObservation {
  if (
    authority?.state === "known" &&
    !status?.service?.reconnectRequired &&
    status?.service?.url === authority.entitlement.realm
  ) {
    const value = authority.entitlement
    return {
      state: value.state,
      expiresAt: value.validityKnown ? value.expiresAt : undefined,
      lifetime: value.validityKnown ? value.lifetime : undefined,
      planID: value.planID,
      authoritative: true,
    }
  }
  if (authority)
    return status?.blocked?.code === "im_activation_required"
      ? { state: "inactive" }
      : { state: "unknown", serviceConfigured: !!status?.service?.url }
  if (activated) return { state: "active" }
  if (!status?.service?.url || status.service.reconnectRequired)
    return { state: "unknown", serviceConfigured: !!status?.service?.url }
  if (status.facade === "active") return { state: "active" }
  if (status?.blocked?.code === "im_activation_required") return { state: "inactive" }
  return { state: "unknown", serviceConfigured: !!status?.service?.url }
}

export function imEntitlementState(observation: IMEntitlementObservation, now = Date.now()) {
  if (observation.state !== "active") return observation.state
  if (observation.authoritative) return observation.state
  const expiresAt = imEntitlementExpiry(observation)
  if (expiresAt !== undefined && expiresAt <= now) return "expired"
  return "active"
}

export function imEntitlementExpiry(observation: IMEntitlementObservation) {
  const value = "expiresAt" in observation ? observation.expiresAt : undefined
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000
    ? value
    : undefined
}
