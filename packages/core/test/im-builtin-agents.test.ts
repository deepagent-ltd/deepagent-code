// V4.0 §A1 — BUILT-IN agent descriptors: prove the trigger/capability metadata is
// present and matchable, so the autonomous event path is no longer dead (every
// autonomous event used to block with `no_capable_agent` because the core provider
// emitted metadata-less descriptors). These tests match directly over the built-in
// set with the same pure matchers the runtime uses.

import { describe, it, expect } from "bun:test"
import { Schema } from "effect"
import { AgentDescriptor } from "../src/im/mention-parser"
import { matchByTrigger, matchByCapability } from "../src/im/agent-list-provider"
import { BUILTIN_AGENT_DESCRIPTORS } from "../src/im/builtin-agents"
import { TaskPartitioner } from "../src/deepagent/task-partitioner"
import { DeepAgentEvent } from "../src/deepagent/deepagent-event"

const decode = Schema.decodeUnknownSync(AgentDescriptor)

describe("BUILTIN_AGENT_DESCRIPTORS — shape + name resolution", () => {
  it("every built-in is a schema-valid AgentDescriptor", () => {
    for (const d of BUILTIN_AGENT_DESCRIPTORS) {
      expect(() => decode(d)).not.toThrow()
    }
  })

  it("every built-in runs as a REAL resolvable agent (auto/general/plan) and is hidden from mention UI", () => {
    const realAgents = new Set(["auto", "general", "plan"])
    for (const d of BUILTIN_AGENT_DESCRIPTORS) {
      expect(realAgents.has(d.name)).toBe(true)
      expect(d.visible).toBe(false) // matchable, but not in the human @mention list
    }
  })

  it("built-in ids are distinct", () => {
    const ids = BUILTIN_AGENT_DESCRIPTORS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe("BUILTIN_AGENT_DESCRIPTORS — matchByTrigger", () => {
  it("ci.failure matches CodeFixAgent (code_edit + test_run)", () => {
    const matched = matchByTrigger(BUILTIN_AGENT_DESCRIPTORS, "ci.failure")
    expect(matched.some((d) => d.id === "builtin:codefix")).toBe(true)
  })

  it("ci.repair.requested matches CodeFixAgent", () => {
    expect(matchByTrigger(BUILTIN_AGENT_DESCRIPTORS, "ci.repair.requested").some((d) => d.id === "builtin:codefix")).toBe(
      true,
    )
  })

  it("every autonomous trigger resolves to >=1 capable agent", () => {
    for (const evt of ["ci.failure", "pr.comment", "monitor.alert", "git.push", "schedule.scan", "ci.repair.requested"]) {
      expect(matchByTrigger(BUILTIN_AGENT_DESCRIPTORS, evt).length).toBeGreaterThan(0)
    }
  })

  it("TestAgent is NOT trigger-matched (matched by capability only)", () => {
    const all = ["ci.failure", "pr.comment", "monitor.alert", "git.push", "schedule.scan", "ci.repair.requested"]
    for (const evt of all) {
      expect(matchByTrigger(BUILTIN_AGENT_DESCRIPTORS, evt).some((d) => d.id === "builtin:test")).toBe(false)
    }
  })
})

describe("BUILTIN_AGENT_DESCRIPTORS — matchByCapability", () => {
  it("code_edit matches CodeFixAgent + ChangeAgent", () => {
    const ids = matchByCapability(BUILTIN_AGENT_DESCRIPTORS, "code_edit").map((d) => d.id)
    expect(ids).toContain("builtin:codefix")
    expect(ids).toContain("builtin:change")
  })

  it("test_run matches CodeFixAgent + TestAgent", () => {
    const ids = matchByCapability(BUILTIN_AGENT_DESCRIPTORS, "test_run").map((d) => d.id)
    expect(ids).toContain("builtin:codefix")
    expect(ids).toContain("builtin:test")
  })

  it("the partitioner's required capabilities each resolve to >=1 agent", () => {
    // DEFAULT_RULES capabilities: ci.failure→code_edit,test_run; pr.comment→analyze,code_edit,review;
    // monitor.alert→diagnose,code_edit. Plus the maintenance capability for schedule.scan.
    for (const cap of ["code_edit", "test_run", "analyze", "review", "diagnose", "maintain"]) {
      expect(matchByCapability(BUILTIN_AGENT_DESCRIPTORS, cap).length).toBeGreaterThan(0)
    }
  })
})

// The real end-to-end binding path: PARTITION the event (not just trigger-match), then run capableAgents
// over the built-in set for EVERY subtask. This catches the fallbackStep()/"handle" gap — an event with
// no DEFAULT_RULES rule decomposes to the generic `handle` capability, which no built-in declares. Every
// one of the six autonomous event types must bind a capable built-in for every subtask (no empty result).
describe("BUILTIN_AGENT_DESCRIPTORS — partition + capableAgents (real binding, no no_capable_agent)", () => {
  const event = (type: string, source: DeepAgentEvent.Event["source"]): DeepAgentEvent.Event => ({
    id: DeepAgentEvent.ID.create(1_000),
    type,
    source,
    workspaceID: "wrk_1",
    idempotencyKey: "k",
    priority: "normal",
    createdAt: 1_000,
    payload: {},
  })

  const cases: ReadonlyArray<{ type: string; source: DeepAgentEvent.Event["source"]; expect: ReadonlyArray<{ cap: string; agent: string }> }> = [
    { type: "ci.failure", source: "ci", expect: [{ cap: "code_edit", agent: "builtin:codefix" }, { cap: "test_run", agent: "builtin:codefix" }] },
    { type: "ci.repair.requested", source: "ci", expect: [{ cap: "code_edit", agent: "builtin:codefix" }, { cap: "test_run", agent: "builtin:codefix" }] },
    { type: "pr.comment", source: "im", expect: [{ cap: "analyze", agent: "builtin:codereview" }, { cap: "code_edit", agent: "builtin:codefix" }, { cap: "review", agent: "builtin:codereview" }] },
    { type: "monitor.alert", source: "monitor", expect: [{ cap: "diagnose", agent: "builtin:diagnosis" }, { cap: "code_edit", agent: "builtin:codefix" }] },
    { type: "git.push", source: "git", expect: [{ cap: "review", agent: "builtin:codereview" }] },
    { type: "schedule.scan", source: "system", expect: [{ cap: "maintain", agent: "builtin:maintenance" }] },
  ]

  for (const c of cases) {
    it(`${c.type} partitions and every subtask binds a capable built-in (no empty capableAgents)`, () => {
      const partition = TaskPartitioner.partition(event(c.type, c.source), { idAt: 1 })
      // the DAG must NOT fall back to the generic "handle" step (that has no capable built-in).
      expect(partition.subtasks.some((s) => s.capability === "handle")).toBe(false)
      expect(partition.subtasks.map((s) => s.capability)).toEqual(c.expect.map((e) => e.cap))
      for (let i = 0; i < partition.subtasks.length; i++) {
        const capable = TaskPartitioner.capableAgents(partition.subtasks[i], BUILTIN_AGENT_DESCRIPTORS)
        expect(capable.length).toBeGreaterThan(0) // never no_capable_agent
        // first-in-registry-order bind is the expected built-in.
        expect(capable[0].id).toBe(c.expect[i].agent)
      }
    })
  }
})
