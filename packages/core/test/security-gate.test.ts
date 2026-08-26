import { describe, expect, test } from "bun:test"
import { SecurityGate } from "@deepagent-code/core/deepagent/security-gate"

// SecurityGate.check is a PURE function — no Effect/DB, so these are plain unit tests.

const input = (over?: Partial<SecurityGate.SecurityInput>): SecurityGate.SecurityInput => ({
  eventSourceTrusted: true,
  actorHasPermission: true,
  agentCapabilities: ["code.fix", "code.review"],
  requiredCapability: undefined,
  runtimeAllowed: true,
  ...over,
})

describe("SecurityGate.check", () => {
  test("§E1 all four layers pass → allowed", () => {
    expect(SecurityGate.check(input())).toEqual({ allowed: true })
    expect(SecurityGate.check(input({ requiredCapability: "code.fix" }))).toEqual({ allowed: true })
  })

  test("§E1 layer 1 event_source fails first, fail-closed", () => {
    const d = SecurityGate.check(
      input({ eventSourceTrusted: false, actorHasPermission: false, runtimeAllowed: false }),
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.failedLayer).toBe("event_source")
  })

  test("§E1 layer 2 actor_permission fails when source trusted", () => {
    const d = SecurityGate.check(input({ actorHasPermission: false, runtimeAllowed: false }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.failedLayer).toBe("actor_permission")
  })

  test("§E1 layer 3 agent_capability fails only when required cap is missing", () => {
    const d = SecurityGate.check(input({ requiredCapability: "deploy" }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) {
      expect(d.failedLayer).toBe("agent_capability")
      expect(d.reason).toContain("deploy")
    }
    // present capability passes layer 3
    expect(SecurityGate.check(input({ requiredCapability: "code.review" }))).toEqual({ allowed: true })
    // no requiredCapability = layer 3 is a no-op
    expect(SecurityGate.check(input({ agentCapabilities: [] }))).toEqual({ allowed: true })
  })

  test("§E1 layer 4 runtime_operation fails last", () => {
    const d = SecurityGate.check(input({ runtimeAllowed: false }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.failedLayer).toBe("runtime_operation")
  })

  test("§E1 order: an earlier failure masks a later one", () => {
    // layer 3 would also fail (missing cap) but layer 2 fails first.
    const d = SecurityGate.check(input({ actorHasPermission: false, requiredCapability: "deploy" }))
    if (!d.allowed) expect(d.failedLayer).toBe("actor_permission")
  })
})

describe("SecurityGate.isTrustedSource", () => {
  test("set membership", () => {
    expect(SecurityGate.isTrustedSource("ci", ["ci", "git"])).toBe(true)
    expect(SecurityGate.isTrustedSource("im", ["ci", "git"])).toBe(false)
    expect(SecurityGate.isTrustedSource("system", [])).toBe(false)
  })
})

describe("SecurityGate.hasCapability", () => {
  test("treats a missing list as empty", () => {
    expect(SecurityGate.hasCapability({ capabilities: ["a", "b"] }, "a")).toBe(true)
    expect(SecurityGate.hasCapability({ capabilities: ["a", "b"] }, "c")).toBe(false)
    expect(SecurityGate.hasCapability({ capabilities: undefined }, "a")).toBe(false)
  })
})
