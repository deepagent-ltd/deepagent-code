import { describe, expect, test } from "bun:test"
import { TaskPartitioner } from "@deepagent-code/core/deepagent/task-partitioner"
import { DeepAgentEvent } from "@deepagent-code/core/deepagent/deepagent-event"
import type { AgentDescriptor } from "@deepagent-code/core/im/mention-parser"

// TaskPartitioner.partition is a PURE function — plain unit tests.

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

describe("TaskPartitioner.partition", () => {
  test("§C2 ci.failure → CodeFix then TestAgent, test depends on the fix", () => {
    const p = TaskPartitioner.partition(event({ type: "ci.failure" }), { idAt: 1 })
    expect(p.subtasks.map((s) => s.capability)).toEqual(["code_edit", "test_run"])
    expect(p.subtasks[0].dependsOn).toEqual([]) // fix first
    expect(p.subtasks[1].dependsOn).toEqual([p.subtasks[0].id]) // test depends on fix
    expect(p.subtasks.every((s) => s.requiredAutonomy === "level_2")).toBe(true)
  })

  test("§C2 pr.comment → analyze → code → review linear pipeline", () => {
    const p = TaskPartitioner.partition(event({ type: "pr.comment", source: "pr" }), { idAt: 100 })
    expect(p.subtasks.map((s) => s.capability)).toEqual(["analyze", "code_edit", "review"])
    expect(p.subtasks[1].dependsOn).toEqual([p.subtasks[0].id])
    expect(p.subtasks[2].dependsOn).toEqual([p.subtasks[1].id])
    // analyze + review are read-only level_1; the edit is level_2
    expect(p.subtasks.map((s) => s.requiredAutonomy)).toEqual(["level_1", "level_2", "level_1"])
  })

  test("§C2 monitor.alert → diagnose then propose-fix", () => {
    const p = TaskPartitioner.partition(event({ type: "monitor.alert", source: "monitor" }), { idAt: 200 })
    expect(p.subtasks.map((s) => s.capability)).toEqual(["diagnose", "code_edit"])
    expect(p.subtasks[1].dependsOn).toEqual([p.subtasks[0].id])
  })

  test("unknown event → single conservative level_0 fallback subtask", () => {
    const p = TaskPartitioner.partition(event({ type: "something.weird", source: "system" }), { idAt: 300 })
    expect(p.subtasks.length).toBe(1)
    expect(p.subtasks[0].capability).toBe("handle")
    expect(p.subtasks[0].requiredAutonomy).toBe("level_0")
  })

  test("§C2 file scope is derived from event payload.files and applied to every subtask", () => {
    const p = TaskPartitioner.partition(
      event({ type: "ci.failure", payload: { files: ["src/a.ts", "src/b.ts"] } }),
      { idAt: 400 },
    )
    expect(p.subtasks.every((s) => s.fileScope.length === 2)).toBe(true)
    expect(p.subtasks[0].fileScope).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("scopeOf ignores a malformed payload", () => {
    expect(TaskPartitioner.scopeOf(event({ payload: { files: "not-an-array" } }))).toEqual([])
    expect(TaskPartitioner.scopeOf(event({ payload: null }))).toEqual([])
    expect(TaskPartitioner.scopeOf(event({ payload: { files: [1, 2] } }))).toEqual([])
  })

  test("rejects a custom rule with a forward/out-of-range dependency (no cyclic/dangling DAG)", () => {
    const forwardRef = [
      {
        match: "bad.*",
        steps: [
          { capability: "a", intent: "a", dependsOnIdx: [1], requiredAutonomy: "level_1" as const }, // forward ref
          { capability: "b", intent: "b", dependsOnIdx: [], requiredAutonomy: "level_1" as const },
        ],
      },
    ]
    expect(() =>
      TaskPartitioner.partition(event({ type: "bad.thing", source: "system" }), { rules: forwardRef, idAt: 800 }),
    ).toThrow()
    const outOfRange = [
      { match: "bad2.*", steps: [{ capability: "a", intent: "a", dependsOnIdx: [5], requiredAutonomy: "level_1" as const }] },
    ]
    expect(() =>
      TaskPartitioner.partition(event({ type: "bad2.x", source: "system" }), { rules: outOfRange, idAt: 810 }),
    ).toThrow()
  })

  test("custom rules override the defaults", () => {
    const rules = [
      { match: "custom.*", steps: [{ capability: "x", intent: "do x", dependsOnIdx: [], requiredAutonomy: "level_3" as const }] },
    ]
    const p = TaskPartitioner.partition(event({ type: "custom.thing", source: "system" }), { rules, idAt: 500 })
    expect(p.subtasks.map((s) => s.capability)).toEqual(["x"])
    expect(p.subtasks[0].requiredAutonomy).toBe("level_3")
  })
})

describe("TaskPartitioner.capableAgents", () => {
  const agent = (id: string, caps: string[]): AgentDescriptor => ({
    id,
    name: id,
    displayName: id,
    visible: true,
    capabilities: caps,
  })

  test("filters agents that declare the subtask capability, in registry order", () => {
    const p = TaskPartitioner.partition(event({ type: "ci.failure" }), { idAt: 600 })
    const fixTask = p.subtasks[0] // needs code_edit
    const agents = [agent("a", ["test_run"]), agent("b", ["code_edit", "test_run"]), agent("c", ["code_edit"])]
    expect(TaskPartitioner.capableAgents(fixTask, agents).map((a) => a.id)).toEqual(["b", "c"])
  })

  test("no capable agent ⇒ empty (runtime must block)", () => {
    const p = TaskPartitioner.partition(event({ type: "ci.failure" }), { idAt: 700 })
    expect(TaskPartitioner.capableAgents(p.subtasks[0], [agent("a", ["review"])])).toEqual([])
  })
})
