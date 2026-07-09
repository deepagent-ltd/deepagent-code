import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import {
  deriveSubagentSessionPermission,
  filterPrimaryToolsForSubagent,
  PLAN_WRITE_OWN_GOAL,
} from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import { testEffect } from "../lib/effect"

const it = testEffect(Agent.defaultLayer)

function hasRule(
  ruleset: PermissionV1.Ruleset,
  permission: string,
  action: "allow" | "deny",
): boolean {
  return ruleset.some((rule) => rule.permission === permission && rule.pattern === "*" && rule.action === action)
}

// A minimal subagent Info shaped like the Goal Loop worker P2/§D will register:
// a restrictive `*: deny` base + the plan-write capability. The base deny is what
// makes the "own goal" relaxation load-bearing — without the session-level grant
// the plan tool would be denied.
function workerAgent(capabilities: string[] | undefined): Agent.Info {
  return {
    name: "goal-worker",
    mode: "subagent",
    permission: Permission.fromConfig({ "*": "deny", read: "allow", bash: "allow" }),
    options: {},
    ...(capabilities ? { capabilities } : {}),
  } satisfies Agent.Info
}

describe("V3.9 §E — subagent plan-write capability", () => {
  // §E.3 (1): a subagent WITH capability plan_write:own_goal, at the FLAG-GATED opt-in call site, gets
  // plan-write. (allowPlanWriteCapability:true mirrors the goal-loop wiring, the only opt-in caller.)
  test("capability present + opt-in → plan:allow granted, scoped to plan only", () => {
    const subagent = workerAgent([PLAN_WRITE_OWN_GOAL])
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent,
      allowPlanWriteCapability: true,
    })

    // The real gate for the plan tool is the "plan" permission (tool id/permission "plan").
    expect(hasRule(ruleset, "plan", "allow")).toBe(true)
    // §E F6: the grant is scoped to `plan` ONLY — todowrite is NOT widened (it stays denied by default).
    expect(hasRule(ruleset, "todowrite", "allow")).toBe(false)
    expect(hasRule(ruleset, "todowrite", "deny")).toBe(true)

    // Merged effective evaluation: session plan:allow overrides the worker's own `*: deny`.
    const effective = Permission.merge(subagent.permission, ruleset)
    expect(Permission.evaluate("plan", "*", effective).action).toBe("allow")
    // Scoped grant: it does NOT widen plan_enter / plan_exit (those stay denied by `*: deny`).
    expect(Permission.evaluate("plan_enter", "*", effective).action).toBe("deny")
    expect(Permission.evaluate("plan_exit", "*", effective).action).toBe("deny")
  })

  // §E / §F.3: the capability is IGNORED unless the call site opts in. This is the structural flag
  // gate — the generic `task` tool does NOT opt in, so even a capability-bearing worker spawned there
  // (or ANY caller with experimentalGoalLoop off) gets NO plan grant. All-flags-off === V3.8.
  test("capability present but NO opt-in → capability ignored, no plan grant", () => {
    const subagent = workerAgent([PLAN_WRITE_OWN_GOAL])
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent,
      // allowPlanWriteCapability omitted → defaults to false (the task-tool / flag-off path).
    })
    expect(hasRule(ruleset, "plan", "allow")).toBe(false)
    expect(hasRule(ruleset, "todowrite", "deny")).toBe(true)
    const effective = Permission.merge(subagent.permission, ruleset)
    expect(Permission.evaluate("plan", "*", effective).action).toBe("deny")
  })

  // §E.3 (2): a subagent WITHOUT the capability keeps todowrite:deny, no plan grant — even WITH opt-in.
  test("capability absent → todowrite deny present, no plan:allow (even with opt-in)", () => {
    const subagent = workerAgent(undefined)
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent,
      allowPlanWriteCapability: true,
    })

    expect(hasRule(ruleset, "todowrite", "deny")).toBe(true)
    expect(hasRule(ruleset, "plan", "allow")).toBe(false)
    expect(hasRule(ruleset, "todowrite", "allow")).toBe(false)

    // The plan tool stays denied by the worker's own `*: deny` (no session override).
    const effective = Permission.merge(subagent.permission, ruleset)
    expect(Permission.evaluate("plan", "*", effective).action).toBe("deny")
  })

  // §E F5: the experimental.primary_tools passthrough must NOT be able to re-grant the capability-
  // governed permissions to a subagent (that would bypass the plan-write gate).
  test("filterPrimaryToolsForSubagent strips plan/todowrite but keeps other primary_tools", () => {
    expect(filterPrimaryToolsForSubagent(["plan", "todowrite", "bash", "webfetch"])).toEqual(["bash", "webfetch"])
    expect(filterPrimaryToolsForSubagent(["plan"])).toEqual([])
    expect(filterPrimaryToolsForSubagent(undefined)).toEqual([])
    expect(filterPrimaryToolsForSubagent([])).toEqual([])
  })

  test("empty capabilities array behaves like absent (no relaxation)", () => {
    const subagent = workerAgent([])
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent,
      allowPlanWriteCapability: true,
    })
    expect(hasRule(ruleset, "todowrite", "deny")).toBe(true)
    expect(hasRule(ruleset, "plan", "allow")).toBe(false)
  })

  // §E.3 (2), no-regression: ordinary NAMED native subagents (which declare no
  // capabilities) keep todowrite:deny and gain no plan grant.
  it.instance("ordinary native subagents (explore/researcher/reviewer) unaffected — todowrite:deny, no plan:allow", () =>
    Effect.gen(function* () {
      for (const name of ["explore", "researcher", "reviewer"] as const) {
        const subagent = yield* Agent.use.get(name)
        expect(subagent).toBeDefined()
        expect(subagent!.capabilities?.includes(PLAN_WRITE_OWN_GOAL) ?? false).toBe(false)

        const ruleset = deriveSubagentSessionPermission({
          parentSessionPermission: [],
          parentAgent: undefined,
          subagent: subagent!,
        })
        expect(hasRule(ruleset, "todowrite", "deny")).toBe(true)
        expect(hasRule(ruleset, "plan", "allow")).toBe(false)
        expect(hasRule(ruleset, "todowrite", "allow")).toBe(false)
      }
    }),
  )

  // §D/§E: the registered goal-loop worker native agent declares the capability and therefore
  // derives a session-level plan:allow (the P0-E mechanism, exercised on the REAL registration).
  it.instance("registered 'goal-worker' native agent has capability → derives plan:allow", () =>
    Effect.gen(function* () {
      const worker = yield* Agent.use.get("goal-worker")
      expect(worker).toBeDefined()
      expect(worker!.mode).toBe("subagent")
      expect(worker!.native).toBe(true)
      expect(worker!.capabilities?.includes(PLAN_WRITE_OWN_GOAL) ?? false).toBe(true)

      // At the flag-gated opt-in call site the registered worker derives a session-level plan:allow…
      const ruleset = deriveSubagentSessionPermission({
        parentSessionPermission: [],
        parentAgent: undefined,
        subagent: worker!,
        allowPlanWriteCapability: true,
      })
      expect(hasRule(ruleset, "plan", "allow")).toBe(true)
      // Merged effective evaluation: the worker can write its own goal's plan.
      const effective = Permission.merge(worker!.permission, ruleset)
      expect(Permission.evaluate("plan", "*", effective).action).toBe("allow")
      // But the grant is scoped — it does not widen plan_enter/plan_exit (denied by defaults).
      expect(Permission.evaluate("plan_enter", "*", effective).action).toBe("deny")
      expect(Permission.evaluate("plan_exit", "*", effective).action).toBe("deny")

      // …and WITHOUT the opt-in (e.g. spawned via the generic task tool, or flag off) it does NOT.
      const noOptIn = deriveSubagentSessionPermission({
        parentSessionPermission: [],
        parentAgent: undefined,
        subagent: worker!,
      })
      expect(hasRule(noOptIn, "plan", "allow")).toBe(false)
      // §E F4: the worker is HIDDEN so the task tool won't surface it as a spawnable subagent_type.
      expect(worker!.hidden).toBe(true)
    }),
  )
})
