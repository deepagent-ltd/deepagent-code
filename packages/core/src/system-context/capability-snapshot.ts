export * as CapabilitySnapshot from "./capability-snapshot"

import { contentDigest } from "../contract/digest"
import type { PreparedCapabilitySnapshotRef } from "../contract/prepared-turn"
import {
  capabilityCatalogDigest,
  sortManifests,
  type CapabilityManifest,
} from "./capability-manifest"
import {
  capabilityCatalog,
  capabilityCatalogDigestValue,
  capabilityCatalogSnapshotId,
} from "./capability-catalog"

// C4-08 — bind the catalog/load snapshot into the Context Epoch / PreparedProviderTurn
// on the CAPABILITY side (design §7.5: "Context Epoch 记录目录 snapshot 和 loaded
// hashes；compaction 后恢复加载事实，不必把所有正文永久放入 system prefix；权限、
// runtime 或 manifest 变化创建新 Context Epoch"). session/ is READ-ONLY here, so this
// module PRODUCES the snapshot record and the FROZEN PreparedCapabilitySnapshotRef;
// the runner attaches it to PreparedProviderTurn.capabilitySnapshot (the session-side
// wiring item is reported, not edited).
//
// The snapshot is deterministic: it is a pure function of the catalog + the loaded
// body hashes + the active domain pack, so a re-dispatch re-derives the same bytes.
// Any catalog/body/domain-pack drift produces a DIFFERENT snapshot digest, which is
// exactly the "new Context Epoch" trigger. Persisted receipts (the kernel's receipt
// store, later `session_capability_load` rows) are the durable fact: a compaction /
// restart can rebuild the same snapshot from the receipts + catalog, without keeping
// every procedure body in the system prefix.

/** Snapshot schema version (design §7.5 durable Context Epoch content). */
export const CapabilityLoadSnapshotVersion = { schema: "capability-load-snapshot.v1" } as const

/** A deterministic catalog + load snapshot record carried into a Context Epoch. */
export interface CapabilityLoadSnapshot {
  readonly schemaVersion: typeof CapabilityLoadSnapshotVersion.schema
  readonly catalogSnapshotId: string
  readonly catalogBodyHash: string
  readonly catalogRuntimeHash: string
  readonly catalogPermissionHash: string
  readonly domainPackSnapshotId?: string
  readonly domainPackBodyHash?: string
  readonly domainPackRuntimeHash?: string
  readonly domainPackPermissionHash?: string
  readonly loadedCapabilities: ReadonlyArray<{ readonly capabilityId: string; readonly bodyHash: string }>
}

/** Deterministic byte-stable digest of a capability/load snapshot. */
export const capabilitySnapshotDigest = (snapshot: CapabilityLoadSnapshot): string => contentDigest(snapshot)

/** The catalog-wide body hash: the whole sorted-manifest catalog digest. */
export const catalogBodyHash = (catalog: ReadonlyArray<CapabilityManifest>): string => capabilityCatalogDigest(catalog)

/** The catalog-wide runtime hash: digest over the sorted set of required runtime features. */
export const catalogRuntimeHash = (catalog: ReadonlyArray<CapabilityManifest>): string =>
  contentDigest([...allRuntimeFeatures(catalog)].toSorted())

/** The catalog-wide permission hash: digest over the sorted set of required permissions. */
export const catalogPermissionHash = (catalog: ReadonlyArray<CapabilityManifest>): string =>
  contentDigest([...allPermissions(catalog)].toSorted())

function allRuntimeFeatures(catalog: ReadonlyArray<CapabilityManifest>): ReadonlySet<string> {
  const features = new Set<string>()
  for (const manifest of catalog) {
    for (const feature of manifest.required_runtime_features) features.add(feature)
  }
  return features
}

function allPermissions(catalog: ReadonlyArray<CapabilityManifest>): ReadonlySet<string> {
  const permissions = new Set<string>()
  for (const manifest of catalog) {
    for (const permission of manifest.required_permissions) permissions.add(permission)
  }
  return permissions
}

/** The catalog snapshot id (deterministic, immutable per catalog). */
export const defaultCatalogSnapshotId = (): string => capabilityCatalogSnapshotId

/**
 * Build a snapshot record for a catalog + the set of loaded capability bodies (id +
 * bodyHash) + an optional active domain pack. Pure and deterministic: same inputs
 * always produce the identical snapshot => the identical digest, which is what the
 * Context Epoch uses as its identity.
 */
export function buildCapabilityLoadSnapshot(input: {
  readonly catalog?: ReadonlyArray<CapabilityManifest>
  readonly loadedCapabilities?: ReadonlyArray<{ readonly capabilityId: string; readonly bodyHash: string }>
  readonly domainPack?: {
    readonly snapshotId: string
    readonly bodyHash: string
    readonly runtimeHash: string
    readonly permissionHash: string
  }
  readonly snapshotId?: string
}): CapabilityLoadSnapshot {
  const catalog = sortManifests(input.catalog ?? capabilityCatalog)
  const loaded = input.loadedCapabilities ?? []
  const domainPack = input.domainPack
  return {
    schemaVersion: CapabilityLoadSnapshotVersion.schema,
    catalogSnapshotId: input.snapshotId ?? capabilityCatalogSnapshotId,
    catalogBodyHash: catalogBodyHash(catalog),
    catalogRuntimeHash: catalogRuntimeHash(catalog),
    catalogPermissionHash: catalogPermissionHash(catalog),
    ...(domainPack
      ? {
          domainPackSnapshotId: domainPack.snapshotId,
          domainPackBodyHash: domainPack.bodyHash,
          domainPackRuntimeHash: domainPack.runtimeHash,
          domainPackPermissionHash: domainPack.permissionHash,
        }
      : {}),
    loadedCapabilities: [...loaded].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId)),
  }
}

/**
 * Rebuild a snapshot from the persisted load receipts + catalog (compaction / restart
 * recovery, design §7.5). Receipts carry the durable capabilityId + bodyHash facts;
 * this re-derives the SAME snapshot digest that was recorded before the restart, so
 * the Context Epoch can be restored without keeping every procedure body in the
 * system prefix. `receipts` accepts `{ capabilityId, bodyHash }` — the shape the
 * kernel's `recordedCapabilityLoads()` yields and the durable `session_capability_load`
 * rows carry.
 */
export function rebuildSnapshotFromReceipts(
  receipts: ReadonlyArray<{ readonly capabilityId: string; readonly bodyHash: string }>,
  catalog?: ReadonlyArray<CapabilityManifest>,
): CapabilityLoadSnapshot {
  return buildCapabilityLoadSnapshot({ catalog, loadedCapabilities: receipts })
}

/**
 * The frozen PreparedCapabilitySnapshotRef (design §4.1 steps 5 & 8) carried on
 * PreparedProviderTurn.capabilitySnapshot. Produced on the capability side from the
 * same snapshot record so the attempt identity is exactly the epoch identity.
 */
export function buildPreparedCapabilitySnapshotRef(snapshot: CapabilityLoadSnapshot): PreparedCapabilitySnapshotRef {
  return {
    catalogSnapshotId: snapshot.catalogSnapshotId,
    catalogBodyHash: snapshot.catalogBodyHash,
    catalogRuntimeHash: snapshot.catalogRuntimeHash,
    catalogPermissionHash: snapshot.catalogPermissionHash,
    ...(snapshot.domainPackSnapshotId !== undefined &&
    snapshot.domainPackBodyHash !== undefined &&
    snapshot.domainPackRuntimeHash !== undefined &&
    snapshot.domainPackPermissionHash !== undefined
      ? {
          domainPackSnapshotId: snapshot.domainPackSnapshotId,
          domainPackBodyHash: snapshot.domainPackBodyHash,
          domainPackRuntimeHash: snapshot.domainPackRuntimeHash,
          domainPackPermissionHash: snapshot.domainPackPermissionHash,
        }
      : {}),
    loadedCapabilities: [...snapshot.loadedCapabilities],
  }
}

/**
 * One-shot builder for the default catalog with the currently loaded bodies (as
 * recorded by the kernel's receipt store). Used by the runner at prepare time to
 * produce the capability snapshot ref for the PreparedProviderTurn.
 */
export const capabilitySnapshotRefFor = (
  loadedCapabilities: ReadonlyArray<{ readonly capabilityId: string; readonly bodyHash: string }>,
): PreparedCapabilitySnapshotRef =>
  buildPreparedCapabilitySnapshotRef(buildCapabilityLoadSnapshot({ loadedCapabilities }))

/** The default catalog's immutable snapshot id (exported for the runner). */
export const defaultCatalogDigestValue = capabilityCatalogDigestValue
