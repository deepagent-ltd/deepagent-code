import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  CapabilityLoadReceipt,
  DomainPackLoadReceipt,
  CapabilityLoadDecodeError,
  MissingCapabilityBodyError,
  SupersededCapabilityError,
  BudgetExceededError,
  CapabilityBudgetLimits,
  decodeCapabilityLoadReceipt,
  encodeCapabilityLoadReceipt,
  decodeDomainPackLoadReceipt,
  decodeSessionContentLoad,
  encodeSessionContentLoad,
  validateCapabilityLoadReceipt,
  ContentLoadRetryMismatchError,
  assertCapabilityBodyPresent,
  assertCapabilityNotSuperseded,
  assertContentLoadBudget,
  assertContentLoadExactRetry,
  capabilityLoadReceiptDigest,
  domainPackLoadReceiptDigest,
} from "../../src/contract/capability-load"

function common(state: unknown, contentKind: string = "capability") {
  return {
    schemaVersion: "capability-load.v1",
    contentKind,
    loadId: "load-1",
    sessionId: "ses-1",
    activityId: "act-1",
    turnId: "turn-1",
    catalogSnapshotId: "cat-1",
    version: "2.0.0-beta.0",
    bodyHash: "body-1",
    runtimeHash: "rt-1",
    permissionHash: "perm-1",
    permissionBinding: { permissionFingerprint: "pf-1", required: ["context.read"], granted: ["context.read"] },
    runtimeCompatibilityHash: "rtc-1",
    requestHash: "req-1",
    resultHash: "res-1",
    level: "L2",
    bodyRef: "capability://deepagent.context-query@2.0.0-beta.0",
    tokenCount: 500,
    byteCount: 4000,
    budgetState: "within",
    newLoadsThisTurn: 1,
    newTokensThisTurn: 500,
    contextEpoch: "epoch-1",
    loadedAt: 100,
    state,
  }
}

function makeReceipt(): CapabilityLoadReceipt {
  return decodeCapabilityLoadReceipt(
    common({ state: "loaded", bodyRef: "capability://deepagent.context-query@2.0.0-beta.0", tokenCount: 500, byteCount: 4000 }),
  )
}

function makeDomainPack(): DomainPackLoadReceipt {
  return decodeDomainPackLoadReceipt({
    ...common({ state: "loaded", bodyRef: "domain://pack-a@1", tokenCount: 300, byteCount: 2000 }, "domain_pack"),
    contentKind: "domain_pack",
    packSnapshotRef: "pack://snapshot-1",
    activePackSnapshotHash: "aps-1",
    refBelongsToActiveSnapshot: true,
  })
}

function decodeError(input: unknown): CapabilityLoadDecodeError {
  try {
    decodeCapabilityLoadReceipt(input)
  } catch (error) {
    if (error instanceof CapabilityLoadDecodeError) return error
    throw error
  }
  throw new Error("expected decodeCapabilityLoadReceipt to fail")
}

describe("capability load contract round-trip and digest", () => {
  test("capability receipt encode -> decode round-trip is deterministic", () => {
    const receipt = makeReceipt()
    const decoded = decodeCapabilityLoadReceipt(encodeCapabilityLoadReceipt(receipt))
    expect(decoded).toEqual(receipt)
  })

  test("domain pack receipt encode -> decode round-trip is deterministic", () => {
    const receipt = makeDomainPack()
    const decoded = decodeDomainPackLoadReceipt({ ...receipt })
    expect(decoded).toEqual(receipt)
  })

  test("session content load union encodes both kinds", () => {
    const cap = makeReceipt()
    const pack = makeDomainPack()
    expect(() => encodeSessionContentLoad(cap)).not.toThrow()
    expect(() => encodeSessionContentLoad(pack)).not.toThrow()
    expect(decodeSessionContentLoad(encodeSessionContentLoad(cap)).contentKind).toEqual("capability")
    expect(decodeSessionContentLoad(encodeSessionContentLoad(pack)).contentKind).toEqual("domain_pack")
  })

  test("receipt digest is byte-stable", () => {
    const receipt = makeReceipt()
    expect(capabilityLoadReceiptDigest(receipt)).toEqual(capabilityLoadReceiptDigest(receipt))
    expect(capabilityLoadReceiptDigest(receipt)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("capability load: per-member negatives for every state member", () => {
  const cases: Record<string, { detail: Record<string, unknown>; path: string[] }> = {
    loaded: { detail: { state: "loaded", bodyRef: "cap://1", tokenCount: 10, byteCount: 100 }, path: ["state", "tokenCount"] },
    already_loaded: { detail: { state: "already_loaded", bodyRef: "cap://1" }, path: ["state", "bodyRef"] },
    denied: { detail: { state: "denied", reasonCode: "permission_scope_denied" }, path: ["state", "reasonCode"] },
    disabled: { detail: { state: "disabled", reasonCode: "maintenance_only" }, path: ["state", "reasonCode"] },
    incompatible: { detail: { state: "incompatible", runtimeRequired: "rt-a", runtimeFound: "rt-b" }, path: ["state", "runtimeFound"] },
    not_found: { detail: { state: "not_found", reasonCode: "capability_unregistered" }, path: ["state", "reasonCode"] },
    budget_exceeded: {
      detail: { state: "budget_exceeded", level: "L2", limitTokens: 1200, requestedTokens: 1500, limitNewPerTurn: 2, newThisTurn: 3 },
      path: ["state", "newThisTurn"],
    },
  }
  for (const [state, { detail, path }] of Object.entries(cases)) {
    test(`missing member field for state=${state} -> typed error ${path.join(".")}`, () => {
      const input = common({ ...detail }) as Record<string, unknown>
      const stateObj = input.state as Record<string, unknown>
      delete stateObj[path[1]!]
      expect(decodeError(input).path).toEqual(path)
    })
  }
})

describe("capability load negative shapes", () => {
  test("missing common field -> typed error with exact path", () => {
    const input = makeReceipt() as unknown as Record<string, unknown>
    delete input.bodyHash
    expect(decodeError(input).path).toEqual(["bodyHash"])
  })

  test("extra field -> typed error with exact path", () => {
    const input = { ...(makeReceipt() as unknown as Record<string, unknown>), unexpected: true }
    expect(decodeError(input).path).toEqual(["unexpected"])
  })

  test("wrong type -> typed error with exact path", () => {
    const input = makeReceipt() as unknown as Record<string, unknown>
    input.level = "L9"
    expect(decodeError(input).path).toEqual(["level"])
  })

  test("version mismatch -> typed error with exact path", () => {
    const input = { ...(makeReceipt() as unknown as Record<string, unknown>), schemaVersion: "capability-load.v2" }
    expect(decodeError(input).path).toEqual(["schemaVersion"])
  })

  test("wrong state discriminant -> typed error with exact path", () => {
    const input = common({ state: "bogus", ref: "x" })
    expect(decodeError(input).path).toEqual(["state"])
  })

  test("unknown denied reason is rejected", () => {
    const input = common({ state: "denied", reasonCode: "bogus" })
    expect(decodeError(input).path).toEqual(["state", "reasonCode"])
  })
})

describe("capability load budget freeze (design §7.3, §13)", () => {
  test("frozen budget limits decode", () => {
    const decoded = Schema.decodeUnknownSync(CapabilityBudgetLimits)({
      l0MaxBytes: 4096,
      l0MaxTokens: 700,
      l2SingleMaxTokens: 1200,
      l2PerTurnMaxNew: 2,
      l2PerTurnMaxNewTokens: 2400,
    })
    expect(decoded.l0MaxBytes).toEqual(4096)
    expect(decoded.l0MaxTokens).toEqual(700)
    expect(decoded.l2SingleMaxTokens).toEqual(1200)
    expect(decoded.l2PerTurnMaxNew).toEqual(2)
    expect(decoded.l2PerTurnMaxNewTokens).toEqual(2400)
  })

  test("a drift from the frozen budget is rejected", () => {
    expect(() =>
      Schema.decodeUnknownSync(CapabilityBudgetLimits)({ l0MaxBytes: 5000, l0MaxTokens: 700, l2SingleMaxTokens: 1200, l2PerTurnMaxNew: 2, l2PerTurnMaxNewTokens: 2400 }),
    ).toThrow()
  })

  test("L0 over budget throws BudgetExceededError", () => {
    expect(() => assertContentLoadBudget("L0", 800, 5000, 0, 0)).toThrow(BudgetExceededError)
  })

  test("L2 single body over budget throws BudgetExceededError", () => {
    expect(() => assertContentLoadBudget("L2", 1300, 5000, 1, 1300)).toThrow(BudgetExceededError)
  })

  test("L2 per-turn new body count over budget throws BudgetExceededError", () => {
    expect(() => assertContentLoadBudget("L2", 1000, 4000, 3, 1000)).toThrow(BudgetExceededError)
  })

  test("within budget does not throw", () => {
    expect(() => assertContentLoadBudget("L0", 500, 3000, 0, 0)).not.toThrow()
    expect(() => assertContentLoadBudget("L2", 1000, 4000, 2, 2000)).not.toThrow()
  })
})

describe("capability load: exact retry + typed violations", () => {
  test("an exact retry does not throw", () => {
    expect(() =>
      assertContentLoadExactRetry(
        { requestHash: "req-1", bodyHash: "body-1", catalogSnapshotId: "cat-1" },
        { requestHash: "req-1", bodyHash: "body-1", catalogSnapshotId: "cat-1" },
      ),
    ).not.toThrow()
  })

  test("a body-hash drift is a typed conflict", () => {
    let cause = ""
    try {
      assertContentLoadExactRetry(
        { requestHash: "req-1", bodyHash: "body-1", catalogSnapshotId: "cat-1" },
        { requestHash: "req-1", bodyHash: "body-2", catalogSnapshotId: "cat-1" },
      )
    } catch (error) {
      if (error instanceof ContentLoadRetryMismatchError) cause = error.cause
    }
    expect(cause).toEqual("body_hash")
  })

  test("missing capability body throws the typed missing-body error", () => {
    expect(() => assertCapabilityBodyPresent("deepagent.context-query", "cap://1", "")).toThrow(MissingCapabilityBodyError)
    expect(() => assertCapabilityBodyPresent("deepagent.context-query", "cap://1", "body-1")).not.toThrow()
  })

  test("supersession throws a typed superseded error", () => {
    expect(() => assertCapabilityNotSuperseded("deepagent.context-query", "cap://2")).toThrow(SupersededCapabilityError)
    expect(() => assertCapabilityNotSuperseded("deepagent.context-query", undefined)).not.toThrow()
  })

  test("permission binding is never expanded (schema level)", () => {
    const receipt = makeReceipt()
    expect(receipt.permissionBinding.required).toEqual(["context.read"])
    expect(receipt.permissionBinding.granted).toEqual(["context.read"])
  })

  test("validate (non-throwing) returns the value for a valid receipt", () => {
    const result = validateCapabilityLoadReceipt(makeReceipt())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.contentKind).toEqual("capability")
  })

  test("validate (non-throwing) returns the typed error for an invalid receipt", () => {
    const result = validateCapabilityLoadReceipt({ ...(makeReceipt() as unknown as Record<string, unknown>), level: "L9" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.path).toEqual(["level"])
  })
})

describe("F1: receipt digest strips loadedAt", () => {
  test("capability receipt digest ignores loadedAt", () => {
    const a = decodeCapabilityLoadReceipt({
      ...common({ state: "loaded", bodyRef: "cap://1", tokenCount: 10, byteCount: 100 }),
      loadedAt: 1,
    })
    const b = decodeCapabilityLoadReceipt({
      ...common({ state: "loaded", bodyRef: "cap://1", tokenCount: 10, byteCount: 100 }),
      loadedAt: 999999,
    })
    expect(capabilityLoadReceiptDigest(a)).toEqual(capabilityLoadReceiptDigest(b))
  })

  test("domain-pack receipt digest ignores loadedAt", () => {
    const a = decodeDomainPackLoadReceipt({
      ...common({ state: "loaded", bodyRef: "po://p", tokenCount: 10, byteCount: 100 }, "domain_pack"),
      packSnapshotRef: "ps",
      activePackSnapshotHash: "h",
      refBelongsToActiveSnapshot: true,
      loadedAt: 1,
    })
    const b = decodeDomainPackLoadReceipt({
      ...common({ state: "loaded", bodyRef: "po://p", tokenCount: 10, byteCount: 100 }, "domain_pack"),
      packSnapshotRef: "ps",
      activePackSnapshotHash: "h",
      refBelongsToActiveSnapshot: true,
      loadedAt: 999999,
    })
    expect(domainPackLoadReceiptDigest(a)).toEqual(domainPackLoadReceiptDigest(b))
  })
})

describe("F3: SessionContentLoad per-member negatives", () => {
  test("capability member decodes", () => {
    expect(() => decodeSessionContentLoad(makeReceipt())).not.toThrow()
  })

  test("wrong contentKind discriminant -> exact path", () => {
    const input = { ...(makeReceipt() as unknown as Record<string, unknown>), contentKind: "bogus" }
    let path: readonly string[] = []
    try {
      decodeSessionContentLoad(input)
    } catch (error) {
      if (error instanceof CapabilityLoadDecodeError) path = error.path
    }
    expect(path).toEqual(["contentKind"])
  })

  test("domain-pack member missing packSnapshotRef -> exact path", () => {
    const input = makeDomainPack() as unknown as Record<string, unknown>
    delete input.packSnapshotRef
    let path: readonly string[] = []
    try {
      decodeSessionContentLoad(input)
    } catch (error) {
      if (error instanceof CapabilityLoadDecodeError) path = error.path
    }
    expect(path).toEqual(["packSnapshotRef"])
  })

  test("capability member missing required common field -> exact path", () => {
    const input = makeReceipt() as unknown as Record<string, unknown>
    delete input.bodyHash
    let path: readonly string[] = []
    try {
      decodeSessionContentLoad(input)
    } catch (error) {
      if (error instanceof CapabilityLoadDecodeError) path = error.path
    }
    expect(path).toEqual(["bodyHash"])
  })
})
