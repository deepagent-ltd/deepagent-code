import { describe, expect, test, beforeEach } from "bun:test"
import { Hash } from "@deepagent-code/core/util/hash"
import {
  buildCapabilityLoadSnapshot,
  buildPreparedCapabilitySnapshotRef,
  capabilitySnapshotDigest,
  rebuildSnapshotFromReceipts,
  defaultCatalogSnapshotId,
} from "@deepagent-code/core/system-context/capability-snapshot"
import { sessionCapabilityLoad, type CapabilityLoadRequest, type CapabilityLoadTurnIdentity } from "@deepagent-code/core/system-context/capability-load-adapter"
import { recordedCapabilityLoads, resetCapabilityLoader } from "@deepagent-code/core/system-context/capability-loader"
import { capabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"

// C4-08 — bind the catalog/load snapshot into the Context Epoch / PreparedProviderTurn
// on the capability side.

const digestOf = (body: string): string => `sha256:${Hash.sha256(body)}`

const IDENTITY: CapabilityLoadTurnIdentity = { sessionId: "session-snap", activityId: "activity-snap", turnId: "turn-snap" }

function loadRequest(capabilityId: string, body: string, catalogSnapshotId = "capability_catalog:test"): CapabilityLoadRequest {
  return {
    capabilityId,
    version: "1.0.0-beta.0",
    bodyHash: digestOf(body),
    runtimeHash: "rt-snap",
    permissionHash: "perm-snap",
    bodyRef: `capability://${capabilityId}@1.0.0-beta.0`,
    body,
    declaredDigest: digestOf(body),
    catalogSnapshotId,
    requiredPermissions: ["read"],
    grantedPermissions: ["read"],
  }
}

beforeEach(() => resetCapabilityLoader())

describe("catalog/load snapshot is deterministic", () => {
  test("the same load derives the same snapshot bytes/digest", () => {
    const loaded = [{ capabilityId: "deepagent.code-read", bodyHash: digestOf("Read body") }]
    const a = buildCapabilityLoadSnapshot({ loadedCapabilities: loaded })
    const b = buildCapabilityLoadSnapshot({ loadedCapabilities: loaded })
    expect(capabilitySnapshotDigest(a)).toBe(capabilitySnapshotDigest(b))
    expect(capabilitySnapshotDigest(a)).toMatch(/^[0-9a-f]{64}$/)
  })

  test("catalog hashes are deterministic and derived from the catalog", () => {
    const a = buildCapabilityLoadSnapshot({})
    const b = buildCapabilityLoadSnapshot({})
    expect(a.catalogBodyHash).toBe(b.catalogBodyHash)
    expect(a.catalogRuntimeHash).toBe(b.catalogRuntimeHash)
    expect(a.catalogPermissionHash).toBe(b.catalogPermissionHash)
    expect(a.catalogSnapshotId).toBe(defaultCatalogSnapshotId())
  })

  test("a loaded-body drift produces a successor (different) snapshot", () => {
    const base = buildCapabilityLoadSnapshot({ loadedCapabilities: [{ capabilityId: "deepagent.code-read", bodyHash: digestOf("Read body") }] })
    const drifted = buildCapabilityLoadSnapshot({ loadedCapabilities: [{ capabilityId: "deepagent.code-read", bodyHash: digestOf("Other body") }] })
    expect(capabilitySnapshotDigest(drifted)).not.toBe(capabilitySnapshotDigest(base))
  })

  test("adding a loaded body produces a successor snapshot", () => {
    const base = buildCapabilityLoadSnapshot({ loadedCapabilities: [{ capabilityId: "deepagent.code-read", bodyHash: digestOf("Read body") }] })
    const added = buildCapabilityLoadSnapshot({
      loadedCapabilities: [
        { capabilityId: "deepagent.code-read", bodyHash: digestOf("Read body") },
        { capabilityId: "deepagent.code-edit", bodyHash: digestOf("Edit body") },
      ],
    })
    expect(capabilitySnapshotDigest(added)).not.toBe(capabilitySnapshotDigest(base))
  })
})

describe("snapshot binds loads via the frozen PreparedCapabilitySnapshotRef", () => {
  test("buildPreparedCapabilitySnapshotRef carries the frozen shape", () => {
    const snapshot = buildCapabilityLoadSnapshot({
      loadedCapabilities: [{ capabilityId: "deepagent.code-read", bodyHash: digestOf("Read body") }],
    })
    const ref = buildPreparedCapabilitySnapshotRef(snapshot)
    expect(ref.catalogSnapshotId).toBe(snapshot.catalogSnapshotId)
    expect(ref.catalogBodyHash).toBe(snapshot.catalogBodyHash)
    expect(ref.catalogRuntimeHash).toBe(snapshot.catalogRuntimeHash)
    expect(ref.catalogPermissionHash).toBe(snapshot.catalogPermissionHash)
    expect(ref.loadedCapabilities).toEqual([{ capabilityId: "deepagent.code-read", bodyHash: digestOf("Read body") }])
  })
})

describe("compaction / restart recovery rebuilds the same snapshot", () => {
  test("snapshot can be rebuilt from the persisted receipts after a simulated restart", () => {
    // Two real loads through the kernel record durable receipts (the session_capability_load facts).
    sessionCapabilityLoad({ request: loadRequest("deepagent.code-read", "Read body"), identity: IDENTITY, contextEpoch: "epoch-1" })
    sessionCapabilityLoad({ request: loadRequest("deepagent.code-edit", "Edit body"), identity: IDENTITY, contextEpoch: "epoch-1" })

    // Capture the surviving durable receipts BEFORE the restart.
    const surviving = receiptsAsLoaded(recordedCapabilityLoads())
    const before = buildCapabilityLoadSnapshot({ loadedCapabilities: surviving })
    const beforeDigest = capabilitySnapshotDigest(before)

    // Simulate a compaction/restart: the in-module store is cleared, but the durable
    // receipts survive (the `surviving` snapshot we captured above). The same snapshot
    // is rebuilt from the receipts + catalog, so the Context Epoch is restored without
    // keeping every procedure body in the system prefix.
    resetCapabilityLoader()
    const after = rebuildSnapshotFromReceipts(surviving, capabilityCatalog)
    expect(capabilitySnapshotDigest(after)).toBe(beforeDigest)

    // A rebuild from the SAME surviving receipts is byte-identical.
    const again = rebuildSnapshotFromReceipts(surviving)
    expect(capabilitySnapshotDigest(again)).toBe(beforeDigest)
  })
})

function receiptsAsLoaded(receipts: ReadonlyArray<{ capabilityId: string; bodyHash: string }>) {
  return receipts.map((receipt) => ({ capabilityId: receipt.capabilityId, bodyHash: receipt.bodyHash }))
}
