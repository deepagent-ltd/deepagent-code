import { describe, expect, test, beforeEach } from "bun:test"
import { Hash } from "@deepagent-code/core/util/hash"
import {
  CapabilityL2BudgetExceededError,
  CapabilityTurnBudgetExceededError,
  capabilityLoad,
  resetCapabilityLoader,
  turnBudgetView,
} from "@deepagent-code/core/system-context/capability-loader"

// C4-05 — `capability_load` L2 + bounded per-turn budget: the frozen L2
// single-body ceiling (1200 tokens) and the per-turn ≤2 bodies / ≤2400 new tokens
// budget, with idempotent accounting so an exact retry never double-charges.

const digestOf = (body: string): string => `sha256:${Hash.sha256(body)}`

const SESSION = "session-1"
const TURN = "turn-1"

const codeRead = "Read and search source files: use read/glob/grep and trace references before editing."
const codeEdit = "Edit files with exact changes: apply-patch then re-read the diff."
const shellExec = "Execute shell commands in the active workspace: run builds and tests."

function load(capabilityId: string, body: string, turn = TURN, session = SESSION) {
  const bodyHash = digestOf(body)
  return capabilityLoad({
    capabilityId,
    version: "1.0.0-beta.0",
    bodyHash,
    runtimeHash: "rt-1",
    permissionHash: "perm-1",
    bodyRef: `capability://${capabilityId}@1.0.0-beta.0`,
    sessionIdentity: session,
    turnIdentity: turn,
    body,
    declaredDigest: bodyHash,
  })
}

beforeEach(() => resetCapabilityLoader())

describe("capability_load L2 single-body budget", () => {
  test("a body over the frozen L2 ceiling throws the typed L2 error", () => {
    const body = "x".repeat(5000) // 1250 tokens by char estimate (4 chars/token)
    expect(() => load("deepagent.web-research", body)).toThrow(CapabilityL2BudgetExceededError)
  })

  test("an L2-exceeding bound reports the exact level and limits (fail-closed)", () => {
    const body = "y".repeat(5000) // deterministic but still > 1200 tokens
    try {
      load("deepagent.web-research", body)
      throw new Error("expected CapabilityL2BudgetExceededError")
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityL2BudgetExceededError)
      if (error instanceof CapabilityL2BudgetExceededError) {
        expect(error._tag).toBe("capability_l2_budget_exceeded")
        expect(error.level).toBe("L2")
        expect(error.limitTokens).toBe(1200)
        expect(error.requestedTokens).toBeGreaterThan(1200)
      }
    }
  })

  test("an in-budget body loads and returns available", () => {
    const result = load("deepagent.code-read", codeRead)
    expect(result.state).toBe("available")
  })
})

describe("capability_load per-turn budget", () => {
  test("the 3rd distinct body in one turn is a typed turn-budget error", () => {
    expect(load("deepagent.code-read", codeRead).state).toBe("available")
    expect(load("deepagent.code-edit", codeEdit).state).toBe("available")
    expect(() => load("deepagent.shell-execute", shellExec)).toThrow(CapabilityTurnBudgetExceededError)
    const view = turnBudgetView(SESSION, TURN)
    expect(view.newLoads).toBe(2)
    expect(view.newTokens).toBeGreaterThan(0)
  })

  test("an exact retry within the same turn is idempotent (no double charge)", () => {
    const first = load("deepagent.code-read", codeRead)
    expect(first.state).toBe("available")
    const retry = load("deepagent.code-read", codeRead)
    expect(retry.state).toBe("existing")
    expect(turnBudgetView(SESSION, TURN).newLoads).toBe(1)
  })

  test("a different session does not share the turn budget", () => {
    expect(load("deepagent.code-read", codeRead, TURN, "session-a").state).toBe("available")
    expect(load("deepagent.code-edit", codeEdit, TURN, "session-b").state).toBe("available")
    expect(turnBudgetView("session-a", TURN).newLoads).toBe(1)
    expect(turnBudgetView("session-b", TURN).newLoads).toBe(1)
  })

  test("cross-turn: a new turn resets the per-turn counter", () => {
    expect(load("deepagent.code-read", codeRead, "turn-1").state).toBe("available")
    expect(turnBudgetView(SESSION, "turn-1").newLoads).toBe(1)
    expect(turnBudgetView(SESSION, "turn-2").newLoads).toBe(0)

    expect(load("deepagent.code-edit", codeEdit, "turn-2").state).toBe("available")
    expect(load("deepagent.shell-execute", shellExec, "turn-2").state).toBe("available")
    expect(turnBudgetView(SESSION, "turn-2").newLoads).toBe(2)
    expect(() => load("deepagent.code-read", codeRead, "turn-2")).toThrow(CapabilityTurnBudgetExceededError)
  })
})
