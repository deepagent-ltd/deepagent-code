import { describe, expect, test } from "bun:test"
import { subagentIsWriteType } from "../../src/agent/subagent-permissions"
import type { Agent } from "../../src/agent/agent"

// I33-3: subagentIsWriteType decides the default isolation for a spawned subagent — write-type ⇒ git
// worktree (edits propagated back on completion), read-only ⇒ shared parent dir. It evaluates the
// subagent's own permission ruleset (last matching rule wins; unmatched ⇒ "ask", still write-capable),
// and is read-only only when EVERY edit-class tool (edit/write/patch/bash) resolves to "deny".

const agent = (permission: Agent.Info["permission"]): Agent.Info =>
  ({ name: "t", permission }) as unknown as Agent.Info

describe("I33-3 subagentIsWriteType", () => {
  test("empty ruleset ⇒ WRITE-type (unmatched edit-class ⇒ 'ask', not 'deny')", () => {
    // A subagent with no explicit denies can still edit (the runtime would 'ask'); treat as write-type
    // so it gets isolation rather than silently sharing the parent dir.
    expect(subagentIsWriteType(agent([]))).toBe(true)
  })

  test("all edit-class DENIED ⇒ READ-ONLY", () => {
    const readonly = ["edit", "write", "patch", "bash"].map((permission) => ({
      permission,
      pattern: "**",
      action: "deny" as const,
    }))
    expect(subagentIsWriteType(agent(readonly))).toBe(false)
  })

  test("edit allowed but others denied ⇒ WRITE-type (any one edit-class ⇒ write)", () => {
    const rules = [
      { permission: "edit", pattern: "**", action: "allow" as const },
      { permission: "write", pattern: "**", action: "deny" as const },
      { permission: "patch", pattern: "**", action: "deny" as const },
      { permission: "bash", pattern: "**", action: "deny" as const },
    ]
    expect(subagentIsWriteType(agent(rules))).toBe(true)
  })

  test("only bash allowed (shell can mutate) ⇒ WRITE-type", () => {
    const rules = [
      { permission: "edit", pattern: "**", action: "deny" as const },
      { permission: "write", pattern: "**", action: "deny" as const },
      { permission: "patch", pattern: "**", action: "deny" as const },
      { permission: "bash", pattern: "**", action: "allow" as const },
    ]
    expect(subagentIsWriteType(agent(rules))).toBe(true)
  })

  test("last matching rule wins: a later deny overrides an earlier allow ⇒ that tool denied", () => {
    // edit allow then edit deny ⇒ edit resolves deny; with all others denied too ⇒ read-only.
    const rules = [
      { permission: "edit", pattern: "**", action: "allow" as const },
      { permission: "edit", pattern: "**", action: "deny" as const },
      { permission: "write", pattern: "**", action: "deny" as const },
      { permission: "patch", pattern: "**", action: "deny" as const },
      { permission: "bash", pattern: "**", action: "deny" as const },
    ]
    expect(subagentIsWriteType(agent(rules))).toBe(false)
  })
})
