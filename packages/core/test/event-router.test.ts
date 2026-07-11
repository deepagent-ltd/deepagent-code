import { describe, expect, test } from "bun:test"
import { EventRouter } from "@deepagent-code/core/deepagent/event-router"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"

// EventRouter.route is a PURE function — no Effect/DB, so these are plain unit tests.

const agent = (over?: Partial<AgentDescriptor>): AgentDescriptor => ({
  id: "agt_ci",
  name: "CodeFixAgent",
  displayName: "Code Fix Agent",
  visible: true,
  triggers: [{ event: "ci.failure" }],
  ...over,
})

const event = (over?: Partial<DeepAgentEvent.Event>): DeepAgentEvent.Event => ({
  id: DeepAgentEvent.ID.create(1_000),
  type: "ci.failure",
  source: "ci",
  workspaceID: "wrk_1",
  idempotencyKey: "k",
  priority: "normal",
  createdAt: 1_000,
  payload: {},
  ...over,
})

describe("EventRouter.matches", () => {
  test("exact + wildcard matching", () => {
    expect(EventRouter.matches("ci.failure", "ci.failure")).toBe(true)
    expect(EventRouter.matches("ci.failure", "ci.success")).toBe(false)
    expect(EventRouter.matches("*", "anything.here")).toBe(true)
    expect(EventRouter.matches("agent.*", "agent.task.started")).toBe(true)
    expect(EventRouter.matches("agent.*", "agent")).toBe(false) // prefix keeps the dot
    expect(EventRouter.matches("agent.*", "agentx.foo")).toBe(false)
  })
})

describe("EventRouter.route", () => {
  test("§A4 flag gate: a disabled flag drops fail-closed", () => {
    const d = EventRouter.route({ event: event(), agents: [agent()], flagEnabled: false })
    expect(d).toEqual({ type: "dropped", reason: "flag_disabled" })
  })

  test("§A4 type match: no subscribing agent drops as no_match", () => {
    const d = EventRouter.route({
      event: event({ type: "pr.comment" }),
      agents: [agent()], // only triggers on ci.failure
      flagEnabled: true,
    })
    expect(d).toEqual({ type: "dropped", reason: "no_match" })
  })

  test("§A4 dispatch: matched agents returned at the event priority", () => {
    const fixer = agent()
    const reviewer = agent({ id: "agt_rev", name: "ReviewAgent", triggers: [{ event: "ci.*" }] })
    const noise = agent({ id: "agt_x", name: "X", triggers: [{ event: "git.push" }] })
    const d = EventRouter.route({
      event: event({ priority: "high" }),
      agents: [fixer, reviewer, noise],
      flagEnabled: true,
    })
    expect(d.type).toBe("dispatch")
    if (d.type === "dispatch") {
      expect(d.priority).toBe("high")
      expect(d.targets.map((a) => a.id)).toEqual(["agt_ci", "agt_rev"]) // registry order, noise excluded
    }
  })

  test("§A4 去重窗口: a LOW-priority duplicate merges into the recent event", () => {
    const recent = event({ id: DeepAgentEvent.ID.create(900), idempotencyKey: "older" })
    const d = EventRouter.route({
      event: event({ priority: "low", idempotencyKey: "newer" }),
      agents: [agent()],
      flagEnabled: true,
      recentSameType: [recent],
    })
    expect(d).toEqual({ type: "dropped", reason: "deduped", mergedInto: recent.id })
  })

  test("§A4 去重窗口: NORMAL priority is never merged even with a recent duplicate", () => {
    const recent = event({ id: DeepAgentEvent.ID.create(900), idempotencyKey: "older" })
    const d = EventRouter.route({
      event: event({ priority: "normal" }),
      agents: [agent()],
      flagEnabled: true,
      recentSameType: [recent],
    })
    expect(d.type).toBe("dispatch")
  })

  test("§A4 去重窗口: dedup ignores the event itself in the recent set", () => {
    const self = event({ priority: "low", idempotencyKey: "self" })
    const d = EventRouter.route({
      event: self,
      agents: [agent()],
      flagEnabled: true,
      recentSameType: [self], // only itself present ⇒ no merge target
    })
    expect(d.type).toBe("dispatch")
  })

  test("§A4 回压: a full queue drops low/normal but admits high/critical", () => {
    const base = { agents: [agent()], flagEnabled: true, queueDepth: 10, maxQueueDepth: 10 }
    expect(EventRouter.route({ ...base, event: event({ priority: "normal" }) })).toEqual({
      type: "dropped",
      reason: "backpressure",
    })
    expect(EventRouter.route({ ...base, event: event({ priority: "low", idempotencyKey: "l" }) }).type).toBe(
      "dropped",
    )
    expect(EventRouter.route({ ...base, event: event({ priority: "high" }) }).type).toBe("dispatch")
    expect(EventRouter.route({ ...base, event: event({ priority: "critical" }) }).type).toBe("dispatch")
  })

  test("§A4 回压: non-positive maxQueueDepth means no limit (not always-full)", () => {
    for (const cap of [0, -5]) {
      const d = EventRouter.route({
        event: event({ priority: "normal" }),
        agents: [agent()],
        flagEnabled: true,
        queueDepth: 100,
        maxQueueDepth: cap,
      })
      expect(d.type).toBe("dispatch") // a 0/negative cap must NOT drop everything
    }
  })

  test("§A4 回压: below capacity everything admits", () => {
    const d = EventRouter.route({
      event: event({ priority: "normal" }),
      agents: [agent()],
      flagEnabled: true,
      queueDepth: 3,
      maxQueueDepth: 10,
    })
    expect(d.type).toBe("dispatch")
  })
})
