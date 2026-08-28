import { describe, expect, test } from "bun:test"
import { Hash } from "@deepagent-code/core/util/hash"
import {
  assertCapabilityBodiesCoherent,
  bodyMetrics,
  capabilityBodies,
  capabilityBodyDigest,
  findCapabilityBody,
  capabilityBodyFor,
  bodyContent,
} from "@deepagent-code/core/system-context/capability-bodies"
import { sessionCapabilityLoad, type CapabilityLoadTurnIdentity } from "@deepagent-code/core/system-context/capability-load-adapter"
import { resetCapabilityLoader } from "@deepagent-code/core/system-context/capability-loader"
import { capabilityCatalog, capabilityCatalogSnapshotId } from "@deepagent-code/core/system-context/capability-catalog"

// C4-09 — author the first batch of capability bodies, hash-bound, within the L2
// budget, with no permission expansion.

describe("first batch = 10 capability bodies", () => {
  test("authors exactly 10 concrete bodies", () => {
    expect(capabilityBodies).toHaveLength(10)
    expect(new Set(capabilityBodies.map((entry) => entry.id)).size).toBe(10)
  })

  test("every body uses the capability://<id>@<version> scheme", () => {
    for (const entry of capabilityBodies) {
      expect(String(entry.body_ref)).toBe(`capability://${entry.id}@${entry.version}`)
    }
  })

  test("every body_hash equals the sha256 of the body content (deterministic binding)", () => {
    for (const entry of capabilityBodies) {
      expect(String(entry.body_hash)).toBe(`sha256:${Hash.sha256(entry.body)}`)
      expect(String(entry.body_hash)).toBe(capabilityBodyDigest(entry.body))
    }
  })
})

describe("each body loads through the kernel (hash matches)", () => {
  test("every body's body + declared digest load as 'loaded'", () => {
    const IDENTITY: CapabilityLoadTurnIdentity = { sessionId: "session-bodies", activityId: "activity-bodies", turnId: "turn-bodies" }
    for (const entry of capabilityBodies) {
      const { body, declaredDigest } = bodyContent(entry)
      const out = sessionCapabilityLoad({
        request: {
          capabilityId: entry.id,
          version: entry.version,
          bodyHash: entry.body_hash!,
          runtimeHash: "rt-bodies",
          permissionHash: "perm-bodies",
          bodyRef: entry.body_ref,
          body,
          declaredDigest,
          catalogSnapshotId: capabilityCatalogSnapshotId,
          requiredPermissions: entry.required_permissions,
          grantedPermissions: entry.required_permissions,
          requiredRuntimeFeatures: entry.required_runtime_features,
        },
        identity: { ...IDENTITY, turnId: `turn-${entry.id}` },
        contextEpoch: "epoch-bodies",
      })
      expect(out.state.state).toBe("loaded")
      expect(out.body).toBe(body)
    }
  })

  test("a body lookup by ref and by id/version are consistent", () => {
    const entry = capabilityBodies[0]!
    expect(findCapabilityBody(entry.body_ref)).toBe(entry)
    expect(capabilityBodyFor(entry.id, entry.version)).toBe(entry)
  })
})

describe("every body respects the L2 1200-token single-body budget", () => {
  test("no body exceeds the frozen L2 single-body token ceiling", () => {
    for (const entry of capabilityBodies) {
      const { tokenCount } = bodyMetrics(entry)
      expect(tokenCount).toBeLessThanOrEqual(1200)
      expect(tokenCount).toBeGreaterThan(0)
    }
  })
})

describe("no permission expansion (design §7.6)", () => {
  test("the body coherence gate is clean over the whole inventory", () => {
    expect(assertCapabilityBodiesCoherent()).toEqual([])
  })

  test("every catalog-matching body's permissions are a subset of its manifest's (never a superset)", () => {
    const catalogById = new Map(capabilityCatalog.map((manifest) => [manifest.id, manifest]))
    for (const entry of capabilityBodies) {
      const frozen = catalogById.get(entry.id)
      if (!frozen) continue
      const extra = entry.required_permissions.filter((permission) => !frozen.required_permissions.includes(permission))
      expect(extra).toEqual([])
    }
  })

  test("the 6 catalog bodies share the frozen manifest's id/version", () => {
    const frozenIds = new Set(capabilityCatalog.map((manifest) => manifest.id))
    const matching = capabilityBodies.filter((entry) => frozenIds.has(entry.id))
    expect(matching).toHaveLength(capabilityCatalog.length)
  })
})
