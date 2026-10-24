export * as SharedBrowserFileBinding from "./shared-file-binding"

import type { SharedBrowserSchema } from "./shared-schema"
import type { SharedBrowserFileSchema } from "./shared-file-schema"
import { CanonicalJson } from "../util/canonical-json"
import { Hash } from "../util/hash"

export const hash = (value: unknown) => Hash.sha256(CanonicalJson.stringify(value))

/** A reproducible projection, not authority: callers must first establish the actual
 * current SQL and Main resource/lease, then compare this binding at every boundary. */
export function from(resource: SharedBrowserSchema.Resource, lease: SharedBrowserSchema.Lease): SharedBrowserFileSchema.Binding {
  return { kind: "shared-v2", resourceID: resource.resourceID, rootSessionID: resource.rootSessionID,
    mainIncarnation: resource.mainIncarnation, sidecarIncarnation: lease.sidecarIncarnation,
    leaseID: lease.leaseID, leaseEpoch: lease.leaseEpoch, manualEpoch: resource.manualEpoch,
    policyHash: hash(resource.policy), scopeHash: hash(resource.scope) }
}
