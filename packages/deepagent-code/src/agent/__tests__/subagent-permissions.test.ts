/**
 * F5: subagent depth limit + unified admission tests
 *
 * Acceptance criteria from 4.0.4_r4.md §F5:
 *  1. Default researcher, reviewer, explore still cannot delegate task.
 *  2. Explicitly allowed agent can delegate within depth limit.
 *  3. Unauthorised target is still denied.
 *  4. depth=3 cannot delegate regardless of config.
 *  5. admitChildOrFail covers normal, background, takeover and resume paths consistently.
 *  6. Plan Mode parent deny, Goal Loop plan capability and worktree rules do not regress.
 */

import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import {
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_DEPTH_META_KEY,
  canDelegateTask,
  admitChildOrFail,
  resolveSessionDepth,
  deriveSubagentSessionPermission,
  subagentIsWriteType,
  PLAN_WRITE_OWN_GOAL,
} from "../subagent-permissions"
import type { Agent } from "../agent"
import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { SessionID } from "../../session/schema"
import type { Session } from "../../session/session"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(name: string, rules: PermissionV1.Rule[]): Agent.Info {
  return {
    name,
    mode: "all",
    permission: rules,
    options: {},
    native: false,
  }
}

function makeRule(
  permission: string,
  action: "allow" | "deny" | "ask",
  pattern = "*",
): PermissionV1.Rule {
  return { permission, action, pattern }
}

// Default "star deny" that researcher/reviewer/explore/goal-worker have.
const STAR_DENY: PermissionV1.Rule[] = [makeRule("*", "deny")]
// Explicit task allow rule (custom agents).
const TASK_ALLOW: PermissionV1.Rule[] = [makeRule("task", "allow")]

// ---------------------------------------------------------------------------
// A. MAX_SUBAGENT_DEPTH constant
// ---------------------------------------------------------------------------

describe("MAX_SUBAGENT_DEPTH", () => {
  it("is 3", () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// B. canDelegateTask — permission-only check (no depth)
// ---------------------------------------------------------------------------

describe("canDelegateTask", () => {
  it("returns false when caller agent has '*: deny' (researcher/reviewer/explore default)", () => {
    expect(canDelegateTask(STAR_DENY, [], "researcher")).toBe(false)
    expect(canDelegateTask(STAR_DENY, [], "explore")).toBe(false)
    expect(canDelegateTask(STAR_DENY, [], "reviewer")).toBe(false)
    expect(canDelegateTask(STAR_DENY, [], "goal-worker")).toBe(false)
  })

  it("returns false when caller has no task rule at all (unmatched → ask, not allow)", () => {
    expect(canDelegateTask([], [], "researcher")).toBe(false)
  })

  it("returns true when caller agent has explicit task allow", () => {
    expect(canDelegateTask(TASK_ALLOW, [], "researcher")).toBe(true)
  })

  it("session permission overrides agent permission (last-match-wins)", () => {
    // Agent says deny, session adds allow → allow wins.
    const sessionAllow: PermissionV1.Rule[] = [makeRule("task", "allow")]
    expect(canDelegateTask(STAR_DENY, sessionAllow, "researcher")).toBe(true)

    // Agent says allow, session adds deny → deny wins.
    const sessionDeny: PermissionV1.Rule[] = [makeRule("task", "deny")]
    expect(canDelegateTask(TASK_ALLOW, sessionDeny, "researcher")).toBe(false)
  })

  it("pattern matching: allow for specific type only", () => {
    const allowExplore: PermissionV1.Rule[] = [makeRule("task", "allow", "explore")]
    expect(canDelegateTask(allowExplore, [], "explore")).toBe(true)
    expect(canDelegateTask(allowExplore, [], "researcher")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// C. admitChildOrFail — depth + permission gate
// ---------------------------------------------------------------------------

describe("admitChildOrFail", () => {
  it("AC4: depth >= MAX_SUBAGENT_DEPTH → error regardless of permission", () => {
    const result = admitChildOrFail({
      callerDepth: MAX_SUBAGENT_DEPTH,
      callerAgentPermission: TASK_ALLOW,
      callerSessionPermission: [],
      targetAgentType: "researcher",
    })
    expect("error" in result).toBe(true)
    expect((result as { error: string }).error).toMatch(/depth limit/)
  })

  it("depth 3 with explicit allow still blocked (hard ceiling)", () => {
    const result = admitChildOrFail({
      callerDepth: 3,
      callerAgentPermission: TASK_ALLOW,
      callerSessionPermission: [],
      targetAgentType: "general",
    })
    expect("error" in result).toBe(true)
  })

  it("depth 0, no permission → error for unauthorised target", () => {
    const result = admitChildOrFail({
      callerDepth: 0,
      callerAgentPermission: STAR_DENY,
      callerSessionPermission: [],
      targetAgentType: "researcher",
    })
    expect("error" in result).toBe(true)
    expect((result as { error: string }).error).toMatch(/permission/)
  })

  it("AC2: depth 0, explicit allow → admitted with childDepth=1", () => {
    const result = admitChildOrFail({
      callerDepth: 0,
      callerAgentPermission: TASK_ALLOW,
      callerSessionPermission: [],
      targetAgentType: "researcher",
    })
    expect("childDepth" in result).toBe(true)
    expect((result as { childDepth: number }).childDepth).toBe(1)
  })

  it("depth 2, explicit allow → admitted with childDepth=3 (equals MAX, still ok)", () => {
    const result = admitChildOrFail({
      callerDepth: 2,
      callerAgentPermission: TASK_ALLOW,
      callerSessionPermission: [],
      targetAgentType: "explore",
    })
    expect("childDepth" in result).toBe(true)
    expect((result as { childDepth: number }).childDepth).toBe(3)
  })

  it("depth 4 (corrupted/injected) → error even with allow", () => {
    const result = admitChildOrFail({
      callerDepth: 4,
      callerAgentPermission: TASK_ALLOW,
      callerSessionPermission: [],
      targetAgentType: "researcher",
    })
    expect("error" in result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// D. resolveSessionDepth — metadata path, chain path, conflict resolution
// ---------------------------------------------------------------------------

describe("resolveSessionDepth", () => {
  // SessionID requires "ses" prefix — use ses_ prefixed keys throughout.
  const S = {
    root: "ses_root0000000000",
    child: "ses_child000000000",
    grand: "ses_grand000000000",
    a: "ses_aaaaaaaaaaaaaaaa",
    b: "ses_bbbbbbbbbbbbbbbb",
    none: "ses_nonexistent0000",
  } as const

  function makeSessionsService(
    sessions: Record<string, { parentID?: string; metadata?: Record<string, unknown> }>,
  ): Session.Interface {
    return {
      get: (id: SessionID) =>
        Effect.gen(function* () {
          const s = sessions[id]
          if (!s) return yield* Effect.fail({ message: `not found: ${id}` } as never)
          return {
            id,
            parentID: s.parentID as SessionID | undefined,
            metadata: s.metadata,
          } as Session.Info
        }),
    } as unknown as Session.Interface
  }

  it("root session (no parent, no metadata) → depth 0", async () => {
    const svc = makeSessionsService({ [S.root]: {} })
    const depth = await Effect.runPromise(resolveSessionDepth(svc, SessionID.make(S.root)))
    expect(depth).toBe(0)
  })

  it("reads depth from metadata when present", async () => {
    const svc = makeSessionsService({
      [S.root]: {},
      [S.child]: {
        parentID: S.root,
        metadata: { deepagent: { [SUBAGENT_DEPTH_META_KEY]: 1 } },
      },
    })
    const depth = await Effect.runPromise(resolveSessionDepth(svc, SessionID.make(S.child)))
    expect(depth).toBe(1)
  })

  it("walks parentID chain for historical sessions without metadata", async () => {
    const svc = makeSessionsService({
      [S.root]: {},
      [S.child]: { parentID: S.root },
      [S.grand]: { parentID: S.child },
    })
    const depth = await Effect.runPromise(resolveSessionDepth(svc, SessionID.make(S.grand)))
    expect(depth).toBe(2)
  })

  it("prefers stricter value when metadata conflicts with chain", async () => {
    // metadata says depth=1, chain says depth=2 → use 2 (stricter)
    const svc = makeSessionsService({
      [S.root]: {},
      [S.a]: { parentID: S.root },
      [S.b]: { parentID: S.a, metadata: { deepagent: { [SUBAGENT_DEPTH_META_KEY]: 1 } } },
    })
    const depth = await Effect.runPromise(resolveSessionDepth(svc, SessionID.make(S.b)))
    expect(depth).toBe(2)
  })

  it("fails closed at MAX_SUBAGENT_DEPTH on cycle detection", async () => {
    const svc = makeSessionsService({
      [S.a]: { parentID: S.b },
      [S.b]: { parentID: S.a }, // cycle: a→b→a
    })
    const depth = await Effect.runPromise(resolveSessionDepth(svc, SessionID.make(S.a)))
    expect(depth).toBe(MAX_SUBAGENT_DEPTH)
  })

  it("fails closed at MAX_SUBAGENT_DEPTH on unknown session", async () => {
    const svc = makeSessionsService({})
    const depth = await Effect.runPromise(resolveSessionDepth(svc, SessionID.make(S.none)))
    expect(depth).toBe(MAX_SUBAGENT_DEPTH)
  })

  it("fails closed on super-long chain (over limit)", async () => {
    // Build a chain of length MAX_SUBAGENT_DEPTH + 10, using ses_ prefixed ids.
    const sessions: Record<string, { parentID?: string }> = {}
    const chainLen = MAX_SUBAGENT_DEPTH + 10
    const ids = Array.from({ length: chainLen + 1 }, (_, i) => `ses_chain${String(i).padStart(10, "0")}`)
    for (let i = 0; i <= chainLen; i++) {
      sessions[ids[i]!] = i > 0 ? { parentID: ids[i - 1] } : {}
    }
    const svc = makeSessionsService(sessions)
    const depth = await Effect.runPromise(resolveSessionDepth(svc, SessionID.make(ids[chainLen]!)))
    expect(depth).toBe(MAX_SUBAGENT_DEPTH)
  })
})

// ---------------------------------------------------------------------------
// E. deriveSubagentSessionPermission — regression: canTask/canTodo use evaluate
// ---------------------------------------------------------------------------

describe("deriveSubagentSessionPermission — canTask / canTodo", () => {
  it("AC1: researcher (star deny) gets task:deny in derived session permission", () => {
    const researcher = makeAgent("researcher", STAR_DENY)
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent: researcher,
    })
    const taskRule = derived.find((r) => r.permission === "task")
    expect(taskRule?.action).toBe("deny")
  })

  it("AC1: reviewer (star deny) gets task:deny in derived session permission", () => {
    const reviewer = makeAgent("reviewer", STAR_DENY)
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent: reviewer,
    })
    const taskRule = derived.find((r) => r.permission === "task")
    expect(taskRule?.action).toBe("deny")
  })

  it("agent with explicit task:allow does NOT get an extra task:deny appended", () => {
    const custom = makeAgent("custom", [makeRule("task", "allow")])
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent: custom,
    })
    // Must NOT append task:deny when agent already has an explicit allow.
    const taskDenies = derived.filter((r) => r.permission === "task" && r.action === "deny")
    expect(taskDenies).toHaveLength(0)
  })

  it("agent with no task rule (ask by default) gets task:deny appended", () => {
    const noRules = makeAgent("general", [])
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent: noRules,
    })
    const taskDenies = derived.filter((r) => r.permission === "task" && r.action === "deny")
    expect(taskDenies.length).toBeGreaterThan(0)
  })

  it("AC6: Goal Loop plan capability grant is preserved", () => {
    const worker = makeAgent("goal-worker", [
      ...STAR_DENY,
      // capability declared in registry
    ])
    worker.capabilities = [PLAN_WRITE_OWN_GOAL]
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent: worker,
      allowPlanWriteCapability: true,
    })
    const planAllow = derived.find((r) => r.permission === "plan" && r.action === "allow")
    expect(planAllow).toBeTruthy()
  })

  it("AC6: Goal Loop plan capability NOT granted when allowPlanWriteCapability is false", () => {
    const worker = makeAgent("goal-worker", STAR_DENY)
    worker.capabilities = [PLAN_WRITE_OWN_GOAL]
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent: worker,
      allowPlanWriteCapability: false,
    })
    const planAllow = derived.find((r) => r.permission === "plan" && r.action === "allow")
    expect(planAllow).toBeUndefined()
  })

  it("AC6: Plan Mode parent deny propagates to child session", () => {
    const editDenyAgent = makeAgent("parent-plan-mode", [makeRule("edit", "deny")])
    const child = makeAgent("child", [])
    const derived = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: editDenyAgent,
      subagent: child,
    })
    const editDeny = derived.find((r) => r.permission === "edit" && r.action === "deny")
    expect(editDeny).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// F. subagentIsWriteType regression
// ---------------------------------------------------------------------------

describe("subagentIsWriteType", () => {
  it("agent with bash:allow is write-type", () => {
    const a = makeAgent("a", [makeRule("bash", "allow")])
    expect(subagentIsWriteType(a)).toBe(true)
  })

  it("agent with all edit-class denied is read-only", () => {
    const a = makeAgent("a", STAR_DENY)
    expect(subagentIsWriteType(a)).toBe(false)
  })

  it("agent with no rules (ask default) is write-type (ask ≠ deny)", () => {
    const a = makeAgent("a", [])
    expect(subagentIsWriteType(a)).toBe(true)
  })
})
