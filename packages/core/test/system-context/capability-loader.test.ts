import { describe, expect, test, beforeEach } from "bun:test"
import { Hash } from "@deepagent-code/core/util/hash"
import {
  CapabilityBodyHashMismatchError,
  capabilityLoaderIdentity,
  capabilityLoaderIdentityFrom,
  loadCapabilityBody,
  recordedCapabilityLoads,
  resetCapabilityLoader,
  type CapabilityLoadGrounds,
} from "@deepagent-code/core/system-context/capability-loader"

// C4-04 — durable capability loader kernel: byte-stable identity, exact-retry
// receipt, fail-closed hash verification, and the typed tagged union.

const digestOf = (body: string): string => `sha256:${Hash.sha256(body)}`

const bodyA = "Read and search source files: use read/glob/grep and trace references before editing."
const bodyB = "Edit files with exact changes: apply-patch then re-read the diff."

function grounds(partial: Partial<CapabilityLoadGrounds> = {}): CapabilityLoadGrounds {
  return { bodyRef: "capability://deepagent.code-read@1.0.0-beta.0", ...partial }
}

beforeEach(() => resetCapabilityLoader())

describe("capabilityLoaderIdentity", () => {
  test("is byte-stable: identical inputs hash identically", () => {
    const a = capabilityLoaderIdentity("deepagent.code-read", "1.0.0-beta.0", digestOf(bodyA), "rt-1", "perm-1")
    const b = capabilityLoaderIdentity("deepagent.code-read", "1.0.0-beta.0", digestOf(bodyA), "rt-1", "perm-1")
    expect(a).toBe(b)
    expect(a).toMatch(/^capability_load:[0-9a-f]{64}$/)
  })

  test("is independent of insertion order and object form", () => {
    const a = capabilityLoaderIdentityFrom({ capabilityId: "deepagent.code-read", version: "1.0.0-beta.0", bodyHash: digestOf(bodyA), runtimeHash: "rt-1", permissionHash: "perm-1" })
    const b = capabilityLoaderIdentity("deepagent.code-read", "1.0.0-beta.0", digestOf(bodyA), "rt-1", "perm-1")
    expect(a).toBe(b)
  })

  test("changes when a single identity ground changes", () => {
    const base = capabilityLoaderIdentity("deepagent.code-read", "1.0.0-beta.0", digestOf(bodyA), "rt-1", "perm-1")
    const bodyDrift = capabilityLoaderIdentity("deepagent.code-read", "1.0.0-beta.0", digestOf(bodyB), "rt-1", "perm-1")
    const versionBump = capabilityLoaderIdentity("deepagent.code-read", "2.0.0-beta.0", digestOf(bodyA), "rt-1", "perm-1")
    expect(bodyDrift).not.toBe(base)
    expect(versionBump).not.toBe(base)
  })
})

describe("loadCapabilityBody", () => {
  test("loads a body and records a receipt for the identity", () => {
    const identity = capabilityLoaderIdentity("deepagent.code-read", "1.0.0-beta.0", digestOf(bodyA), "rt-1", "perm-1")
    const result = loadCapabilityBody(identity, { body: bodyA, declaredDigest: digestOf(bodyA) }, grounds())
    expect(result.state).toBe("available")
    if (result.state === "available") {
      expect(result.body).toBe(bodyA)
      expect(result.tokenCount).toBeGreaterThan(0)
    }
    expect(recordedCapabilityLoads()).toHaveLength(1)
  })

  test("exact retry of an identical identity is an existing no-op (no duplicate receipt)", () => {
    const identity = capabilityLoaderIdentity("deepagent.code-read", "1.0.0-beta.0", digestOf(bodyA), "rt-1", "perm-1")
    const first = loadCapabilityBody(identity, { body: bodyA, declaredDigest: digestOf(bodyA) }, grounds())
    expect(first.state).toBe("available")

    const retry = loadCapabilityBody(identity, { body: bodyA, declaredDigest: digestOf(bodyA) }, grounds())
    expect(retry.state).toBe("existing")
    if (retry.state === "existing" && first.state === "available") {
      expect(retry.receipt.identity).toBe(first.receipt.identity)
    }
    expect(recordedCapabilityLoads()).toHaveLength(1)
  })

  test("a body hash that drifts from the declared digest is a typed fail-closed mismatch", () => {
    const identity = capabilityLoaderIdentity("deepagent.code-read", "1.0.0-beta.0", digestOf(bodyA), "rt-1", "perm-1")
    expect(() =>
      loadCapabilityBody(identity, { body: bodyA, declaredDigest: digestOf(bodyB) }, grounds()),
    ).toThrow(CapabilityBodyHashMismatchError)
    expect(recordedCapabilityLoads()).toHaveLength(0)
  })

  test("a version bump (superseding ref) is a typed superseded result", () => {
    const identity = capabilityLoaderIdentity("deepagent.code-read", "1.0.0-beta.0", digestOf(bodyA), "rt-1", "perm-1")
    const result = loadCapabilityBody(
      identity,
      { body: bodyA, declaredDigest: digestOf(bodyA) },
      grounds({ supersedingRef: "capability://deepagent.code-read@2.0.0-beta.0" }),
    )
    expect(result.state).toBe("superseded")
    if (result.state === "superseded") expect(result.supersedingRef).toBe("capability://deepagent.code-read@2.0.0-beta.0")
    expect(recordedCapabilityLoads()).toHaveLength(0)
  })

  test("an absent body (no body authored yet) is a typed missing_body result", () => {
    const identity = capabilityLoaderIdentity("deepagent.code-edit", "1.0.0-beta.0", "", "rt-2", "perm-2")
    const result = loadCapabilityBody(identity, { body: undefined, declaredDigest: undefined }, grounds({ bodyRef: "capability://deepagent.code-edit@1.0.0-beta.0" }))
    expect(result.state).toBe("missing_body")
    if (result.state === "missing_body") expect(result.bodyRef).toBe("capability://deepagent.code-edit@1.0.0-beta.0")
    expect(recordedCapabilityLoads()).toHaveLength(0)
  })

  test("a permission-denied load is a typed denied result and never loads a body", () => {
    const identity = capabilityLoaderIdentity("deepagent.shell-execute", "1.0.0-beta.0", digestOf(bodyB), "rt-3", "perm-3")
    const result = loadCapabilityBody(
      identity,
      { body: bodyB, declaredDigest: digestOf(bodyB) },
      grounds({ bodyRef: "capability://deepagent.shell-execute@1.0.0-beta.0", deniedReason: "permission_scope_denied" }),
    )
    expect(result.state).toBe("denied")
    if (result.state === "denied") expect(result.reasonCode).toBe("permission_scope_denied")
    expect(recordedCapabilityLoads()).toHaveLength(0)
  })

  test("an over-budget L2 body is a typed budget_exceeded result (kernel-level state)", () => {
    const longBody = "x".repeat(5000) // deterministic, > 1200 tokens by char estimate (4 chars/token)
    const identity = capabilityLoaderIdentity("deepagent.web-research", "1.0.0-beta.0", digestOf(longBody), "rt-4", "perm-4")
    const result = loadCapabilityBody(
      identity,
      { body: longBody, declaredDigest: digestOf(longBody) },
      grounds({ bodyRef: "capability://deepagent.web-research@1.0.0-beta.0" }),
    )
    expect(result.state).toBe("budget_exceeded")
    if (result.state === "budget_exceeded") {
      expect(result.level).toBe("L2")
      expect(result.limitTokens).toBe(1200)
      expect(result.requestedTokens).toBeGreaterThan(1200)
    }
    expect(recordedCapabilityLoads()).toHaveLength(0)
  })
})
