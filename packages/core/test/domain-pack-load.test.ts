import { describe, expect, test, beforeEach } from "bun:test"
import { Hash } from "@deepagent-code/core/util/hash"
import {
  ActivePackRefsExceededError,
  activePackRefsFor,
  domainPackLoaderIdentity,
  loadDomainPack,
  resetDomainPackLoader,
} from "@deepagent-code/core/deepagent/domain-pack-load"
import { resetCapabilityLoader } from "@deepagent-code/core/system-context/capability-loader"

// C4-06 — `domain_pack_load`: reuses the durable capability loader kernel, then
// adds the session-scoped active pack snapshot ref cap (default 3 per session).

const digestOf = (body: string): string => `sha256:${Hash.sha256(body)}`

const bodyA = "Frontend React: component structure, state management and hooks guidance."
const bodyB = "Backend Node: service layering, error handling and migration guidance."

function pack(overrides: Partial<Parameters<typeof loadDomainPack>[0]> = {}) {
  return loadDomainPack({
    packId: "code.frontend.react",
    version: "1.0.0",
    bodyHash: digestOf(bodyA),
    runtimeHash: "rt-pack-1",
    permissionHash: "perm-pack-1",
    bodyRef: "domain://code.frontend.react@1.0.0",
    sessionIdentity: "session-pack-1",
    packSnapshotRef: "pack_snapshot:aaaa1111",
    body: bodyA,
    declaredDigest: digestOf(bodyA),
    ...overrides,
  })
}

beforeEach(() => {
  resetCapabilityLoader()
  resetDomainPackLoader()
})

describe("domain_pack_load via the kernel", () => {
  test("a matching pack body hash loads through the kernel (binding verified)", () => {
    const result = pack()
    expect(result.state).toBe("available")
    if (result.state === "available") expect(result.body).toBe(bodyA)
  })

  test("a pack version bump is a typed superseded result", () => {
    const result = pack({ supersedingRef: "domain://code.frontend.react@2.0.0" })
    expect(result.state).toBe("superseded")
    if (result.state === "superseded") expect(result.supersedingRef).toBe("domain://code.frontend.react@2.0.0")
  })

  test("a permission-denied pack entry is a typed denied result and never loads a body", () => {
    const result = pack({ deniedReason: "permission_scope_denied" })
    expect(result.state).toBe("denied")
    if (result.state === "denied") expect(result.reasonCode).toBe("permission_scope_denied")
    expect(activePackRefsFor("session-pack-1")).toHaveLength(0)
  })

  test("a missing pack body is a typed missing_body result and records no active ref", () => {
    const result = pack({ body: undefined, declaredDigest: undefined })
    expect(result.state).toBe("missing_body")
    expect(activePackRefsFor("session-pack-1")).toHaveLength(0)
  })

  test("a pack body hash that drifts is a typed fail-closed mismatch", () => {
    expect(() => pack({ declaredDigest: digestOf(bodyB) })).toThrow()
    expect(activePackRefsFor("session-pack-1")).toHaveLength(0)
  })
})

describe("active pack snapshot refs cap (default 3 per session)", () => {
  test("the 4th distinct pack snapshot ref in one session is a typed refs-exceeded error", () => {
    expect(pack().state).toBe("available")
    expect(pack({ packId: "code.node", version: "1.0.0", bodyRef: "domain://code.node@1.0.0", packSnapshotRef: "pack_snapshot:bbbb2222", body: bodyB, declaredDigest: digestOf(bodyB), bodyHash: digestOf(bodyB) }).state).toBe("available")
    expect(pack({ packId: "code.python", version: "1.0.0", bodyRef: "domain://code.python@1.0.0", packSnapshotRef: "pack_snapshot:cccc3333", body: bodyB, declaredDigest: digestOf(bodyB), bodyHash: digestOf(bodyB) }).state).toBe("available")
    expect(activePackRefsFor("session-pack-1")).toHaveLength(3)
    expect(() =>
      pack({ packId: "code.go", version: "1.0.0", bodyRef: "domain://code.go@1.0.0", packSnapshotRef: "pack_snapshot:dddd4444", body: bodyB, declaredDigest: digestOf(bodyB), bodyHash: digestOf(bodyB) }),
    ).toThrow(ActivePackRefsExceededError)
    expect(activePackRefsFor("session-pack-1")).toHaveLength(3)
  })

  test("re-recording the same pack snapshot ref is idempotent and never exceeds the cap", () => {
    expect(pack().state).toBe("available")
    expect(pack().state).toBe("existing")
    expect(pack().state).toBe("existing")
    expect(pack().state).toBe("existing")
    expect(activePackRefsFor("session-pack-1")).toHaveLength(1)
  })

  test("the active ref cap is scoped per session identity", () => {
    expect(pack().state).toBe("available")
    expect(pack({ sessionIdentity: "session-pack-2", packId: "code.node", version: "1.0.0", bodyRef: "domain://code.node@1.0.0", packSnapshotRef: "pack_snapshot:bbbb2222", body: bodyB, declaredDigest: digestOf(bodyB), bodyHash: digestOf(bodyB) }).state).toBe("available")
    expect(pack({ sessionIdentity: "session-pack-2", packId: "code.python", version: "1.0.0", bodyRef: "domain://code.python@1.0.0", packSnapshotRef: "pack_snapshot:cccc3333", body: bodyB, declaredDigest: digestOf(bodyB), bodyHash: digestOf(bodyB) }).state).toBe("available")
    expect(pack({ sessionIdentity: "session-pack-2", packId: "code.go", version: "1.0.0", bodyRef: "domain://code.go@1.0.0", packSnapshotRef: "pack_snapshot:dddd4444", body: bodyB, declaredDigest: digestOf(bodyB), bodyHash: digestOf(bodyB) }).state).toBe("available")
    expect(activePackRefsFor("session-pack-2")).toHaveLength(3)
    expect(activePackRefsFor("session-pack-1")).toHaveLength(1)
  })
})

describe("domain_pack loader identity", () => {
  test("is byte-stable and namespaced apart from capability loads", () => {
    const a = domainPackLoaderIdentity("code.frontend.react", "1.0.0", digestOf(bodyA), "rt-1", "perm-1")
    const b = domainPackLoaderIdentity("code.frontend.react", "1.0.0", digestOf(bodyA), "rt-1", "perm-1")
    expect(a).toBe(b)
    expect(a).toMatch(/^domain_pack_load:[0-9a-f]{64}$/)
  })
})
