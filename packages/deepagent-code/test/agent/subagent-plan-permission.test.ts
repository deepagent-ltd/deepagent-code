import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission, PLAN_WRITE_OWN_GOAL } from "../../src/agent/subagent-permissions"
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
  // §E.3 (1): a subagent WITH capability plan_write:own_goal gets plan-write.
  test("capability present → plan:allow granted, no todowrite deny", () => {
    const subagent = workerAgent([PLAN_WRITE_OWN_GOAL])
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent,
    })

    // The real gate for the plan tool is the "plan" permission (tool id/permission "plan").
    expect(hasRule(ruleset, "plan", "allow")).toBe(true)
    // Forward-compat: todowrite is allowed, and the default todowrite deny is skipped.
    expect(hasRule(ruleset, "todowrite", "allow")).toBe(true)
    expect(hasRule(ruleset, "todowrite", "deny")).toBe(false)

    // Merged effective evaluation: session plan:allow overrides the worker's own `*: deny`.
    const effective = Permission.merge(subagent.permission, ruleset)
    expect(Permission.evaluate("plan", "*", effective).action).toBe("allow")
    // Scoped grant: it does NOT widen plan_enter / plan_exit (those stay denied by `*: deny`).
    expect(Permission.evaluate("plan_enter", "*", effective).action).toBe("deny")
    expect(Permission.evaluate("plan_exit", "*", effective).action).toBe("deny")
  })

  // §E.3 (2): a subagent WITHOUT the capability keeps todowrite:deny, no plan grant.
  test("capability absent → todowrite deny present, no plan:allow", () => {
    const subagent = workerAgent(undefined)
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent,
    })

    expect(hasRule(ruleset, "todowrite", "deny")).toBe(true)
    expect(hasRule(ruleset, "plan", "allow")).toBe(false)
    expect(hasRule(ruleset, "todowrite", "allow")).toBe(false)

    // The plan tool stays denied by the worker's own `*: deny` (no session override).
    const effective = Permission.merge(subagent.permission, ruleset)
    expect(Permission.evaluate("plan", "*", effective).action).toBe("deny")
  })

  test("empty capabilities array behaves like absent (no relaxation)", () => {
    const subagent = workerAgent([])
    const ruleset = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent,
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

      const ruleset = deriveSubagentSessionPermission({
        parentSessionPermission: [],
        parentAgent: undefined,
        subagent: worker!,
      })
      expect(hasRule(ruleset, "plan", "allow")).toBe(true)
      // Merged effective evaluation: the worker can write its own goal's plan.
      const effective = Permission.merge(worker!.permission, ruleset)
      expect(Permission.evaluate("plan", "*", effective).action).toBe("allow")
      // But the grant is scoped — it does not widen plan_enter/plan_exit (denied by defaults).
      expect(Permission.evaluate("plan_enter", "*", effective).action).toBe("deny")
      expect(Permission.evaluate("plan_exit", "*", effective).action).toBe("deny")
    }),
  )
})
