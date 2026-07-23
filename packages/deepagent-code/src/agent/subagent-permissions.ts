import { PermissionV1 } from "@deepagent-code/core/v1/permission"
import { evaluate as evaluatePermission } from "../permission"
import type { Permission } from "../permission"
import type { Agent } from "./agent"
import { Effect } from "effect"
import { Log } from "@deepagent-code/core/util/log"
import type { Session } from "../session/session"
import { SessionID } from "../session/schema"

// I33-3: the edit-class tool permissions that mark a subagent as WRITE-type. A subagent that can run
// ANY of these (effective action !== "deny") mutates the working tree and therefore defaults to git
// worktree isolation (its edits are propagated back to the parent on completion). A subagent denied
// all of them is READ-ONLY and defaults to sharing the parent's directory. Keep in sync with the
// mutating-tool set the plan gate uses (session/tools.ts: write/edit/patch/shell).
const EDIT_CLASS_PERMISSIONS = ["edit", "write", "patch", "bash"] as const

// F5: hard process-level subagent depth limit. Root session = depth 0; its first child = depth 1.
// A session at MAX_SUBAGENT_DEPTH cannot spawn any further children — all task calls from that depth
// are denied regardless of config. This constant MUST NOT be raised via runtime config.
export const MAX_SUBAGENT_DEPTH = 3

// F5: metadata key path for the normalized depth value written at session-create time.
// Access via: session.metadata?.deepagent?.subagentDepth
export const SUBAGENT_DEPTH_META_KEY = "subagentDepth" as const

const log = Log.create({ service: "subagent-permissions" })

/**
 * I33-3: is this subagent WRITE-type (defaults to worktree isolation) or READ-ONLY (defaults to
 * shared parent dir)? Evaluates the subagent's own permission ruleset for each edit-class tool via the
 * same `Permission.evaluate` the runtime uses (last matching rule wins; unmatched ⇒ "ask", which is
 * NOT "deny" ⇒ still write-capable). A subagent is read-only only when EVERY edit-class permission
 * resolves to "deny". Pure + exported for unit testing; no I/O.
 */
export function subagentIsWriteType(subagent: Agent.Info): boolean {
  return EDIT_CLASS_PERMISSIONS.some(
    (perm) => evaluatePermission(perm, "**", subagent.permission).action !== "deny",
  )
}

/**
 * V3.9 §E — Registry capability that grants a Goal Loop worker subagent a
 * LIMITED plan-write permission (it may maintain its OWN goal's plan step
 * status). Ordinary subagents (explore/researcher/reviewer/panelist) do NOT
 * carry this capability and remain plan-write denied. A worker is registered
 * (P2/§D) with `capabilities: [PLAN_WRITE_OWN_GOAL]`; this derivation is the
 * only mechanism that GRANTS plan-write from the capability. The one other path
 * that could otherwise hand a subagent `plan`/`todowrite: allow` — a user's
 * `experimental.primary_tools` passthrough in the `task` tool — is fenced off by
 * `filterPrimaryToolsForSubagent` (see below), so the capability gate remains the
 * sole route to those permissions for a subagent.
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
 * V3.9 §E — permissions that are GOVERNED by the capability gate (deriveSubagentSessionPermission)
 * and must therefore NOT be re-grantable to a subagent through a side channel. The `task` tool appends
 * a user's `experimental.primary_tools` as blanket `*: allow` rules AFTER the derived ruleset (and
 * last-match-wins), which would let e.g. `primary_tools: ["plan"]` hand `plan: allow` to
 * explore/researcher/reviewer — bypassing the §E capability gate entirely. These names are filtered
 * out of that passthrough by `filterPrimaryToolsForSubagent`, so the capability gate stays the ONLY
 * path to them for a subagent. (This does not affect the PRIMARY agent, which is where primary_tools is
 * meant to apply.)
 */
export const CAPABILITY_GOVERNED_PERMISSIONS: readonly string[] = ["plan", "todowrite"]

/**
 * Filter a user's `experimental.primary_tools` list down to what may be safely force-allowed on a
 * SUBAGENT session. Drops the §E capability-governed permissions (see CAPABILITY_GOVERNED_PERMISSIONS)
 * so the primary_tools escape hatch cannot bypass the plan-write capability gate. Any other
 * primary_tool passes through unchanged.
 */
export function filterPrimaryToolsForSubagent(primaryTools: readonly string[] | undefined): string[] {
  if (!primaryTools) return []
  return primaryTools.filter((tool) => !CAPABILITY_GOVERNED_PERMISSIONS.includes(tool))
}

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
  /**
   * V3.9 §E / §F.3 — whether this call site is allowed to honor the
   * `PLAN_WRITE_OWN_GOAL` capability. Defaults to FALSE: the plan-write
   * relaxation is granted ONLY when the caller explicitly opts in. The single
   * opt-in caller is the Goal-Loop wiring (`goal-loop-wiring.ts`), which is
   * itself constructed ONLY when `flags.experimentalGoalLoop` is on — so the
   * flag is the structural gate. The generic `task` tool passes false, so a
   * goal-worker spawned directly via `task` (or ANY subagent) gets NO plan
   * grant, and with the flag OFF the relaxation is entirely unreachable
   * (all-flags-off === V3.8 behaviour, §F.3 #3 / §H.6).
   */
  allowPlanWriteCapability?: boolean
}): PermissionV1.Ruleset {
  // F5: use evaluate (not presence check) so "ask" does NOT count as delegation capability.
  // A subagent that has only "ask"-level task permission cannot further delegate; only an explicit
  // "allow" rule in the subagent's own permission set permits it. This preserves the default deny
  // for researcher/reviewer/explore/goal-worker (all have `"*": "deny"` which covers "task") and
  // keeps custom agents with explicit `task: allow` rules working.
  const canTask = evaluatePermission("task", "*", input.subagent.permission).action === "allow"
  const canTodo = evaluatePermission("todowrite", "*", input.subagent.permission).action === "allow"
  // V3.9 §E: controlled relaxation — a Goal Loop worker gets plan-write ONLY when it BOTH declares the
  // capability in its Registry entry AND the call site opted in (the flag-gated goal-loop wiring). Both
  // conditions are required, so ordinary subagents — and any caller with the flag off — never get it.
  const canPlanOwnGoal =
    (input.allowPlanWriteCapability ?? false) && (input.subagent.capabilities?.includes(PLAN_WRITE_OWN_GOAL) ?? false)
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
    // worker agent's own `*: deny`. Scoped to `plan` ONLY (§E authorizes plan
    // step status, not general task tracking) — `todowrite` is NOT widened here.
    ...(canPlanOwnGoal ? [{ permission: "plan" as const, pattern: "*" as const, action: "allow" as const }] : []),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}

/**
 * F5: resolve the effective subagent nesting depth for a session.
 *
 * Resolution order (fail-closed throughout):
 *   1. Read `metadata.deepagent.subagentDepth` — present on all sessions created after F5 ships.
 *   2. Fall back to walking the `parentID` chain for historical sessions that pre-date the field.
 *   3. When both are available, use the STRICTER (larger) value and log a diagnostic.
 *   4. Cycle detection, missing-parent termination, and over-long chain guard all fail closed at
 *      MAX_SUBAGENT_DEPTH so a corrupted chain cannot lower the effective depth below the real one.
 *
 * The function never fails — any error path returns MAX_SUBAGENT_DEPTH (fail closed).
 */
export function resolveSessionDepth(
  sessions: Session.Interface,
  sessionID: SessionID,
): Effect.Effect<number> {
  return Effect.gen(function* () {
    const session = yield* sessions.get(sessionID).pipe(Effect.orElseSucceed(() => undefined))
    if (!session) {
      log.warn("resolveSessionDepth: session not found, failing closed", { sessionID })
      return MAX_SUBAGENT_DEPTH
    }

    // 1. Try normalised metadata depth written at create time.
    const deepagentMeta = session.metadata?.["deepagent"] as Record<string, unknown> | undefined
    const rawMeta = deepagentMeta?.[SUBAGENT_DEPTH_META_KEY]
    const metaDepth =
      typeof rawMeta === "number" && Number.isFinite(rawMeta) && rawMeta >= 0
        ? Math.floor(rawMeta)
        : undefined

    // 2. Walk parentID chain for historical sessions / cross-validation.
    const visited = new Set<string>([sessionID])
    let cursor: string | undefined = session.parentID
    let chainDepth = 0
    const chainLimit = MAX_SUBAGENT_DEPTH + 4 // generous bound against corrupted chains

    for (let i = 0; i < chainLimit && cursor !== undefined; i++) {
      if (visited.has(cursor)) {
        log.warn("resolveSessionDepth: cycle in parentID chain, failing closed", { sessionID, cycleAt: cursor })
        return MAX_SUBAGENT_DEPTH
      }
      visited.add(cursor)
      const parentSID = SessionID.make(cursor)
      const parent = yield* sessions.get(parentSID).pipe(Effect.orElseSucceed(() => undefined))
      if (!parent) break // chain terminates at an unknown root — depth is the hops counted so far
      chainDepth++
      cursor = parent.parentID
    }
    // If the loop exhausted chainLimit the chain is suspiciously long — fail closed.
    if (cursor !== undefined) {
      log.warn("resolveSessionDepth: parentID chain exceeds limit, failing closed", { sessionID })
      return MAX_SUBAGENT_DEPTH
    }

    // 3. Reconcile metadata vs chain.
    if (metaDepth === undefined) return chainDepth
    if (metaDepth !== chainDepth) {
      log.warn("resolveSessionDepth: metadata/chain depth conflict — using stricter value", {
        sessionID,
        metaDepth,
        chainDepth,
      })
      return Math.max(metaDepth, chainDepth)
    }
    return metaDepth
  })
}

/**
 * F5: check whether the calling session's effective permission allows it to delegate a task
 * to the given target agent type.
 *
 * Uses the existing Permission.evaluate function (last-match-wins) over the MERGED caller
 * ruleset (agent permission first, session permission second so session overrides take effect).
 * "ask" is NOT a delegation capability — only an explicit "allow" rule grants it.
 *
 * Pure + synchronous; no I/O. Call resolveSessionDepth separately and combine with this.
 */
export function canDelegateTask(
  callerAgentPermission: PermissionV1.Ruleset,
  callerSessionPermission: PermissionV1.Ruleset,
  targetAgentType: string,
): boolean {
  // Session permission is passed second so it is the "last" ruleset and wins over agent permission.
  const result = evaluatePermission("task", targetAgentType, callerAgentPermission, callerSessionPermission)
  return result.action === "allow"
}

/**
 * F5: unified child-admission check for ALL task-creation paths (normal, takeover, background).
 *
 * Returns the depth the NEW child session should carry, or fails with a descriptive error string.
 * Does NOT create the session or write metadata — the caller must do both.
 *
 * Checks (in order):
 *   1. Hard depth ceiling: parent depth >= MAX_SUBAGENT_DEPTH → always deny.
 *   2. Caller delegation permission: effective permission for "task" + targetAgentType must be "allow".
 */
export function admitChildOrFail(input: {
  callerDepth: number
  callerAgentPermission: PermissionV1.Ruleset
  callerSessionPermission: PermissionV1.Ruleset
  targetAgentType: string
}): { childDepth: number } | { error: string } {
  const childDepth = input.callerDepth + 1
  if (input.callerDepth >= MAX_SUBAGENT_DEPTH) {
    return {
      error:
        `Subagent depth limit reached (max ${MAX_SUBAGENT_DEPTH}). ` +
        `This session is at depth ${input.callerDepth} and cannot spawn further subagents. ` +
        `Restructure the task to reduce nesting.`,
    }
  }
  if (!canDelegateTask(input.callerAgentPermission, input.callerSessionPermission, input.targetAgentType)) {
    return {
      error:
        `This agent does not have permission to delegate to "${input.targetAgentType}". ` +
        `The effective "task" permission evaluates to deny or ask for this agent type. ` +
        `Grant explicit task permission in the agent configuration to enable delegation.`,
    }
  }
  return { childDepth }
}
