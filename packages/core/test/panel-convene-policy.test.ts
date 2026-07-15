import { describe, expect, test } from "bun:test"
import { PanelConvenePolicy } from "@deepagent-code/core/deepagent/panel-convene-policy"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"

// PanelConvenePolicy.shouldConvene is PURE — plain unit tests.

const event = (over?: Partial<DeepAgentEvent.Event>): DeepAgentEvent.Event => ({
  id: DeepAgentEvent.ID.create(1_000),
  type: "pr.comment",
  source: "pr",
  workspaceID: "wrk_1",
  idempotencyKey: "k",
  priority: "normal",
  createdAt: 1_000,
  payload: {},
  ...over,
})

describe("PanelConvenePolicy.shouldConvene", () => {
  test("§M flag off → skip flag_disabled (no auto-convene, panels still exist for explicit convening)", () => {
    const d = PanelConvenePolicy.shouldConvene({
      event: event({ payload: { destructive: true } }),
      flagEnabled: false,
    })
    expect(d).toEqual({ type: "skip", reason: "flag_disabled" })
  })

  test("§M no risk match → skip", () => {
    const d = PanelConvenePolicy.shouldConvene({ event: event({ payload: {} }), flagEnabled: true })
    expect(d).toEqual({ type: "skip", reason: "no_risk_match" })
  })

  test("§M destructive migration PR → convene, urgency floored to high (survives backpressure)", () => {
    const d = PanelConvenePolicy.shouldConvene({
      event: event({ type: "pr.comment", priority: "normal", payload: { migration: true } }),
      flagEnabled: true,
    })
    expect(d.type).toBe("convene")
    if (d.type === "convene") {
      expect(d.riskClass).toBe("destructive_migration")
      expect(d.urgency).toBe("high") // floored from normal so §A4 backpressure can't drop it
    }
  })

  test("§M security alert → convene, urgency escalated to at least high", () => {
    const d = PanelConvenePolicy.shouldConvene({
      event: event({ type: "monitor.alert", source: "monitor", priority: "normal", payload: { category: "security" } }),
      flagEnabled: true,
    })
    expect(d.type).toBe("convene")
    if (d.type === "convene") {
      expect(d.riskClass).toBe("security")
      expect(d.urgency).toBe("high") // escalated from normal
    }
  })

  test("§M security alert keeps critical urgency (not downgraded)", () => {
    const d = PanelConvenePolicy.shouldConvene({
      event: event({ type: "monitor.alert", source: "monitor", priority: "critical", payload: { severity: "critical" } }),
      flagEnabled: true,
    })
    expect(d.type === "convene" && d.urgency).toBe("critical")
  })

  test("§M architecture change → convene", () => {
    const d = PanelConvenePolicy.shouldConvene({
      event: event({ type: "pr.comment", payload: { architectureChange: true } }),
      flagEnabled: true,
    })
    expect(d.type === "convene" && d.riskClass).toBe("architecture_change")
  })

  test("§M repeated CI failure (>=3) → convene; <3 does not", () => {
    const three = PanelConvenePolicy.shouldConvene({
      event: event({ type: "ci.failure", source: "ci", payload: { consecutiveFailures: 3 } }),
      flagEnabled: true,
    })
    expect(three.type === "convene" && three.riskClass).toBe("repeated_failure")
    const two = PanelConvenePolicy.shouldConvene({
      event: event({ type: "ci.failure", source: "ci", payload: { consecutiveFailures: 2 } }),
      flagEnabled: true,
    })
    expect(two.type).toBe("skip")
  })

  test("§M a non-destructive PR comment does not convene", () => {
    const d = PanelConvenePolicy.shouldConvene({
      event: event({ type: "pr.comment", payload: { destructive: false } }),
      flagEnabled: true,
    })
    expect(d.type).toBe("skip")
  })

  test("custom rules override defaults", () => {
    const rules = [{ match: "custom.*", riskClass: "security" as const }]
    const d = PanelConvenePolicy.shouldConvene({
      event: event({ type: "custom.thing", source: "system" }),
      flagEnabled: true,
      rules,
    })
    expect(d.type === "convene" && d.riskClass).toBe("security")
  })

  test("hostile payload (null/non-object) does not throw", () => {
    for (const payload of [null, "str", 42, []]) {
      const d = PanelConvenePolicy.shouldConvene({
        event: event({ payload }),
        flagEnabled: true,
      })
      expect(d.type).toBe("skip") // no crash, just no match
    }
  })
})
