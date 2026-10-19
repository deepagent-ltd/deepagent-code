import type { IMFacadeStatus } from "@/utils/im-client"

// A connection is evidence of access, not of its duration. In particular, a
// missing date (and the activation quote's date) never means lifetime access.
export type IMEntitlementObservation =
  | { state: "unknown"; serviceConfigured: boolean }
  | { state: "inactive" }
  | { state: "active"; expiresAt?: number | null; lifetime?: boolean }

export type IMEntitlementStatus = Pick<IMFacadeStatus, "service" | "facade" | "blocked">

export function observeIMEntitlement(
  status: IMEntitlementStatus | undefined,
  activated = false,
): IMEntitlementObservation {
  if (activated) return { state: "active" }
  if (!status?.service?.url || status.service.reconnectRequired)
    return { state: "unknown", serviceConfigured: !!status?.service?.url }
  if (status.facade === "active") return { state: "active" }
  if (status?.blocked?.code === "im_activation_required") return { state: "inactive" }
  return { state: "unknown", serviceConfigured: !!status?.service?.url }
}

export function imEntitlementState(observation: IMEntitlementObservation, now = Date.now()) {
  if (observation.state !== "active") return observation.state
  const expiresAt = imEntitlementExpiry(observation)
  if (expiresAt !== undefined && expiresAt <= now) return "expired"
  return "active"
}

export function imEntitlementExpiry(observation: IMEntitlementObservation) {
  const value = observation.state === "active" ? observation.expiresAt : undefined
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000
    ? value
    : undefined
}
