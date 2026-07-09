import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import type { Permission } from "../permission"
import type { Agent } from "./agent"

/**
 * V3.9 §E — Registry capability that grants a Goal Loop worker subagent a
 * LIMITED plan-write permission (it may maintain its OWN goal's plan step
 * status). Ordinary subagents (explore/researcher/reviewer/panelist) do NOT
 * carry this capability and remain plan-write denied. A worker is registered
 * (P2/§D) with `capabilities: [PLAN_WRITE_OWN_GOAL]`; this derivation is the
 * only mechanism that acts on it.
 *
 * Gate mapping (verified): the plan-write tool (`tool/plan-write.ts`) has tool
 * id `"plan"` and asks `ctx.ask({ permission: "plan" })`. The legacy
 * `todowrite` deny historically fenced task-tracking but does NOT match the
 * `"plan"` permission (`Wildcard.match("plan", "todowrite") === false`), so the
 * real gate for the plan tool is the `"plan"` permission itself. A subagent
 * whose base ruleset is `*: deny` (reviewer/researcher/explore) therefore
 * cannot write a plan. Granting a SESSION-level `plan: allow` flips that: session
 * rules are merged AFTER the agent ruleset (`session/tools.ts` ask ruleset and
 * `session/prompt.ts` process ruleset both do `merge(agent.permission,
 * session.permission)`), and `Permission.evaluate` takes the LAST matching rule —
 * so a session `plan: allow` overrides an agent `*: deny`.
 *
 * "Own goal only" is enforced by session-scope isolation, not by this ruleset:
 * the plan doc is a `type:"plan"`, `scope:"run:<sessionId>"` DocumentStore
 * document (`core/deepagent/plan-controller.ts`), and the plan tool reads/writes
 * via `ctx.sessionID` only. A worker session can therefore only see and mutate
 * its OWN goal's plan doc — it cannot reach another session's plan or change the
 * goal/criteria of a different goal. The grant is scoped to `permission:"plan"`
 * (exact), so it does not widen `plan_enter`/`plan_exit` or any other permission.
 */
export const PLAN_WRITE_OWN_GOAL = "plan_write:own_goal"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent **agent's** edit-class deny rules — Plan Mode's file-edit
 *    restriction lives on the agent ruleset, not on the session, so a
 *    subagent that only inherited the parent SESSION's permission would
 *    silently bypass it. (#26514)
 * 2. The parent **session's** deny rules and external_directory rules —
 *    same forwarding the original code already did.
 * 3. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 * 4. V3.9 §E — for a Goal Loop worker (capability `PLAN_WRITE_OWN_GOAL`): a
 *    LIMITED plan-write grant (`plan: allow`, plus `todowrite: allow` for
 *    forward-compat), and the default `todowrite` deny is skipped. Bounded to
 *    its own goal by run-scope session isolation (see doc-comment above).
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  // V3.9 §E: controlled relaxation — ONLY a Goal Loop worker that declares this
  // capability in its Registry entry gets plan-write. Ordinary subagents do not.
  const canPlanOwnGoal = input.subagent.capabilities?.includes(PLAN_WRITE_OWN_GOAL) ?? false
  const parentAgentDenies =
    input.parentAgent?.permission.filter((rule) => rule.action === "deny" && rule.permission === "edit") ?? []
  return [
    ...parentAgentDenies,
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    // V3.9 §E: a Goal Loop worker may write its OWN goal's plan (bounded by
    // run:<sessionId> scope isolation). `plan: allow` is the real gate for the
    // plan tool (id/permission "plan"); merged after — and thus overriding — the
    // worker agent's own `*: deny`. `todowrite: allow` is granted alongside for
    // forward-compat and to skip the default todowrite deny below.
    ...(canPlanOwnGoal
      ? [
          { permission: "plan" as const, pattern: "*" as const, action: "allow" as const },
          { permission: "todowrite" as const, pattern: "*" as const, action: "allow" as const },
        ]
      : []),
    ...(canTodo || canPlanOwnGoal
      ? []
      : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
