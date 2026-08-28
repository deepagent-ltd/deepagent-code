import { describe, expect, test, beforeEach } from "bun:test"
import { Hash } from "@deepagent-code/core/util/hash"
import {
  mapCapabilityLoadResult,
  sessionCapabilityLoad,
  withTurnIdentity,
  capabilityLoadRequestHash,
  type CapabilityLoadRequest,
  type CapabilityLoadTurnIdentity,
} from "@deepagent-code/core/system-context/capability-load-adapter"
import { capabilityCatalog } from "@deepagent-code/core/system-context/capability-catalog"
import { capabilitySearch, fullAuthorization } from "@deepagent-code/core/system-context/capability-search"
import { findCapabilityBody } from "@deepagent-code/core/system-context/capability-bodies"
import { resetCapabilityLoader, type CapabilityLoadResult } from "@deepagent-code/core/system-context/capability-loader"

// C4-07 — wire the K2 kernel onto the frozen C0-02 contract: the 6-state -> ContentLoadState
// mapping, the frozen durable receipt, the withTurnIdentity seam, and the search -> load path.

const digestOf = (body: string): string => `sha256:${Hash.sha256(body)}`

const REQUEST: CapabilityLoadRequest = {
  capabilityId: "deepagent.code-read",
  version: "1.0.0-beta.0",
  bodyHash: digestOf("Read source body"),
  runtimeHash: "rt-1",
  permissionHash: "perm-1",
  bodyRef: "capability://deepagent.code-read@1.0.0-beta.0",
  body: "Read source body",
  declaredDigest: digestOf("Read source body"),
  catalogSnapshotId: "capability_catalog:test",
  requiredPermissions: ["read", "glob", "grep"],
  grantedPermissions: ["read", "glob", "grep"],
  requiredRuntimeFeatures: [],
}

const IDENTITY: CapabilityLoadTurnIdentity = { sessionId: "session-1", activityId: "activity-1", turnId: "turn-1" }

beforeEach(() => resetCapabilityLoader())

function kernelReceipt(bodyHash = digestOf("Read source body")) {
  return {
    identity: "capability_load:abc",
    capabilityId: "deepagent.code-read",
    version: "1.0.0-beta.0",
    bodyRef: "capability://deepagent.code-read@1.0.0-beta.0",
    bodyHash,
    runtimeHash: "rt-1",
    permissionHash: "perm-1",
    state: "loaded" as const,
    tokenCount: 5,
    byteCount: 20,
  }
}

// --- mapping table: every K2 kernel state -> ContentLoadState --------------------
describe("mapCapabilityLoadResult (6-state kernel -> ContentLoadState)", () => {
  const cases: ReadonlyArray<[string, CapabilityLoadResult, { state: string; extra: Record<string, unknown> }]> = [
    ["available", { state: "available", body: "b", tokenCount: 5, byteCount: 20, receipt: kernelReceipt() }, { state: "loaded", extra: { bodyRef: "capability://deepagent.code-read@1.0.0-beta.0", tokenCount: 5, byteCount: 20 } }],
    ["existing", { state: "existing", receipt: kernelReceipt() }, { state: "already_loaded", extra: { bodyRef: "capability://deepagent.code-read@1.0.0-beta.0" } }],
    ["denied", { state: "denied", reasonCode: "permission_scope_denied" }, { state: "denied", extra: { reasonCode: "permission_scope_denied" } }],
    ["budget_exceeded", { state: "budget_exceeded", level: "L2", limitTokens: 1200, requestedTokens: 1500 }, { state: "budget_exceeded", extra: { level: "L2", limitTokens: 1200, requestedTokens: 1500, limitNewPerTurn: 2, newThisTurn: 0 } }],
    ["missing_body", { state: "missing_body", bodyRef: "capability://deepagent.code-edit@1.0.0-beta.0" }, { state: "not_found", extra: { reasonCode: "capability_unregistered" } }],
    ["superseded", { state: "superseded", supersedingRef: "capability://deepagent.code-read@2.0.0-beta.0" }, { state: "not_found", extra: { reasonCode: "catalog_snapshot_mismatch" } }],
  ]

  for (const [label, kernel, expected] of cases) {
    test(`${label} -> ${expected.state}`, () => {
      const mapped = mapCapabilityLoadResult(kernel) as { state: string } & Record<string, unknown>
      expect(mapped.state).toBe(expected.state)
      for (const [key, value] of Object.entries(expected.extra)) expect(mapped[key]).toEqual(value)
    })
  }
})

// --- frozen receipt field completeness -------------------------------------------
describe("sessionCapabilityLoad builds the durable frozen receipt", () => {
  test("a successful load yields a ContentLoadState 'loaded' + a fully-populated receipt", () => {
    const out = sessionCapabilityLoad({ request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" })
    expect(out.state.state).toBe("loaded")
    const receipt = out.receipt
    // Every frozen field is present and coherent.
    expect(receipt.schemaVersion).toBe("capability-load.v1")
    expect(receipt.contentKind).toBe("capability")
    expect(receipt.loadId).toBeTruthy()
    expect(receipt.sessionId).toBe("session-1")
    expect(receipt.activityId).toBe("activity-1")
    expect(receipt.turnId).toBe("turn-1")
    expect(receipt.catalogSnapshotId).toBe("capability_catalog:test")
    expect(receipt.version).toBe("1.0.0-beta.0")
    expect(receipt.bodyHash).toBe(REQUEST.bodyHash)
    expect(receipt.runtimeHash).toBe("rt-1")
    expect(receipt.permissionHash).toBe("perm-1")
    expect(receipt.permissionBinding.required).toEqual(["read", "glob", "grep"])
    expect(receipt.permissionBinding.granted).toEqual(["read", "glob", "grep"])
    expect(receipt.requestHash).toBeTruthy()
    expect(receipt.resultHash).toBeTruthy()
    expect(receipt.contextEpoch).toBe("epoch-1")
    expect(receipt.level).toBe("L2")
    expect(receipt.bodyRef).toBe(REQUEST.bodyRef)
    expect(receipt.budgetState).toBe("within")
    expect(receipt.newLoadsThisTurn).toBeGreaterThanOrEqual(0)
    expect(receipt.tokenCount).toBeGreaterThan(0)
    expect(receipt.byteCount).toBeGreaterThan(0)
  })

  test("request hash is byte-stable and binds turn/session identity", () => {
    const a = capabilityLoadRequestHash(REQUEST, IDENTITY)
    const b = capabilityLoadRequestHash(REQUEST, IDENTITY)
    expect(a).toBe(b)
    const c = capabilityLoadRequestHash(REQUEST, { ...IDENTITY, turnId: "turn-2" })
    expect(c).not.toBe(a)
  })

  test("withTurnIdentity binds the real session/activity/turn identity into the request", () => {
    const bound = withTurnIdentity(REQUEST, IDENTITY)
    expect(bound.sessionId).toBe("session-1")
    expect(bound.activityId).toBe("activity-1")
    expect(bound.turnId).toBe("turn-1")
    expect(bound.capabilityId).toBe("deepagent.code-read")
  })

  test("an exact retry returns the already_loaded state with a stable request/body binding", () => {
    const first = sessionCapabilityLoad({ request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" })
    const second = sessionCapabilityLoad({ request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" })
    expect(second.state.state).toBe("already_loaded")
    expect(second.receipt.requestHash).toBe(first.receipt.requestHash)
    expect(second.receipt.bodyHash).toBe(first.receipt.bodyHash)
    expect(second.receipt.catalogSnapshotId).toBe(first.receipt.catalogSnapshotId)
  })
})

// --- search -> load path: available index is reachable ---------------------------
describe("L0 catalog -> L1 search -> L2 load is reachable (available index non-empty)", () => {
  test("a known capability card is searchable, then its body loads through the kernel", () => {
    const cards = capabilitySearch(capabilityCatalog, { query: "read source", intended_action: "read" }, fullAuthorization)
    expect(cards.some((card) => card.id === "deepagent.code-read")).toBe(true)

    const entry = findCapabilityBody("capability://deepagent.code-read@1.0.0-beta.0")
    expect(entry).toBeTruthy()

    const out = sessionCapabilityLoad({
      request: {
        capabilityId: entry!.id,
        version: entry!.version,
        bodyHash: entry!.body_hash!,
        runtimeHash: "rt-catalog",
        permissionHash: "perm-catalog",
        bodyRef: entry!.body_ref,
        body: entry!.body,
        declaredDigest: entry!.body_hash!,
        catalogSnapshotId: "capability_catalog:local",
        requiredPermissions: entry!.required_permissions,
        grantedPermissions: entry!.required_permissions,
        requiredRuntimeFeatures: entry!.required_runtime_features,
      },
      identity: IDENTITY,
      contextEpoch: "epoch-search",
    })
    expect(out.state.state).toBe("loaded")
    expect(out.body).toBe(entry!.body)
  })
})

// --- observable store reset -------------------------------------------------------
describe("adapter re-exports the kernel reset for isolation", () => {
  test("a fresh adapter boundary clears the loader budget", () => {
    sessionCapabilityLoad({ request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" })
    resetCapabilityLoader()
    const again = sessionCapabilityLoad({ request: REQUEST, identity: IDENTITY, contextEpoch: "epoch-1" })
    expect(again.state.state).toBe("loaded")
  })
})
